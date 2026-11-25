import assert from 'node:assert/strict';
import {test} from 'node:test';
import {build} from 'esbuild';
test('service-status healthy empty remains successful and can recover',async(t)=>{
 const b=await build({entryPoints:['src/services/infrastructure/index.ts'],bundle:true,write:false,platform:'node',format:'esm',define:{'import.meta.env':'{"DEV":false}'},logLevel:'silent'});
 const s=await import(`data:text/javascript;base64,${Buffer.from(b.outputFiles[0]!.text).toString('base64')}`);
 let statuses:unknown[]=[];t.mock.method(globalThis,'fetch',async()=>Response.json({statuses}));
 const empty=await s.fetchServiceStatuses();assert.equal(empty.success,true);assert.deepEqual(empty.services,[]);
 statuses=[{id:'aws',name:'AWS',status:'SERVICE_OPERATIONAL_STATUS_OPERATIONAL',description:''}];
 const result=await s.fetchServiceStatuses();assert.equal(result.success,true);assert.equal(result.summary.operational,1);
});

test('service-status caller abort cancels fetch without tripping circuit breaker',async(t)=>{
 const b=await build({entryPoints:['src/services/infrastructure/index.ts'],bundle:true,write:false,platform:'node',format:'esm',define:{'import.meta.env':'{"DEV":false}'},logLevel:'silent'});
 const s=await import(`data:text/javascript;base64,${Buffer.from(`${b.outputFiles[0]!.text}\n// abort-test`).toString('base64')}`);
 let calls=0;
 let onFetchEntered:(()=>void)|null=null;
 t.mock.method(globalThis,'fetch',async(_input:unknown,init?:RequestInit)=>{
  calls+=1;
  onFetchEntered?.();
  if(calls<=3){
   if(init?.signal?.aborted) throw init.signal.reason??new DOMException('Aborted','AbortError');
   return await new Promise<Response>((_resolve,reject)=>{
    init?.signal?.addEventListener('abort',()=>reject(init.signal?.reason??new DOMException('Aborted','AbortError')),{once:true});
   });
  }
  return Response.json({statuses:[{id:'aws',name:'AWS',status:'SERVICE_OPERATIONAL_STATUS_OPERATIONAL',description:''}]});
 });
 // Three consecutive caller aborts exceed DEFAULT_MAX_FAILURES (2) if counted as failures.
 for(let i=0;i<3;i++){
  const ac=new AbortController();
  const entered=new Promise<void>((resolve)=>{onFetchEntered=resolve;});
  const pending=s.fetchServiceStatuses(ac.signal);
  await entered;
  ac.abort(new DOMException('Refresh lane lease expired','AbortError'));
  await assert.rejects(pending,{name:'AbortError'});
 }
 // Breaker must NOT be on cooldown; next healthy call succeeds immediately.
 const recovered=await s.fetchServiceStatuses();
 assert.equal(calls,4);
 assert.equal(recovered.success,true);
 assert.equal(recovered.summary.operational,1);
});
