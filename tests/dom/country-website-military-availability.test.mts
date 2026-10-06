import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { AppContext } from '@/app/app-context';
const rpc = vi.hoisted(() => ({flight:vi.fn(),usni:vi.fn(),persistent:new Map()}));
vi.mock('@/services/generated-rpc-clients',async(importOriginal)=>({...await importOriginal<typeof import('@/services/generated-rpc-clients')>(),MilitaryServiceClient:class {listMilitaryFlights(req:unknown){return rpc.flight(req);}getUSNIFleetReport(){return rpc.usni();}}}));
vi.mock('@/services/persistent-cache',()=>({getPersistentCache:async(key:string)=>rpc.persistent.get(key)??null,setPersistentCache:async(key:string,data:unknown)=>{rpc.persistent.set(key,{data,updatedAt:Date.now()});},deletePersistentCache:async(key:string)=>{rpc.persistent.delete(key);},deletePersistentCacheByPrefix:async(prefix:string)=>{for(const key of rpc.persistent.keys())if(key.startsWith(prefix))rpc.persistent.delete(key);}}));
vi.mock('@/services/wingbits',()=>({checkWingbitsStatus:async()=>false,getAircraftDetailsBatch:async()=>new Map(),analyzeAircraftDetails:()=>({})}));
const snapshot = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock('@/app/lazy-services', () => ({ getSignalAggregator: async () => ({ getCountryClusters: snapshot.read }) }));
vi.mock('@/services/related-assets', () => ({ getNearbyInfrastructure: () => [], preloadInfrastructureTables: async () => {} }));
import { CountryIntelManager } from '@/app/country-intel';
import { CountryDeepDivePanel } from '@/components/CountryDeepDivePanel';
import { projectCountryMilitaryActivity } from '@/services/country-military-activity';
import * as runtimeConfig from '@/services/runtime-config';
import { initTestI18n } from './helpers/i18n.mts';
function manager(military?: unknown) { return new CountryIntelManager({ latestClusters: [], intelligenceCache: military === undefined ? {} : { military } } as unknown as AppContext); }
function summary(military?: unknown, code='CA', country='Canada') { const m=manager(military); return Reflect.get(m,'buildMilitarySummary').call(m,code,country); }
function render(value: ReturnType<typeof projectCountryMilitaryActivity>) {
 const panel=new CountryDeepDivePanel(),body=document.createElement('div');
 Reflect.set(panel,'militaryBody',body);Reflect.set(panel,'currentMilitarySummary',value);Reflect.get(panel,'renderMilitaryActivity').call(panel);
 const text=body.textContent;panel.hide();return text;
}
const live={mode:'live',timestamp:1791296400000,offline:false};
const cached={mode:'cached',timestamp:1791292800000,offline:false};
function empty(flightDataState=live,vesselDataState=live,confirmed=true) { return {flights:[],flightClusters:[],vessels:[],vesselClusters:[],flightDataState,vesselDataState,vesselNegativeEvidenceConfirmed:confirmed}; }
beforeAll(initTestI18n);
beforeEach(()=>{ snapshot.read.mockReset().mockReturnValue([]);vi.stubGlobal('fetch',vi.fn(()=>{throw Error('Offline preparation forbids fetch');})); });
it('required red: absent cache must render unavailable and unknown',()=>{
 const value=summary();
 expect(value).toMatchObject({ownFlights:null,foreignFlights:null,nearbyVessels:null,foreignPresence:null});
 expect(render(value)).toContain('Foreign PresenceUnknown');
});
it('required red: missing signal input must preserve null',async()=>{
 const value=await manager().getCountrySignals('CA','Canada');
 expect(value).toMatchObject({militaryFlights:null,militaryVessels:null});
});
it('required red: disabled flight service must return unavailable result state',async()=>{
 vi.spyOn(runtimeConfig,'isFeatureAvailable').mockReturnValue(false);
 const {fetchMilitaryFlights}=await import('@/services/military-flights');const value=await fetchMilitaryFlights();
 expect(fetch).not.toHaveBeenCalled();expect(value).toMatchObject({dataState:{mode:'unavailable'}});
});
it('required red: failed flight service fallback must return unavailable state',async()=>{
 vi.spyOn(runtimeConfig,'isFeatureAvailable').mockReturnValue(true);
 rpc.flight.mockRejectedValue(Error('Controlled transport failure'));
 const {fetchMilitaryFlights}=await import('@/services/military-flights');const value=await fetchMilitaryFlights();
 expect(fetch).not.toHaveBeenCalled();expect(value).toMatchObject({dataState:{mode:'unavailable'}});
});
it('required red: cached empty inputs cannot assert current zero or No',()=>{
 const value=summary(empty(cached,cached,false));
 expect(value).toMatchObject({ownFlights:null,foreignFlights:null,nearbyVessels:null,foreignPresence:null});
});
it('positive control: confirmed supplied empty sample remains zero and No',()=>{
 const value=summary(empty());
 expect(value).toMatchObject({ownFlights:0,foreignFlights:0,nearbyVessels:0,foreignPresence:false});
 expect(render(value)).toContain('Foreign PresenceNo');
});
it('positive control: supported foreign observations remain Detected',()=>{
 const cache={...empty(cached,cached,false),flights:[{lat:38,lon:-77,operatorCountry:'GB'}]};const value=summary(cache,'US','United States');
 expect(value.foreignFlights).toBe(1);expect(value.foreignPresence).toBe(true);expect(render(value)).toContain('Foreign PresenceDetected');
});
it('positive control: actual shared adapter and renderer already preserve explicit null',()=>{
 const value=projectCountryMilitaryActivity('CA','Canada',null,null);
 expect(render(value)).toContain('Own FlightsUnavailable');expect(render(value)).toContain('Foreign PresenceUnknown');
});

