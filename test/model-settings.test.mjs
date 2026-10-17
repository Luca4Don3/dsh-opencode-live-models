import { test } from 'node:test'
import assert from 'node:assert/strict'
import { configuredModels, selectModels, repairCatalogGaps, syncNativeCatalog, restoreNativeCatalogs, syncNativeDiagnostics, restoreNativeDiagnostics } from '../lib/model-settings.js'

test('API key and OAuth routes both use the native settings selection', () => {
  const selected = [{ id: 'selected' }]
  const ctx = {
    llm: { listConfigurableProviders: () => ['opencode-go', 'opencode', 'openai-codex', 'custom'].map(provider => ({ provider, settingsNs: 'native', settingsPath: ['providers', provider] })) },
    get: name => {
      assert.equal(name, 'settings')
      return { describe(options) {
        assert.deepEqual(options, { redactSecrets: true })
        return [{ ns: 'native', value: { providers: Object.fromEntries(['opencode-go', 'opencode', 'openai-codex', 'custom'].map(id => [id, { models: selected }])) } }]
      } }
    },
  }
  for (const provider of ['opencode-go', 'opencode', 'openai-codex', 'custom']) assert.equal(configuredModels(ctx, provider), selected)
  assert.equal(configuredModels(ctx, 'unknown'), undefined)
})

test('the native selection filters live additions and preserves configured order and capacities', () => {
  const models = [{ id: 'hidden' }, { id: 'selected', api: 'native', maxTokens: 200 }, { id: 'new-live-model' }]
  const result = selectModels(models, [{ id: 'new-live-model' }, { id: 'selected', name: 'Custom', maxTokens: 100, input: ['text'] }])
  assert.deepEqual(result.map(model => model.id), ['new-live-model', 'selected'])
  assert.equal(result[1].api, 'native')
  assert.equal(result[1].maxTokens, 100)
  assert.equal(result[1].name, 'Custom')
  assert.deepEqual(result[1].input, ['text'])
  assert.equal(selectModels(models, undefined), models, 'reset uses the full live catalog again')
})

test('the native discovery/validation dictionary gets full descriptors and restores on unload', () => {
  const old = { id: 'old', provider: 'opencode', api: 'anthropic-messages' }
  const target = { old }, records = new Map()
  const added = { id: 'new', provider: 'opencode', api: 'openai-responses', contextWindow: 200000 }
  const updated = { ...old, maxTokens: 100 }
  syncNativeCatalog(records, 'opencode', target, () => [updated, added])
  assert.equal(target.new, added)
  assert.equal(target.old, updated)
  syncNativeCatalog(records, 'opencode', target, baseline => {
    assert.deepEqual(baseline, [old], 'refresh always starts from the unmodified native baseline')
    return [updated]
  })
  assert.equal(target.new, undefined, 'retired live additions leave native discovery too')
  const otherPlugin = { id: 'unrelated' }
  target.unrelated = otherPlugin
  restoreNativeCatalogs(records)
  assert.equal(target.old, old)
  assert.equal(target.unrelated, otherPlugin)
  assert.equal(records.size, 0)
})

test('unload preserves a descriptor another plugin replaced after our update', () => {
  const target = { old: { id: 'old' } }, records = new Map()
  syncNativeCatalog(records, 'opencode', target, () => [{ id: 'old' }, { id: 'new' }])
  const replacement = { id: 'new', name: 'Other' }
  target.new = replacement
  restoreNativeCatalogs(records)
  assert.equal(target.new, replacement)
})

