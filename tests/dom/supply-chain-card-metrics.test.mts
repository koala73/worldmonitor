import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { GetChokepointStatusResponse } from '@/generated/client/worldmonitor/supply_chain/v1/service_client';
import { SupplyChainPanel } from '@/components/SupplyChainPanel';
import { initTestI18n } from './helpers/i18n.mts';

function chokepoint(id: string, name: string, aisDisruptions: number) {
  return {
    id,
    name,
    status: 'yellow',
    activeWarnings: 0,
    aisDisruptions,
    navigationalWarningsAvailable: false,
    aisSnapshotAvailable: true,
    affectedRoutes: [],
    description: '',
    directions: [],
    disruptionScore: 20,
    transitSummary: {
      dataAvailable: true,
      todayCountsAvailable: true,
      todayTotal: 41,
      wowChangePct: -3.2,
      officialLatestDate: '2026-11-22',
    },
    flowEstimate: { currentMbd: 4.1, baselineMbd: 4.5, flowRatio: 0.91, disrupted: false, latestDate: '2026-11-21' },
  };
}

const response = {
  chokepoints: [chokepoint('dover_strait', 'Dover Strait', 1), chokepoint('suez', 'Suez Canal', 3)],
  fetchedAt: '2026-11-25T04:19:10.309Z',
  upstreamUnavailable: false,
} as unknown as GetChokepointStatusResponse;

async function renderCard(name: string): Promise<Element> {
  const panel = new SupplyChainPanel();
  panel.updateChokepointStatus(response);
  await vi.advanceTimersByTimeAsync(151);
  return panel.getElement().querySelector(`[data-cp-id="${name}"]`)!;
}

beforeAll(async () => {
  await initTestI18n();
});

beforeEach(() => {
  document.body.replaceChildren();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('supply-chain chokepoint card metrics', () => {
  it('uses the singular label for one ship tracking disruption', async () => {
    const card = await renderCard('Dover Strait');
    expect(card.textContent).toContain('1 ship tracking disruption');
    expect(card.textContent).not.toContain('1 ship tracking disruptions');
  });

  it('uses the plural label for several ship tracking disruptions', async () => {
    const card = await renderCard('Suez Canal');
    expect(card.textContent).toContain('3 ship tracking disruptions');
  });

  it('dates the week-over-week change and the flow estimate with their own observation days', async () => {
    const card = await renderCard('Suez Canal');
    const rows = [...card.querySelectorAll('.sc-metric-row')].map((row) => row.textContent ?? '');
    expect(rows.find((row) => row.includes('Week-over-week change'))).toContain('as of Nov 22');
    expect(rows.find((row) => row.includes('mb/d'))).toContain('as of Nov 21');
  });
});
