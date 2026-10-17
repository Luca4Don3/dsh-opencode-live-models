import { QuotaError } from './errors.js'

/**
 * The quota engine: per-provider cache with in-flight coalescing, account-key
 * invalidation, stale fallback and plugin-lifetime cancellation.
 *
 * - One in-flight query per provider; concurrent callers join it only when
 *   they resolve to the same account key as the in-flight fetch, so a switch
 *   can never be answered with the previous account's snapshot.
 * - A cached snapshot is served only while fresh AND owned by the caller's
 *   resolved account key (account switch invalidates).
 * - On transient failure a previous snapshot is returned marked 'stale' with
 *   its original capturedAt rather than invented numbers.
 * - The plugin AbortSignal (fired on disable/unload/HMR dispose) owns the
 *   actual request cancellation; a caller signal only stops that caller from
 *   joining.
 *
 * @param {object} options - adapters registry, freshMs and plugin abort signal.
 * @returns {{query: Function, invalidate: Function, hasCache: Function}} engine API.
 */
export function createQuotaEngine({ adapters, freshMs = 300000, abort }) {
  const cache = new Map()    // providerId -> { accountKey, snapshot, fetchedAt }
  const inflight = new Map() // providerId -> { accountKey, promise }

  function checkAbort() {
    if (abort?.signal.aborted) throw new QuotaError('timeout', 'plugin disposed')
  }

  async function run(adapter, providerId, auth) {
    checkAbort()
    const payload = await adapter.fetchUsage(auth, { signal: abort?.signal })
    const snapshot = adapter.normalize(payload, { ...auth, capturedAt: Date.now() })
    checkAbort()
    if (auth.accountKey) cache.set(providerId, { accountKey: auth.accountKey, snapshot, fetchedAt: Date.now() })
    return snapshot
  }

  async function query(providerId, { signal } = {}) {
    checkAbort()
    if (signal?.aborted) throw new QuotaError('timeout', 'caller aborted before the query started')
    const adapter = adapters[providerId]
    if (adapter === undefined) throw new QuotaError('unsupported', `no quota adapter for provider ${providerId}`)
    // Resolve the account first so a cached snapshot from another account is
    // never returned for this one.
    const auth = await adapter.resolveAuth({ signal: abort?.signal ?? signal })
    checkAbort()
    if (signal?.aborted) throw new QuotaError('timeout', 'caller aborted before the query started')
    const entry = cache.get(providerId)
    if (auth.accountKey && entry && entry.accountKey === auth.accountKey && Date.now() - entry.fetchedAt < freshMs) {
      return entry.snapshot
    }
    if (entry && entry.accountKey !== auth.accountKey) cache.delete(providerId) // account switch
    const existing = inflight.get(providerId)
    if (auth.accountKey && existing?.accountKey === auth.accountKey) return existing.promise
    const task = (async () => {
      try {
        return await run(adapter, providerId, auth)
      } catch (error) {
        const previous = cache.get(providerId)
        // Stale-with-timestamp beats invented numbers: keep the last truth.
        if (!abort?.signal.aborted && auth.accountKey && previous?.accountKey === auth.accountKey
          && error instanceof QuotaError && error.code !== 'auth-required') {
          return { ...previous.snapshot, status: 'stale', staleReason: error.code }
        }
        throw error
      } finally {
        const current = inflight.get(providerId)
        if (current && current.promise === task) inflight.delete(providerId)
      }
    })()
    inflight.set(providerId, { accountKey: auth.accountKey, promise: task })
    return task
  }

  return {
    query,
    invalidate(providerId) { if (providerId === undefined) cache.clear(); else cache.delete(providerId) },
    hasCache(providerId) { return cache.has(providerId) },
  }
}
