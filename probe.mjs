/**
 * 只读探针：用**真实端点数据**验证目录合并逻辑。跑之前先 mock 掉 fetch，让插件
 * 以为自己在离线环境，再检查它在各种 roster/catalog 组合下的行为。
 * 断言全部基于实测的 OCG /models 与 pi.dev 数据，不含编造的模型。
 *
 * 固件随仓库一起提交（test/fixtures/），所以新克隆后 `npm test` 即可运行，
 * 不需要先联网。刷新固件见 README 的 Probe 一节。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Point the plugin's cache at a throwaway directory before any instance loads.
 *
 * The cache location is resolved once per module instance and memoized, so a
 * scenario that changed the variable later only redirected *new* instances —
 * every earlier one was already writing to the real `~/.dsh` cache. The result
 * was a suite whose outcome depended on whether the developer had DSH running:
 * a leftover catalog got restored at mount, so the first publish was no longer
 * "the installed catalog alone" and the emit counts came out one higher. The suite
 * must read the same empty disk every time, so it gets its own and never the
 * real one.
 */
const CACHE_SANDBOX = mkdtempSync(join(tmpdir(), 'dsh-live-models-probe-'))
process.env.DSH_PROFILE_DIR = CACHE_SANDBOX
process.on('exit', () => { rmSync(CACHE_SANDBOX, { recursive: true, force: true }) })

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

/**
 * One scope's entry out of a cache payload, whichever schema wrote it.
 * @param {any} payload - the parsed cache file.
 * @param {string} providerId - the provider id to read.
 * @returns {any} the entry, or `undefined`.
 */
function cachedScope(payload, providerId) {
  return payload?.scopes?.[providerId]
}

/**
 * A cache payload for one provider, in the schema the plugin currently writes.
 * @param {string} providerId - the provider id.
 * @param {any[]} models - its catalog.
 * @param {string | null} [etag] - its validator.
 * @returns {any} the payload.
 */
function cachePayload(providerId, models, etag = null) {
  return { version: 2, scopes: { [providerId]: { savedAt: Date.now(), etag, models } } }
}

function freshState() {
  delete globalThis[STATE_KEY]
  // The on-disk cache too. Scenarios share one sandbox directory, so a catalog
  // written by an earlier one is restored at the next mount and the picker
  // starts from something other than the installed catalog alone — which shifts
  // the first publish and every emit count after it.
  rmSync(join(CACHE_SANDBOX, 'opencode-live-models-catalog.json'), { force: true })
}

// 真实数据
const liveData = fixture('ocg-models.json')
const OCG_LIVE = liveData.data
const LIVE_IDS = OCG_LIVE.map(m => m.id).sort()
const PI_DEV = fixture('pi-dev-opencode-go.json')
// The installed catalog is copied out of the pi-ai that ships inside the app
// currently installed, so a DSH upgrade that moves pi-ai forward shows up here as
// a real change in what the picker has to keep — not as a number nobody updated.
const CATALOG_INSTALLED = fixture('opencode-go-0.87.1.json')
const CATALOG_SOURCE = 'pi-ai 0.87.1 (from DSH 0.2.0-rc.2)'
const INSTALLED = []
for (const models of Object.values(CATALOG_INSTALLED)) INSTALLED.push(...Object.values(models))
const INSTALLED_IDS = INSTALLED.map(m => m.id).sort()
/**
 * What the picker should hold once both feeds are applied: the installed catalog
 * as a floor, with Pi's additions layered on. Derived rather than written down,
 * because the installed catalog moves with every pi-ai release and a hard-coded
 * number here is a test that fails for a reason nobody wrote it for.
 */
const EXPECTED_UNION_SIZE = new Set([...INSTALLED_IDS, ...PI_DEV.map(m => m.id)]).size

// ── 受控 fetch ────────────────────────────────────────────────────────────────
let mode = 'live'
/**
 * Every request the plugin actually issued, so a test can assert on what went
 * out over the wire rather than on a constant's value in isolation.
 * @type {{ url: string, userAgent: string | null }[]}
 */
const requests = []
globalThis.fetch = async (url, init) => {
  const u = String(url)
  requests.push({ url: u, userAgent: init?.headers?.['user-agent'] ?? null })
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
  getProvider: (id) => (id === OPENCODE_GO ? baseProvider : undefined),
  setProvider: (p) => { patched += 1; Object.assign(baseProvider, p) },
  // The real pi-ai Models collection has this; without it every read that goes
  // through the collection silently yields [] and the drift report undercounts
  // itself — which is exactly how a broken lookup hid behind a green probe.
  getModels: (id) => (id === OPENCODE_GO ? baseProvider.getModels() : []),
}
const OPENCODE_GO = 'opencode-go'
let baseProvider = {
  id: OPENCODE_GO,
  auth: {},
  getModels: () => installedModels.list,
  stream: () => { throw new Error('not used') },
  streamSimple: () => { throw new Error('not used') },
}
const adapter = {
  current() { return { profiles: new Map(), models: collection } },
}
const ctx = {
  llm: { adapters: new Map([[OPENCODE_GO, { adapter }]]) },
  logger: {
    info: (...a) => logs.push(['info', a.join(' ')]),
    warn: (...a) => logs.push(['warn', a.join(' ')]),
    debug: (...a) => logs.push(['debug', a.join(' ')]),
  },
  emit: (ev) => logs.push(['emit', ev]),
  effect: (fn) => fn(),
  on: (ev, fn) => { fn() },
}
// 捕获定时器回调，作为触发后续刷新的入口（等价于 5 分钟后的真实路径）
let intervalFn = null
globalThis.setInterval = (fn) => { intervalFn = fn; return { unref() {} } }
const triggerRefresh = () => { intervalFn?.() ; return new Promise(r => setTimeout(r, 30)) }

const mod = await import('./lib/index.js')
const wait = () => new Promise(r => setTimeout(r, 60))

/**
 * A mock of pi-ai's `Models` collection for one provider.
 *
 * The real collection's `setProvider` does *not* mutate the provider object in
 * place — it stores the object under its id — and that difference is what the
 * unmount scenarios turn on: a mock that assigned onto the base would let the
 * wrapper "restore" the provider while the base object itself never came back.
 * So the wrapper is held beside the raw provider here, and the raw one is what
 * `_original` exposes for an assertion to compare against.
 *
 * `getProvider` and `getModels` only answer for their own provider id: a call
 * for a route this collection does not carry is a bug in the plugin, not a
 * scenario, and returning `undefined` for it is what makes {@link activeScopes}
 * skip the route instead of fetching it.
 * @param {string} providerId - the provider id this collection serves.
 * @param {() => any[]} installed - the installed catalog, read per call.
 * @returns {any} the collection, with `_original` and `_current` for assertions.
 */
function makeColl(providerId, installed, rawFactory) {
  const raw = rawFactory
    ? rawFactory()
    : {
      id: providerId,
      auth: {},
      // pi-ai writes `provider` onto every catalog descriptor, and the merged
      // roster is read back through the model's own provider id — so the mock
      // carries it too, or the plugin would filter nothing and the roster
      // scenarios would pass for the wrong reason.
      getModels: () => installed().map(m => (m && m.provider === undefined ? { ...m, provider: providerId } : m)),
      stream: () => { throw new Error('not used') },
      streamSimple: () => { throw new Error('not used') },
    }
  const coll = {
    _original: raw,
    _current: raw,
    _providerId: providerId,
    /** The catalog in force, i.e. read through whatever wrapper is installed. */
    mergedModels: () => coll._current.getModels(),
    getProvider: id => (id === providerId ? coll._current : undefined),
    setProvider: p => { coll._current = p },
    getModels: id => (id === providerId ? coll._current.getModels() : []),
  }
  return coll
}

/**
 * The adapter registry a mount context carries, for one collection.
 * @param {any} coll - a {@link makeColl} collection.
 * @returns {Map<string, any>} one adapter registration per provider asked for.
 */
function collAdapter(...colls) {
  return new Map(colls.map(coll => [
    coll._providerId,
    { adapter: { current: () => ({ profiles: new Map(), models: coll }) } },
  ]))
}

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

const merged = () => collection.getProvider(OPENCODE_GO).getModels()
const ids = () => merged().map(m => m.id).sort()

// ── 0. 固件与当前 pi-ai 的关系 ──────────────────────────────────────────────
{
  const required = ['name', 'contextWindow', 'maxTokens', 'cost', 'input']
  const incomplete = INSTALLED.filter(m => required.some(f => m[f] === undefined))
  const protos = [...new Set(INSTALLED.map(m => m.api))]
  ok(`已安装目录固件自带全部必需字段（${CATALOG_SOURCE}）`, incomplete.length === 0,
    `${INSTALLED.length} 个模型，缺字段 ${incomplete.length} 个`)
  ok('已安装目录只含本插件支持的协议（不会因上游新增协议而整份被拒）',
    protos.every(p => ['openai-completions', 'openai-responses', 'anthropic-messages'].includes(p)),
    protos.join(', '))
  ok('已安装目录的规模与 Pi 目录同量级（缩水阈值不会误判）',
    Math.abs(INSTALLED.length - PI_DEV.length) <= PI_DEV.length / 2,
    `installed ${INSTALLED.length} / pi.dev ${PI_DEV.length}`)

  // `RATE_FIELDS` in lib/index.js is a written mirror of pi-ai's billing table,
  // and this is what keeps the mirror honest: the comparison is between the
  // fixture's cost keys and the constant the plugin actually gates on, so a new
  // rate on either side shows up here. `calculateCost` is the one place to
  // re-read when it does — a rate the plugin does not know about is a rate its
  // cost gate would be validating a subset of.
  const rateKeys = new Set()
  for (const m of INSTALLED) for (const k of Object.keys(m.cost ?? {})) rateKeys.add(k)
  ok('已安装目录的 cost 字段集与 RATE_FIELDS 一致（计费表变了要重读 calculateCost）',
    [...rateKeys].sort().join() === [...mod.RATE_FIELDS].sort().join(),
    `固件：${[...rateKeys].sort().join(', ') || '(无)'}；RATE_FIELDS：${[...mod.RATE_FIELDS].sort().join(', ')}`)
}

