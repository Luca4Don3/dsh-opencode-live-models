/**
 * dsh-opencode-live-models — read-only subscription quota monitoring for the
 * providers OpenAI Codex, OpenCode Go and OpenCode Zen balances.
 *
 * Design boundaries:
 * - Never registers or patches an LLM provider; quota reads are passive.
 * - Credentials come only from the host public services (ctx.credentials) and
 *   are sent only to each provider's official origin.
 * - Codex refresh delegates to host Pi-AI; optional OpenCode Console login uses
 *   its documented device flow and the same host credential store.
 * - Every in-flight quota request is cancelled when this plugin's fiber is
 *   disposed (disable, unload, HMR reload), satisfying the gate's cancellation
 *   requirement.
 * - The quota engine caches only verified account identities. The account UI
 *   uses separate, stable credential scopes to retain display snapshots.
 *
 * @module dsh-opencode-live-models
 */
import { createQuotaEngine } from './engine.js'
import { createCodexAdapter } from './providers/codex.js'
import { createOpenCodeGoAdapter } from './providers/opencode-go.js'
import { createOpenCodeZenAdapter } from './providers/opencode-zen.js'
import { createLoginController } from './login.js'
import { makeCodexRefresh } from './refresh.js'
import { handleLoginHttp } from './login-http.js'
import { createOpenCodeConsoleAuth } from './opencode-auth.js'

export const name = 'subscription-usage'
export const inject = ['credentials']

export async function apply(ctx, config = {}) {
  const { freshMs = 300000, timeoutMs = 15000, goApiKeyRef = 'OPENCODE_GO_API_KEY', zenApiKeyRef = 'OPENCODE_API_KEY' } = config
  if (!Number.isFinite(freshMs) || freshMs < 1000 || !Number.isFinite(timeoutMs) || timeoutMs < 1000) {
    throw new TypeError('freshMs and timeoutMs must be numbers >= 1000')
  }
  if (typeof goApiKeyRef !== 'string' || goApiKeyRef.trim() === '') throw new TypeError('goApiKeyRef must be a non-empty string')
  if (typeof zenApiKeyRef !== 'string' || zenApiKeyRef.trim() === '') throw new TypeError('zenApiKeyRef must be a non-empty string')
  const abort = new AbortController()
  const login = createLoginController()
  const credentials = ctx.get('credentials')
  const consoleAuth = createOpenCodeConsoleAuth({ credentials, timeoutMs })
  // Cancel every in-flight quota request and login on disable/unload/HMR.
  ctx.effect(() => () => { abort.abort(); login.cancelLogin('plugin disposed'); consoleAuth.cancelLogin() }, 'subscription-usage.cancel-in-flight')
  if (credentials === undefined) {
    ctx.logger.warn('subscription-usage: no credentials service; quota queries will report auth-required')
  }
  const refresh = await makeCodexRefresh(credentials)
  if (abort.signal.aborted) return
  const adapters = {
    'openai-codex': createCodexAdapter({ credentials, refresh, timeoutMs }),
    'opencode-go': createOpenCodeGoAdapter({ credentials, refName: goApiKeyRef, timeoutMs }),
    'opencode': createOpenCodeZenAdapter({ credentials, consoleAuth, refName: zenApiKeyRef, timeoutMs }),
  }
  const engine = createQuotaEngine({ adapters, freshMs, abort })
  ctx.provide('subscriptionUsage', {
    providers: Object.keys(adapters),
    freshMs,
    configured: async () => (await Promise.all(Object.entries(adapters).map(async ([providerId, adapter]) => {
      if (!await adapter.isConfigured()) return undefined
      return {
        providerId,
        label: { 'openai-codex': 'OpenAI订阅', 'opencode-go': 'OpenCode Go', opencode: 'OpenCode Zen' }[providerId],
        cacheKey: await adapter.displayKey(),
        ...(adapter.kind === 'balance' ? { kind: 'balance' } : {}),
      }
    }))).filter(Boolean).slice(0, 3),
    query: (providerId, opts) => engine.query(providerId, { ...opts, signal: opts?.signal ?? abort.signal }),
    invalidate: (providerId) => engine.invalidate(providerId),
  })

  // Plugin-page login API: mounted only when the host webServer exists
  // (ctx.inject waits for the service; headless profiles simply never run it).
  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], (httpCtx) => {
      httpCtx.effect(() => httpCtx.webServer.register({
        kind: 'prefix',
        path: '/dsh-opencode-live-models',
        handler: (req, res) => { void handleLoginHttp(ctx, req, res, { login, consoleAuth }) },
      }), 'subscription-usage: login http')
    })
  }
}
