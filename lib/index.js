/**
 * dsh-opencode-live-models: keep the OpenCode Go model catalog current without
 * waiting for a pi-ai (and therefore a DSH) release to carry it.
 *
 * ## What it patches, and why that is enough
 *
 * DSH's `llm-pi-ai` adapter builds a pi-ai `Models` collection per operation and
 * reads every catalog fact from it:
 *
 * - `listModels()`  -> `snapshot.models.getModels(provider)`
 * - `resolveModel()` -> `snapshot.models.getModel(provider, id)`
 * - dispatch        -> `snapshot.models.streamSimple(model, ...)`
 *
 * In pi-ai both `getModels(provider)` and `getModel(provider, id)` delegate to the
 * registered provider's own `getModels()` (`ModelsImpl.getModel` is literally
 * `getModels(provider).find(m => m.id === id)`), and `setProvider()` swaps a
 * provider at runtime. Replacing the `opencode-go` provider with one whose
 * `getModels()` returns a merged roster therefore reaches the model picker, the
 * capability queries, and dispatch, **without reimplementing any transport**: a
 * model the old pi-ai has never heard of is carried by the old pi-ai's existing
 * `openai-completions` / `openai-responses` / `anthropic-messages` transports.
 *
 * ## Zero imports, on purpose
 *
 * This module imports nothing at runtime, and the reason is testability rather
 * than necessity — worth being precise about, because the obvious justification
 * is false. The host *does* route `@deepseek-ai/*` to its own copies:
 * `dsh-app-boot` patches Node's CommonJS and ESM resolvers so a profile plugin
 * can import host packages that live inside `app.asar`, and `dsh-shell` relies
 * on exactly that with no declared dependencies.
 *
 * What does not work is importing one *here*. `probe.mjs` loads this module in a
 * plain Node process, with no host and no `node_modules` anywhere above the
 * checkout, so a top-level host import fails to resolve and takes the whole suite
 * with it before the first assertion runs.
 *
 * So the plugin stays import-free and reaches the running pi-ai instance through
 * `ctx.llm.adapters` — a TypeScript-`private` field that is an ordinary Map at
 * runtime — which is the same path `dsh-opencode-session` uses. Staying loadable
 * outside the host is what lets the merge, validation and degrade logic be tested
 * directly instead of through the client.
 *
 * ## Sources, in priority order
 *
 * 1. `https://pi.dev/api/models/providers/opencode-go?types=chat` — Pi's own
 *    catalog, carrying complete descriptors (capacities, compat,
 *    thinkingLevelMap). Authoritative and pre-verified by Pi. It decides which
 *    models exist and what they can do; {@link OCG_BASE_URLS} decides where
 *    requests go, so the remote cannot redirect traffic.
 * 2. The installed catalog, untouched, so a model Pi has not published yet is
 *    never dropped from the picker just because the remote fetch was partial.
 *
 * Nothing is bundled: the overlay is exactly what Pi currently publishes, so an
 * id added, renamed or retired upstream needs no change in this file.
 *
 * `https://opencode.ai/zen/go/v1/models` supplies the live roster, gated by
 * {@link acceptRoster} because it alone decides which *installed* models survive.
 * Pi's own entries are exempt — see {@link buildOverlay} for why a gateway gap is
 * not read as a retirement. A name with no descriptor is reported, not guessed.
 *
 * ## Ordering
 *
 * Appending the overlay would read as two blocks, because `Map.set` never moves
 * an existing key and the overlay can therefore only append. So the roster is
 * ordered on purpose: Pi's catalog order is the spine, a model only the
 * installed catalog carries is inserted before its nearest following spine
 * entry, and anything without an anchor goes last. See {@link orderModels}.
 *
 * @module dsh-opencode-live-models
 */

export const name = 'opencode-live-models'
export const inject = ['llm']

const PROVIDER_ID = 'opencode-go'
const PI_CATALOG_URL = `https://pi.dev/api/models/providers/${PROVIDER_ID}?types=chat`
const OCG_MODELS_URL = 'https://opencode.ai/zen/go/v1/models'
const REFRESH_INTERVAL_MS = 5 * 60 * 1000
const FETCH_TIMEOUT_MS = 8000

/**
 * `User-Agent` sent to both endpoints, as `<package name>/<package version>`.
 *
 * A mirror of `package.json` rather than a read of it: this module imports
 * nothing at runtime (see the header) and Node gives a module no way to ask for
 * its own package version, so the value has to be written down here. Note it is
 * the *package* name, not {@link name} — the plugin id the host mounts is
 * `opencode-live-models`, and a UA quoting that would not identify the artifact
 * a server operator is looking at.
 *
 * What made this worth naming is that it used to be a literal buried in a header
 * object: a release bump left it behind, and every request then went out
 * claiming a version the package no longer had — a lie no test could see, in the
 * one field whose entire job is to be true about which build is talking. As a
 * named constant the probe can assert it against `package.json`, so the bump that
 * forgets this line fails the suite instead of a server log.
 */
const USER_AGENT = 'dsh-opencode-live-models/0.3.0'

/**
 * Where each wire protocol's requests actually go, and the only set of protocols
 * the installed pi-ai's `opencode-go` provider carries — a descriptor naming
 * anything else is absent from this map, so it is dropped: its transport does
 * not exist and registering it would fail at dispatch instead of at load.
 *
 * `anthropic-messages` deliberately differs from the other two. The Anthropic
 * transport appends `/v1/messages` itself, so its base is the bare gateway root,
 * while the OpenAI transports post to `<base>/chat/completions` and
 * `<base>/responses`. Pi's own catalog uses the same split, and forcing one
 * base on all three would send the two Anthropic models to a wrong endpoint.
 *
 * Because this map is the whole of the plugin's network posture, a remote
 * catalog decides *which* models exist and what they can do — never where a
 * request is sent or what headers it carries.
 *
 * A `Map`, not an object literal, because a plain lookup is not the same as a
 * membership test: `OCG_BASE_URLS['constructor']` returns `Object` itself,
 * `['toString']` returns a function, `['__proto__']` returns `{}` — all inherited
 * from `Object.prototype`, all `!== undefined`, and all of them would sail past
 * an "unknown protocol" check and land a function in `descriptor.baseUrl`.
 * `Map.get` consults only its own entries.
 * @type {Map<string, string>}
 */
const OCG_BASE_URLS = new Map([
  ['anthropic-messages', 'https://opencode.ai/zen/go'],
  ['openai-completions', 'https://opencode.ai/zen/go/v1'],
  ['openai-responses', 'https://opencode.ai/zen/go/v1'],
])

/** Marker so a provider is never wrapped twice, even across adapter rebuilds. */
const WRAPPED = Symbol.for('dsh-opencode-live-models.provider')

/**
 * State that must outlive this module instance.
 *
 * The wrapper installed on the provider closes over this module's functions, and
 * a provider already carrying the marker is never wrapped again — so under hot
 * reload the wrapper that survives is the *old* one, reading the *old* module's
 * variables. A reload that fetches a new model would then refresh successfully
 * and change nothing visible. Keeping the mutable state, and the merge function
 * itself, in a slot on `globalThis` means a freshly loaded module adopts the one
 * the surviving wrapper is already reading, and immediately starts driving it.
 * @type {any}
 */
const STATE_KEY = Symbol.for('dsh-opencode-live-models.state')

/**
 * Every field the shared state carries, with the value to start from.
 * @returns {any} a fresh set of defaults.
 */
