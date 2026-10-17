async function defaultLoad() {
  const pi = await import('@earendil-works/pi-ai')
  const { openaiCodexProvider } = await import('@earendil-works/pi-ai/providers/openai-codex')
  return { pi, openaiCodexProvider }
}

/**
 * Optional Pi-AI refresh for the native Codex OAuth credential. Loads lazily
 * so the plugin still starts when pi-ai is absent; without it an expired
 * credential is reported as auth-required instead of refreshed.
 * @param {any} credentials - host credentials service.
 * @returns {(opts: {signal?: AbortSignal}) => Promise<any>} refresh function or undefined.
 */
export async function makeCodexRefresh(credentials, load = defaultLoad) {
  try {
    const { pi, openaiCodexProvider } = await load()
    return async ({ signal } = {}) => {
      const models = pi.createModels({
        credentials: {
          async read() {
            const r = await credentials.readRecord('llm-pi-ai/openai-codex')
            return r?.payload
          },
          async list() { return [{ providerId: 'openai-codex', type: 'oauth' }] },
          async modify(id, mutate) {
            const r = await credentials.modifyRecord('llm-pi-ai/openai-codex', async (cur) => {
              const next = await mutate(cur?.payload)
              return next === undefined ? undefined : { kind: 'grant', payload: next }
            })
            return r?.payload
          },
          async delete() { throw new Error('delete not supported during quota refresh') },
        },
        authContext: { env: async () => undefined, fileExists: async () => false },
      })
      models.setProvider(openaiCodexProvider())
      await models.getAuth('openai-codex', { signal, minOAuthValidityMs: 1 })
      const after = await credentials.readRecord('llm-pi-ai/openai-codex')
      return after?.payload
    }
  } catch {
    return undefined
  }
}
