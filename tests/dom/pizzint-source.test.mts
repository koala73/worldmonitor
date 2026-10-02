import { expect, it, vi } from 'vitest';
import type { PizzIntStatus } from '@/types';

vi.mock('@/services/i18n', () => ({ t: (key: string) => key }));

import { PizzIntIndicator } from '@/components/PizzIntIndicator';

it('switches source attribution during fallback and restores it on recovery', () => {
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
  indicator.updateStatus(status);
  expect(indicator.getElement().querySelector('.pizzint-score')).toBeNull();
  expect(indicator.getElement().querySelector('.pizzint-source')!.textContent).toContain('components.pizzint.indexSource');
  expect(source().textContent).toBe('BestTime');
  expect(source().href).toBe('https://besttime.app/');
  indicator.updateStatus({ ...status, locations: status.locations.map(loc => ({ ...loc, data_source: 'google' })) });
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

it('shows World Monitor tensions and missing-data states when pizza is unavailable', () => {
  const indicator = new PizzIntIndicator();
  indicator.updateStatus({ defconLevel: 5, defconLabel: '', aggregateActivity: 0,
    activeSpikes: 0, locationsMonitored: 0, locationsOpen: 0, lastUpdate: new Date(),
    dataFreshness: 'stale', locations: [] });
  indicator.updateTensions([{ id: 'usa_russia', countries: ['US', 'RU'], label: 'US–Russia',
    score: 50, trend: 'stable', changePercent: 0, region: 'global' }]);
  const element = indicator.getElement();
  expect(element.querySelector('.pizzint-defcon')?.textContent).toBe('--');
  expect(element.querySelectorAll('.pizzint-tension-row')).toHaveLength(4);
  expect(element.querySelector('.pizzint-tension-value')?.textContent).toBe('50.0');
  expect(element.textContent).toContain('components.pizzint.tensionsTitle');
  expect(element.textContent).toContain('components.pizzint.insufficientData');
  expect(element.querySelector('.pizzint-source')?.textContent).toContain('components.pizzint.indexSource');
  expect(element.querySelector('.pizzint-source a')?.textContent).toBe('PizzINT');
  expect(element.querySelector('.pizzint-tensions-source')).toBeNull();
  expect(element.textContent).not.toContain('components.pizzint.tensionsSource');
});
