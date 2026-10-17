import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fetchJson, requestSignal } from '../../lib/subscription/http.js'
import { QuotaError, classifyHttp } from '../../lib/subscription/errors.js'

const ORIGIN = 'https://vendor.example'

test('origin guard refuses a different host before any request is made', async () => {
  let called = 0
  const fetchImpl = async () => { called += 1; return new Response('{}') }
  await assert.rejects(
    fetchJson('https://evil.example/usage', { origin: ORIGIN, timeoutMs: 1000, fetchImpl }),
    e => e.code === 'origin-refused')
  assert.equal(called, 0, 'no request may leave for a non-official origin')
})

test('401 maps to auth-required, 403 to risk-control', async () => {
  const mk = status => async () => new Response('x', { status })
  await assert.rejects(fetchJson(ORIGIN + '/u', { origin: ORIGIN, timeoutMs: 1000, fetchImpl: mk(401) }), e => e.code === 'auth-required')
  await assert.rejects(fetchJson(ORIGIN + '/u', { origin: ORIGIN, timeoutMs: 1000, fetchImpl: mk(403) }), e => e.code === 'risk-control')
})

test('429 splits quota vs rate-limited by body', async () => {
  const withBody = body => async () => new Response(body, { status: 429 })
  await assert.rejects(fetchJson(ORIGIN + '/u', { origin: ORIGIN, timeoutMs: 1000, fetchImpl: withBody('The usage limit has been reached') }), e => e.code === 'quota')
  await assert.rejects(fetchJson(ORIGIN + '/u', { origin: ORIGIN, timeoutMs: 1000, fetchImpl: withBody('slow down') }), e => e.code === 'rate-limited')
})

test('non-JSON success body is invalid-response', async () => {
  const fetchImpl = async () => new Response('<html/>', { status: 200 })
  await assert.rejects(fetchJson(ORIGIN + '/u', { origin: ORIGIN, timeoutMs: 1000, fetchImpl }), e => e.code === 'invalid-response')
})

test('abort/cancel maps to timeout class', async () => {
  const ac = new AbortController()
  const fetchImpl = async (url, init) => {
    ac.abort() // composed signal aborts too; a real fetch rejects in both orders
    if (init.signal.aborted) throw new DOMException('aborted', 'AbortError')
    return new Promise((_, reject) => {
      init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
    })
  }
  await assert.rejects(fetchJson(ORIGIN + '/u', { origin: ORIGIN, timeoutMs: 5000, signal: ac.signal, fetchImpl }), e => e.code === 'timeout')
})

test('requestSignal aborts when either source fires, then releases', () => {
  const ac = new AbortController()
  const held = requestSignal(ac.signal, 60000)
  assert.equal(held.signal.aborted, false)
  ac.abort()
  assert.equal(held.signal.aborted, true)
  held.release()
})

test('classifyHttp covers 5xx and default', () => {
  assert.equal(classifyHttp(503, ''), 'upstream')
  assert.equal(classifyHttp(418, ''), 'error')
})
