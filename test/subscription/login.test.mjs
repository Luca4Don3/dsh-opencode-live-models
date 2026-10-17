import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startLogin, submitCode, cancelLogin, loginWatch } from '../../lib/subscription/login.js'

const tick = () => new Promise(r => setImmediate(r))

function makeAuth({ withFlow = true, mode = 'auto', defer = false } = {}) {
  let resolveBegun, rejectBegun
  let releaseGate
  const gate = defer ? new Promise(r => { releaseGate = r }) : Promise.resolve()
  const release = () => { if (releaseGate) releaseGate() }
  const begun = new Promise((r, j) => { resolveBegun = r; rejectBegun = j })
  const auth = {
    beginCalls: 0,
    describe() { return withFlow ? { methods: [{ id: 'oauth' }, { id: 'api-key' }] } : undefined },
    begin({ signal, interaction }) {
      auth.beginCalls += 1
      ;(async () => {
        try {
          const choice = await interaction.prompt({ kind: 'select', options: [{ id: 'browser' }] })
          if (choice !== 'browser') throw new Error('select mismatch')
          interaction.notify({ type: 'auth_url', url: 'https://auth.openai.com/oauth/authorize?state=t' })
          if (mode === 'manual') {
            const v = await interaction.prompt({ kind: 'manual_code', message: 'paste redirect', signal })
            if (!v.startsWith('https://localhost:1455/')) throw new Error('bad code: ' + v)
          }
          if (signal.aborted) throw new DOMException('aborted', 'AbortError')
          await gate
          resolveBegun({ status: 'authorized' })
        } catch (e) { rejectBegun(e) }
      })()
      return begun
    },
  }
  return { auth, release }
}

const ctxWith = auth => ({ get: name => name === 'authorization' ? auth : undefined })

test('start resolves with the URL while the flow continues in background', async () => {
  const { auth, release } = makeAuth({ defer: true })
  const w = await startLogin(ctxWith(auth))
  assert.equal(w.status, 'waiting')
  assert.match(w.openUrl, /^https:\/\/auth\.openai\.com\//)
  assert.equal(auth.beginCalls, 1)
  release() // begin settles only now — proves start returned before completion
  await tick(); await tick()
  assert.equal(loginWatch(), undefined, 'session removed after completion')
})

test('manual-code prompt: submitCode completes the flow', async () => {
  const { auth } = makeAuth({ mode: 'manual' })
  const w = await startLogin(ctxWith(auth))
  assert.ok(w.openUrl, 'URL is still produced first')
  await tick()
  const pending = loginWatch()
  assert.ok(pending && pending.prompt, 'manual prompt recorded')
  assert.equal(submitCode('  https://localhost:1455/auth/callback?code=z  '), true)
  await tick(); await tick()
  assert.equal(loginWatch(), undefined, 'session finished and removed')
})

test('browser auto-opens only when requested and only for the official origin', async () => {
  const opened = []
  const { auth } = makeAuth()
  await startLogin(ctxWith(auth), { openBrowser: true, opener: u => opened.push(u) })
  assert.equal(opened.length, 1)
  assert.match(opened[0], /^https:\/\/auth\.openai\.com\//)
  const { auth: auth2 } = makeAuth()
  const opened2 = []
  await startLogin(ctxWith(auth2), { opener: u => opened2.push(u) })
  assert.equal(opened2.length, 0, 'default stays silent (no browser in tests)')
})

test('submitCode without a pending prompt returns false', () => {
  assert.equal(submitCode('whatever'), false)
})

test('missing native flow fails fast without calling begin', async () => {
  const { auth } = makeAuth({ withFlow: false })
  const w = await startLogin(ctxWith(auth))
  assert.equal(w.status, 'error')
  assert.match(w.detail, /flow unavailable/)
  assert.equal(auth.beginCalls, 0)
})

test('cancelLogin aborts an in-flight login and settles as error', async () => {
  const { auth } = makeAuth({ mode: 'manual' })
  await startLogin(ctxWith(auth))
  await tick()
  cancelLogin('test cancel')
  await tick(); await tick(); await tick()
  const w = loginWatch()
  assert.ok(w === undefined || w.status !== 'waiting', 'no login remains waiting')
})
