import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createOpenCodeConsoleAuth, OPENCODE_RECORD } from '../../lib/subscription/opencode-auth.js'

const tick = () => new Promise(resolve => setImmediate(resolve))
const challenge = { device_code: '<device-token>', user_code: 'TEST-CODE', verification_uri_complete: '/console/device?user_code=TEST-CODE', expires_in: 600, interval: 5 }
const tokens = (org_id = 'org_fixture') => ({ access_token: '<access-token>', refresh_token: '<refresh-token>', expires_in: 3600, org_id })
const grant = (expires = 1) => ({ kind: 'grant', payload: { type: 'oauth', access: '<old-access>', refresh: '<old-refresh>', expires, orgId: 'org_fixture' } })
function store(initial) {
  let record = initial, tail = Promise.resolve()
  return {
    current: () => record,
    set: value => { record = value },
    async readRecord(key) { assert.equal(key, OPENCODE_RECORD); return record },
    modifyRecord(key, mutate) {
      assert.equal(key, OPENCODE_RECORD)
      const next = tail.then(async () => { const result = await mutate(record); if (result !== undefined) record = result; return record })
      tail = next.catch(() => {})
      return next
    },
  }
}

test('OpenCode official device flow respects pending and slow_down, then saves only a host grant', async () => {
  const credentials = store(), delays = [], opened = []
  let polls = 0
  const auth = createOpenCodeConsoleAuth({ credentials, now: () => 10000, wait: async ms => { delays.push(ms) }, fetchImpl: async (url, options) => {
    assert.equal(options.method, 'POST')
    assert.equal(options.redirect, 'error')
    assert.equal(options.headers.authorization, undefined)
    const body = new URLSearchParams(options.body)
    assert.equal(body.get('client_id'), 'dsh-opencode-live-models')
    if (url === 'https://opencode.ai/console/auth/device/code') {
      assert.equal(body.get('supports_org_scope'), 'true')
      return Response.json(challenge)
    }
    assert.equal(url, 'https://opencode.ai/console/auth/device/token')
    assert.equal(body.get('device_code'), '<device-token>')
    if (++polls <= 2) return Response.json({ error: polls === 1 ? 'authorization_pending' : 'slow_down' }, { status: 400 })
    return Response.json(tokens())
  } })
  const started = await auth.startLogin({ openBrowser: true, opener: url => opened.push(url) })
  assert.equal(started.status, 'waiting')
  assert.deepEqual(opened, ['https://opencode.ai/console/device?user_code=TEST-CODE'])
  await tick()
  assert.deepEqual(delays, [5000, 5000, 10000])
  assert.equal(credentials.current().payload.orgId, 'org_fixture')
  assert.equal((await auth.status()).loggedIn, true)
  const publicState = JSON.stringify(await auth.status())
  assert.ok(!publicState.includes('token>') && !publicState.includes('org_fixture') && !publicState.includes('device_code'))
})

test('OpenCode cancellation stops polling, coalesces starts and never writes a grant', async () => {
  const credentials = store()
  let calls = 0
  const auth = createOpenCodeConsoleAuth({ credentials, fetchImpl: async () => { calls++; return Response.json(challenge) },
    wait: (_ms, signal) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })) })
  await Promise.all([auth.startLogin(), auth.startLogin()])
  assert.equal(calls, 1)
  auth.cancelLogin(); await tick()
  assert.equal(auth.loginWatch().status, 'cancelled')
  assert.equal(credentials.current(), undefined)
})

test('OpenCode rejects nonofficial device URLs and does not expose response secrets', async () => {
  for (const verification_uri_complete of ['https://untrusted.example/console/device', '//untrusted.example/console/device', 'https://opencode.ai/other']) {
    const auth = createOpenCodeConsoleAuth({ credentials: store(), fetchImpl: async () => Response.json({ ...challenge, verification_uri_complete }) })
    const result = await auth.startLogin({ openBrowser: true, opener() { assert.fail('must not open the URL') } })
    assert.equal(result.status, 'error')
    assert.ok(!JSON.stringify(result).includes('<device-token>'))
  }
})

