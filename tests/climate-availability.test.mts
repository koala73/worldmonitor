import assert from 'node:assert/strict';
import {test} from 'node:test';
import {build} from 'esbuild';

test('climate client retains last-good on unavailable seed and accepts confirmed empty recovery',async(t)=>{
  const built=await build({stdin:{contents:`
    export {fetchClimateAnomalies} from './src/services/climate/index.ts';
    import {createClimateServiceRoutes} from './src/generated/server/worldmonitor/climate/v1/service_server.ts';
    import {listClimateAnomalies} from './server/worldmonitor/climate/v1/list-climate-anomalies.ts';
    import {mapErrorToResponse} from './server/error-mapper.ts';
    export const routes=createClimateServiceRoutes({listClimateAnomalies},{onError:mapErrorToResponse});
  `,resolveDir:process.cwd(),loader:'ts'},bundle:true,write:false,format:'esm',platform:'node',define:{'import.meta.env':'{"DEV":false}'},logLevel:'silent',plugins:[{name:'bootstrap-fixture',setup(b){b.onLoad({filter:/src\/services\/bootstrap\.ts$/},()=>({contents:'export function getHydratedData(){return undefined}',loader:'ts'}));}}]});
  const harness=await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0]!.text).toString('base64')}`);
  const env={...process.env};t.after(()=>{process.env=env});
  process.env.UPSTASH_REDIS_REST_URL='https://redis.fixture';process.env.UPSTASH_REDIS_REST_TOKEN='fixture';delete process.env.LOCAL_API_MODE;
  let now=Date.now();t.mock.method(Date,'now',()=>now);t.mock.method(console,'warn',()=>{});t.mock.method(console,'error',()=>{});
  const good={anomalies:[{zone:'Test',location:{latitude:1,longitude:2},tempDelta:3,precipDelta:0,severity:'ANOMALY_SEVERITY_EXTREME',type:'ANOMALY_TYPE_WARM',period:'2026-09'}]};
  let payload:unknown=good;let failure=false;const statuses:number[]=[];
  t.mock.method(globalThis,'fetch',async(input:RequestInfo|URL)=>{
    const url=new URL(input instanceof Request?input.url:String(input),'https://app.fixture');
    if(url.origin==='https://redis.fixture'){if(failure)throw new TypeError('offline');return Response.json({result:payload===null?null:JSON.stringify(payload)});}
    const route=harness.routes.find((r:{path:string})=>r.path===url.pathname);assert.ok(route);const response=await route.handler(new Request(url));statuses.push(response.status);return response;
  });
  payload=null;assert.deepEqual(await harness.fetchClimateAnomalies(),{ok:false,anomalies:[]});payload=good;
  const initial=await harness.fetchClimateAnomalies();assert.equal(initial.anomalies.length,1);
  async function refresh(expected:unknown,status:number){now+=20*60*1000+1;await harness.fetchClimateAnomalies();await new Promise(r=>setImmediate(r));assert.equal(statuses.at(-1),status);assert.deepEqual(await harness.fetchClimateAnomalies(),expected);await new Promise(r=>setImmediate(r));}
  for(const bad of [null,{}, {anomalies:null}]){payload=bad;await refresh(initial,503);payload=good;await refresh(initial,200);}
  failure=true;await refresh(initial,503);failure=false;payload={anomalies:[]};await refresh({ok:true,anomalies:[]},200);
  failure=true;await refresh({ok:true,anomalies:[]},503);failure=false;payload=good;await refresh(initial,200);
});
