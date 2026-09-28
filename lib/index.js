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
 *    catalog, carrying complete descriptors (api, baseUrl, capacities, compat,
 *    thinkingLevelMap). Authoritative and pre-verified by Pi.
 * 2. `FALLBACK_MODELS` below — the two models this plugin exists to make
 *    reachable, used when the remote catalog cannot be fetched.
 * 3. The installed catalog, untouched, so a model Pi has not published yet is
 *    never dropped from the picker just because the remote fetch was partial.
 *
 * `https://opencode.ai/zen/go/v1/models` supplies the live roster. It is used
 * only to **add nothing on its own** and to flag drift: a name with no descriptor
 * is reported, not guessed. A roster fetch that fails leaves the last known
 * roster in place rather than emptying the catalog.
 *
 * @module dsh-opencode-live-models
 */

export const name = 'opencode-live-models'
export const inject = ['llm']

const PROVIDER_ID = 'opencode-go'
const PI_CATALOG_URL = 'https://pi.dev/api/models/providers/opencode-go?types=chat'
const OCG_MODELS_URL = 'https://opencode.ai/zen/go/v1/models'
const OCG_BASE_URL = 'https://opencode.ai/zen/go/v1'
const REFRESH_INTERVAL_MS = 5 * 60 * 1000
const FETCH_TIMEOUT_MS = 8000

/**
 * Wire protocols the installed pi-ai's `opencode-go` provider already carries.
 * A descriptor naming anything else is dropped: the transport for it does not
 * exist, so registering it would fail at dispatch instead of at load.
 */
const SUPPORTED_APIS = new Set([
  'openai-completions',
  'openai-responses',
  'anthropic-messages',
])

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
    baseUrl: OCG_BASE_URL,
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
    baseUrl: OCG_BASE_URL,
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
    headers: { accept: 'application/json', 'user-agent': 'dsh-opencode-live-models/0.1.0' },
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
  if (value && typeof value === 'object' && value.models && typeof value.models === 'object') {
    return Object.values(value.models)
  }
  if (value && typeof value === 'object') return Object.values(value)
  return []
}

/**
 * Keep a descriptor only when the installed pi-ai can actually carry it.
 * @param {any} model - one catalog entry.
 * @returns {any|undefined} the normalized descriptor, or undefined to drop it.
 */
function normalizeRemoteModel(model) {
  if (!model || typeof model !== 'object' || typeof model.id !== 'string') return undefined
  if (typeof model.api !== 'string' || !SUPPORTED_APIS.has(model.api)) return undefined
  return {
    ...model,
    provider: PROVIDER_ID,
    baseUrl: typeof model.baseUrl === 'string' ? model.baseUrl : OCG_BASE_URL,
  }
}

/**
 * Load Pi's catalog into {@link remoteCatalog}.
 * @returns {Promise<Map<string, any>>} descriptors by id.
 */
async function fetchPiCatalog() {
  const entries = extractCatalogEntries(await fetchJson(PI_CATALOG_URL))
  const models = new Map()
  for (const entry of entries) {
    const model = normalizeRemoteModel(entry)
    if (model !== undefined) models.set(model.id, model)
  }
  return models
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
 * Merge the installed roster with the overlay.
 *
 * The installed catalog is the floor and is never emptied: `mergeModels` keeps
 * every installed model the live roster still lists, then layers the overlay on
 * top. That is what preserves the five models Pi's catalog does not carry but
 * the installed pi-ai does (`omen-alpha`, `qwen3.6-plus`, and three more).
 * @param {any[]} installed - the provider's own models.
 * @returns {any[]} the merged roster.
 */
function mergeModels(installed) {
  const merged = new Map()
  for (const model of installed) {
    if (liveModelIds === null || liveModelIds.has(model.id)) merged.set(model.id, model)
  }
  for (const [id, model] of buildOverlay()) merged.set(id, model)
  return [...merged.values()]
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
 * Reload both remote sources and re-publish the catalog.
 * @param {any} ctx - plugin context.
 * @returns {Promise<void>} resolves once this refresh settled.
 */
async function refreshCatalog(ctx) {
  if (refreshing !== null) return refreshing

  refreshing = (async () => {
    let changed = false

    try {
      const models = await fetchPiCatalog()
      remoteCatalog = models
      changed = true
      ctx.logger.info(`${name}: loaded ${models.size} model descriptors from pi.dev`)
    } catch (error) {
      ctx.logger.warn(`${name}: pi.dev catalog refresh failed (${error?.message ?? error}); keeping the last known catalog`)
    }

    try {
      const roster = await fetchOcgRoster()
      liveModelIds = roster
      changed = true
      ctx.logger.info(`${name}: OpenCode Go currently exposes ${roster.size} models`)

      // A name the gateway serves but no descriptor exists for: report it, and
      // say why it is absent. Guessing a protocol here would send the request
      // down the wrong transport and fail mid-turn instead of at load.
      const described = new Set([...buildOverlay().keys()])
      for (const model of installedIds()) described.add(model)
      const undescribed = [...roster].filter(id => !described.has(id))
      if (undescribed.length > 0) {
        ctx.logger.warn(
          `${name}: ${undescribed.length} live model(s) have no descriptor yet and are NOT added:`
          + ` ${undescribed.join(', ')}. Add them to the Pi catalog or to FALLBACK_MODELS with their api,`
          + ' baseUrl, contextWindow and maxTokens.',
        )
      }
    } catch (error) {
      // Deliberately keeps the previous roster: an empty set would be read as
      // "OCG serves nothing" and empty the picker.
      ctx.logger.warn(`${name}: OCG roster refresh failed (${error?.message ?? error}); keeping the last known roster`)
    }

    if (changed) {
      installIntoCurrentAdapter(ctx)
      // The next listModels() reads the patched provider, so the picker refreshes.
      ctx.emit('llm/adapters-updated')
    }
  })().finally(() => { refreshing = null })

  return refreshing
}

/**
 * The ids the installed pi-ai already knows, read through the patched adapter.
 * @returns {string[]} installed model ids; empty before the first snapshot.
 */
function installedIds() {
  try {
    const registration = currentRegistration()
    const snapshot = registration?.adapter?.current?.()
    return (snapshot?.models?.getModels?.(PROVIDER_ID) ?? []).map(model => model.id)
  } catch {
    return []
  }
}

/** @returns {any} the `opencode-go` adapter registration, if any. */
function currentRegistration() {
  return registrationRef?.get?.(PROVIDER_ID) ?? null
}

/**
 * Reference to the live `llm` service, captured in {@link apply} so the
 * module-level helpers above need no import.
 * @type {{ get?: (id: string) => any } | null}
 */
let registrationRef = null

/**
 * Mount the overlay.
 *
 * Returns the first catalog refresh, so a caller (or a test) can await the
 * overlay being live rather than guessing when the two network reads settled.
 * @param {any} ctx - plugin context.
 * @returns {Promise<void>} resolves after the first refresh attempt.
 */
export function apply(ctx) {
  registrationRef = ctx.llm

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