// ── 0.8 user-agent 里的版本不得与 package.json 漂移 ─────────────────────────
{
  // Derived from the manifest rather than written down, because the whole point
  // is that the two cannot disagree: a hard-coded expected version here would
  // pass on the bump that forgot to update the plugin, which is the failure
  // being tested for.
  const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))
  const expected = `${pkg.name}/${pkg.version}`
  const sent = [...new Set(requests.map(r => r.userAgent))]
  ok('发出的 user-agent 带的是 package.json 的当前版本', sent.length === 1 && sent[0] === expected,
    `${requests.length} 个请求，UA 为 ${sent.join(', ') || '(无)'}；package.json 是 ${expected}`)
  // One UA covering both feeds is only meaningful if both feeds were asked.
  const urls = [...new Set(requests.map(r => r.url))]
  ok('两个数据源都在同一次轮询里被请求', urls.length === 2, urls.join('  '))
}

// ── 0.9 计费字段完整：缺一个 rate 就整份拒绝 ───────────────────────────────
{
  // A helper that drives the real gate with whatever catalog it is handed, so a
  // test states a payload rather than restating the rule it is checking.
  const adopt = async (label, catalog) => {
    const mainFetch = globalThis.fetch
    const warns = []
    const coll = makeColl('opencode-go', () => INSTALLED.slice())
    globalThis.fetch = async (url) => {
      const u = String(url)
      if (u.startsWith('https://pi.dev/')) {
        return new Response(JSON.stringify(catalog), { status: 200, headers: { etag: `"synthetic-${label}"` } })
      }
      if (u.startsWith('https://opencode.ai/zen/go/v1/models')) {
        return new Response(JSON.stringify({ data: LIVE_IDS.map(id => ({ id })) }), { status: 200 })
      }
      throw new Error(`unexpected fetch: ${u}`)
    }
    let tick = null
    globalThis.setInterval = fn => { tick = fn; return { unref() {} } }
    freshState()
    const mod = await import(`./lib/index.js?gate-${label}`)
    await mount(mod, {
      llm: { adapters: collAdapter(coll) },
      logger: {
        info: () => {}, warn: (...a) => warns.push(a.join(' ')),
        debug: () => {},
      },
      emit: () => {}, effect: fn => { fn() }, on: () => {},
    })
    const got = coll.mergedModels()
    globalThis.fetch = mainFetch
    return { got, warns }
  }

  // With the catalog refused the picker keeps exactly the installed floor, minus
  // whatever the roster has retired. Nothing is bundled, so there is no third
  // contribution to account for.
  const liveSet = new Set(LIVE_IDS)
  const expectedWhenRefused = INSTALLED_IDS.filter(id => liveSet.has(id)).length

  // Goes through the real path — fetchPiCatalog -> normalizeRemoteModel -> the
  // required-field gate — rather than re-implementing the gate here, which would
  // stay green no matter what the plugin did with `output`.
  const partials = {
    output: (m) => ({ ...m, cost: { input: m.cost.input } }),
    cacheRead: (m) => ({ ...m, cost: { input: m.cost.input, output: m.cost.output } }),
    cacheWrite: (m) => ({ ...m, cost: { input: m.cost.input, output: m.cost.output, cacheRead: m.cost.cacheRead } }),
  }
  // Same floor as above, restated next to the loop that exercises it.
  for (const [drop, mutate] of Object.entries(partials)) {
    const { got, warns } = await adopt(`cost-${drop}`, PI_DEV.map(mutate))
    ok(`cost 缺 ${drop} 的远端目录被整份拒绝（目录退回已安装目录）`,
      got.length === expectedWhenRefused && warns.some(w => w.includes('incomplete descriptors')),
      `目录 ${got.length}（应为 ${expectedWhenRefused}，完整时 ${EXPECTED_UNION_SIZE}），warn: ${warns.find(w => w.includes('incomplete'))?.slice(0, 70) ?? '无'}`)
  }

  // Tiered pricing, via a **synthetic** entry. Neither OCG fixture has tiers
  // today, so this is a guard on a path, not a reproduction of a response —
  // stated here so nobody later reads the scenario as evidence that upstream
  // does this. pi-ai swaps in the whole tier object once a usage threshold is
  // crossed, so a tier missing a rate bills NaN exactly as the base rates do,
  // just later and only for long conversations.
  {
    const withTiers = (tiers) => PI_DEV.map((m, i) => (
      i === 0 ? { ...m, cost: { ...m.cost, tiers } } : m
    ))
    const complete = await adopt('tier-complete', withTiers([{
      inputTokensAbove: 200000,
      input: 2, output: 6, cacheRead: 0.2, cacheWrite: 3,
    }]))
    ok('合成条目：tier 四个费率齐全时整份被采纳（正常的分层定价不会被误拒）',
      complete.got.length === EXPECTED_UNION_SIZE,
      `目录 ${complete.got.length}（完整应为 ${EXPECTED_UNION_SIZE}）`)

    for (const [what, tiers] of [
      ['output', [{ inputTokensAbove: 200000, input: 2, cacheRead: 0.2, cacheWrite: 3 }]],
      ['cacheWrite', [{ inputTokensAbove: 200000, input: 2, output: 6, cacheRead: 0.2 }]],
      ['tiers-not-an-array', { inputTokensAbove: 200000, input: 2, output: 6, cacheRead: 0.2, cacheWrite: 3 }],
    ]) {
      const bad = await adopt(`tier-bad-${what}`, withTiers(tiers))
      ok(`合成条目：tier 缺 ${what}被整份拒绝`,
        bad.got.length === expectedWhenRefused && bad.warns.some(w => w.includes('incomplete descriptors')),
        `目录 ${bad.got.length}（应为 ${expectedWhenRefused}）；告警: ${bad.warns.map(w => w.slice(0, 90)).join(' | ') || '无'}`)
    }
  }
  // Nothing is bundled any more, so there is no local copy that could shadow the
  // installed catalog, and none that could fill a gap either. Only measurable when
  // Pi is unreachable: while the remote catalog loads, Pi's own entry already
  // wins, so asserting on the healthy path would prove nothing.
  {
    const mainFetch = globalThis.fetch
    globalThis.fetch = async (url) => {
      const u = String(url)
      if (u.startsWith('https://pi.dev/')) throw new Error('simulated pi.dev outage')
      if (u.startsWith('https://opencode.ai/zen/go/v1/models')) {
        return new Response(JSON.stringify({ data: LIVE_IDS.map(id => ({ id })) }), { status: 200 })
      }
      throw new Error(`unexpected fetch: ${u}`)
    }
    const coll = makeColl('opencode-go', () => INSTALLED.slice())
    globalThis.setInterval = () => ({ unref() {} })
    freshState()
    const mod = await import('./lib/index.js?no-bundled-descriptors')
    await mount(mod, {
      llm: { adapters: collAdapter(coll) },
      logger: { info: () => {}, warn: () => {}, debug: () => {} },
      emit: () => {}, effect: fn => { fn() }, on: () => {},
    })
    const installedEntry = INSTALLED.find(m => m.id === 'deepseek-v4.1-flash')
    const served = coll.mergedModels().find(m => m.id === 'deepseek-v4.1-flash')
    const gapFilled = coll.mergedModels().find(m => m.id === 'space-bunny')
    ok('Pi 不可达时，内置目录自带的模型仍用内置描述符（没有本地副本可覆盖它）',
      served?.inputLimits !== undefined,
      `内置 inputLimits=${installedEntry?.inputLimits !== undefined}，目录里=${served?.inputLimits !== undefined}`)
    ok('Pi 不可达时不会凭空补出模型（插件不再内置任何描述符）',
      gapFilled === undefined,
      `space-bunny 出现在目录里=${gapFilled !== undefined}`)
    globalThis.fetch = mainFetch
  }
}

// ── 1. 两个代表性模型进入目录 ────────────────────────────────────────────────
// deepseek-v4.1-flash 已安装目录里有（floor 覆盖它），space-bunny 只有 Pi 有
// （floor 覆盖不到，必须靠叠加层补上）。这两个正好是合并逻辑的两条分支。
ok('provider 被包装', patched >= 1, `setProvider 调用 ${patched} 次`)
ok('DeepSeek V4.1 Flash 进入目录', ids().includes('deepseek-v4.1-flash'))
ok('Space Bunny 进入目录', ids().includes('space-bunny'))
{
  const m = merged().find(x => x.id === 'space-bunny')
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
  ok('已安装目录的模型一个不丢', missing.length === 0, `缺: ${missing.join(',') || '无'}`)
}

