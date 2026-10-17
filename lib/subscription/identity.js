/**
 * Account identity keys: only a non-empty, trimmed identifier may become a
 * cache key. Empty or missing identity maps to `identity-unverified` and
 * produces no key at all, so two unidentified accounts can never collide
 * under an empty-string hash.
 * @param {unknown} id - the account identifier from a credential or response.
 * @returns {{identity: string, accountKey: string|undefined}} the identity verdict and key.
 */
export function accountKeyOf(id) {
  if (typeof id !== 'string' || id.trim() === '') {
    return { identity: 'identity-unverified', accountKey: undefined }
  }
  return {
    identity: 'verified',
    accountKey: 'acct_' + createHash('sha256').update(id).digest('hex').slice(0, 10),
  }
}
import { createHash } from 'node:crypto'

/** Stable display-cache scope, never an authentication value or engine identity. */
export function displayScopeOf(provider, value) {
  if (typeof value !== 'string' || value.trim() === '') return undefined
  return 'view_' + createHash('sha256').update(JSON.stringify([provider, value])).digest('hex')
}
