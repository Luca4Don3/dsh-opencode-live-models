import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply, recoverSummary, partitionMessages, summaryTarget, retryDelay } from '../lib/compaction-recovery.js'

const text = value => ({ role: 'user', content: [{ type: 'text', text: value }] })
const estimate = message => 4 + message.content.reduce((total, block) => total + (block.text?.length ?? block.arguments?.length ?? 10), 0)
const summary = value => ({ summary: [{ type: 'text', text: value }], rawOutput: [{ type: 'text', text: value }], usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110 } })
const logger = { info() {}, warn() {} }
const defaults = { input: { messages: [text('short history')] }, estimate, contextWindow: 272000, maxTokens: 65536, logger, wait: async () => {} }
const error = code => Object.assign(new Error(code), { code })

test('small summaries retain the native input, result and output cap', async () => {
  const input = { tools: [{ name: 'fixture' }], messages: [{ role: 'system', content: [{ type: 'text', text: 'keep these instructions' }] }, text('history')] }
  let seen
  const result = await recoverSummary({ ...defaults, input, call: async part => { seen = part; return summary('complete') } })
  assert.deepEqual(seen, input)
  assert.deepEqual(result, summary('complete'))
})

test('a transport failure gets one fresh attempt and returns only the complete result', async () => {
  let calls = 0, waits = 0
  const result = await recoverSummary({ ...defaults, wait: async () => { waits++ }, call: async () => { if (++calls === 1) throw error('TRANSPORT'); return summary('second attempt') } })
  assert.equal(calls, 2)
  assert.equal(waits, 1)
  assert.equal(result.summary[0].text, 'second attempt')
})

test('non-recoverable failures and exhausted short retries propagate unchanged', async () => {
  for (const code of ['INVALID_CREDENTIAL', 'QUOTA_EXCEEDED', 'ABORTED', 'MAX_TOKENS', 'UNSUPPORTED_CONTENT', 'TRANSPORT']) {
    let calls = 0
    const cause = error(code)
    await assert.rejects(recoverSummary({ ...defaults, call: async () => { calls++; throw cause } }), value => value === cause)
    assert.equal(calls, code === 'TRANSPORT' ? 2 : 1)
  }
})

test('an 805K history is summarized in bounded requests before the final checkpoint', async () => {
  const messages = Array.from({ length: 81 }, (_, index) => text(index + ':' + 'h'.repeat(10000)))
  const prefix = { role: 'system', content: [{ type: 'text', text: 'retain system policy' }] }
  const calls = []
  const result = await recoverSummary({ ...defaults, input: { messages: [prefix, ...messages] }, call: async part => {
    assert.equal(part.messages[0], prefix)
    assert.ok(part.messages.reduce((total, message) => total + estimate(message), 0) + 65536 + 4096 < 272000)
    calls.push(part)
    return summary('verified checkpoint ' + calls.length)
  } })
  assert.ok(calls.length > 2)
  assert.equal(calls.slice(0, -1).flatMap(part => part.messages.slice(1)).length, messages.length, 'every original message reaches one map batch')
  assert.ok(calls.at(-1).messages[1].content[0].text.includes('Chronological partial checkpoint'))
  assert.equal(result.summary[0].text, 'verified checkpoint ' + calls.length)
  assert.equal(result.usage.inputTokens, calls.length * 100)
})

test('parallel tool calls and their results never cross a batch boundary', () => {
  const assistant = { role: 'assistant', content: [{ type: 'tool-call', id: 'a', name: 'first', arguments: '{}' }, { type: 'tool-call', id: 'b', name: 'second', arguments: '{}' }] }
  const first = { role: 'tool', toolCallId: 'a', content: [{ type: 'text', text: 'one' }] }
  const second = { role: 'tool', toolCallId: 'b', content: [{ type: 'text', text: 'two' }] }
  const batches = partitionMessages([text('before'.repeat(14)), assistant, first, second, text('after'.repeat(18))], 100, estimate)
  const batch = batches.find(items => items.includes(assistant))
  assert.deepEqual(batch, [assistant, first, second])
  assert.equal(batches.length, 3)
  assert.throws(() => partitionMessages([first], 100, estimate), /Unpaired/)
  assert.throws(() => partitionMessages([assistant], 100, estimate), /Unanswered/)
})

test('oversized tool text becomes quoted fragments without dropping characters or executing tool calls', () => {
  const original = '😀'.repeat(2000) + 'IMPORTANT-END'
  const batches = partitionMessages([{ role: 'assistant', content: [{ type: 'tool-call', id: 'call', name: 'read', arguments: '{}' }] }, { role: 'tool', toolCallId: 'call', content: [{ type: 'text', text: original }] }], 1000, estimate)
  assert.ok(batches.length > 2)
  for (const [message] of batches) {
    assert.equal(message.role, 'user')
    assert.ok(estimate(message) <= 1000)
    assert.ok(!/[\uD800-\uDBFF]$/.test(message.content[0].text))
  }
  const joined = batches.map(([message]) => message.content[0].text.split('instructions:\n')[1]).join('')
  assert.ok(joined.includes(original))
  assert.ok(joined.includes('toolCallId=call'))
  assert.throws(() => partitionMessages([{ role: 'user', content: [{ type: 'image' }] }], 1, estimate), /non-text/)
})

