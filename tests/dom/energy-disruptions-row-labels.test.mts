/**
 * Energy Disruptions Log rows read as plain text (#11272): the event type,
 * the cause chain and the asset show display labels, never the schema codes
 * or registry ids the seed stores.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { initTestI18n } from './helpers/i18n.mts';
import type { EnergyDisruptionEntry } from '@/generated/client/worldmonitor/supply_chain/v1/service_client';

const rpc = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock('@/services/generated-rpc-clients', () => ({
  SupplyChainServiceClient: class {
    listEnergyDisruptions = rpc.list;
  },
}));

import { EnergyDisruptionsPanel } from '@/components/EnergyDisruptionsPanel';

const KEYSTONE_XL: EnergyDisruptionEntry = {
  id: 'keystone-xl-permit-revoked-2021',
  assetId: 'keystone-xl-cancelled',
  assetName: 'Keystone XL (cancelled 2021)',
  assetType: 'pipeline',
  eventType: 'sanction',
  startAt: '2021-01-20T00:00:00Z',
  endAt: '2021-06-09T00:00:00Z',
  capacityOfflineBcmYr: 0,
  capacityOfflineMbd: 0,
  causeChain: ['upstream_refinery', 'policy'],
  shortDescription: 'Biden administration revoked the presidential permit on day one.',
  sources: [],
  classifierVersion: 'v1',
  classifierConfidence: 0.95,
  lastEvidenceUpdate: '2026-04-22T00:00:00Z',
  countries: ['CA', 'US'],
};

beforeAll(async () => {
  await initTestI18n();
});

let panel: EnergyDisruptionsPanel;

beforeEach(() => {
  vi.useFakeTimers();
  panel = new EnergyDisruptionsPanel();
  document.body.appendChild(panel.getElement());
});

afterEach(() => {
  panel.destroy();
  vi.useRealTimers();
  document.body.innerHTML = '';
});

async function renderEvents(events: EnergyDisruptionEntry[]): Promise<HTMLElement> {
  rpc.list.mockResolvedValue({ events, upstreamUnavailable: false, fetchedAt: '2026-11-10T00:00:00Z', classifierVersion: 'v1' });
  await panel.fetchData();
  await vi.advanceTimersByTimeAsync(300);
  return panel.getElement().querySelector<HTMLElement>('tr.ed-row')!;
}

describe('EnergyDisruptionsPanel row labels', () => {
  it('shows the event type, causes and asset by display name', async () => {
    const row = await renderEvents([KEYSTONE_XL]);
    expect(row.querySelector('.ed-event')?.textContent).toContain('Sanction');
    expect(row.textContent).toContain('Upstream refinery → Policy');
    expect(row.textContent).not.toContain('upstream_refinery');
    expect(row.querySelector('.ed-asset-id')?.textContent).toBe('Keystone XL (cancelled 2021)');
    expect(row.dataset.assetId).toBe('keystone-xl-cancelled');
  });

  it('falls back to the asset id for rows seeded before the name join', async () => {
    const row = await renderEvents([{ ...KEYSTONE_XL, assetName: '' }]);
    expect(row.querySelector('.ed-asset-id')?.textContent).toBe('keystone-xl-cancelled');
  });
});
