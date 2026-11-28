/**
 * Dashboard focus (#10453), radiation watch: each station names its country
 * ("United States", "Japan"). Under a focus the panel lists the chosen
 * countries, then neighbours marked, counts the rest, and its summary cards
 * count the stations shown.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { initTestI18n } from './helpers/i18n.mts';
import { RadiationWatchPanel } from '@/components/RadiationWatchPanel';
import type { RadiationObservation, RadiationWatchResult } from '@/services/radiation';
import type { ResolvedScope } from '@/services/tab-focus';
import { resolveScope } from '../../shared/tab-scope-resolve';

beforeAll(async () => {
  await initTestI18n();
});

const scopeOf = (countries: string[], neighbours = true): ResolvedScope => {
  const scope = { countries, neighbours };
  return { scope, ...resolveScope(scope) };
};
// US neighbours include CA and MX.
const FOCUS = scopeOf(['US']);

function station(id: string, location: string, country: string, severity: RadiationObservation['severity']): RadiationObservation {
  return {
    id,
    source: 'Safecast',
    contributingSources: ['Safecast'],
    location,
    country,
    lat: 1,
    lon: 2,
    value: 100,
    unit: 'nSv/h',
    observedAt: new Date('2026-11-10T00:00:00.000Z'),
    freshness: 'recent',
    baselineValue: 90,
    delta: 10,
    zScore: 1,
    severity,
    confidence: 'medium',
    corroborated: false,
    conflictingSources: false,
    convertedFromCpm: false,
    sourceCount: 1,
  };
}

const TOKYO = station('tokyo', 'Tokyo', 'Japan', 'spike');
const VANCOUVER = station('van', 'Vancouver', 'Canada', 'elevated');
const SEATTLE = station('sea', 'Seattle', 'United States', 'normal');
const UNKNOWN = station('unk', 'Unnamed station', '', 'elevated');
const STATIONS = [TOKYO, VANCOUVER, SEATTLE, UNKNOWN];

function result(observations: RadiationObservation[]): RadiationWatchResult {
  return {
    fetchedAt: new Date('2026-11-10T00:00:00.000Z'),
    observations,
    coverage: { epa: 0, safecast: observations.length },
    // The server's summary over the whole feed.
    summary: {
      anomalyCount: 3,
      elevatedCount: 2,
      spikeCount: 1,
      corroboratedCount: 0,
      lowConfidenceCount: 0,
      conflictingCount: 0,
      convertedFromCpmCount: 0,
    },
  };
}

let panel: RadiationWatchPanel;

beforeEach(() => {
  vi.useFakeTimers();
  panel = new RadiationWatchPanel();
  document.body.appendChild(panel.getElement());
});

afterEach(() => {
  panel.destroy();
  vi.useRealTimers();
  document.body.innerHTML = '';
});

const settle = () => vi.advanceTimersByTimeAsync(300);
const el = () => panel.getElement();
const stations = () => [...el().querySelectorAll('.radiation-row .radiation-location-name')].map((n) => n.textContent);
const strip = () => el().querySelector<HTMLElement>('.panel-scope-strip');
const stripButton = (action: string) => strip()?.querySelector<HTMLButtonElement>(`button[data-scope-action="${action}"]`);
const rowFor = (name: string) => [...el().querySelectorAll('.radiation-row')].find((n) => n.querySelector('.radiation-location-name')?.textContent === name);
const count = () => el().querySelector('.panel-count')?.textContent;
const summary = () => [...el().querySelectorAll('.radiation-summary-value')].map((n) => n.textContent);

describe('RadiationWatchPanel under a focus', () => {
  it('lists the chosen country then the marked neighbour, counts hidden and no-country stations, and scopes the summary', async () => {
    panel.setData(result(STATIONS));
    panel.applyScope(FOCUS);
    await settle();

    expect(stations()).toEqual(['Seattle', 'Vancouver']);
    expect(rowFor('Vancouver')?.querySelector('.panel-scope-tag-neighbour')?.textContent).toBe('Neighbour: Canada');
    expect(rowFor('Seattle')?.querySelector('.panel-scope-tag')).toBeNull();
    expect(strip()?.textContent).toContain('1 hidden by focus');
    expect(strip()?.textContent).toContain('1 item with no country');
    expect(count()).toBe('2');
    // anomalies, elevated, confirmed, low confidence, conflicts, spikes
    expect(summary()).toEqual(['1', '1', '0', '0', '0', '0']);
  });

  it('shows the no-country station on request, and Show all restores the server summary', async () => {
    panel.setData(result(STATIONS));
    panel.applyScope(FOCUS);
    await settle();
    stripButton('show-unattributed')!.click();
    await settle();
    expect(stations()).toEqual(['Seattle', 'Vancouver', 'Unnamed station']);
    expect(rowFor('Unnamed station')?.querySelector('.panel-scope-tag-none')?.textContent).toBe('No country');

    stripButton('show-all')!.click();
    await settle();
    expect(stations()).toEqual(['Tokyo', 'Vancouver', 'Seattle', 'Unnamed station']);
    expect(summary()).toEqual(['3', '2', '0', '0', '0', '1']);
    expect(count()).toBe('4');
  });

  it('applies a focus set before the data arrives, and clears back to the full list', async () => {
    panel.applyScope(scopeOf(['JP'], false));
    expect(strip()?.hidden).toBe(true);
    expect(el().querySelector('.panel-loading-text, .panel-loading-radar')).toBeTruthy();
    panel.setData(result(STATIONS));
    await settle();
    expect(stations()).toEqual(['Tokyo']);
    panel.applyScope(null);
    await settle();
    expect(stations()).toEqual(['Tokyo', 'Vancouver', 'Seattle', 'Unnamed station']);
    expect(strip()?.hidden).toBe(true);
  });

  it('says nothing matched the focus, distinct from the panel empty state, and keeps the counts reachable', async () => {
    panel.setData(result(STATIONS));
    panel.applyScope(scopeOf(['NZ'], false));
    await settle();
    expect(el().querySelector('.panel-scope-empty')?.textContent).toContain('No radiation readings for these countries');
    expect(el().querySelector('.panel-empty')).toBeNull();
    expect(strip()?.textContent).toContain('3 hidden by focus');
    stripButton('show-all')!.click();
    await settle();
    expect(stations()).toHaveLength(4);
  });

  it('with no stations at all shows the panel empty state and no strip', async () => {
    panel.setData(result([]));
    panel.applyScope(FOCUS);
    await settle();
    expect(el().querySelector('.panel-empty')).not.toBeNull();
    expect(strip()?.hidden).toBe(true);
  });

  it('hides the strip after a load failure, and a focus change keeps the failure', async () => {
    panel.setData(result(STATIONS));
    panel.applyScope(FOCUS);
    await settle();
    panel.showError('Radiation failed');
    expect(strip()?.hidden).toBe(true);
    panel.applyScope(null);
    panel.applyScope(scopeOf(['JP']));
    await settle();
    expect(el().querySelector('.panel-error-state')?.textContent).toContain('Radiation failed');
    expect(strip()?.hidden).toBe(true);
    panel.setData(result(STATIONS));
    await settle();
    expect(stations()).toEqual(['Tokyo']);
    expect(strip()?.hidden).toBe(false);
  });

  it('a focus change during a refresh keeps the loading state', async () => {
    panel.setData(result(STATIONS));
    await settle();
    panel.showLoading('Refreshing');
    expect(strip()?.hidden).toBe(true);
    panel.applyScope(FOCUS);
    await settle();
    expect(el().querySelector('.panel-loading-text, .panel-loading-radar')).toBeTruthy();
    expect(stations()).toEqual([]);
  });

  it('is unchanged without a focus', async () => {
    panel.setData(result(STATIONS));
    await settle();
    expect(stations()).toEqual(['Tokyo', 'Vancouver', 'Seattle', 'Unnamed station']);
    expect(summary()).toEqual(['3', '2', '0', '0', '0', '1']);
    expect(strip()?.hidden).toBe(true);
    expect(el().querySelector('.panel-scope-tag')).toBeNull();
  });
});
