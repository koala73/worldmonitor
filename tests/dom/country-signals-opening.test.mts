import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { initTestI18n } from './helpers/i18n.mts';
import { createHostCountryBriefSource } from '@/services/country-brief-source';
import { CountryDeepDivePanel } from '@/components/CountryDeepDivePanel';
import { CountryBriefController } from '@/components/CountryBriefController';
import { countrySignalsFromMilitary } from '@/services/country-signals';
import { loadHostCountryMilitaryActivity } from '@/services/country-military-activity';
import { loadQualifiedCountrySignals } from '@/services/country-signal-projection';
import { qualifiedFixtureOutcomes } from '../../src/e2e/fixtures/qualified-country-signals';
import { assembleRawSignals, failedRawSignal, RAW_SIGNAL_FAMILIES } from '../../shared/country-raw-signals';

beforeAll(initTestI18n);
afterEach(() => { vi.unstubAllGlobals(); });
it.each(['IR', 'CN'])('measures %s panel and controller opening reads with ten sectors and eight flight pages', async code => {
  const calls: Array<{ section: string; arguments: Record<string, any> }> = [];
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Network is forbidden in opening fixtures'); }));
  const source = await createHostCountryBriefSource(async (_name, args: any) => {
    calls.push(args);
    const a = args.arguments;
    let value: Record<string, unknown> = {};
    switch (args.section) {
      case 'signalsRaw': return assembleRawSignals(code, Object.fromEntries(RAW_SIGNAL_FAMILIES.map(family => [family, failedRawSignal(family, 'unavailable', new Date().toISOString(), 'Controlled missing source')] )) as never, new Date().toISOString());
      case 'countrySignals': {
        if (a.family === 'COUNTRY_SIGNAL_FAMILY_FLIGHT_PAGE') {
          const page = a.cursor ? Number(String(a.cursor).split(':')[1]) : 0;
          value = { countryCode: code, family: a.family, windowIndex: 0, outcomeJson: '', flightPage: { flights: [{ id: `flight-${page}`, source: 'adsb.lol', operatorCountry: code, location: { latitude: 32, longitude: code === 'CN' ? 110 : 53 }, firstSeenAt: 1792324800000 }], clusters: [], pagination: { nextCursor: page < 7 ? `w0:${page + 1}` : '', totalCount: 8 } } };
        } else value = { countryCode: code, family: a.family, windowIndex: 0, outcomeJson: JSON.stringify({ ...qualifiedFixtureOutcomes().find(row => `COUNTRY_SIGNAL_FAMILY_${row.family.toUpperCase()}` === a.family), countryCode: code }) };
        break;
      }
      case 'exposure': value = { iso2: code, hs2: a.hs2, primaryChokepointId: 'hormuz_strait', vulnerabilityIndex: 50, fetchedAt: '2026-10-18T12:00:00Z', exposures: [{ chokepointId: 'hormuz_strait', chokepointName: 'Hormuz', exposureScore: 50, coastSide: '', shockSupported: true }] }; break;
      case 'dependency': value = { iso2: code, hs2: a.hs2, flags: [], primaryExporterIso2: 'CN', primaryExporterShare: 0.5 }; break;
      case 'cost': value = { iso2: code, chokepointId: a.chokepointId, closureDays: a.closureDays, sectors: [{ hs2: '27', hs2Label: 'Fuel', totalCostShock: 30000000 }], totalAddedCost: 30000000, fetchedAt: '2026-10-18T12:00:00Z', unavailableReason: '' }; break;
      case 'chokepoints': value = { chokepoints: [{ id: 'hormuz_strait', disruptionScore: 50 }] }; break;
      case 'products': value = { iso2: code, products: [{ hs4: '2709', description: 'Controlled fuel', totalValue: 100, topExporters: [{ partnerCode: 156, partnerIso2: 'CN', partnerName: 'China', share: 1, value: 100 }], year: 2025 }], fetchedAt: '2026-10-18T12:00:00Z' }; break;
      case 'imf': case 'housing': value = { data: {}, missing: [] }; break;
      case 'vessels': value = { dataAvailable: true, snapshot: { snapshotAt: Date.now(), status: { connected: true }, candidateReports: [], disruptions: [] } }; break;
      case 'pipelines': value = { pipelines: [] }; break;
      case 'facilities': value = { facilities: [] }; break;
      case 'shortages': value = { shortages: [] }; break;
      case 'disruptions': value = { events: [] }; break;
      case 'debt': value = { entries: [] }; break;
      case 'tariffs': value = { datapoints: [] }; break;
      case 'flows': value = { flows: [] }; break;
      case 'markets': value = { dataAvailable: true, markets: [] }; break;
      case 'bypass': value = { options: [] }; break;
    }
    return { section: args.section, state: 'ready', value, retrievedAt: new Date().toISOString() };
  });
  const panel = new CountryDeepDivePanel(null, source);
  panel.show(code, code, null, countrySignalsFromMilitary(code));
  const controller = new CountryBriefController(source, panel);
  try {
    controller.hydrate(code, code);
    const military = loadHostCountryMilitaryActivity(source, code, code, panel.signal);
    const risk = source.intelligence.getCountryRisk({ countryCode: code }, { signal: panel.signal });
    const raw = source.signalsRaw(code, panel.signal);
    const china = code === 'CN' ? source.intelligence.getChinaDecisionSignals({}, { signal: panel.signal }) : null;
    const qualified = await loadQualifiedCountrySignals(source, code, panel.signal, military.then(async value => { await panel.settleHostedOpeningReads(); return value; }));
    await china;
    await risk;
    await raw;
    await source.settleMandatoryReads();
    expect(calls.filter(call => call.section === 'exposure')).toHaveLength(10);
    expect(calls.filter(call => call.section === 'dependency')).toHaveLength(10);
    expect(calls.filter(call => call.section === 'countrySignals' && call.arguments.family === 'COUNTRY_SIGNAL_FAMILY_FLIGHT_PAGE')).toHaveLength(8);
    expect(calls.filter(call => call.section === 'risk')).toHaveLength(1);
    expect(calls.filter(call => call.section === 'cost')).toMatchObject([{ arguments: { closureDays: 30 } }]);
    expect(calls.filter(call => call.section === 'chokepoints')).toHaveLength(1);
    expect(calls.length + 2).toBeLessThanOrEqual(64);
    expect(calls.filter(call => call.section === 'countrySignals' && call.arguments.family !== 'COUNTRY_SIGNAL_FAMILY_FLIGHT_PAGE')).toHaveLength(code === 'CN' ? 5 : 6);
    expect(qualified.families.filter(family => family.reason?.startsWith('Deferred:'))).toHaveLength(1);
    expect(qualified.details).not.toBeNull();
  } finally { controller.dispose(); panel.hide(); }
});
