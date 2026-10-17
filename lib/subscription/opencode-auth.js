import { randomUUID } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import { QuotaError } from './errors.js'
import { requestSignal } from './http.js'
import { accountKeyOf, displayScopeOf } from './identity.js'
import { systemOpen } from './login.js'

export const OPENCODE_RECORD = 'dsh-opencode-live-models/opencode-console'
const ORIGIN = 'https://opencode.ai'
const CLIENT_ID = 'dsh-opencode-live-models'

function grantOf(record) {
  const p = record?.kind === 'grant' && record.payload
  return p?.type === 'oauth' && typeof p.access === 'string' && p.access
    && typeof p.refresh === 'string' && p.refresh && Number.isFinite(p.expires)
    && typeof p.orgId === 'string' && /^(org_|wrk_)[\w-]+$/.test(p.orgId) ? p : undefined
}

function tokenGrant(body, previousOrg, now) {
  const orgId = body?.org_id ?? previousOrg
  const payload = { type: 'oauth', access: body?.access_token, refresh: body?.refresh_token,
    expires: now + body?.expires_in * 1000, orgId }
  if (!grantOf({ kind: 'grant', payload }) || !Number.isFinite(body?.expires_in) || body.expires_in <= 0
    || (previousOrg && orgId !== previousOrg)) throw new QuotaError('invalid-response', 'OpenCode 登录响应不完整或工作区发生变化，请重新登录')
  return { kind: 'grant', payload }
}

