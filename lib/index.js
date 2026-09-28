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
 * This module imports nothing at runtime. A profile's `node_modules` cannot
 * resolve the DSH packages, which live inside `app.asar` in the installed
 * desktop client, so `import '@deepseek-ai/dsh-llm'` fails with
 * `MODULE_NOT_FOUND`. The plugin reaches the running pi-ai instance through
 * `ctx.llm.adapters` — a TypeScript-`private` field that is an ordinary Map at
 * runtime — which is the same path `dsh-opencode-session` uses.
 *
 * ## Sources, in priority order
 *
 * 1. `https://pi.dev/api/models/providers/opencode-go?types=chat` — Pi's own
 *    catalog, carrying complete descriptors (capacities, compat,
 *    thinkingLevelMap). Authoritative and pre-verified by Pi. It decides which
 *    models exist and what they can do; {@link OCG_BASE_URLS} decides where
 *    requests go, so the remote cannot redirect traffic.
 * 2. `FALLBACK_MODELS` below — the two models this plugin exists to make
 *    reachable, used when the remote catalog cannot be fetched.
 * 3. The installed catalog, untouched, so a model Pi has not published yet is
 *    never dropped from the picker just because the remote fetch was partial.
 *
 * `https://opencode.ai/zen/go/v1/models` supplies the live roster, gated by
 * {@link acceptRoster} because it alone decides which installed models survive.
 * A name with no descriptor is reported, not guessed.
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
const PI_CATALOG_URL = 'https://pi.dev/api/models/providers/opencode-go?types=chat'
const OCG_MODELS_URL = 'https://opencode.ai/zen/go/v1/models'
const REFRESH_INTERVAL_MS = 5 * 60 * 1000
const FETCH_TIMEOUT_MS = 8000

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
 * @type {Record<string, string>}
 */
const OCG_BASE_URLS = {
  'anthropic-messages': 'https://opencode.ai/zen/go',
  'openai-completions': 'https://opencode.ai/zen/go/v1',
  'openai-responses': 'https://opencode.ai/zen/go/v1',
}

/** Marker so a provider is never wrapped twice, even across adapter rebuilds. */
const WRAPPED = Symbol.for('dsh-opencode-live-models.provider')

/** Adapters already patched, so a configuration reload does not stack wrappers. */
const patchedAdapters = new WeakSet()

/** Latest complete descriptors from Pi's catalog, by model id. */
let remoteCatalog = new Map()

/**
 * OCG's live roster. `null` means "not known yet" or "last fetch failed", in
 * which case no membership filtering happens at all — an empty roster must never
 * be read as "OCG serves nothing".
 */
let liveModelIds = null

/**
 * A shrink that {@link acceptRoster} refused on first sight, remembered so the
 * same one twice in a row is treated as a real retirement. `null` when there is
 * no shrink awaiting confirmation.
 * @type {{ signature: string, size: number } | null}
 */
let pendingShrink = null

/**
 * Fingerprint of the catalog DSH last saw, and the ids it was made of. `null`
 * until the first refresh publishes something, so a cold start always emits.
 * @type {{ fingerprint: string, ids: string[] } | null}
 */
let publishedCatalog = null

/** In-flight refresh, so a slow network does not stack overlapping fetches. */
let refreshing = null

/**
 * Minimum viable descriptors for the two models that motivated this plugin, so
 * they stay reachable even when Pi's catalog is unreachable. The values are Pi's
 * published ones; `apply()` logs when a fallback entry is the only source.
 */
