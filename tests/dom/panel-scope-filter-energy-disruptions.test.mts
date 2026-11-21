/**
 * Dashboard focus (#10453), Energy Disruptions Log: each event carries the
 * ISO codes of the countries it touches (`countries[]`). Under a focus the
 * panel lists chosen-country events, then neighbour events marked, counts the
 * rest, and counts events from before the field existed (empty list) apart.
 * The panel's own type and "ongoing only" filters work within the focus.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { initTestI18n } from './helpers/i18n.mts';
import type { EnergyDisruptionEntry, ListEnergyDisruptionsResponse } from '@/generated/client/worldmonitor/supply_chain/v1/service_client';
import type { ResolvedScope } from '@/services/tab-focus';
import { resolveScope } from '../../shared/tab-scope-resolve';

const rpc = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock('@/services/generated-rpc-clients', () => ({
  SupplyChainServiceClient: class {
    listEnergyDisruptions = rpc.list;
  },
}));

import { EnergyDisruptionsPanel } from '@/components/EnergyDisruptionsPanel';

beforeAll(async () => {
  await initTestI18n();
});

const scopeOf = (countries: string[], neighbours = true): ResolvedScope => {
  const scope = { countries, neighbours };
  return { scope, ...resolveScope(scope) };
};

function event(id: string, countries: string[], startAt: string, extra: Partial<EnergyDisruptionEntry> = {}): EnergyDisruptionEntry {
  return {
    id,
    assetId: `asset-${id}`,
    assetType: 'pipeline',
    eventType: 'sabotage',
    startAt,
    endAt: '',
    capacityOfflineBcmYr: 0,
    capacityOfflineMbd: 0,
    causeChain: [],
    shortDescription: `desc ${id}`,
    sources: [],
    classifierVersion: 'v1',
    classifierConfidence: 1,
    lastEvidenceUpdate: startAt,
    countries,
    ...extra,
  };
}

// Newest first is the panel's own order; the focus must keep chosen before neighbours.
const LAOS = event('laos', ['LA'], '2026-10-05');
const THAI = event('thai', ['TH'], '2026-09-01', { eventType: 'weather', endAt: '2026-09-10' });
const MULTI = event('multi', ['US', 'VN'], '2026-08-01');
const US = event('us', ['US'], '2026-10-01');
const OLD = event('old', [], '2026-07-01');
const EVENTS = [LAOS, THAI, MULTI, US, OLD];

function response(events: EnergyDisruptionEntry[]): ListEnergyDisruptionsResponse {
  return { events, upstreamUnavailable: false, fetchedAt: '2026-11-10T00:00:00Z', classifierVersion: 'v1' } as ListEnergyDisruptionsResponse;
}

let panel: EnergyDisruptionsPanel;

beforeEach(() => {
  vi.useFakeTimers();
  rpc.list.mockReset();
  rpc.list.mockResolvedValue(response(EVENTS));
  panel = new EnergyDisruptionsPanel();
  document.body.appendChild(panel.getElement());
});

afterEach(() => {
  panel.destroy();
  vi.useRealTimers();
  document.body.innerHTML = '';
});

const settle = () => vi.advanceTimersByTimeAsync(300);
const el = () => panel.getElement();
const ids = () => [...el().querySelectorAll<HTMLElement>('tr.ed-row')].map((n) => n.dataset.eventId);
const strip = () => el().querySelector<HTMLElement>('.panel-scope-strip');
const stripButton = (action: string) => strip()?.querySelector<HTMLButtonElement>(`button[data-scope-action="${action}"]`);
const rowFor = (id: string) => el().querySelector<HTMLElement>(`tr.ed-row[data-event-id="${id}"]`);
const summary = () => el().querySelector('.ed-summary')?.textContent;

async function load(): Promise<void> {
  await panel.fetchData();
  await settle();
}

describe('EnergyDisruptionsPanel under a focus', () => {
  it('lists chosen-country events, then the neighbour marked, and counts hidden and no-country events', async () => {
    await load();
    panel.applyScope(scopeOf(['TH', 'VN']));
    await settle();

    expect(ids()).toEqual(['thai', 'multi', 'laos']);
    expect(rowFor('laos')?.querySelector('.panel-scope-tag-neighbour')?.textContent).toBe('Neighbour: Laos');
    expect(rowFor('thai')?.querySelector('.panel-scope-tag')).toBeNull();
    expect(strip()?.hidden).toBe(false);
    expect(strip()?.textContent).toContain('1 hidden by focus');
    expect(strip()?.textContent).toContain('1 item with no country');
    expect(summary()).toBe('3 events · 2 ongoing');
  });

  it('shows the no-country event on request and everything on Show all, then filters again on Apply focus', async () => {
    await load();
    panel.applyScope(scopeOf(['TH', 'VN']));
    await settle();

    stripButton('show-unattributed')!.click();
    await settle();
    expect(ids()).toEqual(['thai', 'multi', 'laos', 'old']);
    expect(rowFor('old')?.querySelector('.panel-scope-tag-none')?.textContent).toBe('No country');

    stripButton('show-all')!.click();
    await settle();
    expect(ids()).toEqual(['laos', 'us', 'thai', 'multi', 'old']);
    expect(summary()).toBe('5 events · 4 ongoing');

    stripButton('apply')!.click();
    await settle();
    // "Show items with no country" stays on for this focus.
    expect(ids()).toEqual(['thai', 'multi', 'laos', 'old']);
  });

  it('runs the type and ongoing filters within the focus', async () => {
    await load();
    panel.applyScope(scopeOf(['TH', 'VN']));
    await settle();
    el().querySelector<HTMLElement>('[data-toggle-ongoing]')!.click();
    await settle();
    expect(ids()).toEqual(['multi', 'laos']);
    expect(summary()).toBe('2 shown · 3 total · 2 ongoing');
    el().querySelector<HTMLElement>('[data-toggle-ongoing]')!.click();
    el().querySelector<HTMLElement>('[data-filter-type="weather"]')!.click();
    await settle();
    expect(ids()).toEqual(['thai']);
  });

  it('applies a focus set before the data arrives, and clears back to the full list', async () => {
    panel.applyScope(scopeOf(['TH'], false));
    await settle();
    expect(strip()?.hidden).toBe(true);
    await load();
    expect(ids()).toEqual(['thai']);
    panel.applyScope(null);
    await settle();
    expect(ids()).toEqual(['laos', 'us', 'thai', 'multi', 'old']);
    expect(strip()?.hidden).toBe(true);
    expect(summary()).toBe('5 events · 4 ongoing');
    expect(rpc.list).toHaveBeenCalledTimes(1);
  });

  it('an empty focused result is distinct from the panel empty and error states, with the counts reachable', async () => {
    await load();
    panel.applyScope(scopeOf(['NZ'], false));
    await settle();
    expect(el().querySelector('.panel-scope-empty')?.textContent).toContain('No energy disruptions for these countries');
    expect(el().querySelector('.ed-empty')).toBeNull();
    expect(el().querySelector('.panel-error-state')).toBeNull();
    expect(strip()?.textContent).toContain('4 hidden by focus');
    stripButton('show-all')!.click();
    await settle();
    expect(ids()).toHaveLength(5);
  });

  it('hides the strip while loading and after a load failure, and a focus change keeps the failure', async () => {
    await load();
    panel.applyScope(scopeOf(['TH']));
    await settle();
    expect(strip()?.hidden).toBe(false);

    panel.showLoading();
    expect(strip()?.hidden).toBe(true);

    rpc.list.mockResolvedValueOnce({ events: [], upstreamUnavailable: true });
    await panel.fetchData();
    await settle();
    expect(strip()?.hidden).toBe(true);
    expect(el().querySelector('.panel-error-state')?.textContent).toContain('Energy disruptions log unavailable');

    panel.applyScope(scopeOf(['VN']));
    await settle();
    expect(el().querySelector('.panel-error-state')?.textContent).toContain('Energy disruptions log unavailable');
    expect(strip()?.hidden).toBe(true);
    expect(ids()).toEqual([]);
  });

  it('keeps the panel empty state and no strip when the log has no events', async () => {
    rpc.list.mockResolvedValue(response([]));
    panel.applyScope(scopeOf(['TH']));
    await load();
    expect(el().querySelector('.ed-empty')).not.toBeNull();
    expect(el().querySelector('.panel-scope-empty')).toBeNull();
    expect(strip()?.hidden).toBe(true);
  });

  it('is unchanged when unfocused', async () => {
    await load();
    expect(ids()).toEqual(['laos', 'us', 'thai', 'multi', 'old']);
    expect(strip()?.hidden).toBe(true);
    expect(el().querySelector('.panel-scope-tag')).toBeNull();
    expect(summary()).toBe('5 events · 4 ongoing');
  });
});
