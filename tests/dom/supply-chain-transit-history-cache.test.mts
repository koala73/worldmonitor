import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { GetChokepointStatusResponse } from '@/generated/client/worldmonitor/supply_chain/v1/service_client';

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

const DAY = { date: '2026-09-01', tanker: 10, cargo: 20, other: 5, total: 35 };

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
