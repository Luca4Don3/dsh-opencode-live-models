import { test } from 'node:test'
import assert from 'node:assert/strict'
import { handleLoginHttp } from '../../lib/subscription/login-http.js'
import { cancelLogin } from '../../lib/subscription/login.js'

function fakeRes() {
  let resolve
  const done = new Promise(r => { resolve = r })
  return {
    status: 0, headers: null, body: null, done,
    writeHead(c, h) { this.status = c; this.headers = h },
    end(b) { this.body = b; resolve(b) },
  }
}
function fakeReq(method, url, body) {
  const chunks = body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]
  return {
    method, url, headers: { host: '127.0.0.1' },
    async *[Symbol.asyncIterator]() { for (const c of chunks) yield c },
  }
}
function fakeCtx({ configured = false, hanging = false } = {}) {
  const auth = {
    describe: () => ({ methods: [{ id: 'oauth' }] }),
    begin({ interaction }) {
      interaction.notify({ url: 'https://auth.openai.com/oauth/authorize?state=t' })
      return hanging ? new Promise(() => {}) : Promise.resolve({ status: 'authorized' })
    },
  }
  return { get: n => n === 'authorization' ? auth : (n === 'credentials' ? { describeRecord: async () => ({ configured }) } : undefined) }
}
async function call(ctx, method, path, body, options) {
  const res = fakeRes()
  await handleLoginHttp(ctx, fakeReq(method, path, body), res, options)
  await res.done
  return { status: res.status, body: JSON.parse(res.body) }
}

test('GET status reports signed-out state', async () => {
  cancelLogin('cleanup')
  const r = await call(fakeCtx(), 'GET', '/dsh-opencode-live-models/status')
  assert.equal(r.status, 200)
  assert.equal(r.body.loggedIn, false)
  assert.equal(r.body.login, null)
})

test('POST login returns the URL and keeps waiting in background', async () => {
  cancelLogin('cleanup')
  const r = await call(fakeCtx({ hanging: true }), 'POST', '/dsh-opencode-live-models/login', undefined, { openBrowser: false })
  assert.equal(r.status, 200)
  assert.match(r.body.openUrl, /^https:\/\/auth\.openai\.com\//)
  assert.equal(r.body.login && r.body.login.status, 'waiting')
  cancelLogin('cleanup')
})

test('POST code without a pending prompt is 409, empty value 400', async () => {
  cancelLogin('cleanup')
  const c = await call(fakeCtx(), 'POST', '/dsh-opencode-live-models/code', { value: 'x' })
  assert.equal(c.status, 409)
  assert.equal(c.body.ok, false)
  const e = await call(fakeCtx(), 'POST', '/dsh-opencode-live-models/code', { value: '   ' })
  assert.equal(e.status, 400)
})

test('unknown route is 404', async () => {
  const r = await call(fakeCtx(), 'GET', '/dsh-opencode-live-models/nope')
  assert.equal(r.status, 404)
})

test('OpenCode login endpoints are separate from Codex and expose only safe login status', async () => {
  let cancelled = false
  const consoleAuth = {
    status: async () => ({ loggedIn: false, login: cancelled ? { status: 'cancelled' } : null }),
    async startLogin(options) { assert.equal(options.openBrowser, false); return { status: 'waiting', userCode: 'TEST-CODE' } },
    cancelLogin() { cancelled = true },
  }
  const options = { consoleAuth, openBrowser: false }
  const ctx = { get() { assert.fail('must not invoke native Codex login') } }
  assert.equal((await call(ctx, 'GET', '/dsh-opencode-live-models/opencode/status', undefined, options)).body.loggedIn, false)
  const started = await call(ctx, 'POST', '/dsh-opencode-live-models/opencode/login', undefined, options)
  assert.equal(started.body.login.userCode, 'TEST-CODE')
  const ended = await call(ctx, 'POST', '/dsh-opencode-live-models/opencode/cancel', undefined, options)
  assert.equal(ended.body.login.status, 'cancelled')
  assert.equal((await call(ctx, 'GET', '/dsh-opencode-live-models/opencode/status')).status, 503)
})

test('subscription list excludes official DeepSeek and limits configured subscriptions to three', async () => {
  const configured = [
    { providerId: 'deepseek', label: 'DeepSeek' },
    { providerId: 'deepseek-official', label: 'DeepSeek official' },
    { providerId: 'openai-codex', label: 'OpenAI Codex' },
    { providerId: 'opencode-go', label: 'OpenCode Go' },
    { providerId: 'fixture-third', label: 'Third' },
    { providerId: 'fixture-fourth', label: 'Fourth' },
  ]
  const r = await call({ get: name => {
    assert.equal(name, 'subscriptionUsage')
    return { freshMs: 300000, configured: async () => configured, query() { assert.fail('listing must not query quota') } }
  } }, 'GET', '/dsh-opencode-live-models/subscriptions')
  assert.equal(r.status, 200)
  assert.deepEqual(r.body.subscriptions, configured.slice(2, 5))
  assert.equal(r.body.freshMs, 300000)
})

test('subscription list explicitly reports a missing service or credential discovery failure', async () => {
  const missing = await call({ get() {} }, 'GET', '/dsh-opencode-live-models/subscriptions')
  assert.equal(missing.status, 503)
  assert.equal(missing.body.error, 'unavailable')
  const failed = await call({ get: () => ({ configured() { throw new Error('fixture credentials unavailable') } }) }, 'GET', '/dsh-opencode-live-models/subscriptions')
  assert.equal(failed.status, 500)
  assert.equal(failed.body.detail, 'fixture credentials unavailable')
})
