import assert from 'node:assert/strict';
import {test} from 'node:test';
import {build} from 'esbuild';

test('cyber client retains last-good on unavailable seed and accepts confirmed empty recovery',async(t)=>{
  const built=await build({stdin:{contents:`
    export {fetchCyberThreats} from './src/services/cyber/index.ts';
    import {createCyberServiceRoutes} from './src/generated/server/worldmonitor/cyber/v1/service_server.ts';
    import {listCyberThreats} from './server/worldmonitor/cyber/v1/list-cyber-threats.ts';
    import {mapErrorToResponse} from './server/error-mapper.ts';
    export const routes=createCyberServiceRoutes({listCyberThreats},{onError:mapErrorToResponse});
  `,resolveDir:process.cwd(),loader:'ts'},bundle:true,write:false,format:'esm',platform:'node',define:{'import.meta.env':'{"DEV":false}'},logLevel:'silent',plugins:[{name:'bootstrap-fixture',setup(b){b.onLoad({filter:/src\/services\/bootstrap\.ts$/},()=>({contents:'export async function ensureHydrated(){return undefined}',loader:'ts'}));}}]});
  const harness=await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0]!.text).toString('base64')}`);
  const env={...process.env};t.after(()=>{process.env=env});
  process.env.UPSTASH_REDIS_REST_URL='https://redis.fixture';process.env.UPSTASH_REDIS_REST_TOKEN='fixture';delete process.env.LOCAL_API_MODE;
  let now=Date.now();t.mock.method(Date,'now',()=>now);t.mock.method(console,'warn',()=>{});t.mock.method(console,'error',()=>{});
  const good={threats:[{id:'fixture',type:'CYBER_THREAT_TYPE_C2_SERVER',source:'CYBER_THREAT_SOURCE_FEODO',indicator:'192.0.2.1',indicatorType:'CYBER_THREAT_INDICATOR_TYPE_IP',location:{latitude:1,longitude:2},country:'XX',severity:'CRITICALITY_LEVEL_HIGH',tags:[],firstSeenAt:0,lastSeenAt:0}]};
  let payload:unknown=good;let failure=false;const statuses:number[]=[];
  t.mock.method(globalThis,'fetch',async(input:RequestInfo|URL)=>{
    const url=new URL(input instanceof Request?input.url:String(input),'https://app.fixture');
    if(url.origin==='https://redis.fixture'){if(failure)throw new TypeError('offline');return Response.json({result:payload===null?null:JSON.stringify(payload)});}
    const route=harness.routes.find((r:{path:string})=>r.path===url.pathname);assert.ok(route);const response=await route.handler(new Request(url));statuses.push(response.status);return response;
  });
  const initial=await harness.fetchCyberThreats();assert.equal(initial.length,1);
  async function refresh(expected:unknown,status:number){now+=10*60*1000+1;await harness.fetchCyberThreats();await new Promise(r=>setImmediate(r));assert.equal(statuses.at(-1),status);assert.deepEqual(await harness.fetchCyberThreats(),expected);await new Promise(r=>setImmediate(r));}
  for(const bad of [null,{}, {threats:null}]){payload=bad;await refresh(initial,503);payload=good;await refresh(initial,200);}
  failure=true;await refresh(initial,503);failure=false;payload={threats:[]};await refresh([],200);
  failure=true;await refresh([],503);failure=false;payload=good;await refresh(initial,200);
});
