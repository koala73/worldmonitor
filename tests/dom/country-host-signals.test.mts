import { beforeAll, expect, it } from 'vitest';
import { CountryDeepDivePanel } from '@/components/CountryDeepDivePanel';
import { countrySignalsFromMilitary, recoverCountrySignals } from '@/services/country-signals';
import { initTestI18n } from './helpers/i18n.mts';

beforeAll(async () => { await initTestI18n(); });

it('renders partial observed counts and unknown sources without fabricating aggregate severity', () => {
  const panel = new CountryDeepDivePanel();
  const body = document.createElement('div');
  Reflect.set(panel, 'signalsBody', body);
  const signals = countrySignalsFromMilitary({ militaryFlights: 3, militaryFlightsInCountry: 1, militaryVessels: null, militaryVesselsInCountry: null });
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
  panel.updateSignals(countrySignalsFromMilitary({ militaryFlights: null, militaryFlightsInCountry: null, militaryVessels: null, militaryVesselsInCountry: null }));
  expect(body.textContent).toContain('Military Air unavailable');
  panel.updateSignals(countrySignalsFromMilitary({ militaryFlights: 0, militaryFlightsInCountry: 0, militaryVessels: 2, militaryVesselsInCountry: 1 }));
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
  panel.updateSignals(countrySignalsFromMilitary());
  panel.updateSignalDetails({ critical: 1, high: 0, medium: 0, low: 0, recentHigh: [{ type: 'MILITARY', severity: 'critical', description: 'Observed evidence', timestamp: new Date() }] });
  const breakdown = body.querySelector('.cdp-signal-breakdown')?.textContent;
  const recent = body.querySelector('.cdp-signal-recent');
  const before = recent?.textContent;
  expect(before).toContain('Observed evidence');
  panel.updateScore(null, countrySignalsFromMilitary({ militaryFlights: 2, militaryFlightsInCountry: 1, militaryVessels: 0, militaryVesselsInCountry: 0 }));
  expect(recent?.textContent).toBe(before);
  expect(body.querySelector('.cdp-signal-breakdown')?.textContent).toBe(breakdown);
  expect(body.textContent).toContain('2 Military Air');
  panel.updateSignals(countrySignalsFromMilitary());
  expect(body.textContent).not.toContain('Observed evidence');
  expect(body.textContent).toContain('Aggregate severity');
  panel.hide();
});

it('retains prior country counts only for unavailable authorized sources and replaces them on recovery', () => {
  const prior = countrySignalsFromMilitary({ militaryFlights: 3, militaryFlightsInCountry: 2, militaryVessels: 2, militaryVesselsInCountry: 1 });
  const next = countrySignalsFromMilitary({ militaryFlights: 1, militaryFlightsInCountry: 0, militaryVessels: null, militaryVesselsInCountry: null });
  const recovered = recoverCountrySignals(next, prior, []);
  expect(recovered.signals.militaryFlights).toBe(1);
  expect(recovered.signals.militaryVessels).toBe(2);
  expect(recovered.notes.join(' ')).toContain('previously loaded');
  expect(recoverCountrySignals(next, prior, ['militaryVessels', 'militaryVesselsInCountry']).signals.militaryVessels).toBeNull();
  expect(recoverCountrySignals(next, null, []).signals.militaryVessels).toBeNull();
  const zero = countrySignalsFromMilitary({ militaryFlights: 0, militaryFlightsInCountry: 0, militaryVessels: 0, militaryVesselsInCountry: 0 });
  expect(recoverCountrySignals(zero, prior, []).signals).toEqual(zero);
  expect(recoverCountrySignals(zero, prior, []).notes).toEqual([]);
});
