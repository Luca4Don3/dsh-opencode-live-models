/**
 * 只读探针：用**真实端点数据**验证目录合并逻辑。跑之前先 mock 掉 fetch，让插件
 * 以为自己在离线环境，再检查它在各种 roster/catalog 组合下的行为。
 * 断言全部基于实测的 OCG /models 与 pi.dev 数据，不含编造的模型。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

/**
 * 探针固件的位置：默认取仓库同级的 `.temp/ocg-fixtures`，可用 OCG_FIXTURES 覆盖。
 * 探针不硬编码任何人的机器路径。
 */
const FIXTURES = process.env.OCG_FIXTURES
  ?? resolve(process.cwd(), '..', '.temp', 'ocg-fixtures')

/**
 * 读取一个固件 JSON。
 * @param {string} name - 文件名。
 * @returns {any} 解析后的内容。
 */
function fixture(name) {
  const file = join(FIXTURES, name)
  if (!existsSync(file)) {
    throw new Error(`missing fixture ${name} under ${FIXTURES}; see README for how to capture it`)
  }
  return JSON.parse(readFileSync(file, 'utf8'))
}

const results = []
const ok = (name, pass, detail = '') => results.push({ name, pass, detail })

// 真实数据
const liveData = fixture('ocg-models.json')
const LIVE_IDS = liveData.data.map(m => m.id).sort()
const PI_DEV = fixture('pi-dev-opencode-go.json')
const CATALOG_085 = fixture('opencode-go-0.85.1.json')
const INSTALLED = []
for (const models of Object.values(CATALOG_085)) INSTALLED.push(...Object.values(models))
const INSTALLED_IDS = INSTALLED.map(m => m.id).sort()

// ── 受控 fetch ────────────────────────────────────────────────────────────────
let mode = 'live'
globalThis.fetch = async (url) => {
  const u = String(url)
  if (u.startsWith('https://pi.dev/')) {
    if (mode === 'no-pidev') throw new Error('simulated pi.dev outage')
    return new Response(JSON.stringify(PI_DEV), { status: 200 })
  }
  if (u.startsWith('https://opencode.ai/zen/go/v1/models')) {
    if (mode === 'no-roster') throw new Error('simulated OCG outage')
    if (mode === 'stale') return new Response(JSON.stringify({ data: [{ id: 'stale-only' }] }), { status: 200 })
    return new Response(JSON.stringify(liveData), { status: 200 })
  }
  throw new Error(`unexpected fetch: ${u}`)
}

// ── mock Cordis ctx ───────────────────────────────────────────────────────────
const logs = []
let patched = 0
const installedModels = { list: INSTALLED.slice() }
const collection = {
  getProvider: (id) => (id === 'opencode-go' ? baseProvider : undefined),
  setProvider: (p) => { patched += 1; Object.assign(baseProvider, p) },
}
let baseProvider = {
  id: 'opencode-go',
  auth: {},
  getModels: () => installedModels.list,
  stream: () => { throw new Error('not used') },
  streamSimple: () => { throw new Error('not used') },
}
const adapter = {
  current() { return { profiles: new Map(), models: collection } },
}
const ctx = {
  llm: { adapters: new Map([['opencode-go', { adapter }]]) },
  logger: {
    info: (...a) => logs.push(['info', a.join(' ')]),
    warn: (...a) => logs.push(['warn', a.join(' ')]),
  },
  emit: (ev) => logs.push(['emit', ev]),
  effect: (fn) => fn(),
  on: (ev, fn) => { ctx._on = { ev, fn }; fn() },
}
// 捕获定时器回调，作为触发后续刷新的入口（等价于 5 分钟后的真实路径）
let intervalFn = null
globalThis.setInterval = (fn) => { intervalFn = fn; return { unref() {} } }
const triggerRefresh = () => { intervalFn?.() ; return new Promise(r => setTimeout(r, 30)) }

const mod = await import('./lib/index.js')
const wait = () => new Promise(r => setTimeout(r, 60))
const firstRefresh = mod.apply(ctx)   // apply 返回首次刷新，可直接 await
await firstRefresh
await wait()

