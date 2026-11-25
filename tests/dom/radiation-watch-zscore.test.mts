import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { initTestI18n } from './helpers/i18n.mts';

vi.mock('@/services/bootstrap', () => ({
  getHydratedData: () => ({
    fetchedAt: Date.parse('2026-11-10T00:00:00.000Z'),
    epaCount: 0,
    safecastCount: 1,
    observations: [{
      id: 'safecast:jp-fukushima:1',
      source: 'RADIATION_SOURCE_SAFECAST',
      contributingSources: ['RADIATION_SOURCE_SAFECAST'],
      locationName: 'Fukushima',
      country: 'Japan',
      location: { latitude: 37.7608, longitude: 140.4747 },
      value: 74.3,
      unit: 'nSv/h',
      observedAt: Date.parse('2026-01-27T00:00:00.000Z'),
      freshness: 'RADIATION_FRESHNESS_HISTORICAL',
      baselineValue: 68.6,
      delta: 5.7,
      severity: 'RADIATION_SEVERITY_NORMAL',
      confidence: 'RADIATION_CONFIDENCE_LOW',
      corroborated: false,
      conflictingSources: false,
      convertedFromCpm: false,
      sourceCount: 1,
    }],
  }),
}));

import { RadiationWatchPanel } from '@/components/RadiationWatchPanel';
import { fetchRadiationWatch } from '@/services/radiation';

beforeAll(async () => {
  await initTestI18n();
});

let panel: RadiationWatchPanel | undefined;

afterEach(() => {
  panel?.destroy();
  vi.useRealTimers();
  document.body.innerHTML = '';
});

describe('RadiationWatchPanel z-score', () => {
  it('shows an unavailable z-score as unavailable, not zero', async () => {
    const result = await fetchRadiationWatch();
    expect(result.observations[0]?.zScore).toBeNull();

    vi.useFakeTimers();
    panel = new RadiationWatchPanel();
    document.body.appendChild(panel.getElement());
    panel.setData(result);
    await vi.advanceTimersByTimeAsync(300);

    const row = panel.getElement().querySelector('.radiation-row')?.textContent ?? '';
    expect(row).toContain('+5.7 nSv/h · z—');
    expect(row).not.toContain('z0.0');
  });
});
