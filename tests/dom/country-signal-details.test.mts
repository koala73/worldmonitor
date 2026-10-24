import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppContext } from '@/app/app-context';
import type { CountrySignalCluster, GeoSignal } from '@/services/signal-aggregator';
import { projectCountrySignalDetails } from '../../shared/country-signal-details';
import { projectQualifiedCountrySignals, unavailableCountrySignal } from '../../shared/country-signal-observations';
import { qualifiedFixtureOutcomes } from '../../src/e2e/fixtures/qualified-country-signals';
import * as militaryActivity from '@/services/country-military-activity';

const snapshot = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock('@/app/lazy-services', () => ({ getSignalAggregator: async () => ({ getCountryClusters: snapshot.read, getRegionalConvergence: () => [] }) }));
import { CountryIntelManager } from '@/app/country-intel';
import { CountryDeepDivePanel } from '@/components/CountryDeepDivePanel';
import { countrySignalsFromMilitary } from '@/services/country-signals';
import { initTestI18n } from './helpers/i18n.mts';

const paint = vi.hoisted(() => ({ yield: vi.fn(async () => {}) }));
vi.mock('@/utils/after-paint', () => ({ yieldToMain: () => paint.yield() }));
vi.mock('@/services/country-coverage', () => ({ fetchCountryCoverage: async () => ({ headlines: [], timelineEvents: [] }) }));
vi.mock('@/services/country-geometry', async original => ({ ...await original<typeof import('@/services/country-geometry')>(), preloadCountryGeometry: async () => {}, getCountryCentroid: () => null }));
vi.mock('@/services/related-assets', async original => ({ ...await original<typeof import('@/services/related-assets')>(), preloadInfrastructureTables: async () => {} }));
vi.mock('@/services/military-base-config', async original => ({ ...await original<typeof import('@/services/military-base-config')>(), preloadMilitaryBases: async () => [] }));

beforeAll(async () => { await initTestI18n(); });


function observation(type: GeoSignal['type'], severity: GeoSignal['severity'], minute: number): GeoSignal {
  return { type, severity, country: 'FR', countryName: 'France', lat: 48.85, lon: 2.35, title: `${type} ${minute}`, timestamp: new Date(Date.UTC(2026, 9, 3, 12, minute)) };
}

function cluster(country: string, signals: GeoSignal[]): CountrySignalCluster {
  return { country, countryName: country, signals, signalTypes: new Set(signals.map(signal => signal.type)), totalCount: signals.length, highSeverityCount: 0, convergenceScore: 0 };
}