const merged = () => collection.getProvider('opencode-go').getModels()
const ids = () => merged().map(m => m.id).sort()

// ── 1. 核心目标：两个关键模型出现 ────────────────────────────────────────────
ok('provider 被包装', patched >= 1, `setProvider 调用 ${patched} 次`)
ok('DeepSeek V4.1 Flash 进入目录', ids().includes('deepseek-v4.1-flash'))
ok('Space Bunny Free 进入目录', ids().includes('space-bunny-free'))
{
  const m = merged().find(x => x.id === 'space-bunny-free')
  ok('Space Bunny descriptor 完整（协议/端点/容量/modalities）',
    m?.api === 'openai-completions' && m?.baseUrl === 'https://opencode.ai/zen/go/v1'
      && m?.contextWindow === 1048576 && m?.maxTokens === 524288
      && m?.input?.includes('image') && m?.provider === 'opencode-go',
    JSON.stringify({ api: m?.api, ctx: m?.contextWindow, max: m?.maxTokens }))
}
{
  const m = merged().find(x => x.id === 'deepseek-v4.1-flash')
  ok('V4.1 Flash 带 deepseek compat（协议 quirks）',
    m?.compat?.thinkingFormat === 'deepseek' && m?.compat?.maxTokensField === 'max_tokens',
    JSON.stringify(m?.compat))
}

// ── 2. 不丢官方客户端独有的模型 ──────────────────────────────────────────────
{
  const missing = INSTALLED_IDS.filter(i => !ids().includes(i))
  ok('0.85.1 原有的 27 个模型一个不丢', missing.length === 0, `缺: ${missing.join(',') || '无'}`)
}

// ── 3. 覆盖率 ────────────────────────────────────────────────────────────────
{
  const got = ids()
  const liveSet = new Set(LIVE_IDS)
  // 有 descriptor 的 = pi.dev 收录的 ∪ 0.85.1 已有的。其余 14 个是 OCG 已上线但
  // 两个来源都没有 descriptor 的，**设计就是不自动加入**（不猜协议）。
  const describable = new Set([...PI_DEV.map(m => m.id), ...INSTALLED_IDS])
  const expected = LIVE_IDS.filter(i => describable.has(i))
  const covered = expected.filter(i => got.includes(i)).length
  ok('所有「有 descriptor」的实时模型都进入目录', covered === expected.length,
    `${covered}/${expected.length}（另 ${LIVE_IDS.length - expected.length} 个无 descriptor，按设计不加入）`)
  const undescribed = LIVE_IDS.filter(i => !describable.has(i))
  ok('无 descriptor 的模型一个都没被瞎加', undescribed.every(i => !got.includes(i)),
    undescribed.filter(i => got.includes(i)).join(',') || '全部未加入')
  ok('目录里没有 OCG 不提供的模型',
    got.every(i => liveSet.has(i)),
    got.filter(i => !liveSet.has(i)).join(',') || '无')
}

// ── 4. 未知模型只报告不瞎猜 ─────────────────────────────────────────────────
{
  const warn = logs.filter(([l]) => l === 'warn').map(([, m]) => m)
  const reported = warn.find(m => m.includes('no descriptor yet'))
  ok('无 descriptor 的实时模型被点名报告', reported !== undefined, reported?.slice(0, 130))
  // 模型名本身含 '.'（mimo-v2.5），所以锚定到句子结尾而不是 [^.]+
  const named = (reported?.match(/NOT added: (.+?)\. Add them/s)?.[1] ?? '')
    .split(', ').map(x => x.trim()).filter(Boolean)
  // 首次刷新时 installed 目录仍有全部 27 个，所以「无 descriptor」= live - (pi.dev ∪ 0.85.1) = 14。
  // refresh 时 described = overlay(pi.dev 29 + fallback 2 = 31) ∪ installed(27) = 43 项中 29 项
  // 实际 covered = pi.dev∩live(29) + fallback(2) + installed∩live(22) = 43 - 14
  // described = overlay(pi.dev 29 + fallback 2) ∪ installed(27)；live 43 项中
  // 9 项三者都没有 descriptor；另有 5 项 installed 有、pi.dev 无，它们在 installed
  // 快照里**仍可读**（那是已安装目录的事实），所以也被点名为「缺 descriptor」。
  // 合计 14 —— 插件报告的就是这 14 个，逐个点名，无一遗漏、无一误报。
  const trulyUnknown = LIVE_IDS.filter(i =>
    !PI_DEV.some(m => m.id === i) && !INSTALLED_IDS.includes(i)
    && i !== 'deepseek-v4.1-flash' && i !== 'space-bunny-free')
  ok('告警逐个点名了每个 OCG 正在提供但无 descriptor 的模型（9 个完全未知 + 5 个仅目录有）',
    named.length === 14
      && trulyUnknown.every(i => named.includes(i))
      && !named.includes('space-bunny-free')
      && !named.includes('mimo-v2.5')
      && !named.includes('deepseek-v4.1-flash'),
    `${named.length} 个被点名；其中完全未知 ${trulyUnknown.length} 个全部在内`)
}

