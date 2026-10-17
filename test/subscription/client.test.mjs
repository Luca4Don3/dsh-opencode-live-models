import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Script } from 'node:vm'

const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))
const source = readFileSync(new URL('../../lib/client.js', import.meta.url), 'utf8')

function createSlots(accountEntries = [{ options: { id: 'account' }, component: function AccountSection() {} }], overlayEntries = []) {
  const listeners = new Map([['settings.section', new Set()], ['shell.overlay', new Set()]])
  const registrations = []
  return {
    registrations,
    inject(name, callback) {
      assert.ok(['plugins.bundle.config', 'settings.section', 'shell.overlay'].includes(name))
      return callback()
    },
    register(options, component) {
      const entry = { options, component }
      registrations.push(entry)
      return () => registrations.splice(registrations.indexOf(entry), 1)
    },
    entries(name) { assert.ok(listeners.has(name)); return name === 'settings.section' ? accountEntries : overlayEntries },
    subscribe(name, listener) {
      assert.ok(listeners.has(name))
      listeners.get(name).add(listener)
      return () => listeners.get(name).delete(listener)
    },
    replace(entries, name = 'settings.section') {
      if (name === 'settings.section') accountEntries = entries
      else overlayEntries = entries
      for (const listener of listeners.get(name)) listener()
    },
  }
}

const STORAGE_KEY = 'dsh-opencode-live-models.subscription-balances.v1'
function memoryStorage() {
  const data = new Map()
  return { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, String(value)) }
}

function loadClient({ status = null, fetchImpl, slots = createSlots(), now = () => Date.now(), storage = memoryStorage() } = {}) {
  let entry
  const states = []
  const effects = []
  const warnings = []
  let cursor = 0
  new Script(source, { filename: 'client.js' }).runInNewContext({
    window: { localStorage: storage, __ModuleLoader__: { load(value) { entry = value } } },
    console: { warn: value => warnings.push(value) },
    fetch: fetchImpl,
    setInterval,
    clearInterval,
    Date: class extends Date { static now() { return now() } },
  })
  assert.equal(entry.id, pkg.name)
  const required = []
  let reactApi
  const client = entry.factory(name => {
    required.push(name)
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return { BrandWordmark: function BrandWordmark() {} }
    assert.equal(name, 'react')
    return reactApi = {
      createElement(type, props, ...children) {
        const value = children.length ? children.flat(Infinity) : [props?.children].flat(Infinity)
        return { type, props: children.length ? { ...props, children: value.length === 1 ? value[0] : value } : props, children: value }
      },
      cloneElement(node, props, ...children) {
        const value = children.length ? children.flat(Infinity) : [node.props.children].flat(Infinity)
        return { ...node, props: { ...node.props, ...props, children: value.length === 1 ? value[0] : value }, children: value }
      },
      isValidElement: node => !!node && typeof node === 'object' && 'type' in node,
      useState(initial) {
        const index = cursor++
        if (!(index in states)) states[index] = index === 0 && status !== null ? status : typeof initial === 'function' ? initial() : initial
        return [states[index], value => { states[index] = typeof value === 'function' ? value(states[index]) : value }]
      },
      useEffect(callback) { effects.push(callback) },
      useRef(initial) {
        const index = cursor++
        if (!(index in states)) states[index] = { current: initial }
        return states[index]
      },
      useMemo(create, deps) {
        const index = cursor++
        if (!states[index] || deps.some((value, at) => value !== states[index].deps[at])) states[index] = { deps, value: create() }
        return states[index].value
      },
    }
  })
  const disposers = []
  client.apply({
    slots: {
      ...slots,
      inject(name, callback) {
        const dispose = slots.inject(name, callback)
        assert.equal(typeof dispose, 'function')
        disposers.push(dispose)
      },
    },
  })
  const login = slots.registrations.at(-1)
  const renderNode = node => {
    if (!node || typeof node !== 'object') return node
    if (typeof node.type === 'function') return renderNode(node.type(node.props))
    return { ...node, children: (node.children ?? []).map(renderNode) }
  }
  return {
    client, react: reactApi, required, section: login.options, effects, slots, storage, warnings,
    render() { cursor = 0; return renderNode(login.component()) },
    renderModels(props) { cursor = 0; return renderNode(slots.entries('settings.section').find(entry => entry.options.id === 'models').component(props)) },
    renderBalances() {
      cursor = 0
      const account = slots.entries('settings.section').find(entry => entry.options.id === 'account')
      return account.component({}).children[1].type()
    },
    remount() { states.length = 0; effects.length = 0 },
    dispose() { for (const dispose of disposers.reverse()) dispose() },
  }
}

function elements(node) {
  return node && typeof node === 'object' ? [node, ...(node.children ?? []).flatMap(elements)] : []
}

const tick = () => new Promise(resolve => setImmediate(resolve))
const response = body => ({ status: 200, text: async () => JSON.stringify(body) })