test('provider-confirmed context overflow halves the batch even when estimates fit', async () => {
  let failures = 0, calls = 0
  const result = await recoverSummary({ ...defaults, input: { messages: Array.from({ length: 6 }, () => text('x'.repeat(6000))) }, call: async part => {
    calls++
    if (part.messages.reduce((sum, message) => sum + estimate(message), 0) > 20000) { failures++; throw error('CONTEXT_WINDOW_EXCEEDED') }
    return summary('short checkpoint')
  } })
  assert.equal(failures, 1)
  assert.ok(calls >= 4)
  assert.equal(result.summary[0].text, 'short checkpoint')
})

test('non-converging partial summaries fail instead of replacing history', async () => {
  await assert.rejects(recoverSummary({ ...defaults, chunkTokens: 5000, input: { messages: [text('x'.repeat(4000)), text('y'.repeat(4000))] }, call: async () => summary('z'.repeat(5000)) }), /not smaller/)
  await assert.rejects(recoverSummary({ ...defaults, contextWindow: 32768, call: async () => assert.fail('no request fits') }), /insufficient context/)
})

test('very large histories stop at a fixed request limit instead of running indefinitely', async () => {
  let calls = 0
  await assert.rejects(recoverSummary({ ...defaults,
    input: { messages: Array.from({ length: 80 }, () => text('original')) },
    estimate: message => message.content[0].text === 'original' ? 95000 : 10,
    call: async () => { calls++; return summary('small') },
  }), /bounded auxiliary-request limit/)
  assert.equal(calls, 64)
})

test('cancellation interrupts backoff and stops subsequent batches', async () => {
  const abort = new AbortController(), reason = error('ABORTED')
  const sleeping = retryDelay(10000, abort.signal)
  abort.abort(reason)
  await assert.rejects(sleeping, value => value === reason)
  let calls = 0
  const during = new AbortController()
  await assert.rejects(recoverSummary({ ...defaults, signal: during.signal, input: { messages: [text('x'.repeat(70000)), text('y'.repeat(70000))] }, call: async () => { calls++; during.abort(reason); return summary('incomplete operation') } }), value => value === reason)
  assert.equal(calls, 1)
})

test('summary target honors exact policies, explicit global routing and agent fallback', () => {
  const agent = { session: { requestHeader: () => ({ config: { provider: 'go', model: 'large' } }) }, options: { provider: 'native', model: 'small' } }
  assert.deepEqual(summaryTarget({ modelPolicies: [] }, agent), { provider: 'go', model: 'large' })
  assert.deepEqual(summaryTarget({ summarizationProvider: 'configured', summarizationModel: 'model', modelPolicies: [] }, agent), { provider: 'configured', model: 'model' })
  assert.deepEqual(summaryTarget({ summarizationProvider: 'configured', summarizationModel: 'model', modelPolicies: [{ provider: 'go', model: 'large', summarizationProvider: '', summarizationModel: '' }] }, agent), { provider: 'go', model: 'large' })
  agent.session.requestHeader = () => undefined
  assert.deepEqual(summaryTarget({ modelPolicies: [] }, agent), agent.options)
})

function lifecycle(original) {
  const service = { config: { maxTokens: 65536, modelPolicies: [] }, ctx: { tokenMeter: { estimateMessage: estimate }, llm: { resolveModelInfo: async () => ({ context: { contextWindow: 272000 } }) } }, summarize: original }
  const mount = () => {
    const disposers = []
    apply({ get: () => service, logger, effect(fn) { disposers.push(fn()) } })
    return () => disposers.forEach(dispose => dispose())
  }
  return { service, mount }
}
const agent = { options: {}, session: { requestHeader: () => ({ config: { provider: 'same-provider', model: 'same-model' } }) } }

test('HMR adopts the native hook once, preserves this and restores on final disposal', async () => {
  let calls = 0
  const original = async function () { assert.equal(this, service); calls++; return summary('native') }
  const { service, mount } = lifecycle(original)
  const old = mount(), current = mount(), wrapper = service.summarize
  old()
  assert.equal(service.summarize, wrapper)
  assert.equal((await service.summarize(defaults.input, agent)).summary[0].text, 'native')
  assert.equal(calls, 1)
  current()
  assert.equal(service.summarize, original)
})

test('unload aborts an in-flight summary and never commits its late result', async () => {
  let finish, seen
  const { service, mount } = lifecycle((input, agent, signal) => { seen = signal; return new Promise(resolve => { finish = resolve }) })
  const dispose = mount()
  const pending = service.summarize(defaults.input, agent)
  await new Promise(resolve => setImmediate(resolve))
  dispose()
  assert.equal(seen.aborted, true)
  finish(summary('late result'))
  await assert.rejects(pending, value => value.code === 'ABORTED')
})

test('scoped Cordis method proxies restore the underlying native hook on disposal', async () => {
  const original = async () => summary('original')
  const { service } = lifecycle(original)
  const proxy = new Proxy(service, { get(target, key) {
    if (key === Symbol.for('cordis.original')) return target
    const value = target[key]
    return typeof value === 'function' ? new Proxy(value, { apply: (fn, self, args) => fn.apply(target, args) }) : value
  } })
  assert.notEqual(proxy.summarize, proxy.summarize)
  const disposers = []
  apply({ get: () => proxy, logger, effect(fn) { disposers.push(fn()) } })
  assert.notEqual(service.summarize, original)
  assert.equal((await proxy.summarize(defaults.input, agent)).summary[0].text, 'original')
  disposers[0]()
  assert.equal(service.summarize, original)
  assert.equal((await proxy.summarize(defaults.input, agent)).summary[0].text, 'original', 'disabled recovery cannot leave an aborted wrapper behind')
})
