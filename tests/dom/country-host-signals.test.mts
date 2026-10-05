import { beforeAll, expect, it } from 'vitest';
import { CountryDeepDivePanel } from '@/components/CountryDeepDivePanel';
import { briefSectionState } from '@/components/country-brief-presentation';
import { countrySignalsFromMilitary, recoverCountrySignals } from '@/services/country-signals';
import { initTestI18n } from './helpers/i18n.mts';

beforeAll(async () => { await initTestI18n(); });

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