function modelPicker(initialModels = []) {
  let ui, models = initialModels, writes = 0
  const candidates = [{ id: 'fable', name: 'Fable', maxTokens: 500 }, { id: 'sol', maxTokens: 200 }, { id: 'other' }]
  // Model the native add-only boundary: unchecked existing rows survive its Map.
  function ModelListEditor(props) {
    const { createElement: h, useState } = ui.react
    const [found, setFound] = useState(null), [picked, setPicked] = useState(new Set()), [query, setQuery] = useState('')
    const visible = (found ?? []).filter(model => model.id.includes(query))
    const close = () => setFound(null)
    function Modal(p) { return h('dialog', p, p.children, p.footer) }
    return h('section', null,
      h('button', { onClick: async () => {
        const answer = await props.operations.discoverModels('native', { provider: 'opencode' })
        setFound(answer.models)
        setPicked(new Set(answer.models.filter(model => !props.models.some(row => row.id === model.id)).map(model => model.id)))
      } }, props.t('fetchModels')),
      h(Modal, { title: props.t('fetchTitle'), open: !!found, onClose: close,
        footer: h('footer', null, h('button', { onClick: close }, 'cancel'), h('button', { onClick: () => {
          const next = new Map(props.models.map(model => [model.id, model]))
          for (const model of found) if (picked.has(model.id)) next.set(model.id, model)
          props.onChange([...next.values()]); close()
        } }, props.t('fetchAdopt'))) },
      h('input', { type: 'search', value: query, onChange: event => setQuery(event.target.value) }),
      h('button', { onClick: () => setPicked(new Set()) }, props.t('fetchSelectAll')),
      visible.map(model => h('label', null,
        h('input', { type: 'checkbox', checked: picked.has(model.id), onChange() {} }), h('span', null, model.id)))))
  }
  function ProviderEditor(props) { return ui.react.createElement(ModelListEditor, props) }
  function Loaded(props) { return ui.react.createElement(ProviderEditor, props) }
  const entry = { options: { id: 'models' }, component: props => ui.react.createElement(Loaded, props) }
  const original = entry.component, slots = createSlots([entry])
  ui = loadClient({ slots })
  const operations = { discoverModels: async () => ({ kind: 'found', models: candidates }) }
  const render = () => ui.renderModels({ models, operations, probe: { settingsNs: 'native', provider: 'opencode' },
    catalogProvider: 'opencode', onBusyChange() {}, t: key => key, onChange: next => { models = next; writes++ } })
  const button = text => elements(render()).find(node => node.type === 'button' && node.children.includes(text))
  const checkbox = id => {
    const row = elements(render()).find(node => node.type === 'label' && elements(node).some(child => child.children.includes(id)))
    return elements(row).find(node => node.type === 'input' && node.props.type === 'checkbox')
  }
  return { ui, entry, original, slots, render, button, checkbox, models: () => models, writes: () => writes,
    async open() { button('fetchModels').props.onClick(); await tick() } }
}

test('discovery checkboxes remove an existing Fable row and preserve other model overrides', async () => {
  const picker = modelPicker([{ id: 'fable' }, { id: 'sol', name: 'Custom Sol', maxTokens: 100 }])
  await picker.open()
  assert.equal(picker.checkbox('fable').props.checked, true)
  assert.equal(picker.checkbox('other').props.checked, false)
  picker.checkbox('fable').props.onChange()
  picker.button('应用选择').props.onClick()
  assert.deepEqual(picker.models(), [{ id: 'sol', name: 'Custom Sol', maxTokens: 100 }])
  await picker.open()
  assert.equal(picker.checkbox('fable').props.checked, false)
  assert.equal(picker.checkbox('sol').props.checked, true)
  picker.ui.dispose()
})

test('inherited catalogs start checked and applying deselection writes an explicit visible list', async () => {
  const picker = modelPicker()
  await picker.open()
  assert.equal(picker.checkbox('fable').props.checked, true)
  picker.checkbox('fable').props.onChange()
  picker.button('应用选择').props.onClick()
  assert.deepEqual(picker.models().map(model => model.id), ['sol', 'other'])
  picker.ui.dispose()
})

test('filtered select-all only changes visible models and retains manual models absent from discovery', async () => {
  const picker = modelPicker([{ id: 'fable' }, { id: 'sol' }, { id: 'manual' }])
  await picker.open()
  elements(picker.render()).find(node => node.type === 'input' && node.props.type === 'search').props.onChange({ target: { value: 'fable' } })
  picker.button('fetchDeselectAll').props.onClick()
  picker.button('应用选择').props.onClick()
  assert.deepEqual(picker.models().map(model => model.id), ['sol', 'manual'])
  picker.ui.dispose()
})

test('empty selection cannot silently restore the full catalog and cancel does not change settings', async () => {
  const picker = modelPicker([{ id: 'fable' }])
  await picker.open()
  picker.checkbox('fable').props.onChange()
  assert.equal(picker.button('应用选择').props.disabled, true)
  picker.button('应用选择').props.onClick()
  assert.equal(picker.writes(), 0)
  picker.button('cancel').props.onClick()
  assert.equal(picker.writes(), 0)
  picker.ui.dispose()
  assert.equal(picker.entry.component, picker.original)
})

test('model-selection HMR cannot stack native wrappers and disabling restores the native entry', () => {
  const entry = { options: { id: 'models' }, component: () => null }
  const original = entry.component, slots = createSlots([entry])
  const previous = loadClient({ slots }), current = loadClient({ slots })
  const wrapper = entry.component
  previous.dispose()
  assert.equal(entry.component, wrapper)
  current.dispose()
  assert.equal(entry.component, original)
})

test('startup loading centers the native brand above the localized status and preserves the surface', () => {
  let calls = 0
  const Surface = function OnboardingSurface() {}
  const overlay = { options: { id: 'desktop-onboarding' }, component: props => {
    calls++
    return { type: Surface, props: { native: true, children: { type: 'div', props: { role: 'status', children: props.t('onboardingLoading') } } } }
  } }
  const slots = createSlots([], [overlay])
  const ui = loadClient({ slots })
  for (const text of ['正在加载设置…', 'Loading settings…']) {
    const result = overlay.component({ t: key => key === 'onboardingBrand' ? 'DeepSeek Harness' : text })
    assert.equal(result.type, Surface)
    assert.equal(result.props.native, true)
    const status = result.children[0]
    assert.equal(status.props.role, 'status')
    assert.equal(status.props.style.display, 'flex')
    assert.equal(status.props.style.flexDirection, 'column')
    assert.equal(status.props.style.justifyContent, 'center')
    assert.equal(status.props.style.alignItems, 'center')
    assert.equal(status.props.style.height, '100%')
    assert.equal(status.children[0].props['aria-label'], 'DeepSeek Harness')
    assert.equal(status.children[0].children[0].type.name, 'BrandWordmark')
    assert.deepEqual(status.children[1].children, [text])
  }
  assert.equal(calls, 2, 'the native component and its hooks run exactly once per render')
  ui.dispose()
})

