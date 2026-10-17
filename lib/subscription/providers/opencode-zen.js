import { fetchJson } from '../http.js'
import { QuotaError } from '../errors.js'
import { normalizeOpenCodeZen } from '../normalize.js'
import { displayScopeOf } from '../identity.js'

const ORIGIN = 'https://opencode.ai'
const BALANCE_URL = ORIGIN + '/console/api/billing/status'

/** Send either legacy sk- or current oc_sk_ keys; billing access is endpoint-specific. */
export function createOpenCodeZenAdapter({ credentials, consoleAuth, refName = 'OPENCODE_API_KEY', timeoutMs = 15000, fetchImpl }) {
  const key = async () => (await credentials?.resolve(refName.replace(/^!/, '')))?.value
  return {
    providerId: 'opencode',
    origin: ORIGIN,
    kind: 'balance',
    async isConfigured() {
      if (await consoleAuth?.isConfigured()) return true
      const value = await key()
      return typeof value === 'string' && value.trim() !== ''
    },
    async displayKey() { return await consoleAuth?.displayKey() ?? displayScopeOf('opencode/key', await key()) },
    async resolveAuth(options) {
      const loggedIn = await consoleAuth?.resolveAuth(options)
      if (loggedIn) return loggedIn
      const value = await key()
      if (typeof value !== 'string' || value.trim() === '') throw new QuotaError('auth-required', 'OpenCode Zen credential is not configured')
      return { authorization: 'Bearer ' + value, accountKey: undefined }
    },
    async fetchUsage(auth, { signal } = {}) {
      try {
        return await fetchJson(BALANCE_URL, { headers: { accept: 'application/json', authorization: auth.authorization,
          ...(auth.orgId ? { 'x-org-id': auth.orgId } : {}) }, origin: ORIGIN, timeoutMs, signal, fetchImpl })
      } catch (error) {
        if (error?.code === 'risk-control') throw new QuotaError('forbidden', 'OpenCode Zen billing endpoint rejected this credential (HTTP 403)')
        throw error
      }
    },
    normalize(payload, { capturedAt }) {
      const snapshot = normalizeOpenCodeZen(payload, { capturedAt })
      if (!snapshot.balance) throw new QuotaError('invalid-response', 'OpenCode Zen billing response did not include a valid balance')
      return snapshot
    },
  }
}
