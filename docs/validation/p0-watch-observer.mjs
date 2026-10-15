/** P0-10 watch-mode observer: emits model counts on change until disposed. Read-only. */
import z from '@deepseek-ai/schemastery';
export const name='p0-hmr-watch-observer';
export const inject=['llm'];
export const Config=z.object({sampleMs:z.number().min(100).required()});
function emit(v){process.stdout.write('P0_WATCH '+JSON.stringify(v)+'\n');}
let stopping=false;
export function apply(ctx,config){
  const ready=ctx.get('appReady');
  if(!ready)return;
  ctx.effect(function(){return function(){stopping=true;};});
  ctx.effect(function(){return ready.onReady(function(){void loop(ctx,config.sampleMs);});});
}
async function loop(ctx,sampleMs){
  let last='';
  let seq=0;
  while(!stopping){
    const providers=ctx.llm.listProviders().map(function(p){return p.id;}).sort();
    const counts={};
    for(const p of providers){
      try{counts[p]=(await ctx.llm.listModels(p)).length;}catch(e){counts[p]='err';}
    }
    const sig=JSON.stringify({providers:providers,counts:counts});
    if(sig!==last){
      seq+=1;
      emit({seq:seq,at:new Date().toISOString(),providers:providers,counts:counts});
      last=sig;
    }
    await new Promise(function(r){setTimeout(r,sampleMs);});
  }
  emit({seq:seq,stopped:true});
}
