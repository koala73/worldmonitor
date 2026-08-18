import { describe, expect, it, vi } from 'vitest';
import type { AppContext } from '@/app/app-context';
import type { ListGlobalTendersResponse } from '@/generated/client/worldmonitor/economic/v1/service_client';
import type { GlobalTenderFilters } from '@/services/global-tenders';

const procurementMocks = vi.hoisted(() => ({
  fetchGlobalTenders: vi.fn(),
}));

vi.mock('@/services/panel-gating', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/services/panel-gating')>(),
  hasPremiumAccess: () => true,
}));

vi.mock('@/services/global-tenders', () => ({
  clearGlobalTenderCache: vi.fn(),
  fetchGlobalTenders: procurementMocks.fetchGlobalTenders,
}));

function response(total = 0): ListGlobalTendersResponse {
  return {
    tenders: [],
    nextCursor: '',
    fetchedAt: '2026-08-18T12:00:00.000Z',
    dataAvailable: true,
    availability: 'available',
    sourceStatuses: [],
    total,
    appliedFilters: [],
    countryCoverage: 'not_requested',
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((onResolve) => {
    resolve = onResolve;
  });
  return { promise, resolve };
}

describe('Global procurement DataLoader cancellation', () => {
  it('does not let canceled scoped filters seed an overlapping unfiltered refresh', async () => {
    type RequestHandler = (
      filters: GlobalTenderFilters,
      append: boolean,
      signal: AbortSignal,
    ) => void | Promise<void>;

    const procurementPanel = {
      setRequestHandler: vi.fn((_handler: RequestHandler) => undefined),
      setLoading: vi.fn(),
      update: vi.fn(),
      clear: vi.fn(),
      showUnavailable: vi.fn(),
    };
    const statusPanel = { updateApi: vi.fn() };
    const ctx = {
      panels: {
        'global-procurement': procurementPanel,
      },
      statusPanel,
    } as unknown as AppContext;

    procurementMocks.fetchGlobalTenders.mockReset();
    procurementMocks.fetchGlobalTenders.mockResolvedValue(response(1));
    const { DataLoaderManager } = await import('@/app/data-loader');
    const loader = new DataLoaderManager(ctx, {
      renderCriticalBanner: () => undefined,
      refreshOpenCountryBrief: () => undefined,
    });

    await loader.loadGlobalTenders({ query: 'baseline' });
    const requestHandlerCalls = procurementPanel.setRequestHandler.mock.calls;
    const requestHandler = requestHandlerCalls[requestHandlerCalls.length - 1]?.[0];
    if (!requestHandler) throw new Error('Global procurement request handler was not registered');

    const agentFetch = deferred<ListGlobalTendersResponse>();
    procurementMocks.fetchGlobalTenders.mockImplementationOnce(() => agentFetch.promise);
    const controller = new AbortController();
    const agentRequest = requestHandler({ query: 'agent-only' }, false, controller.signal);
    await vi.waitFor(() => expect(procurementMocks.fetchGlobalTenders).toHaveBeenCalledTimes(2));
    expect(procurementMocks.fetchGlobalTenders.mock.calls[1]?.[1]).toBe(controller.signal);

    await loader.loadGlobalTenders();
    expect(procurementMocks.fetchGlobalTenders).toHaveBeenCalledTimes(2);

    controller.abort();
    expect((procurementMocks.fetchGlobalTenders.mock.calls[1]?.[1] as AbortSignal).aborted).toBe(true);
    await loader.loadGlobalTenders();
    const refreshFilters = procurementMocks.fetchGlobalTenders.mock.calls[2]?.[0] as GlobalTenderFilters | undefined;
    expect(refreshFilters).toMatchObject({ query: 'baseline', cursor: '' });

    agentFetch.resolve(response(99));
    await agentRequest;
    expect(procurementPanel.update).not.toHaveBeenCalledWith(expect.objectContaining({ total: 99 }), false);
  });

  it('invalidates an unscoped procurement load when the DataLoader is destroyed', async () => {
    const procurementPanel = {
      setRequestHandler: vi.fn(),
      setLoading: vi.fn(),
      update: vi.fn(),
      clear: vi.fn(),
      showUnavailable: vi.fn(),
    };
    const statusPanel = { updateApi: vi.fn() };
    const ctx = {
      panels: {
        'global-procurement': procurementPanel,
      },
      statusPanel,
    } as unknown as AppContext;
    const pendingFetch = deferred<ListGlobalTendersResponse>();
    procurementMocks.fetchGlobalTenders.mockReset();
    procurementMocks.fetchGlobalTenders.mockImplementationOnce(() => pendingFetch.promise);
    const { DataLoaderManager } = await import('@/app/data-loader');
    const loader = new DataLoaderManager(ctx, {
      renderCriticalBanner: () => undefined,
      refreshOpenCountryBrief: () => undefined,
    });

    const load = loader.loadGlobalTenders();
    await vi.waitFor(() => expect(procurementMocks.fetchGlobalTenders).toHaveBeenCalledTimes(1));
    loader.destroy();
    pendingFetch.resolve(response(77));
    await load;

    expect(procurementPanel.update).not.toHaveBeenCalled();
    expect(statusPanel.updateApi).not.toHaveBeenCalled();
  });
});
