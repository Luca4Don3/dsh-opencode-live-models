/** P0 verification only: real bundled services in fresh, isolated Cordis contexts.
 * Uses synthetic data in a new directory below the plugin's .temp/p0.
 * No live host registration/configuration, real credentials, or network are used.
 * Does not implement or install an OAuth/usage plugin.
 */
export async function runP0PublicServicesProbe(moduleRoot, pluginRoot) {
  const { default: assert } = await import('node:assert/strict');
  const fs = await import('node:fs/promises');
  const { join, resolve } = await import('node:path');
  const { Context } = await import(moduleRoot + '/@deepseek-ai/cordis/lib/index.js');
  const { LocalCredentialProvider } = await import(moduleRoot + '/@deepseek-ai/dsh-credentials-local/lib/index.js');
  const { AuthorizationService } = await import(moduleRoot + '/@deepseek-ai/dsh-authorization/lib/index.js');
  const { SlotCore } = await import(moduleRoot + '/@deepseek-ai/dsh-client-ui-slots/lib/index.js');
  const host = await import(moduleRoot + '/@deepseek-ai/dsh-llm-pi-ai/lib/index.js');
  const parent = resolve(pluginRoot, '.temp/p0');
  assert.ok(parent.startsWith(resolve(pluginRoot) + '/'));
  await fs.mkdir(parent, { recursive: true, mode: 0o700 });
  const directory = await fs.mkdtemp(join(parent, 'public-services-'));
  const contexts = new Set();
  const tests = [];
  const originalFetch = globalThis.fetch;
  let current;
  const jwt = account => ['p0', Buffer.from(JSON.stringify({
    'https://api.openai.com/auth': { chatgpt_account_id: account },
  })).toString('base64'), 'not-a-signature'].join('.');
  const grant = (account, expires = Date.now() + 3600000) => ({kind:'grant', payload:{
    type:'oauth',access:jwt(account),refresh:'p0-synthetic-refresh',expires,accountId:account,
  }});
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.href === 'https://auth.openai.com/api/accounts/deviceauth/usercode') {
      current.loginRequests++;
      return Response.json({device_auth_id:'p0-device',user_code:'P0-FAKE',interval:0});
    }
    if (url.href === 'https://auth.openai.com/api/accounts/deviceauth/token') {
      current.loginRequests++;
      return Response.json({authorization_code:'p0-auth-code',code_verifier:'p0-verifier'});
    }
    if (url.href === 'https://auth.openai.com/oauth/token') {
      const body = new URLSearchParams(await request.text());
      if (body.get('grant_type') === 'authorization_code') {
        current.loginRequests++;
        assert.equal(body.get('code'), 'p0-auth-code');
        return Response.json({access_token:jwt('p0-login-account'),refresh_token:'p0-synthetic-refresh',expires_in:3600});
      }
      assert.equal(body.get('grant_type'), 'refresh_token');
      assert.equal(body.get('refresh_token'), 'p0-synthetic-refresh');
      current.refreshRequests++;
      return Response.json({access_token:jwt('p0-refresh-account'),refresh_token:'p0-synthetic-rotated',expires_in:3600});
    }
    if (url.href !== 'https://chatgpt.com/backend-api/codex/responses') {
      current.unexpectedRequests++;
      throw Error('Unexpected network target blocked by P0 probe');
    }
    assert.equal(request.method,'POST');
    current.modelRequests.push({endpoint:url.href,authorization:request.headers.get('authorization'),
      account:request.headers.get('chatgpt-account-id'),opencode:request.headers.has('x-opencode-session')});
    return Response.json({error:{message:'P0 mock terminal response'}},{status:400});
  };
  async function boot(filename, auth = false) {
    const ctx = new Context();
    contexts.add(ctx);
    const credentialFiber = ctx.plugin(LocalCredentialProvider, {path:filename,watch:false});
    await credentialFiber;
    if (auth) await ctx.plugin(AuthorizationService);
    return {ctx,credentials:ctx.get('credentials'),authorization:ctx.get('authorization'),credentialFiber};
  }
  async function close(ctx) {
    try { await ctx.fiber.dispose(); } finally { contexts.delete(ctx); }
  }
  async function test(id, fn) {
    current = {loginRequests:0,refreshRequests:0,modelRequests:[],unexpectedRequests:0};
    const before = new Set(contexts);
    try {
      const details = await fn(join(directory, id + '.yaml'));
      assert.equal(current.unexpectedRequests,0);
      tests.push({id,status:'PASS',evidence:{...details,loginRequests:current.loginRequests,
        refreshRequests:current.refreshRequests,
        modelRequests:current.modelRequests.map(r=>({endpoint:r.endpoint,scheme:r.authorization?.split(' ')[0],
          hasAccountHeader:!!r.account,hasOpencodeHeader:r.opencode}))}});
    } catch (error) { tests.push({id,status:'FAIL',errorName:error.name,errorCode:error.code}); }
    finally {
      for (const ctx of [...contexts].filter(ctx=>!before.has(ctx)).reverse()) await close(ctx);
    }
  }
  async function nativeAdapter(c) {
    let adapter;
    c.ctx.provide('llm',{
      registerAdapter(routes,value) {adapter=value;return {replace(){}};},
      registerConfigurableProviders() {return {replace(){}};},registerModelDiscovery(){},
    });
    const fiber = c.ctx.plugin({name:'p0-isolated-native-adapter',inject:['llm'],apply(ctx){
      host.apply(ctx,host.Config({providers:{openai:{},'openai-codex':{transport:'sse'}}}));
    }});
    await fiber;
    assert.ok(adapter);
    return adapter;
  }
  async function call(adapter,provider) {
    const model=(await adapter.listModels(provider))[0].id;
    let failed=false;
    try {
      for await(const chunk of adapter.stream({provider,model,maxTokens:1,
        messages:[{role:'user',content:[{type:'text',text:'P0 isolated verification'}]}]})) {
        if(chunk.type==='finish' && chunk.reason.kind==='error')failed=true;
      }
    }catch{failed=true;}
    return {failed};
  }
  const ownKey='p0-validation/counter';
  const codexKey=host.recordKeyFor('openai-codex');
  const put=(store,key,record)=>store.modifyRecord(key,async()=>record);
  const interaction={notify(){},prompt:async()=>''};
  try {
    await test('S01-real-store-roundtrip-and-owner-only-file',async file=>{
      const c=await boot(file);
      await put(c.credentials,codexKey,grant('p0-a'));
      assert.equal((await c.credentials.readRecord(codexKey)).payload.accountId,'p0-a');
      assert.equal((await fs.stat(file)).mode&0o777,0o600);
      assert.equal((await c.credentials.describeRecord(codexKey)).kind,'grant');
      return {realStore:true,filePermissions:'0600'};
    });
    await test('S02-service-recreation-restores-durable-record',async file=>{
      const a=await boot(file);
      await put(a.credentials,codexKey,grant('p0-a'));
      await close(a.ctx);
      const b=await boot(file);
      assert.equal((await b.credentials.readRecord(codexKey)).payload.accountId,'p0-a');
      return {serviceRecreated:true,realDshRestart:false};
    });
    await test('S03-undefined-keeps-record-and-does-not-notify',async file=>{
      const c=await boot(file);
      await put(c.credentials,ownKey,{kind:'grant',payload:{counter:4}});
      let updates=0;
      const off=c.ctx.on('credentials/record-updated',()=>{updates++;});
      try{
        const result=await c.credentials.modifyRecord(ownKey,async()=>undefined);
        assert.equal(result.payload.counter,4);assert.equal(updates,0);
        assert.equal((await c.credentials.readRecord(ownKey)).payload.counter,4);
      }finally{off();}
      return {undefinedMeans:'retain'};
    });
    await test('S04-invalid-payload-does-not-change-disk',async file=>{
      const c=await boot(file);
      await put(c.credentials,ownKey,{kind:'grant',payload:{counter:1}});
      const prior=await fs.readFile(file);
      await assert.rejects(put(c.credentials,ownKey,{kind:'grant',payload:{counter:NaN}}));
      assert.deepEqual(await fs.readFile(file),prior);
      return {invalidJsonRejected:true,diskUnchanged:true};
    });
    await test('S05-delete-only-target-synthetic-record',async file=>{
      const c=await boot(file);
      await put(c.credentials,ownKey,{kind:'grant',payload:{counter:1}});
      await put(c.credentials,codexKey,grant('p0-a'));
      await c.credentials.deleteRecord(ownKey);
      assert.equal(await c.credentials.readRecord(ownKey),undefined);
      assert.equal((await c.credentials.readRecord(codexKey)).payload.accountId,'p0-a');
      return {unrelatedRecordPreserved:true};
    });
    await test('S06-one-real-store-concurrent-modify-is-serialized',async file=>{
      const c=await boot(file);
      await put(c.credentials,ownKey,{kind:'grant',payload:{counter:0}});
      await Promise.all(Array.from({length:12},()=>c.credentials.modifyRecord(ownKey,async record=>
        ({kind:'grant',payload:{counter:record.payload.counter+1}}))));
      assert.equal((await c.credentials.readRecord(ownKey)).payload.counter,12);
      return {concurrentModifications:12,finalCounter:12};
    });
    await test('S07-two-real-stores-share-actual-file-lock',async file=>{
      const a=await boot(file);await put(a.credentials,ownKey,{kind:'grant',payload:{counter:0}});
      const b=await boot(file);
      await Promise.all(Array.from({length:12},(_,i)=>(i%2?a:b).credentials.modifyRecord(ownKey,async record=>
        ({kind:'grant',payload:{counter:record.payload.counter+1}}))));
      const fresh=await boot(file);
      assert.equal((await fresh.credentials.readRecord(ownKey)).payload.counter,12);
      return {independentServices:2,actualFileLock:true,finalCounter:12,crossProcess:false};
    });
    await test('S08-service-dispose-unregisters-and-refuses-new-writes',async file=>{
      const c=await boot(file);
      const service=c.credentials;
      await c.credentialFiber.dispose();
      assert.equal(c.ctx.get('credentials'),undefined);
      await assert.rejects(put(service,ownKey,{kind:'grant',payload:{counter:1}}),/disposed/);
      return {serviceWithdrawn:true,postDisposeWritesRejected:true};
    });
    await test('S09-fiber-disposal-removes-owned-listeners',async file=>{
      const c=await boot(file);let calls=0;
      const owner=c.ctx.plugin({name:'p0-owned-listener',apply(ctx){ctx.on('p0-validation/pulse',()=>{calls++;});}});
      await owner;c.ctx.emit('p0-validation/pulse');assert.equal(calls,1);
      await owner.dispose();c.ctx.emit('p0-validation/pulse');assert.equal(calls,1);
      return {ownedListenerRemoved:true};
    });
    await test('S10-native-codex-reads-real-store-at-http-boundary',async file=>{
      const c=await boot(file);await put(c.credentials,codexKey,grant('p0-a'));
      const adapter=await nativeAdapter(c);await call(adapter,'openai-codex');
      assert.equal(current.modelRequests.length,1);
      assert.equal(current.modelRequests[0].authorization,'Bearer '+jwt('p0-a'));
      assert.equal(current.modelRequests[0].account,'p0-a');
      return {realStoreToNativeAdapter:true};
    });
    await test('S11-native-refresh-writes-real-store-before-http',async file=>{
      const c=await boot(file);await put(c.credentials,codexKey,grant('p0-a',0));
      const adapter=await nativeAdapter(c);await call(adapter,'openai-codex');
      assert.equal(current.refreshRequests,1);assert.equal(current.modelRequests.length,1);
      assert.equal(current.modelRequests[0].account,'p0-refresh-account');
      const reloaded=await boot(file);
      assert.equal((await reloaded.credentials.readRecord(codexKey)).payload.refresh,'p0-synthetic-rotated');
      return {rotatedSyntheticGrantPersisted:true,realTokenEndpoint:false};
    });
    await test('S20-two-native-adapters-deduplicate-refresh-with-real-file-lock',async file=>{
      const a=await boot(file);await put(a.credentials,codexKey,grant('p0-a',0));
      const b=await boot(file);
      const aa=await nativeAdapter(a),bb=await nativeAdapter(b);
      await Promise.all([call(aa,'openai-codex'),call(bb,'openai-codex')]);
      assert.equal(current.refreshRequests,1);assert.equal(current.modelRequests.length,2);
      assert.ok(current.modelRequests.every(r=>r.account==='p0-refresh-account'));
      const reloaded=await boot(file);
      assert.equal((await reloaded.credentials.readRecord(codexKey)).payload.refresh,'p0-synthetic-rotated');
      return {independentAdapters:2,actualFileLock:true,refreshCount:1,crossProcess:false};
    });
    await test('S12-openai-real-store-still-cannot-consume-oauth',async file=>{
      const c=await boot(file);await put(c.credentials,host.recordKeyFor('openai'),grant('p0-a'));
      const adapter=await nativeAdapter(c);
      assert.ok((await call(adapter,'openai')).failed);assert.equal(current.modelRequests.length,0);
      return {openaiOAuthUnsupported:true};
    });
    await test('S13-public-authorization-commits-own-real-record',async file=>{
      const c=await boot(file,true);const key='p0-validation/own-flow';
      const owner=c.ctx.plugin({name:'p0-own-flow',inject:['authorization'],apply(ctx){ctx.authorization.registerFlow({
        key,label:'P0 synthetic',methods:[{id:'synthetic',label:'Synthetic'}],
        run:async session=>session.commit({kind:'grant',payload:{synthetic:true}}),
      });}});await owner;
      assert.equal((await c.authorization.begin({key,method:'synthetic',interaction})).status,'authorized');
      assert.equal((await c.credentials.readRecord(key)).payload.synthetic,true);
      await owner.dispose();assert.equal(c.authorization.describe(key),undefined);
      return {ownKeyCommitObserved:true,flowRemovedOnFiberDispose:true};
    });
    await test('S14-other-key-write-cannot-bypass-flow-commit-check',async file=>{
      const c=await boot(file,true);const key='p0-validation/wrong-flow';
      const owner=c.ctx.plugin({name:'p0-wrong-flow',inject:['authorization'],apply(ctx){ctx.authorization.registerFlow({
        key,label:'P0 synthetic',methods:[{id:'synthetic',label:'Synthetic'}],
        run:async()=>put(c.credentials,codexKey,grant('p0-a')),
      });}});await owner;
      await assert.rejects(c.authorization.begin({key,interaction}),error=>error.code==='NOT_COMMITTED');
      await owner.dispose();return {differentKeyRejected:true};
    });
    await test('S15-duplicate-flow-is-rejected-without-replacing-owner',async file=>{
      const c=await boot(file,true);const key='p0-validation/duplicate';
      const flow={key,label:'P0 owner',methods:[{id:'synthetic',label:'Synthetic'}],run:async()=>{}};
      const dispose=c.authorization.registerFlow(flow);
      try{
        assert.throws(()=>c.authorization.registerFlow({...flow,label:'P0 replacement'}),error=>error.code==='DUPLICATE_FLOW');
        assert.equal(c.authorization.describe(key).label,'P0 owner');
      }finally{dispose();}
      assert.equal(c.authorization.describe(key),undefined);
      return {duplicateRejected:true,originalOwnerPreserved:true};
    });
    await test('S16-flow-fiber-dispose-cancels-pending-attempt',async file=>{
      const c=await boot(file,true);const key='p0-validation/cancel';let aborted=false,entered;
      const ready=new Promise(resolve=>{entered=resolve;});
      const owner=c.ctx.plugin({name:'p0-cancellable-flow',inject:['authorization'],apply(ctx){ctx.authorization.registerFlow({
        key,label:'P0 cancellable',methods:[{id:'synthetic',label:'Synthetic'}],run:async session=>{
          await new Promise(resolve=>{session.signal.addEventListener('abort',()=>{aborted=true;resolve();},{once:true});entered();});
        },
      });}});await owner;
      const pending=c.authorization.begin({key,interaction});await ready;await owner.dispose();
      assert.equal((await pending).status,'cancelled');assert.equal(aborted,true);
      assert.equal(c.authorization.describe(key),undefined);
      assert.equal(await c.credentials.readRecord(key),undefined);
      return {pendingAttemptCancelled:true,noCredentialCommitted:true};
    });
    await test('S17-native-codex-mock-login-disk-handoff-and-http',async file=>{
      const c=await boot(file,true);const adapter=await nativeAdapter(c);
      let notice=false;
      const result=await c.authorization.begin({key:codexKey,method:'oauth',interaction:{
        notify(n){if(n.code==='P0-FAKE')notice=true;},
        prompt:async p=>{assert.equal(p.kind,'select');return 'device_code';},
      }});
      assert.equal(result.status,'authorized');assert.equal(notice,true);
      assert.equal(current.loginRequests,3);
      assert.equal((await c.credentials.readRecord(codexKey)).payload.accountId,'p0-login-account');
      await call(adapter,'openai-codex');
      assert.equal(current.modelRequests.length,1);assert.equal(current.modelRequests[0].account,'p0-login-account');
      const restored=await boot(file);
      assert.equal((await restored.credentials.readRecord(codexKey)).payload.accountId,'p0-login-account');
      return {nativeModelsLoginUsed:true,realDiskHandoff:true,authorizationServer:'mock',realOAuthAuthorization:false};
    });
    await test('S18-slotcore-declarations-and-recursive-disposal',async()=>{
      const core=new SlotCore(),Component=()=>null,handle={};
      assert.throws(()=>core.register({name:'p0.x',id:'x'},Component),/not declared/);
      const epochs=[];const off=core.subscribeDeclaration('p0.x',()=>epochs.push(core.declarationEpoch('p0.x')));
      const parent=core.register({name:'root',store:handle,children:{'p0.x':{kind:'list',scope:'session'}}},Component);
      try{
        assert.deepEqual(core.spec('p0.x'),{kind:'list',scope:'session'});
        assert.throws(()=>core.register({name:'root',priority:1,children:{'p0.x':{kind:'list',scope:'root'}}},Component),/already declared/);
        assert.throws(()=>core.register({name:'p0.x',id:'bad',store:handle},Component),/one handle, one scope/);
        const child=core.register({name:'p0.x',id:'x',children:{'p0.leaf':{kind:'single',scope:'session'}}},Component);
        const leaf=core.register({name:'p0.leaf'},Component);const entry=core.entries('p0.x')[0];
        assert.ok(core.isLive(entry));leaf();leaf();assert.equal(core.entries('p0.leaf').length,0);
        const leaf2=core.register({name:'p0.leaf'},Component);parent();parent();child();leaf2();
        assert.equal(core.isLive(entry),false);
        for(const k of ['p0.x','p0.leaf']){assert.equal(core.spec(k),undefined);assert.equal(core.entries(k).length,0);}
        assert.deepEqual(epochs,[1,2]);
      }finally{parent();off();await Promise.resolve();}
      return {recursiveDisposal:true,idempotentDisposers:true,realReactUi:false};
    });
    await test('S19-slotcore-explicit-unsubscribe-stops-observation',async()=>{
      const core=new SlotCore(),Component=()=>null;let observed=0;
      const off=core.subscribeDeclaration('p0.x',()=>{observed++;});
      const first=core.register({name:'root',children:{'p0.x':{kind:'list',scope:'root'}}},Component);
      assert.equal(observed,1);off();first();assert.equal(observed,1);
      const second=core.register({name:'root',children:{'p0.x':{kind:'list',scope:'root'}}},Component);
      assert.equal(observed,1);second();await Promise.resolve();
      return {explicitSubscriptionRemoved:true,realClientHmr:false};
    });
  }finally{
    globalThis.fetch=originalFetch;
    for(const ctx of [...contexts].reverse())await close(ctx);
  }
  return {mode:'REAL_BUNDLED_SERVICES_ISOLATED_CORDIS_MOCK_HTTP',timestamp:new Date().toISOString(),
    runtime:{node:process.versions.node,electron:process.versions.electron,platform:process.platform,arch:process.arch},
    moduleRoot,syntheticDirectory:directory.substring(resolve(pluginRoot).length+1),
    userCredentialReads:0,userCredentialWrites:0,realNetworkRequests:0,
    syntheticDiskWrites:true,actualServices:true,loaderComposition:false,crossProcess:false,
    realDshRestart:false,realBrowserUi:false,realOAuthAuthorization:false,
    contextCountAfterCleanup:contexts.size,fetchRestored:globalThis.fetch===originalFetch,
    tests,passed:tests.filter(t=>t.status==='PASS').length,failed:tests.filter(t=>t.status==='FAIL').length};
}