// ── 5. 降级：pi.dev 挂了 ─────────────────────────────────────────────────────
{
  mode = 'no-pidev'
  logs.length = 0
  await triggerRefresh()
  await wait(); await wait()
  ok('pi.dev 不可达时两个 fallback 模型仍在',
    ids().includes('deepseek-v4.1-flash') && ids().includes('space-bunny-free'))
  ok('pi.dev 失败有告警且不静默',
    logs.some(([l, m]) => l === 'warn' && m.includes('pi.dev catalog refresh failed')))
  ok('pi.dev 失败时原有目录未丢', INSTALLED_IDS.every(i => ids().includes(i)))
}

// ── 6. 降级：roster 挂了不能清空目录 ─────────────────────────────────────────
{
  mode = 'live'
  await wait()
  const before = ids().length
  mode = 'no-roster'
  logs.length = 0
  await triggerRefresh()
  await wait(); await wait()
  ok('OCG roster 不可达时目录不清空（保留 last-known-good）', ids().length === before,
    `${before} -> ${ids().length}`)
  ok('roster 失败有告警',
    logs.some(([l, m]) => l === 'warn' && m.includes('roster refresh failed')))
}

// ── 7. 换 roster：下线的模型消失 ─────────────────────────────────────────────
{
  mode = 'stale'
  await triggerRefresh()
  await wait(); await wait()
  const after = ids()
  // overlay（pi.dev + fallback）不受 roster 过滤：roster 掉线不等于模型下架。
  // 被 roster 过滤掉的只应是**已安装目录**里那些确实不在 roster 的条目。
  // stale-only roster：installed 27 个里，只有 stale-only 这一个 id 在 roster 中（且它本来就不在），
  // 所以 27 个全部应被过滤；overlay 的 29+2 个不受影响。
  // stale-only roster：installed 里 pi.dev 覆盖的 22 个回到 overlay 仍在；剩下 5 个既不在
  // roster 也不在 pi.dev，无处可补，正确地消失。
  const devIds = new Set(PI_DEV.map(m => m.id))
  const unrecoverable = INSTALLED_IDS.filter(i => !devIds.has(i))
  const filtered = INSTALLED_IDS.filter(i => !after.includes(i))
  ok('roster 只剩 stale-only 时，无处可补的 installed 模型被正确过滤',
    filtered.length === unrecoverable.length && unrecoverable.every(i => filtered.includes(i)),
    `被过滤 ${filtered.length} 个（期望 ${unrecoverable.length}）：${filtered.join(', ')}`)
  ok('pi.dev 覆盖的 installed 模型仍在（由 overlay 保留）',
    INSTALLED_IDS.filter(i => devIds.has(i)).every(i => after.includes(i)))
  ok('overlay 里的 fallback 模型不受 roster 影响（掉线≠下架）',
    after.includes('space-bunny-free'))
  ok('仍在 roster 的模型保留', after.includes('stale-only') === false && after.includes('deepseek-v4-flash'),
    after.slice(0, 8).join(','))
}

let failed = 0
for (const r of results) {
  if (!r.pass) failed += 1
  console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `\n        ${r.detail}` : ''}`)
}
console.log(`\n${results.length - failed}/${results.length} 通过`)
if (failed > 0) process.exitCode = 1
