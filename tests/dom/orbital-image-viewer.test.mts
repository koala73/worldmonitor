import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { initTestI18n } from './helpers/i18n.mts';

import type { GeostationaryRow } from '@/services/orbital/archive-gibs';
import type { MatchedAcquisition, OrbitalEvidence } from '@/services/orbital/match';
import type { SceneHistory } from '@/services/orbital/timelapse';
import { IMAGE_CREDIT, OrbitalWatchPage } from '@/components/OrbitalWatchPage';
import {
  openOrbitalImageViewer,
  sceneFromAcquisition,
  sceneFromFrame,
  subjectForImage,
  type ViewerDependencies,
} from '@/components/OrbitalImageViewer';

const NOW = Date.UTC(2026, 10, 13, 12);
const DAY = 86_400_000;
const point = { lat: 25.2048, lon: 55.2708 };
const crop = (id: string) => `https://planetarycomputer.microsoft.com/api/data/v1/item/bbox/55.25,25.18,55.29,25.22.png?collection=sentinel-2-l2a&item=${id}`;

function scene(daysAgo: number, cloudCoverPct: number | null, over: Partial<MatchedAcquisition> = {}): MatchedAcquisition {
  const startMs = NOW - daysAgo * DAY;
  return {
    key: `sentinel-2c:1:${startMs}`, profileId: 'sentinel-2', platform: 'sentinel-2c', orbit: 1, startMs, endMs: startMs + 5_000, items: [],
    pass: null, condition: 'clear', cloudCoverPct, sunElevationDeg: 40, resolutionM: 10, imageUrl: crop(`S2C_${daysAgo}`), ...over,
  };
}

const meteosat: GeostationaryRow = {
  kind: 'geostationary', archive: 'eumetsat', source: 'Meteosat-12', layer: 'mtg_fd:rgb_geocolour', noradId: 54_743, cadenceMinutes: 10,
  latest: { time: new Date(NOW - 600_000).toISOString(), imageUrl: 'https://view.eumetsat.int/geoserver/wms?SERVICE=WMS&REQUEST=GetMap&LAYERS=mtg_fd%3Argb_geocolour&CRS=EPSG%3A4326&BBOX=25.1,55.1,25.3,55.4' },
};

const history = (scenes: MatchedAcquisition[]): ViewerDependencies['searchHistory'] => vi.fn(async (): Promise<SceneHistory> => ({ status: 'ok', scenes }));
const loaded: ViewerDependencies['loadImage'] = async () => {};
const viewer = () => document.querySelector<HTMLElement>('.oiv-dialog');
const viewerText = () => viewer()?.textContent ?? '';
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function open(selected: MatchedAcquisition, deps: ViewerDependencies, others: MatchedAcquisition[] = [], returnFocusTo: HTMLElement | null = null) {
  return openOrbitalImageViewer({ point, nowMs: NOW, selected: sceneFromAcquisition(selected), scenes: others.map(sceneFromAcquisition), historyProfile: selected.profileId }, returnFocusTo, deps);
}

beforeAll(async () => {
  await initTestI18n();
});

afterEach(() => {
  document.querySelector<HTMLButtonElement>('.oiv-close')?.click();
  document.body.replaceChildren();
  vi.useRealTimers();
});