test('cold-start repair clears only a resolved descriptor gap and leaves native errors intact', () => {
  const gap = 'llm-pi-ai: model "new" needs an api; the installed catalog does not describe it, so set the route\'s api to the wire protocol its endpoint speaks'
  const unresolved = gap.replace('"new"', '"still-missing"')
  const profile = { piProvider: {}, catalogError: gap, modelErrors: new Map([['new', gap], ['invalid', 'invalid capacity'], ['still-missing', unresolved]]) }
  const snapshot = { profiles: new Map([['opencode', profile]]), models: {} }
  const next = repairCatalogGaps(snapshot, ['opencode'], () => [{ id: 'new', api: 'openai-responses', contextWindow: 10000, maxTokens: 1000 }])
  assert.equal(next.models, snapshot.models)
  assert.equal(next.profiles.get('opencode').modelErrors.has('new'), false)
  assert.equal(next.profiles.get('opencode').modelErrors.get('invalid'), 'invalid capacity')
  assert.equal(next.profiles.get('opencode').modelErrors.has('still-missing'), true)
  assert.equal(next.profiles.get('opencode').catalogError, 'invalid capacity', 'the next real error remains visible')
  assert.equal(profile.catalogError, gap, 'the native startup diagnostic remains available for unload')
  assert.equal(profile.modelErrors.size, 3, 'the native snapshot stays unchanged for unload')
  assert.equal(repairCatalogGaps(snapshot, ['opencode'], () => [{ id: 'new', api: 'native', contextWindow: 0, maxTokens: 10 }]), snapshot)
})

test('a resolved startup API gap clears the runtime and settings diagnostics, with guarded unload', () => {
  const id = 'ling-3.0-flash-fin-free'
  const gap = `llm-pi-ai: provider "opencode" model "${id}" needs an api; the installed catalog does not describe it, so set the route's api to the wire protocol its endpoint speaks`
  const original = { provider: 'opencode', settingsNs: 'native', settingsPath: ['providers', 'opencode'], error: gap }
  const directory = new Map([['opencode', original]]), records = new Map()
  const snapshot = { profiles: new Map([['opencode', { piProvider: {}, catalogError: gap, modelErrors: new Map([[id, gap]]) }]]) }
  const repaired = repairCatalogGaps(snapshot, ['opencode'], () => [{ id, api: 'openai-completions', contextWindow: 262144, maxTokens: 32768 }])
  assert.equal(repaired.profiles.get('opencode').catalogError, undefined)
  syncNativeDiagnostics(records, directory, snapshot, repaired, ['opencode'])
  assert.equal(directory.get('opencode').error, undefined)
  assert.equal(directory.get('opencode').settingsPath, original.settingsPath)
  assert.equal(original.error, gap)
  restoreNativeDiagnostics(records)
  assert.equal(directory.get('opencode'), original)
  syncNativeDiagnostics(records, directory, snapshot, repaired, ['opencode'])
  const newer = { ...original, error: 'native configuration changed' }
  directory.set('opencode', newer)
  restoreNativeDiagnostics(records)
  assert.equal(directory.get('opencode'), newer, 'unload preserves a newer native registration')
})

test('settings retain unresolved or unrelated errors and advance to a remaining real diagnostic', () => {
  const gap = 'llm-pi-ai: provider "opencode" model "new" needs an api; the installed catalog does not describe it, so set the route\'s api to the wire protocol its endpoint speaks'
  const snapshot = { profiles: new Map([['opencode', { piProvider: {}, catalogError: gap, modelErrors: new Map([['new', gap], ['invalid', 'invalid capacity']]) }]]) }
  const original = { provider: 'opencode', error: gap }, directory = new Map([['opencode', original]]), records = new Map()
  const unresolved = repairCatalogGaps(snapshot, ['opencode'], () => [])
  syncNativeDiagnostics(records, directory, snapshot, unresolved, ['opencode'])
  assert.equal(directory.get('opencode'), original)
  const repaired = repairCatalogGaps(snapshot, ['opencode'], () => [{ id: 'new', api: 'native', contextWindow: 1000, maxTokens: 100 }])
  syncNativeDiagnostics(records, directory, snapshot, repaired, ['opencode'])
  assert.equal(directory.get('opencode').error, 'invalid capacity')
  restoreNativeDiagnostics(records)
  const unrelated = { provider: 'opencode', error: 'invalid route endpoint' }
  directory.set('opencode', unrelated)
  syncNativeDiagnostics(records, directory, snapshot, repaired, ['opencode'])
  assert.equal(directory.get('opencode'), unrelated)
  assert.equal(records.size, 0)
})