function deferred<T>() {let resolve!: (value:T)=>void,reject!: (error:Error)=>void;const promise=new Promise<T>((ok,bad)=>{resolve=ok;reject=bad;});return {promise,resolve,reject};}
const tick=async()=>{await Promise.resolve();await Promise.resolve();await new Promise(ok=>setTimeout(ok,0));};
function protoReport(title='current') {return {report:{articleUrl:'https://fixture.invalid',articleDate:'2026-10-05',articleTitle:title,vessels:[],strikeGroups:[],regions:[],parsingWarnings:[],timestamp:1791208800000}};}
function protoFlight(hexCode:string) {return {id:hexCode,callsign:hexCode,hexCode,registration:'',aircraftType:'MILITARY_AIRCRAFT_TYPE_UNKNOWN',aircraftModel:'',operator:'MILITARY_OPERATOR_OTHER',operatorCountry:'GB',location:{latitude:38,longitude:-77},altitude:20000,heading:90,speed:300,verticalRate:0,onGround:false,squawk:'',origin:'',destination:'',lastSeenAt:1791296400000,firstSeenAt:0,confidence:'MILITARY_CONFIDENCE_LOW',isInteresting:false,note:''};}
describe('actual result-local USNI and flight observation state',()=>{
 beforeEach(()=>{vi.resetModules();rpc.flight.mockReset();rpc.usni.mockReset();rpc.persistent.clear();});
 afterEach(async()=>{const flights=await import('@/services/military-flights');flights.stopFlightHistoryCleanup();});
 it('returns live roster once then cached roster with the identical report and no second read',async()=>{
  rpc.usni.mockResolvedValue(protoReport());const service=await import('@/services/usni-fleet');const first=await service.fetchUSNIFleetObservation();const second=await service.fetchUSNIFleetObservation();expect(first.dataState.mode).toBe('live');expect(second.dataState.mode).toBe('cached');expect(second.report).toBe(first.report);expect(second.dataState.timestamp).toBeNull();expect(rpc.usni).toHaveBeenCalledOnce();expect(await service.fetchUSNIFleetReport()).toBe(first.report);expect(fetch).not.toHaveBeenCalled();
 });
 it('persistent roster carries cached state and original article date without a provider read',async()=>{
  const stored={articleDate:'2026-10-05',articleTitle:'stored',vessels:[]};rpc.persistent.set('breaker:USNI Fleet Tracker',{data:stored,updatedAt:Date.now()-1000});const {fetchUSNIFleetObservation}=await import('@/services/usni-fleet');const result=await fetchUSNIFleetObservation();expect(result.report).toBe(stored);expect(result.dataState).toMatchObject({mode:'cached',timestamp:null});expect(rpc.usni).not.toHaveBeenCalled();
 });
 for(const order of ['failure-first','success-first'])it(`USNI reverse ${order} results retain per-call state`,async()=>{
  const a=deferred<any>(),b=deferred<any>();rpc.usni.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);const {fetchUSNIFleetObservation}=await import('@/services/usni-fleet');const successPromise=fetchUSNIFleetObservation();await tick();const failedPromise=fetchUSNIFleetObservation();await tick();let success:any,failed:any;
  if(order==='failure-first'){b.reject(Error('fixture failure'));failed=await failedPromise;a.resolve(protoReport('A'));success=await successPromise;}else{a.resolve(protoReport('A'));success=await successPromise;b.reject(Error('fixture failure'));failed=await failedPromise;}
  expect(success.report.articleTitle).toBe('A');expect(success.dataState.mode).toBe('live');expect(failed.report).toBeNull();expect(failed.dataState.mode).toBe('unavailable');expect(success.dataState.mode).toBe('live');expect(fetch).not.toHaveBeenCalled();
 });
 it('null and thrown roster results are unavailable',async()=>{
  rpc.usni.mockResolvedValueOnce({}).mockRejectedValueOnce(Error('fixture failure'));const {fetchUSNIFleetObservation}=await import('@/services/usni-fleet');for(let i=0;i<2;i++){const r=await fetchUSNIFleetObservation();expect(r.report).toBeNull();expect(r.dataState.mode).toBe('unavailable');}
 });
 it('cached roster in desktop offline mode keeps cached/offline metadata',async()=>{
  const stored={articleDate:'2026-10-05',vessels:[]};rpc.persistent.set('breaker:USNI Fleet Tracker',{data:stored,updatedAt:Date.now()-1000});vi.stubGlobal('window',Object.assign(window,{__TAURI__:{}}));vi.spyOn(navigator,'onLine','get').mockReturnValue(false);try{const {fetchUSNIFleetObservation}=await import('@/services/usni-fleet');expect((await fetchUSNIFleetObservation()).dataState).toMatchObject({mode:'cached',offline:true});}finally{Reflect.deleteProperty(window,'__TAURI__');}
 });
 for(const order of ['failure-first','success-first'])it(`flights reverse ${order} keeps unavailable and live results associated`,async()=>{
  vi.spyOn(runtimeConfig,'isFeatureAvailable').mockReturnValue(true);const a=deferred<any>(),b=deferred<any>();rpc.flight.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);const {fetchMilitaryFlights}=await import('@/services/military-flights');const good=fetchMilitaryFlights();await tick();const bad=fetchMilitaryFlights();await tick();let success:any,failed:any;
  if(order==='failure-first'){b.reject(Error('fixture failure'));failed=await bad;a.resolve({flights:[protoFlight('A1')],pagination:{nextCursor:'',totalCount:1}});success=await good;}else{a.resolve({flights:[protoFlight('A1')],pagination:{nextCursor:'',totalCount:1}});success=await good;b.reject(Error('fixture failure'));failed=await bad;}
  expect(success.flights[0].hexCode).toBe('A1');expect(success.dataState.mode).toBe('live');expect(failed.flights).toEqual([]);expect(failed.dataState.mode).toBe('unavailable');expect(fetch).not.toHaveBeenCalled();
 });

 it('inner flight cache stays cached even during a successful outer breaker call',async()=>{
  const utils=await import('@/utils');const real=utils.createCircuitBreaker;let breaker:import('@/utils/circuit-breaker').CircuitBreaker<any>|undefined;
  vi.spyOn(utils,'createCircuitBreaker').mockImplementation((options:any)=>{const instance=real(options);if(options.name==='Military Flight Tracking')breaker=instance;return instance;});
  const runtime=await import('@/services/runtime-config');vi.spyOn(runtime,'isFeatureAvailable').mockReturnValue(true);rpc.flight.mockResolvedValue({flights:[protoFlight('A1')],pagination:{nextCursor:'',totalCount:1}});
  const {fetchMilitaryFlights}=await import('@/services/military-flights');const first=await fetchMilitaryFlights();expect(breaker).toBeDefined();breaker!.clearCache();await tick();rpc.persistent.clear();const second=await fetchMilitaryFlights();expect(rpc.flight).toHaveBeenCalledOnce();expect(second.dataState.mode).toBe('cached');expect(second.dataState.timestamp).toBe(first.dataState.timestamp);expect(second.flights).toBe(first.flights);expect(breaker!.getDataState().mode).toBe('live');
 });
 it('two flight successes completed in reverse keep separate arrays and local clocks',async()=>{
  const runtime=await import('@/services/runtime-config');vi.spyOn(runtime,'isFeatureAvailable').mockReturnValue(true);let now=1791296400000;vi.spyOn(Date,'now').mockImplementation(()=>now);const a=deferred<any>(),b=deferred<any>();rpc.flight.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);const {fetchMilitaryFlights}=await import('@/services/military-flights');const older=fetchMilitaryFlights();await tick();const newer=fetchMilitaryFlights();await tick();b.resolve({flights:[protoFlight('B2')],pagination:{nextCursor:'',totalCount:1}});const newResult=await newer;now+=1000;a.resolve({flights:[protoFlight('A1')],pagination:{nextCursor:'',totalCount:1}});const oldResult=await older;expect(newResult.flights[0].hexCode).toBe('B2');expect(oldResult.flights[0].hexCode).toBe('A1');expect(newResult.flights).not.toBe(oldResult.flights);expect(newResult.dataState.timestamp).toBe(1791296400000);expect(oldResult.dataState.timestamp).toBe(1791296401000);expect(newResult.dataState.mode).toBe('live');
 });
 it('two roster successes completed in reverse retain their own report and clock',async()=>{
  let now=1791296400000;vi.spyOn(Date,'now').mockImplementation(()=>now);const a=deferred<any>(),b=deferred<any>();rpc.usni.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);const {fetchUSNIFleetObservation}=await import('@/services/usni-fleet');const older=fetchUSNIFleetObservation();await tick();const newer=fetchUSNIFleetObservation();await tick();b.resolve(protoReport('B'));const newResult=await newer;now+=1000;a.resolve(protoReport('A'));const oldResult=await older;expect(newResult.report?.articleTitle).toBe('B');expect(oldResult.report?.articleTitle).toBe('A');expect(newResult.dataState.timestamp).toBe(1791296400000);expect(oldResult.dataState.timestamp).toBe(1791296401000);expect(newResult.dataState.mode).toBe('live');
 });
 it('a previous flight sample returned from the breaker is cached without a borrowed global clock',async()=>{
  vi.spyOn(runtimeConfig,'isFeatureAvailable').mockReturnValue(true);rpc.flight.mockResolvedValue({flights:[protoFlight('A1')],pagination:{nextCursor:'',totalCount:1}});const {fetchMilitaryFlights}=await import('@/services/military-flights');const first=await fetchMilitaryFlights();const second=await fetchMilitaryFlights();expect(first.dataState.mode).toBe('live');expect(second.dataState).toMatchObject({mode:'cached',timestamp:null});expect(second.flights).toBe(first.flights);expect(rpc.flight).toHaveBeenCalledOnce();
 });
});
it('both manager projections preserve confirmed empty, unknown cached negatives and supported partial positives',async()=>{
 const ctx={latestClusters:[],intelligenceCache:{military:empty()}} as unknown as AppContext;const m=new CountryIntelManager(ctx);
 let signals=await m.getCountrySignals('US','United States');expect(signals.militaryFlights).toBe(0);expect(signals.militaryVessels).toBe(0);expect(Reflect.get(m,'buildMilitarySummary').call(m,'US','United States').foreignPresence).toBe(false);
 ctx.intelligenceCache.military=empty(cached,cached,false) as never;signals=await m.getCountrySignals('US','United States');expect(signals.militaryFlights).toBeNull();expect(signals.militaryVessels).toBeNull();expect(Reflect.get(m,'buildMilitarySummary').call(m,'US','United States').foreignPresence).toBeNull();
 ctx.intelligenceCache.military={...empty(cached,cached,false),flights:[{lat:38,lon:-77,operatorCountry:'GB'}]} as never;signals=await m.getCountrySignals('US','United States');expect(signals.militaryFlights).toBe(1);const summary=Reflect.get(m,'buildMilitarySummary').call(m,'US','United States');expect(summary.foreignPresence).toBe(true);expect(summary.coverageNotes.join(' ')).toMatch(/previous cached/);
 ctx.intelligenceCache.military={...empty(cached,cached,false),vessels:[{lat:38,lon:-77,operatorCountry:'GB'}],vesselCoverageNotes:['Partial fixture vessel coverage']} as never;signals=await m.getCountrySignals('US','United States');expect(signals.militaryVessels).toBe(1);const vesselSummary=Reflect.get(m,'buildMilitarySummary').call(m,'US','United States');expect(vesselSummary.nearbyVessels).toBe(1);expect(vesselSummary.foreignPresence).toBe(true);expect(vesselSummary.coverageNotes).toContain('Partial fixture vessel coverage');
 ctx.intelligenceCache.military=undefined;expect((await m.getCountrySignals('US','United States')).militaryFlights).toBeNull();expect(Reflect.get(m,'buildMilitarySummary').call(m,'US','United States').foreignPresence).toBeNull();
});