describe('orbital image viewer', () => {
  it('shows the opened image with its source credit and a north arrow from the crop grid', async () => {
    const landsat = scene(3, 5, { profileId: 'landsat', platform: 'landsat-9', key: 'landsat-9:1:x' });
    open(landsat, { searchHistory: history([]) });
    await settle();
    expect(viewer()!.querySelector('img.oiv-image')!.getAttribute('src')).toBe(landsat.imageUrl);
    expect(viewerText()).toContain(IMAGE_CREDIT.usgs);
    expect(viewer()!.querySelector('.oiv-north')!.getAttribute('aria-label')).toBe('North is up');
  });

  it('credits EUMETSAT on a Meteosat frame and offers no time-lapse for a single frame', () => {
    openOrbitalImageViewer({ point, nowMs: NOW, selected: sceneFromFrame(meteosat)!, scenes: [], historyProfile: null }, null, {});
    expect(viewerText()).toContain(IMAGE_CREDIT.eumetsat);
    expect(viewerText()).not.toContain(IMAGE_CREDIT.gibsAcknowledgement);
    expect(viewer()!.querySelector('.oiv-timelapse')).toBeNull();
  });

  it('offers compare only when a second scene of the same collection exists', async () => {
    const selected = scene(1, 5);
    const radar = scene(40, null, { profileId: 'sentinel-1', platform: 'sentinel-1c', key: 'sentinel-1c:1:x' });
    open(selected, { searchHistory: history([selected]) }, [radar]);
    await settle();
    expect(viewer()!.querySelector('.oiv-slider')).toBeNull();
    expect(viewerText()).toContain('No other scene of this collection to compare with.');

    document.querySelector<HTMLButtonElement>('.oiv-close')!.click();
    open(selected, { searchHistory: history([selected, scene(20, 5)]) });
    await settle();
    expect(viewer()!.querySelectorAll('.oiv-slider img')).toHaveLength(2);
    expect(viewer()!.querySelector('input[type="range"]')).not.toBeNull();
  });

  it('defaults the compare picker to the nearest low-cloud scene at least 30 days away', async () => {
    const selected = scene(1, 5);
    const nearButRecent = scene(10, 2);
    const farButCloudy = scene(32, 60);
    const expected = scene(38, 8);
    const further = scene(55, 1);
    open(selected, { searchHistory: history([selected, nearButRecent, farButCloudy, expected, further]) });
    await settle();
    const pressed = viewer()!.querySelector<HTMLElement>('.oiv-date[aria-pressed="true"]')!;
    expect(pressed.dataset.key).toBe(expected.key);
    expect(viewer()!.querySelector('.oiv-before')!.getAttribute('src')).toBe(expected.imageUrl);

    viewer()!.querySelector<HTMLButtonElement>(`.oiv-date[data-key="${nearButRecent.key}"]`)!.click();
    expect(viewer()!.querySelector('.oiv-before')!.getAttribute('src')).toBe(nearButRecent.imageUrl);
  });

  it('moves the compare default to a clear scene from history once it arrives, unless a date was picked', async () => {
    const selected = scene(1, 5);
    const recentCloudy = scene(4, 50);
    const clearMonthAgo = scene(35, 3);
    open(selected, { searchHistory: history([selected, recentCloudy, clearMonthAgo]) }, [recentCloudy]);
    expect(viewer()!.querySelector('.oiv-before')!.getAttribute('src')).toBe(recentCloudy.imageUrl);
    await settle();
    expect(viewer()!.querySelector('.oiv-before')!.getAttribute('src')).toBe(clearMonthAgo.imageUrl);

    document.body.replaceChildren();
    open(selected, { searchHistory: history([selected, recentCloudy, clearMonthAgo]) }, [recentCloudy]);
    viewer()!.querySelector<HTMLButtonElement>(`.oiv-date[data-key="${recentCloudy.key}"]`)!.click();
    await settle();
    expect(viewer()!.querySelector('.oiv-before')!.getAttribute('src')).toBe(recentCloudy.imageUrl);
  });

  it('keeps Escape working after the focused time-lapse control is replaced', async () => {
    const frames = [scene(50, 2), scene(40, 3), scene(30, 4), scene(20, 5)];
    open(frames[3]!, { searchHistory: history(frames), prefersReducedMotion: () => false, loadImage: loaded });
    await settle();
    const start = viewer()!.querySelector<HTMLButtonElement>('[data-action="timelapse-start"]')!;
    start.focus();
    start.click();
    await settle();
    expect(viewer()!.querySelector('[data-timelapse="autoplay"]')).not.toBeNull();
    expect(viewer()!.contains(document.activeElement)).toBe(true);
    document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(viewer()).toBeNull();
  });

  it('skips a frame that fails to load and plays the rest', async () => {
    vi.useFakeTimers();
    const frames = [scene(50, 2), scene(40, 3), scene(30, 4), scene(20, 5), scene(10, 6)];
    const failing = frames[2]!.imageUrl;
    open(frames[4]!, {
      searchHistory: history(frames),
      prefersReducedMotion: () => false,
      loadImage: async (url) => {
        if (url === failing) throw new Error('404');
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    viewer()!.querySelector<HTMLButtonElement>('[data-action="timelapse-start"]')!.click();
    await vi.advanceTimersByTimeAsync(0);
    const frameSrc = () => viewer()!.querySelector('.oiv-timelapse-frame')!.getAttribute('src');
    const shown = new Set<string | null>([frameSrc()]);
    expect(viewer()!.querySelector('[data-timelapse="autoplay"]')).not.toBeNull();
    expect(viewerText()).toContain('Frame 1 of 4');
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(800);
      shown.add(frameSrc());
    }
    expect(shown).toEqual(new Set(frames.filter((f) => f.imageUrl !== failing).map((f) => f.imageUrl)));
  });

  it('gives reduced-motion users a manual stepper instead of autoplay', async () => {
    vi.useFakeTimers();
    const frames = [scene(50, 2), scene(40, 3), scene(30, 4), scene(20, 5)];
    open(frames[3]!, { searchHistory: history(frames), prefersReducedMotion: () => true, loadImage: loaded });
    await vi.advanceTimersByTimeAsync(0);
    viewer()!.querySelector<HTMLButtonElement>('[data-action="timelapse-start"]')!.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(viewer()!.querySelector('[data-timelapse="stepper"]')).not.toBeNull();
    expect(viewer()!.querySelector('[data-action="timelapse-toggle"]')).toBeNull();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(viewerText()).toContain('Frame 1 of 4');
    viewer()!.querySelector<HTMLButtonElement>('[data-action="frame-next"]')!.click();
    expect(viewerText()).toContain('Frame 2 of 4');
  });

  it('replaces the time-lapse control when fewer than four clear scenes exist', async () => {
    const frames = [scene(50, 2), scene(40, 45), scene(30, 4), scene(20, 5), scene(75, 1)];
    open(frames[3]!, { searchHistory: history(frames), loadImage: loaded });
    await settle();
    expect(viewer()!.querySelector('[data-action="timelapse-start"]')).toBeNull();
    expect(viewer()!.querySelector('[data-timelapse="insufficient"]')!.textContent)
      .toBe('Not enough clear scenes for a time-lapse: 3 of 4 needed from the last 60 days.');
  });

  it('names the archive that timed out instead of implying there are no earlier scenes', async () => {
    const searchHistory = vi.fn(async (): Promise<SceneHistory> => ({ status: 'failed', failure: { archive: 'planetary-computer', reason: 'timeout' } }));
    open(scene(1, 5), { searchHistory });
    await settle();
    expect(viewerText()).toContain('Microsoft Planetary Computer did not answer in time, so earlier scenes are missing.');
    expect(viewerText()).not.toContain('No other scene of this collection');
    searchHistory.mockResolvedValueOnce({ status: 'ok', scenes: [scene(1, 5), scene(40, 3)] });
    viewer()!.querySelector<HTMLButtonElement>('[data-action="retry-history"]')!.click();
    await settle();
    expect(viewer()!.querySelector('.oiv-slider')).not.toBeNull();
  });

  it('never renders an image from a host outside the archive allowlist', async () => {
    const selected = scene(1, 5);
    open(selected, { searchHistory: history([selected, scene(40, 3, { imageUrl: 'https://evil.example/x.png' })]) });
    await settle();
    expect([...document.querySelectorAll('img')].every((img) => new URL(img.src).hostname === 'planetarycomputer.microsoft.com')).toBe(true);
    expect(viewerText()).toContain('No other scene of this collection to compare with.');
  });
});

describe('opening the viewer from the lookup sheet', () => {
  it('opens from a pass row image, and Escape closes only the viewer and returns focus to that row', async () => {
    const acquisition = scene(2, 5);
    const evidence: OrbitalEvidence = { passes: [], acquisitions: [acquisition], mosaics: [], frames: [], bestView: acquisition, status: 'complete', failures: [], unansweredProfiles: [] };
    const page = new OrbitalWatchPage({ onClose: vi.fn(), onRetry: vi.fn() });
    page.open(point, null);
    page.render({ kind: 'passes', lookup: { point, window: { startMs: NOW - 30 * DAY, endMs: NOW + 2 * DAY }, nowMs: NOW, catalog: { status: 'fresh', fetchedAt: NOW, inventoryVersion: 't' }, passes: [], satellites: [], computedOn: 'worker' }, archives: { kind: 'answered', evidence } });
    expect(subjectForImage(evidence, { kind: 'acquisition', key: acquisition.key }, { point, nowMs: NOW })!.selected.imageUrl).toBe(acquisition.imageUrl);

    const trigger = document.querySelector<HTMLButtonElement>('.ow-row [data-action="view-image"]')!;
    const row = trigger.closest<HTMLElement>('.ow-row')!;
    trigger.click();
    await vi.waitFor(() => expect(viewer()).not.toBeNull());
    expect(document.activeElement).toBe(viewer());

    viewer()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(viewer()).toBeNull();
    expect(page.isOpen).toBe(true);
    expect(document.activeElement).toBe(row);
    page.close();
  });

  it('opens the best view from the sheet summary', async () => {
    const acquisition = scene(2, 5);
    const evidence: OrbitalEvidence = { passes: [], acquisitions: [acquisition], mosaics: [], frames: [], bestView: acquisition, status: 'complete', failures: [], unansweredProfiles: [] };
    const page = new OrbitalWatchPage({ onClose: vi.fn(), onRetry: vi.fn() });
    page.open(point, null);
    page.render({ kind: 'passes', lookup: { point, window: { startMs: NOW - 30 * DAY, endMs: NOW + 2 * DAY }, nowMs: NOW, catalog: { status: 'fresh', fetchedAt: NOW, inventoryVersion: 't' }, passes: [], satellites: [], computedOn: 'worker' }, archives: { kind: 'answered', evidence } });
    document.querySelector<HTMLButtonElement>('.ow-best-view')!.click();
    await vi.waitFor(() => expect(viewer()).not.toBeNull());
    expect(viewer()!.querySelector('img.oiv-image')!.getAttribute('src')).toBe(acquisition.imageUrl);
    page.close();
  });
});