function stateDefaults() {
  return {
    /** `(installed) => merged`, taken over by whichever module loaded last. */
    merge: null,
    /** Latest complete descriptors from Pi's catalog, by model id. */
    remoteCatalog: new Map(),
    /**
     * OCG's live roster. `null` means "not known yet" or "last fetch failed", in
     * which case no membership filtering happens at all — an empty roster must
     * never be read as "OCG serves nothing".
     */
    liveModelIds: null,
    /**
     * A shrink {@link acceptRoster} refused on first sight, so the same one twice
     * in a row counts. `null` when none is awaiting confirmation.
     */
    pendingShrink: null,
    /** The same held-back confirmation for Pi's catalog. */
    pendingCatalogShrink: null,
    /**
     * Feeds that arrived before the installed catalog was measurable, kept for a
     * second look rather than judged against a baseline of zero. An adapter that
     * registers late makes the first poll's answer to "how many models should
     * there be" unknowable at the time it arrives.
     */
    deferredRoster: null,
    deferredCatalog: null,
    /**
     * Fingerprint of the catalog DSH last saw, and the ids it was made of. `null`
     * until the first refresh publishes something, so a cold start always emits.
     */
    publishedCatalog: null,
    /** The drift report last printed, so an unchanged list is not repeated. */
    lastDriftWarning: null,
    /** Tail of the shared write queue, so instances of this module take turns. */
    cacheWriteTail: Promise.resolve(),
    /** Counts writes so each gets its own temp file. */
    cacheWriteSeq: 0,
    /** Set once a cache write has failed, so the warning is not repeated every poll. */
    warnedCacheWrite: false,
    /** ETag of Pi's catalog, so an unchanged one costs a conditional request. */
    catalogEtag: null,
    /** Unknown fields already named in a warning, so a five-minute poll stays quiet. */
    warnedUnknownFields: new Set(),
    /** Adapter hooks installed by this plugin, so unload can put them back. */
    hooks: new Map(),
    /**
     * Providers this plugin wrapped, keyed by the collection they were installed
     * on, holding the provider that was there before. Unload puts it back — but
     * only if ours is still the one in place.
     */
    providers: new Map(),
    /**
     * Bumped by every mount and every unmount. A refresh compares the value it
     * captured against this one before writing, so a request belonging to a
     * superseded or unloaded instance cannot touch the current state.
     */
    generation: 0,
  }
}

// Assigned rather than `state = existing ?? defaults`: the state outlives a
// module, so it can have been created by an *older* version that did not have
// every field this one uses. Reading a missing one is what made a 0.1.5 → 0.1.6
// hot reload die on `undefined.then`. Existing values win, including explicit
// nulls — only absent keys take a default.
// The state object itself must be reused, never replaced. Two live instances —
// an old one and one loaded over it — have to be reading the *same* object, or
// the surviving wrapper keeps writing into a copy nobody looks at. Only a state
// inherited from an older version is topped up: a field added since then is
// simply absent, and reading one is what made a 0.1.5 → 0.1.6 hot reload die on
// `undefined.then`. Existing values win, explicit nulls included.
const inheritedState = globalThis[STATE_KEY]
const state = inheritedState ?? stateDefaults()
if (inheritedState !== undefined) {
  const defaults = stateDefaults()
  for (const key of Object.keys(defaults)) {
    if (!(key in state)) state[key] = defaults[key]
  }
}

/**
 * The generation of the mount that is currently in charge. A refresh compares
 * the value it captured with this one and drops its result if they differ, so a
 * request belonging to a superseded or unloaded instance cannot write.
 *
 * Module-level because the refresh path is a module function, but each `apply`
 * *also* keeps its own claim in a local — the disposer has to know whether its
 * own mount is still current, and by the time it runs this variable may already
 * belong to a later one.
 * @type {number}
 */
let activeGeneration = 0
globalThis[STATE_KEY] = state

/** In-flight refresh, so a slow network does not stack overlapping fetches. */
let refreshing = null

/** The mount that owns { refreshing}; only that mount may join it. */
let refreshingGeneration = -1

/**
 * Deliberately no bundled descriptors.
 *
 * A hand-written entry is a snapshot, and it goes stale without ever failing
 * loudly. Two of them used to live here — the models this plugin was built
 * around — and `space-bunny-free` is the cautionary half of that pair: OCG
 * retired it (it now lives on Zen under the same name, while OCG serves a paid
 * `space-bunny`), and a bundled copy would have kept publishing an id whose
 * every dispatch returns `ModelError`. Nothing in this file would have noticed,
 * and no amount of waiting would have fixed it: Pi's catalog is the thing that
 * moves, and a local copy neither follows it nor knows when it disagrees.
 *
 * So descriptors come from Pi and nowhere else. The cost is that a first boot
 * with no network has only the installed catalog to offer — the catalog the user
 * would have had without this plugin, with the on-disk cache covering every boot
 * after the first successful fetch.
 */

/**
 * The last known good catalog, kept across restarts.
 *
 * Where it goes is resolved lazily and, importantly, without depending on an
 * environment variable. DSH exports `DSH_PROFILE_DIR` to the processes *it*
 * spawns — the shell, the tools — but this plugin runs inside the main process,
 * which does not have it, so reading `process.env` here yields nothing and the
 * cache would silently never be written. `os.homedir()` is derived rather than
 * inherited and is therefore available regardless, and `~/.dsh` is DSH's own
 * home on every install. A profile directory is still preferred when one is
 * visible, being the more specific location.
 * @returns {Promise<string | null>} the directory, or `null` to stay disabled.
 */
let cacheDirPromise = null
function cacheDir() {
  cacheDirPromise ??= (async () => {
    const fromProfile = process.env?.DSH_PROFILE_DIR
    if (typeof fromProfile === 'string' && fromProfile.length > 0) return fromProfile
    try {
      const { homedir } = await import('node:os')
      const home = homedir()
      return typeof home === 'string' && home.length > 0 ? `${home}/.dsh` : null
    } catch {
      return null
    }
  })()
  return cacheDirPromise
}
const CACHE_FILE = 'opencode-live-models-catalog.json'
const CACHE_VERSION = 1
/** A week is long enough to ride out an outage and short enough that a model
 * retired while the plugin was off does not linger in the picker. */
const CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

/**
 * `node:fs` and `node:path`, loaded on demand.
 *
 * The plugin imports nothing statically on purpose — see the module header — and
 * that still holds here: a built-in module always resolves, and the cache is
 * optional, so it must not be on the path of mounting at all.
 * @returns {Promise<any[]>} `[fsPromises, path]`.
 */
function nodeModules() {
  return Promise.all([import('node:fs/promises'), import('node:path')])
}

/**
 * Serializes cache writes across *every* instance of this module.
 *
 * The queue has to live in the shared state, not in a module variable: under a
 * hot reload the old and new instances are separate modules with separate
 * variables, and two independent queues writing the same temp file interleave
 * exactly as badly as no queue at all — the older catalog lands last.
 * @param {() => Promise<void>} task - the write to perform.
 * @returns {Promise<void>} resolves when this write, and all before it, are done.
 */
function cacheWrite(task) {
  // `then(task, task)` on both sides: a rejected predecessor must not strand
  // everything behind it, and each write below handles its own failure.
  state.cacheWriteTail = state.cacheWriteTail.then(task, task)
  return state.cacheWriteTail
}

/**
 * Write the accepted catalog so the next session starts with it.
 *
 * Written to a sibling temp file and then renamed, because a plain write that is
 * interrupted leaves a truncated JSON where the last known good catalog used to
 * be — and the one moment that file is really needed is exactly when something
 * has gone wrong. `rename` within a directory is atomic, so a reader sees either
 * the old file or the new one, never half of either. Overlapping writes are
 * serialized through {@link cacheWrite} so two of them cannot interleave.
 *
 * Best effort otherwise: a read-only home or a full disk must not turn a refresh
 * into a mount failure. Failures are reported once, not on every poll.
 * @param {Map<string, any>} models - the catalog that was just accepted.
 * @param {string | null} etag - its validator, captured at the same moment.
 * @param {any} ctx - plugin context, for the one-shot warning.
 * @returns {Promise<void>} resolves whether or not the write happened.
 */
