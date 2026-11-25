import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const transport = vi.hoisted(() => ({
  fetchTorontoSafetyDataset: vi.fn(),
}));
vi.mock('@/services/toronto-safety', () => ({
  fetchTorontoSafetyDataset: transport.fetchTorontoSafetyDataset,
}));

import type { TorontoAnnualAggregate } from '@/generated/client/worldmonitor/safety/v1/service_client';
import { TorontoSafetyPanel } from '@/components/TorontoSafetyPanel';
import { initTestI18n } from './helpers/i18n.mts';

function aggregate(objectId: number, neighbourhood: string, eventCount: number, divisionOriginal: string, divisionFinal: string): TorontoAnnualAggregate {
  return {
    id: `tps-calls-${objectId}`, objectId, eventYear: 2025,
    divisionOriginal, divisionFinal, neighbourhood, eventCount, incidentPoint: false,
  };
}

const AGGREGATES = [
  aggregate(5212, 'South Parkdale', 1, 'D14', 'D11'),
  aggregate(5213, 'NSA', 13, 'D14', 'D11'),
  aggregate(5214, 'NSA', 15, 'D11', 'D11'),
];

async function aggregateRows(): Promise<Array<{ title: string; meta: string }>> {
  const panel = new TorontoSafetyPanel();
  const root = panel.getElement();
  document.body.appendChild(root);
  panel.notifyConnected();
  await vi.waitFor(() => expect(root.querySelector('.toronto-safety-panel')).not.toBeNull());
  [...root.querySelectorAll<HTMLButtonElement>('.panel-tab')].find((tab) => tab.textContent === 'Annual calls attended')!.click();
  return [...root.querySelectorAll('.toronto-safety-list .intel-item')].map((item) => ({
    title: item.querySelector('.intel-item-title')!.textContent!,
    meta: item.querySelector('.intel-item-meta')!.textContent!,
  }));
}

beforeAll(async () => {
  await initTestI18n();
});

beforeEach(() => {
  document.body.replaceChildren();
  transport.fetchTorontoSafetyDataset.mockReset();
  transport.fetchTorontoSafetyDataset.mockImplementation(async (dataset: string) => (
    dataset === 'annual_aggregate'
      ? { dataset, occurrences: [], aggregates: AGGREGATES, sourceUrl: '', attribution: '', disclaimer: '', degraded: false, unavailable: false }
      : { dataset, occurrences: [], aggregates: [], sourceUrl: '', attribution: '', disclaimer: '', degraded: false, unavailable: false }
  ));
});

describe('TorontoSafetyPanel annual calls attended rows', () => {
  it('uses the singular for a single call', async () => {
    const rows = await aggregateRows();
    expect(rows.map((row) => row.title)).toEqual(['1 call attended', '13 calls attended', '15 calls attended']);
  });

  it('shows the original and final division so split aggregates are distinguishable', async () => {
    const rows = await aggregateRows();
    expect(rows.map((row) => row.meta)).toEqual([
      '2025 · Original D14 · Final D11',
      '2025 · Original D14 · Final D11',
      '2025 · D11',
    ]);
  });
});
