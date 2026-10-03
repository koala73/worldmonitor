import { beforeAll, expect, it } from 'vitest';
import { CountryDeepDivePanel } from '@/components/CountryDeepDivePanel';
import { countrySignalsFromMilitary } from '@/services/country-signals';
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
  const recent = body.querySelector('.cdp-signal-recent');
  const before = recent?.textContent;
  expect(before).toContain('Observed evidence');
  panel.updateScore(null, countrySignalsFromMilitary({ militaryFlights: 2, militaryFlightsInCountry: 1, militaryVessels: 0, militaryVesselsInCountry: 0 }));
  expect(recent?.textContent).toBe(before);
  expect(body.textContent).toContain('2 Military Air');
  panel.hide();
});
