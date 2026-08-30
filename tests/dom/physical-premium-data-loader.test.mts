import { describe, expect, it, vi } from 'vitest';

import { loadPhysicalPremiumComparison } from '@/app/data-loader';
import type {
  GetPhysicalDivergenceIndexResponse,
  GetPhysicalPremiumsResponse,
} from '@/generated/client/worldmonitor/market/v1/service_client';

describe('physical premium data loading', () => {
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
});
