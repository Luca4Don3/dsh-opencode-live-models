/**
 * 只读探针：用**真实端点数据**验证目录合并逻辑。跑之前先 mock 掉 fetch，让插件
 * 以为自己在离线环境，再检查它在各种 roster/catalog 组合下的行为。
 * 断言全部基于实测的 OCG /models 与 pi.dev 数据，不含编造的模型。
 *
 * 固件随仓库一起提交（test/fixtures/），所以新克隆后 `npm test` 即可运行，
 * 不需要先联网。刷新固件见 README 的 Probe 一节。
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 探针固件的位置：默认取仓库内的 `test/fixtures`，可用 OCG_FIXTURES 指向别处。
 * 相对本文件定位，因此从任何工作目录运行都成立。
 */
const FIXTURES = process.env.OCG_FIXTURES
  ?? resolve(dirname(fileURLToPath(import.meta.url)), 'test', 'fixtures')

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

/**
 * The plugin keeps its mutable state on `globalThis` so a wrapper installed
 * before a hot reload keeps working afterwards. Each scenario here is meant to
 * be an independent cold start, so it has to clear that slot first — otherwise
 * the second scenario inherits the first one's published catalog, pending
 * confirmations and "already warned" field names, and every assertion about a
 * first publish quietly becomes an assertion about a second one.
 *
 * The hot-reload scenario deliberately does *not* call this: sharing the slot is
 * the behaviour under test there.
 */
const STATE_KEY = Symbol.for('dsh-opencode-live-models.state')
function freshState() {
  delete globalThis[STATE_KEY]
}

// 真实数据
const liveData = fixture('ocg-models.json')
const OCG_LIVE = liveData.data
const LIVE_IDS = OCG_LIVE.map(m => m.id).sort()
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
  // The real pi-ai Models collection has this; without it every read that goes
  // through the collection silently yields [] and the drift report undercounts
  // itself — which is exactly how a broken lookup hid behind a green probe.
  getModels: (id) => (id === 'opencode-go' ? baseProvider.getModels() : []),
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
    debug: (...a) => logs.push(['debug', a.join(' ')]),
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

/**
 * Mount a plugin instance and let its background first refresh settle.
 *
 * `apply()` no longer returns the refresh — it publishes the installed catalog
 * immediately and refreshes behind that, because mounting must not block on the
 * network. Tests therefore wait for the effect rather than for the call.
 * @param {any} plugin - the imported module.
 * @param {any} mountCtx - the context to mount with.
 * @param {number} [ticks] - how many event-loop turns to allow.
 * @returns {Promise<void>} resolves once the background refresh has settled.
 */
async function mount(plugin, mountCtx, ticks = 5) {
  plugin.apply(mountCtx)
  for (let i = 0; i < ticks; i += 1) await wait()
}

await mount(mod, ctx)

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

// ── 3.5 顺序：主序 + 锚定插入，而不是两段拼接 ──────────────────────────────
{
  const order = merged().map(m => m.id)
  const devIds = PI_DEV.map(m => m.id)
  const devSet = new Set(devIds)

  // (a) Pi 目录里被收录的模型，相对次序与 Pi 发布的一致
  const onSpine = order.filter(id => devSet.has(id))
  const expectedSpine = devIds.filter(id => order.includes(id))
  ok('Pi 目录收录的模型保持 Pi 发布的相对次序', JSON.stringify(onSpine) === JSON.stringify(expectedSpine),
    onSpine.length === expectedSpine.length ? `${onSpine.length} 个主序成员全部保序` : `${onSpine.length} vs ${expectedSpine.length}`)

  // (b) 新模型不再被追加成末尾一整块
  const lastSpine = order.lastIndexOf(order.filter(id => devSet.has(id)).at(-1))
  ok('新模型不再堆在末尾（主序末位之后至多 1 个）', order.length - lastSpine - 1 <= 1,
    `末尾残留 ${order.length - lastSpine - 1} 个：${order.slice(lastSpine + 1).join(', ') || '无'}`)

  // (c) 仅 installed 独有的模型，插在它后继主序模型之前 —— 家族因此连续
  const installedOrder = INSTALLED.map(m => m.id)
  const inserted = order.filter(id => !devSet.has(id) && installedOrder.includes(id))
  const anchored = inserted.every(id => {
    const at = order.indexOf(id)
    const successor = installedOrder.slice(installedOrder.indexOf(id) + 1)
      .find(i => devSet.has(i) && order.includes(i))
    // Several insertions can share one anchor and land as a block in front of
    // it, so skip the siblings before looking for the anchor itself.
    let next = at + 1
    while (next < order.length && !devSet.has(order[next])) next += 1
    if (successor !== undefined) return order[next] === successor
    return next >= order.length
  })
  ok('仅 installed 独有的模型紧贴其后继主序模型（家族不被打散）', anchored,
    inserted.map(id => `${id}→${order[order.indexOf(id) + 1] ?? '(末尾)'}`).join(', '))

  // (d) 同厂商模型在最终列表中连续
  const families = [...new Set(order.map(id => id.match(/^[a-z]+/)[0]))]
  const split = families.filter(f => {
    const at = order.map((id, i) => (id.startsWith(f) ? i : -1)).filter(i => i >= 0)
    return at.length > 1 && at.at(-1) - at[0] !== at.length - 1
  })
  ok('同厂商模型在列表中连续', split.length === 0,
    split.length === 0 ? '无被打散的厂商' : `被打散：${split.join(', ')}`)
}

