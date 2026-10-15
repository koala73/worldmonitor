import { beforeAll, expect, it } from 'vitest';
import { CountryDeepDivePanel } from '@/components/CountryDeepDivePanel';
import { briefSectionState } from '@/components/country-brief-presentation';
import { countrySignalsFromMilitary, recoverCountrySignals, recoverRawSignals, composeCountrySignals } from '@/services/country-signals';
import { initTestI18n } from './helpers/i18n.mts';

beforeAll(async () => { await initTestI18n(); });

it('renders informational advice without escalating it to caution', () => {
  const panel = new CountryDeepDivePanel();
  const body = document.createElement('div');
  Reflect.set(panel, 'signalsBody', body);
  panel.updateSignals(countrySignalsFromMilitary('US', undefined, { earthquakes: null, outages: null, travelAdvisories: 1, travelAdvisoryMaxLevel: 'info', thermalEscalations: null }));
  expect(body.textContent).toContain('1 Advisory: Info');
  expect(body.textContent).not.toContain('Exercise Caution');
  panel.hide();
});

it('renders normal travel advice without escalating it to caution', () => {
  const panel = new CountryDeepDivePanel();
  const body = document.createElement('div');
  Reflect.set(panel, 'signalsBody', body);
  panel.updateSignals(countrySignalsFromMilitary('US', undefined, { earthquakes: null, outages: null, travelAdvisories: 1, travelAdvisoryMaxLevel: 'normal', thermalEscalations: null }));
  expect(body.textContent).toContain('Normal Precautions');
  expect(body.textContent).not.toContain('Exercise Caution');
  panel.hide();
});

it('carries selected-country advisory publishers into portable coverage and rendered notes', async () => {
  const { assembleRawSignals, failedRawSignal, RAW_SIGNAL_FAMILIES, validateRawSignal } = await import('../../shared/country-raw-signals');
  const time = '2026-10-01T12:00:00Z';
  const sources = Object.fromEntries(RAW_SIGNAL_FAMILIES.map(family => [family, failedRawSignal(family, 'unavailable', time, 'No data')])) as Parameters<typeof assembleRawSignals>[1];
  const row = { title: 'Advice', link: 'https://example.com/advice', source: 'US State Dept', sourceCountry: 'US', pubDate: time, level: 'normal', country: 'US' };
  sources.advisories = validateRawSignal('advisories', { advisories: [row, { ...row, source: 'UK FCDO' }, { ...row, source: 'Other publisher', country: 'CN' }], byCountry: Object.fromEntries(Array.from({ length: 100 }, (_, index) => [`C${index}`, 'normal'])) }, time) as typeof sources.advisories;
  expect(sources.advisories.state).toBe('observed');
  const raw = recoverRawSignals(assembleRawSignals('US', sources, time).value, null);
  const composed = composeCountrySignals(countrySignalsFromMilitary('US'), 'US', 'United States', undefined, [], raw, false, () => false);
  expect(composed.notes.join(' ')).toContain('US State Dept');
  expect(composed.notes.join(' ')).toContain('UK FCDO');
  expect(composed.notes.join(' ')).not.toContain('Other publisher');
  expect(composed.coverage?.advisories?.observation?.publishers).toEqual(['US State Dept', 'UK FCDO']);
  const panel = new CountryDeepDivePanel();
  const body = document.createElement('div');
  Reflect.set(panel, 'signalsBody', body);
  panel.updateSignals(composed.signals, composed.notes);
  expect(body.textContent).toContain('US State Dept');
  expect(Reflect.get(panel, 'signalCoverageNotes').join(' ')).toContain('UK FCDO');
  panel.hide();
});

it('renders partial observed counts and unknown sources without fabricating aggregate severity', () => {
  const panel = new CountryDeepDivePanel();
  const body = document.createElement('div');
  Reflect.set(panel, 'signalsBody', body);
  const signals = countrySignalsFromMilitary('US', { militaryFlights: 3, militaryFlightsInCountry: 1, militaryVessels: null, militaryVesselsInCountry: null });
  panel.updateSignals(signals);
  expect(body.textContent).toContain('3 Military Air');
  expect(body.textContent).toContain('Naval Vessels unavailable');
  expect(body.textContent).toContain('Critical News unavailable');
  expect(body.textContent).toContain('Aggregate severity and recent high-severity observations are unavailable');
  expect(body.querySelector('.cdp-signal-chip[title]')?.getAttribute('title')).toBe('3 near · 1 inside borders');
  expect(body.querySelector('.cdp-signal-breakdown')?.textContent).not.toMatch(/High\s*3/);
  expect(signals.protests).toBeNull();
  expect(signals.criticalNews).toBeNull();
  panel.updateScore(null, null);
  expect(panel.getSignalCounts()).toEqual(signals);
  expect(body.textContent).toContain('3 Military Air');
  panel.hide();
});

