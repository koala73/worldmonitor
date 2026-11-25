import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { GetChokepointStatusResponse } from '@/generated/client/worldmonitor/supply_chain/v1/service_client';
import { SupplyChainPanel } from '@/components/SupplyChainPanel';
import { initTestI18n } from './helpers/i18n.mts';

function chokepoint(id: string, name: string, aisDisruptions: number, transitDate = '2026-11-22', flowDate = '2026-11-21') {
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
      officialLatestDate: transitDate,
    },
    flowEstimate: { currentMbd: 4.1, baselineMbd: 4.5, flowRatio: 0.91, disrupted: false, latestDate: flowDate },
  };
}

const response = {
  chokepoints: [
    chokepoint('dover_strait', 'Dover Strait', 1), chokepoint('suez', 'Suez Canal', 3),
    chokepoint('panama', 'Panama Canal', 0, '2026-13-22', '2026-02-30'),
    chokepoint('gibraltar', 'Strait of Gibraltar', 0, '2025-11-22', '2025-11-21'),
  ],
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
  vi.setSystemTime(new Date('2026-11-25T06:00:00Z'));
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

  it('omits the observation day when the date does not exist on the calendar', async () => {
    const card = await renderCard('Panama Canal');
    expect(card.textContent).toContain('Week-over-week change');
    expect(card.textContent).toContain('mb/d');
    expect(card.textContent).not.toContain('as of');
  });

  it('includes the year when the observation is from an earlier year', async () => {
    const card = await renderCard('Strait of Gibraltar');
    const rows = [...card.querySelectorAll('.sc-metric-row')].map((row) => row.textContent ?? '');
    expect(rows.find((row) => row.includes('Week-over-week change'))).toContain('as of Nov 22, 2025');
    expect(rows.find((row) => row.includes('mb/d'))).toContain('as of Nov 21, 2025');
  });
});
