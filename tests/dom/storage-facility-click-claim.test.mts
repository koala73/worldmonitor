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
  document.body.className = '';
});

/** Dispatch the map's cancelable detail event and report whether the atlas claimed it. */
function atlasClaims(): boolean {
  const ev = new CustomEvent('energy:open-storage-facility-detail', {
    cancelable: true,
    detail: { facilityId: 'okoli' },
  });
  window.dispatchEvent(ev);
  return ev.defaultPrevented;
}

function mountedAtlas(): StorageFacilityMapPanel {
  const panel = new StorageFacilityMapPanel();
  panels.push(panel);
  document.body.append(panel.getElement());
  return panel;
}

describe('Storage atlas click claim', () => {
  it('leaves the click unclaimed while the atlas is not on the page', () => {
    const absent = new StorageFacilityMapPanel();
    panels.push(absent);
    expect(atlasClaims()).toBe(false);
  });

  it('claims the click when the atlas is mounted and visible', () => {
    mountedAtlas();
    expect(atlasClaims()).toBe(true);
  });

  it('leaves the click unclaimed after the atlas was closed (hidden but still connected)', () => {
    const atlas = mountedAtlas();
    atlas.toggle(false);
    expect(atlas.getElement().isConnected).toBe(true);
    expect(atlasClaims()).toBe(false);
    atlas.toggle(true);
    expect(atlasClaims()).toBe(true);
  });

  it('leaves the click unclaimed while a mobile category filter hides the atlas', () => {
    const atlas = mountedAtlas();
    atlas.getElement().classList.add('mobile-cat-hidden');
    expect(atlasClaims()).toBe(false);
  });

  it('leaves the click unclaimed while the fullscreen map covers the panel grid', () => {
    mountedAtlas();
    document.body.classList.add('live-news-fullscreen-active');
    expect(atlasClaims()).toBe(false);
    document.body.classList.remove('live-news-fullscreen-active');
    expect(atlasClaims()).toBe(true);
  });
});
