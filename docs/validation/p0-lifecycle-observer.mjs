/** P0-10 read-only lifecycle observer: records provider/model counts after mount, then exits. Changes nothing. */
import z from '@deepseek-ai/schemastery';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
export const name='p0-lifecycle-observer';
export const inject=['llm'];
export const Config=z.object({runDir:z.string().required(),label:z.string().required()});
function emit(value){process.stdout.write('P0_LIFECYCLE '+JSON.stringify(value)+'\n');}
export function apply(ctx,config){
  const ready=ctx.get('appReady');
  const exit=ctx.get('appExit');
  if(!ready||!exit)return;
  ctx.effect(function(){return ready.onReady(function(){void run(ctx,config,exit);});});
}
async function run(ctx,config,exit){
  const started=Date.now();
  const samples=[];
  let last='';
  let stableSince=null;
  while(Date.now()-started<30000){
    const providers=ctx.llm.listProviders().map(function(p){return p.id;}).sort();
    const counts={};
    for(const p of providers){
      try{counts[p]=(await ctx.llm.listModels(p)).length;}catch(e){counts[p]='err';}
    }
    const sig=JSON.stringify({providers:providers,counts:counts});
    if(sig!==last){samples.push({at:Date.now()-started,providers:providers,counts:counts});last=sig;stableSince=Date.now();}

    if(stableSince!==null&&Date.now()-started>12000&&Date.now()-stableSince>1500)break;
    await new Promise(function(r){setTimeout(r,500);});
  }
  const dir=join(resolve(config.runDir),'evidence');
  await mkdir(dir,{recursive:true,mode:0o700});
  const file=join(dir,config.label+'-'+Date.now()+'-'+randomUUID()+'.json');
  const lastSample=samples.length>0?samples[samples.length-1]:{};
  const result={stage:'P0-10',label:config.label,endedAt:new Date().toISOString(),
    providers:lastSample.providers||[],counts:lastSample.counts||{},
    settledAfterMs:lastSample.at===undefined?null:lastSample.at,samplesTaken:samples.length,
    note:'read-only observer; real Loader composition; no model requests sent'};
  await writeFile(file,JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});
  emit({event:'lifecycle-observed',evidenceFile:file,result:result});
  exit(0);
}
