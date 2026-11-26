import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const hydration = vi.hoisted(() => ({ data: undefined as unknown }));
vi.mock('@/services/bootstrap', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/bootstrap')>()),
  getHydratedData: vi.fn((key: string) => (key === 'thermalEscalation' ? hydration.data : undefined)),
}));

import { fetchThermalEscalations } from '@/services/thermal-escalation';
import { ThermalEscalationPanel } from '@/components/ThermalEscalationPanel';
import { initTestI18n } from './helpers/i18n.mts';

function protoCluster(id: string, latitude: number, longitude: number) {
  return {
    id,
    countryCode: 'IR',
    countryName: 'Iran',
    regionLabel: 'Iran',
    centroid: { latitude, longitude },
    observationCount: 57,
    uniqueSourceCount: 2,
    maxBrightness: 360,
    avgBrightness: 330,
    maxFrp: 120,
    totalFrp: 1400,
    nightDetectionShare: 0.4,
    baselineExpectedCount: 10,
    baselineExpectedFrp: 300,
    countDelta: 47,
    frpDelta: 1100,
    zScore: 2,
    persistenceHours: 30,
    status: 'THERMAL_STATUS_PERSISTENT',
    context: 'THERMAL_CONTEXT_CONFLICT_ADJACENT',
    confidence: 'THERMAL_CONFIDENCE_HIGH',
    strategicRelevance: 'THERMAL_RELEVANCE_HIGH',
    nearbyAssets: [],
    narrativeFlags: [],
    firstDetectedAt: '2026-11-24T00:00:00.000Z',
    lastDetectedAt: '2026-11-25T00:00:00.000Z',
  };
}

const LIVE_SUMMARY = {
  clusterCount: 586,
  elevatedCount: 40,
  spikeCount: 12,
  persistentCount: 71,
  conflictAdjacentCount: 397,
  highRelevanceCount: 76,
};

beforeAll(async () => {
  await initTestI18n();
});

beforeEach(() => {
  document.body.replaceChildren();
  hydration.data = {
    fetchedAt: '2026-11-25T00:00:00.000Z',
    observationWindowHours: 24,
    sourceVersion: 'thermal-escalation-v1',
    clusters: [
      protoCluster('a', 30.2813, 47.3688),
      protoCluster('b', 31.3203, 48.6692),
      protoCluster('c', -2.5, -60.25),
    ],
    summary: LIVE_SUMMARY,
  };
});

describe('ThermalEscalationPanel', () => {
  it('keeps the bootstrap summary totals instead of counting the rendered rows', async () => {
    const watch = await fetchThermalEscalations(2);
    expect(watch.clusters).toHaveLength(2);
    expect(watch.summary).toEqual(LIVE_SUMMARY);

    const panel = new ThermalEscalationPanel();
    document.body.appendChild(panel.getElement());
    panel.notifyConnected();
    panel.setData(watch);
    await vi.waitFor(() => expect(document.querySelector('.te-stat')).not.toBeNull());
    const totals = [...document.querySelectorAll('.te-stat')].map((el) => el.textContent?.replace(/\s+/g, ' ').trim());
    expect(totals[0]).toBe('586 Total');
  });

  it('shows each cluster location so rows with the same region are distinguishable', async () => {
    const watch = await fetchThermalEscalations(3);
    const panel = new ThermalEscalationPanel();
    document.body.appendChild(panel.getElement());
    panel.notifyConnected();
    panel.setData(watch);
    await vi.waitFor(() => expect(document.querySelector('.te-card')).not.toBeNull());
    const rows = [...document.querySelectorAll('.te-card')].map((card) => [
      card.querySelector('.te-region')?.textContent?.trim(),
      card.querySelector('.te-coords')?.textContent?.trim(),
    ]);
    expect(rows).toEqual([
      ['Iran', '30.28°N 47.37°E'],
      ['Iran', '31.32°N 48.67°E'],
      ['Iran', '2.50°S 60.25°W'],
    ]);
  });
});
