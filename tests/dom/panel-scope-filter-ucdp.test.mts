/**
 * Dashboard focus (#10453), unrest and conflict: UCDP events carry a country
 * name ("Myanmar (Burma)"), resolved to its ISO code. The bootstrap payload is
 * a 150-row projection, so under a focus the panel loads the full set ONCE and
 * filters it in memory; later focus changes do not fetch again.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { initTestI18n } from './helpers/i18n.mts';
import { UcdpEventsPanel, type UcdpFullSetLoader } from '@/components/UcdpEventsPanel';
import type { UcdpTabAggregate } from '@/services/conflict';
import type { ResolvedScope } from '@/services/tab-focus';
import type { UcdpGeoEvent } from '@/types';
import { resolveScope } from '../../shared/tab-scope-resolve';

beforeAll(async () => {
  await initTestI18n();
});

const scopeOf = (countries: string[], neighbours = true): ResolvedScope => {
  const scope = { countries, neighbours };
  return { scope, ...resolveScope(scope) };
};
const FOCUS = scopeOf(['TH', 'VN', 'ID']);

function event(id: string, country: string, deaths = 1): UcdpGeoEvent {
  return {
    id,
    date_start: '2026-10-01',
    date_end: '2026-10-01',
    latitude: 10,
    longitude: 100,
    country,
    side_a: `Side A ${id}`,
    side_b: `Side B ${id}`,
    deaths_best: deaths,
    deaths_low: deaths,
    deaths_high: deaths,
    type_of_violence: 'state-based',
    source_original: 'test',
  };
}

const US = event('us', 'United States of America', 5);
const LAOS = event('la', 'Laos', 2);
const THAILAND = event('th', 'Thailand', 3);
const NONE = event('none', '', 7);
const MYANMAR = event('mm', 'Myanmar (Burma)', 4);
const EVENTS = [US, LAOS, THAILAND, NONE];

const AGGREGATES: Record<string, UcdpTabAggregate> = {
  UCDP_VIOLENCE_TYPE_STATE_BASED: { count: 1200, totalDeaths: 9000 },
} as Record<string, UcdpTabAggregate>;

let panel: UcdpEventsPanel;
let loadFullSet: ReturnType<typeof vi.fn<UcdpFullSetLoader>>;

beforeEach(() => {
  vi.useFakeTimers();
  loadFullSet = vi.fn<UcdpFullSetLoader>(async () => [...EVENTS, MYANMAR]);
  panel = new UcdpEventsPanel({ loadFullSet });
  document.body.appendChild(panel.getElement());
});

afterEach(() => {
  panel.destroy();
  vi.useRealTimers();
  document.body.innerHTML = '';
});

const settle = () => vi.advanceTimersByTimeAsync(300);
const el = () => panel.getElement();
const ids = () => [...el().querySelectorAll<HTMLElement>('.ucdp-row .ucdp-actors')].map((n) => n.textContent?.replace('Side A ', '').replace(/ vs .*/, ''));
const strip = () => el().querySelector<HTMLElement>('.panel-scope-strip');
const stripButton = (action: string) => strip()?.querySelector<HTMLButtonElement>(`button[data-scope-action="${action}"]`);
const rowFor = (id: string) => [...el().querySelectorAll('.ucdp-row')].find((n) => n.querySelector('.ucdp-actors')?.textContent?.startsWith(`Side A ${id} `));