const FALLBACK_MODELS = new Map([
  ['deepseek-v4.1-flash', {
    id: 'deepseek-v4.1-flash',
    name: 'DeepSeek V4.1 Flash',
    provider: PROVIDER_ID,
    api: 'openai-completions',
    baseUrl: OCG_BASE_URLS['openai-completions'],
    reasoning: true,
    input: ['text', 'image'],
    thinkingLevelMap: { off: null, minimal: null, low: 'low', medium: null, high: 'high', xhigh: null, max: 'max' },
    contextWindow: 1000000,
    maxTokens: 384000,
    cost: { input: 0.15, output: 0.6, cacheRead: 0.003, cacheWrite: 0 },
    compat: {
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsStrictMode: true,
      maxTokensField: 'max_tokens',
      requiresReasoningContentOnAssistantMessages: true,
      thinkingFormat: 'deepseek',
    },
  }],
  ['space-bunny-free', {
    id: 'space-bunny-free',
    name: 'Space Bunny Free',
    provider: PROVIDER_ID,
    api: 'openai-completions',
    baseUrl: OCG_BASE_URLS['openai-completions'],
    reasoning: true,
    input: ['text', 'image'],
    thinkingLevelMap: { off: null, minimal: null, low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' },
    contextWindow: 1048576,
    maxTokens: 524288,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    compat: {
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsStrictMode: true,
      maxTokensField: 'max_tokens',
    },
  }],
])

/**
 * Fetch and parse one JSON document.
 * @param {string} url - absolute URL.
 * @returns {Promise<any>} the parsed body.
 * @throws {Error} on a non-2xx status or a transport failure.
 */
async function fetchJson(url) {
  const response = await fetch(url, {
    headers: { accept: 'application/json', 'user-agent': 'dsh-opencode-live-models/0.1.1' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`)
  return response.json()
}

/**
 * Pull the model array out of whichever envelope the endpoint used.
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

/** Unknown fields already named in a warning, so a five-minute poll stays quiet. */
const warnedUnknownFields = new Set()

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
  const baseUrl = OCG_BASE_URLS[model.api]
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
  const fresh = unknown.filter(field => !warnedUnknownFields.has(field))
  if (fresh.length === 0) return
  for (const field of fresh) warnedUnknownFields.add(field)
  ctx.logger.warn(
    `${name}: pi.dev introduced new model field(s): ${fresh.join(', ')}; forwarding them unchanged`,
  )
}

/**
 * Load Pi's catalog into {@link remoteCatalog}, noting any field this plugin
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
  const entries = extractCatalogEntries(await fetchJson(PI_CATALOG_URL))
  if (entries.length === 0) {
    throw new Error('pi.dev returned an empty or unrecognized catalog; refusing to replace the last known one')
  }

  const models = new Map()
  const unknown = new Set()
  for (const entry of entries) {
    if (entry !== null && typeof entry === 'object') {
      for (const key of Object.keys(entry)) {
        // A blocked field is a known, deliberately confiscated one — not news.
        if (!KNOWN_CATALOG_FIELDS.has(key) && !BLOCKED_REMOTE_FIELDS.has(key)) unknown.add(key)
      }
    }
    const model = normalizeRemoteModel(entry)
    if (model !== undefined) models.set(model.id, model)
  }

  if (models.size === 0) {
    throw new Error(
      `pi.dev sent ${entries.length} entries but none names a protocol this plugin can carry;`
      + ' refusing to replace the last known catalog',
    )
  }
  return { models, unknown: [...unknown] }
}

/**
 * Read OCG's live roster of model ids.
 * @returns {Promise<Set<string>>} the ids the gateway currently serves.
 */
async function fetchOcgRoster() {
  const value = await fetchJson(OCG_MODELS_URL)
  const rows = Array.isArray(value) ? value : Array.isArray(value?.data) ? value.data : []
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
 * - **Suspicious shrink** — below half the previous size. Real mass retirement is
 *   rare and a wrong guess is expensive, so the first such poll is held back with
 *   a warning and only the *same* shrink a second time is believed. A roster
 *   that returns to normal cancels the pending shrink.
 * @param {Set<string>} next - the freshly fetched roster.
 * @returns {Set<string>} `next`, to be adopted.
 * @throws {Error} when the roster must not replace the last known good one.
 */
function acceptRoster(next) {
  if (next.size === 0) {
    throw new Error('empty roster; an empty result means a broken or reshaped response, not "OCG serves nothing"')
  }
  if (liveModelIds === null) {
    pendingShrink = null
    return next
  }
  if (next.size * 2 >= liveModelIds.size) {
    pendingShrink = null
    return next
  }
  const signature = rosterSignature(next)
  if (pendingShrink !== null && pendingShrink.signature === signature) {
    pendingShrink = null
    return next
  }
  pendingShrink = { signature, size: next.size }
  throw new Error(
    `suspicious shrink ${liveModelIds.size} -> ${next.size} held back pending confirmation;`
    + ' the same roster twice in a row will be accepted',
  )
}

/**
 * Descriptors this plugin contributes, fallbacks first so the remote catalog
 * wins. Nothing is filtered against the live roster here: a model Pi still
 * publishes but OCG has not yet indexed is more likely a rollout lag than a
 * retirement, and dropping it from the picker would be the more damaging error.
 * @returns {Map<string, any>} contributed descriptors by id.
 */
function buildOverlay() {
  const result = new Map(FALLBACK_MODELS)
  for (const [id, model] of remoteCatalog) result.set(id, model)
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
 * - **Tail:** anything with no anchor — a fallback entry while Pi's catalog is
 *   reachable, or an installed model nothing follows — goes last.
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
  for (const id of remoteCatalog.keys()) {
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
 * Merge the installed roster with the overlay.
 *
 * The installed catalog is the floor and is never emptied: `mergeModels` keeps
 * every installed model the live roster still lists, then layers the overlay on
 * top. That is what preserves the five models Pi's catalog does not carry but
 * the installed pi-ai does (`omen-alpha`, `qwen3.6-plus`, and three more).
 * @param {any[]} installed - the provider's own models.
 * @returns {any[]} the merged, ordered roster.
 */
function mergeModels(installed) {
  const merged = new Map()
  for (const model of installed) {
    if (liveModelIds === null || liveModelIds.has(model.id)) merged.set(model.id, model)
  }
  for (const [id, model] of buildOverlay()) merged.set(id, model)
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
  if (base === undefined || base === null || base[WRAPPED] === true) return false

  const originalGetModels = base.getModels.bind(base)
  const hasGetAllModels = typeof base.getAllModels === 'function'
  const originalGetAllModels = hasGetAllModels ? base.getAllModels.bind(base) : undefined

  const wrapped = {
    ...base,
    [WRAPPED]: true,
    getModels: () => mergeModels(originalGetModels()),
    ...(hasGetAllModels ? { getAllModels: () => mergeModels(originalGetAllModels()) } : {}),
    stream: (model, context, options) => base.stream(model, context, options),
    streamSimple: (model, context, options) => base.streamSimple(model, context, options),
  }

  models.setProvider(wrapped)
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
  if (adapter === null || adapter === undefined || patchedAdapters.has(adapter)) return false
  if (typeof adapter.current !== 'function') return false

  const originalCurrent = adapter.current.bind(adapter)
  adapter.current = function patchedCurrent(...args) {
    const snapshot = originalCurrent(...args)
    try {
      patchModelsCollection(snapshot?.models, ctx)
    } catch (error) {
      ctx.logger.warn(`${name}: could not overlay the model catalog: ${error?.message ?? error}`)
    }
    return snapshot
  }
  patchedAdapters.add(adapter)

  // The adapter may already hold a snapshot from before this plugin mounted.
  try { patchModelsCollection(adapter.current()?.models, ctx) } catch { /* not ready yet */ }
  return true
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
  const fingerprint = catalogFingerprint(models)
  if (publishedCatalog !== null && publishedCatalog.fingerprint === fingerprint) {
    ctx.logger.debug(`${name}: catalog unchanged at ${models.length} models; not re-emitting`)
    return
  }

  const ids = models.map(model => model.id)
  if (publishedCatalog === null) {
    ctx.logger.info(`${name}: catalog published: ${ids.length} models`)
  } else {
    const before = new Set(publishedCatalog.ids)
    const added = ids.filter(id => !before.has(id))
    const removed = publishedCatalog.ids.filter(id => !ids.includes(id))
    ctx.logger.info(`${name}: catalog updated: ${before.size} -> ${ids.length} models`)
    if (added.length > 0) ctx.logger.info(`${name}: added: ${added.join(', ')}`)
    if (removed.length > 0) ctx.logger.info(`${name}: removed: ${removed.join(', ')}`)
  }

  publishedCatalog = { fingerprint, ids }
  ctx.emit('llm/adapters-updated')
}

/**
 * Reload both remote sources and re-publish the catalog.
 * @param {any} ctx - plugin context.
 * @returns {Promise<void>} resolves once this refresh settled.
 */
async function refreshCatalog(ctx) {
  if (refreshing !== null) return refreshing

  refreshing = (async () => {
    try {
      const { models, unknown } = await fetchPiCatalog()
      remoteCatalog = models
      reportUnknownFields(unknown, ctx)
      ctx.logger.debug(`${name}: loaded ${models.size} model descriptors from pi.dev`)
    } catch (error) {
      ctx.logger.warn(`${name}: pi.dev catalog refresh failed (${error?.message ?? error}); keeping the last known catalog`)
    }

    try {
      const roster = acceptRoster(await fetchOcgRoster())
      liveModelIds = roster
      ctx.logger.debug(`${name}: OpenCode Go currently exposes ${roster.size} models`)

      // A name the gateway serves but no descriptor exists for: report it, and
      // say why it is absent. Guessing a protocol here would send the request
      // down the wrong transport and fail mid-turn instead of at load.
      const described = new Set([...buildOverlay().keys(), ...effectiveModels().map(model => model.id)])
      const undescribed = [...roster].filter(id => !described.has(id))
      if (undescribed.length > 0) {
        ctx.logger.warn(
          `${name}: ${undescribed.length} live model(s) have no descriptor yet and are NOT added:`
          + ` ${undescribed.join(', ')}. Add them to the Pi catalog or to FALLBACK_MODELS with their api,`
          + ' baseUrl, contextWindow and maxTokens.',
        )
      }
    } catch (error) {
      // Deliberately keeps the previous roster: the picker losing models with
      // only a fetch that "succeeded" to blame is the failure mode this guards.
      ctx.logger.warn(`${name}: OCG roster refresh failed (${error?.message ?? error}); keeping the last known roster`)
    }

    installIntoCurrentAdapter(ctx)
    publishIfChanged(ctx)
  })().finally(() => { refreshing = null })

  return refreshing
}

/**
 * Mount the overlay.
 *
 * Returns the first catalog refresh, so a caller (or a test) can await the
 * overlay being live rather than guessing when the two network reads settled.
 * @param {any} ctx - plugin context.
 * @returns {Promise<void>} resolves after the first refresh attempt.
 */
export function apply(ctx) {
  adapterRegistryRef = ctx.llm?.adapters ?? null

  installIntoCurrentAdapter(ctx)

  // The adapter can register after this plugin, and re-register on a settings
  // change, so re-patch whenever the registry announces a change.
  ctx.on('llm/adapters-updated', () => { installIntoCurrentAdapter(ctx) })

  const first = refreshCatalog(ctx)

  ctx.effect(() => {
    const timer = setInterval(() => { void refreshCatalog(ctx) }, REFRESH_INTERVAL_MS)
    timer.unref?.()
    return () => { clearInterval(timer) }
  })

  return first
}