it('distinguishes unavailable vessel counts from a recovered observed count', () => {
  const panel = new CountryDeepDivePanel();
  const body = document.createElement('div');
  Reflect.set(panel, 'signalsBody', body);
  panel.updateSignals(countrySignalsFromMilitary('US', { militaryFlights: null, militaryFlightsInCountry: null, militaryVessels: null, militaryVesselsInCountry: null }));
  expect(body.textContent).toContain('Military Air unavailable');
  panel.updateSignals(countrySignalsFromMilitary('US', { militaryFlights: 0, militaryFlightsInCountry: 0, militaryVessels: 2, militaryVesselsInCountry: 1 }));
  expect(body.textContent).toContain('2 Naval Vessels');
  expect(body.textContent).not.toContain('Military Air unavailable');
  expect(body.textContent).not.toContain('Naval Vessels unavailable');
  expect(panel.getSignalCounts()?.militaryFlights).toBe(0);
  panel.hide();
});

it('retains website recent evidence when a score refresh updates the count chips', () => {
  const panel = new CountryDeepDivePanel();
  const body = document.createElement('div');
  Reflect.set(panel, 'signalsBody', body);
  panel.updateSignals(countrySignalsFromMilitary('US'));
  panel.updateSignalDetails({ critical: 1, high: 0, medium: 0, low: 0, recentHigh: [{ type: 'MILITARY', severity: 'critical', description: 'Observed evidence', timestamp: new Date() }] });
  const breakdown = body.querySelector('.cdp-signal-breakdown')?.textContent;
  const recent = body.querySelector('.cdp-signal-recent');
  const before = recent?.textContent;
  expect(before).toContain('Observed evidence');
  panel.updateScore(null, countrySignalsFromMilitary('US', { militaryFlights: 2, militaryFlightsInCountry: 1, militaryVessels: 0, militaryVesselsInCountry: 0 }));
  expect(recent?.textContent).toBe(before);
  expect(body.querySelector('.cdp-signal-breakdown')?.textContent).toBe(breakdown);
  expect(body.textContent).toContain('2 Military Air');
  panel.updateSignals(countrySignalsFromMilitary('US'));
  expect(body.textContent).not.toContain('Observed evidence');
  expect(body.textContent).toContain('Aggregate severity');
  panel.hide();
});

it('retains prior country counts only for unavailable authorized sources and replaces them on recovery', () => {
  const prior = countrySignalsFromMilitary('US', { militaryFlights: 3, militaryFlightsInCountry: 2, militaryVessels: 2, militaryVesselsInCountry: 1 });
  const next = countrySignalsFromMilitary('US', { militaryFlights: 1, militaryFlightsInCountry: 0, militaryVessels: null, militaryVesselsInCountry: null });
  const recovered = recoverCountrySignals(next, prior, []);
  expect(recovered.signals.militaryFlights).toBe(1);
  expect(recovered.signals.militaryVessels).toBe(2);
  expect(recovered.notes.join(' ')).toContain('previously loaded');
  expect(recoverCountrySignals(next, prior, ['militaryVessels', 'militaryVesselsInCountry']).signals.militaryVessels).toBeNull();
  expect(recoverCountrySignals(next, null, []).signals.militaryVessels).toBeNull();
  const zero = countrySignalsFromMilitary('US', { militaryFlights: 0, militaryFlightsInCountry: 0, militaryVessels: 0, militaryVesselsInCountry: 0 });
  expect(recoverCountrySignals(zero, prior, []).signals).toEqual(zero);
  expect(recoverCountrySignals(zero, prior, []).notes).toEqual([]);
});

it.each([['US', true], ['CH', false]] as const)('preserves known static tier for %s while live sources remain unknown', (code, isTier1) => {
  const panel = new CountryDeepDivePanel();
  const body = document.createElement('div');
  Reflect.set(panel, 'signalsBody', body);
  const signals = countrySignalsFromMilitary(code);
  panel.updateSignals(signals);
  expect(panel.getSignalCounts()?.isTier1).toBe(isTier1);
  expect(Object.entries(signals).filter(([key]) => key !== 'isTier1').every(([, value]) => value === null)).toBe(true);
  expect(body.textContent).toContain('Signal coverage is partial');
  expect(body.textContent).toContain('Military Air unavailable');
  expect(body.textContent).toContain('Aggregate severity and recent high-severity observations are unavailable');
  expect(body.querySelector('[data-brief-state="unavailable"]')).not.toBeNull();
  panel.hide();
});

