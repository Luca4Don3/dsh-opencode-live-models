import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdirSync, mkdtempSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createQuotaEngine } from '../../lib/subscription/engine.js'
import { createCodexAdapter } from '../../lib/subscription/providers/codex.js'
import { createOpenCodeGoAdapter } from '../../lib/subscription/providers/opencode-go.js'
import { createLoginController } from '../../lib/subscription/login.js'
import { makeCodexRefresh } from '../../lib/subscription/refresh.js'
import { apply as applySubscription } from '../../lib/subscription/index.js'
import { handleLoginHttp } from '../../lib/subscription/login-http.js'
import { QuotaError } from '../../lib/subscription/errors.js'

const fixture = name => JSON.parse(readFileSync(new URL('./fixtures/' + name, import.meta.url), 'utf8'))
const tick = () => new Promise(resolve => setImmediate(resolve))
const record = { kind: 'grant', payload: { type: 'oauth', access: '<token>', accountId: 'fixture-account', expires: Date.now() + 3600000 } }

test('real Codex normalization and engine use the same account cache key', async () => {
  let requests = 0
  const adapter = createCodexAdapter({ credentials: { readRecord: async () => record }, fetchImpl: async (url, options) => {
    requests++
    assert.equal(options.headers['chatgpt-account-id'], record.payload.accountId)
    assert.equal(options.redirect, 'error')
    return new Response(JSON.stringify(url.endsWith('usage') ? fixture('codex-usage-available.json') : { available_count: 1 }))
  } })
  const engine = createQuotaEngine({ adapters: { 'openai-codex': adapter }, abort: new AbortController() })
  const first = await engine.query('openai-codex')
  assert.equal(await engine.query('openai-codex'), first)
  assert.equal(requests, 2, 'one usage request and one reset-credit request')
  assert.equal(first.accountKey, (await adapter.resolveAuth()).accountKey)
})

test('unverified Go accounts never share a cache or in-flight query', async () => {
  let value = '<token-a>'
  const seen = []
  const adapter = createOpenCodeGoAdapter({ credentials: { resolve: async () => ({ value }) }, fetchImpl: async (url, options) => {
    seen.push(options.headers.authorization)
    return new Response(JSON.stringify(fixture('opencode-go-usage.json')))
  } })
  const engine = createQuotaEngine({ adapters: { 'opencode-go': adapter }, abort: new AbortController() })
  await engine.query('opencode-go')
  value = '<token-b>'
  await engine.query('opencode-go')
  assert.deepEqual(seen, ['Bearer <token-a>', 'Bearer <token-b>'])
  assert.equal(engine.hasCache('opencode-go'), false)
})

test('a late failure from account A never falls back to account B data', async () => {
  let accountKey = 'a'
  let rejectA
  const adapter = {
    resolveAuth: async () => ({ accountKey }),
    fetchUsage(auth) { return auth.accountKey === 'a' ? new Promise((resolve, reject) => { rejectA = reject }) : Promise.resolve({}) },
    normalize(payload, auth) { return { accountKey: auth.accountKey, status: 'ready', windows: [] } },
  }
  const engine = createQuotaEngine({ adapters: { x: adapter }, abort: new AbortController() })
  const a = engine.query('x')
  await tick()
  accountKey = 'b'
  assert.equal((await engine.query('x')).accountKey, 'b')
  const rejected = assert.rejects(a, error => error.code === 'network')
  rejectA(new QuotaError('network', 'fixture failure'))
  await rejected
})

test('native quota refresh forwards the caller abort signal to Pi-AI', async () => {
  const abort = new AbortController()
  let seen
  const refresh = await makeCodexRefresh({ readRecord: async () => record }, async () => ({
    pi: { createModels: () => ({ setProvider() {}, async getAuth(id, options) { seen = options.signal; assert.equal(id, 'openai-codex') } }) },
    openaiCodexProvider: () => ({}),
  }))
  assert.equal(await refresh({ signal: abort.signal }), record.payload)
  assert.equal(seen, abort.signal)
})

test('disposal during subscription initialization cannot leave a service behind', async () => {
  const disposers = []
  let provided = false
  const pending = applySubscription({
    get: () => ({}),
    logger: { warn() {} },
    effect(fn) { disposers.push(fn()) },
    provide() { provided = true },
    inject() { assert.fail('HTTP route must not be registered after disposal') },
  })
  for (const dispose of disposers) dispose()
  await pending
  assert.equal(provided, false)
})

test('display scopes survive subscription service restarts and change with the account or Go key', async () => {
  let codex = false, go = false, usage
  let accountId = 'fixture-account', goKey = '<token-a>'
  const disposers = []
  const ctx = {
    get: () => ({
      describeRecord: async () => ({ configured: codex }),
      resolve: async name => {
        if (name === 'OPENCODE_API_KEY') return undefined
        assert.equal(name, 'CUSTOM_GO_KEY')
        return go ? { value: goKey } : undefined
      },
      readRecord: async () => ({ ...record, payload: { ...record.payload, accountId } }),
    }),
    logger: { warn() {} },
    effect(fn) { disposers.push(fn()) },
    provide(name, value) { assert.equal(name, 'subscriptionUsage'); usage = value },
  }
  await applySubscription(ctx, { goApiKeyRef: 'CUSTOM_GO_KEY' })
  assert.deepEqual(await usage.configured(), [])
  const descriptions = async () => (await usage.configured()).map(({ providerId, label }) => ({ providerId, label }))
  codex = true
  assert.deepEqual(await descriptions(), [{ providerId: 'openai-codex', label: 'OpenAI订阅' }])
  go = true
  assert.deepEqual(await descriptions(), [
    { providerId: 'openai-codex', label: 'OpenAI订阅' },
    { providerId: 'opencode-go', label: 'OpenCode Go' },
  ])
  const initial = await usage.configured()
  assert.ok(initial.every(provider => typeof provider.cacheKey === 'string' && !provider.cacheKey.includes('<token>')))
  assert.deepEqual(await usage.configured(), initial, 'display scopes stay stable without credential changes')
  await applySubscription(ctx, { goApiKeyRef: 'CUSTOM_GO_KEY' })
  assert.deepEqual(await usage.configured(), initial, 'the same credentials keep their scopes after a fresh mount')
  goKey = '<token-b>'
  const goChanged = await usage.configured()
  assert.equal(goChanged[0].cacheKey, initial[0].cacheKey)
  assert.notEqual(goChanged[1].cacheKey, initial[1].cacheKey)
  accountId = 'fixture-other-account'
  assert.notEqual((await usage.configured())[0].cacheKey, initial[0].cacheKey)
  assert.equal(usage.freshMs, 300000)
  codex = false
  assert.deepEqual(await descriptions(), [{ providerId: 'opencode-go', label: 'OpenCode Go' }])
  for (const dispose of disposers) dispose()
})

