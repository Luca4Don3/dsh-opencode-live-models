/** Keep the native model editor and its validation on the same live catalog. */
export async function loadNativeCatalogs() {
  const [go, zen, codex] = await Promise.all([
    import('@earendil-works/pi-ai/providers/opencode-go.models'),
    import('@earendil-works/pi-ai/providers/opencode.models'),
    import('@earendil-works/pi-ai/providers/openai-codex.models'),
  ])
  return new Map([
    ['opencode-go', go.OPENCODE_GO_MODELS],
    ['opencode', zen.OPENCODE_MODELS],
    ['openai-codex', codex.OPENAI_CODEX_MODELS],
  ])
}

/** Read only the native provider's model selection; never copy credentials. */
export function configuredModels(ctx, providerId) {
  const entry = ctx.llm?.listConfigurableProviders?.().find(row => row.provider === providerId)
  if (!entry) return undefined
  const view = ctx.get('settings')?.describe({ redactSecrets: true }).find(row => row.ns === entry.settingsNs)
  const profile = entry.settingsPath.reduce((value, part) => value?.[part], view?.value)
  // The host treats an absent/empty list as the inherited complete catalog.
  return Array.isArray(profile?.models) && profile.models.length ? profile.models : undefined
}

export function selectModels(models, configured) {
  if (!configured) return models
  const byId = new Map(models.map(model => [model.id, model]))
  return configured.flatMap(entry => {
    const model = byId.get(entry.id)
    if (!model) return []
    // Preserve the native editor's explicit capacity/name/input overrides.
    const { id, name, contextWindow, maxTokens, input } = entry
    return [{ ...model, id,
      ...(name === undefined ? {} : { name }),
      ...(contextWindow === undefined ? {} : { contextWindow }),
      ...(maxTokens === undefined ? {} : { maxTokens }),
      ...(input === undefined ? {} : { input }),
    }]
  })
}

/** Repair only the host's missing-descriptor diagnostic after a cold start. */
export function repairCatalogGaps(snapshot, providerIds, candidates) {
  if (!(snapshot?.profiles instanceof Map)) return snapshot
  const profiles = new Map(snapshot.profiles)
  let changed = false
  for (const providerId of providerIds) {
    const profile = profiles.get(providerId)
    if (!profile?.piProvider || !profile.modelErrors?.size) continue
    const models = new Map(candidates(providerId).map(model => [model.id, model]))
    const errors = new Map(profile.modelErrors)
    const resolved = new Set()
    for (const [id, message] of errors) {
      const model = models.get(id)
      if (model && typeof model.api === 'string' && Number.isInteger(model.contextWindow) && model.contextWindow > 0
        && Number.isInteger(model.maxTokens) && model.maxTokens > 0
        && message.endsWith('needs an api; the installed catalog does not describe it, so set the route\'s api to the wire protocol its endpoint speaks')) {
        errors.delete(id)
        resolved.add(message)
      }
    }
    if (errors.size === profile.modelErrors.size) continue
    const next = { ...profile, modelErrors: errors }
    if (resolved.has(profile.catalogError)) {
      delete next.catalogError
      if (errors.size) next.catalogError = errors.values().next().value
    }
    profiles.set(providerId, next)
    changed = true
  }
  return changed ? { ...snapshot, profiles } : snapshot
}

/** Keep the host's settings directory aligned with repaired runtime diagnostics. */
export function syncNativeDiagnostics(records, directory, snapshot, repaired, providerIds) {
  if (!(directory instanceof Map) || !(repaired?.profiles instanceof Map)) return
  for (const providerId of providerIds) {
    const entry = directory.get(providerId), profile = repaired.profiles.get(providerId)
    if (!profile?.piProvider || typeof entry?.error !== 'string' || entry.error === profile.catalogError
      || !entry.error.endsWith('needs an api; the installed catalog does not describe it, so set the route\'s api to the wire protocol its endpoint speaks')) continue
    // Only a diagnostic actually removed from this native snapshot is resolved.
    // A newer native directory registration must start its own restoration record.
    if (![...snapshot.profiles.get(providerId)?.modelErrors?.values() ?? []].includes(entry.error)
      || [...profile.modelErrors.values()].includes(entry.error)) continue
    const previous = records.get(providerId)
    const original = previous?.directory === directory && previous.written === entry ? previous.original : entry
    const written = { ...entry }
    if (profile.catalogError === undefined) delete written.error
    else written.error = profile.catalogError
    directory.set(providerId, written)
    records.set(providerId, { directory, original, written })
  }
}

export function restoreNativeDiagnostics(records) {
  for (const [providerId, { directory, original, written }] of records) {
    if (directory.get(providerId) === written) directory.set(providerId, original)
  }
  records.clear()
}

/** Runtime-only changes, shared across HMR and restored when the plugin stops. */
export function syncNativeCatalog(records, providerId, target, merge) {
  if (!target || typeof target !== 'object' || Object.isFrozen(target)) throw new Error('unsupported native model catalog: ' + providerId)
  let record = records.get(providerId)
  if (!record) {
    record = { target, original: new Map(Object.entries(target)), written: new Map() }
    records.set(providerId, record)
  }
  const merged = merge([...record.original.values()])
  const next = new Map(merged.map(model => [model.id, model]))
  for (const [id, value] of record.written) {
    if (!next.has(id) && target[id] === value) delete target[id]
  }
  for (const [id, model] of next) target[id] = model
  record.written = next
}

export function restoreNativeCatalogs(records) {
  for (const { target, original, written } of records.values()) {
    for (const [id, model] of written) {
      if (target[id] !== model) continue
      if (original.has(id)) target[id] = original.get(id)
      else delete target[id]
    }
    for (const [id, model] of original) if (!Object.hasOwn(target, id)) target[id] = model
  }
  records.clear()
}