test('OpenCode expired or denied device approval remains an explicit failed login', async () => {
  for (const error of ['access_denied', 'expired_token']) {
    const auth = createOpenCodeConsoleAuth({ credentials: store(), wait: async () => {}, fetchImpl: async url => Response.json(
      url.endsWith('/code') ? challenge : { error, error_description: '<private-response>' }, { status: url.endsWith('/code') ? 200 : 400 }) })
    await auth.startLogin(); await tick()
    assert.equal(auth.loginWatch().status, 'error')
    assert.ok(!auth.loginWatch().detail.includes('<private-response>'))
  }
})

test('OpenCode OAuth refresh rotates once across concurrent queries and keeps workspace display scope', async () => {
  const credentials = store(grant()), seen = []
  const auth = createOpenCodeConsoleAuth({ credentials, now: () => 10000, fetchImpl: async (url, options) => {
    seen.push(url)
    assert.ok(credentials.current().payload.refreshAttempt, 'claim is durable before sending the single-use token')
    assert.equal(new URLSearchParams(options.body).get('refresh_token'), '<old-refresh>')
    return Response.json(tokens())
  } })
  const before = await auth.displayKey()
  const [first, second] = await Promise.all([auth.resolveAuth(), auth.resolveAuth()])
  assert.equal(seen.length, 1)
  assert.deepEqual(first, second)
  assert.equal(first.authorization, 'Bearer <access-token>')
  assert.equal(first.orgId, 'org_fixture')
  assert.ok(first.accountKey && !first.accountKey.includes('org_fixture'))
  assert.equal(await auth.displayKey(), before)
  assert.equal(credentials.current().payload.refreshAttempt, undefined)
})

test('OpenCode ambiguous refresh failure cannot replay a single-use token after restart', async () => {
  const credentials = store(grant())
  let calls = 0
  const options = { credentials, now: () => 10000, fetchImpl: async () => { calls++; throw new Error('<private-token>') } }
  await assert.rejects(createOpenCodeConsoleAuth(options).resolveAuth(), error => error.code === 'network' && !error.message.includes('<private-token>'))
  assert.ok(credentials.current().payload.refreshAttempt)
  await assert.rejects(createOpenCodeConsoleAuth(options).resolveAuth(), error => error.code === 'auth-required')
  assert.equal(calls, 1)
})

test('OpenCode refresh rejects workspace changes and cannot overwrite a newer login', async () => {
  for (const mode of ['workspace', 'new-login']) {
    const credentials = store(grant())
    const auth = createOpenCodeConsoleAuth({ credentials, now: () => 10000, fetchImpl: async () => {
      if (mode === 'new-login') credentials.set({ ...grant(999999), payload: { ...grant(999999).payload, orgId: 'org_new' } })
      return Response.json(tokens(mode === 'workspace' ? 'org_other' : 'org_fixture'))
    } })
    await assert.rejects(auth.resolveAuth(), error => error.code === (mode === 'workspace' ? 'invalid-response' : 'auth-required'))
    if (mode === 'new-login') assert.equal(credentials.current().payload.orgId, 'org_new')
  }
})

test('OpenCode new and absent workspaces have separate scopes without network discovery', async () => {
  const credentials = store(grant(999999)), auth = createOpenCodeConsoleAuth({ credentials, now: () => 10000,
    fetchImpl() { assert.fail('discovery must not fetch') } })
  const scope = await auth.displayKey()
  assert.ok(scope && !scope.includes('org_fixture'))
  credentials.set({ kind: 'grant', payload: { ...grant().payload, orgId: 'org_other' } })
  assert.notEqual(await auth.displayKey(), scope)
  credentials.set(undefined)
  assert.equal(await auth.displayKey(), undefined)
  assert.equal(await auth.resolveAuth(), undefined)
  assert.equal(await auth.isConfigured(), false)
})
