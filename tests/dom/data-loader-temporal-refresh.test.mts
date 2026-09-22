import { beforeEach, describe, expect, it, vi } from 'vitest';

const temporal = vi.hoisted(() => ({
  fetch: vi.fn(async () => ({ anomalies: [], trackedTypes: ['news'] })),
}));
const aggregator = vi.hoisted(() => ({
  ingest: vi.fn(),
}));

vi.mock('@/services/temporal-baseline', () => ({
  consumeServerAnomalies: vi.fn(),
  fetchLiveAnomalies: temporal.fetch,
}));
vi.mock('@/app/lazy-services', () => ({
  getSignalAggregator: async () => ({ ingestTemporalAnomalies: aggregator.ingest }),
}));

describe('data-loader temporal refresh', () => {
  beforeEach(() => {
    temporal.fetch.mockClear();
    aggregator.ingest.mockClear();
  });

  it('refreshes an open country brief after live temporal ingest', async () => {
    const refreshOpenCountryBrief = vi.fn();
    const { DataLoaderManager } = await import('@/app/data-loader');
    const loader = new DataLoaderManager(
      { statusPanel: null } as never,
      { renderCriticalBanner: () => undefined, refreshOpenCountryBrief },
    );
    await loader.refreshTemporalBaseline();
    expect(aggregator.ingest).toHaveBeenCalled();
    expect(refreshOpenCountryBrief).toHaveBeenCalled();
  });
});
