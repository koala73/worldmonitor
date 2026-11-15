import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { fillWaterExtentRow, renderWaterExtentRow, waterCard, waterExtentLines } from '@/components/water-card';
import type { ReservoirLevel } from '@/services/climate';
import { reservoirAtPoint } from '@/services/climate/reservoir-context';
import { t } from '@/services/i18n';
import { initTestI18n } from './helpers/i18n.mts';

beforeAll(async () => { await initTestI18n(); });
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-14T12:00:00Z'));
});
afterEach(() => { vi.useRealTimers(); });

const ctx = () => ({ t, locale: 'en-US', nowMs: Date.now() });
const reading = (time: string, waterPercent: number) => ({ timeMs: Date.parse(time), waterPercent, waterKm2: 318.5, platform: 'Sentinel-1A', relativeOrbit: 43 });
const extent = { latest: reading('2026-11-09T03:40:00Z', 62.4), sameOrbitPrevious: reading('2026-10-28T03:40:00Z', 65.5), boxKm2: 510 };

const level = {
  id: 'kariba', name: 'Lake Kariba', country: 'ZM', riparians: [], river: 'Zambezi', lat: -16.9, lon: 28.0, tags: [], why: '',
  latest: { observedAt: new Date('2026-09-06T00:00:00Z'), levelM: 478.1, madM: 0.1, segments: 4, ageDays: 69 },
  prevDate: null, changePrevM: null, change30dM: null, change90dM: null, change365dM: -0.8, seasonalAnomalyM: -1.6, seasonalZ: -2.2,
  recordMinM: null, recordMaxM: null, recordStart: null, percentOfRange: null, recordLow: false, recordHigh: false, status: 'low', series: [],
} as ReservoirLevel;

describe('water card (#10714)', () => {
  it('dates the radar reading and compares it only with the same orbit', () => {
    expect(waterExtentLines(extent, ctx())).toEqual([
      '62.4% open water (318.5 km²) on Nov 9',
      '\u22123.1 points since Oct 28 on the same orbit',
    ]);
    expect(waterExtentLines({ ...extent, sameOrbitPrevious: undefined }, ctx())[1]).toBe(t('components.reservoirLevels.water.extentNoComparison'));
    expect(waterExtentLines(null, ctx())).toEqual([t('components.reservoirLevels.water.extentNone')]);
  });

  it('fills the popup row in place', () => {
    const holder = document.createElement('div');
    holder.innerHTML = renderWaterExtentRow('kariba', t);
    const row = holder.firstElementChild as HTMLElement;
    expect(row.dataset.wlWaterExtent).toBe('kariba');
    fillWaterExtentRow(row, extent, ctx());
    expect([...row.querySelectorAll('.wl-water-extent-line')].map((el) => el.textContent)).toHaveLength(2);
  });

  it('shows all four rows, each with its date, and says none is a live reading', () => {
    const pass = { status: 'pass' as const, timeMs: Date.parse('2026-11-20T08:00:00Z'), elementsEpochMs: Date.parse('2026-11-13T00:00:00Z'), windowEndMs: Date.parse('2026-11-21T00:00:00Z') };
    const card = waterCard('Lake Kariba', {
      level, extent, nextPass: pass,
      optical: { datetime: '2026-11-12T08:10:00Z', profileId: 'sentinel-2', archive: 'planetary-computer', candidates: [] },
    }, ctx());
    const rows = [...card.querySelectorAll<HTMLElement>('.wl-water-row')];
    expect(rows.map((r) => r.dataset.row)).toEqual(['level', 'extent', 'optical', 'pass']);
    const text = (name: string) => rows.find((r) => r.dataset.row === name)!.querySelector('.wl-water-value')!.textContent;
    expect(text('level')).toMatch(/Sep 6|6 Sep/);
    expect(text('extent')).toContain('Nov 9');
    expect(text('optical')).toBe('Nov 12 · Sentinel-2');
    expect(text('pass')).toContain('Nov 20');
    expect(card.querySelector('.wl-water-note')!.textContent).toContain('not a live reading');
  });

  it('says what is missing instead of leaving a row out', () => {
    const card = waterCard('Lake Kariba', { level: null, extent: null, optical: null, nextPass: null }, ctx());
    expect(card.querySelectorAll('.wl-water-row')).toHaveLength(4);
    expect(card.textContent).toContain(t('components.reservoirLevels.water.opticalNone'));
  });

  it('finds the reservoir for an evidence point inside its core box or at its own map point', () => {
    expect(reservoirAtPoint(11, 35.15)?.id).toBe('gerd');
    expect(reservoirAtPoint(10.9, 35.3)?.id, 'inside the core box').toBe('gerd');
    const merowe = reservoirAtPoint(18.75, 32.1);
    expect(merowe?.id, 'map point outside its core box').toBe('merowe');
    expect(reservoirAtPoint(0, 0)).toBeNull();
  });
});
