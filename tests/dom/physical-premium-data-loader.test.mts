import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DataLoaderManager,
  loadPhysicalPremiumComparison,
  loadPhysicalPremiumComparisonIfNeeded,
} from '@/app/data-loader';
import type { AppContext } from '@/app/app-context';
import type {
  GetPhysicalDivergenceIndexResponse,
  GetPhysicalPremiumsResponse,
} from '@/generated/client/worldmonitor/market/v1/service_client';

const marketMocks = vi.hoisted(() => ({
  fetchPhysicalPremiums: vi.fn(),
  fetchPhysicalDivergence: vi.fn(),
}));

const gateMocks = vi.hoisted(() => ({ isPro: true }));
const emptyDivergence: GetPhysicalDivergenceIndexResponse = {
  readings: [],
  evaluatedAt: 0,
  methodologyVersion: 'physical-divergence-test',
};

vi.mock('@/services/market', () => marketMocks);

vi.mock('@/services/panel-gating', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/services/panel-gating')>(),
  hasPremiumAccess: () => gateMocks.isPro,
}));

beforeEach(() => {
  gateMocks.isPro = true;
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((onResolve) => { resolve = onResolve; });
  return { promise, resolve };
}

describe('physical premium data loading', () => {
  it('fetches only while the comparison needs discovery or refresh', async () => {
    const panel = {
      shouldRefreshPhysicalComparison: vi.fn(() => false),
      updatePhysicalPremiums: vi.fn(),
      updatePhysicalDivergence: vi.fn(),
      showPhysicalDivergenceUnavailable: vi.fn(),
    };
    const fetchPremiums = vi.fn(async () => ({ premiums: [] }));
    const fetchDivergence = vi.fn(async () => (
      { readings: [], composite: undefined } as unknown as GetPhysicalDivergenceIndexResponse
    ));

    expect(await loadPhysicalPremiumComparisonIfNeeded(
      panel,
      () => true,
      fetchPremiums,
      fetchDivergence,
    )).toBe(false);
    expect(fetchPremiums).not.toHaveBeenCalled();
    expect(fetchDivergence).not.toHaveBeenCalled();

    panel.shouldRefreshPhysicalComparison.mockReturnValue(true);
    expect(await loadPhysicalPremiumComparisonIfNeeded(
      panel,
      () => true,
      fetchPremiums,
      fetchDivergence,
    )).toBe(true);
    expect(fetchPremiums).toHaveBeenCalledOnce();
    expect(fetchDivergence).toHaveBeenCalledOnce();
  });

  it('keeps a successful premium response when divergence fails', async () => {
    const premiums: GetPhysicalPremiumsResponse = { premiums: [] };
    const panel = {
      updatePhysicalPremiums: vi.fn(),
      updatePhysicalDivergence: vi.fn(),
      showPhysicalDivergenceUnavailable: vi.fn(),
    };

    await loadPhysicalPremiumComparison(
      panel,
      () => true,
      async () => premiums,
      async (): Promise<GetPhysicalDivergenceIndexResponse> => { throw new Error('Redis unavailable'); },
    );

    expect(panel.updatePhysicalPremiums).toHaveBeenCalledWith(premiums);
    expect(panel.updatePhysicalDivergence).not.toHaveBeenCalled();
    expect(panel.showPhysicalDivergenceUnavailable).toHaveBeenCalledOnce();
  });

  it('keeps a successful divergence response when premiums fail', async () => {
    const divergence = { readings: [], composite: undefined } as unknown as GetPhysicalDivergenceIndexResponse;
    const panel = {
      updatePhysicalPremiums: vi.fn(),
      updatePhysicalDivergence: vi.fn(),
      showPhysicalDivergenceUnavailable: vi.fn(),
    };

    await loadPhysicalPremiumComparison(
      panel,
      () => true,
      async (): Promise<GetPhysicalPremiumsResponse> => { throw new Error('Premium transport unavailable'); },
      async () => divergence,
    );

    expect(panel.updatePhysicalPremiums).not.toHaveBeenCalled();
    expect(panel.updatePhysicalDivergence).toHaveBeenCalledWith(divergence);
    expect(panel.showPhysicalDivergenceUnavailable).not.toHaveBeenCalled();
  });

  it('drops both fulfilled responses after the market load becomes stale', async () => {
    const panel = {
      updatePhysicalPremiums: vi.fn(),
      updatePhysicalDivergence: vi.fn(),
      showPhysicalDivergenceUnavailable: vi.fn(),
    };
    const divergence = { readings: [], composite: undefined } as unknown as GetPhysicalDivergenceIndexResponse;

    await loadPhysicalPremiumComparison(
      panel,
      () => false,
      async () => ({ premiums: [] }),
      async () => divergence,
    );

    expect(panel.updatePhysicalPremiums).not.toHaveBeenCalled();
    expect(panel.updatePhysicalDivergence).not.toHaveBeenCalled();
    expect(panel.showPhysicalDivergenceUnavailable).not.toHaveBeenCalled();
  });

  it('does not paint a completed premium response after entitlement drops', async () => {
    const premiums = deferred<GetPhysicalPremiumsResponse>();
    const divergence = deferred<GetPhysicalDivergenceIndexResponse>();
    marketMocks.fetchPhysicalPremiums.mockReset().mockReturnValueOnce(premiums.promise);
    marketMocks.fetchPhysicalDivergence.mockReset().mockReturnValueOnce(divergence.promise);
    const panel = {
      updatePhysicalPremiums: vi.fn(),
      updatePhysicalDivergence: vi.fn(),
      showPhysicalDivergenceUnavailable: vi.fn(),
    };
    const ctx = { panels: { commodities: panel } } as unknown as AppContext;
    const loader = new DataLoaderManager(ctx, {
      renderCriticalBanner: () => undefined,
      refreshOpenCountryBrief: () => undefined,
    });

    const load = loader.loadPhysicalPremiumComparison();
    await vi.waitFor(() => expect(marketMocks.fetchPhysicalPremiums).toHaveBeenCalledOnce());
    gateMocks.isPro = false;
    premiums.resolve({ premiums: [] });
    divergence.resolve(emptyDivergence);
    await load;

    expect(panel.updatePhysicalPremiums).not.toHaveBeenCalled();
    expect(panel.updatePhysicalDivergence).not.toHaveBeenCalled();
  });

  it('does not let an older physical comparison overwrite a newer cohort', async () => {
    const olderPremiums = deferred<GetPhysicalPremiumsResponse>();
    const olderDivergence = deferred<GetPhysicalDivergenceIndexResponse>();
    const newerPremiums = { premiums: [{ metal: 'gold', premiumPct: 2 }] } as GetPhysicalPremiumsResponse;
    const newerDivergence = {
      evaluatedAt: '2026-08-19T12:30:00.000Z',
      readings: [],
    } as unknown as GetPhysicalDivergenceIndexResponse;
    marketMocks.fetchPhysicalPremiums
      .mockReset()
      .mockImplementationOnce(() => olderPremiums.promise)
      .mockResolvedValueOnce(newerPremiums);
    marketMocks.fetchPhysicalDivergence
      .mockReset()
      .mockImplementationOnce(() => olderDivergence.promise)
      .mockResolvedValueOnce(newerDivergence);
    const panel = {
      updatePhysicalPremiums: vi.fn(),
      updatePhysicalDivergence: vi.fn(),
      showPhysicalDivergenceUnavailable: vi.fn(),
    };
    const ctx = { panels: { commodities: panel } } as unknown as AppContext;
    const loader = new DataLoaderManager(ctx, {
      renderCriticalBanner: () => undefined,
      refreshOpenCountryBrief: () => undefined,
    });

    const olderLoad = loader.loadPhysicalPremiumComparison();
    await vi.waitFor(() => expect(marketMocks.fetchPhysicalPremiums).toHaveBeenCalledTimes(1));
    const newerLoad = loader.loadPhysicalPremiumComparison();
    await newerLoad;

    expect(panel.updatePhysicalPremiums).toHaveBeenCalledWith(newerPremiums);
    expect(panel.updatePhysicalDivergence).toHaveBeenCalledWith(newerDivergence);
    olderPremiums.resolve({ premiums: [{ metal: 'gold', premiumPct: 1 }] } as GetPhysicalPremiumsResponse);
    olderDivergence.resolve({
      evaluatedAt: '2026-08-18T12:30:00.000Z',
      readings: [],
    } as unknown as GetPhysicalDivergenceIndexResponse);
    await olderLoad;

    expect(panel.updatePhysicalPremiums).toHaveBeenCalledTimes(1);
    expect(panel.updatePhysicalDivergence).toHaveBeenCalledTimes(1);
  });

  it('fetches nothing for a free viewer, leaving the Physical tab unbuilt (#6436/#6448)', async () => {
    gateMocks.isPro = false;
    marketMocks.fetchPhysicalPremiums.mockReset().mockResolvedValue({ premiums: [] });
    marketMocks.fetchPhysicalDivergence.mockReset().mockResolvedValue({ readings: [] });
    const panel = {
      updatePhysicalPremiums: vi.fn(),
      updatePhysicalDivergence: vi.fn(),
      showPhysicalDivergenceUnavailable: vi.fn(),
    };
    const ctx = { panels: { commodities: panel } } as unknown as AppContext;
    const loader = new DataLoaderManager(ctx, {
      renderCriticalBanner: () => undefined,
      refreshOpenCountryBrief: () => undefined,
    });

    await loader.loadPhysicalPremiumComparison();

    expect(marketMocks.fetchPhysicalPremiums).not.toHaveBeenCalled();
    expect(marketMocks.fetchPhysicalDivergence).not.toHaveBeenCalled();
    expect(panel.updatePhysicalPremiums).not.toHaveBeenCalled();
    expect(panel.updatePhysicalDivergence).not.toHaveBeenCalled();
    expect(panel.showPhysicalDivergenceUnavailable).not.toHaveBeenCalled();
  });
});