test('startup decoration passes through native ready, onboarding and error states', () => {
  let view
  const overlay = { options: { id: 'desktop-onboarding' }, component: () => view }
  const ui = loadClient({ slots: createSlots([], [overlay]) })
  for (view of [null, { type: 'div', props: { children: 'ready' } }, { type: function DesktopOnboarding() {}, props: { state: { visible: true } } },
    { type: 'div', props: { children: { type: 'div', props: { role: 'status', children: 'retry' } } } }]) {
    assert.equal(overlay.component({ t: () => '正在加载设置…' }), view)
  }
  ui.dispose()
})

test('startup wrappers follow late native registration, survive HMR and restore on disposal', () => {
  const slots = createSlots([])
  const older = loadClient({ slots })
  const overlay = { options: { id: 'desktop-onboarding' }, component: () => null }
  const other = { options: { id: 'other-overlay' }, component: () => null }
  const original = overlay.component, otherOriginal = other.component
  slots.replace([overlay, other], 'shell.overlay')
  assert.notEqual(overlay.component, original)
  assert.equal(other.component, otherOriginal)
  const current = loadClient({ slots })
  const wrapper = overlay.component
  older.dispose()
  assert.equal(overlay.component, wrapper)
  current.dispose()
  assert.equal(overlay.component, original)
  slots.replace([overlay], 'shell.overlay')
  assert.equal(overlay.component, original)
})

test('Zen balances use the bottom full-width row after both subscription cards, with their own footer', async () => {
  const ui = loadClient({ fetchImpl: async url => response(url.endsWith('/subscriptions') ? { subscriptions: [
    { providerId: 'opencode', label: 'OpenCode Zen', kind: 'balance', cacheKey: 'zen' },
    { providerId: 'openai-codex', cacheKey: 'codex' },
    { providerId: 'opencode-go', label: 'OpenCode Go', cacheKey: 'go' },
  ] } : url.endsWith('provider=opencode')
    ? { status: 'ready', windows: [], capturedAt: 10000, balance: { amount: 12.34, currency: 'USD' } }
    : { status: 'ready', windows: [{ id: 'primary', remainingPercent: 80 }] }) })
  ui.renderBalances(); ui.effects[0](); await tick()
  const tree = ui.renderBalances(), nodes = elements(tree)
  const balanceRow = tree.children.at(-1)
  assert.equal(balanceRow.props['aria-label'], '账户余额')
  assert.equal(balanceRow.props.style.gridTemplateColumns, '1fr')
  assert.equal(balanceRow.props.style.marginTop, 20)
  const card = nodes.find(node => node.props?.['data-balance'] === 'opencode')
  assert.ok(card)
  assert.ok(elements(card).some(node => node.children.includes('OpenCode Zen 余额')))
  assert.ok(elements(card).some(node => node.children.some(child => typeof child === 'string' && /USD.*12\.34/.test(child))))
  assert.equal(card.children.at(-1).type, 'footer')
  const order = nodes.filter(node => node.props?.['data-subscription'] || node.props?.['data-balance'])
    .map(node => node.props['data-subscription'] ?? node.props['data-balance'])
  assert.deepEqual(order, ['openai-codex', 'opencode-go', 'opencode'])
})

test('a billing rejection stays in the money row without claiming the key lacks permissions', async () => {
  const ui = loadClient({ fetchImpl: async url => response(url.endsWith('/subscriptions')
    ? { subscriptions: [{ providerId: 'opencode', label: 'OpenCode Zen', kind: 'balance', cacheKey: 'zen' }] }
    : { error: 'forbidden' }) })
  ui.renderBalances(); ui.effects[0](); await tick()
  const nodes = elements(ui.renderBalances())
  assert.ok(nodes.some(node => node.props?.['data-balance'] === 'opencode'))
  assert.ok(nodes.some(node => node.children.includes('计费接口拒绝访问')))
  assert.ok(nodes.some(node => node.children.includes('访问被拒绝')))
  assert.ok(nodes.some(node => node.type === 'a' && node.props.href === 'https://opencode.ai/console'))
  assert.ok(nodes.some(node => node.children.some(child => typeof child === 'string' && child.includes('All 权限的 Key 也可能被拒绝'))))
  assert.ok(!nodes.some(node => node.children.includes('没有余额查询权限')))
  assert.ok(!nodes.some(node => node.children.includes('余额未知')))
  assert.ok(!nodes.some(node => node.children.some(child => typeof child === 'string' && /USD.*0\.00/.test(child))))
})

test('an incomplete balance refresh preserves the last saved amount and timestamp', async () => {
  const storage = memoryStorage()
  const subscriptions = [{ providerId: 'opencode', label: 'OpenCode Zen', kind: 'balance', cacheKey: 'zen' }]
  const first = loadClient({ storage, now: () => 10000, fetchImpl: async url => response(url.endsWith('/subscriptions')
    ? { subscriptions } : { status: 'ready', capturedAt: 10000, windows: [], balance: { amount: 4.96, currency: 'USD' } }) })
  first.renderBalances(); first.effects[0](); await tick(); first.dispose()
  for (const result of [{ status: 'unknown', capturedAt: 1000000, windows: [] }, { error: 'forbidden' }]) {
    const restarted = loadClient({ storage, now: () => 1000000, fetchImpl: async url => response(url.endsWith('/subscriptions') ? { subscriptions } : result) })
    restarted.renderBalances(); restarted.effects[0](); await tick()
    const nodes = elements(restarted.renderBalances())
    assert.ok(nodes.some(node => node.children.some(child => typeof child === 'string' && /USD.*4\.96/.test(child))))
    assert.equal(JSON.parse(storage.getItem(STORAGE_KEY)).entries[0].snapshot.capturedAt, 10000)
    if (result.error === 'forbidden') assert.ok(nodes.some(node => node.type === 'a' && node.props.href === 'https://opencode.ai/console'))
    restarted.dispose()
  }
})

