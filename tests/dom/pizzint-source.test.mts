import { expect, it, vi } from 'vitest';
import type { PizzIntStatus } from '@/types';

vi.mock('@/services/i18n', () => ({ t: (key: string) => key }));

import { PizzIntIndicator } from '@/components/PizzIntIndicator';

it('names no venue source during the BestTime fallback and credits PizzINT on recovery', () => {
  const indicator = new PizzIntIndicator();
  const status: PizzIntStatus = {
    defconLevel: 3, defconLabel: 'Elevated Activity', aggregateActivity: 60,
    activeSpikes: 0, locationsMonitored: 1, locationsOpen: 1,
    lastUpdate: new Date(), dataFreshness: 'fresh',
    locations: [{
      place_id: 'venue', name: 'Pizza', address: '', current_popularity: 60,
      percentage_of_usual: null, is_spike: false, spike_magnitude: 0,
      data_source: 'besttime', recorded_at: new Date().toISOString(),
      data_freshness: 'fresh', is_closed_now: false,
    }],
  };
  const source = () => indicator.getElement().querySelector<HTMLAnchorElement>('.pizzint-source a')!;
  const venue = () => indicator.getElement().querySelector<HTMLElement>('.pizzint-venue-source')!;
  expect(venue().hidden, 'no venue credit before any status arrives').toBe(true);
  indicator.updateStatus(status);
  expect(indicator.getElement().querySelector('.pizzint-score')).toBeNull();
  expect(indicator.getElement().querySelector('.pizzint-source')!.textContent).toContain('components.pizzint.indexSource');
  expect(venue().hidden).toBe(true);
  expect(indicator.getElement().innerHTML).not.toContain('BestTime');
  expect(indicator.getElement().innerHTML).not.toContain('besttime.app');
  indicator.updateStatus({ ...status, locations: status.locations.map(loc => ({ ...loc, data_source: 'google' })) });
  expect(venue().hidden).toBe(false);
  expect(venue().textContent).toContain('components.pizzint.venueSource');
  expect(source().textContent).toBe('PizzINT');
  expect(source().href).toBe('https://www.pizzint.watch/');
  const label = () => indicator.getElement().querySelector('.pizzint-location-status')!.textContent;
  status.locations[0] = { ...status.locations[0]!, current_popularity: 100, percentage_of_usual: 100 };
  indicator.updateStatus(status);
  expect(label()).toBe('components.pizzint.statusNormal');
  status.locations[0] = { ...status.locations[0]!, current_popularity: 70, percentage_of_usual: 156, is_spike: true };
  indicator.updateStatus(status);
  expect(label()).toBe('components.pizzint.statusSpike +56%');
  status.locations[0] = { ...status.locations[0]!, current_popularity: 0, percentage_of_usual: null, is_spike: false, no_live_signal: true };
  indicator.updateStatus(status);
  expect(label()).toBe('components.pizzint.statusNoData');
  status.locations[0] = { ...status.locations[0]!, percentage_of_usual: 0, no_live_signal: false };
  indicator.updateStatus(status);
  expect(label()).toBe('−100% components.pizzint.vsUsual');
});

it('shows a stale reading without its level colour, so an hours-old level never reads as current', () => {
  const indicator = new PizzIntIndicator();
  const status: PizzIntStatus = {
    defconLevel: 3, defconLabel: 'Elevated Activity', aggregateActivity: 60,
    activeSpikes: 1, locationsMonitored: 1, locationsOpen: 1,
    lastUpdate: new Date(Date.now() - 5 * 60 * 60_000), dataFreshness: 'fresh',
    locations: [{
      place_id: 'venue', name: 'Pizza', address: '', current_popularity: 60,
      percentage_of_usual: 200, is_spike: true, spike_magnitude: 30,
      data_source: 'google', recorded_at: new Date().toISOString(),
      data_freshness: 'fresh', is_closed_now: false,
    }],
  };
  const defcon = () => indicator.getElement().querySelector<HTMLElement>('.pizzint-defcon')!;
  const label = () => indicator.getElement().querySelector<HTMLElement>('.pizzint-defcon-label')!;
  indicator.updateStatus(status);
  expect(defcon().style.background).not.toBe('');
  expect(label().style.color).not.toBe('');
  indicator.updateStatus({ ...status, dataFreshness: 'stale' });
  expect(defcon().textContent, 'the level stays readable').toBe('components.pizzint.defcon');
  expect(defcon().style.background).toBe('');
  expect(defcon().style.color).toBe('');
  expect(label().style.color).toBe('');
  expect(indicator.getElement().querySelector('.pizzint-updated')!.textContent).toBe('components.pizzint.updated');
});

it('shows World Monitor tensions and missing-data states when pizza is unavailable', () => {
  const indicator = new PizzIntIndicator();
  indicator.updateStatus({ defconLevel: 5, defconLabel: '', aggregateActivity: 0,
    activeSpikes: 0, locationsMonitored: 0, locationsOpen: 0, lastUpdate: new Date(),
    dataFreshness: 'stale', locations: [] });
  indicator.updateTensions([{ id: 'usa_russia', countries: ['US', 'RU'], label: 'US–Russia',
    score: 50, trend: 'stable', changePercent: 0, region: 'global' }]);
  const element = indicator.getElement();
  expect(element.querySelector('.pizzint-defcon')?.textContent).toBe('--');
  expect([...element.querySelectorAll('.pizzint-tension-label')].map(label => label.textContent)).toEqual([
    'US–Russia', 'Russia–Ukraine', 'US–China', 'China–Taiwan', 'US–Iran', 'Israel–Iran', 'Iran–GCC', 'Saudi Arabia–Yemen',
  ]);
  expect(element.querySelector('.pizzint-tension-value')?.textContent).toBe('50.0');
  expect(element.textContent).toContain('components.pizzint.tensionsTitle');
  expect(element.textContent).toContain('components.pizzint.insufficientData');
  expect(element.querySelector('.pizzint-source')?.textContent).toContain('components.pizzint.indexSource');
  expect(element.querySelector<HTMLElement>('.pizzint-venue-source')?.hidden, 'no venues, no venue credit').toBe(true);
  expect(element.querySelector('.pizzint-source a')?.textContent).toBe('PizzINT');
  expect(element.querySelector('.pizzint-tensions-source')).toBeNull();
  expect(element.textContent).not.toContain('components.pizzint.tensionsSource');
});