it('counts observed zero as live coverage while excluding static classification', () => {
  const panel = new CountryDeepDivePanel();
  const body = document.createElement('div');
  const card = document.createElement('section');
  const section = { id: 'signals' as const, title: 'Signals', card, body };
  Reflect.set(panel, 'signalsBody', body);
  Reflect.set(panel, 'sections', [section]);
  const signals = countrySignalsFromMilitary('CH', { militaryFlights: 0, militaryFlightsInCountry: 0, militaryVessels: 0, militaryVesselsInCountry: 0 });
  panel.updateSignals(signals);
  expect(briefSectionState(section)).toBe('ready');
  expect(card.dataset.briefCoverage).toBe('partial');
  expect(panel.getSignalCounts()?.isTier1).toBe(false);
  expect(panel.getSignalCounts()?.militaryFlights).toBe(0);
  const complete = Object.fromEntries(Object.keys(signals).map(key => [key, key === 'isTier1' ? null : 0])) as typeof signals;
  panel.updateSignals(complete);
  expect(card.dataset.briefCoverage).toBe('complete');
  expect(body.querySelector('[data-brief-state="unavailable"]')).toBeNull();
  expect(panel.getSignalCounts()?.isTier1).toBeNull();
  panel.hide();
});


it.each(['military-first', 'raw-first'])('keeps independent observed slots in the compiled panel: %s', (order) => {
  const panel = new CountryDeepDivePanel();
  const body = document.createElement('div');
  Reflect.set(panel, 'signalsBody', body);
  const observed = { earthquakes: 2, outages: 1, travelAdvisories: 3, travelAdvisoryMaxLevel: 'caution', thermalEscalations: 1 };
  const military = { militaryFlights: 3, militaryFlightsInCountry: 1, militaryVessels: 2, militaryVesselsInCountry: 1 };
  let militarySlot: typeof military | undefined;
  let rawSlot: typeof observed | undefined;
  const complete = (kind: string) => {
    if (kind === 'military') militarySlot = military; else rawSlot = observed;
    panel.updateSignals(countrySignalsFromMilitary('US', militarySlot, rawSlot));
  };
  for (const kind of order === 'military-first' ? ['military', 'raw'] : ['raw', 'military']) complete(kind);
  expect(panel.getSignalCounts()).toMatchObject({ ...military, ...observed, isTier1: true });
  expect(body.textContent).toContain('2 Earthquakes');
  expect(body.textContent).toContain('3 Military Air');
  expect(body.textContent).toContain('Aggregate severity and recent high-severity observations are unavailable');
  panel.hide();
});


it('retains each raw family observation with its original dates, clears denial, and replaces observed zero', async () => {
  const { assembleRawSignals, failedRawSignal, RAW_SIGNAL_FAMILIES, validateRawSignal } = await import('../../shared/country-raw-signals');
  const time = '2026-10-01T12:00:00Z'; const latestTime = '2026-10-05T12:00:00Z';
  const sources = Object.fromEntries(RAW_SIGNAL_FAMILIES.map(family => [family, failedRawSignal(family, 'unavailable', time, 'Not observed')])) as Parameters<typeof assembleRawSignals>[1];
  sources.outages = validateRawSignal('outages', { outages: [{ id: 'out', title: 'Observed outage', country: 'United States', location: { latitude: 38, longitude: -77 }, detectedAt: 1791000000000, endedAt: 0, link: 'https://example.com/out' }] }, time) as typeof sources.outages;
  const prior = recoverRawSignals(assembleRawSignals('US', sources, time).value, null);
  const failed = Object.fromEntries(RAW_SIGNAL_FAMILIES.map(family => [family, failedRawSignal(family, 'unavailable', latestTime, 'Transient failure')])) as typeof sources;
  const recovered = recoverRawSignals(assembleRawSignals('US', failed, latestTime).value, prior);
  const composed = composeCountrySignals(countrySignalsFromMilitary('US'), 'US', 'United States', { militaryFlights: 3, militaryFlightsInCountry: 1, militaryVessels: 2, militaryVesselsInCountry: 1 }, ['Military source note'], recovered, true, () => true);
  expect(composed.signals).toMatchObject({ outages: 1, militaryFlights: 3, isTier1: true });
  expect(composed.coverage?.outages?.observation?.retrievedAt).toBe(time);
  expect(composed.coverage?.outages?.latestRetrievedAt).toBe(latestTime);
  expect(composed.notes.join(' ')).toContain('these counts are not fresh');
  expect(composed.notes.join(' ')).toContain('Original returned-sample dates');
  failed.outages = failedRawSignal('outages', 'locked', latestTime, 'Denied') as typeof failed.outages;
  const denied = recoverRawSignals(assembleRawSignals('US', failed, latestTime).value, recovered);
  expect(composeCountrySignals(countrySignalsFromMilitary('US'), 'US', 'United States', undefined, [], denied, true, () => true).signals.outages).toBeNull();
  expect(denied.families.outages.observation).toBeNull();
  failed.outages = validateRawSignal('outages', { outages: [] }, latestTime) as typeof failed.outages;
  const zero = recoverRawSignals(assembleRawSignals('US', failed, latestTime).value, recovered);
  expect(composeCountrySignals(countrySignalsFromMilitary('US'), 'US', 'United States', undefined, [], zero, true, () => true).signals.outages).toBe(0);
  expect(zero.families.outages.retained).toBe(false);
  expect(recoverRawSignals(assembleRawSignals('CN', failed, latestTime).value, prior).families.earthquakes.observation).toBeNull();
});