// ── 3. 覆盖率 ────────────────────────────────────────────────────────────────
{
  const got = ids()
  const liveSet = new Set(LIVE_IDS)
  // 有 descriptor 的 = pi.dev 收录的 ∪ 0.87.1 已有的。其余 10 个是 OCG 已上线但
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
  // 这必须是 10 个：另 4 个（kimi-k2.6、glm-5.1、qwen3.6-plus、qwen3.7-max）
  // 已安装目录里就有，属于**可用**模型，被点名就是漂移报告在说谎。
  //
  // 这里原来还排除了 deepseek-v4.1-flash 和 space-bunny-free，因为内置兜底给过它们
  // 描述符。兜底已删，而这两个 id 现在都由 Pi 的目录覆盖，所以排除项已经变成死代码
  // ——留着只会让人以为它们仍需要特殊处理。集合相等由下面两条断言保证，不需要排除。
  const trulyUnknown = LIVE_IDS.filter(i =>
    !PI_DEV.some(m => m.id === i) && !INSTALLED_IDS.includes(i))
  const onlyInstalled = INSTALLED_IDS.filter(i => !PI_DEV.some(m => m.id === i))
  ok('告警逐个点名了每个无 descriptor 的模型，且不误报任何有描述符的模型',
    named.length === trulyUnknown.length
      && trulyUnknown.every(i => named.includes(i)),
    `点名 ${named.length} 个 = 完全未知 ${trulyUnknown.length} 个；误报 ${named.filter(i => onlyInstalled.includes(i)).join(',') || '无'}`)
}

