import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createCodexAdapter } from '../../lib/subscription/providers/codex.js'
import { createOpenCodeGoAdapter } from '../../lib/subscription/providers/opencode-go.js'
import { createOpenCodeZenAdapter } from '../../lib/subscription/providers/opencode-zen.js'

const grant = (expires = Date.now() + 3600000) => ({ kind: 'grant', payload: { type: 'oauth', access: 'tok', refresh: 'r', expires, accountId: 'acct-1' } })
const creds = record => ({ readRecord: async () => record, resolve: async () => undefined })

test('codex resolveAuth refuses without a grant', async () => {
  const a = createCodexAdapter({ credentials: creds(undefined) })
  await assert.rejects(a.resolveAuth(), e => e.code === 'auth-required')
})

test('codex expired credential invokes injected refresh (delegated to Pi-AI)', async () => {
  let refreshed = 0
  const a = createCodexAdapter({
    credentials: creds(grant(Date.now() - 1000)),
    refresh: async () => { refreshed += 1; return { access: 'new', expires: Date.now() + 3600000, accountId: 'acct-1' } },
  })
  const auth = await a.resolveAuth()
  assert.equal(refreshed, 1)
  assert.equal(auth.authorization, 'Bearer new')
})

test('codex expired without refresh is auth-required, never a stale token', async () => {
  const a = createCodexAdapter({ credentials: creds(grant(Date.now() - 1000)) })
  await assert.rejects(a.resolveAuth(), e => e.code === 'auth-required')
})

test('codex fetch sends credentials only to the official chatgpt origin', async () => {
  const seen = []
  const fetchImpl = async url => { seen.push(String(url)); return new Response(JSON.stringify({ rate_limit: { allowed: true } }), { status: 200 }) }
  const a = createCodexAdapter({ credentials: creds(grant()), fetchImpl, timeoutMs: 1000 })
  const auth = await a.resolveAuth()
  await a.fetchUsage(auth, {})
  assert.deepEqual(seen, [
    'https://chatgpt.com/backend-api/wham/usage',
    'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits',
  ])
})

test('go resolveAuth requires the configured key reference', async () => {
  const missing = createOpenCodeGoAdapter({ credentials: { resolve: async () => undefined } })
  await assert.rejects(missing.resolveAuth(), e => e.code === 'auth-required')
  const present = createOpenCodeGoAdapter({ credentials: { resolve: async () => ({ value: 'k' }) } })
  assert.equal((await present.resolveAuth()).authorization, 'Bearer k')
})

test('Codex configuration discovery reads credential metadata without refreshing or fetching usage', async () => {
  let configured = false
  const adapter = createCodexAdapter({
    credentials: {
      async describeRecord(name) { assert.equal(name, 'llm-pi-ai/openai-codex'); return { configured } },
      readRecord() { assert.fail('listing subscriptions must not read the OAuth grant') },
    },
    refresh() { assert.fail('listing subscriptions must not refresh OAuth') },
    fetchImpl() { assert.fail('listing subscriptions must not fetch usage') },
  })
  assert.equal(await adapter.isConfigured(), false)
  configured = true
  assert.equal(await adapter.isConfigured(), true)
  assert.equal(await createCodexAdapter({}).isConfigured(), false)
})

test('Go configuration discovery requires a non-empty key in the configured reference', async () => {
  let value
  const adapter = createOpenCodeGoAdapter({
    refName: '!CUSTOM_GO_KEY',
    credentials: { async resolve(name) { assert.equal(name, 'CUSTOM_GO_KEY'); return { value } } },
    fetchImpl() { assert.fail('listing subscriptions must not fetch usage') },
  })
  for (const missing of [undefined, '', '  ', 0]) {
    value = missing
    assert.equal(await adapter.isConfigured(), false)
  }
  value = '<token>'
  assert.equal(await adapter.isConfigured(), true)
  assert.equal(await createOpenCodeGoAdapter({}).isConfigured(), false)
})

test('Codex display scope survives token refresh and new adapters but changes with the account', async () => {
  let current = grant()
  const credentials = { readRecord: async () => current }
  const options = { credentials, refresh() { assert.fail('display discovery cannot refresh OAuth') }, fetchImpl() { assert.fail('display discovery cannot fetch usage') } }
  const first = await createCodexAdapter(options).displayKey()
  current = { ...current, payload: { ...current.payload, access: '<new-token>', refresh: '<new-refresh>' } }
  assert.equal(await createCodexAdapter(options).displayKey(), first)
  current.payload.accountId = 'acct-2'
  assert.notEqual(await createCodexAdapter(options).displayKey(), first)
  current = undefined
  assert.equal(await createCodexAdapter(options).displayKey(), undefined)
})

test('Go display scope is stable across adapters without exposing the key or verifying an account identity', async () => {
  let value = '<token-a>'
  const credentials = { resolve: async () => ({ value }) }
  const first = await createOpenCodeGoAdapter({ credentials }).displayKey()
  assert.equal(first.includes(value), false)
  assert.equal(await createOpenCodeGoAdapter({ credentials }).displayKey(), first)
  assert.equal((await createOpenCodeGoAdapter({ credentials }).resolveAuth()).accountKey, undefined)
  value = '<token-b>'
  assert.notEqual(await createOpenCodeGoAdapter({ credentials }).displayKey(), first)
  value = ' '
  assert.equal(await createOpenCodeGoAdapter({ credentials }).displayKey(), undefined)
})