// ── 4. 未知模型只报告不瞎猜 ─────────────────────────────────────────────────
{
  const warn = logs.filter(([l]) => l === 'warn').map(([, m]) => m)
  const reported = warn.find(m => m.includes('no descriptor yet'))
  ok('无 descriptor 的实时模型被点名报告', reported !== undefined, reported?.slice(0, 130))
  // 模型名本身含 '.'（mimo-v2.5），所以锚定到句子结尾而不是 [^.]+
  const named = (reported?.match(/NOT added: (.+?)\. Add them/s)?.[1] ?? '')
    .split(', ').map(x => x.trim()).filter(Boolean)
  // 「无 descriptor」= live - effective，即网关在服务、但两个来源都给不出描述符的模型。
  // 这必须是 9 个：另 5 个（glm-5.1、kimi-k2.6、omen-alpha、qwen3.6-plus、qwen3.7-max）
  // 已安装目录里就有，属于**可用**模型，被点名就是漂移报告在说谎。
  const trulyUnknown = LIVE_IDS.filter(i =>
    !PI_DEV.some(m => m.id === i) && !INSTALLED_IDS.includes(i)
    && i !== 'deepseek-v4.1-flash' && i !== 'space-bunny-free')
  const onlyInstalled = INSTALLED_IDS.filter(i => !PI_DEV.some(m => m.id === i))
  ok('告警逐个点名了每个无 descriptor 的模型，且不误报已安装目录已有的模型',
    named.length === trulyUnknown.length
      && trulyUnknown.every(i => named.includes(i))
      && !onlyInstalled.some(i => named.includes(i))
      && !named.includes('space-bunny-free')
      && !named.includes('mimo-v2.5')
      && !named.includes('deepseek-v4.1-flash'),
    `点名 ${named.length} 个 = 完全未知 ${trulyUnknown.length} 个；误报 ${named.filter(i => onlyInstalled.includes(i)).join(',') || '无'}`)
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

// ── 6.5 fingerprint：数据没变就不该惊动 DSH ────────────────────────────────
{
  mode = 'live'
  await triggerRefresh()
  await wait(); await wait()
  const emitted = logs.filter(([l]) => l === 'emit').length
  ok('两份上游都返回同一份数据时不 emit adapters-updated', emitted === 0,
    `emit ${emitted} 次`)
  ok('无变化走 debug 而不是 info（日志不再每 5 分钟刷屏）',
    logs.some(([l, m]) => l === 'debug' && m.includes('catalog unchanged')))
}

// ── 6.6 fingerprint 不得漏掉 UI 可见的字段 ──────────────────────────────────
{
  // Price and display name are rendered in the picker, so a remote edit to either
  // that fails to reach the consumer is a stale-UI bug, not a missed optimization.
  const mainFetch = globalThis.fetch
  let reprice = false
  let addOutput = false
  globalThis.fetch = async (url) => {
    const u = String(url)
    if (u.startsWith('https://pi.dev/')) {
      const rows = JSON.parse(JSON.stringify(PI_DEV))
      const target = rows.find(m => m.id === 'space-bunny-free')
      if (reprice) {
        target.cost = { ...target.cost, input: 0.5, output: 1.5 }
        target.name = 'Space Bunny Free (repriced)'
      }
      if (addOutput) {
        // A field this plugin has never heard of, on a model it does know: it is
        // forwarded, so a change to it has to be announced too.
        target.output = ['text', 'image']
      }
      return new Response(JSON.stringify(rows), { status: 200 })
    }
    if (u.startsWith('https://opencode.ai/zen/go/v1/models')) {
      return new Response(JSON.stringify({ data: OCG_LIVE.map(m => ({ id: m.id })) }), { status: 200 })
    }
    throw new Error(`unexpected fetch: ${u}`)
  }
  let base = {
    id: 'opencode-go',
    getModels: () => INSTALLED.slice(),
    stream: () => {}, streamSimple: () => {},
  }
  const coll = {
    getProvider: id => (id === 'opencode-go' ? base : undefined),
    setProvider: p => { Object.assign(base, p) },
    getModels: id => (id === 'opencode-go' ? base.getModels() : []),
  }
  let tick = null
  globalThis.setInterval = fn => { tick = fn; return { unref() {} } }
  const pLogs = []
  const pCtx = {
    llm: { adapters: new Map([['opencode-go', { adapter: { current: () => ({ models: coll }) } }]]) },
    logger: {
      info: (...a) => pLogs.push(['info', a.join(' ')]),
      warn: (...a) => pLogs.push(['warn', a.join(' ')]),
      debug: (...a) => pLogs.push(['debug', a.join(' ')]),
    },
    emit: ev => pLogs.push(['emit', ev]), effect: fn => fn(), on: () => {},
  }
freshState()
  const priced = await import('./lib/index.js?repriced')
  await mount(priced, pCtx)
  const emittedAfterBoot = pLogs.filter(([l]) => l === 'emit').length

  tick?.(); await wait()
  const sameData = pLogs.filter(([l]) => l === 'emit').length
  reprice = true
  tick?.(); await wait()
  const afterPriceChange = pLogs.filter(([l]) => l === 'emit').length
  addOutput = true
  tick?.(); await wait()
  const afterUnknownField = pLogs.filter(([l]) => l === 'emit').length

  // Mounting publishes twice: once immediately from the installed catalog plus the
  // bundled fallbacks, once when the background refresh lands. Both are real
  // changes in what DSH can see, which is the point of publishing at mount.
  ok('挂载即发布 + 刷新后再发布，共两次', emittedAfterBoot === 2, `${emittedAfterBoot} 次`)
  ok('数据未变不 emit', sameData === 2, `${sameData} 次`)
  ok('远端改 price / display name 会 emit', afterPriceChange === 3, `${afterPriceChange} 次`)
  ok('远端新增未知字段会 emit（透传的字段变化同样要抵达 consumer）',
    afterUnknownField === 4, `${afterUnknownField} 次`)
  globalThis.fetch = mainFetch
}

// ── 6.7 顺序本身就是目录信息，纯重排也必须 emit ────────────────────────────
{
  // orderModels() spends real effort putting the picker in Pi's published order,
  // so a reordering upstream is a change DSH can see. Sorting the models by id
  // inside the fingerprint would flatten exactly that back into a no-op.
  const mainFetch = globalThis.fetch
  let reorder = false
  globalThis.fetch = async (url) => {
    const u = String(url)
    if (u.startsWith('https://pi.dev/')) {
      const rows = JSON.parse(JSON.stringify(PI_DEV))
      // Same descriptors, same ids, same values — published in a different order.
      if (reorder) rows.reverse()
      return new Response(JSON.stringify(rows), { status: 200 })
    }
    if (u.startsWith('https://opencode.ai/zen/go/v1/models')) {
      return new Response(JSON.stringify({ data: OCG_LIVE.map(m => ({ id: m.id })) }), { status: 200 })
    }
    throw new Error(`unexpected fetch: ${u}`)
  }
  let base = {
    id: 'opencode-go',
    getModels: () => INSTALLED.slice(),
    stream: () => {}, streamSimple: () => {},
  }
  const coll = {
    getProvider: id => (id === 'opencode-go' ? base : undefined),
    setProvider: p => { Object.assign(base, p) },
    getModels: id => (id === 'opencode-go' ? base.getModels() : []),
  }
  let tick = null
  globalThis.setInterval = fn => { tick = fn; return { unref() {} } }
  const oLogs = []
  const oCtx = {
    llm: { adapters: new Map([['opencode-go', { adapter: { current: () => ({ models: coll }) } }]]) },
    logger: {
      info: (...a) => oLogs.push(['info', a.join(' ')]),
      warn: (...a) => oLogs.push(['warn', a.join(' ')]),
      debug: (...a) => oLogs.push(['debug', a.join(' ')]),
    },
    emit: ev => oLogs.push(['emit', ev]), effect: fn => fn(), on: () => {},
  }
freshState()
  const ordered = await import('./lib/index.js?reordered')
  await mount(ordered, oCtx)
  const boot = oLogs.filter(([l]) => l === 'emit').length
  const orderBefore = base.getModels().map(m => m.id).join(',')
  const bootDescriptors = base.getModels().map(m => ({ ...m }))

  tick?.(); await wait()
  const unchanged = oLogs.filter(([l]) => l === 'emit').length
  reorder = true
  tick?.(); await wait()
  const afterReorder = oLogs.filter(([l]) => l === 'emit').length
  const orderAfter = base.getModels().map(m => m.id).join(',')

  ok('目录顺序真的变了', orderBefore !== orderAfter,
    `${orderBefore.split(',').slice(0, 3)} -> ${orderAfter.split(',').slice(0, 3)} …`)
  // Compare the descriptors DSH actually holds across the two polls, rather
  // than a fixture against a copy of itself, which is true by construction and
  // would stay green no matter what the code under test did.
  const descriptorsBefore = new Map(bootDescriptors.map(m => [m.id, JSON.stringify(m)]))
  const descriptorsAfter = new Map(base.getModels().map(m => [m.id, JSON.stringify(m)]))
  const changedDescriptors = [...descriptorsAfter]
    .filter(([id, json]) => descriptorsBefore.get(id) !== json)
    .map(([id]) => id)
  ok('descriptor 集合与内容都没变，只有顺序变了',
    descriptorsBefore.size === descriptorsAfter.size && changedDescriptors.length === 0,
    `${descriptorsAfter.size} 个模型，其中内容变化 ${changedDescriptors.length} 个`)
  ok('挂载发布 + 刷新发布，共两次', boot === 2, `${boot} 次`)
  ok('顺序未变时不 emit', unchanged === 2, `${unchanged} 次`)
  ok('仅顺序变化也 emit（fingerprint 不得按 id 排序抹平目录顺序）',
    afterReorder === 3, `${afterReorder} 次`)
  globalThis.fetch = mainFetch
}

// ── 6.8 挂载不阻塞：网络返回前目录已就绪 ───────────────────────────────────
{
  const mainFetch = globalThis.fetch
  let release
  const gate = new Promise(r => { release = r })
  let catalogFetches = 0
  globalThis.fetch = async (url) => {
    const u = String(url)
    if (u.startsWith('https://pi.dev/')) {
      catalogFetches += 1
      await gate                       // the network is the slow part
      return new Response(JSON.stringify(PI_DEV), { status: 200 })
    }
    if (u.startsWith('https://opencode.ai/zen/go/v1/models')) {
      return new Response(JSON.stringify({ data: LIVE_IDS.map(id => ({ id })) }), { status: 200 })
    }
    throw new Error(`unexpected fetch: ${u}`)
  }
  const base = {
    id: 'opencode-go',
    getModels: () => INSTALLED.slice(),
    stream: () => {}, streamSimple: () => {},
  }
  let current = base
  const coll = {
    getProvider: id => (id === 'opencode-go' ? current : undefined),
    setProvider: p => { current = p },
    getModels: id => (id === 'opencode-go' ? current.getModels() : []),
  }
  const adapters = new Map([['opencode-go', { adapter: { current: () => ({ models: coll }) } }]])
  let tick = null
  globalThis.setInterval = fn => { tick = fn; return { unref() {} } }
  const events = []
  freshState()
  const mod = await import('./lib/index.js?no-block')
  mod.apply({
    llm: { adapters },
    logger: { info: () => {}, warn: () => {}, debug: () => {} },
    emit: ev => events.push(ev),
    effect: fn => { fn() },
    on: () => {},
  })
  // Deliberately no wait: the network has not answered and never will inside
  // this tick. Whatever the picker can show must already be published.
  const immediate = coll.getModels('opencode-go').map(m => m.id)
  const emittedNow = events.length

  release()
  await wait(); await wait(); await wait()
  const settled = coll.getModels('opencode-go').map(m => m.id)

  ok('挂载在网络返回前就已发布（不阻塞 DSH）', emittedNow >= 1 && immediate.length > INSTALLED.length,
    `网络未返回时已发布 ${immediate.length} 个，emit ${emittedNow} 次`)
  ok('此时目录是 installed + fallback，缺少远端模型属正常',
    immediate.includes('space-bunny-free') && immediate.length < settled.length,
    `挂载时 ${immediate.length} → 刷新后 ${settled.length}`)
  ok('网络返回后目录补全并再次发布', settled.length > immediate.length && events.length > emittedNow,
    `${settled.length} 个，emit 共 ${events.length} 次`)
  ok('取数确实发生过（挂载只是不等它）', catalogFetches >= 1, `${catalogFetches} 次`)
  globalThis.fetch = mainFetch
}

// ── 6.9 ETag 条件请求 ───────────────────────────────────────────────────────
{
  const mainFetch = globalThis.fetch
  const ETAG = '"v1-fixture"'
  let poll = 0
  const seen = []
  let rosterCond = 'not-called'
  globalThis.fetch = async (url, init) => {
    const u = String(url)
    if (u.startsWith('https://pi.dev/')) {
      const cond = init?.headers?.['if-none-match'] ?? null
      seen.push(cond)
      // Second poll: the server would answer 304 for the ETag it handed out.
      if (cond === ETAG) return new Response(null, { status: 304, headers: { etag: ETAG } })
      return new Response(JSON.stringify(PI_DEV), { status: 200, headers: { etag: ETAG } })
    }
    if (u.startsWith('https://opencode.ai/zen/go/v1/models')) {
      rosterCond = init?.headers?.['if-none-match'] ?? null
      return new Response(JSON.stringify({ data: LIVE_IDS.map(id => ({ id })) }), { status: 200 })
    }
    throw new Error(`unexpected fetch: ${u}`)
  }
  const base = {
    id: 'opencode-go',
    getModels: () => INSTALLED.slice(),
    stream: () => {}, streamSimple: () => {},
  }
  let current = base
  const coll = {
    getProvider: id => (id === 'opencode-go' ? current : undefined),
    setProvider: p => { current = p },
    getModels: id => (id === 'opencode-go' ? current.getModels() : []),
  }
  const adapters = new Map([['opencode-go', { adapter: { current: () => ({ models: coll }) } }]])
  let tick = null
  globalThis.setInterval = fn => { tick = fn; return { unref() {} } }
  const logs = []
  const events = []
  freshState()
  const mod = await import('./lib/index.js?etag')
  await mount(mod, {
    llm: { adapters },
    logger: {
      info: () => {},
      warn: (...a) => logs.push(['warn', a.join(' ')]),
      debug: (...a) => logs.push(['debug', a.join(' ')]),
    },
    emit: ev => events.push(ev),
    effect: fn => { fn() },
    on: () => {},
  })
  const afterFirst = coll.getModels('opencode-go').map(m => m.id)
  poll = 1
  tick?.(); await wait(); await wait(); await wait()
  const afterSecond = coll.getModels('opencode-go').map(m => m.id)

  ok('首次请求不带条件头（还没有 ETag）', seen[0] === null, `${seen[0]}`)
  ok('第二次请求带上 If-None-Match', seen[1] === ETAG, `${seen[1]}`)
  // The cache-write warning is excluded: the probe runs in a sandbox where
  // ~/.dsh is not writable, so it fires for environmental reasons and says
  // nothing about how 304 is handled.
  const relevantWarn = (m) => !m.includes('have no descriptor yet') && !m.includes('could not persist')
  ok('304 不被当作失败，也不重新发布',
    afterSecond.length === afterFirst.length && !logs.some(([l, m]) => l === 'warn' && relevantWarn(m)),
    `${afterFirst.length} → ${afterSecond.length}；warn: ${logs.map(([, m]) => m.slice(0, 70)).join(' | ') || '无'}`)
  ok('304 被记录下来', logs.some(([, m]) => m.includes('304')), logs.find(([, m]) => m.includes('304')) ?? '无')
  ok('roster 不发条件头（网关没有 ETag 可用）', rosterCond === null, `${rosterCond}`)
  globalThis.fetch = mainFetch
}

// ── 6.10 持久化 last-known-good：重启后离线也能用上一轮目录 ──────────────────
{
  const mainFetch = globalThis.fetch
  const { mkdtemp, readFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = await mkdtemp(join(tmpdir(), 'ocg-probe-'))
  // CACHE_DIR is read when the module evaluates, so this has to be in place
  // before the instance below is imported — which is exactly what a real DSH
  // start looks like.
  const prevDir = process.env.DSH_PROFILE_DIR
  process.env.DSH_PROFILE_DIR = dir

  let online = true
  globalThis.fetch = async (url) => {
    const u = String(url)
    if (!online) throw new Error('simulated outage')
    if (u.startsWith('https://pi.dev/')) return new Response(JSON.stringify(PI_DEV), { status: 200 })
    if (u.startsWith('https://opencode.ai/zen/go/v1/models')) {
      return new Response(JSON.stringify({ data: LIVE_IDS.map(id => ({ id })) }), { status: 200 })
    }
    throw new Error(`unexpected fetch: ${u}`)
  }

  const runOnce = async (label) => {
    const base = {
      id: 'opencode-go',
      getModels: () => INSTALLED.slice(),
      stream: () => {}, streamSimple: () => {},
    }
    let current = base
    const coll = {
      getProvider: id => (id === 'opencode-go' ? current : undefined),
      setProvider: p => { current = p },
      getModels: id => (id === 'opencode-go' ? current.getModels() : []),
    }
    const adapters = new Map([['opencode-go', { adapter: { current: () => ({ models: coll }) } }]])
    let tick = null
    globalThis.setInterval = fn => { tick = fn; return { unref() {} } }
    freshState()
    const mod = await import(`./lib/index.js?persist-${label}`)
    await mount(mod, {
      llm: { adapters },
      logger: { info: () => {}, warn: () => {}, debug: () => {} },
      emit: () => {}, effect: fn => { fn() }, on: () => {},
    })
    return coll.getModels('opencode-go').map(m => m.id)
  }

  const first = await runOnce('online')
  let written = null
  try {
    written = JSON.parse(await readFile(join(dir, 'opencode-live-models-catalog.json'), 'utf8'))
  } catch { /* asserted below */ }
  ok('接受后的目录被写入缓存文件', written !== null && Array.isArray(written.models) && written.models.length > 0,
    written ? `${written.models.length} 条` : '文件不存在')
  ok('缓存只保存 sanitized 之后的描述符（无可劫持的 baseUrl）',
    Array.isArray(written?.models)
      && written.models.every(m => typeof m.baseUrl === 'string' && m.baseUrl.startsWith('https://opencode.ai/'))
      && written.models.every(m => m.headers === undefined),
    written ? `baseUrl 样本 ${written.models[0]?.baseUrl}` : '—')

  // A restart with the network down: the last known good catalog is all there is.
  online = false
  const offline = await runOnce('offline')
  ok('重启后断网仍能恢复上一轮的完整目录', offline.length === first.length && offline.length > INSTALLED.length,
    `在线 ${first.length} → 离线重启 ${offline.length}`)
  ok('离线时用上的是缓存，不是只剩 fallback',
    offline.includes('deepseek-v4.1-flash') && offline.length > INSTALLED.length,
    `${offline.length} 个（含 fallback）`)

  // A tampered cache must not survive the same validation a live response gets.
  try {
    const { writeFile } = await import('node:fs/promises')
    const hostile = { version: 1, savedAt: Date.now(), models: [{ id: 'cached-evil', api: 'constructor' }] }
    await writeFile(join(dir, 'opencode-live-models-catalog.json'), JSON.stringify(hostile), 'utf8')
  } catch { /* asserted below */ }
  const tampered = await runOnce('tampered')
  const tamperedModels = await runOnce('tampered')
  ok('缓存文件被篡改时按同样规则拒绝（api=constructor 不通过）',
    !tamperedModels.includes('cached-evil'), tamperedModels.includes('cached-evil') ? '★被放行' : '已忽略')

  // A cache that lost its capacities must be rejected whole, not partly kept.
  const { writeFile } = await import('node:fs/promises')
  const gutted = {
    version: 1,
    savedAt: Date.now(),
    models: PI_DEV.map(m => ({ id: m.id, api: m.api, name: m.name, input: m.input })),
  }
  await writeFile(join(dir, 'opencode-live-models-catalog.json'), JSON.stringify(gutted), 'utf8')
  const guttedRun = await runOnce('gutted')
  ok('缓存缺少 contextWindow/maxTokens/cost 时整份拒绝（与在线同一标准）',
    // installed plus the two bundled fallbacks — nothing from the gutted file.
    guttedRun.length === INSTALLED.length + 2,
    `缓存被掏空后目录 ${guttedRun.length}（installed ${INSTALLED.length} + fallback 2），未采纳任何残缺条目`)

  // 延迟注册路径采纳的目录也必须落盘并记住 ETag
  {
    const { readFile: rf } = await import('node:fs/promises')
    online = true
    let hits = 0
    const withEtag = async (url) => {
      const u = String(url)
      if (u.startsWith('https://pi.dev/')) {
        hits += 1
        return new Response(JSON.stringify(PI_DEV), { status: 200, headers: { etag: '"deferred-etag"' } })
      }
      if (u.startsWith('https://opencode.ai/zen/go/v1/models')) {
        return new Response(JSON.stringify({ data: LIVE_IDS.map(id => ({ id })) }), { status: 200 })
      }
      throw new Error(`unexpected fetch: ${u}`)
    }
    const adapters = new Map()
    let onEvt = null
    // A collection for the adapter to hang off: without a registered adapter the
    // deferred feed has no baseline to judge against and is correctly left
    // alone, which is what the late-registration guard is for.
    const lateBase = {
      id: 'opencode-go',
      getModels: () => INSTALLED.slice(),
      stream: () => {}, streamSimple: () => {},
    }
    let lateCurrent = lateBase
    const coll = {
      getProvider: id => (id === 'opencode-go' ? lateCurrent : undefined),
      setProvider: p => { lateCurrent = p },
      getModels: id => (id === 'opencode-go' ? lateCurrent.getModels() : []),
    }
    globalThis.fetch = withEtag
    freshState()
    const deferred = await import('./lib/index.js?deferred-cache')
    await mount(deferred, {
      llm: { adapters },
      logger: { info: () => {}, warn: () => {}, debug: () => {} },
      emit: () => {},
      effect: fn => { fn() },
      on: (ev, fn) => { if (ev === 'llm/adapters-updated') onEvt = fn },
    })
    // The adapter registers after the first refresh, so the catalog is adopted
    // by the deferred path rather than by a later poll.
    adapters.set('opencode-go', { adapter: { current: () => ({ models: coll }) } })
    onEvt?.()
    await wait(); await wait(); await wait()

    // The write is queued behind any earlier one, so poll for it rather than
    // assume a fixed number of ticks is enough.
    let saved = null
    for (let i = 0; i < 30; i += 1) {
      try {
        const parsed = JSON.parse(await rf(join(dir, 'opencode-live-models-catalog.json'), 'utf8'))
        if (parsed?.etag) { saved = parsed; break }
      } catch { /* not written yet */ }
      await wait()
    }
    ok('延迟采纳的目录同样落盘（此前这条路径漏掉了）',
      saved !== null && Array.isArray(saved.models) && saved.models.length > 0,
      saved ? `${saved.models.length} 条` : '文件不存在')
    ok('延迟采纳的目录同样记住 ETag', saved?.etag === '"deferred-etag"', `${saved?.etag}`)
  }

  globalThis.fetch = mainFetch
  if (prevDir === undefined) delete process.env.DSH_PROFILE_DIR
  else process.env.DSH_PROFILE_DIR = prevDir
  await rm(dir, { recursive: true, force: true })
}

// ── 7. roster 熔断：异常缩水要两轮才承认 ───────────────────────────────────
{
  // 'stale' is a one-id roster. Applying the previous behavior, that silently
  // deleted every installed-only model; now it must be believed only once it
  // repeats.
  mode = 'stale'
  const before = ids()
  logs.length = 0
  await triggerRefresh()
  await wait(); await wait()
  ok('异常缩水的 roster 第一次出现被挡下，目录不变', ids().join() === before.join(),
    `${before.length} -> ${ids().length}`)
  ok('挡下时有明确告警', logs.some(([l, m]) => l === 'warn' && m.includes('suspicious shrink')))

  await triggerRefresh()
  await wait(); await wait()
  const after = ids()
  const devIds = new Set(PI_DEV.map(m => m.id))
  const unrecoverable = INSTALLED_IDS.filter(i => !devIds.has(i))
  const filtered = INSTALLED_IDS.filter(i => !after.includes(i))
  ok('同样的缩水第二次出现才被接受', filtered.length === unrecoverable.length,
    `被过滤 ${filtered.length} 个（期望 ${unrecoverable.length}）`)
  ok('pi.dev 覆盖的 installed 模型仍在（由 overlay 保留）',
    INSTALLED_IDS.filter(i => devIds.has(i)).every(i => after.includes(i)))
  ok('overlay 里的 fallback 模型不受 roster 影响（掉线≠下架）',
    after.includes('space-bunny-free') && after.includes('deepseek-v4.1-flash'))
  ok('目录真的变了才 emit adapters-updated', logs.filter(([l]) => l === 'emit').length > 0,
    `emit ${logs.filter(([l]) => l === 'emit').length} 次`)
  ok('变化以 added/removed 形式记录', logs.some(([l, m]) => l === 'info' && m.includes('catalog updated:')),
    logs.filter(([l, m]) => l === 'info' && m.includes('removed:')).map(([, m]) => m)[0]?.slice(0, 100) ?? '')
}

// ── 7.5 roster 状态机：空集 / 缩水 / 确认 / 恢复 ─────────────────────────────
{
  const mainFetch = globalThis.fetch
  const FULL = LIVE_IDS
  const SMALL = LIVE_IDS.slice(0, 18)

  /**
   * Boot a fresh plugin instance so the module-level roster state starts clean,
   * then replay a script of rosters: the first entry is served to the initial
   * refresh, each later one to one `step()`.
   * @param {string} label - unique import query.
   * @param {string[][]} rosters - roster id lists, in order.
   * @returns {Promise<any>} the probe handles for that instance.
   */
  async function scenario(label, rosters) {
    let call = 0
    globalThis.fetch = async (url) => {
      const u = String(url)
      if (u.startsWith('https://pi.dev/')) return new Response(JSON.stringify(PI_DEV), { status: 200 })
      if (u.startsWith('https://opencode.ai/zen/go/v1/models')) {
        const ids = rosters[Math.min(call, rosters.length - 1)]
        call += 1
        return new Response(JSON.stringify({ data: ids.map(id => ({ id })) }), { status: 200 })
      }
      throw new Error(`unexpected fetch: ${u}`)
    }
    let base = {
      id: 'opencode-go',
      getModels: () => INSTALLED.slice(),
      stream: () => {}, streamSimple: () => {},
    }
    const coll = {
      getProvider: id => (id === 'opencode-go' ? base : undefined),
      setProvider: p => { Object.assign(base, p) },
      getModels: id => (id === 'opencode-go' ? base.getModels() : []),
    }
    const sLogs = []
    let tick = null
    globalThis.setInterval = fn => { tick = fn; return { unref() {} } }
    const sCtx = {
      llm: { adapters: new Map([['opencode-go', { adapter: { current: () => ({ models: coll }) } }]]) },
      logger: {
        info: (...a) => sLogs.push(['info', a.join(' ')]),
        warn: (...a) => sLogs.push(['warn', a.join(' ')]),
        debug: (...a) => sLogs.push(['debug', a.join(' ')]),
      },
      emit: () => {}, effect: fn => fn(), on: () => {},
    }
freshState()
    const mod = await import(`./lib/index.js?${label}`)
    await mount(mod, sCtx)
    return {
      snap: () => base.getModels().map(m => m.id),
      models: () => base.getModels(),
      warns: () => sLogs.filter(([l]) => l === 'warn').map(([, m]) => m),
      step: async () => { tick?.(); await new Promise(r => setTimeout(r, 60)) },
    }
  }

  // (a) 43 → 0：空集永远不被当作候选，也永远不覆盖 last-known-good
  {
    const s = await scenario('empty', [FULL, [], []])
    const healthy = s.snap().length
    await s.step()
    const afterFirst = s.snap().length
    await s.step()
    const afterSecond = s.snap().length
    ok('43 → 0：空 roster 被拒绝且从不成为候选', afterFirst === healthy && afterSecond === healthy,
      `${healthy} -> ${afterFirst} -> ${afterSecond}`)
    ok('空 roster 拒绝有告警且两次都报', s.warns().filter(w => w.includes('empty roster')).length === 2,
      s.warns().filter(w => w.includes('empty roster')).length + ' 次')
  }

  // (b) 43 → 18 → 18：第一次挡，第二次承认
  {
    const s = await scenario('shrink', [FULL, SMALL, SMALL])
    const healthy = s.snap().length
    await s.step()
    const held = s.snap().length
    const heldWarn = s.warns().some(w => w.includes('suspicious shrink'))
    await s.step()
    const accepted = s.snap().length
    ok('43 → 18：第一次 warn + pending，目录保持不变', held === healthy && heldWarn,
      `${healthy} -> ${held}（held 警告 ${heldWarn ? '有' : '无'}）`)
    ok('43 → 18 → 18：第二次同样的缩水被接受', accepted < held,
      `${held} -> ${accepted}`)
  }

  // (c) 43 → 18 → 43：恢复应取消 pending，再来一次 18 又要重新确认
  {
    const s = await scenario('recover', [FULL, SMALL, FULL, SMALL])
    const healthy = s.snap().length
    await s.step()
    const held = s.snap().length
    await s.step()
    const recovered = s.snap().length
    await s.step()
    const heldAgain = s.snap().length
    ok('43 → 18 → 43：恢复后目录回到全量', recovered === healthy,
      `${healthy} -> ${held} -> ${recovered}`)
    ok('恢复取消了 pending，再次骤降仍需重新确认', heldAgain === healthy,
      `再次 18 被挡：${heldAgain === healthy ? '是' : '否'}`)
  }

  globalThis.fetch = mainFetch
}

// ── 7.6 安全边界：远端不能决定请求去向与 headers ────────────────────────────
{
  const mainFetch = globalThis.fetch
  // The real catalog travels with the hostile entries: a 3-entry response would
  // now be (correctly) refused as a suspicious shrink, and that is a different
  // test. This section is about endpoints and headers, not about size.
  const HOSTILE = [
    ...PI_DEV,
    { id: 'evil-completions', name: 'Evil Completions', contextWindow: 1000, maxTokens: 500, input: ['text'], cost: { input: 0, output: 0 }, api: 'openai-completions', baseUrl: 'https://evil.example/v1', headers: { 'x-api-key': 'stolen' }, type: 'chat' },
    { id: 'evil-anthropic', name: 'Evil Anthropic', contextWindow: 1000, maxTokens: 500, input: ['text'], cost: { input: 0, output: 0 }, api: 'anthropic-messages', baseUrl: 'https://evil.example', headers: { authorization: 'Bearer stolen' }, type: 'chat' },
    { id: 'evil-unknown-api', name: 'Evil Unknown', contextWindow: 1000, maxTokens: 500, input: ['text'], cost: { input: 0, output: 0 }, api: 'some-future-transport', baseUrl: 'https://evil.example', type: 'chat' },
    { id: 'evil-constructor-api', name: 'Evil Ctor', contextWindow: 1000, maxTokens: 500, input: ['text'], cost: { input: 0, output: 0 }, api: 'constructor', type: 'chat' },
    { id: 'evil-proto-api', name: 'Evil Proto', contextWindow: 1000, maxTokens: 500, input: ['text'], cost: { input: 0, output: 0 }, api: '__proto__', type: 'chat' },
  ]
  globalThis.fetch = async (url) => {
    const u = String(url)
    if (u.startsWith('https://pi.dev/')) return new Response(JSON.stringify(HOSTILE), { status: 200 })
    if (u.startsWith('https://opencode.ai/zen/go/v1/models')) {
      return new Response(JSON.stringify({ data: LIVE_IDS.map(id => ({ id })) }), { status: 200 })
    }
    throw new Error(`unexpected fetch: ${u}`)
  }
  let base = {
    id: 'opencode-go',
    getModels: () => INSTALLED.slice(),
    stream: () => {}, streamSimple: () => {},
  }
  const coll = {
    getProvider: id => (id === 'opencode-go' ? base : undefined),
    setProvider: p => { Object.assign(base, p) },
    getModels: id => (id === 'opencode-go' ? base.getModels() : []),
  }
  globalThis.setInterval = () => ({ unref() {} })
  const hCtx = {
    llm: { adapters: new Map([['opencode-go', { adapter: { current: () => ({ models: coll }) } }]]) },
    logger: { info: () => {}, warn: () => {}, debug: () => {} },
    emit: () => {}, effect: fn => fn(), on: () => {},
  }
freshState()
  const hostile = await import('./lib/index.js?hostile')
  await mount(hostile, hCtx)
  const got = base.getModels()
  const completions = got.find(m => m.id === 'evil-completions')
  const anthropic = got.find(m => m.id === 'evil-anthropic')
  ok('远端 baseUrl 被忽略：openai 类固定到 /v1', completions?.baseUrl === 'https://opencode.ai/zen/go/v1',
    completions?.baseUrl)
  ok('远端 baseUrl 被忽略：anthropic 固定到网关根（不拼 /v1）',
    anthropic?.baseUrl === 'https://opencode.ai/zen/go', anthropic?.baseUrl)
  ok('远端 headers 被剥离', completions?.headers === undefined && anthropic?.headers === undefined,
    JSON.stringify({ c: completions?.headers, a: anthropic?.headers }))
  ok('未知协议的模型被丢弃（不存在的 transport 不注册）',
    got.find(m => m.id === 'evil-unknown-api') === undefined)
  ok('api="constructor" 的模型被丢弃（不能靠 Object.prototype 通过协议校验）',
    got.find(m => m.id === 'evil-constructor-api') === undefined,
    JSON.stringify(got.find(m => m.id === 'evil-constructor-api')))
  ok('api="__proto__" 的模型被丢弃', got.find(m => m.id === 'evil-proto-api') === undefined)
  ok('目录中没有任何模型携带非字符串 baseUrl',
    got.every(m => typeof m.baseUrl === 'string'),
    got.filter(m => typeof m.baseUrl !== 'string').map(m => `${m.id}=${typeof m.baseUrl}`).join(', ') || '全部为字符串')
  globalThis.fetch = mainFetch
}

// ── 7.7 信任模型：控制面剥离，业务字段与未来字段透传 ────────────────────────
{
  ok('真实 fixture 不产生未知字段告警（KNOWN_CATALOG_FIELDS 覆盖当前 schema）',
    !logs.some(([, m]) => m.includes('introduced new model field')),
    logs.filter(([, m]) => m.includes('introduced new model field')).join(' | ') || '无')

  const mainFetch = globalThis.fetch
  const MIXED = [
    ...PI_DEV,
    {
      id: 'control-plane', name: 'Control Plane', contextWindow: 1000, maxTokens: 500, input: ['text'], cost: { input: 0, output: 0 }, api: 'openai-completions', type: 'chat',
      // every way a remote could try to steer a request
      baseUrl: 'https://evil.example/v1', url: 'https://evil.example', endpoint: 'https://evil.example',
      headers: { 'x-api-key': 'stolen' }, auth: { token: 'stolen' }, apiKey: 'stolen',
      credentials: { user: 'x' }, proxy: 'http://127.0.0.1:1080',
      env: { HTTPS_PROXY: 'http://127.0.0.1:1080' }, fetch: 'https://evil.example',
      transport: 'evil-transport', provider: 'someone-else',
    },
    {
      // a capability this plugin has never heard of: must arrive, not be stripped
      id: 'future-model', api: 'openai-completions', type: 'chat',
      name: 'Future Model', contextWindow: 1000, maxTokens: 500, input: ['text'], cost: { input: 0, output: 0 },
      output: ['text', 'image'], promptCache: true, capabilities: { vision: true },
    },
  ]
  globalThis.fetch = async (url) => {
    const u = String(url)
    if (u.startsWith('https://pi.dev/')) return new Response(JSON.stringify(MIXED), { status: 200 })
    if (u.startsWith('https://opencode.ai/zen/go/v1/models')) {
      return new Response(JSON.stringify({ data: LIVE_IDS.map(id => ({ id })) }), { status: 200 })
    }
    throw new Error(`unexpected fetch: ${u}`)
  }
  let base = {
    id: 'opencode-go',
    getModels: () => INSTALLED.slice(),
    stream: () => {}, streamSimple: () => {},
  }
  const coll = {
    getProvider: id => (id === 'opencode-go' ? base : undefined),
    setProvider: p => { Object.assign(base, p) },
    getModels: id => (id === 'opencode-go' ? base.getModels() : []),
  }
  let tick = null
  globalThis.setInterval = fn => { tick = fn; return { unref() {} } }
  const mLogs = []
  const mCtx = {
    llm: { adapters: new Map([['opencode-go', { adapter: { current: () => ({ models: coll }) } }]]) },
    logger: {
      info: (...a) => mLogs.push(['info', a.join(' ')]),
      warn: (...a) => mLogs.push(['warn', a.join(' ')]),
      debug: (...a) => mLogs.push(['debug', a.join(' ')]),
    },
    emit: () => {}, effect: fn => fn(), on: () => {},
  }
freshState()
  const mixed = await import('./lib/index.js?mixed')
  await mount(mixed, mCtx)
  tick?.(); await wait(); await wait()
  tick?.(); await wait(); await wait()

  const control = base.getModels().find(m => m.id === 'control-plane')
  const future = base.getModels().find(m => m.id === 'future-model')
  const leaked = ['url', 'endpoint', 'headers', 'auth', 'apiKey', 'credentials', 'proxy', 'env', 'fetch', 'transport']
    .filter(key => control?.[key] !== undefined)
  ok('控制面字段一个都没透传（url/endpoint/auth/proxy/apiKey/credentials/env/fetch/transport/headers）',
    leaked.length === 0, leaked.join(', ') || '无泄漏')
  ok('provider 仍被插件改写，baseUrl 仍被固定',
    control?.provider === 'opencode-go' && control?.baseUrl === 'https://opencode.ai/zen/go/v1',
    `${control?.provider} / ${control?.baseUrl}`)
  ok('未来能力字段原样透传，不被静默削掉',
    JSON.stringify(future?.output) === JSON.stringify(['text', 'image'])
      && future?.promptCache === true
      && future?.capabilities?.vision === true,
    JSON.stringify({ output: future?.output, promptCache: future?.promptCache, capabilities: future?.capabilities }))

  const notices = mLogs.filter(([l, m]) => l === 'warn' && m.includes('introduced new model field'))
  const named = notices[0]?.[1] ?? ''
  ok('未知字段被点名告警（output/promptCache/capabilities）',
    notices.length >= 1 && ['output', 'promptCache', 'capabilities'].every(f => named.includes(f)),
    named.slice(0, 120))
  ok('被主动剥离的控制面字段不算「新字段」，不混进告警',
    !['url', 'endpoint', 'auth', 'apiKey', 'credentials', 'proxy', 'env', 'fetch', 'transport']
      .some(f => new RegExp(`\\b${f}\\b`).test(named)),
    named.slice(0, 120))
  ok('未知字段告警整个进程只出现一次，不随 5 分钟轮询刷屏', notices.length === 1,
    `${notices.length} 次（经历 3 次轮询）`)
  globalThis.fetch = mainFetch
}

// ── 8. 降级：首次启动即 pi.dev 不可达（无骨架，顺序必须保持 installed 原序）─────
{
  mode = 'no-pidev'
  let base2 = {
    id: 'opencode-go',
    getModels: () => INSTALLED.slice(),
    stream: () => { throw new Error('not used') },
    streamSimple: () => { throw new Error('not used') },
  }
  const collection2 = {
    getProvider: (id) => (id === 'opencode-go' ? base2 : undefined),
    setProvider: (p) => { Object.assign(base2, p) },
  }
  const ctx2 = {
    llm: { adapters: new Map([['opencode-go', { adapter: { current: () => ({ models: collection2 }) } }]]) },
    logger: { info: () => {}, warn: () => {} },
    emit: () => {},
    effect: () => {},
    on: () => {},
  }
  // The query makes ESM load a *fresh* instance, so its module-level
  // remoteCatalog starts empty — the state of a first boot with no network.
freshState()
  const fresh = await import('./lib/index.js?firstboot')
  await mount(fresh, ctx2)
  const order2 = base2.getModels().map(m => m.id)
  const liveSet = new Set(LIVE_IDS)
  const installedOrder = INSTALLED.map(m => m.id).filter(id => liveSet.has(id))
  ok('首次启动即 pi.dev 不可达：退回 installed 原序（无主序时不臆造顺序）',
    order2.slice(0, installedOrder.length).join() === installedOrder.join(),
    order2.slice(0, 5).join(', '))
  ok('首次启动即降级时两个 fallback 模型仍可路由',
    order2.includes('space-bunny-free') && order2.includes('deepseek-v4.1-flash'))
}

// ── 8.6 目录缩水熔断 + 首次启动下限 + 并行取数 ─────────────────────────────
{
  const mainFetch = globalThis.fetch
  const SMALL_CATALOG = PI_DEV.slice(0, 4)

  /**
   * Fresh instance whose pi.dev and OCG responses are driven by a script of
   * `{ catalog, roster }` pairs, one per poll.
   * @param {string} label - unique import query.
   * @param {Array<{ catalog: any, roster: string[], delay?: number }>} script -
   * what each successive poll should return.
   * @returns {Promise<any>} probe handles.
   */
  async function scripted(label, script) {
    let poll = 0
    globalThis.fetch = async (url) => {
      const u = String(url)
      // Both feeds read the *same* step: a refresh issues two requests, so
      // advancing on each request would hand pi.dev one step and the roster the
      // next. That happens to be harmless in today's cases only because neither
      // step is a mixture; a cross-feed scenario would silently read the wrong
      // pair. The step advances in step(), once per refresh.
      const step = script[Math.min(poll, script.length - 1)]
      if (step.delay) await new Promise(r => setTimeout(r, step.delay))
      if (u.startsWith('https://pi.dev/')) return new Response(JSON.stringify(step.catalog), { status: 200 })
      if (u.startsWith('https://opencode.ai/zen/go/v1/models')) {
        return new Response(JSON.stringify({ data: step.roster.map(id => ({ id })) }), { status: 200 })
      }
      throw new Error(`unexpected fetch: ${u}`)
    }
    let base = {
      id: 'opencode-go',
      getModels: () => INSTALLED.slice(),
      stream: () => {}, streamSimple: () => {},
    }
    const coll = {
      getProvider: id => (id === 'opencode-go' ? base : undefined),
      setProvider: p => { Object.assign(base, p) },
      getModels: id => (id === 'opencode-go' ? base.getModels() : []),
    }
    let tick = null
    globalThis.setInterval = fn => { tick = fn; return { unref() {} } }
    const sLogs = []
    const sCtx = {
      llm: { adapters: new Map([['opencode-go', { adapter: { current: () => ({ models: coll }) } }]]) },
      logger: {
        info: (...a) => sLogs.push(['info', a.join(' ')]),
        warn: (...a) => sLogs.push(['warn', a.join(' ')]),
        debug: (...a) => sLogs.push(['debug', a.join(' ')]),
      },
      emit: () => {}, effect: fn => fn(), on: () => {},
    }
freshState()
    const mod = await import(`./lib/index.js?${label}`)
    await mount(mod, sCtx)
    return {
      snap: () => base.getModels().map(m => m.id),
      models: () => base.getModels(),
      warns: () => sLogs.filter(([l]) => l === 'warn').map(([, m]) => m),
      step: async () => {
        poll += 1
        tick?.()
        await wait(); await wait(); await wait()
      },
    }
  }

  // (a) pi.dev 29 -> 4：非空但严重缩水，也要两轮确认
  {
    const s = await scripted('cat-shrink', [
      { catalog: PI_DEV, roster: LIVE_IDS },
      { catalog: SMALL_CATALOG, roster: LIVE_IDS },
      { catalog: SMALL_CATALOG, roster: LIVE_IDS },
    ])
    const good = s.snap().length
    await s.step()
    const held = s.snap().length
    const warned = s.warns().some(w => w.includes('catalog suspicious shrink'))
    await s.step()
    const accepted = s.snap().length
    ok('pi.dev 29 → 4：第一次被挡下且目录不变', held === good && warned, `${good} -> ${held}（告警 ${warned ? '有' : '无'}）`)
    ok('pi.dev 同样的缩水第二次出现才被接受', accepted < held, `${held} -> ${accepted}`)
  }

  // (b) 缩水后恢复正常：取消待确认
  {
    const s = await scripted('cat-recover', [
      { catalog: PI_DEV, roster: LIVE_IDS },
      { catalog: SMALL_CATALOG, roster: LIVE_IDS },
      { catalog: PI_DEV, roster: LIVE_IDS },
    ])
    const good = s.snap().length
    await s.step()
    const held = s.snap().length
    await s.step()
    const recovered = s.snap().length
    ok('pi.dev 缩水后恢复：目录回到全量，待确认被取消',
      held === good && recovered === good, `${good} -> ${held} -> ${recovered}`)
  }

  // (c) 冷启动就拿到 1 个 ID 的名单：没有 last-known-good 兜底，仍必须拒绝
  {
    const s = await scripted('roster-cold', [
      { catalog: PI_DEV, roster: ['gpt-5.6-luna'] },
    ])
    const snap = s.snap()
    ok('冷启动即拿到单条目名单时被拒（不靠 last-known-good 兜底）',
      snap.every(id => INSTALLED_IDS.includes(id) || PI_DEV.some(m => m.id === id)),
      `目录 ${snap.length} 个`)
    ok('冷启动单条目名单有告警', s.warns().some(w => w.includes('roster suspicious shrink')),
      s.warns().find(w => w.includes('roster suspicious shrink'))?.slice(0, 110) ?? '无')
  }

  // (d) 两个端点是并行取的：总耗时应接近较慢的那个，而非两者之和
  {
    const DELAY = 300
    const t0 = Date.now()
    const s = await scripted('parallel', [
      { catalog: PI_DEV, roster: LIVE_IDS, delay: DELAY },
    ])
    const elapsed = Date.now() - t0
    ok('两个上游并行请求（总耗时 ≈ 单个延迟，而非两倍）',
      elapsed < DELAY * 1.8,
      `${DELAY}ms × 2 串行需 ≈${DELAY * 2}ms，实际 ${elapsed}ms`)
    ok('并行取数后目录仍正确', s.snap().length > 30, `${s.snap().length} 个模型`)
  }

  // (d2) 漂移告警：名单不变就不重复刷屏，名单一变要重新提示
  {
    const UNKNOWN = ['mystery-1', 'mystery-2']
    const s = await scripted('drift-quiet', [
      { catalog: PI_DEV, roster: [...LIVE_IDS, ...UNKNOWN] },
      { catalog: PI_DEV, roster: [...LIVE_IDS, ...UNKNOWN] },
      { catalog: PI_DEV, roster: [...LIVE_IDS, ...UNKNOWN, 'mystery-3'] },
      { catalog: PI_DEV, roster: [...LIVE_IDS, ...UNKNOWN, 'mystery-3'] },
    ])
    const count = () => s.warns().filter(w => w.includes('have no descriptor yet')).length
    ok('首次出现时报告一次', count() === 1, `${count()} 次`)
    await s.step()
    ok('名单不变时不再重复（5 分钟轮询保持安静）', count() === 1, `${count()} 次`)
    await s.step()
    ok('名单变化时重新报告', count() === 2, `${count()} 次`)
    await s.step()
    ok('再次稳定后不再重复', count() === 2, `${count()} 次`)
  }

  globalThis.fetch = mainFetch
}

// ── 8.5 pi.dev 目录熔断：空/畸形响应不得覆盖 last-known-good ────────────────
{
  const mainFetch = globalThis.fetch

  /**
   * Boot a fresh instance whose pi.dev answers with `body` from the second poll
   * onward, so the first refresh establishes a known-good catalog first.
   * @param {string} label - unique import query.
   * @param {any} body - the malformed (or valid) body pi.dev returns later.
   * @returns {Promise<any>} the probe handles for that instance.
   */
  async function catalogScenario(label, body) {
    let call = 0
    globalThis.fetch = async (url) => {
      const u = String(url)
      if (u.startsWith('https://pi.dev/')) {
        call += 1
        return new Response(JSON.stringify(call === 1 ? PI_DEV : body), { status: 200 })
      }
      if (u.startsWith('https://opencode.ai/zen/go/v1/models')) {
        return new Response(JSON.stringify({ data: LIVE_IDS.map(id => ({ id })) }), { status: 200 })
      }
      throw new Error(`unexpected fetch: ${u}`)
    }
    let base = {
      id: 'opencode-go',
      getModels: () => INSTALLED.slice(),
      stream: () => {}, streamSimple: () => {},
    }
    const coll = {
      getProvider: id => (id === 'opencode-go' ? base : undefined),
      setProvider: p => { Object.assign(base, p) },
      getModels: id => (id === 'opencode-go' ? base.getModels() : []),
    }
    let tick = null
    globalThis.setInterval = fn => { tick = fn; return { unref() {} } }
    const cLogs = []
    const cCtx = {
      llm: { adapters: new Map([['opencode-go', { adapter: { current: () => ({ models: coll }) } }]]) },
      logger: {
        info: (...a) => cLogs.push(['info', a.join(' ')]),
        warn: (...a) => cLogs.push(['warn', a.join(' ')]),
        debug: (...a) => cLogs.push(['debug', a.join(' ')]),
      },
      emit: () => {}, effect: fn => fn(), on: () => {},
    }
freshState()
    const mod = await import(`./lib/index.js?${label}`)
    await mount(mod, cCtx)
    return {
      snap: () => base.getModels().map(m => m.id),
      models: () => base.getModels(),
      warns: () => cLogs.filter(([l]) => l === 'warn').map(([, m]) => m),
      step: async () => { tick?.(); await wait(); await wait() },
    }
  }

  // HTTP 200 but nothing usable in it — the fetch "succeeded", so only the
  // breaker can keep the last good catalog alive.
  for (const [label, body, why] of [
    ['emptyarray', [], '空数组'],
    ['dataempty', { data: [] }, 'envelope 变成 data 且为空'],
    ['envelopeshift', { results: PI_DEV }, 'envelope 换成不认识的名字'],
    ['allunknown', PI_DEV.map(m => ({ ...m, api: 'some-future-transport' })), '全部协议不认识'],
  ]) {
    const s = await catalogScenario(`cat-${label}`, body)
    const good = s.snap().length
    await s.step()
    ok(`pi.dev 返回${why}时 last-known-good 不被覆盖`, s.snap().length === good,
      `${good} -> ${s.snap().length}`)
    ok(`pi.dev 返回${why}时有明确告警（不是静默降级）`,
      s.warns().some(w => w.includes('pi.dev catalog refresh failed')), s.warns().find(w => w.includes('pi.dev catalog refresh failed'))?.slice(0, 110) ?? '无')
  }

  // The other direction: a new envelope that is *populated* is a new shape, not
  // a failure, and must not be mistaken for one.
  {
    const s = await catalogScenario('cat-dataenvelope', { data: PI_DEV })
    const good = s.snap().length
    await s.step()
    ok('envelope 变成 data 但内容正常时被正确识别，不误杀',
      s.snap().length === good && !s.warns().some(w => w.includes('pi.dev catalog refresh failed')),
      `${good} -> ${s.snap().length}`)
  }

  globalThis.fetch = mainFetch
}

// ── 8.7 连续确认必须真的连续 + 延迟注册的基线 + 热重载接管 ────────────────
{
  const mainFetch = globalThis.fetch

  /**
   * A live plugin environment whose adapter can be attached later, with both
   * feeds scripted per refresh.
   * @param {string} label - unique import query.
   * @param {Array<{ catalog: any, roster: string[] }>} script - per-poll feeds.
   * @returns {Promise<any>} handles for attaching, stepping and disposing.
   */
  async function lateAdapter(label, script) {
    let poll = 0
    globalThis.fetch = async (url) => {
      const u = String(url)
      const step = script[Math.min(poll, script.length - 1)]
      if (u.startsWith('https://pi.dev/')) return new Response(JSON.stringify(step.catalog), { status: 200 })
      if (u.startsWith('https://opencode.ai/zen/go/v1/models')) {
        return new Response(JSON.stringify({ data: step.roster.map(id => ({ id })) }), { status: 200 })
      }
      throw new Error(`unexpected fetch: ${u}`)
    }
    const base = {
      id: 'opencode-go',
      getModels: () => INSTALLED.slice(),
      stream: () => {}, streamSimple: () => {},
    }
    // A real provider slot, not `Object.assign(base, p)`: the unload path
    // restores a provider only while ours is still the installed one, and a
    // mock that mutates in place makes that identity check permanently false —
    // hiding the bug instead of testing it.
    let current = base
    const coll = {
      getProvider: id => (id === 'opencode-go' ? current : undefined),
      setProvider: p => { current = p },
      getModels: id => (id === 'opencode-go' ? current.getModels() : []),
    }
    const adapters = new Map()
    let tick = null
    globalThis.setInterval = fn => { tick = fn; return { unref() {} } }
    const disposers = []
    const sLogs = []
    const listeners = new Map()
    const sCtx = {
      llm: { adapters },
      logger: {
        info: (...a) => sLogs.push(['info', a.join(' ')]),
        warn: (...a) => sLogs.push(['warn', a.join(' ')]),
        debug: (...a) => sLogs.push(['debug', a.join(' ')]),
      },
      // Really dispatch, so a plugin that emits its own event reaches its own
      // listener; an inert emit() hides that re-entry completely.
      emit: (ev) => { for (const fn of listeners.get(ev) ?? []) fn(ev) },
      effect: fn => { const d = fn(); if (typeof d === 'function') disposers.push(d) },
      on: (ev, fn) => {
        if (!listeners.has(ev)) listeners.set(ev, [])
        listeners.get(ev).push(fn)
      },
    }
    freshState()
    const mod = await import(`./lib/index.js?${label}`)
    await mount(mod, sCtx)
    const adapter = { current: () => ({ models: coll }) }
    const originalCurrent = adapter.current
    return {
      attach() {
        adapters.set('opencode-go', { adapter })
        for (const fn of listeners.get('llm/adapters-updated') ?? []) fn('llm/adapters-updated')
      },
      /** Fire the event the way DSH would, without re-registering the adapter. */
      announce() {
        for (const fn of listeners.get('llm/adapters-updated') ?? []) fn('llm/adapters-updated')
      },
      adapter,
      originalCurrent,
      snap: () => coll.getModels('opencode-go').map(m => m.id),
      installedOnly: () => INSTALLED_IDS.filter(i => !PI_DEV.some(m => m.id === i)),
      warns: () => sLogs.filter(([l]) => l === 'warn').map(([, m]) => m),
      step: async () => { poll += 1; tick?.(); await wait(); await wait(); await wait() },
      dispose() { for (const d of disposers) d() },
    }
  }

  // (a) 43 → 18 → 0 → 18：中间插了空响应，两次 18 并非连续
  {
    const script = [
      { catalog: PI_DEV, roster: LIVE_IDS },
      { catalog: PI_DEV, roster: LIVE_IDS.slice(0, 18) },
      { catalog: PI_DEV, roster: [] },
      { catalog: PI_DEV, roster: LIVE_IDS.slice(0, 18) },
    ]
    const s = await lateAdapter('nonconsecutive', script)
    s.attach()
    await wait(); await wait()
    const full = s.snap().length
    await s.step()
    await s.step()
    await s.step()
    const after = s.snap().length
    const missing = INSTALLED_IDS.filter(i => !s.snap().includes(i))
    ok('43 → 18 → 0 → 18：中间失败后不再确认（候选被重置）',
      after === full, `${full} → ${after}${missing.length ? `，缺失 ${missing.join(',')}` : ''}`)
  }

  // (b) 43 → 18 → 18：真正连续，仍应确认
  {
    const script = [
      { catalog: PI_DEV, roster: LIVE_IDS },
      { catalog: PI_DEV, roster: LIVE_IDS.slice(0, 18) },
      { catalog: PI_DEV, roster: LIVE_IDS.slice(0, 18) },
    ]
    const s = await lateAdapter('consecutive', script)
    s.attach()
    await wait(); await wait()
    const full = s.snap().length
    await s.step()
    const held = s.snap().length
    await s.step()
    const accepted = s.snap().length
    ok('43 → 18 → 18：真正连续仍会确认（重置逻辑未误伤）',
      held === full && accepted < held, `${full} → ${held} → ${accepted}`)
  }

  // (c) adapter 延迟注册：单条名单先挂起；且**重复事件不得把同一份数据
  //     当成第二次确认** —— 确认必须来自新的网络响应
  {
    const script = [
      { catalog: PI_DEV, roster: ['gpt-5.6-luna'] },
      { catalog: PI_DEV, roster: ['gpt-5.6-luna'] },
    ]
    const s = await lateAdapter('late-adapter', script)
    s.attach()
    await wait(); await wait()
    ok('adapter 晚注册：单条名单被挂起，installed-only 模型一个不丢',
      s.installedOnly().every(i => s.snap().includes(i)),
      `目录 ${s.snap().length}；缺失 ${s.installedOnly().filter(i => !s.snap().includes(i)).join(',') || '无'}`)
    ok('adapter 晚注册：拿到基线后重新判定，缩水名单仍被挡下',
      s.warns().some(w => w.includes('roster suspicious shrink')),
      s.warns().find(w => w.includes('roster suspicious shrink'))?.slice(0, 100) ?? '无')

    // Our own event, fired twice more, must not re-judge the same bytes.
    s.announce()
    s.announce()
    await wait(); await wait()
    ok('重复的 adapters-updated 不会拿同一份数据当第二次确认',
      s.installedOnly().every(i => s.snap().includes(i)),
      `重复事件后 ${s.snap().length} 个；缺失 ${s.installedOnly().filter(i => !s.snap().includes(i)).join(',') || '无'}`)
  }

  // (c2) 重复事件不堆叠 hook；卸载一次即可退净，provider 也还原
  {
    const s = await lateAdapter('repeat-hook', [
      { catalog: PI_DEV, roster: LIVE_IDS },
      { catalog: PI_DEV, roster: LIVE_IDS },
    ])
    s.attach()
    s.announce()
    s.announce()
    s.announce()
    await wait(); await wait()
    const hookedOnce = s.adapter.current
    s.announce()
    await wait()
    ok('重复事件不会反复包装 adapter.current（hook 不嵌套）',
      hookedOnce !== s.originalCurrent && s.adapter.current === hookedOnce,
      `重复事件后 ${s.adapter.current === hookedOnce ? '引用未变' : '★又被包了一层'}`)
    s.dispose()
    ok('重复事件后卸载一次即恢复原函数', s.adapter.current === s.originalCurrent,
      s.adapter.current === s.originalCurrent ? '已恢复' : '★仍是包装版本')
    ok('卸载后 provider 被还原，目录回到原安装目录', s.snap().length === INSTALLED.length,
      `卸载后 ${s.snap().length}（期望 ${INSTALLED.length}）`)
  }

  // (d) 热重载：新实例接管共享 state，旧 wrapper 反映新数据
  {
    const rows = [...PI_DEV, { id: 'hot-reload-new', name: 'Hot New', contextWindow: 2000, maxTokens: 1000, input: ['text'], cost: { input: 0, output: 0 }, api: 'openai-completions', type: 'chat' }]
    let poll = 0
    let catalogPolls = 0
    globalThis.fetch = async (url) => {
      const u = String(url)
      const catalog = poll === 0 ? PI_DEV : rows
      if (u.startsWith('https://pi.dev/')) { catalogPolls += 1; return new Response(JSON.stringify(catalog), { status: 200 }) }
      if (u.startsWith('https://opencode.ai/zen/go/v1/models')) {
        return new Response(JSON.stringify({ data: [...LIVE_IDS, 'hot-reload-new'].map(id => ({ id })) }), { status: 200 })
      }
      throw new Error(`unexpected fetch: ${u}`)
    }
    const base = {
      id: 'opencode-go',
      getModels: () => INSTALLED.slice(),
      stream: () => {}, streamSimple: () => {},
    }
    const coll = {
      getProvider: id => (id === 'opencode-go' ? base : undefined),
      setProvider: p => { Object.assign(base, p) },
      getModels: id => (id === 'opencode-go' ? base.getModels() : []),
    }
    const adapters = new Map([['opencode-go', { adapter: { current: () => ({ models: coll }) } }]])
    let tick = null
    globalThis.setInterval = fn => { tick = fn; return { unref() {} } }
    // The reload must run the *second* instance's timer, so the context has to
    // actually call the effect body — an empty stub would leave `tick` pointing
    // at whatever the previous scenario installed.
    const makeCtx = (logs) => ({
      llm: { adapters },
      logger: {
        info: (...a) => logs.push(['info', a.join(' ')]),
        warn: (...a) => logs.push(['warn', a.join(' ')]),
        debug: (...a) => logs.push(['debug', a.join(' ')]),
      },
      emit: () => {},
      effect: fn => { fn() },
      on: () => {},
    })

    // Deliberately no freshState(): this instance must adopt the slot the first
    // one left behind, which is the whole point of this section.
    const first = await import('./lib/index.js?hmr-first')
    await mount(first, makeCtx([]))
    const wrapped = coll.getProvider('opencode-go')
    const beforeReload = coll.getModels('opencode-go').map(m => m.id)

    const second = await import('./lib/index.js?hmr-second')
    await mount(second, makeCtx([]))
    const sameWrapper = coll.getProvider('opencode-go') === wrapped
    poll = 1   // the next poll is the one that carries the new descriptor
    tick?.(); await wait(); await wait(); await wait()
    const afterReload = coll.getModels('opencode-go').map(m => m.id)

    ok('热重载：provider 未被二次包装（沿用同一 wrapper）', sameWrapper)
    ok('热重载：新实例拉到的新模型进入目录（旧 wrapper 不再读旧闭包）',
      afterReload.includes('hot-reload-new') && !beforeReload.includes('hot-reload-new'),
      `重载前 ${beforeReload.length} → 重载后 ${afterReload.length}，新模型${afterReload.includes('hot-reload-new') ? '已出现' : '★缺失'}（pi.dev 取数 ${catalogPolls} 次）`)
  }

  // (d) 卸载：adapter hook 被恢复，在途刷新不再回写
  {
    const s = await lateAdapter('unload', [
      { catalog: PI_DEV, roster: LIVE_IDS },
      { catalog: PI_DEV, roster: LIVE_IDS },
    ])
    s.attach()
    await wait(); await wait()
    ok('挂载后 adapter.current 被包装', s.adapter.current !== s.originalCurrent)
    s.dispose()
    ok('卸载后 adapter.current 恢复为原函数', s.adapter.current === s.originalCurrent,
      s.adapter.current === s.originalCurrent ? '已恢复' : '★仍是被包装的版本')
    // A refresh already in flight must not write into a state the next instance
    // is about to inherit: with the provider unwound, the picker must stay on
    // the installed catalog rather than snapping back to the overlay.
    await s.step()
    ok('卸载后在途刷新不回写，目录停在原安装目录', s.snap().length === INSTALLED.length,
      `卸载并刷新后 ${s.snap().length}（期望 ${INSTALLED.length}）`)
  }

  // (e) 旧实例的在途请求晚于新实例返回：不得覆盖新实例的结果
  {
    // The old instance's roster is the one that deletes installed models. A
    // shared `disposed` flag would be cleared by the new mount and let this late
    // answer through, taking the new instance's catalog down with it.
    const COLLAPSE = ['gpt-5.6-luna']
    let release
    const gate = new Promise(r => { release = r })
    let phase = 'old'
    globalThis.fetch = async (url) => {
      const u = String(url)
      if (u.startsWith('https://pi.dev/')) return new Response(JSON.stringify(PI_DEV), { status: 200 })
      if (u.startsWith('https://opencode.ai/zen/go/v1/models')) {
        if (phase === 'old') {
          await gate
          return new Response(JSON.stringify({ data: COLLAPSE.map(id => ({ id })) }), { status: 200 })
        }
        return new Response(JSON.stringify({ data: LIVE_IDS.map(id => ({ id })) }), { status: 200 })
      }
      throw new Error(`unexpected fetch: ${u}`)
    }
    const base = {
      id: 'opencode-go',
      getModels: () => INSTALLED.slice(),
      stream: () => {}, streamSimple: () => {},
    }
    let current = base
    const coll = {
      getProvider: id => (id === 'opencode-go' ? current : undefined),
      setProvider: p => { current = p },
      getModels: id => (id === 'opencode-go' ? current.getModels() : []),
    }
    const adapters = new Map([['opencode-go', { adapter: { current: () => ({ models: coll }) } }]])
    let tick = null
    globalThis.setInterval = fn => { tick = fn; return { unref() {} } }
    const quiet = () => ({
      llm: { adapters },
      logger: { info: () => {}, warn: () => {}, debug: () => {} },
      emit: () => {}, effect: () => {}, on: () => {},
    })

    const oldMod = await import('./lib/index.js?stale-old')
    oldMod.apply(quiet())                        // still blocked in-flight
    const newMod = await import('./lib/index.js?stale-new')
    phase = 'new'
    await mount(newMod, quiet())
    const shownByNew = coll.getModels('opencode-go').map(m => m.id).length

    release()
    await wait(); await wait(); await wait()
    const afterOld = coll.getModels('opencode-go').map(m => m.id)

    ok('旧实例的请求在新实例之后返回，目录不被它覆盖',
      afterOld.length === shownByNew,
      `新实例 ${shownByNew} 个 → 旧请求返回后 ${afterOld.length} 个`)
    ok('旧实例的缩水名单被丢弃，installed-only 模型未消失',
      afterOld.length > INSTALLED.length,
      `目录 ${afterOld.length} 个（installed-only 全部在列）`)
  }

  // (f) 新实例先挂载、旧实例后卸载：旧实例不得拆掉新实例的补丁
  {
    const base = {
      id: 'opencode-go',
      getModels: () => INSTALLED.slice(),
      stream: () => {}, streamSimple: () => {},
    }
    let current = base
    const coll = {
      getProvider: id => (id === 'opencode-go' ? current : undefined),
      setProvider: p => { current = p },
      getModels: id => (id === 'opencode-go' ? current.getModels() : []),
    }
    const adapter = { current: () => ({ models: coll }) }
    const originalCurrent = adapter.current
    const adapters = new Map([['opencode-go', { adapter }]])
    let tick = null
    globalThis.setInterval = fn => { tick = fn; return { unref() {} } }
    globalThis.fetch = async (url) => {
      const u = String(url)
      if (u.startsWith('https://pi.dev/')) return new Response(JSON.stringify(PI_DEV), { status: 200 })
      if (u.startsWith('https://opencode.ai/zen/go/v1/models')) {
        return new Response(JSON.stringify({ data: LIVE_IDS.map(id => ({ id })) }), { status: 200 })
      }
      throw new Error(`unexpected fetch: ${u}`)
    }
    const makeEnv = () => {
      const disposers = []
      return {
        ctx: {
          llm: { adapters },
          logger: { info: () => {}, warn: () => {}, debug: () => {} },
          emit: () => {},
          effect: fn => { const d = fn(); if (typeof d === 'function') disposers.push(d) },
          on: () => {},
        },
        dispose: () => { for (const d of disposers) d() },
      }
    }

    // Deliberately no freshState(): the second instance must adopt the slot the
    // first one left behind.
    const firstEnv = makeEnv()
    const first = await import('./lib/index.js?order-old')
    await mount(first, firstEnv.ctx)
    const overlaid = coll.getModels('opencode-go').map(m => m.id).length
    const providerAfterMount = coll.getProvider('opencode-go')

    const secondEnv = makeEnv()
    const second = await import('./lib/index.js?order-new')
    await mount(second, secondEnv.ctx)
    const afterMount = coll.getModels('opencode-go').map(m => m.id).length

    // The old instance unloads *after* the new one has taken over.
    firstEnv.dispose()
    await wait(); await wait()
    const afterOldUnload = coll.getModels('opencode-go').map(m => m.id).length

    ok('新挂载后旧卸载：旧实例不拆掉新实例的 provider',
      coll.getProvider('opencode-go') === providerAfterMount,
      coll.getProvider('opencode-go') === providerAfterMount ? '仍是新实例的 provider' : '★已被还原')
    ok('新挂载后旧卸载：adapter.current 仍被包装',
      adapter.current !== originalCurrent,
      adapter.current === originalCurrent ? '★被旧实例退掉了' : '仍保持包装')
    ok('新挂载后旧卸载：目录仍是叠加后的数量，未退回原安装目录',
      afterOldUnload === afterMount && afterMount === overlaid && afterOldUnload > INSTALLED.length,
      `挂载后 ${afterMount} → 旧卸载后 ${afterOldUnload}（期望 ${overlaid}）`)

    // The current instance must still be able to clean up after itself.
    secondEnv.dispose()
    ok('当前实例卸载时仍能正常还原',
      adapter.current === originalCurrent && coll.getProvider('opencode-go') === base,
      `adapter ${adapter.current === originalCurrent ? '已恢复' : '★未恢复'}，provider ${coll.getProvider('opencode-go') === base ? '已恢复' : '★未恢复'}`)
  }

  // (g) 同数量但丢字段的响应：必须整份回退，不能采纳残缺描述符
  {
    // Same 29 ids, same supported protocols, nothing else. The size gate cannot
    // see this — the count never moved — so the catalog would be replaced with
    // descriptors that have no capacities at all.
    const stripped = PI_DEV.map(m => ({ id: m.id, api: m.api }))
    const probeId = 'deepseek-v4.1-flash'
    let poll = 0
    globalThis.fetch = async (url) => {
      const u = String(url)
      if (u.startsWith('https://pi.dev/')) {
        return new Response(JSON.stringify(poll === 0 ? PI_DEV : stripped), { status: 200 })
      }
      if (u.startsWith('https://opencode.ai/zen/go/v1/models')) {
        return new Response(JSON.stringify({ data: LIVE_IDS.map(id => ({ id })) }), { status: 200 })
      }
      throw new Error(`unexpected fetch: ${u}`)
    }
    const base = {
      id: 'opencode-go',
      getModels: () => INSTALLED.slice(),
      stream: () => {}, streamSimple: () => {},
    }
    let current = base
    const coll = {
      getProvider: id => (id === 'opencode-go' ? current : undefined),
      setProvider: p => { current = p },
      getModels: id => (id === 'opencode-go' ? current.getModels() : []),
    }
    const adapters = new Map([['opencode-go', { adapter: { current: () => ({ models: coll }) } }]])
    let tick = null
    globalThis.setInterval = fn => { tick = fn; return { unref() {} } }
    const warns = []
    freshState()
    const mod = await import('./lib/index.js?stripped')
    await mount(mod, {
      llm: { adapters },
      logger: {
        info: () => {},
        warn: (...a) => warns.push(a.join(' ')),
        debug: () => {},
      },
      emit: () => {}, effect: fn => { fn() }, on: () => {},
    })
    const models = () => coll.getModels('opencode-go')
    const goodCount = models().length
    const before = models().find(m => m.id === probeId)
    poll = 1
    tick?.(); await wait(); await wait(); await wait()
    const after = models().find(m => m.id === probeId)

    ok('同数量但缺能力字段的响应被整份拒绝（并说明原因）',
      warns.some(w => w.includes('incomplete descriptors')),
      warns.find(w => w.includes('incomplete'))?.slice(0, 120) ?? '无')
    ok('拒绝后目录回到 last-known-good', models().length === goodCount, `${goodCount} → ${models().length}`)
    ok('保留下来的描述符仍带完整能力字段',
      after !== undefined && after.contextWindow === before?.contextWindow && after.maxTokens === before?.maxTokens,
      `contextWindow ${after?.contextWindow} / maxTokens ${after?.maxTokens}`)
  }

  // (h) 同一模块对象二次 apply：首轮刷新不得被上一代的 in-flight 吞掉
  {
    let release
    const gate = new Promise(r => { release = r })
    let hits = 0
    globalThis.fetch = async (url) => {
      const u = String(url)
      if (u.startsWith('https://pi.dev/')) {
        hits += 1
        if (hits === 1) await gate
        return new Response(JSON.stringify(PI_DEV), { status: 200 })
      }
      if (u.startsWith('https://opencode.ai/zen/go/v1/models')) {
        return new Response(JSON.stringify({ data: LIVE_IDS.map(id => ({ id })) }), { status: 200 })
      }
      throw new Error(`unexpected fetch: ${u}`)
    }
    const base = {
      id: 'opencode-go',
      getModels: () => INSTALLED.slice(),
      stream: () => {}, streamSimple: () => {},
    }
    let current = base
    const coll = {
      getProvider: id => (id === 'opencode-go' ? current : undefined),
      setProvider: p => { current = p },
      getModels: id => (id === 'opencode-go' ? current.getModels() : []),
    }
    const adapters = new Map([['opencode-go', { adapter: { current: () => ({ models: coll }) } }]])
    let tick = null
    globalThis.setInterval = fn => { tick = fn; return { unref() {} } }
    const quiet = () => ({
      llm: { adapters },
      logger: { info: () => {}, warn: () => {}, debug: () => {} },
      emit: () => {}, effect: () => {}, on: () => {},
    })

    freshState()
    // One module object, two mounts — no freshState(), same instance this time.
    const mod = await import('./lib/index.js?same-module-twice')
    const first = mod.apply(quiet())          // still blocked in-flight
    const secondCount = hits
    // Without a per-generation guard this would be handed the first mount's
    // in-flight refresh, whose result is then dropped by the generation check —
    // leaving the new mount with nothing and the picker on installed + fallback.
    mod.apply(quiet())
    const hitsAfterSecond = hits
    release()
    await first
    await wait(); await wait(); await wait()
    const models = coll.getModels('opencode-go').map(m => m.id)

    ok('同一模块二次 apply 会另起一轮刷新，不复用上一代的 in-flight 请求',
      hitsAfterSecond > secondCount,
      `首次挂载已发 ${secondCount} 次，二次挂载后共 ${hitsAfterSecond} 次`)
    ok('二次挂载的首轮数据未被丢弃，目录完整',
      models.length > INSTALLED.length,
      `目录 ${models.length} 个（installed-only 全部在列）`)
  }

  globalThis.fetch = mainFetch
}

let failed = 0
for (const r of results) {
  if (!r.pass) failed += 1
  console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `\n        ${r.detail}` : ''}`)
}
console.log(`\n${results.length - failed}/${results.length} 通过`)
if (failed > 0) process.exitCode = 1
