/**
 * Loopback HTTP API behind the plugin detail login page, mounted only when the
 * host webServer exists (prefix /dsh-opencode-live-models, never the /api RPC).
 * @module dsh-opencode-live-models/login-http
 */
import * as defaultLogin from './login.js'

const PREFIX = '/dsh-opencode-live-models'

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

async function readJson(req) {
  const chunks = []
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
    const total = chunks.reduce((sum, p) => sum + p.length, 0)
    if (total > 64_000) throw new Error('request body too large')
  }
  if (chunks.length === 0) return {}
  const raw = Buffer.concat(chunks).toString('utf8').trim()
  if (raw === '') return {}
  const parsed = JSON.parse(raw)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('JSON body must be an object')
  return parsed
}

async function statusOf(ctx, login) {
  const record = ctx.get('credentials') ? await ctx.get('credentials').describeRecord('llm-pi-ai/openai-codex') : undefined
  const w = login.loginWatch()
  return {
    loggedIn: record?.configured === true,
    login: w === undefined ? null : { status: w.status, openUrl: w.openUrl, prompt: w.prompt, detail: w.detail },
  }
}

/**
 * Handle one request under /dsh-opencode-live-models.
 * @param {any} ctx - plugin context.
 * @param {import('node:http').IncomingMessage} req - request.
 * @param {import('node:http').ServerResponse} res - response.
 * @param {{openBrowser?: boolean}} options - test seam; production passes true.
 * @returns {Promise<void>} resolves when the response is sent.
 */
export async function handleLoginHttp(ctx, req, res, options = {}) {
  const login = options.login ?? defaultLogin
  const method = (req.method ?? 'GET').toUpperCase()
  const host = req.headers.host ?? '127.0.0.1'
  const url = new URL(req.url ?? '/', 'http://' + host)
  const path = url.pathname.replace(/\/+$/, '') || '/'
  try {
    if (path.startsWith(PREFIX + '/opencode/')) {
      const auth = options.consoleAuth
      if (!auth) { sendJson(res, 503, { error: 'unavailable' }); return }
      if (method === 'POST' && path === PREFIX + '/opencode/login') {
        const login = await auth.startLogin({ openBrowser: options.openBrowser !== false })
        sendJson(res, login?.status === 'error' ? 500 : 200, { ...(await auth.status()), login })
        return
      }
      if (method === 'POST' && path === PREFIX + '/opencode/cancel') {
        auth.cancelLogin()
        sendJson(res, 200, await auth.status())
        return
      }
      if (method === 'GET' && path === PREFIX + '/opencode/status') {
        sendJson(res, 200, await auth.status())
        return
      }
    }
    if (method === 'GET' && path === PREFIX + '/status') {
      sendJson(res, 200, await statusOf(ctx, login))
      return
    }
    if (method === 'GET' && path === PREFIX + '/subscriptions') {
      const usage = ctx.get('subscriptionUsage')
      if (!usage) { sendJson(res, 503, { error: 'unavailable' }); return }
      const subscriptions = (await usage.configured())
        .filter(provider => !/^deepseek(?:$|[-/])/i.test(provider.providerId))
        .slice(0, 3)
      sendJson(res, 200, { subscriptions, freshMs: usage.freshMs })
      return
    }
    if (method === 'GET' && path === PREFIX + '/usage') {
      const usage = ctx.get('subscriptionUsage')
      if (!usage) { sendJson(res, 503, { error: 'unavailable' }); return }
      const provider = url.searchParams.get('provider')
      if (!usage.providers.includes(provider)) { sendJson(res, 400, { error: 'unsupported' }); return }
      if (url.searchParams.get('refresh') === '1') usage.invalidate(provider)
      sendJson(res, 200, await usage.query(provider))
      return
    }
    if (method === 'POST' && path === PREFIX + '/login') {
      const w = await login.startLogin(ctx, { openBrowser: options.openBrowser !== false })
      sendJson(res, w.status === 'error' ? 500 : 200, { ...w, ...(await statusOf(ctx, login)) })
      return
    }
    if (method === 'POST' && path === PREFIX + '/code') {
      const body = await readJson(req)
      const value = typeof body.value === 'string' ? body.value : ''
      if (value.trim() === '') { sendJson(res, 400, { error: 'missing value' }); return }
      const accepted = login.submitCode(value)
      sendJson(res, accepted ? 200 : 409, { ok: accepted })
      return
    }
    if (method === 'POST' && path === PREFIX + '/cancel') {
      login.cancelLogin('cancelled from plugin page')
      sendJson(res, 200, await statusOf(ctx, login))
      return
    }
    sendJson(res, 404, { error: 'not found' })
  } catch (error) {
    sendJson(res, error?.code === 'auth-required' ? 401 : 500, {
      error: error?.code ?? 'error',
      detail: String(error && error.message ? error.message : error).slice(0, 200),
    })
  }
}