test('Zen balance reads only the official Console billing endpoint with the configured key', async () => {
  const seen = [], abort = new AbortController()
  const credentials = { resolve: async name => { assert.equal(name, 'ZEN_KEY'); return { value: '<token>' } } }
  const adapter = createOpenCodeZenAdapter({ credentials, refName: '!ZEN_KEY', fetchImpl: async (url, options) => {
    seen.push(url)
    assert.equal(options.method, 'GET')
    assert.equal(options.redirect, 'error')
    assert.equal(options.headers.authorization, 'Bearer <token>')
    assert.equal(options.signal.aborted, false)
    return Response.json({ availableMicroCents: '1234000000' })
  } })
  assert.equal(await adapter.isConfigured(), true)
  const key = await adapter.displayKey()
  assert.equal(await createOpenCodeZenAdapter({ credentials, refName: 'ZEN_KEY' }).displayKey(), key)
  assert.equal(key.includes('<token>'), false)
  const body = await adapter.fetchUsage(await adapter.resolveAuth(), { signal: abort.signal })
  assert.equal(adapter.normalize(body, { capturedAt: 1 }).balance.amount, 12.34)
  assert.deepEqual(seen, ['https://opencode.ai/console/api/billing/status'])
})

test('Zen missing credentials and billing permissions remain explicit failures', async () => {
  const missing = createOpenCodeZenAdapter({ credentials: { resolve: async () => undefined } })
  assert.equal(await missing.isConfigured(), false)
  await assert.rejects(missing.resolveAuth(), error => error.code === 'auth-required')
  for (const [status, code] of [[401, 'auth-required'], [403, 'forbidden'], [503, 'upstream']]) {
    const adapter = createOpenCodeZenAdapter({ fetchImpl: async () => Response.json({ private: '<token>' }, { status }) })
    await assert.rejects(adapter.fetchUsage({ authorization: 'Bearer <token>' }), error => error.code === code && !error.message.includes('<token>'))
  }
})

test('Zen uses the official billing API for both legacy and Console keys', async () => {
  for (const value of ['sk-' + 'a'.repeat(64), 'oc_sk_' + 'a'.repeat(12) + '_' + 'b'.repeat(32)]) {
    const adapter = createOpenCodeZenAdapter({ credentials: { resolve: async () => ({ value }) }, fetchImpl: async (url, options) => {
      assert.equal(url, 'https://opencode.ai/console/api/billing/status')
      assert.equal(options.headers.authorization, 'Bearer ' + value)
      return Response.json({ availableMicroCents: '496000000' })
    } })
    assert.equal(await adapter.isConfigured(), true)
    const snapshot = adapter.normalize(await adapter.fetchUsage(await adapter.resolveAuth()), { capturedAt: 1 })
    assert.equal(snapshot.balance.amount, 4.96)
  }
})

test('Zen incomplete billing responses explicitly fail so cached money can survive', () => {
  const adapter = createOpenCodeZenAdapter({})
  for (const body of [{}, { availableMicroCents: null }, { availableMicroCents: 'invalid' }]) {
    assert.throws(() => adapter.normalize(body, { capturedAt: 1 }), error => error.code === 'invalid-response')
  }
  assert.equal(adapter.normalize({ availableMicroCents: '0' }, { capturedAt: 1 }).balance.amount, 0)
})

test('Zen prefers workspace-scoped Console OAuth without changing or reading the model API key', async () => {
  const abort = new AbortController()
  const adapter = createOpenCodeZenAdapter({ credentials: { resolve() { assert.fail('OAuth balance reads must not touch the model key') } },
    consoleAuth: {
      isConfigured: async () => true, displayKey: async () => 'workspace-digest',
      async resolveAuth({ signal }) { assert.equal(signal, abort.signal); return { authorization: 'Bearer <oauth-token>', orgId: 'org_fixture', accountKey: 'account-digest' } },
    }, fetchImpl: async (url, options) => {
      assert.equal(url, 'https://opencode.ai/console/api/billing/status')
      assert.equal(options.headers.authorization, 'Bearer <oauth-token>')
      assert.equal(options.headers['x-org-id'], 'org_fixture')
      assert.equal(options.redirect, 'error')
      return Response.json({ availableMicroCents: '496000000' })
    } })
  assert.equal(await adapter.isConfigured(), true)
  assert.equal(await adapter.displayKey(), 'workspace-digest')
  const auth = await adapter.resolveAuth({ signal: abort.signal })
  assert.equal(adapter.normalize(await adapter.fetchUsage(auth, { signal: abort.signal }), { capturedAt: 1 }).balance.amount, 4.96)
})

test('Zen invalid Console authorization stays explicit and cannot fall back to another key or workspace', async () => {
  const adapter = createOpenCodeZenAdapter({ consoleAuth: { async resolveAuth() { throw Object.assign(new Error('expired'), { code: 'auth-required' }) } },
    credentials: { resolve() { assert.fail('must not switch to a different identity') } } })
  await assert.rejects(adapter.resolveAuth(), error => error.code === 'auth-required')
})
