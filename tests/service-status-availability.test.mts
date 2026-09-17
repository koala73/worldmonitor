import assert from 'node:assert/strict';
import {test} from 'node:test';
import {build} from 'esbuild';
test('service-status cold empty is unavailable and can recover',async(t)=>{
 const b=await build({entryPoints:['src/services/infrastructure/index.ts'],bundle:true,write:false,platform:'node',format:'esm',define:{'import.meta.env':'{"DEV":false}'},logLevel:'silent'});
 const s=await import(`data:text/javascript;base64,${Buffer.from(b.outputFiles[0]!.text).toString('base64')}`);
 let statuses:unknown[]=[];t.mock.method(globalThis,'fetch',async()=>Response.json({statuses}));
 assert.equal((await s.fetchServiceStatuses()).success,false);
 statuses=[{id:'aws',name:'AWS',status:'SERVICE_OPERATIONAL_STATUS_OPERATIONAL',description:''}];
 const result=await s.fetchServiceStatuses();assert.equal(result.success,true);assert.equal(result.summary.operational,1);
});