test('a new client process retains money and credit type throughout a pending refresh', async () => {
  const storage = memoryStorage()
  const subscriptions = [{ providerId: 'opencode', label: 'OpenCode Zen', kind: 'balance', cacheKey: 'zen' }]
  const first = loadClient({ storage, now: () => 10000, fetchImpl: async url => response(url.endsWith('/subscriptions')
    ? { subscriptions } : { status: 'ready', capturedAt: 10000, windows: [], balance: { amount: 12.34, currency: 'USD', kind: 'credit', private: '<token>' } }) })
  first.renderBalances(); first.effects[0](); await tick(); first.dispose()
  const raw = storage.getItem(STORAGE_KEY)
  assert.ok(!raw.includes('<token>'))
  let finish
  const restarted = loadClient({ storage, now: () => 1000000, fetchImpl: async url => url.endsWith('/subscriptions')
    ? response({ subscriptions }) : new Promise(resolve => { finish = resolve }) })
  assert.ok(elements(restarted.renderBalances()).some(node => node.children.includes('OpenCode Zen 可用额度')))
  restarted.effects[0](); await tick()
  let nodes = elements(restarted.renderBalances())
  assert.ok(nodes.some(node => node.children.some(child => typeof child === 'string' && /USD.*12\.34/.test(child))))
  assert.ok(!nodes.some(node => node.children.includes('正在查询余额…')))
  finish(response({ error: 'network' })); await tick()
  nodes = elements(restarted.renderBalances())
  assert.ok(nodes.some(node => node.children.some(child => typeof child === 'string' && /USD.*12\.34/.test(child))))
  assert.equal(JSON.parse(storage.getItem(STORAGE_KEY)).entries[0].snapshot.capturedAt, 10000)
})

