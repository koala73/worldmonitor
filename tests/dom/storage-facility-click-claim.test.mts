import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { initTestI18n } from './helpers/i18n.mts';

vi.mock('@/services/generated-rpc-clients', () => ({
  SupplyChainServiceClient: class {
    getStorageFacilityDetail = vi.fn(async () => ({ facility: { id: 'okoli', name: 'Okoli UGS' } }));
    listEnergyDisruptions = vi.fn(async () => ({ events: [], upstreamUnavailable: false }));
    listStorageFacilities = vi.fn(async () => ({ facilities: [], upstreamUnavailable: true }));
  },
}));

import { StorageFacilityMapPanel } from '@/components/StorageFacilityMapPanel';

const panels: StorageFacilityMapPanel[] = [];

beforeAll(async () => {
  await initTestI18n();
});

afterEach(() => {
  for (const panel of panels.splice(0)) panel.destroy();
  document.body.replaceChildren();
});

describe('Storage atlas click claim', () => {
  it('claims a storage click only while the atlas is on the page', () => {
    const absent = new StorageFacilityMapPanel();
    panels.push(absent);
    const missed = new CustomEvent('energy:open-storage-facility-detail', {
      cancelable: true,
      detail: { facilityId: 'okoli' },
    });
    window.dispatchEvent(missed);
    expect(missed.defaultPrevented).toBe(false);
    absent.destroy();
    panels.pop();

    const mounted = new StorageFacilityMapPanel();
    panels.push(mounted);
    document.body.append(mounted.getElement());
    const claimed = new CustomEvent('energy:open-storage-facility-detail', {
      cancelable: true,
      detail: { facilityId: 'okoli' },
    });
    window.dispatchEvent(claimed);
    expect(claimed.defaultPrevented).toBe(true);
  });
});
