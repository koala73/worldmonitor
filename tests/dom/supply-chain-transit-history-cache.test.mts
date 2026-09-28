import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  GetChokepointStatusResponse,
  TransitDayCount,
} from '@/generated/client/worldmonitor/supply_chain/v1/service_client';

const history = vi.hoisted(() => ({ fetchChokepointHistory: vi.fn() }));
vi.mock('@/services/supply-chain', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/supply-chain')>()),
  fetchChokepointHistory: history.fetchChokepointHistory,
}));

import { SupplyChainPanel } from '@/components/SupplyChainPanel';
import { initTestI18n } from './helpers/i18n.mts';

const status = {
  chokepoints: [{
    id: 'suez',
    name: 'Suez Canal',
    status: 'green',
    activeWarnings: 0,
    aisDisruptions: 0,
    navigationalWarningsAvailable: true,
    aisSnapshotAvailable: true,
    affectedRoutes: [],
    description: '',
    directions: [],
    disruptionScore: 0,
    transitSummary: { dataAvailable: true },
  }],
  fetchedAt: '2026-09-02T00:00:00.000Z',
  upstreamUnavailable: false,
} as unknown as GetChokepointStatusResponse;

// Every TransitDayCount field, with distinct values so a legend that reads the
// wrong key (or an absent one) shows the wrong number instead of passing.
const DAY: TransitDayCount = {
  date: '2026-09-01',
  tanker: 10,
  cargo: 20,
  other: 5,
  total: 35,
  container: 11,
  dryBulk: 12,
  generalCargo: 13,
  roro: 14,
  capContainer: 1_100_000,
  capDryBulk: 1_200_000,
  capGeneralCargo: 13_000,
  capRoro: 14_000,
  capTanker: 1_500_000,
};

function legendText(panel: SupplyChainPanel): string {
  return (chartSlot(panel)?.textContent ?? '').replace(/\s+/g, ' ');
}

function toggleSuez(panel: SupplyChainPanel): void {
  panel.getElement().querySelector<HTMLElement>('[data-cp-id="Suez Canal"] .trade-restriction-header')!.click();
}

function chartSlot(panel: SupplyChainPanel): HTMLElement | null {
  return panel.getElement().querySelector<HTMLElement>('[data-chart-cp-id="suez"]');
}

beforeAll(async () => {
  await initTestI18n();
});

beforeEach(() => {
  document.body.replaceChildren();
  history.fetchChokepointHistory.mockReset();
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({}));
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('SupplyChainPanel transit history cache', () => {
  it('retries an empty history on the next expand, then caches the first non-empty result', async () => {
    const panel = new SupplyChainPanel();
    document.body.appendChild(panel.getElement());
    panel.updateChokepointStatus(status);
    await vi.advanceTimersByTimeAsync(151);

    // First expand: the history endpoint has nothing yet.
    history.fetchChokepointHistory.mockResolvedValue({ chokepointId: 'suez', history: [], fetchedAt: '0' });
    toggleSuez(panel);
    await vi.advanceTimersByTimeAsync(400);
    expect(history.fetchChokepointHistory).toHaveBeenCalledTimes(1);
    expect(chartSlot(panel)?.textContent).toContain('unavailable');
    expect(chartSlot(panel)?.querySelector('canvas')).toBeNull();

    // Collapse and re-expand: the empty answer was not cached, so it asks again.
    history.fetchChokepointHistory.mockResolvedValue({ chokepointId: 'suez', history: [DAY], fetchedAt: '1' });
    toggleSuez(panel);
    await vi.advanceTimersByTimeAsync(400);
    toggleSuez(panel);
    await vi.advanceTimersByTimeAsync(400);
    expect(history.fetchChokepointHistory).toHaveBeenCalledTimes(2);
    expect(chartSlot(panel)?.querySelector('canvas')).not.toBeNull();
    const calls = legendText(panel);
    for (const expected of ['Container 11', 'Dry Bulk 12', 'Gen. Cargo 13', 'RoRo 14', 'Tanker 10']) {
      expect(calls).toContain(expected);
    }
    expect(calls).not.toMatch(/undefined|NaN/);
    chartSlot(panel)!.querySelector<HTMLButtonElement>('[data-tab="dwt"]')!.click();
    const volume = legendText(panel);
    for (const expected of ['Container 1.10M', 'Dry Bulk 1.20M', 'Gen. Cargo 13.0K', 'RoRo 14.0K', 'Tanker 1.50M']) {
      expect(volume).toContain(expected);
    }
    expect(volume).not.toMatch(/undefined|NaN/);

    // A non-empty history is cached for the session: re-expanding mounts without a fetch.
    toggleSuez(panel);
    await vi.advanceTimersByTimeAsync(400);
    toggleSuez(panel);
    await vi.advanceTimersByTimeAsync(400);
    expect(history.fetchChokepointHistory).toHaveBeenCalledTimes(2);
    expect(chartSlot(panel)?.querySelector('canvas')).not.toBeNull();
    panel.destroy();
  });
});
