/** P0 diagnostics only. Import into an existing Electron-backed run_code process.
 * No plugin registration, real credentials, or real network requests are used.
 * A mock Context/credential provider surrounds the unmodified host apply() and adapter.
 * The process-local fetch replacement is restored in finally; never mount this as a plugin.
 */
export async function runP0Probe(moduleRoot) {
  const { default: assert } = await import('node:assert/strict');
  const host = await import(moduleRoot + '/@deepseek-ai/dsh-llm-pi-ai/lib/index.js');
  const { createModels } = await import(moduleRoot + '/@earendil-works/pi-ai/dist/models.js');
  const { openaiProvider } = await import(moduleRoot + '/@earendil-works/pi-ai/dist/providers/openai.js');
  const { openaiCodexProvider } = await import(moduleRoot + '/@earendil-works/pi-ai/dist/providers/openai-codex.js');
  const originalFetch = globalThis.fetch;
  const tests = [];
  let active;
  const jwt = (account) => ['p0', Buffer.from(JSON.stringify({
    'https://api.openai.com/auth': { chatgpt_account_id: account },
  })).toString('base64'), 'not-a-signature'].join('.');
  const grant = (account, expired = false) => ({ kind: 'grant', payload: {
    type: 'oauth', access: jwt(account), refresh: 'p0-synthetic-refresh',
    expires: expired ? 0 : Date.now() + 3600000, accountId: account,
  }});
  async function test(id, fn) {
    active = { requests: [], refreshes: 0, failRefresh: false, unexpectedRequests: 0 };
    try { await fn(); assert.equal(active.unexpectedRequests, 0); tests.push({ id, status: 'PASS', evidence: {
      modelRequests: active.requests.map(({ endpoint, provider, scheme, hasAccountHeader, hasOpencodeHeader }) =>
        ({ endpoint, provider, scheme, hasAccountHeader, hasOpencodeHeader })),
      refreshRequests: active.refreshes,
    }}); }
    catch (error) { tests.push({ id, status: 'FAIL', errorName: error.name }); }
  }
  // No delegation to originalFetch: an unexpected URL is an assertion failure.
  globalThis.fetch = async (input, init) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    if (url.href === 'https://auth.openai.com/oauth/token') {
      active.refreshes++;
      const form = new URLSearchParams(await req.text());
      assert.equal(form.get('grant_type'), 'refresh_token');
      assert.equal(form.get('refresh_token'), 'p0-synthetic-refresh');
      if (active.failRefresh) return new Response('P0 mock rejection', { status: 401 });
      return Response.json({ access_token: jwt('p0-rotated-account'),
        refresh_token: 'p0-synthetic-rotated-refresh', expires_in: 3600 });
    }
    if (!['https://api.openai.com/v1/responses',
      'https://chatgpt.com/backend-api/codex/responses'].includes(url.href)) {
      active.unexpectedRequests++;
      throw Error('Unexpected request blocked by offline probe');
    }
    assert.equal(req.method, 'POST');
    active.requests.push({ endpoint: url.href,
      provider: url.hostname === 'chatgpt.com' ? 'openai-codex' : 'openai',
      scheme: req.headers.get('authorization')?.split(' ')[0],
      hasAccountHeader: req.headers.has('chatgpt-account-id'),
      hasOpencodeHeader: req.headers.has('x-opencode-session'),
      authorization: req.headers.get('authorization'),
      account: req.headers.get('chatgpt-account-id'),
    });
    // Deliberately stop after observing the SDK's constructed HTTP request.
    // This does NOT simulate successful inference or a real server accepting OAuth.
    return Response.json({ error: { message: 'P0 mock terminal response' } }, { status: 400 });
  };
  function composition({ records = new Map(), refs = new Map(), profiles = {
    openai: {}, 'openai-codex': { transport: 'sse' },
  } } = {}) {
    let adapter;
    let chain = Promise.resolve();
    const reads = [], writes = [];
    const credentials = {
      readRecord: async key => { reads.push(key); return structuredClone(records.get(key)); },
      modifyRecord: (key, mutate) => {
        const mutation = chain.then(async () => {
          const next = await mutate(structuredClone(records.get(key)));
          if (next !== undefined) { records.set(key, structuredClone(next)); writes.push(key); }
          return structuredClone(records.get(key));
        });
        chain = mutation.catch(() => {});
        return mutation;
      },
      deleteRecord: async key => { records.delete(key); },
      listRecords: async () => [...records].map(([key, record]) => ({key, kind:record.kind})),
      resolve: async name => refs.has(name) ? { value: refs.get(name) } : undefined,
    };
    // This is intentionally NOT a real Loader/host composition.
    const ctx = { fiber: {}, get: name => name === 'credentials' ? credentials : undefined,
      inject() {}, effect() {}, on() {}, logger: { warn() {}, error() {} },
      llm: { registerAdapter(routes, value) { adapter = value; return { replace() {} }; },
        registerConfigurableProviders() { return { replace() {} }; }, registerModelDiscovery() {} },
    };
    host.apply(ctx, host.Config({ providers: profiles }));
    return { adapter, credentials, records, reads, writes };
  }
  const key = provider => host.recordKeyFor(provider);
  async function call(c, provider) {
    const models = await c.adapter.listModels(provider);
    const model = models[0].id;
    try {
      let terminalFailure;
      for await (const chunk of c.adapter.stream({ provider, model, maxTokens: 1,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'P0 offline diagnostic' }] }],
      })) {
        if (chunk.type === 'finish' && chunk.reason.kind === 'error') terminalFailure = chunk.reason.failure;
      }
      return { failed: terminalFailure !== undefined, code: terminalFailure?.code };
    } catch (error) { return { failed: true, code: error.code }; }
  }
  try {
    await test('T01-native-openai-oauth-login-is-unsupported', async () => {
      const m = createModels({ authContext: { env: async () => undefined, fileExists: async () => false } });
      m.setProvider(openaiProvider());
      assert.equal(m.login.length, 3);
      assert.equal(openaiProvider().auth.oauth, undefined);
      assert.ok(openaiCodexProvider().auth.oauth);
      await assert.rejects(m.login('openai', 'oauth', { signal: new AbortController().signal,
        notify() {}, prompt: async () => { throw Error('Unexpected prompt'); } }),
        error => error.code === 'auth' && error.message === 'OpenAI does not support oauth login');
      assert.equal(active.requests.length, 0);
    });
    await test('T02-openai-oauth-record-rejected-before-http', async () => {
      const c = composition({ records: new Map([[key('openai'), grant('p0-a')]]) });
      assert.ok((await call(c, 'openai')).failed);
      assert.ok(c.reads.includes(key('openai')));
      assert.equal(active.requests.length, 0);
    });
    await test('T03-unsupported-oauth-does-not-fallback-to-ambient-key', async () => {
      const c = composition({ records: new Map([[key('openai'), grant('p0-a')]]),
        refs: new Map([['OPENAI_API_KEY', 'p0-ambient-key']]) });
      assert.ok((await call(c, 'openai')).failed);
      assert.equal(active.requests.length, 0);
    });
    await test('T04-apiKeyEnv-overrides-stored-openai-oauth', async () => {
      const c = composition({ records: new Map([[key('openai'), grant('p0-a')]]),
        refs: new Map([['P0_KEY_REF', 'p0-explicit-key']]),
        profiles: { openai: { apiKeyEnv: 'P0_KEY_REF' } } });
      await call(c, 'openai');
      assert.equal(active.requests.length, 1);
      assert.equal(active.requests[0].authorization, 'Bearer p0-explicit-key');
      assert.equal(active.requests[0].endpoint, 'https://api.openai.com/v1/responses');
      assert.equal(c.reads.length, 0);
    });
    await test('T05-missing-apiKeyEnv-stops-without-stored-fallback', async () => {
      const c = composition({ records: new Map([[key('openai'), grant('p0-a')]]),
        profiles: { openai: { apiKeyEnv: 'P0_MISSING_REF' } } });
      assert.equal((await call(c, 'openai')).code, 'MISSING_CREDENTIAL');
      assert.equal(active.requests.length, 0);
      assert.equal(c.reads.length, 0);
    });
    await test('T06-stored-api-key-wins-over-ambient', async () => {
      const c = composition({ records: new Map([[key('openai'), {kind:'api-key', key:'p0-stored-key'}]]),
        refs: new Map([['OPENAI_API_KEY', 'p0-ambient-key']]) });
      await call(c, 'openai');
      assert.equal(active.requests.length, 1);
      assert.equal(active.requests[0].authorization, 'Bearer p0-stored-key');
    });
    await test('T07-ambient-key-used-only-without-stored-record', async () => {
      const c = composition({ refs: new Map([['OPENAI_API_KEY', 'p0-ambient-key']]) });
      await call(c, 'openai');
      assert.equal(active.requests.length, 1);
      assert.equal(active.requests[0].authorization, 'Bearer p0-ambient-key');
    });
    await test('T08-codex-oauth-reaches-correct-http-endpoint', async () => {
      const c = composition({ records: new Map([[key('openai-codex'), grant('p0-a')]]) });
      await call(c, 'openai-codex');
      assert.equal(active.requests.length, 1);
      assert.equal(active.requests[0].authorization, 'Bearer ' + jwt('p0-a'));
      assert.equal(active.requests[0].account, 'p0-a');
      assert.equal(active.requests[0].endpoint, 'https://chatgpt.com/backend-api/codex/responses');
      assert.equal(active.requests[0].hasOpencodeHeader, false);
    });
    await test('T09-account-switch-read-by-same-adapter-next-call', async () => {
      const c = composition({ records: new Map([[key('openai-codex'), grant('p0-a')]]) });
      await call(c, 'openai-codex');
      await c.credentials.modifyRecord(key('openai-codex'), async () => grant('p0-b'));
      await call(c, 'openai-codex');
      assert.equal(active.requests.length, 2);
      assert.equal(active.requests[0].account, 'p0-a');
      assert.equal(active.requests[1].account, 'p0-b');
      assert.equal(active.requests[1].authorization, 'Bearer ' + jwt('p0-b'));
    });
    await test('T10-expired-codex-refreshes-and-writes-before-http', async () => {
      const c = composition({ records: new Map([[key('openai-codex'), grant('p0-a', true)]]) });
      await call(c, 'openai-codex');
      assert.equal(active.refreshes, 1);
      assert.equal(c.writes.length, 1);
      assert.equal(c.records.get(key('openai-codex')).payload.refresh, 'p0-synthetic-rotated-refresh');
      assert.equal(active.requests.length, 1);
      assert.equal(active.requests[0].account, 'p0-rotated-account');
    });
    await test('T11-parallel-codex-refresh-deduplicated-with-mock-lock', async () => {
      const c = composition({ records: new Map([[key('openai-codex'), grant('p0-a', true)]]) });
      await Promise.all([call(c, 'openai-codex'), call(c, 'openai-codex')]);
      assert.equal(active.refreshes, 1);
      assert.equal(c.writes.length, 1);
      assert.equal(active.requests.length, 2);
    });
    await test('T12-refresh-failure-does-not-fallback-or-write', async () => {
      active.failRefresh = true;
      const c = composition({ records: new Map([[key('openai-codex'), grant('p0-a', true)]]),
        refs: new Map([['OPENAI_API_KEY', 'p0-ambient-key']]) });
      assert.ok((await call(c, 'openai-codex')).failed);
      assert.equal(active.refreshes, 1);
      assert.equal(c.writes.length, 0);
      assert.equal(active.requests.length, 0);
    });
    await test('T13-provider-records-and-protocols-are-independent', async () => {
      const c = composition({ records: new Map([
        [key('openai'), {kind:'api-key', key:'p0-openai-key'}],
        [key('openai-codex'), grant('p0-codex-account')],
      ]) });
      await call(c, 'openai');
      await call(c, 'openai-codex');
      assert.equal(active.requests.length, 2);
      assert.equal(active.requests[0].authorization, 'Bearer p0-openai-key');
      assert.equal(active.requests[0].hasAccountHeader, false);
      assert.equal(active.requests[1].account, 'p0-codex-account');
      assert.equal(active.requests[1].hasOpencodeHeader, false);
    });
    await test('T14-new-adapter-reads-serialized-mock-record-not-real-restart', async () => {
      const first = composition({ records: new Map([[key('openai-codex'), grant('p0-a')]]) });
      const image = JSON.stringify([...first.records]);
      const second = composition({ records: new Map(JSON.parse(image)) });
      await call(second, 'openai-codex');
      assert.equal(active.requests.length, 1);
      assert.equal(active.requests[0].account, 'p0-a');
    });
    await test('T16-codex-apiKeyEnv-overrides-oauth-and-selects-key-account', async () => {
      const c = composition({ records: new Map([[key('openai-codex'), grant('p0-stored-account')]]),
        refs: new Map([['P0_CODEX_REF', jwt('p0-key-account')]]),
        profiles: { 'openai-codex': { apiKeyEnv: 'P0_CODEX_REF', transport: 'sse' } } });
      await call(c, 'openai-codex');
      assert.equal(active.requests.length, 1);
      assert.equal(active.requests[0].account, 'p0-key-account');
      assert.equal(c.reads.length, 0);
    });
    await test('T17-explicit-pi-apiKey-override-wins', async () => {
      const m = createModels({
        credentials: { read: async () => ({type:'api_key',key:'p0-stored-key'}) },
        authContext: { env: async () => 'p0-ambient-key', fileExists: async () => false } });
      m.setProvider(openaiProvider());
      const resolved = await m.getAuth('openai', {apiKey:'p0-request-key'});
      assert.equal(resolved.auth.apiKey, 'p0-request-key');
      assert.equal(active.requests.length, 0);
    });
    await test('T15-logout-deletion-takes-effect-next-call', async () => {
      const c = composition({ records: new Map([[key('openai-codex'), grant('p0-a')]]) });
      await call(c, 'openai-codex');
      await c.credentials.deleteRecord(key('openai-codex'));
      assert.ok((await call(c, 'openai-codex')).failed);
      assert.equal(active.requests.length, 1);
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
  return { mode: 'OFFLINE_MOCK_HTTP_BOUNDARY', timestamp: new Date().toISOString(),
    runtime: { node: process.versions.node, electron: process.versions.electron, platform: process.platform, arch: process.arch },
    moduleRoot, fetchRestored: globalThis.fetch === originalFetch,
    realNetworkRequests: 0, realCredentialReads: 0, realCredentialWrites: 0,
    realOAuthLogin: 'NOT_RUN', realInference: 'NOT_RUN', realHostRestart: 'NOT_RUN',
    tests, passed: tests.filter(t => t.status === 'PASS').length,
    failed: tests.filter(t => t.status !== 'PASS').length };
}