describe('shared country signal details', () => {
  beforeEach(() => { snapshot.read.mockReset(); });

  it('counts observed empty clusters as zero', () => {
    expect(projectCountrySignalDetails([])).toEqual({ critical: 0, high: 0, medium: 0, low: 0, recentHigh: [] });
  });

  it.each(['active_strike', 'radiation_anomaly'] as const)('promotes high %s to critical without promoting other severities', type => {
    const result = projectCountrySignalDetails([observation(type, 'high', 3), observation(type, 'medium', 2), observation(type, 'low', 1)]);
    expect(result).toMatchObject({ critical: 1, high: 0, medium: 1, low: 1 });
    expect(result.recentHigh).toHaveLength(1);
    expect(result.recentHigh[0]?.severity).toBe('critical');
  });

  it.each([
    ['military_flight', 'MILITARY'], ['military_vessel', 'MILITARY'], ['active_strike', 'MILITARY'],
    ['protest', 'PROTEST'], ['internet_outage', 'OUTAGE'], ['ais_disruption', 'OUTAGE'],
    ['satellite_fire', 'DISASTER'], ['radiation_anomaly', 'DISASTER'], ['temporal_anomaly', 'CYBER'], ['sanctions_pressure', 'OTHER'],
  ] as const)('maps %s to the website display type %s', (type, display) => {
    expect(projectCountrySignalDetails([observation(type, 'high', 1)]).recentHigh[0]?.type).toBe(display);
  });

  it('returns three newest high or critical items while retaining all severity counts and original timestamps', () => {
    const events = [observation('protest', 'high', 1), observation('radiation_anomaly', 'high', 3), observation('internet_outage', 'medium', 5), observation('temporal_anomaly', 'high', 4), observation('military_flight', 'high', 2), observation('protest', 'low', 6)];
    const original = [...events];
    const result = projectCountrySignalDetails(events);
    expect(result).toMatchObject({ critical: 1, high: 3, medium: 1, low: 1 });
    expect(result.recentHigh.map(signal => signal.description)).toEqual(['temporal_anomaly 4', 'radiation_anomaly 3', 'military_flight 2']);
    expect(result.recentHigh[0]?.timestamp).toBe(events[3]?.timestamp);
    expect(events).toEqual(original);
  });

  it('keeps observation order for equal timestamps', () => {
    const first = observation('protest', 'high', 1);
    const second = observation('military_flight', 'high', 1);
    expect(projectCountrySignalDetails([first, second]).recentHigh.map(signal => signal.description)).toEqual([first.title, second.title]);
  });

  it.each(['future_type', 'toString', 'constructor', '__proto__'])('keeps unknown type %s as OTHER', type => {
    expect(projectCountrySignalDetails([{ ...observation('protest', 'high', 1), type }]).recentHigh[0]?.type).toBe('OTHER');
  });

  it('uses the qualified country loader without reading the global aggregator', async () => {
    const signals = [observation('temporal_anomaly', 'high', 2), observation('active_strike', 'high', 1)];
    snapshot.read.mockReturnValue([cluster('XX', [observation('protest', 'high', 6)]), cluster('US', [observation('protest', 'high', 5)]), cluster('FR', signals)]);
    const manager = new CountryIntelManager({ latestClusters: [], intelligenceCache: {} } as unknown as AppContext);
    const qualified = vi.fn(async (code: string) => ({ details: projectCountrySignalDetails(code === 'FR' ? signals : []) }));
    Reflect.set(manager, 'loadQualifiedCountrySignals', qualified);
    const project = Reflect.get(manager, 'buildSignalDetails').bind(manager);
    expect(await project('FR')).toEqual(projectCountrySignalDetails(signals));
    expect(await project('DE')).toEqual(projectCountrySignalDetails([]));
    expect(qualified).toHaveBeenCalledTimes(2);
    expect(snapshot.read).not.toHaveBeenCalled();
  });

  it('does not turn a failed website cluster read into observed empty coverage', async () => {
    snapshot.read.mockImplementation(() => { throw new Error('Controlled cluster outage'); });
    const manager = new CountryIntelManager({ latestClusters: [], intelligenceCache: {} } as unknown as AppContext);
    Reflect.set(manager, 'loadQualifiedCountrySignals', async () => { throw new Error('Controlled cluster outage'); });
    await expect(Reflect.get(manager, 'buildSignalDetails').call(manager, 'FR')).rejects.toThrow('Controlled cluster outage');
  });
});

it('retains same-country qualified observations after the website refresh resets military work', async () => {
  const previous = projectQualifiedCountrySignals('IR', qualifiedFixtureOutcomes());
  const page = { signal: new AbortController().signal, getCode: () => 'IR', getName: () => 'Iran', isVisible: () => true, updateMilitaryActivity: vi.fn() };
  const manager = new CountryIntelManager({ countryBriefPage: page, latestClusters: [], intelligenceCache: {} } as unknown as AppContext);
  const qualified = qualifiedFixtureOutcomes().find(row => row.family === 'military')!;
  const loader = vi.spyOn(militaryActivity, 'loadHostCountryMilitaryActivity').mockResolvedValue({ qualified, ownFlights:null, foreignFlights:null, nearbyVessels:null, nearestBases:[], foreignPresence:null, coverage:'partial', signalCounts: {militaryFlights:null,militaryFlightsInCountry:null,militaryVessels:null,militaryVesselsInCountry:null}, deniedSignalFields:[], coverageNotes:[] } as Awaited<ReturnType<typeof militaryActivity.loadHostCountryMilitaryActivity>>);
  Reflect.set(manager, 'qualifiedSignals', previous);
  Reflect.set(manager, 'qualifiedMilitary', null);
  Reflect.set(manager, 'qualifiedSource', {
    settleMandatoryReads: async () => {},
    countrySignals: async (_code: string, family: Parameters<typeof unavailableCountrySignal>[1]) => unavailableCountrySignal('IR', family, 'Controlled refresh failure'),
  });
  try {
    const value = await Reflect.get(manager, 'loadQualifiedCountrySignals').call(manager, 'IR');
    expect(value.families.find((row: { family: string }) => row.family === 'radiation')).toMatchObject({
      state: 'observed', partial: true, snapshotAt: previous.families.find(row => row.family === 'radiation')!.snapshotAt,
    });
    expect(value.details).toEqual(previous.details);
  } finally { loader.mockRestore(); }
});

