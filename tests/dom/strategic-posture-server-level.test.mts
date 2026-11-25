import { beforeAll, describe, expect, it, vi } from 'vitest';

import { initTestI18n } from './helpers/i18n.mts';

/**
 * The AI Strategic Posture panel shows the level the AIS relay published
 * (scripts/shared/theater-posture.js). It used to recompute every level in the browser
 * from its own AIS vessel counts, uncapped, plus a country-instability boost,
 * so it showed six theaters CRIT while /api said one was elevated: Yemen/Red
 * Sea went CRIT with no aircraft and no ships because Yemen's instability
 * score was 89, and the Baltic went CRIT on ordinary naval traffic.
 */

const fixtures = vi.hoisted(() => {
  const theater = (overrides: Record<string, unknown>) => ({
    fighters: 0, tankers: 0, awacs: 0, reconnaissance: 0, transport: 0, bombers: 0, drones: 0,
    totalAircraft: 0,
    destroyers: 0, frigates: 0, carriers: 0, submarines: 0, patrol: 0, auxiliaryVessels: 0,
    totalVessels: 0,
    byOperator: {},
    postureLevel: 'normal' as const,
    strikeCapable: false,
    trend: 'stable' as const,
    changePercent: 0,
    summary: '',
    headline: '',
    ...overrides,
  });
  return {
    posture: {
      postures: [
        theater({
          theaterId: 'yemen-redsea-theater', theaterName: 'Yemen/Red Sea', shortName: 'RED SEA', targetNation: 'Yemen',
          centerLat: 16.5, centerLon: 43, bounds: { north: 22, south: 11, east: 54, west: 32 },
        }),
        theater({
          theaterId: 'baltic-theater', theaterName: 'Baltic Theater', shortName: 'BALTIC', targetNation: null,
          totalAircraft: 2, totalVessels: 19,
          centerLat: 58.5, centerLon: 21, bounds: { north: 65, south: 52, east: 32, west: 10 },
        }),
      ],
      totalFlights: 2,
      timestamp: '2026-11-24T18:00:00.000Z',
      cached: true,
    },
    // The browser's own AIS view: far more ships in the Baltic than the relay's strict count.
    vessels: Array.from({ length: 25 }, (_, i) => ({ id: `v${i}`, lat: 58, lon: 20, vesselType: 'destroyer', operator: 'other' })),
    // Scores hydrate separately from posture; tests flip this to model a cold load.
    scores: { YE: 89 } as Record<string, number>,
  };
});

vi.mock('@/services/cached-theater-posture', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/services/cached-theater-posture')>(),
  fetchCachedTheaterPosture: vi.fn(async () => fixtures.posture),
}));

vi.mock('@/services/military-vessels-lazy', () => ({
  getMilitaryVesselsModule: vi.fn(async () => ({
    fetchMilitaryVessels: async () => ({ vessels: fixtures.vessels }),
  })),
  isVesselRuntimeStoppedError: () => false,
}));

vi.mock('@/services/cached-risk-scores', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/services/cached-risk-scores')>(),
  getCachedCountryScoreValue: vi.fn((code: string) => fixtures.scores[code] ?? null),
}));

import { StrategicPosturePanel } from '@/components/StrategicPosturePanel';

beforeAll(async () => {
  await initTestI18n();
});

async function waitFor(check: () => boolean, label: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}`);
}

async function renderPanel() {
  const panel = new StrategicPosturePanel();
  const element = panel.getElement();
  document.body.append(element);
  panel.notifyConnected();
  await waitFor(() => element.querySelectorAll('.posture-theater').length === 2, 'both theaters');
  // Let any follow-up vessel pass land before reading the levels.
  await new Promise((resolve) => setTimeout(resolve, 300));
  return { panel, element };
}

const rowFor = (element: HTMLElement, shortName: string) =>
  [...element.querySelectorAll<HTMLElement>('.posture-theater')]
    .find((row) => row.querySelector('.posture-name')?.textContent?.trim() === shortName);

describe('strategic posture shows the published level', () => {
  it('keeps every theater at the level the API published', async () => {
    const { panel, element } = await renderPanel();

    expect(element.querySelector('.posture-badge.posture-critical')).toBeNull();
    expect(element.querySelector('.posture-badge.posture-elevated')).toBeNull();
    expect(element.querySelectorAll('.posture-badge.posture-normal')).toHaveLength(2);

    panel.destroy();
  });

  it('shows the published vessel count, not the browser AIS count', async () => {
    const { panel, element } = await renderPanel();

    expect(rowFor(element, 'BALTIC')?.querySelector('.posture-chip.naval')?.textContent).toContain('19');

    panel.destroy();
  });

  it('shows a high instability score beside the theater without changing its level', async () => {
    const { panel, element } = await renderPanel();

    const yemen = rowFor(element, 'RED SEA');
    expect(yemen?.querySelector('.posture-badge.posture-normal')).not.toBeNull();
    const note = yemen?.querySelector<HTMLElement>('.posture-chip.instability');
    expect(note?.textContent).toContain('89');
    expect(note?.getAttribute('title')).toContain('Yemen');
    expect(rowFor(element, 'BALTIC')?.querySelector('.posture-chip.instability')).toBeNull();

    panel.destroy();
  });

  it('adds the instability chip when scores arrive after the first render', async () => {
    fixtures.scores = {};
    try {
      const { panel, element } = await renderPanel();
      expect(rowFor(element, 'RED SEA')?.querySelector('.posture-chip.instability')).toBeNull();

      fixtures.scores = { YE: 89 };
      // What data-loader calls once fresh CII scores are applied.
      panel.refreshInstabilityNotes();
      await waitFor(
        () => rowFor(element, 'RED SEA')?.querySelector('.posture-chip.instability') != null,
        'the instability chip after scores hydrate',
      );
      expect(rowFor(element, 'RED SEA')?.querySelector('.posture-badge.posture-normal')).not.toBeNull();

      panel.destroy();
    } finally {
      fixtures.scores = { YE: 89 };
    }
  });

  it('keeps the no-data screen when scores change after the posture went empty', async () => {
    const { panel, element } = await renderPanel();

    panel.updatePostures({ ...fixtures.posture, postures: [] });
    await waitFor(() => element.querySelector('.posture-no-data') != null, 'the no-data screen');

    panel.refreshInstabilityNotes();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(element.querySelector('.posture-no-data')).not.toBeNull();
    expect(element.querySelectorAll('.posture-theater')).toHaveLength(0);

    panel.destroy();
  });
});
