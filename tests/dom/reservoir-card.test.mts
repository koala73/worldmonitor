import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { reservoirCard, reservoirSummaryLine } from '@/components/reservoir-card';
import { reservoirChipTone } from '@/components/reservoir-levels-view';
import type { ReservoirLevel } from '@/services/climate';
import { t } from '@/services/i18n';
import { initTestI18n } from './helpers/i18n.mts';

beforeAll(async () => { await initTestI18n(); });
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-14T12:00:00Z'));
});
afterEach(() => { vi.useRealTimers(); });

const ctx = () => ({ t, locale: 'en-US', nowMs: Date.now() });
const series = Array.from({ length: 12 }, (_, i) => {
  const date = new Date(Date.UTC(2025, 9 + i, 6)).toISOString().slice(0, 10);
  return i < 4 ? { date, levelM: 80 + i * 0.1 } : { date, levelM: 80 - i * 0.2, baselineM: 80.4 };
});

function reservoir(overrides: Partial<ReservoirLevel> = {}): ReservoirLevel {
  return {
    id: 'kremenchuk', name: 'Kremenchuk Reservoir', country: 'UA', riparians: [], river: 'Dnieper', lat: 49.2, lon: 32.6,
    tags: ['hydropower'], why: '', latest: { observedAt: new Date('2026-09-06T00:00:00Z'), levelM: 79.1, madM: 0.1, segments: 4, ageDays: 69 },
    prevDate: null, changePrevM: null, change30dM: null, change90dM: null, change365dM: -0.8, seasonalAnomalyM: -1.6, seasonalZ: -2.2,
    recordMinM: null, recordMaxM: null, recordStart: null, percentOfRange: null, recordLow: false, recordHigh: false, status: 'low', series,
    ...overrides,
  };
}

describe('reservoir card', () => {
  it('shows name, river, chip, delta, measured date and the level with its seasonal baseline', () => {
    const card = reservoirCard(reservoir(), ctx());
    expect(card.querySelector('.wl-card-name')?.textContent).toBe('Kremenchuk Reservoir');
    expect(card.querySelector('.wl-card-river')?.textContent).toBe('Dnieper');
    expect(card.querySelector('.wl-chip')?.textContent).toBeTruthy();
    expect(card.querySelector('.wl-card-delta')?.textContent).toMatch(/1\.6 m/);
    expect(card.querySelector('.wl-card-measured')?.textContent).toBe('Measured Sep 6 · 69d ago');
    expect(card.querySelector('.wl-card-measured')?.getAttribute('title')).toContain('ATL13');
    const baseline = card.querySelector('.wl-card-spark svg .mini-sparkline-baseline');
    expect(baseline?.getAttribute('stroke-dasharray')).toBe('2 2');
    expect(card.querySelectorAll('.wl-card-spark polyline')).toHaveLength(2);
    expect(card.textContent).not.toMatch(/ACLED|live/i);
  });

  it('draws no baseline where the snapshot carries none', () => {
    const card = reservoirCard(reservoir({ series: series.map(({ date, levelM }) => ({ date, levelM })) }), ctx());
    expect(card.querySelectorAll('.wl-card-spark polyline')).toHaveLength(1);
  });

  it('uses amber for low or high and green for normal', () => {
    expect(reservoirChipTone('low')).toBe('beyond');
    expect(reservoirChipTone('high')).toBe('beyond');
    expect(reservoirChipTone('normal')).toBe('ok');
    expect(reservoirCard(reservoir({ status: 'normal', seasonalZ: 0.2 }), ctx()).classList.contains('wl-tone-ok')).toBe(true);
  });

  it('shows a current predicted crossing, drops an expired one, and never shows it in the compact form', () => {
    const windowEndMs = Date.parse('2026-11-21T12:00:00Z');
    const pass = { status: 'pass' as const, timeMs: Date.parse('2026-11-21T03:14:00Z'), windowEndMs, elementsEpochMs: Date.parse('2026-11-13T18:00:00Z') };
    expect(reservoirCard(reservoir(), ctx(), { nextPass: pass }).querySelector('.wl-card-next')?.textContent).toMatch(/^Predicted ICESat-2 crossing: Nov 21, 03:14 UTC$/);
    const none = { status: 'none' as const, windowEndMs, elementsEpochMs: pass.elementsEpochMs };
    expect(reservoirCard(reservoir(), ctx(), { nextPass: none }).querySelector('.wl-card-next')?.textContent).toBe('Predicted ICESat-2 crossing: none in this window (to Nov 21)');
    const expired = { ...pass, timeMs: Date.parse('2026-11-14T03:00:00Z') };
    expect(reservoirCard(reservoir(), ctx(), { nextPass: expired }).querySelector('.wl-card-next')).toBeNull();
    expect(reservoirCard(reservoir(), ctx(), { nextPass: pass, compact: true }).querySelector('.wl-card-next')).toBeNull();
  });

  it('summarises how many reservoirs are beyond the baseline and the latest pass date', () => {
    const line = reservoirSummaryLine([
      reservoir(),
      reservoir({ id: 'b', seasonalZ: 1.8, status: 'high', latest: { observedAt: new Date('2026-08-01T00:00:00Z'), levelM: 1, madM: 0, segments: 1, ageDays: 105 } }),
      reservoir({ id: 'c', seasonalZ: 0.3, status: 'normal' }),
    ], ctx());
    expect(line.textContent).toBe('2 of 3 reservoirs beyond seasonal baseline · latest ICESat-2 pass Sep 6');
    expect(line.querySelectorAll('.wl-summary-part')).toHaveLength(2);
  });
});