async function persistCatalog(models, etag, ctx) {
  // Claim a slot, then queue, both before the first await. Queueing after
  // resolving the directory left the order up to how long that resolution
  // happened to take: an earlier adoption whose `cacheDir()` was slower could
  // join the queue after a later one and still land last, which is the same
  // stale-file outcome as having no queue. The directory is resolved inside the
  // task, so queue order is adoption order.
  const seq = state.cacheWriteSeq++
  return cacheWrite(async () => {
    const dir = await cacheDir()
    if (dir === null) return
    try {
      const [{ writeFile, rename, unlink }, { join }] = await nodeModules()
      const target = join(dir, CACHE_FILE)
      // Unique per write, not per process: the queue is shared but the temp
      // path would otherwise collide with anything else writing here.
      const temp = `${target}.${process.pid}.${seq}.tmp`
      const payload = { version: CACHE_VERSION, savedAt: Date.now(), etag, models: [...models.values()] }
      try {
        await writeFile(temp, JSON.stringify(payload), 'utf8')
        await rename(temp, target)
      } catch (error) {
        await unlink(temp).catch(() => { /* the temp may never have been created */ })
        throw error
      }
    } catch (error) {
      if (state.warnedCacheWrite) return
      state.warnedCacheWrite = true
      ctx.logger.warn(
        `${name}: could not persist the catalog (${error?.message ?? error});`
        + ' this session will not survive a restart offline',
      )
    }
  })
}

/**
 * Read the catalog saved by a previous session.
 *
 * Re-validated exactly as a live response is — same sanitizer, same required
 * fields, same all-or-nothing rule — because a cached `baseUrl` is what
 * `normalizeRemoteModel` exists to prevent, and a cache that lost half its fields
 * is the same fault as a response that did. A partial cache is worse than none:
 * it would look authoritative while silently dropping capacities.
 *
 * The ETag comes back too, so the first request after a restart can be
 * conditional instead of downloading a catalog that has not changed.
 * @returns {Promise<{ models: Map<string, any>, etag: string | null } | null>} the
 * catalog and its validator, or `null` when there is nothing usable.
 */
async function restoreCatalog() {
  const dir = await cacheDir()
  if (dir === null) return null
  try {
    const [{ readFile }, { join }] = await nodeModules()
    const parsed = JSON.parse(await readFile(join(dir, CACHE_FILE), 'utf8'))
    if (parsed?.version !== CACHE_VERSION) return null
    if (!Number.isFinite(parsed.savedAt) || Date.now() - parsed.savedAt > CACHE_MAX_AGE_MS) return null
    const models = new Map()
    for (const entry of Array.isArray(parsed.models) ? parsed.models : []) {
      const model = normalizeRemoteModel(entry)
      if (model === undefined) return null
      const missing = Object.keys(REQUIRED_DESCRIPTOR_FIELDS)
        .filter(field => !REQUIRED_DESCRIPTOR_FIELDS[field](model[field]))
      if (missing.length > 0) return null
      models.set(model.id, model)
    }
    if (models.size === 0) return null
    return { models, etag: typeof parsed.etag === 'string' ? parsed.etag : null }
  } catch {
    return null
  }
}

/**
 * Fetch and parse one JSON document.
 * @param {string} url - absolute URL.
 * @param {Record<string, string>} [extraHeaders] - added to the default headers.
 * @returns {Promise<{ status: number, body: any, etag: string | null }>} the
 * parsed body, the HTTP status, and the ETag if the server sent one. A 304 is
 * reported rather than thrown, so the caller can keep what it already has.
 * @throws {Error} on a non-2xx status other than 304, or a transport failure.
 */