it('keeps portable Signals notices bounded and resets them when the country is replaced', () => {
  const panel = new CountryDeepDivePanel();
  Reflect.set(panel, 'signalsBody', document.createElement('div'));
  panel.updateSignals(countrySignalsFromMilitary('US'), ['Returned sample; snapshot unknown; these counts are not fresh.']);
  expect(Reflect.get(panel, 'signalCoverageNotes')).toEqual(['Returned sample; snapshot unknown; these counts are not fresh.']);
  panel.show('China', 'CN', null, countrySignalsFromMilitary('CN'));
  expect(Reflect.get(panel, 'signalCoverageNotes')).toEqual([]);
  panel.hide();
});


it('keeps not-fresh disclosure at the start of exported notes even with maximum accepted metadata', async () => {
  const { assembleRawSignals, failedRawSignal, RAW_SIGNAL_FAMILIES, validateRawSignal } = await import('../../shared/country-raw-signals');
  const sources = Object.fromEntries(RAW_SIGNAL_FAMILIES.map(family => [family, failedRawSignal(family, 'unavailable', '2026-10-01T12:00:00Z', 'No data')])) as Parameters<typeof assembleRawSignals>[1];
  sources.thermal = validateRawSignal('thermal', { clusters: [{ id: 'hot', countryCode: 'US', status: 'THERMAL_STATUS_SPIKE', firstDetectedAt: '2026-10-01T12:00:00Z', lastDetectedAt: '2026-10-01T14:00:00Z' }], fetchedAt: '2026-10-01T15:00:00Z', observationWindowHours: 24, sourceVersion: 's'.repeat(100) }, '2026-10-01T15:00:00Z') as typeof sources.thermal;
  sources.thermal.scope = 's'.repeat(500); sources.thermal.attribution = 'a'.repeat(500); sources.thermal.observationWindow = 'w'.repeat(200);
  const prior = recoverRawSignals(assembleRawSignals('US', sources, '2026-10-01T15:00:00Z').value, null);
  const failed = { ...sources, thermal: failedRawSignal('thermal', 'unavailable', '2026-10-05T12:00:00Z', 'f'.repeat(400)) } as typeof sources;
  const composed = composeCountrySignals(countrySignalsFromMilitary('US'), 'US', 'United States', undefined, [], recoverRawSignals(assembleRawSignals('US', failed, '2026-10-05T12:00:00Z').value, prior), true, () => true);
  const panel = new CountryDeepDivePanel(); Reflect.set(panel, 'signalsBody', document.createElement('div'));
  panel.updateSignals(composed.signals, composed.notes);
  const portable = Reflect.get(panel, 'signalCoverageNotes') as string[];
  expect(portable.find(note => note.startsWith('thermal:'))).toContain('these counts are not fresh');
  expect(portable.every(note => note.length <= 1600)).toBe(true); panel.hide();
});


it('shows sampled information advisories even when the independent native maximum is unknown', () => {
  const panel = new CountryDeepDivePanel(); const body = document.createElement('div'); Reflect.set(panel, 'signalsBody', body);
  panel.updateSignals(countrySignalsFromMilitary('US', undefined, { earthquakes: null, outages: null, travelAdvisories: 1, travelAdvisoryMaxLevel: null, thermalEscalations: 2 }));
  expect(body.textContent).toContain('1 Advisory'); expect(body.textContent).toContain('2 Thermal escalations'); panel.hide();
});