test('client entry loads as a classic script through the DSH module loader', () => {
  const { client, required } = loadClient()
  assert.deepEqual(required, ['react'])
  assert.equal(typeof client.apply, 'function')
  assert.deepEqual(Array.from(client.inject), ['slots'])
  assert.ok(pkg.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-slots'))
  assert.ok(pkg.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-plugin-manager'))
  assert.ok(pkg.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-settings-account'))
  assert.ok(!pkg.dsh.client.inject.includes('@deepseek-ai/dsh-client-runtime'))
})

test('login belongs to this package detail page in the sidebar plugin manager', () => {
  const { section, render } = loadClient()
  assert.equal(section.name, 'plugins.bundle.config')
  assert.equal(section.key, pkg.name)
  assert.ok(!elements(render()).some(node => node.children.includes('刷新额度')))
})

test('plugin page reads status and its sign-in button starts the native login API', async () => {
  const calls = []
  const ui = loadClient({ fetchImpl: async (url, init) => {
    calls.push({ url, init })
    return response({ loggedIn: false, login: url.endsWith('/login') ? { status: 'waiting' } : null })
  } })
  ui.render()
  ui.effects[0]()
  await tick()
  assert.equal(calls[0].url, '/dsh-opencode-live-models/status')
  assert.equal(calls[0].init.headers['content-type'], undefined)
  const button = elements(ui.render()).find(node => node.type === 'button' && node.children.includes('使用 ChatGPT 账号登录 / Sign in with ChatGPT'))
  assert.ok(button)
  button.props.onClick()
  await tick()
  assert.equal(calls[1].url, '/dsh-opencode-live-models/login')
  assert.equal(calls[1].init.method, 'POST')
  assert.equal(calls[1].init.credentials, 'same-origin')
  assert.ok(elements(ui.render()).some(node => node.type === 'button' && node.children.includes('取消登录 / Cancel')))
})

test('plugin detail includes OpenCode official login, its device code, authorization link and cancellation', async () => {
  const calls = []
  const ui = loadClient({ fetchImpl: async (url, options) => {
    calls.push({ url, options })
    return response({ loggedIn: false, login: url.endsWith('/opencode/login')
      ? { status: 'waiting', userCode: 'TEST-CODE', openUrl: 'https://opencode.ai/console/device?user_code=TEST-CODE' }
      : url.endsWith('/cancel') ? { status: 'cancelled' } : null })
  } })
  ui.render(); ui.effects[2](); await tick()
  assert.equal(calls[0].url, '/dsh-opencode-live-models/opencode/status')
  const card = () => elements(ui.render()).find(node => node.props?.['data-opencode-login'])
  elements(card()).find(node => node.type === 'button').props.onClick(); await tick()
  assert.equal(calls[1].url, '/dsh-opencode-live-models/opencode/login')
  assert.equal(calls[1].options.method, 'POST')
  assert.ok(elements(card()).some(node => node.children.includes('TEST-CODE')))
  assert.ok(elements(card()).some(node => node.type === 'a' && node.props.href.startsWith('https://opencode.ai/console/device')))
  elements(card()).find(node => node.type === 'button').props.onClick(); await tick()
  assert.equal(calls[2].url, '/dsh-opencode-live-models/opencode/cancel')
  ui.dispose()
})

test('OpenCode login completion and failures are visible in the plugin detail page', async () => {
  const ui = loadClient({ fetchImpl: async url => response(url.endsWith('/opencode/status')
    ? { loggedIn: true, login: { status: 'ok' } } : { loggedIn: true, login: { status: 'error', detail: '授权已过期' } }) })
  ui.render(); ui.effects[2](); await tick()
  let card = elements(ui.render()).find(node => node.props?.['data-opencode-login'])
  assert.ok(elements(card).some(node => node.children.includes('重新登录 OpenCode Console')))
  elements(card).find(node => node.type === 'button').props.onClick(); await tick()
  card = elements(ui.render()).find(node => node.props?.['data-opencode-login'])
  assert.ok(elements(card).some(node => node.children.includes('授权已过期')))
  ui.dispose()
})

test('waiting login supports callback paste and cancellation in the plugin page', async () => {
  const calls = []
  const ui = loadClient({
    status: { loggedIn: false, login: { status: 'waiting', prompt: { message: 'Paste redirect' } } },
    fetchImpl: async (url, init) => {
      calls.push({ url, init })
      return response({ ok: true, loggedIn: false, login: null })
    },
  })
  let nodes = elements(ui.render())
  nodes.find(node => node.type === 'input').props.onChange({ target: { value: 'http://localhost:1455/auth/callback?code=fixture' } })
  nodes = elements(ui.render())
  const submit = nodes.find(node => node.type === 'button' && node.children.includes('提交 / Submit'))
  assert.equal(submit.props.disabled, false)
  submit.props.onClick()
  await tick()
  assert.equal(calls[0].url, '/dsh-opencode-live-models/code')
  assert.deepEqual(JSON.parse(calls[0].init.body), { value: 'http://localhost:1455/auth/callback?code=fixture' })
  const cancelUi = loadClient({
    status: { loggedIn: false, login: { status: 'waiting' } },
    fetchImpl: async (url, init) => { calls.push({ url, init }); return response({ loggedIn: false, login: null }) },
  })
  elements(cancelUi.render()).find(node => node.type === 'button' && node.children.includes('取消登录 / Cancel')).props.onClick()
  await tick()
  assert.equal(calls.at(-1).url, '/dsh-opencode-live-models/cancel')
  assert.equal(calls.at(-1).init.method, 'POST')
})

test('signed-in state offers re-login and cancellation failures are visible', async () => {
  const signedIn = loadClient({ status: { loggedIn: true, login: null } })
  const button = elements(signedIn.render()).find(node => node.type === 'button')
  assert.ok(button.children.includes('重新登录 ChatGPT'))
  const ui = loadClient({
    status: { loggedIn: false, login: { status: 'waiting' } },
    fetchImpl: async () => { throw new Error('network unavailable') },
  })
  elements(ui.render()).find(node => node.type === 'button').props.onClick()
  await tick()
  assert.ok(elements(ui.render()).some(node => node.children.includes('network unavailable')))
})

test('account balances follow the native account component without a duplicate navigation entry', () => {
  const slots = createSlots()
  const account = slots.entries('settings.section')[0]
  const original = account.component
  const ui = loadClient({ slots })
  const props = { hooks: {}, refreshAccount() {} }
  const layout = account.component(props)
  assert.equal(layout.children[0].type, original)
  assert.equal(layout.children[0].props, props)
  assert.equal(layout.children.filter(child => child.type === original).length, 1)
  assert.equal(slots.entries('settings.section').length, 1)
  assert.deepEqual(slots.registrations.map(entry => entry.options.name), ['plugins.bundle.config'])
  ui.dispose()
  assert.equal(account.component, original)
})

test('account page queries only configured subscriptions and refreshes their remaining quota', async () => {
  const calls = []
  const ui = loadClient({ fetchImpl: async url => {
    calls.push(url)
    return response(url.endsWith('/subscriptions')
      ? { subscriptions: [{ providerId: 'openai-codex', label: 'OpenAI Codex', cacheKey: 'fixture-scope' }] }
      : { status: 'ready', windows: [{ id: 'primary', remainingPercent: 75, resetsAt: 1792166400 }, { id: 'secondary', remainingPercent: 60 }], capturedAt: 1792152000000 })
  } })
  assert.equal(ui.renderBalances(), null)
  const cleanup = ui.effects[0]()
  await tick()
  assert.deepEqual(calls, ['/dsh-opencode-live-models/subscriptions', '/dsh-opencode-live-models/usage?provider=openai-codex'])
  const nodes = elements(ui.renderBalances())
  assert.ok(nodes.some(node => node.children.includes('剩余 75%')))
  assert.ok(nodes.some(node => node.children.includes('OpenAI订阅')))
  assert.ok(!nodes.some(node => node.children.includes('OpenAI Codex')))
  assert.ok(nodes.some(node => node.children.includes('5小时')))
  assert.ok(nodes.some(node => node.children.includes('1周')))
  assert.ok(!nodes.some(node => node.children.includes('主窗口') || node.children.includes('次窗口')))
  assert.ok(nodes.some(node => node.children.some(child => typeof child === 'string' && child.startsWith('重置：'))))
  assert.ok(nodes.some(node => node.children.some(child => typeof child === 'string' && child.startsWith('更新于 '))))
  nodes.find(node => node.type === 'button').props.onClick()
  await tick()
  assert.deepEqual(calls.slice(2), ['/dsh-opencode-live-models/subscriptions', '/dsh-opencode-live-models/usage?provider=openai-codex&refresh=1'])
  cleanup()
})

test('account page excludes DeepSeek, deduplicates subscriptions and displays at most three', async () => {
  const calls = []
  const ui = loadClient({ fetchImpl: async url => {
    calls.push(url)
    return response(url.endsWith('/subscriptions') ? { subscriptions: [
      { providerId: 'deepseek' }, { providerId: 'deepseek-official' },
      { providerId: 'openai-codex' }, { providerId: 'openai-codex' },
      { providerId: 'opencode-go' }, { providerId: 'fixture-third' }, { providerId: 'fixture-fourth' },
    ] } : { status: 'unknown', windows: [] })
  } })
  ui.renderBalances()
  ui.effects[0]()
  await tick()
  const cards = elements(ui.renderBalances()).filter(node => node.props?.['data-subscription'])
  assert.deepEqual(cards.map(node => node.props['data-subscription']), ['openai-codex', 'opencode-go', 'fixture-third'])
  assert.equal(calls.length, 4, 'one list request and at most three usage requests')
})

test('an account without subscriptions renders no quota cards or usage requests', async () => {
  const calls = []
  const ui = loadClient({ fetchImpl: async url => { calls.push(url); return response({ subscriptions: [] }) } })
  ui.renderBalances()
  ui.effects[0]()
  await tick()
  assert.equal(ui.renderBalances(), null)
  assert.deepEqual(calls, ['/dsh-opencode-live-models/subscriptions'])
})

test('a subscription failure does not hide another subscription or turn unknown quota into zero', async () => {
  const ui = loadClient({ fetchImpl: async url => {
    if (url.endsWith('/subscriptions')) return response({ subscriptions: [{ providerId: 'openai-codex' }, { providerId: 'opencode-go' }] })
    if (url.includes('openai-codex')) throw new Error('fixture network failure')
    return response({ status: 'ready', windows: [{ id: 'weekly' }] })
  } })
  ui.renderBalances()
  ui.effects[0]()
  await tick()
  const nodes = elements(ui.renderBalances())
  assert.equal(nodes.filter(node => node.props?.['data-subscription']).length, 2)
  assert.ok(nodes.some(node => node.children.includes('连接失败')))
  assert.ok(nodes.some(node => node.children.includes('剩余额度未知')))
  assert.ok(!nodes.some(node => node.children.includes('剩余 0%')))
})

test('subscription listing failures are visible and can be retried', async () => {
  let failed = true
  const ui = loadClient({ fetchImpl: async () => failed
    ? { status: 503, text: async () => '{"error":"unavailable"}' }
    : response({ subscriptions: [] }) })
  ui.renderBalances()
  ui.effects[0]()
  await tick()
  const nodes = elements(ui.renderBalances())
  assert.ok(nodes.some(node => node.children.includes('订阅额度读取失败，请重试')))
  failed = false
  nodes.find(node => node.type === 'button').props.onClick()
  await tick()
  assert.equal(ui.renderBalances(), null)
})

test('account component registration and removal are followed and restored on disposal', () => {
  const slots = createSlots([])
  const ui = loadClient({ slots })
  const account = { options: { id: 'account' }, component: function AccountSection() {} }
  const original = account.component
  slots.replace([account])
  assert.notEqual(account.component, original)
  slots.replace([])
  assert.equal(account.component, original)
  slots.replace([account])
  assert.notEqual(account.component, original)
  ui.dispose()
  assert.equal(account.component, original)
  slots.replace([account])
  assert.equal(account.component, original, 'disposal unsubscribes from later registration changes')
})

test('HMR does not nest account wrappers and old disposal leaves the new wrapper intact', () => {
  const slots = createSlots()
  const account = slots.entries('settings.section')[0]
  const original = account.component
  const old = loadClient({ slots })
  const current = loadClient({ slots })
  const wrapper = account.component
  assert.equal(wrapper({}).children[0].type, original)
  old.dispose()
  assert.equal(account.component, wrapper)
  current.dispose()
  assert.equal(account.component, original)
})

test('unmounting prevents a late subscription list response from updating the component', async () => {
  let resolve
  const ui = loadClient({ fetchImpl: () => new Promise(done => { resolve = done }) })
  ui.renderBalances()
  const cleanup = ui.effects[0]()
  cleanup()
  resolve({ status: 503, text: async () => '{"error":"unavailable"}' })
  await tick()
  assert.equal(ui.renderBalances(), null)
})

test('configured cards appear immediately and each provider updates without waiting for the other', async () => {
  let finishSlow
  const ui = loadClient({ fetchImpl: async url => {
    if (url.endsWith('/subscriptions')) return response({ subscriptions: [{ providerId: 'openai-codex' }, { providerId: 'opencode-go' }] })
    if (url.includes('opencode-go')) return new Promise(resolve => { finishSlow = resolve })
    return response({ status: 'ready', windows: [{ id: 'primary', remainingPercent: 75 }] })
  } })
  ui.renderBalances()
  ui.effects[0]()
  await tick()
  const nodes = elements(ui.renderBalances())
  assert.equal(nodes.filter(node => node.props?.['data-subscription']).length, 2)
  assert.ok(nodes.some(node => node.children.includes('剩余 75%')))
  assert.ok(nodes.some(node => node.children.includes('正在查询额度…')))
  finishSlow(response({ status: 'ready', windows: [{ id: 'weekly', remainingPercent: 60 }] }))
  await tick()
  assert.ok(elements(ui.renderBalances()).some(node => node.children.includes('剩余 60%')))
})

test('reopening shows fresh balances before the local credential check completes', async () => {
  const calls = []
  let listCount = 0, finishCheck
  const subscriptions = [{ providerId: 'opencode-go', cacheKey: 'fixture-scope' }]
  const ui = loadClient({ fetchImpl: async url => {
    calls.push(url)
    if (url.endsWith('/subscriptions')) {
      if (++listCount > 1) return new Promise(resolve => { finishCheck = resolve })
      return response({ subscriptions })
    }
    return response({ status: 'ready', windows: [{ id: 'weekly', remainingPercent: 60 }] })
  } })
  ui.renderBalances()
  const cleanup = ui.effects[0]()
  await tick()
  cleanup()
  ui.remount()
  const cached = elements(ui.renderBalances())
  assert.ok(cached.some(node => node.children.includes('剩余 60%')), 'saved balance is visible on the first render')
  assert.ok(cached.some(node => node.children.includes('正在更新，暂显示上次查询结果')))
  ui.effects[0]()
  await tick()
  assert.ok(elements(ui.renderBalances()).some(node => node.children.includes('剩余 60%')))
  finishCheck(response({ subscriptions }))
  await tick()
  assert.ok(!elements(ui.renderBalances()).some(node => node.children.includes('正在更新，暂显示上次查询结果')))
  assert.deepEqual(calls, [
    '/dsh-opencode-live-models/subscriptions',
    '/dsh-opencode-live-models/usage?provider=opencode-go',
    '/dsh-opencode-live-models/subscriptions',
  ])
})

test('expired balances remain visible during background refresh and retain their timestamp on failure', async () => {
  let clock = 0, finishRefresh
  const capturedAt = 1792152000000
  const ui = loadClient({ now: () => clock, fetchImpl: async url => {
    if (url.endsWith('/subscriptions')) return response({ freshMs: 1000, subscriptions: [{ providerId: 'opencode-go', cacheKey: 'fixture-scope' }] })
    if (clock > 0) return new Promise(resolve => { finishRefresh = resolve })
    return response({ status: 'ready', capturedAt, windows: [{ id: 'weekly', remainingPercent: 60 }] })
  } })
  ui.renderBalances()
  const cleanup = ui.effects[0]()
  await tick()
  cleanup()
  clock = 1001
  ui.remount()
  const cached = elements(ui.renderBalances())
  assert.ok(cached.some(node => node.children.includes('剩余 60%')), 'expired balance is visible before any request starts')
  assert.ok(cached.some(node => node.children.includes('数据已过期')))
  ui.effects[0]()
  await tick()
  const nodes = elements(ui.renderBalances())
  assert.ok(nodes.some(node => node.children.includes('剩余 60%')))
  assert.ok(nodes.some(node => node.children.includes('数据已过期')))
  const timestamp = '更新于 ' + new Date(capturedAt).toLocaleString()
  assert.ok(nodes.some(node => node.children.includes(timestamp)))
  finishRefresh({ status: 503, text: async () => '{"error":"unavailable"}' })
  await tick()
  assert.ok(elements(ui.renderBalances()).some(node => node.children.includes('剩余 60%')))
  assert.ok(elements(ui.renderBalances()).some(node => node.children.includes(timestamp)))
})

test('changed credentials and logout cannot reuse another credential scope balance', async () => {
  let cacheKey = 'account-a', finishNew, signedIn = true
  const ui = loadClient({ fetchImpl: async url => {
    if (url.endsWith('/subscriptions')) return response({ subscriptions: signedIn ? [{ providerId: 'opencode-go', cacheKey }] : [] })
    if (cacheKey === 'account-b') return new Promise(resolve => { finishNew = resolve })
    return response({ status: 'ready', windows: [{ id: 'weekly', remainingPercent: 60 }] })
  } })
  ui.renderBalances()
  let cleanup = ui.effects[0]()
  await tick()
  cleanup()
  cacheKey = 'account-b'
  ui.remount()
  assert.ok(elements(ui.renderBalances()).some(node => node.children.includes('剩余 60%')), 'previous result is shown until credentials are checked')
  cleanup = ui.effects[0]()
  await tick()
  assert.ok(!elements(ui.renderBalances()).some(node => node.children.includes('剩余 60%')))
  finishNew(response({ status: 'ready', windows: [{ id: 'weekly', remainingPercent: 30 }] }))
  await tick()
  assert.ok(elements(ui.renderBalances()).some(node => node.children.includes('剩余 30%')))
  cleanup()
  signedIn = false
  ui.remount()
  ui.renderBalances()
  ui.effects[0]()
  await tick()
  assert.equal(ui.renderBalances(), null)
})

test('a failed credential check keeps saved cards visible with a retry message', async () => {
  let fail = false
  const ui = loadClient({ fetchImpl: async url => {
    if (url.endsWith('/subscriptions')) return fail
      ? { status: 503, text: async () => '{"error":"unavailable"}' }
      : response({ subscriptions: [{ providerId: 'opencode-go', cacheKey: 'fixture-scope' }] })
    return response({ status: 'ready', windows: [{ id: 'weekly', remainingPercent: 60 }] })
  } })
  ui.renderBalances()
  const cleanup = ui.effects[0]()
  await tick()
  cleanup()
  fail = true
  ui.remount()
  ui.renderBalances()
  ui.effects[0]()
  await tick()
  let nodes = elements(ui.renderBalances())
  assert.ok(nodes.some(node => node.children.includes('剩余 60%')))
  assert.ok(nodes.some(node => node.children.includes('订阅额度读取失败，请重试')))
  fail = false
  nodes.find(node => node.type === 'button').props.onClick()
  await tick()
  nodes = elements(ui.renderBalances())
  assert.ok(nodes.some(node => node.children.includes('剩余 60%')))
  assert.ok(!nodes.some(node => node.children.includes('订阅额度读取失败，请重试')))
})

test('closing and reopening during a quota request joins the existing request', async () => {
  let finish, requests = 0
  const ui = loadClient({ fetchImpl: async url => {
    if (url.endsWith('/subscriptions')) return response({ subscriptions: [{ providerId: 'opencode-go', cacheKey: 'fixture-scope' }] })
    requests++
    return new Promise(resolve => { finish = resolve })
  } })
  ui.renderBalances()
  const cleanup = ui.effects[0]()
  await tick()
  cleanup()
  ui.remount()
  ui.renderBalances()
  ui.effects[0]()
  await tick()
  assert.equal(requests, 1)
  finish(response({ status: 'ready', windows: [{ id: 'weekly', remainingPercent: 60 }] }))
  await tick()
  assert.ok(elements(ui.renderBalances()).some(node => node.children.includes('剩余 60%')))
})

test('a new client process restores cached balances through the entire startup query', async () => {
  const storage = memoryStorage()
  const subscriptions = [{ providerId: 'opencode-go', label: 'OpenCode Go', cacheKey: 'fixture-scope' }]
  const first = loadClient({ storage, now: () => 10000, fetchImpl: async url => response(url.endsWith('/subscriptions')
    ? { subscriptions }
    : { status: 'ready', capturedAt: 10000, accountKey: 'fixture-private-account', token: '<token>', windows: [{ id: 'weekly', remainingPercent: 60 }] }) })
  first.renderBalances()
  const cleanup = first.effects[0]()
  await tick()
  cleanup()
  first.dispose()
  const raw = storage.getItem(STORAGE_KEY)
  assert.ok(!raw.includes('<token>') && !raw.includes('fixture-private-account'), 'only display fields are persisted')
  let finish, requests = 0
  const restarted = loadClient({ storage, now: () => 20000, fetchImpl: async url => {
    if (url.endsWith('/subscriptions')) return response({ subscriptions })
    requests++
    return new Promise(resolve => { finish = resolve })
  } })
  let nodes = elements(restarted.renderBalances())
  assert.ok(nodes.some(node => node.children.includes('剩余 60%')), 'a new module instance restores before making any request')
  assert.ok(nodes.some(node => node.children.includes('1周')), 'restored snapshots use the same limit labels')
  restarted.effects[0]()
  await tick()
  nodes = elements(restarted.renderBalances())
  assert.equal(requests, 1, 'startup revalidates even a fresh persisted result')
  assert.ok(nodes.some(node => node.children.includes('剩余 60%')), 'the saved balance remains after the local credential check')
  assert.ok(!nodes.some(node => node.children.includes('正在查询额度…')))
  finish(response({ status: 'ready', capturedAt: 20000, windows: [{ id: 'weekly', remainingPercent: 30 }] }))
  await tick()
  assert.ok(elements(restarted.renderBalances()).some(node => node.children.includes('剩余 30%')))
  assert.equal(JSON.parse(storage.getItem(STORAGE_KEY)).entries[0].snapshot.windows[0].remainingPercent, 30)
})

test('expired persisted balances survive an offline restart with their original query time', async () => {
  const storage = memoryStorage()
  const first = loadClient({ storage, now: () => 10000, fetchImpl: async url => response(url.endsWith('/subscriptions')
    ? { subscriptions: [{ providerId: 'opencode-go', cacheKey: 'fixture-scope' }] }
    : { status: 'ready', capturedAt: 10000, windows: [{ id: 'weekly', remainingPercent: 60 }] }) })
  first.renderBalances()
  first.effects[0]()
  await tick()
  const restarted = loadClient({ storage, now: () => 1000000, fetchImpl: async url => {
    if (url.endsWith('/subscriptions')) return response({ subscriptions: [{ providerId: 'opencode-go', cacheKey: 'fixture-scope' }] })
    throw new Error('offline')
  } })
  assert.ok(elements(restarted.renderBalances()).some(node => node.children.includes('剩余 60%')))
  restarted.effects[0]()
  await tick()
  const nodes = elements(restarted.renderBalances())
  assert.ok(nodes.some(node => node.children.includes('剩余 60%')))
  assert.ok(nodes.some(node => node.children.includes('数据已过期')))
  assert.ok(nodes.some(node => node.children.includes('更新于 ' + new Date(10000).toLocaleString())))
})

test('confirmed logout removes persisted balances before the next client starts', async () => {
  const storage = memoryStorage()
  const first = loadClient({ storage, fetchImpl: async url => response(url.endsWith('/subscriptions')
    ? { subscriptions: [{ providerId: 'opencode-go', cacheKey: 'fixture-scope' }] }
    : { status: 'ready', windows: [{ id: 'weekly', remainingPercent: 60 }] }) })
  first.renderBalances()
  first.effects[0]()
  await tick()
  const signedOut = loadClient({ storage, fetchImpl: async () => response({ subscriptions: [] }) })
  assert.ok(elements(signedOut.renderBalances()).some(node => node.children.includes('剩余 60%')))
  signedOut.effects[0]()
  await tick()
  assert.equal(signedOut.renderBalances(), null)
  assert.deepEqual(JSON.parse(storage.getItem(STORAGE_KEY)).entries, [])
  assert.equal(loadClient({ storage }).renderBalances(), null)
})

test('damaged display caches report a warning and allow a fresh query', async () => {
  const storage = memoryStorage()
  storage.setItem(STORAGE_KEY, '{broken')
  const ui = loadClient({ storage, fetchImpl: async url => response(url.endsWith('/subscriptions')
    ? { subscriptions: [{ providerId: 'opencode-go', cacheKey: 'fixture-scope' }] }
    : { status: 'ready', windows: [{ id: 'weekly', remainingPercent: 60 }] }) })
  assert.match(ui.warnings[0], /cache read failed/)
  assert.equal(ui.renderBalances(), null)
  ui.effects[0]()
  await tick()
  assert.ok(elements(ui.renderBalances()).some(node => node.children.includes('剩余 60%')))
  assert.equal(JSON.parse(storage.getItem(STORAGE_KEY)).version, 1)
})

test('unavailable persistent storage remains an explicit non-blocking error', async () => {
  const storage = { getItem() { throw new Error('denied') }, setItem() { throw new Error('denied') } }
  const ui = loadClient({ storage, fetchImpl: async url => response(url.endsWith('/subscriptions')
    ? { subscriptions: [{ providerId: 'opencode-go', cacheKey: 'fixture-scope' }] }
    : { status: 'ready', windows: [{ id: 'weekly', remainingPercent: 60 }] }) })
  ui.renderBalances()
  ui.effects[0]()
  await tick()
  const nodes = elements(ui.renderBalances())
  assert.ok(nodes.some(node => node.children.includes('剩余 60%')))
  assert.ok(nodes.some(node => node.children.includes('本地额度缓存保存失败，退出后可能无法保留')))
  assert.ok(ui.warnings.some(message => message.includes('cache write failed')))
})
