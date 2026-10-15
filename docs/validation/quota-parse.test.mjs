/** P0-Q quota parsing regression: pure functions over fixtures; no network, no credentials, no DSH. Run: node docs/validation/quota-parse.test.mjs */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const FIX=join(dirname(fileURLToPath(import.meta.url)),'fixtures');
const fixture=n=>JSON.parse(readFileSync(join(FIX,n),'utf8'));
let failed=0;
const ok=(name,cond)=>{if(!cond){failed++;console.error('FAIL '+name);}else console.log('PASS '+name);};
function accountKeyOf(id){ // 规则：非空且去空白后的账号标识才能成为账号键；否则 identity-unverified
  if(typeof id!=='string'||id.trim()==='')return {identity:'identity-unverified',accountKey:undefined};
  return {identity:'verified',accountKey:'acct_'+createHash('sha256').update(id).digest('hex').slice(0,10)};
}
function normalizeCodex(payload,{httpStatus}={}){
  const rl=payload?.rate_limit??{};
  const windowOf=w=>w&&typeof w.used_percent==='number'
    ?{usedPercent:w.used_percent,remainingPercent:100-w.used_percent,...(typeof w.limit_window_seconds==='number'?{windowMinutes:Math.ceil(w.limit_window_seconds/60)}:{}),...(typeof w.reset_at==='number'?{resetsAt:w.reset_at}:{})}:undefined;
  const windows=[windowOf(rl.primary_window)&&{id:'primary',...windowOf(rl.primary_window)},windowOf(rl.secondary_window)&&{id:'secondary',...windowOf(rl.secondary_window)}].filter(Boolean);
  const usageAllowed=typeof rl.allowed==='boolean'?rl.allowed:undefined;
  const limitReached=rl.limit_reached===true;
  const exhausted=usageAllowed===false||limitReached===true||rl.primary_window?.used_percent===100;
  const status=httpStatus===401?'auth-required':httpStatus===429?'exhausted':windows.length===0?'unknown':exhausted?'exhausted':'ready';
  const ident=accountKeyOf(payload?.account_id);
  return {plan:payload?.plan_type,usageAllowed,limitReached,status,windows,
    modelUsage:Object.entries(payload?.model_usage??{}).map(([modelId,v])=>({modelId,available:v?.available===true,creditsWouldEnable:v?.credits_would_enable===true})),
    resetCredits:payload?.rate_limit_reset_credits?.available_count,
    ...ident};
}
function normalizeOpenCodeGo(payload){
  const WINDOWS=[['rolling',300],['weekly',10080],['monthly',43200]];
  const windows=WINDOWS.flatMap(([id,windowMinutes])=>{const w=payload?.usage?.[id];if(!w)return[];
    if(w.status!=='ok'&&w.status!=='rate-limited')return[{id,windowMinutes,status:'window-unavailable'}];
    return typeof w.percent==='number'?[{id,windowMinutes,usedPercent:w.percent,remainingPercent:100-w.percent,...(w.resetsAt?{resetsAt:w.resetsAt}:{})}]:[];});
  return {status:windows.some(w=>w.usedPercent!==undefined)?'ready':'unknown',windows};
}
// T1: exhausted fixture — allowed=false 与 100% 主窗口必须保留
const ex=normalizeCodex(fixture('codex-usage-exhausted.json'),{httpStatus:200});
ok('T1 allowed=false preserved',ex.usageAllowed===false);
ok('T2 primary 100% => exhausted',ex.status==='exhausted'&&ex.windows.find(w=>w.id==='primary')?.usedPercent===100);
ok('T3 secondary 16% not misread as total exhaustion',ex.windows.find(w=>w.id==='secondary')?.remainingPercent===84);
ok('T4 empty account_id => identity-unverified, no empty-hash key',ex.identity==='identity-unverified'&&ex.accountKey===undefined);
ok('T5 credits separate from windows',ex.resetCredits===1&&!ex.windows.some(w=>w.id.includes('credit')));
// T6: available fixture
const av=normalizeCodex(fixture('codex-usage-available.json'),{httpStatus:200});
ok('T6 allowed=true + <100% => ready',av.status==='ready'&&av.usageAllowed===true);
ok('T7 verified account id yields stable key',av.identity==='verified'&&av.accountKey===accountKeyOf('fixture-account-2').accountKey);
// T8: missing windows
const nw=normalizeCodex(fixture('codex-usage-no-windows.json'),{httpStatus:200});
ok('T8 missing windows => unknown, never 0%/full',nw.status==='unknown'&&nw.windows.length===0);
// T9: 429 never yields percentages
const r429=normalizeCodex({},{httpStatus:429});
ok('T9 bare 429 => exhausted signal with no percent claim',r429.status==='exhausted'&&r429.windows.length===0);
// T10: Go usage
const go=normalizeOpenCodeGo(fixture('opencode-go-usage.json'));
ok('T10 Go rolling/weekly/monthly normalized',JSON.stringify(go.windows.map(w=>[w.id,w.usedPercent]))===JSON.stringify([['rolling',1],['weekly',29],['monthly',37]]));
ok('T11 Go windowMinutes pinned',go.windows.map(w=>w.windowMinutes).join()==='300,10080,43200');
// T12: Go rate-limited window preserved as status
const go2=normalizeOpenCodeGo({usage:{rolling:{percent:100,status:'rate-limited',resetsAt:'2026-10-15T12:00:00.000Z'}}});
ok('T12 Go rate-limited window keeps percent and ready-by-data',go2.windows[0].usedPercent===100&&go2.status==='ready');
console.log(failed===0?'ALL_PASS':'FAILED '+failed);
if(failed>0)process.exit(1);
