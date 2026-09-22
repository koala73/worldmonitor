import assert from 'node:assert/strict';
import {test} from 'node:test';
import {build} from 'esbuild';

test('unrest client retains last-good on unavailable seed and accepts confirmed empty recovery',async(t)=>{
  const built=await build({stdin:{contents:`
    export {fetchProtestEvents} from './src/services/unrest/index.ts';
    import {createUnrestServiceRoutes} from './src/generated/server/worldmonitor/unrest/v1/service_server.ts';
    import {listUnrestEvents} from './server/worldmonitor/unrest/v1/list-unrest-events.ts';
    import {mapErrorToResponse} from './server/error-mapper.ts';
    export const routes=createUnrestServiceRoutes({listUnrestEvents},{onError:mapErrorToResponse});
  `,resolveDir:process.cwd(),loader:'ts'},bundle:true,write:false,format:'esm',platform:'node',define:{'import.meta.env':'{"DEV":false}'},logLevel:'silent',plugins:[{name:'bootstrap-fixture',setup(b){b.onLoad({filter:/src\/services\/bootstrap\.ts$/},()=>({contents:'export function getHydratedData(){return undefined}',loader:'ts'}));}}]});
  const harness=await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0]!.text).toString('base64')}`);
  const env={...process.env};t.after(()=>{process.env=env});
  process.env.UPSTASH_REDIS_REST_URL='https://redis.fixture';process.env.UPSTASH_REDIS_REST_TOKEN='fixture';delete process.env.LOCAL_API_MODE;
  let now=Date.now();t.mock.method(Date,'now',()=>now);t.mock.method(console,'warn',()=>{});t.mock.method(console,'error',()=>{});
  const good={events:[{id:'fixture',title:'Test protest',summary:'',city:'',country:'US',region:'',eventType:'UNREST_EVENT_TYPE_PROTEST',sourceType:'UNREST_SOURCE_TYPE_ACLED',severity:'SEVERITY_LEVEL_LOW',occurredAt:1,location:{latitude:1,longitude:2},fatalities:0,sources:[],sourceUrls:[],tags:[],actors:[],confidence:'CONFIDENCE_LEVEL_HIGH'}]};
  let payload:unknown=good;let failure=false;const statuses:number[]=[];
  t.mock.method(globalThis,'fetch',async(input:RequestInfo|URL)=>{
    const url=new URL(input instanceof Request?input.url:String(input),'https://app.fixture');
    if(url.origin==='https://redis.fixture'){if(failure)throw new TypeError('offline');return Response.json({result:payload===null?null:JSON.stringify(payload)});}
    const route=harness.routes.find((r:{path:string})=>r.path===url.pathname);assert.ok(route);const response=await route.handler(new Request(url));statuses.push(response.status);return response;
  });
  payload=null;await assert.rejects(harness.fetchProtestEvents(),/Unrest events unavailable/);payload=good;
  const initial=await harness.fetchProtestEvents();assert.equal(initial.events.length,1);
  async function refresh(expected:unknown,status:number){now+=10*60*1000+1;await harness.fetchProtestEvents();await new Promise(r=>setImmediate(r));assert.equal(statuses.at(-1),status);assert.deepEqual(await harness.fetchProtestEvents(),expected);await new Promise(r=>setImmediate(r));}
  for(const bad of [null,{}, {events:null}, {events:[{}]}]){payload=bad;await refresh(initial,503);payload=good;await refresh(initial,200);}
  failure=true;await refresh(initial,503);failure=false;payload={events:[]};await refresh({...initial,events:[],byCountry:new Map(),sources:{acled:0,gdelt:0}},200);
  failure=true;await refresh({...initial,events:[],byCountry:new Map(),sources:{acled:0,gdelt:0}},503);failure=false;payload=good;await refresh(initial,200);
});
