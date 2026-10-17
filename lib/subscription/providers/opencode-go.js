import { fetchJson } from '../http.js'
import { QuotaError } from '../errors.js'
import { normalizeOpenCodeGo } from '../normalize.js'
import { displayScopeOf } from '../identity.js'

const ORIGIN = 'https://opencode.ai'
const USAGE_URL = ORIGIN + '/zen/go/v1/usage'

/**
 * OpenCode Go adapter: API-key reference resolved through the host public
 * credentials service; no OAuth involved.
 * @param {object} deps - credentials service, config, timeoutMs, fetchImpl.
 * @returns {object} the adapter.
 */
export function createOpenCodeGoAdapter({ credentials, refName = 'OPENCODE_GO_API_KEY', timeoutMs = 15000, fetchImpl }) {
  return {
    providerId: 'opencode-go',
    origin: ORIGIN,
    async isConfigured() {
      const hit = await credentials?.resolve(refName.startsWith('!') ? refName.slice(1) : refName)
      return typeof hit?.value === 'string' && hit.value.trim() !== ''
    },
    async displayKey() {
      const hit = await credentials?.resolve(refName.startsWith('!') ? refName.slice(1) : refName)
      return displayScopeOf('opencode-go/key', hit?.value)
    },
    async resolveAuth() {
      const hit = await credentials?.resolve(refName.startsWith('!') ? refName.slice(1) : refName)
      if (!hit || typeof hit.value !== 'string' || hit.value === '') {
        throw new QuotaError('auth-required', `credential reference ${refName} is not configured`)
      }
      return { authorization: 'Bearer ' + hit.value, accountKey: undefined }
    },
    async fetchUsage(auth, { signal } = {}) {
      return fetchJson(USAGE_URL, { headers: { accept: 'application/json', authorization: auth.authorization }, origin: ORIGIN, timeoutMs, signal, fetchImpl })
    },
    normalize(payload, { capturedAt }) {
      return normalizeOpenCodeGo(payload, { capturedAt })
    },
  }
}