it('replaces website military loading with unavailable when the qualified military load rejects', async () => {
  const page = { signal: new AbortController().signal, getCode: () => 'IR', getName: () => 'Iran', isVisible: () => true, updateMilitaryActivity: vi.fn() };
  const manager = new CountryIntelManager({ countryBriefPage: page, latestClusters: [], intelligenceCache: {} } as unknown as AppContext);
  const loader = vi.spyOn(militaryActivity, 'loadHostCountryMilitaryActivity').mockRejectedValue(new Error('Controlled infrastructure failure'));
  Reflect.set(manager, 'qualifiedSource', {
    settleMandatoryReads: async () => {},
    countrySignals: async (_code: string, family: Parameters<typeof unavailableCountrySignal>[1]) => unavailableCountrySignal('IR', family, 'Controlled source failure'),
  });
  try {
    await Reflect.get(manager, 'loadQualifiedCountrySignals').call(manager, 'IR');
    expect(page.updateMilitaryActivity).toHaveBeenCalledWith(expect.objectContaining({ownFlights:null,foreignFlights:null,nearbyVessels:null}));
    expect(Reflect.get(manager, 'buildMilitarySummary').call(manager, 'IR', 'Iran').coverageNotes.join(' ')).not.toContain('loading');
  } finally { loader.mockRestore(); }
});