// ── 5. 降级：pi.dev 挂了 ─────────────────────────────────────────────────────
{
  mode = 'no-pidev'
  logs.length = 0
  await triggerRefresh()
  await wait(); await wait()
  // Pi's feed is the only source of descriptors now, so an outage falls back to
  // the last catalog it did serve — kept in memory, and on disk across restarts.
  // Both ids below are in it, which is the point: they survive on the strength of
  // Pi's catalog, not of a copy bundled in this file.
  ok('pi.dev 不可达时退回 last-known-good 目录',
    ids().includes('deepseek-v4.1-flash') && ids().includes('space-bunny'))
  ok('pi.dev 失败有告警且不静默',
    logs.some(([l, m]) => l === 'warn' && m.includes('catalog refresh failed')))
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
      const target = rows.find(m => m.id === 'space-bunny')
      if (reprice) {
        target.cost = { ...target.cost, input: 0.5, output: 1.5 }
        target.name = 'Space Bunny (repriced)'
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
  const coll = makeColl('opencode-go', () => INSTALLED.slice())
  let tick = null
  globalThis.setInterval = fn => { tick = fn; return { unref() {} } }
  const pLogs = []
  const pCtx = {
    llm: { adapters: collAdapter(coll) },
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

  // Mounting publishes twice: once immediately from the installed catalog alone,
  // once when the background refresh lands. Both are real
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
  const coll = makeColl('opencode-go', () => INSTALLED.slice())
  let tick = null
  globalThis.setInterval = fn => { tick = fn; return { unref() {} } }
  const oLogs = []
  const oCtx = {
    llm: { adapters: collAdapter(coll) },
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
  const orderBefore = coll.mergedModels().map(m => m.id).join(',')
  const bootDescriptors = coll.mergedModels().map(m => ({ ...m }))

  tick?.(); await wait()
  const unchanged = oLogs.filter(([l]) => l === 'emit').length
  reorder = true
  tick?.(); await wait()
  const afterReorder = oLogs.filter(([l]) => l === 'emit').length
  const orderAfter = coll.mergedModels().map(m => m.id).join(',')

  ok('目录顺序真的变了', orderBefore !== orderAfter,
    `${orderBefore.split(',').slice(0, 3)} -> ${orderAfter.split(',').slice(0, 3)} …`)
  // Compare the descriptors DSH actually holds across the two polls, rather
  // than a fixture against a copy of itself, which is true by construction and
  // would stay green no matter what the code under test did.
  const descriptorsBefore = new Map(bootDescriptors.map(m => [m.id, JSON.stringify(m)]))
  const descriptorsAfter = new Map(coll.mergedModels().map(m => [m.id, JSON.stringify(m)]))
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
  const coll = makeColl('opencode-go', () => INSTALLED.slice())
  const adapters = collAdapter(coll)
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
  const immediate = coll.mergedModels().map(m => m.id)
  const emittedNow = events.length

  release()
  await wait(); await wait(); await wait()
  const settled = coll.mergedModels().map(m => m.id)

  ok('挂载在网络返回前就已发布（不阻塞 DSH）',
    emittedNow >= 1 && immediate.length === INSTALLED.length,
    `网络未返回时已发布 ${immediate.length} 个（= 已安装目录 ${INSTALLED.length}），emit ${emittedNow} 次`)
  ok('此时目录就是已安装目录，缺少远端模型属正常',
    !immediate.includes('space-bunny') && immediate.length < settled.length,
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
  const coll = makeColl('opencode-go', () => INSTALLED.slice())
  const adapters = collAdapter(coll)
  let tick = null
  globalThis.setInterval = fn => { tick = fn; return { unref() {} } }
  const logs = []
  freshState()
  const mod = await import('./lib/index.js?etag')
  await mount(mod, {
    llm: { adapters },
    logger: {
      info: () => {},
      warn: (...a) => logs.push(['warn', a.join(' ')]),
      debug: (...a) => logs.push(['debug', a.join(' ')]),
    },
    emit: () => {},
    effect: fn => { fn() },
    on: () => {},
  })
  const afterFirst = coll.mergedModels().map(m => m.id)
  tick?.(); await wait(); await wait(); await wait()
  const afterSecond = coll.mergedModels().map(m => m.id)

  ok('首次请求不带条件头（还没有 ETag）', seen[0] === null, `${seen[0]}`)
  ok('第二次请求带上 If-None-Match', seen[1] === ETAG, `${seen[1]}`)
  // The drift warning is excluded: it names models that lack a descriptor,
  // which says nothing about how 304 is handled. The cache write is not
  // excluded on purpose — DSH_PROFILE_DIR points at a writable sandbox, so a
  // failure to persist there would be real and must fail this assertion.
  const relevantWarn = (m) => !m.includes('have no descriptor yet')
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
  // `cacheDir()` memoizes on first use, so this has to be in place before the
  // instance below is imported — which is exactly what a real DSH start looks
  // like.
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
    const coll = makeColl('opencode-go', () => INSTALLED.slice())
    const adapters = collAdapter(coll)
    let tick = null
    globalThis.setInterval = fn => { tick = fn; return { unref() {} } }
    freshState()
    const mod = await import(`./lib/index.js?persist-${label}`)
    await mount(mod, {
      llm: { adapters },
      logger: { info: () => {}, warn: () => {}, debug: () => {} },
      emit: () => {}, effect: fn => { fn() }, on: () => {},
    })
    return coll.mergedModels().map(m => m.id)
  }

  const first = await runOnce('online')
  let written = null
  try {
    written = JSON.parse(await readFile(join(dir, 'opencode-live-models-catalog.json'), 'utf8'))
  } catch { /* asserted below */ }
  const writtenGo = cachedScope(written, OPENCODE_GO)
  ok('接受后的目录被写入缓存文件',
    Array.isArray(writtenGo?.models) && writtenGo.models.length > 0,
    writtenGo ? `${writtenGo.models.length} 条` : '文件不存在')
  ok('缓存只保存 sanitized 之后的描述符（无可劫持的 baseUrl）',
    Array.isArray(writtenGo?.models)
      && writtenGo.models.every(m => typeof m.baseUrl === 'string' && m.baseUrl.startsWith('https://opencode.ai/')),
    writtenGo ? `baseUrl 样本 ${writtenGo.models[0]?.baseUrl}` : '—')

  // A restart with the network down: the last known good catalog is all there is.
  online = false
  const offline = await runOnce('offline')
  ok('重启后断网仍能恢复上一轮的完整目录', offline.length === first.length && offline.length > INSTALLED.length,
    `在线 ${first.length} → 离线重启 ${offline.length}`)
  ok('离线时用上的是缓存，不是只剩已安装目录',
    offline.includes('space-bunny'),
    `${offline.length} 个（含缓存恢复的描述符）`)

  // A tampered cache must not survive the same validation a live response gets.
  try {
    const { writeFile } = await import('node:fs/promises')
    const hostile = cachePayload(OPENCODE_GO, [{ id: 'cached-evil', api: 'constructor' }])
    await writeFile(join(dir, 'opencode-live-models-catalog.json'), JSON.stringify(hostile), 'utf8')
  } catch { /* asserted below */ }
  const tamperedModels = await runOnce('tampered')
  ok('缓存文件被篡改时按同样规则拒绝（api=constructor 不通过）',
    !tamperedModels.includes('cached-evil'), tamperedModels.includes('cached-evil') ? '★被放行' : '已忽略')

  // A restart that *is* online: the very first request must already be
  // conditional. The cache read and that request race for the validator, and one
  // that wins by microseconds saves nothing — the ETag only went to the trouble
  // of being persisted to be used on the first poll, not the second.
  {
    const { writeFile: wf } = await import('node:fs/promises')
    const CACHED_ETAG = '"restart-etag"'
    await wf(join(dir, 'opencode-live-models-catalog.json'),
      JSON.stringify(cachePayload(OPENCODE_GO, PI_DEV, CACHED_ETAG)), 'utf8')

    const seen = []
    online = true
    globalThis.fetch = async (url, init) => {
      const u = String(url)
      if (u.startsWith('https://pi.dev/')) {
        seen.push(init?.headers?.['if-none-match'] ?? null)
        return new Response(JSON.stringify(PI_DEV), { status: 200, headers: { etag: CACHED_ETAG } })
      }
      if (u.startsWith('https://opencode.ai/zen/go/v1/models')) {
        return new Response(JSON.stringify({ data: LIVE_IDS.map(id => ({ id })) }), { status: 200 })
      }
      throw new Error(`unexpected fetch: ${u}`)
    }

    const onlineFirst = await runOnce('online-restart')
    ok('联网重启：第一次 pi.dev 请求就带上 If-None-Match',
      seen[0] === CACHED_ETAG,
      `首次请求头 ${JSON.stringify(seen[0])}（缓存里的 ETag 是 ${CACHED_ETAG}）`)
    ok('联网重启：目录仍完整', onlineFirst.length > INSTALLED.length, `${onlineFirst.length} 个`)
  }

  // A cache that lost its capacities must be rejected whole, not partly kept.
  const { writeFile } = await import('node:fs/promises')
  const gutted = cachePayload(
    OPENCODE_GO,
    PI_DEV.map(m => ({ id: m.id, api: m.api, name: m.name, input: m.input })),
  )
  await writeFile(join(dir, 'opencode-live-models-catalog.json'), JSON.stringify(gutted), 'utf8')
  const guttedRun = await runOnce('gutted')
  ok('缓存缺少 contextWindow/maxTokens/cost 时整份拒绝，退回网络数据',
    // Rejected whole, so the catalog is what the network returned — complete,
    // not the gutted file quietly half-applied.
    guttedRun.length === EXPECTED_UNION_SIZE && INSTALLED_IDS.every(i => guttedRun.includes(i)),
    `缓存被掏空后目录 ${guttedRun.length}（网络补齐的完整目录）`)

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
    // A collection for the adapter to hang off: without a registered adapter the
    // deferred feed has no baseline to judge against and is correctly left
    // alone, which is what the late-registration guard is for.
    const coll = makeColl('opencode-go', () => INSTALLED.slice())
    const adapters = new Map()
    let onEvt = null
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
        if (cachedScope(parsed, OPENCODE_GO)?.etag) { saved = parsed; break }
      } catch { /* not written yet */ }
      await wait()
    }
    const savedGo = cachedScope(saved, OPENCODE_GO)
    ok('延迟采纳的目录同样落盘（此前这条路径漏掉了）',
      Array.isArray(savedGo?.models) && savedGo.models.length > 0,
      savedGo ? `${savedGo.models.length} 条` : '文件不存在')
    ok('延迟采纳的目录同样记住 ETag', savedGo?.etag === '"deferred-etag"', `${savedGo?.etag}`)
  }

  // Two module instances, two adoptions, one shared state. The invariant is not
  // "the last write wins" but "whatever is on disk is a pair that was actually
  // adopted" — a catalog from one adoption with the ETag of another would be
  // told 304 on the next start and keep serving the stale one forever.
  {
    const { readFile: rf2 } = await import('node:fs/promises')
    const catPath = join(dir, 'opencode-live-models-catalog.json')
    const makeCollection = () => makeColl('opencode-go', () => INSTALLED.slice())

    // Adoption A: the full catalog, tagged "etag-A".
    const first = PI_DEV
    // Adoption B: one model dropped, tagged "etag-B" — a different catalog, so a
    // mismatched pair is detectable from the file alone.
    const second = PI_DEV.filter(m => m.id !== 'muse-spark-1.3-contributor')

    let which = 0
    globalThis.fetch = async (url) => {
      const u = String(url)
      if (u.startsWith('https://pi.dev/')) {
        const rows = which === 0 ? first : second
        return new Response(JSON.stringify(rows), { status: 200, headers: { etag: `"etag-${which === 0 ? 'A' : 'B'}"` } })
      }
      if (u.startsWith('https://opencode.ai/zen/go/v1/models')) {
        return new Response(JSON.stringify({ data: LIVE_IDS.map(id => ({ id })) }), { status: 200 })
      }
      throw new Error(`unexpected fetch: ${u}`)
    }

    const collA = makeCollection()
    const collB = makeCollection()
    const ctxFor = adapters => ({
      llm: { adapters },
      logger: { info: () => {}, warn: () => {}, debug: () => {} },
      emit: () => {}, effect: fn => { fn() }, on: () => {},
    })

    freshState()
    which = 0
    const modA = await import('./lib/index.js?pair-a')
    await mount(modA, ctxFor(new Map([['opencode-go', { adapter: { current: () => ({ models: collA }) } }]])))

    // A second instance — a hot reload — takes over the same state and adopts a
    // different catalog while the first write may still be queued.
    which = 1
    const modB = await import('./lib/index.js?pair-b')
    await mount(modB, ctxFor(new Map([['opencode-go', { adapter: { current: () => ({ models: collB }) } }]])))

    let final = null
    for (let i = 0; i < 40; i += 1) {
      try {
        const parsed = JSON.parse(await rf2(catPath, 'utf8'))
        if (cachedScope(parsed, OPENCODE_GO)?.etag === '"etag-B"') { final = parsed; break }
      } catch { /* not written yet */ }
      await wait()
    }

    const aIds = new Set(first.map(m => m.id))
    const bIds = new Set(second.map(m => m.id))
    const onDiskGo = cachedScope(final, OPENCODE_GO)
    const onDisk = new Set(onDiskGo?.models?.map(m => m.id) ?? [])
    const isA = onDisk.size === aIds.size && [...aIds].every(id => onDisk.has(id))
    const isB = onDisk.size === bIds.size && [...bIds].every(id => onDisk.has(id))
    const paired = (isA && onDiskGo?.etag === '"etag-A"') || (isB && onDiskGo?.etag === '"etag-B"')

    ok('跨模块实例：写队列共享，后写入的目录最终生效',
      onDiskGo?.etag === '"etag-B"' && isB,
      `落盘 etag=${final?.etag}，目录${isB ? '与 B 一致' : isA ? '★是旧的 A' : '★两者都不是'}`)
    ok('目录与 ETag 始终来自同一次采纳（不会拼出错配）',
      paired,
      `落盘组合 etag=${final?.etag} + ${isB ? '目录B' : isA ? '目录A' : '未知目录'}`)
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
  ok('Pi 提供的模型不受 roster 影响（网关缺口≠下架，跟随 Pi 更新）',
    after.includes('space-bunny') && after.includes('deepseek-v4.1-flash'))
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
    const coll = makeColl('opencode-go', () => INSTALLED.slice())
    const sLogs = []
    let tick = null
    globalThis.setInterval = fn => { tick = fn; return { unref() {} } }
    const sCtx = {
      llm: { adapters: collAdapter(coll) },
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
      snap: () => coll.mergedModels().map(m => m.id),
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

// ── 7.55 roster 的信封：换一种包法也必须读得出来 ─────────────────────────────
{
  const mainFetch = globalThis.fetch
  /**
   * A cold provider of its own, so one envelope cannot leave its wrapper or its
   * roster behind for the next case.
   * @param {string} label - unique module query for a fresh plugin instance.
   * @param {any} body - what the gateway answers with.
   * @returns {Promise<{ ids: string[], warns: string[] }>} the catalog and the warnings.
   */
  const rosterAs = async (label, body) => {
    globalThis.fetch = async (url) => {
      const u = String(url)
      if (u.startsWith('https://pi.dev/')) return new Response(JSON.stringify(PI_DEV), { status: 200 })
      return new Response(JSON.stringify(body), { status: 200 })
    }
    const coll = makeColl('opencode-go', () => INSTALLED.slice())
    const warns = []
    const debugs = []
    freshState()
    const mod = await import(`./lib/index.js?envelope-${label}`)
    await mount(mod, {
      llm: { adapters: collAdapter(coll) },
      logger: { info: () => {}, warn: (m) => warns.push(m), debug: (m) => debugs.push(m) },
      emit: () => {}, effect: () => {}, on: () => {},
    })
    return { ids: coll.mergedModels().map(m => m.id), warns, debugs }
  }

  // The roster arrived as `{ object, data }` until now, and the parser that read
  // it knew only that shape plus a bare array. A gateway that re-enveloped itself
  // would have produced an empty roster, which reads as "OCG serves nothing" and
  // deletes models from the picker. One parser serves both feeds now, so the
  // roster tolerates the shapes Pi's catalog already tolerated.
  //
  // Asserted on the roster being *accepted*, not on the catalog size: a refused
  // roster leaves `liveModelIds` null, which filters nothing, and every installed
  // model here is one the gateway serves — so a misread envelope and a correct
  // one produce the same 33 ids. The catalog cannot tell them apart; the log can.
  for (const [label, body] of [
    ['models 分组 map', { models: Object.fromEntries(OCG_LIVE.map(m => [m.id, m])) }],
    ['models 数组', { object: 'list', models: OCG_LIVE }],
    ['单层 id map', Object.fromEntries(OCG_LIVE.map(m => [m.id, m]))],
    ['裸数组', OCG_LIVE],
  ]) {
    const { warns, debugs } = await rosterAs(label, body)
    const accepted = debugs.find(d => d.includes('currently exposes'))
    ok(`roster 包成「${label}」时被读出并采纳`, accepted !== undefined && !warns.some(w => w.includes('empty roster')),
      accepted?.slice(0, 70) ?? `被拒：${warns.find(w => w.includes('roster'))?.slice(0, 60) ?? '未知原因'}`)
  }

  // The tolerance must not become a way to *invent* a roster: rows with no string
  // `id` are not a roster however they are wrapped, and have to arrive as the
  // refusal they are rather than as a plausible-looking subset.
  const bogus = await rosterAs('无法识别', { error: { message: 'nope' } })
  ok('无法识别的 roster 信封被拒，而不是被读成空名单',
    bogus.warns.some(w => w.includes('empty roster')),
    bogus.warns.find(w => w.includes('empty roster'))?.slice(0, 70) ?? `目录 ${bogus.ids.length} 个，无 empty roster 告警`)

  globalThis.fetch = mainFetch
}


{
  const mainFetch = globalThis.fetch
  // The real catalog travels with the hostile entries: a 3-entry response would
  // now be (correctly) refused as a suspicious shrink, and that is a different
  // test. This section is about endpoints and headers, not about size.
  const HOSTILE = [
    ...PI_DEV,
    { id: 'evil-completions', name: 'Evil Completions', contextWindow: 1000, maxTokens: 500, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, api: 'openai-completions', baseUrl: 'https://evil.example/v1', headers: { 'x-api-key': 'stolen' }, type: 'chat' },
    { id: 'evil-anthropic', name: 'Evil Anthropic', contextWindow: 1000, maxTokens: 500, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, api: 'anthropic-messages', baseUrl: 'https://evil.example', headers: { authorization: 'Bearer stolen' }, type: 'chat' },
    { id: 'evil-unknown-api', name: 'Evil Unknown', contextWindow: 1000, maxTokens: 500, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, api: 'some-future-transport', baseUrl: 'https://evil.example', type: 'chat' },
    { id: 'evil-constructor-api', name: 'Evil Ctor', contextWindow: 1000, maxTokens: 500, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, api: 'constructor', type: 'chat' },
    { id: 'evil-proto-api', name: 'Evil Proto', contextWindow: 1000, maxTokens: 500, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, api: '__proto__', type: 'chat' },
  ]
  globalThis.fetch = async (url) => {
    const u = String(url)
    if (u.startsWith('https://pi.dev/')) return new Response(JSON.stringify(HOSTILE), { status: 200 })
    if (u.startsWith('https://opencode.ai/zen/go/v1/models')) {
      return new Response(JSON.stringify({ data: LIVE_IDS.map(id => ({ id })) }), { status: 200 })
    }
    throw new Error(`unexpected fetch: ${u}`)
  }
  const coll = makeColl('opencode-go', () => INSTALLED.slice())
  globalThis.setInterval = () => ({ unref() {} })
  const hCtx = {
    llm: { adapters: collAdapter(coll) },
    logger: { info: () => {}, warn: () => {}, debug: () => {} },
    emit: () => {}, effect: fn => fn(), on: () => {},
  }
    freshState()
  const hostile = await import('./lib/index.js?hostile')
  await mount(hostile, hCtx)
  const got = coll.mergedModels()
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
      id: 'control-plane', name: 'Control Plane', contextWindow: 1000, maxTokens: 500, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, api: 'openai-completions', type: 'chat',
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
      name: 'Future Model', contextWindow: 1000, maxTokens: 500, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
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
  const coll = makeColl('opencode-go', () => INSTALLED.slice())
  let tick = null
  globalThis.setInterval = fn => { tick = fn; return { unref() {} } }
  const mLogs = []
  const mCtx = {
    llm: { adapters: collAdapter(coll) },
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

  const control = coll.mergedModels().find(m => m.id === 'control-plane')
  const future = coll.mergedModels().find(m => m.id === 'future-model')
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
  const collection2 = makeColl('opencode-go', () => INSTALLED.slice())
  const ctx2 = {
    llm: { adapters: collAdapter(collection2) },
    logger: { info: () => {}, warn: () => {}, debug: () => {} },
    emit: () => {},
    effect: () => {},
    on: () => {},
  }
  // The query makes ESM load a *fresh* instance, so its module-level
  // remoteCatalog starts empty — the state of a first boot with no network.
freshState()
  const fresh = await import('./lib/index.js?firstboot')
  await mount(fresh, ctx2)
  const order2 = collection2.mergedModels().map(m => m.id)
  const liveSet = new Set(LIVE_IDS)
  const installedOrder = INSTALLED.map(m => m.id).filter(id => liveSet.has(id))
  ok('首次启动即 pi.dev 不可达：退回 installed 原序（无主序时不臆造顺序）',
    order2.slice(0, installedOrder.length).join() === installedOrder.join(),
    order2.slice(0, 5).join(', '))
  ok('首次启动即降级时目录就是已安装目录（没有内置兜底可补）',
    !order2.includes('space-bunny') && order2.includes('deepseek-v4.1-flash'),
    `${order2.length} 个`)
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
      // TRACED
    }
    const coll = makeColl('opencode-go', () => INSTALLED.slice())
    let tick = null
    globalThis.setInterval = fn => { tick = fn; return { unref() {} } }
    const sLogs = []
    const sCtx = {
      llm: { adapters: collAdapter(coll) },
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
      snap: () => coll.mergedModels().map(m => m.id),
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
      snap.length === EXPECTED_UNION_SIZE,
      `目录 ${snap.length} 个（应为 ${EXPECTED_UNION_SIZE}；名单被采纳会少掉 installed-only 的模型）`)
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
    // `mount` waits a fixed 300ms and the mocked round trip takes as long as
    // `DELAY`, so the two race: on a slow runner the refresh lands just after
    // `scripted` returns. Wait for the catalog rather than for the clock, and
    // keep the assertion strict — a refresh that never lands still fails it.
    for (let i = 0; i < 10 && s.snap().length !== EXPECTED_UNION_SIZE; i += 1) await wait()
    ok('并行取数后目录仍正确', s.snap().length === EXPECTED_UNION_SIZE, `${s.snap().length} 个模型（应为 ${EXPECTED_UNION_SIZE}）`)
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
    const coll = makeColl('opencode-go', () => INSTALLED.slice())
    let tick = null
    globalThis.setInterval = fn => { tick = fn; return { unref() {} } }
    const cLogs = []
    const cCtx = {
      llm: { adapters: collAdapter(coll) },
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
      snap: () => coll.mergedModels().map(m => m.id),
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
      s.warns().some(w => w.includes('catalog refresh failed')), s.warns().find(w => w.includes('catalog refresh failed'))?.slice(0, 110) ?? '无')
  }

  // The other direction: a new envelope that is *populated* is a new shape, not
  // a failure, and must not be mistaken for one.
  {
    const s = await catalogScenario('cat-dataenvelope', { data: PI_DEV })
    const good = s.snap().length
    await s.step()
    ok('envelope 变成 data 但内容正常时被正确识别，不误杀',
      s.snap().length === good && !s.warns().some(w => w.includes('catalog refresh failed')),
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
    // A real provider slot, not `Object.assign(base, p)`: the unload path
    // restores a provider only while ours is still the installed one, and a
    // mock that mutates in place makes that identity check permanently false —
    // hiding the bug instead of testing it. `makeColl` holds the wrapper beside
    // the raw provider for exactly that check.
    const coll = makeColl('opencode-go', () => INSTALLED.slice())
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
      snap: () => coll.mergedModels().map(m => m.id),
      installedOnly: () => INSTALLED_IDS.filter(i => !PI_DEV.some(m => m.id === i)),
      warns: () => sLogs.filter(([l]) => l === 'warn').map(([, m]) => m),
      /**
       * Advance the scripted gateway by one poll.
       *
       * The wait happens *before* the tick as well as after: `attach()` starts a
       * first poll of its own, and a tick fired while that one is still in flight
       * is joined to it instead of starting the next request — which left the
       * baseline at the installed catalog and made a "consecutive" scenario look
       * like two unrelated observations.
       */
      step: async () => {
        poll += 1
        await wait(); await wait()
        tick?.()
        await wait(); await wait(); await wait()
      },
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
    await wait(); await wait(); await wait(); await wait()
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
    // The adapter update is what starts the first poll; four ticks is what it
    // takes for that poll to land in the scenarios here.
    await wait(); await wait(); await wait(); await wait()
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
    await wait(); await wait(); await wait(); await wait()
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
  }

  // (d) 热重载：新实例接管共享 state，旧 wrapper 反映新数据
  {
    const rows = [...PI_DEV, { id: 'hot-reload-new', name: 'Hot New', contextWindow: 2000, maxTokens: 1000, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, api: 'openai-completions', type: 'chat' }]
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
    const coll = makeColl('opencode-go', () => INSTALLED.slice())
    const adapters = collAdapter(coll)
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
    const wrapped = coll.getProvider(OPENCODE_GO)
    const beforeReload = coll.mergedModels().map(m => m.id)

    const second = await import('./lib/index.js?hmr-second')
    await mount(second, makeCtx([]))
    const sameWrapper = coll.getProvider(OPENCODE_GO) === wrapped
    poll = 1   // the next poll is the one that carries the new descriptor
    tick?.(); await wait(); await wait(); await wait()
    const afterReload = coll.mergedModels().map(m => m.id)

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
    await wait(); await wait(); await wait(); await wait()
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
    const coll = makeColl('opencode-go', () => INSTALLED.slice())
    const adapters = collAdapter(coll)
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
    const shownByNew = coll.mergedModels().map(m => m.id).length

    release()
    await wait(); await wait(); await wait()
    const afterOld = coll.mergedModels().map(m => m.id)

    ok('旧实例的请求在新实例之后返回，目录不被它覆盖',
      afterOld.length === shownByNew,
      `新实例 ${shownByNew} 个 → 旧请求返回后 ${afterOld.length} 个`)
    ok('旧实例的缩水名单被丢弃，installed-only 模型未消失',
      afterOld.length > INSTALLED.length,
      `目录 ${afterOld.length} 个（installed-only 全部在列）`)
  }

  // (f) 新实例先挂载、旧实例后卸载：旧实例不得拆掉新实例的补丁
  {
    const coll = makeColl('opencode-go', () => INSTALLED.slice())
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
    const overlaid = coll.mergedModels().map(m => m.id).length
    const providerAfterMount = coll.getProvider(OPENCODE_GO)

    const secondEnv = makeEnv()
    const second = await import('./lib/index.js?order-new')
    await mount(second, secondEnv.ctx)
    const afterMount = coll.mergedModels().map(m => m.id).length

    // The old instance unloads *after* the new one has taken over.
    firstEnv.dispose()
    await wait(); await wait()
    const afterOldUnload = coll.mergedModels().map(m => m.id).length

    ok('新挂载后旧卸载：旧实例不拆掉新实例的 provider',
      coll.getProvider(OPENCODE_GO) === providerAfterMount,
      coll.getProvider(OPENCODE_GO) === providerAfterMount ? '仍是新实例的 provider' : '★已被还原')
    ok('新挂载后旧卸载：adapter.current 仍被包装',
      adapter.current !== originalCurrent,
      adapter.current === originalCurrent ? '★被旧实例退掉了' : '仍保持包装')
    ok('新挂载后旧卸载：目录仍是叠加后的数量，未退回原安装目录',
      afterOldUnload === afterMount && afterMount === overlaid && afterOldUnload > INSTALLED.length,
      `挂载后 ${afterMount} → 旧卸载后 ${afterOldUnload}（期望 ${overlaid}）`)

    // The current instance must still be able to clean up after itself.
    secondEnv.dispose()
    ok('当前实例卸载时仍能正常还原',
      adapter.current === originalCurrent && coll.getProvider(OPENCODE_GO) === coll._original,
      `adapter ${adapter.current === originalCurrent ? '已恢复' : '★未恢复'}，provider ${coll.getProvider(OPENCODE_GO) === coll._original ? '已恢复' : '★未恢复'}`)
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
    const coll = makeColl('opencode-go', () => INSTALLED.slice())
    const adapters = collAdapter(coll)
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
    const models = () => coll.mergedModels()
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
    const coll = makeColl('opencode-go', () => INSTALLED.slice())
    const adapters = collAdapter(coll)
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
    mod.apply(quiet())
    // The first refresh waits on the cache read, so give it room to actually
    // start before counting — otherwise the guard under test is never exercised
    // and the numbers below are all zero.
    await wait(); await wait(); await wait()
    const secondCount = hits
    // Without a per-generation guard this would be handed the first mount's
    // in-flight refresh, whose result is then dropped by the generation check —
    // leaving the new mount with nothing and the picker on the installed catalog
    // alone.
    mod.apply(quiet())
    await wait(); await wait(); await wait()
    const hitsAfterSecond = hits
    release()
    await wait(); await wait(); await wait()
    const models = coll.mergedModels().map(m => m.id)

    ok('同一模块二次 apply 会另起一轮刷新，不复用上一代的 in-flight 请求',
      hitsAfterSecond > secondCount,
      `首次挂载已发 ${secondCount} 次，二次挂载后共 ${hitsAfterSecond} 次`)
    ok('二次挂载的首轮数据未被丢弃，目录完整',
      models.length > INSTALLED.length,
      `目录 ${models.length} 个（installed-only 全部在列）`)
  }

  globalThis.fetch = mainFetch
}

// ── 8.5 缓存保活：只有 DS 模型拿到 long retention ─────────────────────────
//
// `cacheRetention` is the only switch pi-ai exposes for `prompt_cache_key` and
// `prompt_cache_retention: "24h"`, the two fields that keep the gateway's prefix
// cache alive past its own ~5-minute window. It is provider-level in pi-ai, so
// the wrapper is the only place a per-model filter can exist.
{
  const mainFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    const u = String(url)
    if (u.startsWith('https://pi.dev/')) return new Response(JSON.stringify(PI_DEV), { status: 200 })
    if (u.startsWith('https://opencode.ai/zen/go/v1/models')) {
      return new Response(JSON.stringify({ data: LIVE_IDS.map(id => ({ id })) }), { status: 200 })
    }
    throw new Error(`unexpected fetch: ${u}`)
  }

  // Stand in for the provider's own entry points and echo back what the wrapper
  // dispatched with. Real pi-ai reads `options.cacheRetention` inside
  // `resolveCacheRetention`, so this is that seam without pi-ai being present.
  const seen = []
  const makeProvider = () => ({
    id: 'opencode-go',
    getModels: () => INSTALLED.slice(),
    stream: (model, context, options) => { seen.push(options); return options },
    streamSimple: (model, context, options) => { seen.push(options); return options },
  })
  // A real swap, as pi-ai's `setProvider` does. The alternative used elsewhere in
  // this file — an in-place `Object.assign` of the wrapper onto the base — would
  // point the wrapper's own `base.streamSimple` at itself, because both entry
  // points forward: that mock recurses instead of dispatching, which is why the
  // shared fixtures leave those two methods throwing "not used".
  const coll = makeColl('opencode-go', () => INSTALLED.slice(), makeProvider)
  globalThis.setInterval = () => ({ unref() {} })
  freshState()
  const mod = await import('./lib/index.js?dispatch-cache')
  const ctxFor = models => ({
    llm: { adapters: collAdapter(coll) },
    logger: { info: () => {}, warn: () => {}, debug: () => {} },
    emit: () => {}, effect: fn => { fn() }, on: () => {},
  })
  await mount(mod, ctxFor(coll))

  const options = { sessionId: 'probe-session', maxTokens: 4096 }
  const call = (method, id) => coll.getProvider(OPENCODE_GO)[method]({ id }, {}, options)

  // Read the sets off the merged catalog rather than writing ids down here, so a
  // model Pi adds or retires later moves the assertion with it.
  const all = coll.mergedModels().map(m => m.id)
  const dsIds = all.filter(id => /^deepseek/i.test(id))
  const restIds = all.filter(id => !/^deepseek/i.test(id))

  const patched = dsIds.filter(id => call('streamSimple', id)?.cacheRetention === 'long')
  ok('目录里每个 DeepSeek 模型都拿到 cacheRetention: long',
    dsIds.length > 0 && patched.length === dsIds.length,
    `${patched.length}/${dsIds.length}：${dsIds.join(', ')}`)

  // Identity, not deep equality: for a model the policy does not name the very
  // same object has to come through, so an accidental extra key cannot pass.
  const untouched = restIds.filter(id => call('streamSimple', id) === options)
  ok('非 DeepSeek 模型原样透传（同一个 options 对象，未复制未改写）',
    restIds.length > 0 && untouched.length === restIds.length,
    `${untouched.length}/${restIds.length} 原样返回`)

  ok('注入不覆盖调用方已有的 options 字段',
    call('streamSimple', dsIds[0])?.maxTokens === 4096
      && call('streamSimple', dsIds[0])?.sessionId === 'probe-session',
    JSON.stringify(call('streamSimple', dsIds[0])))

  ok('调用方不传 options 时仍能注入',
    coll.getProvider(OPENCODE_GO).streamSimple({ id: dsIds[0] }, {}, undefined)?.cacheRetention === 'long')

  ok('stream 与 streamSimple 走同一条策略',
    call('stream', dsIds[0])?.cacheRetention === 'long' && call('stream', restIds[0]) === options,
    `${dsIds[0]} 注入 / ${restIds[0]} 原样`)

  ok('dispatchPatch 对非对象入参不抛错',
    mod.dispatchPatch(null) === null && mod.dispatchPatch(undefined) === null
      && mod.dispatchPatch('deepseek-v4-pro') === null,
    'null / undefined / 字符串都返回 null')

  // A second instance takes over the shared state while the first wrapper is
  // still installed — the hot-reload path. The wrapper left behind closes over
  // the *old* module, so it can only keep working by reading the state slot.
  {
    const seenBefore = seen.length
    // The same collection: a second instance taking over the shared state is the
    // hot-reload path, and a fresh collection would test nothing about the
    // wrapper the first instance left behind on this one.
    const modB = await import('./lib/index.js?dispatch-cache-reload')
    await mount(modB, ctxFor(coll))
    const stillPatched = coll.getProvider(OPENCODE_GO)
      .streamSimple({ id: dsIds[0] }, {}, options)?.cacheRetention === 'long'
    ok('热重载后旧包装仍按当前策略注入（策略读共享 state，不是旧闭包）',
      stillPatched && seen.length > seenBefore,
      stillPatched ? '旧 provider 仍注入 long' : '★旧包装静默失效')
  }

  globalThis.fetch = mainFetch
}

// ── 8.6 opencode 路由的会话头 ─────────────────────────────────────────────
//
// pi-ai's own injection is bound to its two provider descriptors, so a route the
// harness built for a custom id — same gateway, different id — would reach the
// gateway with no session header and be refused with `400 MissingSessionID`. The
// wrapper therefore goes on the `Models` prototype, which is also the only layer
// that survives a collection rebuild.
{
  const mainFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    const u = String(url)
    if (u.startsWith('https://pi.dev/')) return new Response(JSON.stringify(PI_DEV), { status: 200 })
    if (u.startsWith('https://opencode.ai/zen/go/v1/models')) {
      return new Response(JSON.stringify({ data: LIVE_IDS.map(id => ({ id })) }), { status: 200 })
    }
    throw new Error(`unexpected fetch: ${u}`)
  }

  // A class rather than an object literal: the wrapper goes on the prototype, and
  // a literal's prototype is `Object.prototype`, which the installer refuses.
  class FakeModels {
    constructor() { this.registered = new Map() }
    getProvider(id) { return this.registered.get(id) }
    setProvider(provider) { this.registered.set(provider.id, provider) }
    getModels(id) { return this.registered.get(id)?.getModels() ?? [] }
    providerFor(model) {
      const provider = this.registered.get(model.provider)
      if (provider === undefined) throw new Error(`unknown provider ${model.provider}`)
      return provider
    }
    stream(model, context, options) { return this.providerFor(model).stream(model, context, options) }
    streamSimple(model, context, options) { return this.providerFor(model).streamSimple(model, context, options) }
  }
  const echo = id => ({
    id,
    getModels: () => INSTALLED.slice(),
    stream: (model, context, options) => options,
    streamSimple: (model, context, options) => options,
  })

  const models = new FakeModels()
  models.setProvider(echo('opencode-go'))
  models.setProvider(echo('deepseek'))        // the official route: untouched
  models.setProvider(echo('opencode-go-ds'))  // a custom id on the same gateway

  const originalStream = FakeModels.prototype.stream
  const originalStreamSimple = FakeModels.prototype.streamSimple
  const disposers = []
  globalThis.setInterval = () => ({ unref() {} })
  freshState()
  const mod = await import('./lib/index.js?session-headers')
  await mount(mod, {
    // An explicit map: this scenario builds its own `FakeModels` class rather
    // than a `makeColl` collection, so there is no `_providerId` to derive from.
    llm: { adapters: new Map([['opencode-go', { adapter: { current: () => ({ models }) } }]]) },
    logger: { info: () => {}, warn: () => {}, debug: () => {} },
    emit: () => {}, on: () => {},
    effect: (fn) => { const d = fn(); if (typeof d === 'function') disposers.push(d) },
  })

  const dispatch = (model, options) => models.streamSimple(model, {}, options)
  const GC = { id: 'x', provider: 'opencode-go' }

  const routed = dispatch(GC, { sessionId: 'sess-1' })
  ok('opencode-go 路由带上会话头与客户端标识',
    routed?.headers?.['x-opencode-session'] === 'sess-1'
      && routed?.headers?.['x-opencode-client'] === 'dsh',
    JSON.stringify(routed?.headers))

  const custom = dispatch(
    { id: 'x', provider: 'opencode-go-ds', baseUrl: 'https://opencode.ai/zen/go/v1' },
    { sessionId: 'sess-1' },
  )
  ok('自定义 provider 键按 baseUrl 兜底（内置注入覆盖不到这条路由）',
    custom?.headers?.['x-opencode-session'] === 'sess-1'
      && custom?.headers?.['x-opencode-client'] === 'dsh',
    JSON.stringify(custom?.headers))

  const untouched = { sessionId: 'sess-1' }
  ok('非 opencode 路由原样透传（同一个 options 对象）',
    dispatch({ id: 'x', provider: 'deepseek', baseUrl: 'https://api.deepseek.com' }, untouched) === untouched)

  const anonymous = dispatch(GC, {})
  ok('没有会话 ID 时不注入会话头，但客户端标识仍然发',
    anonymous?.headers?.['x-opencode-session'] === undefined
      && anonymous?.headers?.['x-opencode-client'] === 'dsh',
    JSON.stringify(anonymous?.headers))

  const pinned = dispatch(GC, { sessionId: 'sess-1', headers: { 'X-Opencode-Session': 'mine' } })
  ok('显式配置的会话头优先，且大小写不敏感',
    pinned?.headers?.['X-Opencode-Session'] === 'mine'
      && pinned?.headers?.['x-opencode-session'] === undefined,
    JSON.stringify(pinned?.headers))

  const modelPinned = dispatch(
    { id: 'x', provider: 'opencode-go', headers: { 'x-opencode-session': 'model-level' } },
    { sessionId: 'sess-1' },
  )
  ok('模型描述符上的会话头同样优先',
    modelPinned?.headers?.['x-opencode-session'] === undefined,
    JSON.stringify(modelPinned?.headers))

  ok('stream 与 streamSimple 都被覆盖',
    models.stream(GC, {}, { sessionId: 'sess-1' })?.headers?.['x-opencode-session'] === 'sess-1')

  // The two policies meet on one request: the prototype wrapper adds headers, the
  // provider wrapper adds the cache option, and neither overwrites the other.
  const both = dispatch({ id: 'deepseek-v4.1-flash', provider: 'opencode-go' }, { sessionId: 'sess-1' })
  ok('会话头与 cacheRetention 在同一请求上叠加',
    both?.headers?.['x-opencode-session'] === 'sess-1' && both?.cacheRetention === 'long',
    JSON.stringify(both))

  ok('isOpencodeRoute：provider 身份与 baseUrl 都认，其余都不认',
    mod.isOpencodeRoute({ provider: 'opencode-go' }) === true
      && mod.isOpencodeRoute({ provider: 'opencode' }) === true
      && mod.isOpencodeRoute({ provider: 'custom', baseUrl: 'https://opencode.ai/zen/go/v1' }) === true
      && mod.isOpencodeRoute({ provider: 'deepseek', baseUrl: 'https://api.deepseek.com' }) === false
      && mod.isOpencodeRoute(null) === false
      && mod.isOpencodeRoute({ provider: 'x', baseUrl: 'not a url' }) === false)

  for (const dispose of disposers) dispose()
  ok('卸载后 models prototype 恢复原函数',
    FakeModels.prototype.stream === originalStream && FakeModels.prototype.streamSimple === originalStreamSimple,
    FakeModels.prototype.stream === originalStream ? '两个入口都还原' : '★仍有包装残留')
  ok('卸载后不再注入', dispatch(GC, { sessionId: 'sess-1' })?.headers === undefined)

  globalThis.fetch = mainFetch
}

// ── 8.9 OpenCode Zen：第二条路由同样被刷新 ────────────────────────────────
//
// `opencode` and `opencode-go` are different wire endpoints, so the plugin polls
// both: Zen's catalog comes from pi.dev under its own provider id and its roster
// from `/zen/v1/models`, and the fixtures here are what those two endpoints
// actually answer. The Gemini entries ride pi-ai's own Google transport at the
// base URL Pi publishes, and Pi's two `type: "classifier"` rows are named and
// skipped rather than published — they carry no `maxTokens` and have no business
// in a chat picker.
{
  const mainFetch = globalThis.fetch
  const ZEN_DIRECTORY = fixture('pi-dev-opencode.json')
  const ZEN_LIVE = fixture('zen-models.json').data
  const ZEN_CHAT = ZEN_DIRECTORY.filter(m => m.type !== 'classifier')
  const ZEN_INSTALLED = []
  for (const models of Object.values(fixture('opencode-0.87.1.json'))) ZEN_INSTALLED.push(...Object.values(models))
  const ZEN_INSTALLED_IDS = new Set(ZEN_INSTALLED.map(m => m.id))
  const ZEN_LIVE_IDS = new Set(ZEN_LIVE.map(m => m.id))
  const OPERABLE_ZEN_PROTOCOLS = new Set([
    'anthropic-messages', 'openai-completions', 'openai-responses', 'google-generative-ai',
  ])

  globalThis.fetch = async (url) => {
    const u = String(url)
    if (u.includes('/providers/opencode-go')) {
      return new Response(JSON.stringify(PI_DEV), { status: 200, headers: { etag: '"go"' } })
    }
    if (u.includes('/providers/opencode')) {
      return new Response(JSON.stringify(ZEN_DIRECTORY), { status: 200, headers: { etag: '"zen"' } })
    }
    if (u.startsWith('https://opencode.ai/zen/go/v1/models')) {
      return new Response(JSON.stringify(liveData), { status: 200 })
    }
    if (u.startsWith('https://opencode.ai/zen/v1/models')) {
      return new Response(JSON.stringify({ data: ZEN_LIVE }), { status: 200 })
    }
    throw new Error(`unexpected fetch: ${u}`)
  }

  const goColl = makeColl('opencode-go', () => INSTALLED.slice())
  const zenColl = makeColl('opencode', () => ZEN_INSTALLED.slice())
  const zenLogs = []
  let tick = null
  globalThis.setInterval = fn => { tick = fn; return { unref() {} } }
  freshState()
  const dual = await import('./lib/index.js?dual-scope')
  await mount(dual, {
    llm: { adapters: collAdapter(goColl, zenColl) },
    logger: {
      info: (...a) => zenLogs.push(['info', a.join(' ')]),
      warn: (...a) => zenLogs.push(['warn', a.join(' ')]),
      debug: (...a) => zenLogs.push(['debug', a.join(' ')]),
    },
    emit: () => {}, effect: fn => { fn() }, on: () => {},
  })

  const idsOf = coll => new Set(coll.mergedModels().map(m => m.id))
  const zenModel = id => zenColl.mergedModels().find(m => m.id === id)
  const zenIds = idsOf(zenColl)
  const goIds = idsOf(goColl)

  ok('Zen 路由被刷新：目录不再等于安装时的那份快照',
    zenIds.size > ZEN_INSTALLED_IDS.size || [...ZEN_LIVE_IDS].some(id => zenIds.has(id) && !ZEN_INSTALLED_IDS.has(id)),
    `Zen 目录 ${zenIds.size} 个（已安装快照 ${ZEN_INSTALLED_IDS.size} 个）`)
  ok('Pi 目录为 Zen 发布的每个聊模型都进了目录',
    ZEN_CHAT.every(m => zenIds.has(m.id)),
    `${ZEN_CHAT.length} 个中缺 ${ZEN_CHAT.filter(m => !zenIds.has(m.id)).map(m => m.id).join(',') || '无'}`)
  ok('Zen 实时名单里还在、而已安装快照里也有的模型一个不丢',
    ZEN_INSTALLED.every(m => !ZEN_LIVE_IDS.has(m.id) || zenIds.has(m.id)),
    `丢 ${ZEN_INSTALLED.filter(m => ZEN_LIVE_IDS.has(m.id) && !zenIds.has(m.id)).map(m => m.id).join(',') || '无'}`)
  // Zen-only ids are the ones the Go roster never lists; a Go directory that
  // carried one would mean the two scopes share a catalog.
  const ZEN_ONLY = [...ZEN_LIVE_IDS].filter(id => !LIVE_IDS.includes(id))
  ok('Go 目录既被刷新，也没有混进 Zen 专有的模型',
    goIds.size > INSTALLED.length && ZEN_ONLY.every(id => !goIds.has(id)),
    `Go 目录 ${goIds.size} 个，混入的 Zen 专有模型 ${ZEN_ONLY.filter(id => goIds.has(id)).join(',') || '无'}`)
  const zenClaude = zenModel('claude-opus-5')
  const zenGemini = zenModel('gemini-3.8-flash')
  ok('两套协议表各归各的：Claude 走 Anthropic 根、Gemini 走版本路径',
    zenClaude?.baseUrl === 'https://opencode.ai/zen'
      && zenClaude?.provider === 'opencode'
      && zenGemini?.baseUrl === 'https://opencode.ai/zen/v1'
      && zenGemini?.api === 'google-generative-ai',
    `Claude ${zenClaude?.baseUrl} / Gemini ${zenGemini?.api} @ ${zenGemini?.baseUrl}`)
  ok('Zen 目录里每种协议都在本插件的表里（新增协议会导致整份被拒，这里先看见）',
    ZEN_CHAT.every(m => OPERABLE_ZEN_PROTOCOLS.has(m.api)),
    [...new Set(ZEN_DIRECTORY.map(m => m.api))].join(', '))
  ok('分类器条目被点名跳过，不进模型选择器',
    !zenIds.has('jev-1.13') && !zenIds.has('jev-1.13-free')
      && ZEN_INSTALLED.every(m => m.id !== 'jev-1.13')
      && zenLogs.some(([l, m]) => l === 'warn' && m.includes('non-chat')),
    zenLogs.find(([l, m]) => l === 'warn' && m.includes('non-chat'))?.slice(0, 120) ?? '无告警')

  // Both catalogs were adopted, so both have to be on disk — the payload is one
  // file keyed by provider id, and a write triggered by one scope must not drop
  // the other's entry.
  // The cache scenarios above repoint DSH_PROFILE_DIR at their own directory and
  // restore it when they finish, so this one reads whichever directory is in
  // force now rather than the shared sandbox constant.
  const cacheDirNow = process.env.DSH_PROFILE_DIR ?? CACHE_SANDBOX
  const { readFile: readCache } = await import('node:fs/promises')
  let dualPayload = null
  for (let i = 0; i < 120; i += 1) {
    try {
      const parsed = JSON.parse(await readCache(join(cacheDirNow, 'opencode-live-models-catalog.json'), 'utf8'))
      const hasZen = cachedScope(parsed, 'opencode')
      const hasGo = cachedScope(parsed, OPENCODE_GO)
      if (hasZen && hasGo) { dualPayload = parsed; break }
    } catch { /* not written yet */ }
    await wait()
  }
  ok('两条路由各写各的缓存条目（互不覆盖）',
    Array.isArray(cachedScope(dualPayload, 'opencode')?.models)
      && Array.isArray(cachedScope(dualPayload, OPENCODE_GO)?.models)
      && cachedScope(dualPayload, 'opencode')?.etag === '"zen"'
      && cachedScope(dualPayload, OPENCODE_GO)?.etag === '"go"',
    dualPayload
      ? `zen=${cachedScope(dualPayload, 'opencode')?.models?.length} 条 etag ${cachedScope(dualPayload, 'opencode')?.etag}，`
        + `go=${cachedScope(dualPayload, OPENCODE_GO)?.models?.length} 条 etag ${cachedScope(dualPayload, OPENCODE_GO)?.etag}`
      : '文件不存在')

  globalThis.fetch = mainFetch
  void tick
}

// ── 9. 继承旧版本状态：缺失字段必须补齐 ────────────────────────────────────
//
// Last, on purpose: it swaps the shared slot for a hand-made 0.1.5 state and
// loads a module against it. Every earlier section drives its refreshes through
// globals this would repoint.
{
  const STATE_KEY = Symbol.for('dsh-opencode-live-models.state')
  const legacy = {
    remoteCatalog: new Map(), liveModelIds: new Set(['kept-model']), pendingShrink: null,
    pendingCatalogShrink: null, deferredRoster: null, deferredCatalog: null,
    publishedCatalog: null, hooks: new Map(), providers: new Map(),
    warnedUnknownFields: new Set(), warnedCacheWrite: true, merge: null,
    generation: 4,
    // Absent exactly as 0.1.5 left them: cacheWriteTail, cacheWriteSeq,
    // catalogEtag, lastDriftWarning.
  }
  globalThis[STATE_KEY] = legacy
  // Loading the module is what performs the top-up.
  await import('./lib/index.js?legacy-fill')
  const filled = globalThis[STATE_KEY]

  const filledScope = filled.scopes?.get('opencode-go')
  ok('继承旧版本状态：缺失的字段被补上',
    filled.cacheWriteTail !== undefined && filled.cacheWriteSeq === 0
      && filled.scopes instanceof Map && filledScope?.etag === null
      && filledScope?.lastDriftWarning === null && filledScope?.remoteCatalog instanceof Map,
    `cacheWriteTail=${typeof filled.cacheWriteTail}, cacheWriteSeq=${filled.cacheWriteSeq}, `
    + `scopes=${filled.scopes instanceof Map ? 'Map' : typeof filled.scopes}, scope.etag=${filledScope?.etag}`)
  ok('补齐不覆盖旧状态里已有的值',
    filled.generation === 4 && filled.warnedCacheWrite === true
      && filled.remoteCatalog === legacy.remoteCatalog && filled.liveModelIds === legacy.liveModelIds,
    `generation=${filled.generation}, 旧顶层字段仍原样保留`)
  // Compared against `legacy`, the object that was put into the slot — not
  // against the slot itself, which `filled` was just read from and which would
  // match a freshly-built copy just as happily.
  ok('补齐后就地修改同一个对象（实例间必须共享引用）',
    filled === legacy,
    filled === legacy ? '仍是放进去的那个对象' : '★被替换成了新对象，两个实例将各读各的')

  // The crash was a `.then()` on a missing field; reach the write queue.
  let queued = null
  try {
    filled.cacheWriteTail = filled.cacheWriteTail.then(() => { queued = 'ok' }, () => { queued = 'ok' })
    await filled.cacheWriteTail
  } catch (error) {
    queued = `★${error.message}`
  }
  ok('在旧状态之上进入写队列不会抛未处理异常', queued === 'ok', `${queued}`)

  delete globalThis[STATE_KEY]
}

let failed = 0
for (const r of results) {
  if (!r.pass) failed += 1
  console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `\n        ${r.detail}` : ''}`)
}
console.log(`\n${results.length - failed}/${results.length} 通过`)
if (failed > 0) process.exitCode = 1
