import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { AppContext } from '@/app/app-context';
const rpc = vi.hoisted(() => ({flight:vi.fn(),usni:vi.fn(),persistent:new Map()}));
vi.mock('@/services/generated-rpc-clients',async(importOriginal)=>({...await importOriginal<typeof import('@/services/generated-rpc-clients')>(),MilitaryServiceClient:class {listMilitaryFlights(req:unknown){return rpc.flight(req);}getUSNIFleetReport(){return rpc.usni();}}}));
vi.mock('@/services/persistent-cache',()=>({getPersistentCache:async(key:string)=>rpc.persistent.get(key)??null,setPersistentCache:async(key:string,data:unknown)=>{rpc.persistent.set(key,{data,updatedAt:Date.now()});},deletePersistentCache:async(key:string)=>{rpc.persistent.delete(key);},deletePersistentCacheByPrefix:async(prefix:string)=>{for(const key of rpc.persistent.keys())if(key.startsWith(prefix))rpc.persistent.delete(key);}}));
vi.mock('@/services/wingbits',()=>({checkWingbitsStatus:async()=>false,getAircraftDetailsBatch:async()=>new Map(),analyzeAircraftDetails:()=>({})}));
const snapshot = vi.hoisted(() => ({ read: vi.fn(), nearby: vi.fn(), story: vi.fn() }));
vi.mock('@/app/lazy-services', () => ({ getSignalAggregator: async () => ({ getCountryClusters: snapshot.read, getRegionalConvergence: () => [] }) }));
vi.mock('@/services/related-assets', () => ({ getNearbyInfrastructure: (...args: unknown[]) => snapshot.nearby(...args), preloadInfrastructureTables: async () => {} }));
vi.mock('@/components/StoryModal', () => ({ openStoryModal: snapshot.story }));
import { CountryIntelManager } from '@/app/country-intel';
import { CountryDeepDivePanel } from '@/components/CountryDeepDivePanel';
import { projectCountryMilitaryActivity, projectCountryMilitarySignalCounts } from '@/services/country-military-activity';
import * as runtimeConfig from '@/services/runtime-config';
import { dataFreshness } from '@/services/data-freshness';
import { initTestI18n } from './helpers/i18n.mts';
function manager(military?: unknown) { return new CountryIntelManager({ latestClusters: [], intelligenceCache: military === undefined ? {} : { military } } as unknown as AppContext); }
function summary(military?: unknown, code='CA', country='Canada') { const m=manager(military); return Reflect.get(m,'selectCountryMilitary').call(m,code,country).summary; }
function render(value: ReturnType<typeof projectCountryMilitaryActivity>) {
 const panel=new CountryDeepDivePanel(),body=document.createElement('div');
 Reflect.set(panel,'militaryBody',body);Reflect.set(panel,'currentMilitarySummary',value);Reflect.get(panel,'renderMilitaryActivity').call(panel);
 const text=body.textContent;panel.hide();return text;
}
const live={mode:'live',timestamp:1791296400000,offline:false};
const cached={mode:'cached',timestamp:1791292800000,offline:false};
function empty(flightDataState=live,vesselDataState=live,confirmed=true) { return {flights:[],flightClusters:[],vessels:[],vesselClusters:[],flightDataState,vesselDataState,vesselNegativeEvidenceConfirmed:confirmed}; }
beforeAll(initTestI18n);
beforeEach(()=>{ snapshot.read.mockReset().mockReturnValue([]);snapshot.nearby.mockReset().mockReturnValue([]);snapshot.story.mockReset();vi.stubGlobal('fetch',vi.fn(()=>{throw Error('Offline preparation forbids fetch');})); });
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
  const runtime=await import('@/services/runtime-config');vi.spyOn(runtime,'isFeatureAvailable').mockReturnValue(true);let now=1791296400000;vi.spyOn(Date,'now').mockImplementation(()=>now);const a=deferred<any>(),b=deferred<any>();rpc.flight.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);const {fetchMilitaryFlights}=await import('@/services/military-flights');const older=fetchMilitaryFlights();await tick();const newer=fetchMilitaryFlights();await tick();b.resolve({flights:[protoFlight('B2')],pagination:{nextCursor:'',totalCount:1}});const newResult=await newer;now+=1000;a.resolve({flights:[protoFlight('A1')],pagination:{nextCursor:'',totalCount:1}});const oldResult=await older;expect(newResult.flights[0]!.hexCode).toBe('B2');expect(oldResult.flights[0]!.hexCode).toBe('A1');expect(newResult.flights).not.toBe(oldResult.flights);expect(newResult.dataState.timestamp).toBe(1791296400000);expect(oldResult.dataState.timestamp).toBe(1791296401000);expect(newResult.dataState.mode).toBe('live');
 });
 it('two roster successes completed in reverse retain their own report and clock',async()=>{
  let now=1791296400000;vi.spyOn(Date,'now').mockImplementation(()=>now);const a=deferred<any>(),b=deferred<any>();rpc.usni.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);const {fetchUSNIFleetObservation}=await import('@/services/usni-fleet');const older=fetchUSNIFleetObservation();await tick();const newer=fetchUSNIFleetObservation();await tick();b.resolve(protoReport('B'));const newResult=await newer;now+=1000;a.resolve(protoReport('A'));const oldResult=await older;expect(newResult.report?.articleTitle).toBe('B');expect(oldResult.report?.articleTitle).toBe('A');expect(newResult.dataState.timestamp).toBe(1791296400000);expect(oldResult.dataState.timestamp).toBe(1791296401000);expect(newResult.dataState.mode).toBe('live');
 });
 it('a previous flight sample returned from the breaker is cached without a borrowed global clock',async()=>{
  vi.spyOn(runtimeConfig,'isFeatureAvailable').mockReturnValue(true);rpc.flight.mockResolvedValue({flights:[protoFlight('A1')],pagination:{nextCursor:'',totalCount:1}});const {fetchMilitaryFlights}=await import('@/services/military-flights');const first=await fetchMilitaryFlights();const second=await fetchMilitaryFlights();expect(first.dataState.mode).toBe('live');expect(second.dataState).toMatchObject({mode:'cached',timestamp:null});expect(second.flights).toBe(first.flights);expect(rpc.flight).toHaveBeenCalledOnce();
 });
});
it('keeps legacy cache projection semantics while website counts require a qualified owner',async()=>{
 const ctx={latestClusters:[],intelligenceCache:{military:empty()}} as unknown as AppContext;const m=new CountryIntelManager(ctx);
 const legacy=()=>m.selectCountryMilitary('US','United States');
 expect(legacy().signalCounts).toMatchObject({militaryFlights:0,militaryVessels:0});expect(legacy().summary.foreignPresence).toBe(false);
 ctx.intelligenceCache.military=empty(cached,cached,false) as never;
 expect(legacy().signalCounts).toMatchObject({militaryFlights:null,militaryVessels:null});expect(legacy().summary.foreignPresence).toBeNull();
 ctx.intelligenceCache.military={...empty(cached,cached,false),flights:[{lat:38,lon:-77,operatorCountry:'GB'}]} as never;
 expect(legacy().signalCounts.militaryFlights).toBe(1);expect(legacy().summary.foreignPresence).toBe(true);expect(legacy().summary.coverageNotes.join(' ')).toMatch(/previous cached/);
 expect((await m.getCountrySignals('US','United States')).militaryFlights).toBeNull();
 ctx.intelligenceCache.military={...empty(cached,cached,false),vessels:[{lat:38,lon:-77,operatorCountry:'GB'}],vesselCoverageNotes:['Partial fixture vessel coverage']} as never;
 expect(legacy().signalCounts.militaryVessels).toBe(1);expect(legacy().summary.nearbyVessels).toBe(1);expect(legacy().summary.foreignPresence).toBe(true);expect(legacy().summary.coverageNotes).toContain('Partial fixture vessel coverage');
 expect((await m.getCountrySignals('US','United States')).militaryVessels).toBeNull();
 ctx.intelligenceCache.military=undefined;expect((await m.getCountrySignals('US','United States')).militaryFlights).toBeNull();expect(legacy().summary.foreignPresence).toBeNull();
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
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(((contextId: string) => contextId === '2d' ? context : null) as HTMLCanvasElement['getContext']);
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

it('keeps the qualified military card independent of the legacy global cache', () => {
 const m=manager(empty());
 const read=()=>Reflect.get(m,'buildMilitarySummary').call(m,'US','United States');
 expect(read()).toMatchObject({ownFlights:null,foreignFlights:null,nearbyVessels:null,foreignPresence:null});
 const qualified={ownFlights:2,foreignFlights:1,nearbyVessels:null,foreignPresence:true,nearestBases:[],coverage:'partial',coverageNotes:['Controlled qualified source']};
 Reflect.set(m,'qualifiedMilitarySummary',{code:'US',value:qualified});
 expect(read()).toBe(qualified);
 expect(Reflect.get(m,'buildMilitarySummary').call(m,'FR','France').foreignPresence).toBeNull();
});

import * as qualifiedMilitaryLoader from '@/services/country-military-activity';
import { countrySignalsFromMilitary } from '@/services/country-signals';
import { unavailableCountrySignal } from '../../shared/country-signal-observations';
import { CountrySectionError } from '@/services/country-brief-error';
type QualifiedMilitaryResult = Awaited<ReturnType<typeof qualifiedMilitaryLoader.loadHostCountryMilitaryActivity>>;
const qualifiedCounts = { militaryFlights: 0, militaryFlightsInCountry: 0, militaryVessels: 93, militaryVesselsInCountry: 1 };
function qualifiedResult(patch: Partial<QualifiedMilitaryResult> = {}): QualifiedMilitaryResult {
 return { ownFlights: 0, foreignFlights: 0, nearbyVessels: 1, foreignPresence: false, nearestBases: [], coverage: 'complete',
  coverageNotes: ['Controlled AIS snapshot 2026-10-19T01:53:39.344Z'], signalCounts: { ...qualifiedCounts }, deniedSignalFields: [],
  qualified: { ...unavailableCountrySignal('CN','military','Controlled'), state: 'observed', partial: false, reason: null }, ...patch };
}
function ownerFixture() {
 const panel = new CountryDeepDivePanel();
 Reflect.set(panel,'currentCode','CN');
 const body=document.createElement('div');Reflect.set(panel,'signalsBody',body);
 panel.updateSignals({...countrySignalsFromMilitary('CN'), earthquakes:7});
 let visible=true,code='CN'; const abort=new AbortController();
 const page={signal:abort.signal,isVisible:()=>visible,getCode:()=>code,getName:()=>code==='CN'?'China':'France',
  getSignalCounts:panel.getSignalCounts.bind(panel),updateSignals:vi.fn(panel.updateSignals.bind(panel)),
  updateMilitaryActivity:vi.fn(),updateScore:vi.fn(),clearQualifiedCountrySignals:vi.fn(),syncCountryPremiumSectionsAccess:vi.fn()};
 const ctx={countryBriefPage:page,latestClusters:[],intelligenceCache:{},isDestroyed:false};
 const intel=new CountryIntelManager(ctx as unknown as AppContext);
 const presentation={page,code:'CN',refreshGeneration:1,signalDetailsPending:false};
 Reflect.set(intel,'currentCountryPresentation',presentation);
 Reflect.set(intel,'qualifiedSource',{clearLoadedData:vi.fn(),settleMandatoryReads:async()=>{},countrySignals:async(_code:string,family:Parameters<typeof unavailableCountrySignal>[1])=>unavailableCountrySignal(_code,family,'Controlled')});
 vi.spyOn(intel as any,'renderCountryEconomics').mockImplementation(()=>{});
 const load=()=>Reflect.get(intel,'loadQualifiedCountrySignals').call(intel,code);
 const refresh=async()=>{intel.refreshOpenBrief();await tick();};
 const base=(earthquakes=7): Awaited<ReturnType<CountryIntelManager['getCountrySignals']>> =>({...countrySignalsFromMilitary(code,{militaryFlights:999,militaryFlightsInCountry:998,militaryVessels:997,militaryVesselsInCountry:996}),earthquakes} as Awaited<ReturnType<CountryIntelManager['getCountrySignals']>>);
 return {intel,panel,body,page,ctx,presentation,abort,load,refresh,base,setHidden:()=>{visible=false;},setCountry:()=>{code='FR';},cleanup:()=>panel.hide()};
}
describe('website qualified military presentation owner',()=>{
 it('keeps story military figures independent of an unopened or different qualified brief',async()=>{
  vi.spyOn(dataFreshness,'hasSufficientData').mockReturnValue(true);
  const military={...empty(),flights:[{lat:35,lon:110,operatorCountry:'CN'}],vessels:[{lat:35,lon:110,operatorCountry:'US'}]};
  const ctx={latestClusters:[{primaryTitle:'China fixture',allItems:[],sourceCount:1}],latestPredictions:[],intelligenceCache:{military},panels:{}};
  const intel=new CountryIntelManager(ctx as unknown as AppContext);
  for(const code of [null,'CN','FR']) {
   Reflect.set(intel,'qualifiedMilitarySummary',code?{code,page:undefined,value:{},signalCounts:{militaryFlights:99,militaryFlightsInCountry:99,militaryVessels:98,militaryVesselsInCountry:98}}:null);
   await intel.openCountryStory('CN','China');
   expect(snapshot.story).toHaveBeenLastCalledWith(expect.objectContaining({signals:expect.objectContaining({militaryFlights:1,militaryVessels:1})}));
  }
  expect(fetch).not.toHaveBeenCalled();
 });
 it.each(['unavailable','locked'] as const)('preserves static nearest bases when a qualified read is %s',async state=>{
  const h=ownerFixture();
  snapshot.nearby.mockReturnValue([{id:'fixture-base',name:'Controlled base',distanceKm:12}]);
  const bases=projectCountryMilitaryActivity('CN','China',null,null).nearestBases;
  const read=vi.spyOn(qualifiedMilitaryLoader,'loadHostCountryMilitaryActivity').mockResolvedValueOnce(qualifiedResult({nearestBases:bases})).mockRejectedValueOnce(new CountrySectionError(state,'Controlled failure'));
  await h.load();
  vi.spyOn(h.intel,'getCountrySignals').mockResolvedValue(h.base());await h.refresh();
  expect(h.page.updateMilitaryActivity.mock.lastCall![0].nearestBases).toEqual(bases);
  if(state==='locked')expect(h.panel.getSignalCounts()).toMatchObject({militaryFlights:null,militaryVessels:null});
  expect(read).toHaveBeenCalledTimes(2);expect(fetch).not.toHaveBeenCalled();h.cleanup();
 });
 it('publishes exact qualified near/contained counts, card and clocks without changing other chips',async()=>{
  const h=ownerFixture(),value=qualifiedResult();vi.spyOn(qualifiedMilitaryLoader,'loadHostCountryMilitaryActivity').mockResolvedValue(value);
  await h.load();
  expect(h.page.updateMilitaryActivity).toHaveBeenLastCalledWith(expect.objectContaining({ownFlights:0,foreignFlights:0,nearbyVessels:1}));
  expect(h.panel.getSignalCounts()).toMatchObject({...qualifiedCounts,earthquakes:7});
  expect(h.body.textContent).toContain('Controlled AIS snapshot 2026-10-19T01:53:39.344Z');
  expect(fetch).not.toHaveBeenCalled();h.cleanup();
 });
 it.each(['flights','vessels'] as const)('does not reuse a prior foreign %s positive after that family is confirmed empty',async family=>{
  const h=ownerFixture();
  const foreign=[{lat:35,lon:110,operatorCountry:'US'}];
  const firstFlights=family==='flights'?foreign:[];
  const firstVessels=family==='vessels'?foreign:[];
  const first=qualifiedResult({...projectCountryMilitaryActivity('CN','China',firstFlights,firstVessels),signalCounts:projectCountryMilitarySignalCounts('CN',firstFlights,firstVessels)});
  const flights=family==='flights'?[]:null;
  const vessels=family==='vessels'?[]:null;
  const next=qualifiedResult({...projectCountryMilitaryActivity('CN','China',flights,vessels),signalCounts:projectCountryMilitarySignalCounts('CN',flights,vessels),coverage:'partial',coverageNotes:['Current cleared-family snapshot; other family unavailable']});
  const read=vi.spyOn(qualifiedMilitaryLoader,'loadHostCountryMilitaryActivity').mockResolvedValueOnce(first).mockResolvedValueOnce(next);
  await h.load();expect(h.page.updateMilitaryActivity).toHaveBeenLastCalledWith(expect.objectContaining({foreignPresence:true}));
  vi.spyOn(h.intel,'getCountrySignals').mockResolvedValue(h.base());await h.refresh();
  expect(h.panel.getSignalCounts()).toMatchObject({militaryFlights:0,militaryFlightsInCountry:0,militaryVessels:0,militaryVesselsInCountry:0,earthquakes:7});
  const card=h.page.updateMilitaryActivity.mock.lastCall![0];
  expect(card).toMatchObject({ownFlights:0,foreignFlights:0,nearbyVessels:0});
  expect(card.coverageNotes.join(' ')).toContain('not fresh');expect(card.coverageNotes.join(' ')).toContain('2026-10-19T01:53:39.344Z');
  expect(card.foreignPresence).not.toBe(true);expect(render(card)).not.toContain('Foreign PresenceDetected');
  expect(read).toHaveBeenCalledTimes(2);expect(fetch).not.toHaveBeenCalled();h.cleanup();
 });
 it.each(['flights','vessels'] as const)('preserves fresh permitted foreign presence when %s are denied',async deniedFamily=>{
  const h=ownerFixture(),foreign=[{lat:35,lon:110,operatorCountry:'US'}];
  const flights=deniedFamily==='flights'?null:foreign;
  const vessels=deniedFamily==='vessels'?null:foreign;
  const value=qualifiedResult({...projectCountryMilitaryActivity('CN','China',flights,vessels),signalCounts:projectCountryMilitarySignalCounts('CN',flights,vessels),deniedSignalFields:deniedFamily==='flights'?['militaryFlights','militaryFlightsInCountry']:['militaryVessels','militaryVesselsInCountry'],coverage:'partial'});
  expect(value.foreignPresence).toBe(true);
  vi.spyOn(qualifiedMilitaryLoader,'loadHostCountryMilitaryActivity').mockResolvedValue(value);await h.load();
  expect(h.panel.getSignalCounts()).toMatchObject({...value.signalCounts,earthquakes:7});
  const card=h.page.updateMilitaryActivity.mock.lastCall![0];
  expect(card.foreignPresence).toBe(true);expect(render(card)).toContain('Foreign PresenceDetected');
  expect(fetch).not.toHaveBeenCalled();h.cleanup();
 });
 it.each(['flights','vessels'] as const)('keeps qualified foreign %s presence and original clocks on full ordinary failure',async family=>{
  const h=ownerFixture(),foreign=[{lat:35,lon:110,operatorCountry:'US'}];
  const flights=family==='flights'?foreign:[],vessels=family==='vessels'?foreign:[];
  const first=qualifiedResult({...projectCountryMilitaryActivity('CN','China',flights,vessels),signalCounts:projectCountryMilitarySignalCounts('CN',flights,vessels)});
  const read=vi.spyOn(qualifiedMilitaryLoader,'loadHostCountryMilitaryActivity').mockResolvedValue(first);
  await h.load();vi.spyOn(h.intel,'getCountrySignals').mockResolvedValue(h.base());
  read.mockRejectedValue(new CountrySectionError('unavailable','Controlled full outage'));await h.refresh();
  const card=h.page.updateMilitaryActivity.mock.lastCall![0];
  expect(card.foreignPresence).toBe(true);expect(render(card)).toContain('Foreign PresenceDetected');
  expect(h.panel.getSignalCounts()).toMatchObject({...first.signalCounts,earthquakes:7});
  expect(card.coverageNotes.join(' ')).toContain('not fresh');expect(card.coverageNotes.join(' ')).toContain('2026-10-19T01:53:39.344Z');
  expect(fetch).not.toHaveBeenCalled();h.cleanup();
 });
 it('preserves attributed retained foreign flights when vessels refresh empty',async()=>{
  const h=ownerFixture(),foreign=[{lat:35,lon:110,operatorCountry:'US'}];
  const first=qualifiedResult({...projectCountryMilitaryActivity('CN','China',foreign,[]),signalCounts:projectCountryMilitarySignalCounts('CN',foreign,[])});
  const next=qualifiedResult({...projectCountryMilitaryActivity('CN','China',null,[]),signalCounts:projectCountryMilitarySignalCounts('CN',null,[]),coverage:'partial'});
  vi.spyOn(qualifiedMilitaryLoader,'loadHostCountryMilitaryActivity').mockResolvedValueOnce(first).mockResolvedValueOnce(next);
  await h.load();vi.spyOn(h.intel,'getCountrySignals').mockResolvedValue(h.base());await h.refresh();
  const card=h.page.updateMilitaryActivity.mock.lastCall![0];expect(card).toMatchObject({foreignFlights:1,foreignPresence:true,nearbyVessels:0});
  expect(render(card)).toContain('Foreign PresenceDetected');expect(card.coverageNotes.join(' ')).toContain('not fresh');
  expect(fetch).not.toHaveBeenCalled();h.cleanup();
 });
 it('keeps legacy map positives out before qualified data and preserves qualified zero and licensed null',async()=>{
  const h=ownerFixture();Reflect.set(h.intel,'selectCountryMilitary',()=>({signalCounts:{militaryFlights:999,militaryFlightsInCountry:998,militaryVessels:997,militaryVesselsInCountry:996}}));
  expect(await h.intel.getCountrySignals('CN','China')).toMatchObject({militaryFlights:null,militaryVessels:null});
  vi.spyOn(qualifiedMilitaryLoader,'loadHostCountryMilitaryActivity').mockResolvedValue(qualifiedResult({signalCounts:{militaryFlights:null,militaryFlightsInCountry:null,militaryVessels:0,militaryVesselsInCountry:0},ownFlights:null,foreignFlights:null,nearbyVessels:0,foreignPresence:null}));
  await h.load();expect(h.panel.getSignalCounts()).toMatchObject({militaryFlights:null,militaryFlightsInCountry:null,militaryVessels:0,militaryVesselsInCountry:0});
  expect(await h.intel.getCountrySignals('CN','China')).toMatchObject({militaryFlights:null,militaryVessels:0});h.cleanup();
 });
 it('keeps the qualified owner through base/score refresh, ordinary failure and subsequent recovery',async()=>{
  const h=ownerFixture();const read=vi.spyOn(qualifiedMilitaryLoader,'loadHostCountryMilitaryActivity').mockResolvedValue(qualifiedResult());
  await h.load();vi.spyOn(h.intel,'getCountrySignals').mockResolvedValue(h.base(12));
  read.mockRejectedValue(new CountrySectionError('unavailable','Controlled outage'));await h.refresh();
  expect(h.panel.getSignalCounts()).toMatchObject({...qualifiedCounts,earthquakes:12});
  expect(h.page.updateMilitaryActivity).toHaveBeenLastCalledWith(expect.objectContaining({nearbyVessels:1}));
  expect(h.body.textContent).toContain('not fresh');expect(h.body.textContent).toContain('2026-10-19T01:53:39.344Z');
  read.mockResolvedValue(qualifiedResult({signalCounts:{...qualifiedCounts,militaryVessels:0,militaryVesselsInCountry:0},nearbyVessels:0}));await h.refresh();
  expect(h.panel.getSignalCounts()).toMatchObject({militaryVessels:0,militaryVesselsInCountry:0,earthquakes:12});h.cleanup();
 });
 it.each(['locked','partial-flights','partial-vessels'] as const)('clears %s denied fields and never resurrects them on an ordinary failure',async mode=>{
  const h=ownerFixture();const read=vi.spyOn(qualifiedMilitaryLoader,'loadHostCountryMilitaryActivity').mockResolvedValue(qualifiedResult());await h.load();
  vi.spyOn(h.intel,'getCountrySignals').mockResolvedValue(h.base());
  if(mode==='locked')read.mockRejectedValue(new CountrySectionError('locked','Controlled denied'));
  else if(mode==='partial-flights')read.mockResolvedValue(qualifiedResult({signalCounts:{...qualifiedCounts,militaryFlights:null,militaryFlightsInCountry:null},ownFlights:null,foreignFlights:null,deniedSignalFields:['militaryFlights','militaryFlightsInCountry']}));
  else read.mockResolvedValue(qualifiedResult({signalCounts:{...qualifiedCounts,militaryVessels:null,militaryVesselsInCountry:null},nearbyVessels:null,deniedSignalFields:['militaryVessels','militaryVesselsInCountry']}));
  const expected={militaryFlights:mode==='partial-vessels'?0:null,militaryFlightsInCountry:mode==='partial-vessels'?0:null,militaryVessels:mode==='partial-flights'?93:null,militaryVesselsInCountry:mode==='partial-flights'?1:null,earthquakes:7};
  await h.refresh();expect(h.panel.getSignalCounts()).toMatchObject(expected);
  read.mockRejectedValue(new CountrySectionError('unavailable','Later outage'));await h.refresh();
  expect(h.panel.getSignalCounts()).toMatchObject(expected);
  expect(h.page.updateMilitaryActivity).toHaveBeenLastCalledWith(expect.objectContaining({ownFlights:mode==='partial-vessels'?0:null,foreignFlights:mode==='partial-vessels'?0:null,nearbyVessels:mode==='partial-flights'?1:null}));h.cleanup();
 });
 it.each((['abort','hide','country','page-new-signal','page-same-signal','signal-replaced','generation','destroy'] as const).flatMap(kind=>(['success','failure'] as const).map(outcome=>({kind,outcome}))))('suppresses stale counts/card/notes after $kind $outcome',async ({kind,outcome})=>{
  const h=ownerFixture(),pending=deferred<QualifiedMilitaryResult>();vi.spyOn(qualifiedMilitaryLoader,'loadHostCountryMilitaryActivity').mockReturnValue(pending.promise);
  const work=h.load().catch(()=>{});
  if(kind==='abort')h.abort.abort();if(kind==='hide')h.setHidden();if(kind==='country')h.setCountry();
  if(kind==='page-new-signal')h.ctx.countryBriefPage={...h.page,signal:new AbortController().signal};
  if(kind==='page-same-signal')h.ctx.countryBriefPage={...h.page};
  if(kind==='signal-replaced')h.page.signal=new AbortController().signal;
  if(kind==='generation')h.presentation.refreshGeneration++;if(kind==='destroy')h.intel.destroy();
  if(outcome==='success')pending.resolve(qualifiedResult());else pending.reject(new CountrySectionError('unavailable','Late failure'));await work;
  expect(h.page.updateSignals).not.toHaveBeenCalled();expect(h.page.updateMilitaryActivity).not.toHaveBeenCalled();expect(fetch).not.toHaveBeenCalled();h.cleanup();
 });
 it.each(['success','failure'] as const)('leaves the newer same-country refresh visible after older %s',async outcome=>{
  const h=ownerFixture(),old=deferred<QualifiedMilitaryResult>(),next=deferred<QualifiedMilitaryResult>();
  const read=vi.spyOn(qualifiedMilitaryLoader,'loadHostCountryMilitaryActivity').mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
  const first=h.load();vi.spyOn(h.intel,'getCountrySignals').mockResolvedValue(h.base());await h.refresh();
  next.resolve(qualifiedResult({signalCounts:{...qualifiedCounts,militaryVessels:2,militaryVesselsInCountry:0},nearbyVessels:0}));await tick();
  if(outcome==='success')old.resolve(qualifiedResult());else old.reject(new CountrySectionError('unavailable','Older failure'));await first;expect(read).toHaveBeenCalledTimes(2);
  expect(h.panel.getSignalCounts()).toMatchObject({militaryVessels:2,militaryVesselsInCountry:0});expect(h.page.updateMilitaryActivity).toHaveBeenLastCalledWith(expect.objectContaining({nearbyVessels:0}));h.cleanup();
 });
 it('clears the owner on access loss, suppresses pending pre-loss data, and recovers on access return',async()=>{
  const h=ownerFixture(),pending=deferred<QualifiedMilitaryResult>();const read=vi.spyOn(qualifiedMilitaryLoader,'loadHostCountryMilitaryActivity').mockResolvedValueOnce(qualifiedResult()).mockReturnValueOnce(pending.promise);
  await h.load();vi.spyOn(h.intel,'getCountrySignals').mockResolvedValue(h.base());await h.refresh();
  Reflect.set(h.intel,'lastHadPremium',true);Reflect.set(h.intel,'getCountryController',()=>({refreshPremium(){}}));
  read.mockRejectedValue(new CountrySectionError('locked','Access lost'));
  Reflect.get(h.intel,'handlePremiumAccessTransition').call(h.intel,false);expect(h.panel.getSignalCounts()).toMatchObject({militaryFlights:null,militaryVessels:null});await tick();
  pending.resolve(qualifiedResult());await tick();expect(h.panel.getSignalCounts()).toMatchObject({militaryFlights:null,militaryVessels:null});
  read.mockResolvedValue(qualifiedResult());Reflect.get(h.intel,'handlePremiumAccessTransition').call(h.intel,true);await tick();
  expect(h.panel.getSignalCounts()).toMatchObject(qualifiedCounts);h.cleanup();
 });
});
