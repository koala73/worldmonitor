import { expect, it, vi } from 'vitest';
import type { CanadaRoadRecord } from '@/services/canada-roads-core';

const mocks = vi.hoisted(() => ({ fetchCanadaRoads: vi.fn() }));
vi.mock('@/services/canada-roads', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/services/canada-roads')>(),
  fetchCanadaRoads: mocks.fetchCanadaRoads,
  getCanadaRoadSourceStates: () => ({ canadaRoads: 'available' }),
}));

const { DataLoaderManager } = await import('@/app/data-loader');
const placeholder: CanadaRoadRecord = {
  id: 'HWY-40', lat: 53, lon: -117, severity: 'None', eventType: 'event',
  isFullClosure: false, lanesAffected: 'No Data', roadwayName: 'HWY-40',
  headline: 'HWY-40', description: '', jurisdiction: 'AB',
};
const closure = { ...placeholder, id: 'closure', isFullClosure: true };

it.each([
  { records: [], ready: false },
  { records: [placeholder], ready: false },
  { records: [closure], ready: true },
  { records: [placeholder, closure], ready: true },
])('sets road readiness to $ready for $records.length source records', async ({ records, ready }) => {
  mocks.fetchCanadaRoads.mockResolvedValue(records);
  const map = { setCanadaRoads: vi.fn(), setLayerReady: vi.fn() };
  const statusPanel = { updateFeed: vi.fn() };
  await DataLoaderManager.prototype.loadCanadaRoads.call({ ctx: { map, statusPanel } } as never);
  expect(map.setLayerReady).toHaveBeenCalledWith('canadaRoads', ready);
  expect(map.setCanadaRoads).toHaveBeenCalledWith(records);
  expect(statusPanel.updateFeed).toHaveBeenCalledWith('Canada Roads', expect.objectContaining({
    status: 'ok', itemCount: records.length,
  }));
});
