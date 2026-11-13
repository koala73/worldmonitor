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
const showChange = () => viewer()!.querySelector<HTMLButtonElement>('[data-action="mode"][data-mode="change"]')!.click();

function open(selected: MatchedAcquisition, deps: ViewerDependencies, others: MatchedAcquisition[] = [], returnFocusTo: HTMLElement | null = null) {
  return openOrbitalImageViewer({ point, nowMs: NOW, selected: sceneFromAcquisition(selected), scenes: others.map(sceneFromAcquisition), historyProfile: selected.profileId }, returnFocusTo, { loadImage: loaded, ...deps });
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
    expect(viewer()!.querySelector('[data-action="timelapse"]')).toBeNull();
  });

  it('offers compare only when a second scene of the same collection exists', async () => {
    const selected = scene(1, 5);
    const radar = scene(40, null, { profileId: 'sentinel-1', platform: 'sentinel-1c', key: 'sentinel-1c:1:x' });
    open(selected, { searchHistory: history([selected]) }, [radar]);
    await settle();
    showChange();
    expect(viewer()!.querySelector('.oiv-slider')).toBeNull();
    expect(viewerText()).toContain('No other scene of this collection to compare with.');

    document.querySelector<HTMLButtonElement>('.oiv-close')!.click();
    open(selected, { searchHistory: history([selected, scene(20, 5)]) });
    await settle();
    showChange();
    await settle();
    expect(viewer()!.querySelectorAll('.oiv-slider img')).toHaveLength(2);
    expect(viewer()!.querySelector('input[type="range"]')).not.toBeNull();
  });

  it('compares only point crops, never whole-scene previews with other footprints', async () => {
    const preview = (id: string) => `https://sentinel-cogs.s3.us-west-2.amazonaws.com/sentinel-s1-l1c/${id}/preview.jpg`;
    const radar = (daysAgo: number) => scene(daysAgo, null, { profileId: 'sentinel-1', platform: 'sentinel-1c', key: `sentinel-1c:${daysAgo}`, imageUrl: preview(`S1C_${daysAgo}`) });
    const searchHistory = history([radar(1), radar(13), radar(25), radar(37), radar(49)]);
    open(radar(1), { searchHistory, loadImage: loaded }, [radar(13)]);
    await settle();
    expect(viewer()!.querySelector('img.oiv-image')).not.toBeNull();
    expect(viewer()!.querySelector('.oiv-north')).toBeNull();
    expect(viewer()!.querySelector('[data-mode="change"]')).toBeNull();
    expect(viewer()!.querySelector('[data-action="timelapse"]')).toBeNull();
    expect(viewerText()).toContain('Orientation as delivered by the archive');
    expect(searchHistory).not.toHaveBeenCalled();

    document.querySelector<HTMLButtonElement>('.oiv-close')!.click();
    const earthSearchOnly = scene(40, 5, { key: 'sentinel-2c:1:es', imageUrl: preview('S2C_es') });
    open(scene(1, 5), { searchHistory: history([earthSearchOnly]) }, [earthSearchOnly]);
    await settle();
    showChange();
    expect(viewer()!.querySelector('.oiv-slider')).toBeNull();
    expect(viewer()!.querySelector(`.oiv-date[data-key="${earthSearchOnly.key}"]`)).toBeNull();
  });

  it('shows the large crop with a reticle, scale bar, two-line caption and metadata column', async () => {
    open(scene(1, 5), { searchHistory: history([]) });
    await settle();
    expect(viewer()!.querySelector('.oiv-stage .oiv-reticle')).not.toBeNull();
    expect(viewer()!.querySelector('.oiv-scale')!.textContent).toBe('2 KM');
    expect([...viewer()!.querySelectorAll('.oiv-caption span')].map((line) => line.textContent)).toEqual([
      'SENTINEL-2C · THU 12 NOV · 12:00 UTC',
      '10 M · 24 h ago · Clear',
    ]);
    const meta = Object.fromEntries([...viewer()!.querySelectorAll('.oiv-meta div')].map((cell) => [cell.querySelector('dt')!.textContent, cell.querySelector('dd')!.textContent]));
    expect(meta).toMatchObject({ Pixel: '10M', 'Scene cloud': '5%', 'Sun elevation': '40°' });
  });

  it('defaults the compare picker to the nearest clear scene at least 30 days away', async () => {
    const selected = scene(1, 5);
    const nearButRecent = scene(10, 2);
    const farButCloudy = scene(32, 60);
    const expected = scene(38, 8);
    const further = scene(55, 1);
    open(selected, { searchHistory: history([selected, nearButRecent, farButCloudy, expected, further]) });
    await settle();
    showChange();
    await settle();
    const pressed = viewer()!.querySelector<HTMLElement>('.oiv-date[aria-pressed="true"]')!;
    expect(pressed.dataset.key).toBe(expected.key);
    expect(viewer()!.querySelector('.oiv-before')!.getAttribute('src')).toBe(expected.imageUrl);

    viewer()!.querySelector<HTMLButtonElement>(`.oiv-date[data-key="${nearButRecent.key}"]`)!.click();
    await settle();
    expect(viewer()!.querySelector('.oiv-before')!.getAttribute('src')).toBe(nearButRecent.imageUrl);
  });

  it('leaves dates over 30% cloud out of the compare list until cloudy dates are asked for', async () => {
    const selected = scene(1, 5);
    const cloudy = [scene(8, 98), scene(15, 96), scene(22, 31)];
    const hazy = scene(29, 25);
    const clear = scene(36, 4);
    open(selected, { searchHistory: history([selected, ...cloudy, hazy, clear]) });
    await settle();
    showChange();
    const dates = () => [...viewer()!.querySelectorAll<HTMLElement>('.oiv-date')].map((date) => date.dataset.key);
    expect(dates()).toEqual([hazy.key, clear.key]);
    const toggle = viewer()!.querySelector<HTMLButtonElement>('[data-action="show-cloudy"]')!;
    expect(toggle.textContent).toBe('Show cloudy dates (3)');
    toggle.click();
    expect(dates()).toEqual([...cloudy, hazy, clear].map((s) => s.key));
    expect(viewer()!.querySelector('[data-action="show-cloudy"]')!.getAttribute('aria-pressed')).toBe('true');
  });

  it('shows the before and after split only once both dates have decoded', async () => {
    const selected = scene(1, 5);
    const other = scene(36, 4);
    const pending = new Map<string, () => void>();
    open(selected, {
      searchHistory: history([selected, other]),
      loadImage: (url) => new Promise<void>((resolve) => pending.set(url, resolve)),
    });
    await settle();
    showChange();
    const status = () => viewer()!.querySelector('.oiv-compare [role="status"]')!.textContent;
    expect(viewer()!.querySelector('.oiv-slider')).toBeNull();
    expect(status()).toBe('Loading frames: 0 of 2');
    pending.get(selected.imageUrl!)!();
    await settle();
    expect(viewer()!.querySelector('.oiv-slider')).toBeNull();
    expect(status()).toBe('Loading frames: 1 of 2');
    pending.get(other.imageUrl!)!();
    await settle();
    expect(viewer()!.querySelector('.oiv-before')!.getAttribute('src')).toBe(other.imageUrl);
    expect(viewer()!.querySelector('.oiv-after')!.getAttribute('src')).toBe(selected.imageUrl);
    expect([...viewer()!.querySelectorAll('.oiv-chip')].map((chip) => chip.textContent)).toEqual(['8 OCT 2026', '12 NOV 2026']);
  });

  it('moves the compare default to a clear scene from history once it arrives, unless a date was picked', async () => {
    const selected = scene(1, 5);
    const pressed = () => viewer()!.querySelector<HTMLElement>('.oiv-date[aria-pressed="true"]')!.dataset.key;
    const recentClear = scene(4, 12);
    const clearMonthAgo = scene(35, 3);
    open(selected, { searchHistory: history([selected, recentClear, clearMonthAgo]) }, [recentClear]);
    showChange();
    expect(pressed()).toBe(recentClear.key);
    await settle();
    expect(pressed()).toBe(clearMonthAgo.key);

    document.body.replaceChildren();
    open(selected, { searchHistory: history([selected, recentClear, clearMonthAgo]) }, [recentClear]);
    showChange();
    viewer()!.querySelector<HTMLButtonElement>(`.oiv-date[data-key="${recentClear.key}"]`)!.click();
    await settle();
    expect(pressed()).toBe(recentClear.key);
  });

  it('keeps Escape working after the focused tab is replaced', () => {
    open(scene(1, 5), { searchHistory: history([]) });
    const tab = viewer()!.querySelector<HTMLButtonElement>('[data-mode="change"]')!;
    tab.focus();
    tab.click();
    expect(document.activeElement?.closest('.oiv-dialog')).toBe(viewer());
    document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(viewer()).toBeNull();
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
    showChange();
    await settle();
    expect(viewer()!.querySelector('.oiv-slider')).not.toBeNull();
  });

  it('never renders an image from a host outside the archive allowlist', async () => {
    const selected = scene(1, 5);
    open(selected, { searchHistory: history([selected, scene(40, 3, { imageUrl: 'https://evil.example/x.png' })]) });
    await settle();
    showChange();
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
    page.open(point, null, 'full');
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

  it('opens the hero image from the sheet summary', async () => {
    const acquisition = scene(2, 5);
    const evidence: OrbitalEvidence = { passes: [], acquisitions: [acquisition], mosaics: [], frames: [], bestView: acquisition, status: 'complete', failures: [], unansweredProfiles: [] };
    const page = new OrbitalWatchPage({ onClose: vi.fn(), onRetry: vi.fn() });
    page.open(point, null);
    page.render({ kind: 'passes', lookup: { point, window: { startMs: NOW - 30 * DAY, endMs: NOW + 2 * DAY }, nowMs: NOW, catalog: { status: 'fresh', fetchedAt: NOW, inventoryVersion: 't' }, passes: [], satellites: [], computedOn: 'worker' }, archives: { kind: 'answered', evidence } });
    document.querySelector<HTMLButtonElement>('.ow-card [data-action="view-image"]')!.click();
    await vi.waitFor(() => expect(viewer()).not.toBeNull());
    expect(viewer()!.querySelector('img.oiv-image')!.getAttribute('src')).toBe(acquisition.imageUrl);
    page.close();
  });
});
