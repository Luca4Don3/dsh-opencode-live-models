import { spawn } from 'node:child_process'

const KEY = 'llm-pi-ai/openai-codex'

export function systemOpen(url) {
  try {
    const [cmd, args] = process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]]
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true })
    child.on('error', () => {})
    child.unref()
  } catch { /* best effort */ }
}

/** Each plugin mount owns its own login, so disposing an old mount cannot cancel a new one. */
export function createLoginController() {
  /** Active login sessions by credential key. @type {Map<string, {controller: AbortController, watch: any}>} */
  const sessions = new Map()
  /** Pending manual-code prompts by credential key. @type {Map<string, {resolve: (v: string) => void, reject: (e: Error) => void}>} */
  const pendingPrompts = new Map()

  /** Snapshot of the current login attempt; safe to render, no secrets. */
  function loginWatch() {
    for (const s of sessions.values()) {
      return { status: s.watch.status, openUrl: s.watch.openUrl, prompt: s.watch.prompt, detail: s.watch.detail }
    }
    return undefined
  }

  /** Cancel every in-flight login (explicit cancel or plugin disposal). */
  function cancelLogin(reason = 'login cancelled') {
    for (const s of sessions.values()) s.controller.abort(new Error(reason))
    for (const p of pendingPrompts.values()) p.reject(new Error(reason))
    pendingPrompts.clear()
  }

  /**
   * Answer pi-ai manual_code with a pasted final redirect URL or code.
   * @param value - the pasted value.
   * @returns whether a waiting prompt consumed it.
   */
  function submitCode(value) {
    const pending = pendingPrompts.get(KEY)
    const trimmed = typeof value === 'string' ? value.trim() : ''
    if (pending === undefined || trimmed === '') return false
    pendingPrompts.delete(KEY)
    const s = sessions.get(KEY)
    if (s && s.watch) delete s.watch.prompt
    pending.resolve(trimmed)
    return true
  }

  /** AbortSignal.any replacement: Node 18.0-18.16 lacks it while engines allows >=18. */
  function anySignal(signals) {
    const controller = new AbortController()
    const abort = () => controller.abort()
    for (const sig of signals) {
      if (sig.aborted) { abort(); return controller.signal }
      sig.addEventListener('abort', abort, { once: true })
    }
    return controller.signal
  }

  /**
   * Start (or report) the native sign-in. Resolves once the authorization URL
   * is available so the plugin page can render it immediately.
   * @param {any} ctx - plugin context carrying the host authorization service.
   * @returns {Promise<{status: string, openUrl?: string, prompt?: any, detail?: string}>} watch snapshot.
   */
  async function startLogin(ctx, { openBrowser = false, opener = systemOpen } = {}) {
    const running = loginWatch()
    if (running) return running
    const authorization = ctx.get('authorization')
    const flow = authorization && authorization.describe(KEY)
    if (!flow || !flow.methods.some(m => m.id === 'oauth')) {
      return { status: 'error', detail: 'native openai-codex OAuth flow unavailable (is providers.openai-codex configured?)' }
    }
    const controller = new AbortController()
    const watch = { status: 'waiting', openUrl: undefined, prompt: undefined, detail: undefined }
    let resolveFirstUrl
    const firstUrl = new Promise(r => { resolveFirstUrl = r })
    sessions.set(KEY, { controller, watch })
    void (async () => {
      try {
        const outcome = await authorization.begin({
          key: KEY,
          method: 'oauth',
          signal: controller.signal,
          interaction: {
            notify(n) {
              if (n.url) {
                watch.openUrl = n.url
                if (openBrowser && n.url.startsWith('https://auth.openai.com/')) {
                  try { opener(n.url) } catch { /* best effort; URL stays in the command result */ }
                }
                resolveFirstUrl()
              }
            },
            async prompt(pr) {
              if (pr.kind === 'select' && Array.isArray(pr.options) && pr.options.some(o => o.id === 'browser')) return 'browser'
              if (pr.kind === 'text' || pr.kind === 'manual_code') {
                watch.prompt = { type: pr.kind, message: typeof pr.message === 'string' ? pr.message : 'waiting for code', placeholder: pr.placeholder }
                return await new Promise((resolve, reject) => {
                  pendingPrompts.set(KEY, { resolve, reject })
                  const sig = anySignal([controller.signal].concat(pr.signal ? [pr.signal] : []))
                  const done = () => { pendingPrompts.delete(KEY); reject(new DOMException('login cancelled', 'AbortError')) }
                  if (sig.aborted) done(); else sig.addEventListener('abort', done, { once: true })
                })
              }
              throw new Error('unsupported login prompt: ' + pr.kind)
            },
          },
        })
        watch.status = outcome && outcome.status === 'authorized' ? 'ok' : 'error'
        if (watch.status === 'error') watch.detail = 'authorization ended with ' + String(outcome && outcome.status)
      } catch (error) {
        watch.status = 'error'
        watch.detail = String(error && error.message ? error.message : error).slice(0, 200)
      } finally {
        sessions.delete(KEY)
        pendingPrompts.delete(KEY)
        resolveFirstUrl()
      }
    })().catch(() => {})
    await firstUrl
    return loginWatch() || { status: 'error', detail: 'login ended before a URL was produced' }
  }

  return { startLogin, submitCode, cancelLogin, loginWatch }
}

const defaultLogin = createLoginController()
export const { startLogin, submitCode, cancelLogin, loginWatch } = defaultLogin