describe('UcdpEventsPanel under a focus', () => {
  it('filters the full set: chosen first, neighbours marked, hidden and no-country counted', async () => {
    panel.setEvents(EVENTS);
    panel.applyScope(FOCUS);
    await settle();

    expect(ids()).toEqual(['th', 'la']);
    expect(rowFor('la')?.querySelector('.panel-scope-tag-neighbour')?.textContent).toBe('Neighbour: Laos');
    expect(strip()?.textContent).toContain('1 hidden by focus');
    expect(strip()?.textContent).toContain('1 item with no country');
    // Tab count and deaths describe the focused events, not the world.
    expect(el().querySelector('.panel-tab.active .ucdp-tab-count')?.textContent).toBe('2');
    expect(el().querySelector('.ucdp-total-deaths')?.textContent).toContain('5');
    expect(loadFullSet).not.toHaveBeenCalled();
  });

  it('upgrades each bootstrap projection refresh and reuses the full set across focus changes', async () => {
    panel.setEvents(EVENTS, AGGREGATES);
    await settle();
    expect(loadFullSet).not.toHaveBeenCalled();

    panel.applyScope(scopeOf(['MM']));
    await settle();
    expect(loadFullSet).toHaveBeenCalledTimes(1);
    expect(ids()).toEqual(['mm', 'la', 'th']); // Myanmar came only with the full set; LA and TH are neighbours, in source order.

    panel.applyScope(FOCUS);
    await settle();
    panel.applyScope(null);
    await settle();
    expect(el().querySelector('.panel-tab.active .ucdp-tab-count')?.textContent).toBe('1200');
    panel.applyScope(FOCUS);
    await settle();
    // Filtered from the full set held in memory: Myanmar is Thailand's neighbour.
    expect(ids()).toEqual(['th', 'la', 'mm']);
    // A projection refresh invalidates the previous full set and reloads it.
    loadFullSet.mockResolvedValueOnce([event('fresh', 'Thailand')]);
    panel.setEvents(EVENTS, AGGREGATES);
    await settle();
    expect(ids()).toEqual(['fresh']);
    expect(loadFullSet).toHaveBeenCalledTimes(2);
  });

  it('shows every focused event beyond the unfocused 50-row cap', async () => {
    const rows = Array.from({ length: 65 }, (_, i) => event(`th-${i}`, 'Thailand'));
    panel.setEvents(rows);
    await settle();
    expect(ids()).toHaveLength(50);
    panel.applyScope(FOCUS);
    await settle();
    expect(ids()).toHaveLength(65);
    expect(el().querySelector('.panel-more')).toBeNull();
  });

  it('ignores an upgrade superseded by a newer projection, including while the replacement fails', async () => {
    let release!: (events: UcdpGeoEvent[]) => void;
    loadFullSet.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    panel.setEvents(EVENTS, AGGREGATES);
    panel.applyScope(FOCUS);
    await settle();
    loadFullSet.mockResolvedValueOnce(null);
    panel.setEvents([event('fresh', 'Thailand')], AGGREGATES);
    await settle();
    release([...EVENTS, MYANMAR]);
    await settle();
    expect(ids()).toEqual(['fresh']);
    expect(strip()?.textContent).toContain('The full list did not load');
    expect(loadFullSet).toHaveBeenCalledTimes(2);
  });

  it('says the result is partial when the full set fails to load', async () => {
    loadFullSet.mockResolvedValueOnce(null);
    panel.setEvents([US, NONE], AGGREGATES);
    panel.applyScope(FOCUS);
    await settle();
    expect(el().querySelector('.panel-scope-empty')?.textContent).toContain('The full list did not load');
  });

  it('says the list is partial even when rows are shown, and retries on the next focus change', async () => {
    loadFullSet.mockResolvedValueOnce(null);
    panel.setEvents(EVENTS, AGGREGATES);
    panel.applyScope(FOCUS);
    await settle();
    expect(ids()).toEqual(['th', 'la']);
    expect(strip()?.textContent).toContain('The full list did not load');
    // The warning sits beside the reveal controls, it does not replace them.
    expect(stripButton('show-all')).toBeTruthy();
    expect(stripButton('show-unattributed')).toBeTruthy();

    panel.applyScope(scopeOf(['MM']));
    await settle();
    expect(loadFullSet).toHaveBeenCalledTimes(2);
    expect(strip()?.textContent ?? '').not.toContain('The full list did not load');
    expect(ids()).toEqual(['mm', 'la', 'th']);
  });

  it('warns that the list is partial while the full set loads, even with rows shown', async () => {
    let release: (events: UcdpGeoEvent[]) => void = () => {};
    loadFullSet.mockImplementationOnce(() => new Promise<UcdpGeoEvent[]>((resolve) => { release = resolve; }));
    panel.setEvents(EVENTS, AGGREGATES);
    panel.applyScope(FOCUS);
    await settle();
    expect(ids()).toEqual(['th', 'la']);
    expect(strip()?.textContent).toContain('while the full list loads');
    expect(stripButton('show-all')).toBeTruthy();
    release([...EVENTS, MYANMAR]);
    await settle();
    expect(strip()?.textContent ?? '').not.toContain('full list');
    expect(ids()).toEqual(['th', 'la', 'mm']);
  });

  it('ignores a full-set result that a newer full set superseded, and does not paint over a failure', async () => {
    let release: (events: UcdpGeoEvent[]) => void = () => {};
    loadFullSet.mockImplementationOnce(() => new Promise<UcdpGeoEvent[]>((resolve) => { release = resolve; }));
    panel.setEvents(EVENTS, AGGREGATES);
    panel.applyScope(FOCUS);
    await settle();
    // A newer full set arrives (no aggregates) while the old request is pending.
    const NEWER = event('newer', 'Thailand', 9);
    panel.setEvents([NEWER]);
    await settle();
    release([...EVENTS, MYANMAR]); // stale: must not overwrite the newer set
    await settle();
    expect(ids()).toEqual(['newer']);

    // Defer BEFORE the request starts, so the completion really arrives after the failure.
    loadFullSet.mockClear();
    loadFullSet.mockImplementationOnce(() => new Promise<UcdpGeoEvent[]>((resolve) => { release = resolve; }));
    panel.setEvents(EVENTS, AGGREGATES);
    await settle();
    expect(loadFullSet).toHaveBeenCalledTimes(1);
    panel.showError('UCDP failed');
    release([...EVENTS, MYANMAR]);
    await settle();
    expect(el().querySelector('.panel-error-state')?.textContent).toContain('UCDP failed');
    expect(el().querySelector('.ucdp-row')).toBeNull();
  });

  it('keeps keyboard focus on the control that replaced the one activated', async () => {
    panel.setEvents(EVENTS, AGGREGATES);
    panel.applyScope(FOCUS);
    await settle();
    expect(stripButton('show-all')).toBeTruthy();
    stripButton('show-unattributed')?.click();
    await settle();
    expect(document.activeElement).toBe(stripButton('hide-unattributed'));
  });

  it('"Show all" restores the whole list; clearing the focus hides the strip', async () => {
    panel.setEvents(EVENTS);
    panel.applyScope(FOCUS);
    await settle();
    stripButton('show-all')?.click();
    await settle();
    expect(ids()).toEqual(['us', 'la', 'th', 'none']);
    stripButton('apply')?.click();
    await settle();
    expect(ids()).toEqual(['th', 'la']);
    panel.applyScope(null);
    await settle();
    expect(ids()).toEqual(['us', 'la', 'th', 'none']);
    expect(strip()?.hidden).toBe(true);
  });

  it('an empty focused result is distinct from a load failure', async () => {
    panel.setEvents([US, NONE]);
    panel.applyScope(FOCUS);
    await settle();
    expect(el().querySelector('.panel-scope-empty')?.textContent).toContain('No UCDP conflict events for these countries');
    expect(strip()?.textContent).toContain('1 hidden by focus');

    panel.showError('UCDP failed');
    expect(el().querySelector('.panel-scope-empty')).toBeNull();
    expect(el().querySelector('.panel-error-state')).not.toBeNull();
    expect(strip()?.hidden).toBe(true);
  });
});
