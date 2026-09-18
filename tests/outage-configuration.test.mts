import assert from 'node:assert/strict';
import {test} from 'node:test';
import {build} from 'esbuild';
test('empty outage observations never imply missing configuration',async(t)=>{
 const b=await build({stdin:{contents:`export {fetchInternetOutages,isOutagesConfigured} from './src/services/infrastructure/index.ts';export {setAvailable} from './src/services/runtime-config.ts';`,resolveDir:process.cwd(),loader:'ts'},bundle:true,write:false,format:'esm',platform:'node',define:{'import.meta.env':'{"DEV":false}'},logLevel:'silent',plugins:[{name:'feature-fixture',setup(b){b.onLoad({filter:/src\/services\/runtime-config\.ts$/},()=>({contents:'let enabled=true;export function isFeatureAvailable(){return enabled};export function setAvailable(value){enabled=value}',loader:'ts'}));}}]});
 const service=await import(`data:text/javascript;base64,${Buffer.from(b.outputFiles[0]!.text).toString('base64')}`);
 let outages:unknown[]=[];t.mock.method(globalThis,'fetch',async()=>Response.json({outages}));
 assert.deepEqual(await service.fetchInternetOutages(),[]);assert.equal(service.isOutagesConfigured(),null);
 service.setAvailable(false);await service.fetchInternetOutages();assert.equal(service.isOutagesConfigured(),false);
 service.setAvailable(true);await service.fetchInternetOutages();assert.equal(service.isOutagesConfigured(),null);
 outages=[{id:'fixture',title:'Outage',country:'XX',categories:[]}];await service.fetchInternetOutages();assert.equal(service.isOutagesConfigured(),true);
 outages=[];await service.fetchInternetOutages();assert.equal(service.isOutagesConfigured(),true);
});
