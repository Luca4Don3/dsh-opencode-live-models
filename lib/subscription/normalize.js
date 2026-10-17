/**
 * Provider quota normalization into one UsageSnapshot, preserving the rules
 * pinned by the P0 verification suite (dsh-opencode-live-models):
 * - explicit server verdict wins over displayed percentages in both directions
 * - a bare 429 is rate limiting, not account quota, until the body says so
 * - missing windows are unknown, never 0% and never "full"
 * - credits are separate from windows and never mixed into percentages
 */
import { accountKeyOf } from './identity.js'

function windowOf(w) {
  if (!w || typeof w.used_percent !== 'number') return undefined
  const used = Math.max(0, Math.min(100, w.used_percent))
  return {
    usedPercent: used,
    remainingPercent: Number((100 - used).toFixed(2)),
    ...(typeof w.limit_window_seconds === 'number' ? { windowMinutes: Math.ceil(w.limit_window_seconds / 60) } : {}),
    ...(typeof w.reset_at === 'number' ? { resetsAt: w.reset_at } : {}),
  }
}

/**
 * Normalize one Codex usage payload (measured shape: top-level rate_limit.*).
 * @param {any} payload - parsed /wham/usage body.
 * @param {object} context - httpStatus, httpError, accountId, resetCredits, capturedAt.
 * @returns {any} UsageSnapshot.
 */
export function normalizeCodex(payload, { httpStatus, httpError, accountId, resetCredits, capturedAt } = {}) {
  const rl = payload?.rate_limit ?? {}
  const usageAllowed = typeof rl.allowed === 'boolean' ? rl.allowed : undefined
  const limitReached = rl.limit_reached === true
  const windows = [
    windowOf(rl.primary_window) && { id: 'primary', label: 'Primary', ...windowOf(rl.primary_window) },
    windowOf(rl.secondary_window) && { id: 'secondary', label: 'Secondary', ...windowOf(rl.secondary_window) },
  ].filter(Boolean)
  const explicitExhausted = usageAllowed === false || limitReached === true
  const percentExhausted = rl.primary_window?.used_percent === 100
  let status
  if (httpStatus === 401) status = 'auth-required'
  else if (explicitExhausted) status = 'exhausted'
  else if (usageAllowed === true) status = 'ready'
  else if (httpStatus === 429) status = /usage[ -]?limit/i.test(httpError ?? '') ? 'exhausted' : 'rate-limited'
  else if (windows.length === 0) status = 'unknown'
  else if (percentExhausted) status = 'exhausted'
  else status = 'ready'
  const modelUsage = Object.entries(payload?.model_usage ?? {}).map(([modelId, v]) => ({
    modelId,
    available: v?.available === true,
    ...(v?.credits_would_enable === true ? { creditsWouldEnable: true } : {}),
  }))
  const credits = payload?.credits
  const ident = accountKeyOf(accountId)
  return {
    providerId: 'openai-codex',
    accountKey: ident.accountKey,
    identity: ident.identity,
    plan: typeof payload?.plan_type === 'string' ? payload.plan_type : undefined,
    scope: 'subscription',
    status,
    usageAllowed,
    limitReached,
    windows,
    modelUsage,
    credits: credits && {
      hasCredits: credits.has_credits === true,
      unlimited: credits.unlimited === true,
      ...(typeof credits.balance === 'number' ? { balance: credits.balance } : {}),
    },
    resetCredits,
    capturedAt,
    source: 'https://chatgpt.com/backend-api/wham/usage',
  }
}

const GO_WINDOWS = [
  ['rolling', 300, 'Rolling'],
  ['weekly', 10080, 'Weekly'],
  ['monthly', 43200, 'Monthly'],
]

/**
 * Normalize one OpenCode Go usage payload (percent = used, ISO resetsAt).
 * @param {any} payload - parsed /zen/go/v1/usage body.
 * @param {object} context - accountId-independent context: capturedAt.
 * @returns {any} UsageSnapshot.
 */
export function normalizeOpenCodeGo(payload, { capturedAt } = {}) {
  const raw = payload?.usage ?? {}
  const rateLimited = Object.values(raw).some(w => w?.status === 'rate-limited')
  const windows = GO_WINDOWS.flatMap(([id, windowMinutes, label]) => {
    const w = raw[id]
    if (!w) return []
    if (w.status !== 'ok' && w.status !== 'rate-limited') return [{ id, label, windowMinutes, status: 'window-unavailable' }]
    if (typeof w.percent !== 'number') return []
    const used = Math.max(0, Math.min(100, w.percent))
    return [{
      id,
      label: label + ' window',
      windowMinutes,
      serverStatus: w.status,
      usedPercent: used,
      remainingPercent: Number((100 - used).toFixed(2)),
      ...(typeof w.resetsAt === 'string' ? { resetsAt: w.resetsAt } : {}),
    }]
  })
  const anyData = windows.some(w => w.usedPercent !== undefined)
  return {
    providerId: 'opencode-go',
    accountKey: undefined,
    identity: 'identity-unverified',
    scope: 'subscription',
    status: rateLimited ? 'rate-limited' : anyData ? 'ready' : 'unknown',
    windows,
    capturedAt,
    source: 'https://opencode.ai/zen/go/v1/usage',
  }
}

/** Console BillingStatus uses signed integer microcents: 100,000,000 per USD. */
export function normalizeOpenCodeZen(payload, { capturedAt } = {}) {
  const raw = payload?.availableMicroCents
  let microcents
  if (typeof raw === 'number' && Number.isSafeInteger(raw)) microcents = raw
  else if (typeof raw === 'string' && /^-?\d+$/.test(raw) && Number.isSafeInteger(Number(raw))) microcents = Number(raw)
  const amount = microcents === undefined ? undefined : microcents / 100000000
  return {
    providerId: 'opencode',
    scope: 'balance',
    status: amount === undefined ? 'unknown' : amount <= 0 ? 'exhausted' : 'ready',
    windows: [],
    ...(amount === undefined ? {} : { balance: { amount, currency: 'USD', ...(payload.mode === 'invoiceable' ? { kind: 'credit' } : {}) } }),
    capturedAt,
    source: 'https://opencode.ai/console/api/billing/status',
  }
}
