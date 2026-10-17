import { QuotaError, classifyHttp } from './errors.js'

/**
 * Combine an optional caller/plugin signal with a timeout without
 * `AbortSignal.any` (Node 18.0-18.16 lacks it while engines promises >=18).
 * @param {AbortSignal|undefined} external - caller or plugin lifecycle signal.
 * @param {number} ms - request timeout.
 * @returns {{signal: AbortSignal, release: () => void}} composed signal and cleanup.
 */
export function requestSignal(external, ms) {
  const timeout = AbortSignal.timeout(ms)
  if (external === undefined) return { signal: timeout, release: () => {} }
  const controller = new AbortController()
  if (external.aborted || timeout.aborted) {
    controller.abort()
    return { signal: controller.signal, release: () => {} }
  }
  const abort = () => controller.abort()
  external.addEventListener('abort', abort, { once: true })
  timeout.addEventListener('abort', abort, { once: true })
  return {
    signal: controller.signal,
    release: () => {
      external.removeEventListener('abort', abort)
      timeout.removeEventListener('abort', abort)
    },
  }
}

/**
 * GET one official quota endpoint as JSON, refusing any other origin so a
 * credential can never leave the vendor's host. Failure bodies never propagate.
 * @param {string} url - the endpoint; must match `origin`.
 * @param {object} options - headers, official origin, timeout and signal.
 * @returns {Promise<any>} parsed JSON body.
 * @throws {QuotaError} origin-refused / auth-required / risk-control / quota / rate-limited / timeout / invalid-response.
 */
export async function fetchJson(url, { headers, origin, timeoutMs, signal, fetchImpl = globalThis.fetch }) {
  const parsed = new URL(url)
  if (parsed.origin !== origin) {
    throw new QuotaError('origin-refused', `refusing to send credentials to ${parsed.origin} (expected ${origin})`)
  }
  const held = requestSignal(signal, timeoutMs)
  try {
    let response
    try {
      response = await fetchImpl(url, { method: 'GET', headers, signal: held.signal, redirect: 'error' })
    } catch (error) {
      if (held.signal.aborted) throw new QuotaError('timeout', 'quota request timed out or was cancelled')
      throw new QuotaError('network', `quota request failed: ${error?.name ?? 'Error'}`)
    }
    const text = await response.text()
    if (!response.ok) throw new QuotaError(classifyHttp(response.status, text), `quota endpoint returned ${response.status}`)
    try {
      return JSON.parse(text)
    } catch {
      throw new QuotaError('invalid-response', 'quota endpoint returned a non-JSON body')
    }
  } finally {
    held.release()
  }
}