describe('current Military story callers preserve unavailable observations', () => {
  it('absent story input retains null military counts', async () => {
    const { collectStoryData } = await import('@/services/story-data');
    const data = collectStoryData('CA', 'Canada', [], [], []);
    expect(data.signals.militaryFlights).toBeNull();
    expect(data.signals.militaryVessels).toBeNull();
    expect(data.signals.protests).toBe(0);
  });

  it('story collection preserves supplied unknown, confirmed zero and positive counts', async () => {
    const { collectStoryData } = await import('@/services/story-data');
    for (const [flights, vessels] of [[null, null], [0, 0], [3, 3], [null, 3], [3, null], [0, 3], [3, 0]] as const) {
      const signals = { protests: 0, militaryFlights: flights, militaryVessels: vessels, outages: 0, gpsJammingHexes: 0 };
      const data = collectStoryData('CA', 'Canada', [], [], [], signals);
      expect(data.signals.militaryFlights).toBe(flights);
      expect(data.signals.militaryVessels).toBe(vessels);
    }
  });

  it('actual story canvas draws only supplied positive signals and never null or NaN', async () => {
    const { collectStoryData } = await import('@/services/story-data');
    const { renderStoryToCanvas } = await import('@/services/story-renderer');
    const labels: string[] = [];
    const context = new Proxy({}, {
      get: (_target, key) => key === 'fillText' ? (value: string) => labels.push(value)
        : key === 'measureText' ? (value: string) => ({ width: value.length * 8 })
          : key === 'createLinearGradient' ? () => ({ addColorStop: () => {} })
            : () => {},
      set: () => true,
    });
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as CanvasRenderingContext2D);
    vi.stubGlobal('Image', class {
      onerror?: () => void;
      set src(_value: string) { queueMicrotask(() => this.onerror?.()); }
    });
    for (const [flights, vessels] of [[null, null], [0, 0], [3, 3], [null, 3], [3, null], [0, 3], [3, 0]] as const) {
      labels.length = 0;
      const signals = { protests: 2, militaryFlights: flights, militaryVessels: vessels, outages: 1, gpsJammingHexes: 0 };
      await renderStoryToCanvas(collectStoryData('CA', 'Canada', [], [], [], signals));
      expect(labels).toContain('📢 Protests');
      expect(labels).toContain('🌐 Internet Outages');
      expect(labels.includes('✈ Military Aircraft')).toBe(flights === 3);
      expect(labels.includes('⚓ Military Vessels')).toBe(vessels === 3);
      expect(labels.some(value => /null|NaN/.test(value))).toBe(false);
    }
    expect(fetch).not.toHaveBeenCalled();
  });
});


it('actual panel nullable contract preserves unknown counts and coverage through score and signal updates', async () => {
  const counts = await manager().getCountrySignals('CA', 'Canada');
  const panel: import('@/components/CountryBriefPanel').CountryBriefPanel = new CountryDeepDivePanel();
  const body = document.createElement('div');
  Reflect.set(panel, 'signalsBody', body);
  Reflect.set(panel, 'renderSkeleton', () => {});
  Reflect.set(panel, 'open', () => {});
  panel.show('Canada', 'CA', null, counts);
  panel.updateScore?.(null, counts);
  panel.updateSignals?.(counts, ['Military observations unavailable in fixture']);
  expect(Reflect.get(panel, 'currentSignals').militaryFlights).toBeNull();
  expect(Reflect.get(panel, 'currentSignals').militaryVessels).toBeNull();
  expect(body.textContent).toContain('Unavailable');
  expect(body.textContent).toContain('Military observations unavailable in fixture');
  panel.hide();
  expect(fetch).not.toHaveBeenCalled();
});