async function fetchJson(url, extraHeaders) {
  const response = await fetch(url, {
    headers: {
      accept: 'application/json',
      'user-agent': USER_AGENT,
      ...extraHeaders,
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  // 304 means "what you have is still current" — not a failure, and not a body.
  if (response.status === 304) return { status: 304, body: null, etag: null }
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`)
  return {
    status: response.status,
    body: await response.json(),
    etag: response.headers.get('etag'),
  }
}

/**
 * Pull the model array out of whichever envelope the endpoint used.
 *
 * One parser for both feeds, on purpose. They used to have two — this one for
 * Pi's catalog and a narrower bare-array-or-`data` test for the roster — and
 * that was a second place to keep envelope knowledge current, while the wider
 * one was already written and already covered the shapes the narrow one
 * accepted. The roster's extra strictness bought nothing: an envelope it could
 * not read became an empty roster, which {@link acceptRoster} refuses loudly, and
 * a wrong branch of this one yields rows with no string `id`, which lands in the
 * same place. So the wider parse is used for both, and the roster keeps its own
 * shape check on top.
 * @param {any} value - the parsed body.
 * @returns {any[]} candidate model objects.
 */
function extractCatalogEntries(value) {
  if (Array.isArray(value)) return value
  if (value && typeof value === 'object' && Array.isArray(value.models)) return value.models
  if (value && typeof value === 'object' && Array.isArray(value.data)) return value.data
  if (value && typeof value === 'object' && value.models && typeof value.models === 'object') {
    return Object.values(value.models)
  }
  if (value && typeof value === 'object') return Object.values(value)
  return []
}

/**
 * Fields a remote catalog must never get to decide, stripped before a
 * descriptor can reach a transport. Everything else is forwarded.
 *
 * This is a denylist rather than an allowlist on purpose. The whole point of
 * this plugin is to be *ahead* of the bundled pi-ai, so pinning today's field
 * set would mean a new Pi capability — `output`, `promptCache`, anything — gets
 * silently stripped by an out-of-date plugin, which is the same class of quiet
 * degradation this plugin exists to remove. Forwarding by default and
 * confiscating the control plane gets both: new capabilities arrive, and the
 * remote still cannot redirect traffic, attach credentials, or alter the
 * execution environment.
 *
 * The control-plane fields are real, not hypothetical: Pi's own model type
 * carries `headers`, and request options include `apiKey`, `fetch`, `env`,
 * `headers` and `transport`.
 * @type {Set<string>}
 */
const BLOCKED_REMOTE_FIELDS = new Set([
  // identity / routing — this plugin decides these
  'provider', 'baseUrl', 'url', 'endpoint',
  // request headers / authentication
  'headers', 'auth', 'apiKey', 'credentials',
  // execution / network control
  'env', 'fetch', 'proxy', 'transport',
])

/**
 * Fields present in both Pi's catalog and the installed one. Anything outside
 * this set — and outside {@link BLOCKED_REMOTE_FIELDS} — is new and gets an
 * explicit one-time notice: not an error, and not stripped, but worth naming so
 * a Pi-side addition is visible here rather than only in a diff nobody reads.
 * `headers` is listed because Pi does publish it: it is known, and still
 * stripped, like every other control-plane field.
 * @type {Set<string>}
 */
const KNOWN_CATALOG_FIELDS = new Set([
  'id', 'name', 'api', 'provider', 'baseUrl', 'type', 'input', 'inputLimits',
  'reasoning', 'contextWindow', 'maxTokens', 'cost', 'thinkingLevelMap',
  'compat', 'headers',
])

/**
 * The rates pi-ai reads off `model.cost` when billing a turn. All four are read
 * unconditionally in `calculateCost`, and none has a default behind it.
 *
 * A mirror of pi-ai's billing table, and deliberately not derived from anything.
 * Deriving it — from the installed catalog's `cost` keys, say — looks strictly
 * better until it is worked through: the rule would then grow every numeric key
 * any descriptor happened to carry, so a future `cost.currency`-style field, or
 * a per-model surcharge, would make the plugin start *refusing* catalogs that
 * bill perfectly well. That trades a loud, rare mismatch for a wrong gate that
 * widens on data nobody controls. The billing table is a closed spec, so the
 * honest coupling is a written mirror plus a loud failure, and pi-ai's own
 * `calculateCost` is the single place to re-read when a release changes it.
 *
 * Two ways this can drift, with opposite outcomes:
 *
 * - **A rate is added** and a descriptor omits it. Nothing here notices, and the
 *   turn bills `NaN`. Only a read of `calculateCost` catches it.
 * - **A rate is renamed.** Every entry fails this gate, the catalog is refused
 *   whole, and the plugin falls back to the installed catalog — degraded, and
 *   loudly so in the log, never silently misbilling.
 *
 * The second is why the list stays a literal rather than something that fails
 * quietly.
 * @type {string[]}
 */
const RATE_FIELDS = ['input', 'output', 'cacheRead', 'cacheWrite']

/**
 * Fields a descriptor must carry for pi-ai to route it, with the shape each has
 * to have.
 *
 * The size gate cannot see a degraded response: the same 29 ids with the same
 * supported protocols but no capacities would be adopted whole, leaving models in
 * the picker that nothing can size or bill. These are what a request cannot be
 * built without. Everything optional is deliberately absent, so a new Pi field
 * still passes through untouched.
 * @type {Record<string, (value: any) => boolean>}
 */
const REQUIRED_DESCRIPTOR_FIELDS = {
  name: (value) => typeof value === 'string' && value.length > 0,
  contextWindow: (value) => typeof value === 'number' && Number.isFinite(value) && value > 0,
  maxTokens: (value) => typeof value === 'number' && Number.isFinite(value) && value > 0,
  // All four rates, not just the first. pi-ai's calculateCost reads input,
  // output, cacheRead and cacheWrite off the same object, and there is no
  // default behind any of them — a descriptor carrying only `input` bills the
  // other three as NaN rather than as zero.
  //
  // Tiered pricing replaces that rate object wholesale once a usage threshold is
  // crossed, so a tier without the four rates produces exactly the same NaN, just
  // later and only for long conversations. Each tier is held to the same rule.
  // No catalog published so far carries tiers; this guards the path, it is not a
  // response to one.
  cost: (value) => value !== null && typeof value === 'object'
    && RATE_FIELDS.every(rate => Number.isFinite(value[rate]))
    && (value.tiers === undefined
      || (Array.isArray(value.tiers) && value.tiers.every(tier =>
        tier !== null && typeof tier === 'object'
        && RATE_FIELDS.every(rate => Number.isFinite(tier[rate]))))),
  input: (value) => Array.isArray(value) && value.length > 0,
}

/**
 * Strip the control plane from one remote descriptor.
 * @param {any} model - a catalog entry.
 * @returns {any} the entry without any blocked field.
 */
function sanitizeRemoteModel(model) {
  const safe = {}
  for (const [key, value] of Object.entries(model)) {
    if (BLOCKED_REMOTE_FIELDS.has(key)) continue
    safe[key] = value
  }
  return safe
}

/**
 * Keep a descriptor only when the installed pi-ai can actually carry it, and
 * only when the remote cannot redirect traffic.
 * @param {any} model - one catalog entry.
 * @returns {any|undefined} the normalized descriptor, or undefined to drop it.
 */
function normalizeRemoteModel(model) {
  if (!model || typeof model !== 'object' || typeof model.id !== 'string') return undefined
  const baseUrl = OCG_BASE_URLS.get(model.api)
  if (baseUrl === undefined) return undefined
  // `api` doubles as the trust key: a protocol this map does not name is
  // dropped before any of its other fields can reach the transport.
  return { ...sanitizeRemoteModel(model), provider: PROVIDER_ID, baseUrl }
}

/**
 * Name any field this plugin has not seen before, once per process.
 * @param {string[]} unknown - field names outside {@link KNOWN_CATALOG_FIELDS}.
 * @param {any} ctx - plugin context.
 */
function reportUnknownFields(unknown, ctx) {
  const fresh = unknown.filter(field => !state.warnedUnknownFields.has(field))
  if (fresh.length === 0) return
  for (const field of fresh) state.warnedUnknownFields.add(field)
  ctx.logger.warn(
    `${name}: pi.dev introduced new model field(s): ${fresh.join(', ')}; forwarding them unchanged`,
  )
}

/**
 * Report live model names that have no descriptor anywhere.
 *
 * Read after the roster is adopted, because it is a statement about what the
 * picker now offers, not about what the gateway serves.
 * @param {any} ctx - plugin context.
 */
function reportDrift(ctx) {
  // A name the gateway serves but no descriptor exists for: report it, and say
  // why it is absent. Guessing a protocol here would send the request down the
  // wrong transport and fail mid-turn instead of at load.
  const described = new Set([...buildOverlay().keys(), ...effectiveModels().map(model => model.id)])
  const undescribed = [...(state.liveModelIds ?? [])].filter(id => !described.has(id))
  if (undescribed.length === 0) {
    // Disarmed, so a later appearance is reported again rather than staying
    // suppressed by a warning that no longer applies.
    state.lastDriftWarning = null
    return
  }
  // The list only moves when a model is added or dropped, and it is the same
  // handful of names every poll. Repeating it verbatim on a five-minute cycle
  // tells nobody anything new and buries the lines that did change; a different
  // list is worth a line of its own.
  const detail = `${undescribed.join(', ')}. Add them to the Pi catalog with their api,`
    + ' baseUrl, contextWindow and maxTokens.'
  if (state.lastDriftWarning === detail) return
  state.lastDriftWarning = detail
  ctx.logger.warn(
    `${name}: ${undescribed.length} live model(s) have no descriptor yet and are NOT added: ${detail}`,
  )
}

/**
 * Accept a freshly fetched catalog and make it the one in force.
 *
 * Every path that installs a catalog goes through here, including the one that
 * adopts a feed held back for want of a baseline. Those used to differ: the
 * deferred path skipped the ETag and the persist step, so a catalog adopted at
 * that moment was never saved and the next request could not be made
 * conditional — an exit right after it would lose a directory that was known
 * good.
 * @param {{ models: Map<string, any>, unknown: string[], etag?: string | null }} candidate
 * the fetched catalog.
 * @param {number} installedScale - installed catalog size, for the shrink guard.
 * @param {any} ctx - plugin context.
 * @returns {Map<string, any>} the accepted catalog, now the one in force.
 * @throws {Error} when the catalog must not replace the last known one.
 */
function adoptCatalog(candidate, installedScale, ctx) {
  state.remoteCatalog = acceptCatalog(candidate.models, installedScale)
  state.catalogEtag = candidate.etag ?? null
  reportUnknownFields(candidate.unknown, ctx)
  void persistCatalog(state.remoteCatalog, state.catalogEtag, ctx)
  ctx.logger.debug(`${name}: loaded ${state.remoteCatalog.size} model descriptors from pi.dev`)
  return state.remoteCatalog
}

/**
 * Load Pi's catalog into {@link state.remoteCatalog}, noting any field this plugin
 * does not recognize.
 *
 * The empty checks are the same circuit breaker {@link acceptRoster} puts on the
 * live roster, for the same reason: this catalog is replaced wholesale, so an
 * HTTP 200 carrying an empty or reshaped body would otherwise overwrite a good
 * one with nothing — and every model that exists only here would leave the
 * picker without so much as a "catalog fetch failed" in the log, because the
 * fetch did not fail.
 * @returns {Promise<{ models: Map<string, any>, unknown: string[] }>} the
 * descriptors by id, plus the unknown field names seen alongside them.
 * @throws {Error} when the response cannot be trusted to replace the last one.
 */
async function fetchPiCatalog() {
  // Pi serves an ETag, so an unchanged catalog costs one conditional request
  // instead of a full body. The OCG roster sends no validators at all, so it
  // gets none — asking would be guessing.
  const response = await fetchJson(
    PI_CATALOG_URL,
    state.catalogEtag === null ? undefined : { 'if-none-match': state.catalogEtag },
  )
  if (response.status === 304) return { notModified: true }

  const entries = extractCatalogEntries(response.body)
  if (entries.length === 0) {
    throw new Error('pi.dev returned an empty or unrecognized catalog; refusing to replace the last known one')
  }

  const models = new Map()
  const unknown = new Set()
  const incomplete = []
  for (const entry of entries) {
    if (entry !== null && typeof entry === 'object') {
      for (const key of Object.keys(entry)) {
        // A blocked field is a known, deliberately confiscated one — not news.
        if (!KNOWN_CATALOG_FIELDS.has(key) && !BLOCKED_REMOTE_FIELDS.has(key)) unknown.add(key)
      }
    }
    const model = normalizeRemoteModel(entry)
    if (model === undefined) continue
    const missing = Object.keys(REQUIRED_DESCRIPTOR_FIELDS)
      .filter(field => !REQUIRED_DESCRIPTOR_FIELDS[field](model[field]))
    if (missing.length > 0) {
      incomplete.push(`${model.id} (missing or invalid: ${missing.join(', ')})`)
      continue
    }
    models.set(model.id, model)
  }

  // One incomplete entry means the response is not the catalog it claims to be,
  // and a partly-adopted catalog is worse than a stale one: the ids that did
  // parse would displace descriptors that still had their capacities. So the
  // whole thing goes, and the reason is logged rather than guessed at.
  if (incomplete.length > 0) {
    throw new Error(
      `pi.dev returned ${incomplete.length} incomplete descriptors`
      + ` (${incomplete.slice(0, 3).join('; ')}${incomplete.length > 3 ? '; …' : ''});`
      + ' refusing to replace the last known catalog',
    )
  }

  if (models.size === 0) {
    throw new Error(
      `pi.dev sent ${entries.length} entries but none names a protocol this plugin can carry;`
      + ' refusing to replace the last known catalog',
    )
  }
  return { models, unknown: [...unknown], etag: response.etag }
}

/**
 * Read OCG's live roster of model ids.
 * @returns {Promise<Set<string>>} the ids the gateway currently serves.
 */
async function fetchOcgRoster() {
  // No validators are sent: the gateway returns no ETag and no Last-Modified, so
  // there is nothing to make a request conditional on.
  const { body: value } = await fetchJson(OCG_MODELS_URL)
  // The same envelope reader as Pi's catalog — see {@link extractCatalogEntries}
  // for why one parser serves both. A row still has to be an object with a string
  // `id`, which is what keeps a misread envelope arriving as an empty roster for
  // {@link acceptRoster} to refuse rather than as a plausible-looking subset.
  const rows = extractCatalogEntries(value)
  const ids = new Set()
  for (const row of rows) {
    if (row && typeof row === 'object' && typeof row.id === 'string') ids.add(row.id)
  }
  return ids
}

/**
 * A roster's identity, independent of the order the gateway happened to list it
 * in — two polls of the same shrinking roster must produce the same signature.
 * @param {Set<string>} ids - a candidate roster.
 * @returns {string} the signature.
 */
function rosterSignature(ids) {
  return [...ids].sort().join('\n')
}

/**
 * Whether a count is too much smaller than what it is replacing to believe.
 *
 * Shared by both feeds, which are the same kind of failure in the same shape: a
 * response that parses, returns HTTP 200, and is quietly a fraction of the last
 * good one. Half is deliberately not a calibrated constant — it is the point
 * where "the gateway retired most of its models overnight" stops being a more
 * likely story than "we got truncated or partial data".
 * @param {number} nextSize - the incoming count.
 * @param {number} baselineSize - the count being replaced; `0` means none.
 * @returns {boolean} whether the drop looks like a fault rather than a change.
 */
function isSuspiciousShrink(nextSize, baselineSize) {
  return baselineSize > 0 && nextSize * 2 < baselineSize
}

/**
 * Apply the two-confirmation rule to one feed.
 * @param {number} nextSize - the incoming count.
 * @param {number} baselineSize - the count being replaced; `0` disables the check.
 * @param {string} signature - identity of the incoming payload.
 * @param {{ signature: string, size: number } | null} pending - shrink held back
 * last time, if any.
 * @returns {{ accepted: boolean, pending: { signature: string, size: number } | null }}
 * `pending` is the state to store: `null` once the payload is accepted, since
 * a recovered feed must not leave a stale confirmation armed.
 */
function evaluateShrink(nextSize, baselineSize, signature, pending) {
  if (!isSuspiciousShrink(nextSize, baselineSize)) return { accepted: true, pending: null }
  if (pending !== null && pending.signature === signature) return { accepted: true, pending: null }
  return { accepted: false, pending: { signature, size: nextSize } }
}

/**
 * Marks an error as "held back, confirmation pending" rather than "this feed is
 * broken". Only the former must keep its candidate alive: a *refused shrink* is
 * the mechanism working, while an empty body or a failed request is a fresh
 * observation that breaks the consecutive run.
 */
const HELD_BACK = Symbol('dsh-opencode-live-models.held-back')

/**
 * Build an error that marks its feed as held back rather than broken.
 * @param {string} message - the text to log.
 * @returns {Error} the marked error.
 */
function heldBackError(message) {
  const error = new Error(message)
  error[HELD_BACK] = true
  return error
}

/**
 * Whether a refresh error means "held back" (keep the candidate) or "broken"
 * (break the consecutive run).
 * @param {any} error - the thrown value.
 * @returns {boolean} whether the held-back candidate should survive.
 */
function keepsCandidate(error) {
  return error?.[HELD_BACK] === true
}

/**
 * Gate Pi's catalog before it is allowed to replace the last known good one.
 *
 * {@link fetchPiCatalog} already refuses the empty cases, because an empty map is
 * unambiguous. A *partial* one is not: a response that parses and carries HTTP
 * 200 can still be a fraction of the real catalog, and swapping it in would drop
 * every model that only Pi carries. The two feeds fail the same way, so the
 * roster's rule applies unchanged — the same shrink twice in a row is believed,
 * a return to normal disarms the pending confirmation.
 * @param {Map<string, any>} next - the freshly loaded catalog.
 * @param {number} baselineSize - installed catalog scale, used on first boot when
 * there is no previous Pi catalog to measure against.
 * @returns {Map<string, any>} `next`, to be adopted.
 * @throws {Error} when the catalog must not replace the last known good one.
 */
function acceptCatalog(next, baselineSize) {
  if (next.size === 0) {
    state.pendingCatalogShrink = null
    throw new Error('pi.dev returned an empty catalog; refusing to replace the last known one')
  }
  const baseline = state.remoteCatalog.size > 0 ? state.remoteCatalog.size : baselineSize
  const verdict = evaluateShrink(next.size, baseline, catalogFingerprint([...next.values()]), state.pendingCatalogShrink)
  state.pendingCatalogShrink = verdict.pending
  if (!verdict.accepted) {
    throw heldBackError(
      `catalog suspicious shrink ${baseline} -> ${next.size} held back pending confirmation;`
      + ' the same catalog twice in a row will be accepted',
    )
  }
  return next
}

/**
 * Gate a fetched roster before it is allowed to replace the last known good one.
 *
 * The roster decides which installed models survive, so a bad one is not a
 * cosmetic problem: accepting a bogus empty or truncated roster silently deletes
 * models from the picker with nothing in the log to explain it. Two failures are
 * separated here:
 *
 * - **Empty** — always a failure. An empty result means the envelope changed, the
 *   field moved, or the gateway is broken, and none of those mean "OCG serves
 *   nothing". Never even recorded as a candidate.
 * - **Suspicious shrink** — below half the baseline. Real mass retirement is
 *   rare and a wrong guess is expensive, so the first such poll is held back with
 *   a warning and only the *same* shrink a second time is believed. A roster
 *   that returns to normal cancels the pending shrink.
 *
 * "The same shrink a second time" means *consecutively*. Any poll that does not
 * deliver it breaks the sequence, so every failure path clears the candidate:
 * without that, `43 → 18 → 0 → 18` confirms on the last poll, because the empty
 * response in the middle left the earlier candidate armed and the two sightings
 * were never actually consecutive.
 *
 * `baselineSize` is what the first ever roster is measured against. Without it a
 * cold boot has nothing to compare to and would happily accept a one-entry
 * response, wiping every installed model but the one it happened to name.
 * @param {Set<string>} next - the freshly fetched roster.
 * @param {number} baselineSize - installed catalog scale, used only on first boot.
 * @returns {Set<string>} `next`, to be adopted.
 * @throws {Error} when the roster must not replace the last known good one.
 */
function acceptRoster(next, baselineSize) {
  if (next.size === 0) {
    state.pendingShrink = null
    throw new Error('empty roster; an empty result means a broken or reshaped response, not "OCG serves nothing"')
  }
  const baseline = state.liveModelIds !== null ? state.liveModelIds.size : baselineSize
  const verdict = evaluateShrink(next.size, baseline, rosterSignature(next), state.pendingShrink)
  // Record before throwing: the held-back signature is the whole mechanism, and
  // a confirmation that never records itself can never be given.
  state.pendingShrink = verdict.pending
  if (!verdict.accepted) {
    throw heldBackError(
      `roster suspicious shrink ${baseline} -> ${next.size} held back pending confirmation;`
      + ' the same roster twice in a row will be accepted',
    )
  }
  return next
}

/**
 * Descriptors this plugin contributes, all of them from Pi's catalog.
 *
 * Nothing is bundled, so there is no local copy to reconcile against the
 * installed catalog: a Pi entry for an id the installed catalog also carries is
 * meant to win, which is the plugin's whole purpose.
 *
 * Pi's entries are deliberately *not* filtered against the live roster. A model
 * Pi still publishes while OCG has retired it — or has not indexed it yet —
 * stays selectable until Pi drops it, and following Pi's cadence is the contract
 * here. Treating a gateway gap as a retirement is the kind of guess this plugin
 * refuses to make elsewhere; it would be worst here, because the ids at stake
 * are exactly the ones Pi is ahead on.
 * @returns {Map<string, any>} contributed descriptors by id.
 */
function buildOverlay() {
  const result = new Map()
  for (const [id, model] of state.remoteCatalog) result.set(id, model)
  return result
}

/**
 * Order the merged roster.
 *
 * Plain concatenation reads as two blocks — the installed catalog's order, then
 * every new model piled on the end — because `Map.set` never moves an existing
 * key and the overlay can therefore only append. So the order is rebuilt instead:
 *
 * - **Spine:** the order Pi's catalog publishes, which is authoritative and
 *   version-aware. A model the gateway added but the installed catalog predates
 *   lands on the spine with everyone else, not in a trailing block.
 * - **Anchored insertions:** the few models only the installed catalog carries
 *   (`omen-alpha`, `qwen3.6-plus`, ...) are inserted before their nearest
 *   following spine model, so a family stays together: `glm-5.1` goes *before*
 *   `glm-5.2`, not after it.
 * - **Tail:** an installed model with no following spine entry to anchor on
 *   goes last.
 *
 * Without a spine (Pi's catalog unreachable or empty) the installed order is
 * returned untouched, so the degraded path keeps behaving exactly as before.
 * @param {Map<string, any>} merged - the full roster, by id.
 * @param {any[]} installed - the provider's own models, in catalog order.
 * @returns {any[]} the ordered roster.
 */
function orderModels(merged, installed) {
  // The spine follows Pi's published order, read from the catalog itself rather
  // than from `merged`: `merged` iterates in insertion order, which is exactly
  // the concatenation this function exists to undo.
  const spine = []
  for (const id of state.remoteCatalog.keys()) {
    const model = merged.get(id)
    if (model !== undefined) spine.push(model)
  }
  if (spine.length === 0) return [...merged.values()]

  const onSpine = new Set(spine.map(model => model.id))
  const pending = new Set(merged.keys())
  for (const id of onSpine) pending.delete(id)

  // Walk the installed catalog forward so several insertions sharing one anchor
  // keep their own relative order, and look *forward* for the anchor: a model
  // belongs next to the family it precedes, not the one it follows.
  const before = new Map()
  for (let i = 0; i < installed.length; i += 1) {
    const model = installed[i]
    if (onSpine.has(model.id) || !pending.has(model.id)) continue
    for (let j = i + 1; j < installed.length; j += 1) {
      const anchor = installed[j].id
      if (!onSpine.has(anchor) || !merged.has(anchor)) continue
      const bucket = before.get(anchor)
      if (bucket === undefined) before.set(anchor, [model])
      else bucket.push(model)
      break
    }
  }

  const ordered = []
  for (const model of spine) {
    for (const inserted of before.get(model.id) ?? []) {
      ordered.push(inserted)
      pending.delete(inserted.id)
    }
    ordered.push(model)
  }
  for (const model of merged.values()) {
    if (pending.has(model.id)) ordered.push(model)
  }
  return ordered
}

/**
 * Merge the installed roster with Pi's catalog.
 *
 * The installed catalog is the floor: `mergeModels` keeps every installed model
 * the live roster still lists, then layers Pi's descriptors on top. That is what
 * preserves the models Pi does not carry but the installed pi-ai does
 * (`omen-alpha`, `qwen3.6-plus`, and three more), and what lets a Pi entry
 * update an installed model rather than be shadowed by it.
 * @param {any[]} installed - the provider's own models.
 * @returns {any[]} the merged, ordered roster.
 */
function mergeModels(installed) {
  const merged = new Map()
  for (const model of installed) {
    if (state.liveModelIds === null || state.liveModelIds.has(model.id)) merged.set(model.id, model)
  }
  const installedIds = new Set(installed.map(model => model.id))
  for (const [id, model] of buildOverlay(installedIds)) merged.set(id, model)
  return orderModels(merged, installed)
}

/**
 * Wrap the `opencode-go` provider so its `getModels()` returns the merged roster.
 *
 * Only `getModels` is replaced. `stream` / `streamSimple` are forwarded to the
 * original provider so dispatch keeps the installed pi-ai's transport, its auth
 * resolution, and any provider-level headers.
 * @param {any} models - the pi-ai `Models` collection from a live snapshot.
 * @param {any} ctx - plugin context, for the install diagnostic.
 * @returns {boolean} whether a provider was wrapped by this call.
 */
function patchModelsCollection(models, ctx) {
  if (models === null || typeof models !== 'object') return false
  if (typeof models.getProvider !== 'function' || typeof models.setProvider !== 'function') return false

  const base = models.getProvider(PROVIDER_ID)
  if (base === undefined || base === null) return false
  if (base[WRAPPED] === true) {
    // Already wrapped — possibly by a previous instance of this module, whose
    // closure is stale. It reads the shared state, so the takeover below is all
    // it needs; re-wrapping would only stack another layer.
    return true
  }

  const originalGetModels = base.getModels.bind(base)
  const hasGetAllModels = typeof base.getAllModels === 'function'
  const originalGetAllModels = hasGetAllModels ? base.getAllModels.bind(base) : undefined

  // Dispatch through `state.merge` rather than this module's `mergeModels`
  // directly: the closure outlives a hot reload, and what must stay current is
  // the behaviour, not the module that first installed it.
  const wrapped = {
    ...base,
    [WRAPPED]: true,
    getModels: () => state.merge(originalGetModels()),
    ...(hasGetAllModels ? { getAllModels: () => state.merge(originalGetAllModels()) } : {}),
    stream: (model, context, options) => base.stream(model, context, options),
    streamSimple: (model, context, options) => base.streamSimple(model, context, options),
  }

  models.setProvider(wrapped)
  // Remember what we replaced, so unload can undo it. Keyed by collection
  // because a rebuilt snapshot is a different object, and the guard in
  // unpatchAll only restores while ours is still the installed provider.
  state.providers.set(models, { original: base, wrapped })
  ctx.logger.info(`${name}: installed live catalog overlay on ${PROVIDER_ID}`)
  return true
}

/**
 * Patch one DSH adapter so every snapshot it builds carries the overlay.
 *
 * `current()` is the seam: it memoizes one `{ profiles, models }` snapshot and
 * rebuilds it whenever the profiles change, so hooking it covers both the first
 * request and every later configuration change.
 * @param {any} adapter - the `llm-pi-ai` adapter instance.
 * @param {any} ctx - plugin context.
 * @returns {boolean} whether the adapter was patched by this call.
 */
function patchAdapter(adapter, ctx) {
  if (adapter === null || adapter === undefined) return false
  if (typeof adapter.current !== 'function') return false

  // Already hooked — by this instance, or by the one a hot reload replaced. Either
  // way the hook must not be stacked: a second layer would capture the first as
  // its "original", and unloading once would then peel off only the outermost,
  // leaving the adapter permanently wrapped.
  const existing = state.hooks.get(adapter)
  if (existing !== undefined && adapter.current === existing.hooked) return true

  // Keep the unbound reference: restoring a `.bind()` result would leave the
  // adapter holding a function it never had, which is its own kind of residue.
  const originalCurrent = adapter.current
  const hooked = function patchedCurrent(...args) {
    const snapshot = originalCurrent.apply(adapter, args)
    try {
      patchModelsCollection(snapshot?.models, ctx)
    } catch (error) {
      ctx.logger.warn(`${name}: could not overlay the model catalog: ${error?.message ?? error}`)
    }
    return snapshot
  }
  adapter.current = hooked
  // Recorded on the shared state, keyed by adapter: a reload that hooks the same
  // adapter again replaces the entry, and unloading has something to put back.
  state.hooks.set(adapter, { originalCurrent, hooked })

  // The adapter may already hold a snapshot from before this plugin mounted.
  try { patchModelsCollection(adapter.current()?.models, ctx) } catch { /* not ready yet */ }
  return true
}

/**
 * Undo everything this instance installed: the adapter hooks and the wrapped
 * providers, so unloading leaves the installed pi-ai exactly as it was found.
 *
 * Both restorations are guarded. A newer instance may have replaced either one,
 * and undoing its work would be worse than leaving ours in place.
 * @returns {number} how many patches were removed.
 */
function unpatchAll() {
  let restored = 0
  for (const [adapter, hook] of state.hooks) {
    if (adapter.current === hook.hooked) {
      adapter.current = hook.originalCurrent
      restored += 1
    }
  }
  state.hooks.clear()
  for (const [models, entry] of state.providers) {
    if (models.getProvider(PROVIDER_ID) === entry.wrapped) {
      models.setProvider(entry.original)
      restored += 1
    }
  }
  state.providers.clear()
  return restored
}

/**
 * Locate the adapter that owns the route and patch it.
 * @param {any} ctx - plugin context.
 * @returns {boolean} whether an adapter was found and patched.
 */
function installIntoCurrentAdapter(ctx) {
  try {
    const registration = ctx.llm?.adapters?.get?.(PROVIDER_ID)
    return patchAdapter(registration?.adapter, ctx)
  } catch (error) {
    ctx.logger.warn(`${name}: cannot reach the ${PROVIDER_ID} adapter: ${error?.message ?? error}`)
    return false
  }
}

/**
 * The catalog DSH can currently see, read through the patched provider, i.e.
 * the merged result rather than the raw installed one. This is both the set of
 * ids that *have* a descriptor — what the drift report is about — and the thing
 * whose change DSH needs to hear about.
 * @returns {any[]} the effective models; empty before the first snapshot.
 */
function effectiveModels() {
  try {
    const registration = currentRegistration()
    const snapshot = registration?.adapter?.current?.()
    return snapshot?.models?.getModels?.(PROVIDER_ID) ?? []
  } catch {
    return []
  }
}

/** @returns {any} the `opencode-go` adapter registration, if any. */
function currentRegistration() {
  return adapterRegistryRef?.get?.(PROVIDER_ID) ?? null
}

/**
 * Reference to the adapter registry, captured in {@link apply} so the
 * module-level helpers above need no import. Note this is the `adapters` map
 * itself, not the `llm` service wrapping it.
 * @type {Map<string, any> | null}
 */
let adapterRegistryRef = null

/**
 * Recursively put a value into a shape whose serialization does not depend on
 * key insertion order, so an upstream reordering is not mistaken for a change.
 * @param {any} value - any JSON-ish value.
 * @returns {any} the canonical form.
 */
function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map(key => [key, stableValue(value[key])]),
    )
  }
  return value
}

/**
 * Fingerprint of what DSH would see.
 *
 * It covers **every field that survived {@link sanitizeRemoteModel}**, not a
 * maintained list of known ones. A forward allowlist would contradict the
 * plugin's own trust model: an unknown field is forwarded on purpose, so a
 * change to it — Pi adding `output`, then changing it — has to reach the
 * consumer too. Enumerating fields would produce exactly the half-compatible
 * state where the new capability arrives in the descriptor but the picker that
 * caches the catalog never reloads to show it.
 *
 * The *order of the models* is kept, while the order of an object's keys is
 * normalized. That split is the point: {@link orderModels} goes out of its way
 * to put the picker in Pi's published order, so a reordering upstream is a
 * change DSH can see, and sorting the models by id here would flatten precisely
 * that back into a no-op. Key order inside a descriptor means nothing, so
 * {@link stableValue} still normalizes it.
 *
 * A descriptor that cannot be canonicalized (a cycle, a getter that throws)
 * degrades to its id rather than taking the whole refresh down with it.
 * @param {any[]} models - the effective catalog, in the order DSH sees it.
 * @returns {string} the fingerprint.
 */
function catalogFingerprint(models) {
  return JSON.stringify(
    models.map((model) => {
      try {
        return { id: model.id, descriptor: stableValue(model) }
      } catch {
        return { id: model.id, descriptor: null }
      }
    }),
  )
}

/**
 * Emit `llm/adapters-updated` only when the catalog DSH sees really changed.
 *
 * Both feeds are polled every five minutes and normally answer with byte-identical
 * data, so emitting unconditionally would make DSH reload the picker forever and
 * fill the log with a line that means nothing. The first publish always emits, so
 * a cold start still reaches the consumer.
 * @param {any} ctx - plugin context.
 */
function publishIfChanged(ctx) {
  const models = effectiveModels()
  // Nothing to say before the adapter exists: an empty catalog is not a state
  // worth announcing, and publishing it would make the picker look emptied
  // rather than merely not-yet-populated.
  if (models.length === 0) return
  const fingerprint = catalogFingerprint(models)
  if (state.publishedCatalog !== null && state.publishedCatalog.fingerprint === fingerprint) {
    ctx.logger.debug(`${name}: catalog unchanged at ${models.length} models; not re-emitting`)
    return
  }

  const ids = models.map(model => model.id)
  if (state.publishedCatalog === null) {
    ctx.logger.info(`${name}: catalog published: ${ids.length} models`)
  } else {
    const before = new Set(state.publishedCatalog.ids)
    const added = ids.filter(id => !before.has(id))
    const removed = state.publishedCatalog.ids.filter(id => !ids.includes(id))
    ctx.logger.info(`${name}: catalog updated: ${before.size} -> ${ids.length} models`)
    if (added.length > 0) ctx.logger.info(`${name}: added: ${added.join(', ')}`)
    if (removed.length > 0) ctx.logger.info(`${name}: removed: ${removed.join(', ')}`)
  }

  state.publishedCatalog = { fingerprint, ids }
  ctx.emit('llm/adapters-updated')
}

/**
 * Reload both remote sources and re-publish the catalog.
 *
 * The two reads are independent, so they run together: run in sequence, the
 * cold-start cost is the sum of both round trips and the worst case doubles to
 * 16s on two 8s timeouts. In parallel it is the slower of the two. The handling
 * below stays strictly ordered — Pi's catalog first, then the roster — because
 * the drift report reads the overlay that the catalog produces.
 * @param {any} ctx - plugin context.
 * @returns {Promise<void>} resolves once this refresh settled.
 */
async function refreshCatalog(ctx) {
  if (refreshing !== null && refreshingGeneration === activeGeneration) return refreshing

  // Joinable only within the mount that started it. A second `apply()` on the
  // same module object would otherwise be handed the previous mount's promise —
  // whose result the generation check then discards, leaving the new mount with
  // no data at all and the picker on the installed catalog until the next poll.
  refreshingGeneration = activeGeneration
  const mine = (async () => {
    const myGeneration = activeGeneration
    const [catalog, roster] = await Promise.allSettled([fetchPiCatalog(), fetchOcgRoster()])

    // A plain `disposed` flag is not enough: it lives in the shared state, so a
    // new instance resets it to false and an old request still in flight would
    // then happily write into the state the new instance is using. Comparing
    // generations identifies *whose* answer this is — after a reload or an
    // unload, the number has moved on and this result is dropped.
    if (state.generation !== myGeneration) return

    // The installed catalog is the scale both first-boot gates measure against.
    const installedScale = effectiveModels().length

    if (catalog.status === 'fulfilled') {
      try {
        if (catalog.value.notModified === true) {
          // 304: what we hold is still current. Nothing to parse, nothing to
          // re-judge, and no reason to count it as a change.
          ctx.logger.debug(`${name}: pi.dev catalog unchanged (304); keeping ${state.remoteCatalog.size} descriptors`)
        } else if (installedScale === 0) {
          // With no installed catalog in sight yet, any catalog could be judged
          // implausible; hold it rather than measure against nothing.
          state.deferredCatalog = catalog.value
        } else {
          adoptCatalog(catalog.value, installedScale, ctx)
        }
      } catch (error) {
        if (!keepsCandidate(error)) state.pendingCatalogShrink = null
        ctx.logger.warn(`${name}: pi.dev catalog refresh failed (${error?.message ?? error}); keeping the last known catalog`)
      }
    } else {
      state.pendingCatalogShrink = null
      ctx.logger.warn(
        `${name}: pi.dev catalog refresh failed (${catalog.reason?.message ?? catalog.reason});`
        + ' keeping the last known catalog',
      )
    }

    if (roster.status === 'fulfilled') {
      try {
        // An adapter that has not registered yet leaves the installed catalog
        // invisible, so a one-entry roster would look fine against a baseline of
        // zero and then delete 5 real models the moment the adapter shows up.
        // Hold it until there is something real to measure against.
        if (installedScale === 0) state.deferredRoster = roster.value
        else {
          state.liveModelIds = acceptRoster(roster.value, installedScale)
          ctx.logger.debug(`${name}: OpenCode Go currently exposes ${state.liveModelIds.size} models`)
          reportDrift(ctx)
        }
      } catch (error) {
        if (!keepsCandidate(error)) state.pendingShrink = null
        // Deliberately keeps the previous roster: the picker losing models with
        // only a fetch that "succeeded" to blame is the failure mode this guards.
        ctx.logger.warn(`${name}: OCG roster refresh failed (${error?.message ?? error}); keeping the last known roster`)
      }
    } else {
      state.pendingShrink = null
      ctx.logger.warn(
        `${name}: OCG roster refresh failed (${roster.reason?.message ?? roster.reason});`
        + ' keeping the last known roster',
      )
    }

    installIntoCurrentAdapter(ctx)
    publishIfChanged(ctx)
  })()
  // Only clear the slot if it is still ours: a newer mount may already own it.
  refreshing = mine
  mine.finally(() => { if (refreshing === mine) refreshing = null })

  return mine
}

/**
 * Mount the overlay.
 *
 * Returns as soon as the patches are in place and whatever catalog is already
 * known has been published. The first refresh runs behind that, on purpose:
 * mounting must not wait on two round trips to a public API, and the picker is
 * already correct in the meantime. Callers who want the live catalog listen for
 * `llm/adapters-updated` rather than awaiting this call.
 * @param {any} ctx - plugin context.
 * @returns {void}
 */
/**
 * Re-judge anything held back for want of a baseline, now that an adapter is
 * visible. Returns whether anything was adopted, so the caller knows to publish.
 * @param {any} ctx - plugin context.
 * @returns {boolean} whether a deferred feed was adopted on this call.
 */
function applyDeferredFeeds(ctx) {
  const scale = effectiveModels().length
  if (scale === 0) return false
  let adopted = false

  // Both candidates are consumed by this call whatever the verdict. Leaving a
  // rejected one in place would let the next `llm/adapters-updated` re-judge the
  // *same bytes* and count as the second sighting — the confirmation has to come
  // from a fresh response, not from the plugin asking itself a second time.
  if (state.deferredCatalog !== null) {
    const candidate = state.deferredCatalog
    state.deferredCatalog = null
    try {
      adoptCatalog(candidate, scale, ctx)
      adopted = true
    } catch (error) {
      ctx.logger.warn(`${name}: pi.dev catalog refresh failed (${error?.message ?? error}); keeping the last known catalog`)
    }
  }

  if (state.deferredRoster !== null) {
    const candidate = state.deferredRoster
    state.deferredRoster = null
    try {
      state.liveModelIds = acceptRoster(candidate, scale)
      ctx.logger.debug(`${name}: OpenCode Go currently exposes ${state.liveModelIds.size} models`)
      reportDrift(ctx)
      adopted = true
    } catch (error) {
      // Held back, now with a real baseline to hold it against. Only the next
      // poll can confirm it.
      ctx.logger.warn(`${name}: OCG roster refresh failed (${error?.message ?? error}); keeping the last known roster`)
    }
  }

  return adopted
}

export function apply(ctx) {
  adapterRegistryRef = ctx.llm?.adapters ?? null
  // Take over the shared state: whichever instance loaded last supplies the
  // behaviour, so a wrapper installed before a hot reload keeps working and
  // starts reflecting this instance's catalog.
  state.merge = (installed) => mergeModels(installed)

  // Claim the state, and keep the claim in a local: the disposer below has to
  // know whether *this* mount is still the current one, and a module-level
  // variable would have been overwritten by a later mount before this closure
  // ever runs.
  const myGeneration = state.generation + 1
  state.generation = myGeneration
  activeGeneration = myGeneration

  installIntoCurrentAdapter(ctx)

  // The adapter can register after this plugin, and re-register on a settings
  // change, so re-patch whenever the registry announces a change. That event is
  // also the first moment the installed catalog becomes measurable, which is
  // when anything held back for a missing baseline can finally be judged.
  ctx.on('llm/adapters-updated', () => {
    installIntoCurrentAdapter(ctx)
    if (applyDeferredFeeds(ctx)) publishIfChanged(ctx)
  })

  // Publish what is already true before touching the network. The installed
  // catalog *is* a correct catalog — the one the user would have seen with the
  // plugin absent — so the picker can be filled the moment we mount, instead of
  // after two public round trips. Anything a
  // previous session left behind is folded in first, and the refresh below
  // publishes again if it changes anything.
  //
  // The cache read and that first refresh race for `catalogEtag`, and a
  // validator that lands after the request has been built is worth nothing: the
  // first poll of every restart would be a full download, and the ETag we went
  // to the trouble of persisting would only start working on the second one.
  // Reading a local file is far cheaper than a round trip, so the refresh waits
  // for it. Nothing here is awaited by the caller: a cold, slow or unreadable
  // disk delays the refresh, never the mount, and restoreCatalog resolves to null
  // on any failure at all.
  const restored = state.remoteCatalog.size === 0
    ? restoreCatalog().then((cached) => {
      if (cached === null || state.generation !== myGeneration) return
      if (state.remoteCatalog.size > 0) return   // something else got there first
      state.remoteCatalog = cached.models
      // A stale validator is harmless: the server answers 200 with the current
      // one, and the catalog that came with it is only kept if nothing overwrote
      // it in the meantime.
      state.catalogEtag = cached.etag
      publishIfChanged(ctx)
    })
    : Promise.resolve()

  publishIfChanged(ctx)

  void restored.then(() => {
    if (state.generation === myGeneration) void refreshCatalog(ctx)
  })

  ctx.effect(() => {
    const timer = setInterval(() => { void refreshCatalog(ctx) }, REFRESH_INTERVAL_MS)
    timer.unref?.()
    return () => { clearInterval(timer) }
  })

  // Unloading has to undo the monkey patches — leaving a wrapped provider behind
  // would keep rewriting the picker for a plugin that no longer exists — and to
  // move the generation on, so a refresh already in flight cannot write into the
  // state the next instance is about to inherit.
  //
  // Only when this mount still owns the state. Under a hot reload the new
  // instance mounts *before* the old one unloads, and by then the recorded hooks
  // and providers are the new instance's. Unwinding them here would take the
  // live overlay down with a plugin that is no longer running.
  ctx.effect(() => () => {
    if (state.generation !== myGeneration) return
    unpatchAll()
    state.generation += 1
  })
}