test('each mount owns its login cancellation independently', async () => {
  const old = createLoginController(), current = createLoginController()
  const signals = []
  const ctx = { get: () => ({
    describe: () => ({ methods: [{ id: 'oauth' }] }),
    begin({ signal, interaction }) {
      signals.push(signal)
      interaction.notify({ url: 'https://auth.openai.com/oauth/authorize?state=fixture' })
      return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }))
    },
  }) }
  await old.startLogin(ctx)
  await current.startLogin(ctx)
  old.cancelLogin()
  await tick()
  assert.equal(signals[0].aborted, true)
  assert.equal(signals[1].aborted, false)
  assert.equal(current.loginWatch().status, 'waiting')
  current.cancelLogin()
  await tick()
})

test('configured Zen uses its custom credential reference and exposes only a balance display scope', async () => {
  let usage
  const refs = []
  await applySubscription({
    effect(fn) { fn() }, logger: { warn() {} },
    get: () => ({ describeRecord: async () => ({ configured: false }), resolve: async ref => { refs.push(ref); return ref === 'ZEN_CUSTOM' ? { value: '<token>' } : undefined } }),
    provide(name, value) { usage = value },
  }, { zenApiKeyRef: '!ZEN_CUSTOM' })
  const configured = await usage.configured()
  assert.equal(configured.length, 1)
  assert.equal(configured[0].providerId, 'opencode')
  assert.equal(configured[0].kind, 'balance')
  assert.equal(configured[0].label, 'OpenCode Zen')
  assert.ok(!JSON.stringify(configured).includes('<token>'))
  assert.ok(refs.includes('ZEN_CUSTOM'))
})

test('unified entry mounts quota HTTP services under its own plugin lifetime', async () => {
  const tempRoot = fileURLToPath(new URL('../../.temp/', import.meta.url))
  mkdirSync(tempRoot, { recursive: true })
  process.env.DSH_PROFILE_DIR = mkdtempSync(tempRoot + 'merged-entry-')
  const { apply } = await import('../../lib/index.js')
  const disposers = [], routes = [], pending = []
  const services = new Map([['credentials', { describeRecord: async () => ({ configured: true }) }]])
  const effect = fn => { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose) }
  const child = {
    get: name => services.get(name), logger: { warn() {}, debug() {} }, effect,
    provide(name, value) { services.set(name, value); disposers.push(() => services.delete(name)) },
    inject(deps, callback) {
      assert.deepEqual(deps, ['webServer'])
      callback({ effect, webServer: { register(route) { routes.push(route); return () => routes.splice(routes.indexOf(route), 1) } } })
    },
  }
  apply({
    llm: { adapters: new Map() }, logger: { info() {}, warn() {}, debug() {} },
    on() {}, emit() {}, effect,
    inject(deps, callback) {
      if (deps[0] === 'settings' || deps[0] === 'compaction') return
      assert.deepEqual(deps, ['credentials']); pending.push(callback(child))
    },
  })
  await Promise.all(pending)
  assert.deepEqual(services.get('subscriptionUsage').providers, ['openai-codex', 'opencode-go', 'opencode'])
  assert.equal(routes[0].path, '/dsh-opencode-live-models')
  const body = await new Promise(resolve => routes[0].handler({ method: 'GET', url: routes[0].path + '/status', headers: {} }, { writeHead() {}, end: data => resolve(JSON.parse(data)) }))
  assert.equal(body.loggedIn, true)
  const usage = services.get('subscriptionUsage')
  for (const dispose of disposers.reverse()) dispose()
  assert.equal(routes.length, 0)
  assert.equal(services.has('subscriptionUsage'), false)
  await assert.rejects(usage.query('openai-codex'), error => error.code === 'timeout')
})

test('usage HTTP endpoint queries only supported providers and reports auth errors', async () => {
  const seen = []
  const ctx = { get: () => ({ providers: ['openai-codex'], invalidate: id => seen.push(id), query: async () => { throw new QuotaError('auth-required', 'sign in first') } }) }
  async function call(provider) {
    let status, body
    await handleLoginHttp(ctx, { method: 'GET', url: '/dsh-opencode-live-models/usage?provider=' + provider + '&refresh=1', headers: {} }, { writeHead: code => { status = code }, end: data => { body = JSON.parse(data) } })
    return { status, body }
  }
  assert.equal((await call('opencode')).status, 400)
  const result = await call('openai-codex')
  assert.equal(result.status, 401)
  assert.equal(result.body.error, 'auth-required')
  assert.deepEqual(seen, ['openai-codex'])
})
