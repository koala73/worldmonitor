/**
 * A disruption row for a storage asset must open the Strategic Storage Atlas
 * through 'wm:open-storage-atlas' (enable + mount + reveal + deliver), not by
 * dispatching the detail event directly: the atlas only claims a direct
 * 'energy:open-storage-facility-detail' while the user can see it, so a closed
 * or deferred atlas would drop the click (#10148 review).
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { initTestI18n } from './helpers/i18n.mts';

vi.mock('@/services/generated-rpc-clients', () => ({
  SupplyChainServiceClient: class {
    listEnergyDisruptions = vi.fn(async () => ({ events: [], upstreamUnavailable: false }));
  },
}));

import { EnergyDisruptionsPanel } from '@/components/EnergyDisruptionsPanel';

type OpenAsset = { dispatchOpenAsset(eventId: string, assetId: string, assetType: string): void };

const panels: EnergyDisruptionsPanel[] = [];
const seen: Array<{ type: string; detail: unknown }> = [];
const record = (ev: Event): void => {
  seen.push({ type: ev.type, detail: (ev as CustomEvent).detail });
};

beforeAll(async () => {
  await initTestI18n();
  for (const type of ['wm:open-storage-atlas', 'energy:open-storage-facility-detail', 'energy:open-pipeline-detail']) {
    window.addEventListener(type, record);
  }
});

afterEach(() => {
  seen.length = 0;
  for (const panel of panels.splice(0)) panel.destroy();
  document.body.replaceChildren();
});

describe('EnergyDisruptionsPanel row click-through', () => {
  it('opens a storage asset through the atlas route, never the raw detail event', () => {
    const panel = new EnergyDisruptionsPanel();
    panels.push(panel);
    (panel as unknown as OpenAsset).dispatchOpenAsset('ev-1', 'okoli', 'storage');
    expect(seen).toEqual([{ type: 'wm:open-storage-atlas', detail: { facilityId: 'okoli' } }]);
  });

  it('keeps the pipeline detail event for pipeline assets', () => {
    const panel = new EnergyDisruptionsPanel();
    panels.push(panel);
    (panel as unknown as OpenAsset).dispatchOpenAsset('ev-2', 'druzhba', 'pipeline');
    expect(seen).toEqual([{ type: 'energy:open-pipeline-detail', detail: { pipelineId: 'druzhba' } }]);
  });
});
