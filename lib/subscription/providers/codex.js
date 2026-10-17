import { fetchJson } from '../http.js'
import { QuotaError } from '../errors.js'
import { normalizeCodex } from '../normalize.js'
import { accountKeyOf, displayScopeOf } from '../identity.js'

const ORIGIN = 'https://chatgpt.com'
const USAGE_URL = ORIGIN + '/backend-api/wham/usage'
const RESETS_URL = ORIGIN + '/backend-api/wham/rate-limit-reset-credits'
const RECORD = 'llm-pi-ai/openai-codex'
const MIN_VALIDITY_MS = 5 * 60 * 1000

/**
 * Codex adapter: native Pi-AI OAuth credential, official Codex CLI endpoints.
 * Token refresh delegates to the host Pi-AI (injected), never reimplemented.
 * @param {object} deps - credentials service, optional refresh from Pi-AI, timeoutMs, fetchImpl.
 * @returns {object} the adapter.
 */
export function createCodexAdapter({ credentials, refresh, timeoutMs = 15000, fetchImpl }) {
  async function resolveAuth({ signal } = {}) {
    const record = await credentials?.readRecord(RECORD)
    const grant = record?.kind === 'grant' ? record.payload : undefined
    if (!grant || grant.type !== 'oauth' || typeof grant.access !== 'string' || typeof grant.expires !== 'number') {
      throw new QuotaError('auth-required', 'no native openai-codex OAuth credential')
    }
    let live = grant
    if (live.expires - Date.now() < MIN_VALIDITY_MS) {
      if (!refresh) throw new QuotaError('auth-required', 'credential expired and Pi-AI refresh is unavailable')
      live = await refresh({ signal })
      if (!live || typeof live.access !== 'string') throw new QuotaError('auth-required', 'Pi-AI refresh produced no credential')
    }
    return { authorization: 'Bearer ' + live.access, accountId: live.accountId, ...accountKeyOf(live.accountId) }
  }

  return {
    providerId: 'openai-codex',
    origin: ORIGIN,
    async isConfigured() {
      return (await credentials?.describeRecord(RECORD))?.configured === true
    },
    async displayKey() {
      const record = await credentials?.readRecord?.(RECORD)
      const grant = record?.kind === 'grant' ? record.payload : undefined
      if (grant?.type !== 'oauth') return undefined
      return displayScopeOf('openai-codex/account', grant.accountId)
        ?? displayScopeOf('openai-codex/grant', grant.refresh)
        ?? displayScopeOf('openai-codex/grant', grant.access)
    },
    resolveAuth,
    async fetchUsage(auth, { signal } = {}) {
      const headers = { accept: 'application/json', authorization: auth.authorization }
      if (auth.accountId) headers['chatgpt-account-id'] = auth.accountId
      const usage = await fetchJson(USAGE_URL, { headers, origin: ORIGIN, timeoutMs, signal, fetchImpl })
      let resetCredits
      try {
        const body = await fetchJson(RESETS_URL, {
          headers,
          origin: ORIGIN, timeoutMs, signal, fetchImpl,
        })
        resetCredits = typeof body?.available_count === 'number'
          ? { available: body.available_count, ...(typeof body.applicable_available_count === 'number' ? { applicable: body.applicable_available_count } : {}) }
          : undefined
      } catch (error) {
        // The usage snapshot is primary; reset-credit detail is best effort.
        if (!(error instanceof QuotaError)) throw error
        resetCredits = { unavailable: error.code }
      }
      return { usage, resetCredits }
    },
    normalize(result, { accountId, capturedAt }) {
      return normalizeCodex(result.usage, { httpStatus: 200, accountId, resetCredits: result.resetCredits, capturedAt })
    },
  }
}
