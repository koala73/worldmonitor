import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { initTestI18n } from './helpers/i18n.mts';

import type { ArchiveItem } from '@/services/orbital/archive-stac';
import type { YearlyLook, YearlyLooks } from '@/services/orbital/timelapse';
import { openOrbitalTimelapse, type TimelapseDependencies } from '@/components/OrbitalTimelapse';

const stac = vi.hoisted(() => ({ search: vi.fn() }));
vi.mock('@/services/orbital/archive-stac', async (original) => ({ ...(await original<object>()), searchStacArchive: stac.search }));

const { CLEAR_LOOK_CLOUD_PCT, searchYearlyLooks, seasonWindow } = await import('@/services/orbital/timelapse');

const NOW = Date.UTC(2026, 10, 13, 12);
const point = { lat: 25.003, lon: 54.99 };
const crop = (id: string) => `https://planetarycomputer.microsoft.com/api/data/v1/item/bbox/54.96,24.97,55.02,25.03.png?collection=sentinel-2-l2a&item=${id}`;

function look(year: number, month = 9, platform = 'Sentinel-2A'): YearlyLook {
  const timeMs = Date.UTC(year, month, 21, 7);
  return { key: `s2:${year}`, year, timeMs, cloudCoverPct: 1, cloudApplies: true, imageUrl: crop(`S2_${year}`), platform, platformCode: `S2${platform.slice(-1)}` };
}

function item(startMs: number, cloudCoverPct: number | null, over: Partial<ArchiveItem> = {}): ArchiveItem {
  return {
    archive: 'planetary-computer', collection: 'sentinel-2-l2a', itemId: `S2_${startMs}_${cloudCoverPct}`, profileId: 'sentinel-2', platform: 'Sentinel-2B', orbit: 1,
    startMs, endMs: startMs + 5_000, cloudCoverPct, sunElevationDeg: 50, resolutionM: 10, previewUrl: null, renderedPreviewHref: null, classification: null, ...over,
  };
}

const years = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => look(from + i));
const looks = (list: YearlyLook[], failures: YearlyLooks['failures'] = []) => vi.fn(async (): Promise<YearlyLooks> => ({ looks: list, failures }));
const loaded: TimelapseDependencies['loadImage'] = async () => {};
const page = () => document.querySelector<HTMLElement>('.otl-page');
const text = () => page()?.textContent ?? '';
const settle = async () => {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};
const shownYear = () => page()!.querySelector('.otl-year-number')!.textContent;

function open(deps: TimelapseDependencies, returnFocusTo: HTMLElement | null = null) {
  return openOrbitalTimelapse({ point, nowMs: NOW, place: '25.003°N 54.990°E' }, returnFocusTo, { loadImage: loaded, prefersReducedMotion: () => false, ...deps });
}

beforeAll(async () => {
  await initTestI18n();
});

afterEach(() => {
  document.querySelector<HTMLButtonElement>('.oiv-close')?.click();
  document.body.replaceChildren();
  stac.search.mockReset();
  vi.useRealTimers();
});

describe('yearly looks', () => {
  it('searches a different season each year so the run crosses every quarter', () => {
    const months = [2015, 2016, 2017, 2018, 2019].map((year) => new Date(seasonWindow(year).startMs).getUTCMonth());
    expect(months).toEqual([9, 0, 3, 6, 9]);
    const window = seasonWindow(2016);
    expect(new Date(window.endMs).toISOString()).toBe('2016-03-31T23:59:59.999Z');
  });

  it('keeps the least cloudy Sentinel-2 scene under 30% for each year, leaves out years without one, and reports failures', async () => {
    stac.search.mockImplementation(async (_archive: string, query: { window: { startMs: number } }) => {
      const year = new Date(query.window.startMs).getUTCFullYear();
      const at = query.window.startMs + 86_400_000;
      if (year === 2017) return { status: 'failed', failure: { archive: 'planetary-computer', reason: 'timeout' } };
      if (year === 2018) return { status: 'ok', archive: 'planetary-computer', items: [item(at, CLEAR_LOOK_CLOUD_PCT), item(at, null)] };
      return {
        status: 'ok',
        archive: 'planetary-computer',
        items: [item(at, 12), item(at + 1, 3, { platform: 'Sentinel-2C' }), item(at + 2, 1, { profileId: 'landsat', collection: 'landsat-c2-l2' })],
      };
    });
    const result = await searchYearlyLooks(point, NOW);
    const expectedYears = years(2015, 2026).map((l) => l.year).filter((year) => year !== 2017 && year !== 2018);
    expect(result.looks.map((l) => l.year)).toEqual(expectedYears);
    expect(result.looks.every((l) => l.cloudCoverPct === 3 && l.platformCode === 'S2C')).toBe(true);
    expect(result.looks.every((l) => new URL(l.imageUrl!).hostname === 'planetarycomputer.microsoft.com')).toBe(true);
    expect(result.failures).toEqual([{ archive: 'planetary-computer', reason: 'timeout' }]);
  });
});

