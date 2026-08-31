import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DataLoaderManager } from '@/app/data-loader';
import type { AppContext } from '@/app/app-context';
import type { GetMineralProductionResponse } from '@/services/supply-chain';

const supplyMocks = vi.hoisted(() => ({
  fetchMineralProduction: vi.fn(),
}));
const gateMocks = vi.hoisted(() => ({ isPro: true }));

vi.mock('@/services/supply-chain', () => supplyMocks);
vi.mock('@/services/panel-gating', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/services/panel-gating')>(),
  hasPremiumAccess: () => gateMocks.isPro,
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((onResolve) => { resolve = onResolve; });
  return { promise, resolve };
}

beforeEach(() => {
  gateMocks.isPro = true;
  supplyMocks.fetchMineralProduction.mockReset();
});

describe('mineral production data loading', () => {
  it('does not paint a completed production response after entitlement drops', async () => {
    const production = deferred<GetMineralProductionResponse>();
    supplyMocks.fetchMineralProduction.mockReturnValueOnce(production.promise);
    const panel = { updateMineralProduction: vi.fn(), clearMineralProduction: vi.fn() };
    const loader = new DataLoaderManager(
      { panels: { 'supply-chain': panel } } as unknown as AppContext,
      { renderCriticalBanner: () => undefined, refreshOpenCountryBrief: () => undefined },
    );

    const load = loader.loadMineralProduction();
    await vi.waitFor(() => expect(supplyMocks.fetchMineralProduction).toHaveBeenCalledOnce());
    gateMocks.isPro = false;
    production.resolve({ commodities: [] } as unknown as GetMineralProductionResponse);
    await load;

    expect(panel.updateMineralProduction).not.toHaveBeenCalled();
  });

  it('invalidates an in-flight production request before clearing the panel', async () => {
    const production = deferred<GetMineralProductionResponse>();
    supplyMocks.fetchMineralProduction.mockReturnValueOnce(production.promise);
    const panel = { updateMineralProduction: vi.fn(), clearMineralProduction: vi.fn() };
    const loader = new DataLoaderManager(
      { panels: { 'supply-chain': panel } } as unknown as AppContext,
      { renderCriticalBanner: () => undefined, refreshOpenCountryBrief: () => undefined },
    );

    const load = loader.loadMineralProduction();
    await vi.waitFor(() => expect(supplyMocks.fetchMineralProduction).toHaveBeenCalledOnce());
    loader.clearMineralProduction();
    production.resolve({ commodities: [] } as unknown as GetMineralProductionResponse);
    await load;

    expect(panel.clearMineralProduction).toHaveBeenCalledOnce();
    expect(panel.updateMineralProduction).not.toHaveBeenCalled();
  });
});