it('removes the website Signals loading notice after qualified military work settles', async () => {
  const panel = new CountryDeepDivePanel();
  const signals = countrySignalsFromMilitary('IR');
  const body = document.createElement('div');
  Reflect.set(panel, 'signalsBody', body);
  panel.updateSignals(signals, ['Qualified country military observations are loading.']);
  const page = { signal: new AbortController().signal, getCode: () => 'IR', getName: () => 'Iran', isVisible: () => true,
    getSignalCounts: panel.getSignalCounts.bind(panel), updateSignals: panel.updateSignals.bind(panel), updateMilitaryActivity: vi.fn() };
  const manager = new CountryIntelManager({ countryBriefPage: page, latestClusters: [], intelligenceCache: {} } as unknown as AppContext);
  const loader = vi.spyOn(militaryActivity, 'loadHostCountryMilitaryActivity').mockRejectedValue(new Error('Controlled military failure'));
  Reflect.set(manager, 'qualifiedSource', { settleMandatoryReads: async () => {},
    countrySignals: async (_code: string, family: Parameters<typeof unavailableCountrySignal>[1]) => unavailableCountrySignal('IR', family, 'Controlled source failure') });
  try {
    await Reflect.get(manager, 'loadQualifiedCountrySignals').call(manager, 'IR');
    expect(body.textContent).not.toContain('Qualified country military observations are loading.');
    expect(body.textContent).toContain('Military observations could not be loaded. Retry or refresh to recover them.');
  } finally { loader.mockRestore(); panel.hide(); }
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((settle, fail) => { resolve = settle; reject = fail; });
  return { promise, resolve, reject };
}

function lifecycle() {
  const panel = new CountryDeepDivePanel();
  const body = document.createElement('div');
  const card = document.createElement('section');
  card.append(body);
  Reflect.set(panel, 'signalsBody', body);
  Reflect.set(panel, 'sections', [{ id: 'signals', title: 'Signals', card, body }]);
  let code = 'FR';
  let visible = true;
  const signals = { ...countrySignalsFromMilitary('FR'), ...Object.fromEntries(Object.keys(countrySignalsFromMilitary('FR')).map(key => [key, key === 'isTier1' ? false : 0])) };
  signals.earthquakes = 141;
  const page = {
    getCode: () => code, getName: () => code, isVisible: () => visible,
    show: (_name: string, nextCode: string) => { code = nextCode; panel.updateSignals(signals); },
    showLoading: () => {}, hide: () => { visible = false; },
    updateSignals: panel.updateSignals.bind(panel), updateSignalDetails: panel.updateSignalDetails.bind(panel),
    setSectionFailure: panel.setSectionFailure.bind(panel), updateScore: panel.updateScore.bind(panel),
    updateMilitaryActivity: () => {}, updateEconomicIndicators: () => {}, updateNews: () => {},
    updateInfrastructure: () => {}, updateBrief: vi.fn(), getTimelineMount: () => null,
  };
  const ctx = { countryBriefPage: page, isDestroyed: false, allNews: [], latestClusters: [], intelligenceCache: {},
    map: { setRenderPaused: () => {}, highlightCountry: () => {}, fitCountry: () => {} },
  } as unknown as AppContext;
  const manager = new CountryIntelManager(ctx);
  Reflect.set(manager, 'loadQualifiedCountrySignals', async (country: string) => ({ details: projectCountrySignalDetails(snapshot.read().find((value: CountrySignalCluster) => value.country === country)?.signals ?? []) }));
  Reflect.set(manager, 'ensureCountryBriefPage', async () => true);
  Reflect.set(manager, 'getCountrySignals', vi.fn(async () => signals));
  Reflect.set(manager, 'getCountryController', () => ({ hydrate: () => ({ stockPromise: Promise.resolve(null) }) }));
  const assessment = vi.fn(async () => ({ brief: 'Controlled assessment', sources: [] }));
  Reflect.set(manager, 'fetchCountryIntelBrief', assessment);
  for (const name of ['fetchDefenseIndustrialBase', 'fetchProSections', 'fetchCommodityVulnerability', 'mountCountryTimeline']) Reflect.set(manager, name, () => {});
  return { manager, panel, body, ctx, signals, page, assessment, switchCountry: () => { code = 'DE'; }, open: (options: { onPresented?: () => void } = {}) => manager.openCountryBriefByCode('FR', 'France', { trackAnalytics: false, ...options }) };
}

describe('website Signals lifecycle', () => {
  it.each(['opening', 'refresh'] as const)('publishes qualified unavailable coverage during %s without zero totals', async phase => {
    const h = lifecycle();
    if (phase === 'refresh') await h.open();
    const { COUNTRY_SIGNAL_FAMILIES, projectQualifiedCountrySignals, unavailableCountrySignal } = await import('../../shared/country-signal-observations');
    const value = projectQualifiedCountrySignals('FR', [...COUNTRY_SIGNAL_FAMILIES, 'military' as const].map(family => unavailableCountrySignal('FR', family, `Controlled ${family} unavailable`)));
    const publish = vi.fn((qualified: typeof value) => { Reflect.set(h.panel, 'currentCode', 'FR'); h.panel.updateQualifiedCountrySignals(qualified); });
    Object.assign(h.page, { updateQualifiedCountrySignals: publish });
    Reflect.set(h.manager, 'loadQualifiedCountrySignals', async () => { Reflect.set(h.manager, 'qualifiedSignals', value); return value; });
    try {
      if (phase === 'opening') await h.open(); else h.manager.refreshOpenBrief();
      await vi.waitFor(() => expect(publish).toHaveBeenCalledWith(value));
      expect(value.details).toBeNull();
      expect(value.families).toHaveLength(8);
      expect(h.body.textContent).toContain('Controlled radiation unavailable');
      expect(h.body.textContent).toContain('This is not zero activity');
      expect(h.body.querySelectorAll('.cdp-signal-item')).toHaveLength(0);
    } finally { h.panel.hide(); }
  });
  beforeEach(() => { paint.yield.mockResolvedValue(undefined); snapshot.read.mockReturnValue([cluster('FR', [observation('protest', 'high', 1)])]); });

  it('keeps observed severity and recent evidence after the complete opening count flow', async () => {
    const h = lifecycle();
    await h.open();
    expect(h.body.querySelector('.cdp-signal-breakdown')?.textContent).toBe('Critical0High1Moderate0Low0');
    expect(h.body.textContent).toContain('protest 1');
    expect(h.assessment).toHaveBeenCalledOnce();
    expect(h.page.updateBrief).toHaveBeenCalledWith(expect.objectContaining({ brief: 'Controlled assessment' }));
    expect(h.body.textContent).not.toContain('Loading top high-severity');
    h.panel.hide();
  });

  it('refreshes both counts and current observed details', async () => {
    const h = lifecycle();
    await h.open();
    snapshot.read.mockReturnValue([cluster('FR', [observation('radiation_anomaly', 'high', 2)])]);
    h.signals.earthquakes = 142;
    h.manager.refreshOpenBrief();
    await vi.waitFor(() => expect(h.body.textContent).toContain('radiation_anomaly 2'));
    expect(h.body.textContent).toContain('142 Earthquakes');
    expect(h.body.textContent).not.toContain('protest 1');
    expect(h.body.querySelector('.cdp-signal-breakdown')?.textContent).toContain('Critical1');
    h.panel.hide();
  });

  it.each(['opening', 'refresh'] as const)('settles %s detail failure as unavailable and recovers to observed empty', async mode => {
    const h = lifecycle();
    if (mode === 'refresh') await h.open();
    const detailRead = vi.spyOn(h.manager as unknown as { buildSignalDetails: (code: string) => Promise<ReturnType<typeof projectCountrySignalDetails>> }, 'buildSignalDetails');
    detailRead.mockRejectedValueOnce(new Error('Controlled detail outage'));
    if (mode === 'opening') await h.open(); else h.manager.refreshOpenBrief();
    await vi.waitFor(() => expect(h.body.textContent).toContain('Aggregate severity and recent high-severity observations are unavailable'));
    expect(h.body.textContent).toContain('141 Earthquakes');
    expect(h.body.textContent).not.toContain('Loading top high-severity');
    expect(h.body.textContent).not.toContain('No recent high-severity signals');
    if (mode === 'opening') {
      expect(h.assessment).toHaveBeenCalledOnce();
      expect(h.page.updateBrief).toHaveBeenCalledWith(expect.objectContaining({ brief: 'Controlled assessment' }));
    }
    h.panel.updateScore(null, h.signals);
    expect(h.body.textContent).toContain('Aggregate severity and recent high-severity observations are unavailable');
    expect(h.body.querySelector('.cdp-signal-breakdown .cdp-metric')).toBeNull();
    snapshot.read.mockReturnValue([]);
    h.manager.refreshOpenBrief();
    await vi.waitFor(() => expect(h.body.textContent).toContain('No recent high-severity signals'));
    expect(h.body.textContent).not.toContain('observations are unavailable');
    snapshot.read.mockReturnValue([cluster('FR', [observation('radiation_anomaly', 'high', 3)])]);
    h.manager.refreshOpenBrief();
    await vi.waitFor(() => expect(h.body.textContent).toContain('radiation_anomaly 3'));
    expect(h.body.querySelector('.cdp-signal-breakdown')?.textContent).toBe('Critical1High0Moderate0Low0');
    h.panel.hide();
  });

  it.each(['opening', 'refresh'] as const)('suppresses stale %s success and failure after ownership changes', async mode => {
    for (const change of ['country', 'presentation', 'hidden', 'destroyed', 'page'] as const) {
      for (const outcome of ['success', 'failure'] as const) {
        const h = lifecycle();
        if (mode === 'refresh') await h.open();
        const pending = deferred<ReturnType<typeof projectCountrySignalDetails>>();
        const detailRead = vi.spyOn(h.manager as unknown as { buildSignalDetails: (code: string) => Promise<ReturnType<typeof projectCountrySignalDetails>> }, 'buildSignalDetails').mockReturnValueOnce(pending.promise);
        const opening = mode === 'opening' ? h.open() : undefined;
        if (mode === 'refresh') h.manager.refreshOpenBrief();
        await vi.waitFor(() => expect(detailRead).toHaveBeenCalledOnce());
        if (change === 'country') h.switchCountry();
        if (change === 'presentation') Reflect.set(h.manager, 'currentCountryPresentation', { ...Reflect.get(h.manager, 'currentCountryPresentation') });
        if (change === 'hidden') h.page.hide();
        if (change === 'destroyed') h.ctx.isDestroyed = true;
        if (change === 'page') h.ctx.countryBriefPage = { ...h.page } as unknown as AppContext['countryBriefPage'];
        h.panel.updateSignalDetails(projectCountrySignalDetails([observation('protest', 'high', 9)]));
        const before = h.body.textContent;
        if (outcome === 'success') pending.resolve(projectCountrySignalDetails([observation('protest', 'high', 6)]));
        else pending.reject(new Error('Stale controlled failure'));
        await opening;
        await pending.promise.catch(() => {});
        await Promise.resolve();
        expect(h.body.textContent, `${mode}/${change}/${outcome}`).toBe(before);
        h.panel.hide();
      }
    }
  });

  it('keeps refresh counts coverage and details when refresh completes during the opening paint yield', async () => {
    const h = lifecycle();
    const yielded = deferred<void>();
    const countPaints: string[] = [];
    vi.spyOn(h.page, 'updateSignals').mockImplementation((signals, notes) => {
      h.panel.updateSignals(signals, notes);
      countPaints.push(h.body.querySelector('.cdp-signal-chips')?.textContent ?? '');
    });
    paint.yield.mockReturnValueOnce(yielded.promise);
    Reflect.set(h.manager, 'getCountrySignals', vi.fn().mockResolvedValueOnce({ ...h.signals, earthquakes: 141 }).mockResolvedValue({ ...h.signals, earthquakes: 142 }));
    Reflect.set(h.manager, 'buildMilitarySummary', () => ({ coverageNotes: ['Current refresh coverage'] }));
    const opening = h.open({ onPresented: () => {
      snapshot.read.mockReturnValue([cluster('FR', [observation('radiation_anomaly', 'high', 7)])]);
      h.manager.refreshOpenBrief();
    } });
    await vi.waitFor(() => expect(h.body.textContent).toContain('radiation_anomaly 7'));
    expect(h.body.textContent).toContain('142 Earthquakes');
    const owned = { code:'FR', page:h.page, signalCounts:{militaryFlights:0,militaryFlightsInCountry:0,militaryVessels:93,militaryVesselsInCountry:1}, value:{ownFlights:0,foreignFlights:0,nearbyVessels:1,foreignPresence:false,nearestBases:[],coverage:'complete',coverageNotes:['Qualified refresh clock']} };
    Reflect.set(h.manager,'qualifiedMilitarySummary',owned);
    yielded.resolve();
    await opening;
    expect(h.body.textContent).toContain('142 Earthquakes');
    expect(h.body.textContent).not.toContain('141 Earthquakes');
    expect(Reflect.get(h.manager,'qualifiedMilitarySummary')).toBe(owned);
    expect(h.body.textContent).toContain('Current refresh coverage');
    expect(countPaints).toEqual(['✈️ Military Air unavailable⚓ Naval Vessels unavailable🌍 142 Earthquakes']);
    expect(h.body.textContent).toContain('radiation_anomaly 7');
    expect(h.body.querySelector('.cdp-signal-breakdown')?.textContent).toBe('Critical1High0Moderate0Low0');
    expect(h.assessment).toHaveBeenCalledOnce();
    expect(h.page.updateBrief).toHaveBeenCalledWith(expect.objectContaining({ brief: 'Controlled assessment' }));
    h.panel.hide();
  });

  it('settles early refresh count rejection and recovers without reviving opening counts', async () => {
    const h = lifecycle();
    const countPaints: string[] = [];
    vi.spyOn(h.page, 'updateSignals').mockImplementation((signals, notes) => {
      h.panel.updateSignals(signals, notes);
      countPaints.push(h.body.querySelector('.cdp-signal-chips')?.textContent ?? '');
    });
    Reflect.set(h.manager, 'getCountrySignals', vi.fn().mockResolvedValueOnce({ ...h.signals })
      .mockRejectedValueOnce(new Error('Controlled refresh counts outage'))
      .mockResolvedValue({ ...h.signals, earthquakes: 142 }));
    await h.open({ onPresented: () => h.manager.refreshOpenBrief() });
    expect(h.assessment).toHaveBeenCalledOnce();
    expect(h.page.updateBrief).toHaveBeenCalledWith(expect.objectContaining({ brief: 'Controlled assessment' }));
    expect(h.body.textContent).toContain('Aggregate severity and recent high-severity observations are unavailable');
    expect(h.body.textContent).not.toContain('Loading top high-severity');
    expect(h.body.querySelector('.cdp-signal-breakdown .cdp-metric')).toBeNull();
    expect(countPaints).toEqual([]);
    h.panel.updateScore(null, h.signals);
    expect(h.body.textContent).toContain('observations are unavailable');
    snapshot.read.mockReturnValue([]);
    h.manager.refreshOpenBrief();
    await vi.waitFor(() => expect(h.body.textContent).toContain('No recent high-severity signals'));
    expect(h.body.textContent).toContain('142 Earthquakes');
    expect(h.body.querySelector('.cdp-signal-breakdown')?.textContent).toBe('Critical0High0Moderate0Low0');
    snapshot.read.mockReturnValue([cluster('FR', [observation('radiation_anomaly', 'high', 8)])]);
    h.manager.refreshOpenBrief();
    await vi.waitFor(() => expect(h.body.textContent).toContain('radiation_anomaly 8'));
    expect(h.body.querySelector('.cdp-signal-breakdown')?.textContent).toBe('Critical1High0Moderate0Low0');
    expect(h.body.textContent).not.toContain('observations are unavailable');
    h.panel.hide();
  });

  it('preserves settled detail evidence when a later refresh count read rejects', async () => {
    const h = lifecycle();
    await h.open();
    const before = h.body.textContent;
    const counts = deferred<typeof h.signals>();
    Reflect.set(h.manager, 'getCountrySignals', () => counts.promise);
    h.manager.refreshOpenBrief();
    counts.reject(new Error('Controlled settled counts outage'));
    await counts.promise.catch(() => {});
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(h.body.textContent).toBe(before);
    h.panel.hide();
  });

  it.each(['success', 'failure'] as const)('settles count rejection while older refresh details are pending then suppresses their %s', async outcome => {
    const h = lifecycle();
    await h.open();
    const pending = deferred<ReturnType<typeof projectCountrySignalDetails>>();
    const detailRead = vi.spyOn(h.manager as unknown as { buildSignalDetails: (code: string) => Promise<ReturnType<typeof projectCountrySignalDetails>> }, 'buildSignalDetails').mockReturnValueOnce(pending.promise);
    Reflect.set(h.manager, 'getCountrySignals', vi.fn().mockResolvedValueOnce({ ...h.signals, earthquakes: 142 }).mockRejectedValueOnce(new Error('Controlled overlapping counts outage')));
    h.manager.refreshOpenBrief();
    await vi.waitFor(() => expect(detailRead).toHaveBeenCalledOnce());
    expect(h.body.textContent).toContain('protest 1');
    h.manager.refreshOpenBrief();
    await vi.waitFor(() => expect(h.body.textContent).toContain('observations are unavailable'));
    expect(h.body.textContent).toContain('142 Earthquakes');
    expect(h.body.textContent).not.toContain('Loading top high-severity');
    const before = h.body.textContent;
    if (outcome === 'success') pending.resolve(projectCountrySignalDetails([observation('protest', 'high', 6)]));
    else pending.reject(new Error('Superseded detail outage'));
    await pending.promise.catch(() => {});
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(h.body.textContent).toBe(before);
    h.panel.hide();
  });

  it.each(['country', 'presentation', 'hidden', 'destroyed', 'page', 'newer-refresh'] as const)('suppresses early count rejection after %s ownership change', async change => {
    const h = lifecycle();
    const counts = deferred<typeof h.signals>();
    const read = vi.fn().mockResolvedValueOnce(h.signals).mockReturnValueOnce(counts.promise).mockResolvedValue({ ...h.signals, earthquakes: 142 });
    Reflect.set(h.manager, 'getCountrySignals', read);
    const opening = h.open({ onPresented: () => h.manager.refreshOpenBrief() });
    await vi.waitFor(() => expect(read.mock.calls.length).toBeGreaterThanOrEqual(2));
    if (change === 'country') h.switchCountry();
    if (change === 'presentation') Reflect.set(h.manager, 'currentCountryPresentation', { ...Reflect.get(h.manager, 'currentCountryPresentation') });
    if (change === 'hidden') h.page.hide();
    if (change === 'destroyed') h.ctx.isDestroyed = true;
    if (change === 'page') h.ctx.countryBriefPage = { ...h.page } as unknown as AppContext['countryBriefPage'];
    if (change === 'newer-refresh') {
      snapshot.read.mockReturnValue([cluster('FR', [observation('radiation_anomaly', 'high', 9)])]);
      h.manager.refreshOpenBrief();
      await vi.waitFor(() => expect(h.body.textContent).toContain('radiation_anomaly 9'));
    } else h.panel.updateSignalDetails(projectCountrySignalDetails([observation('protest', 'high', 9)]));
    const before = h.body.textContent;
    counts.reject(new Error('Stale early counts outage'));
    await counts.promise.catch(() => {});
    await opening;
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(h.body.textContent).toBe(before);
    h.panel.hide();
  });

  it.each(['success', 'failure'] as const)('does not let pending opening %s overwrite a newer refresh', async outcome => {
    const h = lifecycle();
    const pending = deferred<ReturnType<typeof projectCountrySignalDetails>>();
    const detailRead = vi.spyOn(h.manager as unknown as { buildSignalDetails: (code: string) => Promise<ReturnType<typeof projectCountrySignalDetails>> }, 'buildSignalDetails').mockReturnValueOnce(pending.promise);
    const opening = h.open();
    await vi.waitFor(() => expect(detailRead).toHaveBeenCalledOnce());
    snapshot.read.mockReturnValue([cluster('FR', [observation('protest', 'high', 7)])]);
    h.manager.refreshOpenBrief();
    await vi.waitFor(() => expect(h.body.textContent).toContain('protest 7'));
    if (outcome === 'success') pending.resolve(projectCountrySignalDetails([observation('protest', 'high', 6)]));
    else pending.reject(new Error('Superseded opening failure'));
    await opening;
    expect(h.body.textContent).toContain('protest 7');
    expect(h.body.textContent).not.toContain('protest 6');
    h.panel.hide();
  });

  it.each(['success', 'failure'] as const)('does not let an older refresh %s overwrite a newer detail result', async outcome => {
    const h = lifecycle();
    await h.open();
    const pending = deferred<ReturnType<typeof projectCountrySignalDetails>>();
    const detailRead = vi.spyOn(h.manager as unknown as { buildSignalDetails: (code: string) => Promise<ReturnType<typeof projectCountrySignalDetails>> }, 'buildSignalDetails').mockReturnValueOnce(pending.promise);
    h.manager.refreshOpenBrief();
    await vi.waitFor(() => expect(detailRead).toHaveBeenCalledOnce());
    snapshot.read.mockReturnValue([cluster('FR', [observation('protest', 'high', 7)])]);
    h.manager.refreshOpenBrief();
    await vi.waitFor(() => expect(h.body.textContent).toContain('protest 7'));
    if (outcome === 'success') pending.resolve(projectCountrySignalDetails([observation('protest', 'high', 6)]));
    else pending.reject(new Error('Superseded refresh failure'));
    await pending.promise.catch(() => {});
    await Promise.resolve();
    expect(h.body.textContent).toContain('protest 7');
    expect(h.body.textContent).not.toContain('protest 6');
    h.panel.hide();
  });
});