describe('orbital time-lapse page', () => {
  it('plays one clear look a year with its counter, year, date and platform, list and credit', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    open({ searchLooks: looks(years(2015, 2026)) });
    await vi.waitFor(() => expect(page()!.querySelector('.otl-year-number')).not.toBeNull());
    expect(page()!.querySelector('.oiv-crumb')!.textContent).toBe('Time-lapse / 25.003°N 54.990°E');
    expect(page()!.querySelector('.oiv-counter')!.textContent).toBe('01 / 12');
    expect(shownYear()).toBe('2015');
    expect(page()!.querySelector('.otl-year-detail')!.textContent).toBe('21 OCT 2015 · SENTINEL-2A');
    expect(page()!.querySelectorAll('.otl-row')).toHaveLength(12);
    expect(page()!.querySelectorAll('.otl-tick')).toHaveLength(12);
    expect(text()).toContain('12 clear looks · one a year');
    expect(text()).toContain('Contains modified Copernicus Sentinel data 2015–2026');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(shownYear()).toBe('2016');
    expect(page()!.querySelector('.otl-row[aria-current="true"] .otl-row-year')!.textContent).toBe('2016');
  });

  it('jumps to a year from the list and pauses playback', async () => {
    open({ searchLooks: looks(years(2015, 2026)) });
    await vi.waitFor(() => expect(page()!.querySelector('.otl-row:not([disabled])')).not.toBeNull());
    page()!.querySelectorAll<HTMLButtonElement>('.otl-row')[7]!.click();
    await settle();
    expect(shownYear()).toBe('2022');
    expect(page()!.querySelector('[data-action="toggle"]')!.getAttribute('aria-pressed')).toBe('false');
  });

  it('advances a frame only after it has decoded, keeping the shown frame meanwhile', async () => {
    let release: (() => void) | null = null;
    let preloaded = 0;
    const loadImage: TimelapseDependencies['loadImage'] = () => {
      preloaded += 1;
      if (preloaded <= 4) return Promise.resolve();
      return new Promise<void>((resolve) => { release = resolve; });
    };
    open({ searchLooks: looks(years(2015, 2018)), loadImage, prefersReducedMotion: () => true });
    await vi.waitFor(() => expect(page()!.querySelector('[data-action="frame-next"]')).not.toBeNull());
    page()!.querySelector<HTMLButtonElement>('[data-action="frame-next"]')!.click();
    await settle();
    expect(shownYear()).toBe('2015');
    release!();
    await settle();
    expect(shownYear()).toBe('2016');
    expect(page()!.querySelector<HTMLImageElement>('.oiv-image')!.getAttribute('src')).toBe(crop('S2_2016'));
  });

  it('gives reduced-motion users a stepper and leaves out looks that fail to load', async () => {
    const failing = crop('S2_2017');
    open({ searchLooks: looks(years(2015, 2020)), prefersReducedMotion: () => true, loadImage: async (url) => { if (url === failing) throw new Error('x'); } });
    await vi.waitFor(() => expect(page()!.querySelector('.oiv-stage[data-timelapse="stepper"]')).not.toBeNull());
    expect(page()!.querySelector('[data-action="toggle"]')).toBeNull();
    expect(page()!.querySelectorAll('.otl-row')).toHaveLength(5);
    expect(page()!.querySelector('.oiv-counter')!.textContent).toBe('01 / 05');
  });

  it('says how few looks there are instead of animating fewer than four', async () => {
    open({ searchLooks: looks(years(2024, 2026)) });
    await vi.waitFor(() => expect(page()!.querySelector('[data-timelapse="insufficient"]')).not.toBeNull());
    expect(text()).toContain('Clear yearly looks of this place: 3. A time-lapse needs 4.');
  });

  it('names the archive that timed out and retries', async () => {
    const searchLooks = vi.fn(async (): Promise<YearlyLooks> => ({ looks: [], failures: [{ archive: 'planetary-computer', reason: 'timeout' }] }));
    open({ searchLooks });
    await vi.waitFor(() => expect(text()).toContain('Microsoft Planetary Computer did not answer in time, so the yearly looks are missing.'));
    searchLooks.mockResolvedValueOnce({ looks: years(2015, 2020), failures: [{ archive: 'planetary-computer', reason: 'timeout' }] });
    page()!.querySelector<HTMLButtonElement>('[data-action="retry"]')!.click();
    await vi.waitFor(() => expect(page()!.querySelector('.otl-year-number')).not.toBeNull());
    expect(text()).toContain('Missing years because Microsoft Planetary Computer did not answer: 1.');
  });

  it('never renders a look from a host outside the archive allowlist', async () => {
    open({ searchLooks: looks([...years(2015, 2019), { ...look(2020), imageUrl: 'https://evil.example/x.png' }]) });
    await vi.waitFor(() => expect(page()!.querySelector('.otl-year-number')).not.toBeNull());
    for (let i = 0; i < 6; i += 1) {
      page()!.querySelectorAll<HTMLButtonElement>('.otl-row')[i]?.click();
      await settle();
    }
    expect([...document.querySelectorAll('img')].every((img) => new URL(img.src).hostname === 'planetarycomputer.microsoft.com')).toBe(true);
  });

  it('closes on Escape and returns focus to the control that opened it', async () => {
    const trigger = document.body.appendChild(document.createElement('button'));
    open({ searchLooks: looks(years(2015, 2020)) }, trigger);
    await vi.waitFor(() => expect(page()!.querySelector('.otl-year-number')).not.toBeNull());
    page()!.querySelector<HTMLButtonElement>('[data-action="toggle"]')!.focus();
    page()!.querySelector<HTMLButtonElement>('[data-action="toggle"]')!.click();
    document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(page()).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});