/** Official device authorization, isolated from model API keys and Codex login. */
export function createOpenCodeConsoleAuth({ credentials, timeoutMs = 15000, fetchImpl = globalThis.fetch,
  wait = (ms, signal) => sleep(ms, undefined, { signal }), now = Date.now } = {}) {
  let attempt, watch = null, refreshing

  const check = signal => { if (signal?.aborted) throw new QuotaError('timeout', 'OpenCode 登录已取消或请求超时') }
  const read = async () => credentials?.readRecord?.(OPENCODE_RECORD)
  async function post(path, values, signal) {
    check(signal)
    const held = requestSignal(signal, timeoutMs)
    try {
      let response
      try {
        response = await fetchImpl(ORIGIN + '/console/auth/device/' + path, {
          method: 'POST', redirect: 'error', signal: held.signal,
          headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ client_id: CLIENT_ID, ...values }).toString(),
        })
      } catch {
        throw new QuotaError(held.signal.aborted ? 'timeout' : 'network', 'OpenCode 登录请求未完成，请重新登录')
      }
      let body
      try { body = JSON.parse(await response.text()) }
      catch { throw new QuotaError('invalid-response', 'OpenCode 登录接口返回了无效响应') }
      return { status: response.status, body }
    } finally { held.release() }
  }

  function loginWatch() { return watch && { ...watch } }
  function cancelLogin() {
    if (attempt) {
      attempt.controller.abort()
      attempt = undefined
      watch = { status: 'cancelled' }
    }
  }
  async function startLogin({ openBrowser = false, opener = systemOpen } = {}) {
    if (attempt) return attempt.start
    if (typeof credentials?.modifyRecord !== 'function') return { status: 'error', detail: '宿主凭据服务不可写，无法保存 OpenCode 登录' }
    const run = { controller: new AbortController() }
    attempt = run
    watch = { status: 'starting' }
    const signal = run.controller.signal
    const active = () => { check(signal); if (attempt !== run) throw new QuotaError('timeout', 'OpenCode 登录已取消') }
    run.start = (async () => {
      try {
        const { status, body } = await post('code', { supports_org_scope: 'true' }, signal)
        active()
        if (status !== 200) throw new QuotaError('auth-required', 'OpenCode 暂时无法启动登录（HTTP ' + status + '）')
        const openUrl = new URL(body?.verification_uri_complete, ORIGIN)
        if (openUrl.origin !== ORIGIN || openUrl.pathname !== '/console/device' || openUrl.username || openUrl.password
          || typeof body.device_code !== 'string' || !body.device_code || typeof body.user_code !== 'string' || !body.user_code
          || !Number.isFinite(body.expires_in) || body.expires_in <= 0
          || !Number.isFinite(body.interval) || body.interval <= 0) throw new QuotaError('invalid-response', 'OpenCode 设备授权响应不完整')
        const expiresAt = now() + body.expires_in * 1000
        let intervalMs = Math.max(1000, body.interval * 1000)
        watch = { status: 'waiting', openUrl: openUrl.href, userCode: body.user_code, expiresAt }
        if (openBrowser) {
          try { opener(openUrl.href) }
          catch { watch.detail = '浏览器未能自动打开，请点击下方授权链接' }
        }
        run.poll = (async () => {
          try {
            while (now() < expiresAt) {
              await wait(Math.min(intervalMs, expiresAt - now()), signal)
              active()
              if (now() >= expiresAt) break
              const result = await post('token', { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: body.device_code }, signal)
              active()
              if (result.status === 200) {
                const grant = tokenGrant(result.body, undefined, now())
                await credentials.modifyRecord(OPENCODE_RECORD, () => { active(); return grant })
                active()
                watch = { status: 'ok' }
                return
              }
              if (result.body?.error === 'authorization_pending' && result.status === 400) continue
              if (result.body?.error === 'slow_down' && result.status === 400) { intervalMs += 5000; continue }
              throw new QuotaError('auth-required', result.body?.error === 'access_denied' ? 'OpenCode 授权被拒绝，请重新登录' : 'OpenCode 授权已失效，请重新登录')
            }
            throw new QuotaError('auth-required', 'OpenCode 授权码已过期，请重新登录')
          } catch (error) {
            if (attempt === run) watch = { status: 'error', detail: error instanceof QuotaError ? error.message : 'OpenCode 登录未能完成，请重试' }
          } finally { if (attempt === run) attempt = undefined }
        })()
        return loginWatch()
      } catch (error) {
        if (attempt === run) {
          attempt = undefined
          watch = { status: 'error', detail: error instanceof QuotaError ? error.message : 'OpenCode 登录未能启动，请重试' }
        }
        return loginWatch()
      }
    })()
    return run.start
  }

  async function refresh(signal) {
    check(signal)
    if (typeof credentials?.modifyRecord !== 'function') throw new QuotaError('auth-required', '请重新登录 OpenCode Console')
    const claim = randomUUID()
    // Persist the claim BEFORE consuming a single-use refresh token. After a
    // crash or ambiguous network failure, require login rather than replay it.
    const claimed = await credentials.modifyRecord(OPENCODE_RECORD, current => {
      check(signal)
      const grant = grantOf(current)
      if (!grant || grant.refreshAttempt) throw new QuotaError('auth-required', 'OpenCode 登录需要重新授权')
      if (grant.expires > now() + 60000) return undefined
      return { kind: 'grant', payload: { ...grant, refreshAttempt: claim } }
    })
    const previous = grantOf(claimed)
    if (previous?.refreshAttempt !== claim) return previous
    const { status, body } = await post('token', { grant_type: 'refresh_token', refresh_token: previous.refresh }, signal)
    check(signal)
    if (status !== 200) throw new QuotaError('auth-required', 'OpenCode 登录已失效，请重新登录')
    const next = tokenGrant(body, previous.orgId, now())
    const saved = await credentials.modifyRecord(OPENCODE_RECORD, current => {
      check(signal)
      if (grantOf(current)?.refreshAttempt !== claim) throw new QuotaError('auth-required', 'OpenCode 登录已变化，请重新查询')
      return next
    })
    return grantOf(saved)
  }

  return {
    loginWatch, startLogin, cancelLogin,
    async status() { const grant = grantOf(await read()); return { loggedIn: !!grant && !grant.refreshAttempt, login: loginWatch() } },
    async isConfigured() { return !!grantOf(await read()) },
    async displayKey() { return displayScopeOf('opencode/console', grantOf(await read())?.orgId) },
    async resolveAuth({ signal } = {}) {
      const record = await read()
      if (!record) return undefined
      let grant = grantOf(record)
      if (grant?.refreshAttempt && refreshing) grant = await refreshing
      if (!grant || grant.refreshAttempt) throw new QuotaError('auth-required', '请重新登录 OpenCode Console')
      if (grant.expires <= now() + 60000) {
        if (!refreshing) refreshing = refresh(signal).finally(() => { refreshing = undefined })
        grant = await refreshing
      }
      check(signal)
      if (!grant) throw new QuotaError('auth-required', '请重新登录 OpenCode Console')
      return { authorization: 'Bearer ' + grant.access, orgId: grant.orgId,
        accountKey: accountKeyOf('opencode/console/' + grant.orgId).accountKey }
    },
  }
}
