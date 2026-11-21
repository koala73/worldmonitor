/**
 * Dashboard focus (#10453), fuel shortages: each entry carries the ISO code of
 * its country. Under a focus the registry lists the chosen countries, then
 * neighbours marked, counts the rest, and its confirmed/watch summary counts
 * the focused set.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { initTestI18n } from './helpers/i18n.mts';
import { FuelShortagePanel } from '@/components/FuelShortagePanel';
import type { ResolvedScope } from '@/services/tab-focus';
import { getCachedFuelShortageRegistry } from '@/shared/fuel-shortage-registry-store';
import { resolveScope } from '../../shared/tab-scope-resolve';

const listFuelShortages = vi.fn();

vi.mock('@/shared/fuel-shortage-registry-store', () => ({
  getCachedFuelShortageRegistry: vi.fn(() => ({ registry: undefined })),
  setCachedFuelShortageRegistry: vi.fn(),
}));

vi.mock('@/services/generated-rpc-clients', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  SupplyChainServiceClient: class {
    listFuelShortages = (...args: unknown[]) => listFuelShortages(...args);
    getFuelShortageDetail = async () => ({ shortage: null });
  },
}));

beforeAll(async () => {
  await initTestI18n();
});

const scopeOf = (countries: string[], neighbours = true): ResolvedScope => {
  const scope = { countries, neighbours };
  return { scope, ...resolveScope(scope) };
};
// TH's neighbours are KH, LA, MM and MY.
const FOCUS = scopeOf(['TH']);

function shortage(id: string, country: string, severity: 'confirmed' | 'watch', product = 'diesel') {
  return {
    id,
    country,
    product,
    severity,
    firstSeen: '2026-10-01',
    lastConfirmed: '2026-11-01',
    resolvedAt: '',
    impactTypes: [],
    causeChain: [],
    shortDescription: '',
  };
}

// Unfocused order: confirmed first, then watch.
const SHORTAGES = [
  shortage('th', 'TH', 'watch'),
  shortage('us', 'US', 'confirmed'),
  shortage('la', 'LA', 'confirmed'),
  shortage('none', '', 'watch', 'jet'),
];

function live(shortages = SHORTAGES) {
  return { shortages, fetchedAt: '2026-11-10T00:00:00Z', classifierVersion: 'v1', upstreamUnavailable: false };
}

let panel: FuelShortagePanel;

beforeEach(() => {
  listFuelShortages.mockReset();
  vi.mocked(getCachedFuelShortageRegistry).mockReturnValue({ registry: undefined } as never);
  // A detail source makes every render immediate (no 150 ms coalescing).
  panel = new FuelShortagePanel({ getFuelShortageDetail: async () => ({ shortage: undefined }) as never });
  document.body.appendChild(panel.getElement());
});

afterEach(() => {
  panel.destroy();
  document.body.innerHTML = '';
});

async function load(shortages = SHORTAGES): Promise<void> {
  listFuelShortages.mockResolvedValue(live(shortages));
  await panel.fetchData();
}

const el = () => panel.getElement();
const ids = () => [...el().querySelectorAll<HTMLElement>('tr.fs-row')].map((n) => n.dataset.shortageId);
const strip = () => el().querySelector<HTMLElement>('.panel-scope-strip');
const stripButton = (action: string) => strip()?.querySelector<HTMLButtonElement>(`button[data-scope-action="${action}"]`);
const rowFor = (id: string) => el().querySelector(`tr.fs-row[data-shortage-id="${id}"]`);
const summary = () => el().querySelector('.fs-summary')?.textContent;

describe('FuelShortagePanel under a focus', () => {
  it('lists the chosen country then the marked neighbour, counts hidden and no-country entries, and scopes the summary', async () => {
    await load();
    panel.applyScope(FOCUS);

    expect(ids()).toEqual(['th', 'la']);
    expect(rowFor('la')?.querySelector('.panel-scope-tag-neighbour')?.textContent).toBe('Neighbour: Laos');
    expect(rowFor('th')?.querySelector('.panel-scope-tag')).toBeNull();
    expect(strip()?.hidden).toBe(false);
    expect(strip()?.textContent).toContain('1 hidden by focus');
    expect(strip()?.textContent).toContain('1 item with no country');
    expect(summary()).toBe('1 confirmed · 1 watch');
  });

  it('shows the no-country entry on request, and Show all shows everything in the registry order', async () => {
    await load();
    panel.applyScope(FOCUS);
    stripButton('show-unattributed')!.click();
    expect(ids()).toEqual(['th', 'la', 'none']);
    expect(rowFor('none')?.querySelector('.panel-scope-tag-none')?.textContent).toBe('No country');
    expect(summary()).toBe('1 confirmed · 2 watch');

    stripButton('show-all')!.click();
    expect(ids()).toEqual(['us', 'la', 'th', 'none']);
    expect(summary()).toBe('2 confirmed · 2 watch');
  });

  it('applies a focus set before the data arrives, and clears back to the full list', async () => {
    panel.applyScope(scopeOf(['TH'], false));
    expect(strip()?.hidden).toBe(true);
    await load();
    expect(ids()).toEqual(['th']);
    panel.applyScope(null);
    expect(ids()).toEqual(['us', 'la', 'th', 'none']);
    expect(strip()?.hidden).toBe(true);
  });

  it('says nothing matched the focus, keeps the counts reachable, and is distinct from a load failure', async () => {
    await load();
    panel.applyScope(scopeOf(['NZ'], false));
    expect(el().querySelector('.panel-scope-empty')?.textContent).toContain('No fuel shortages for these countries');
    expect(el().querySelector('.panel-error-state')).toBeNull();
    expect(summary()).toBe('0 confirmed · 0 watch');
    expect(strip()?.textContent).toContain('3 hidden by focus');
    stripButton('show-all')!.click();
    expect(ids()).toHaveLength(4);
  });

  it('hides the strip after a load failure, and a focus change keeps the failure', async () => {
    listFuelShortages.mockRejectedValue(new Error('down'));
    panel.applyScope(FOCUS);
    await panel.fetchData();
    expect(el().querySelector('.panel-error-state')?.textContent).toContain('Fuel shortage registry error');
    expect(strip()?.hidden).toBe(true);
    panel.applyScope(null);
    panel.applyScope(scopeOf(['US']));
    expect(el().querySelector('.panel-error-state')?.textContent).toContain('Fuel shortage registry error');
    expect(strip()?.hidden).toBe(true);
    await load();
    expect(ids()).toEqual(['us']);
    expect(strip()?.hidden).toBe(false);
  });

  it('hides the strip while loading', async () => {
    await load();
    panel.applyScope(FOCUS);
    expect(strip()?.hidden).toBe(false);
    panel.showLoading();
    expect(strip()?.hidden).toBe(true);
  });

  it('is unchanged without a focus', async () => {
    await load();
    expect(ids()).toEqual(['us', 'la', 'th', 'none']);
    expect(summary()).toBe('2 confirmed · 2 watch');
    expect(strip()?.hidden).toBe(true);
    expect(el().querySelector('.panel-scope-tag')).toBeNull();
  });
});
