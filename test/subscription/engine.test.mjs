import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createQuotaEngine } from '../../lib/subscription/engine.js'
import { QuotaError } from '../../lib/subscription/errors.js'

function fakeAdapter({ fail, accountKey = 'acct_a' } = {}) {
  let calls = 0
  return {
    providerId: 'x',
    calls: () => calls,
    async resolveAuth() { return { accountKey } },
    async fetchUsage() { calls += 1; if (fail) throw fail; return { ok: true } },
    normalize(payload, { capturedAt }) {
      return { providerId: 'x', accountKey, identity: 'verified', status: 'ready', windows: [], capturedAt }
    },
  }
}

test('concurrent queries coalesce into one fetch', async () => {
  const a = fakeAdapter()
  const engine = createQuotaEngine({ adapters: { x: a }, freshMs: 60000, abort: new AbortController() })
  const [r1, r2] = await Promise.all([engine.query('x'), engine.query('x')])
  assert.equal(a.calls(), 1)
  assert.equal(r1, r2)
})

test('fresh cache serves without refetch; invalidate forces a refetch', async () => {
  const a = fakeAdapter()
  const engine = createQuotaEngine({ adapters: { x: a }, freshMs: 60000, abort: new AbortController() })
  await engine.query('x'); await engine.query('x')
  assert.equal(a.calls(), 1)
  engine.invalidate('x')
  await engine.query('x')
  assert.equal(a.calls(), 2)
})

test('expired freshMs triggers refetch', async () => {
  const a = fakeAdapter()
  const engine = createQuotaEngine({ adapters: { x: a }, freshMs: 1, abort: new AbortController() })
  await engine.query('x')
  await new Promise(r => setTimeout(r, 5))
  await engine.query('x')
  assert.equal(a.calls(), 2)
})

test('failure falls back to the last snapshot marked stale, never invents numbers', async () => {
  let fail = null
  const a = { providerId: 'x', async resolveAuth() { return { accountKey: 'acct_a' } }, async fetchUsage() { if (fail) throw fail; return { ok: true } }, normalize(p, c) { return { providerId: 'x', accountKey: 'acct_a', identity: 'verified', status: 'ready', windows: [], capturedAt: c.capturedAt } } }
  const engine = createQuotaEngine({ adapters: { x: a }, freshMs: 1, abort: new AbortController() })
  const first = await engine.query('x')
  assert.equal(first.status, 'ready')
  await new Promise(r => setTimeout(r, 5))
  fail = new QuotaError('timeout', 'boom')
  const stale = await engine.query('x')
  assert.equal(stale.status, 'stale')
  assert.equal(stale.staleReason, 'timeout')
  assert.equal(stale.capturedAt, first.capturedAt, 'stale keeps the old timestamp')
})

test('auth-required is not masked by stale data', async () => {
  const a = fakeAdapter()
  const engine = createQuotaEngine({ adapters: { x: a }, freshMs: 1, abort: new AbortController() })
  await engine.query('x')
  a.resolveAuth = async () => { throw new QuotaError('auth-required', 'gone') }
  await assert.rejects(engine.query('x'), e => e.code === 'auth-required')
})

test('account switch invalidates the cached snapshot', async () => {
  const a = fakeAdapter({ accountKey: 'acct_1' })
  const engine = createQuotaEngine({ adapters: { x: a }, freshMs: 60000, abort: new AbortController() })
  const first = await engine.query('x')
  assert.equal(first.accountKey, 'acct_1')
  a.resolveAuth = async () => ({ accountKey: 'acct_2' })
  a.normalize = (p, c) => ({ providerId: 'x', accountKey: 'acct_2', identity: 'verified', status: 'ready', windows: [], capturedAt: c.capturedAt })
  const second = await engine.query('x')
  assert.equal(second.accountKey, 'acct_2', 'must not serve the other account snapshot')
})

test('unknown provider is unsupported, not an invented snapshot', async () => {
  const engine = createQuotaEngine({ adapters: {}, abort: new AbortController() })
  await assert.rejects(engine.query('nope'), e => e.code === 'unsupported')
})

test('plugin disposal aborts the in-flight request (engine honors abort.signal)', async () => {
  const ac = new AbortController()
  const a = { providerId: 'x', resolveAuth: async () => ({ accountKey: 'a' }),
    async fetchUsage(auth, { signal }) {
      if (signal.aborted) throw new QuotaError('timeout', 'cancelled')
      return new Promise((_, reject) => {
        signal.addEventListener('abort', () => reject(new QuotaError('timeout', 'cancelled')), { once: true })
      })
    },
    normalize: (p, c) => ({ providerId: 'x', status: 'ready', windows: [], capturedAt: c.capturedAt }) }
  const engine = createQuotaEngine({ adapters: { x: a }, freshMs: 60000, abort: ac })
  const p = engine.query('x').catch(e => e)
  ac.abort()
  const err = await p
  assert.ok(err instanceof QuotaError)
  assert.equal(err.code, 'timeout')
})
