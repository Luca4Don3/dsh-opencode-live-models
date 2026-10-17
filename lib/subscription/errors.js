/**
 * Stable failure classes for quota operations. Callers branch on `code`, never
 * on message text, so UI can distinguish "re-authenticate" from "wait" from
 * "unknown".
 */
export class QuotaError extends Error {
  /**
   * @param {string} code - one of the classes below.
   * @param {string} message - human-readable detail (never contains credentials).
   */
  constructor(code, message) {
    super(message)
    this.name = 'QuotaError'
    this.code = code
  }
}

/** HTTP status/body to failure class: 401 auth, 403 risk-control, 429 split by body. */
export function classifyHttp(status, bodyText) {
  if (status === 401) return 'auth-required'
  if (status === 403) return 'risk-control'
  if (status === 429) return /usage[ -]?limit/i.test(bodyText ?? '') ? 'quota' : 'rate-limited'
  if (status >= 500) return 'upstream'
  return 'error'
}
