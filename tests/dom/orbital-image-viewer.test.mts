import { afterEach, beforeAll, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import { initTestI18n } from './helpers/i18n.mts';

import type { DailyMosaicRow, GeostationaryRow } from '@/services/orbital/archive-gibs';
import type { MatchedAcquisition, OrbitalEvidence } from '@/services/orbital/match';
import type { SceneHistory } from '@/services/orbital/scene-history';
import { OrbitalWatchPage } from '@/components/OrbitalWatchPage';
import { IMAGE_CREDIT } from '@/services/orbital/credits';
import {
  openOrbitalImageViewer,
  sceneFromAcquisition,
  scenesFromFrame,
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
  latest: { time: new Date(NOW - 600_000).toISOString(), imageUrl: 'https://view.eumetsat.int/geoserver/wms?SERVICE=WMS&REQUEST=GetMap&LAYERS=mtg_fd%3Argb_geocolour&CRS=EPSG%3A4326&BBOX=25.1,55.1,25.3,55.4', fallbacks: [] },
};

const history = (scenes: MatchedAcquisition[]): ViewerDependencies['searchHistory'] => vi.fn(async (): Promise<SceneHistory> => ({ status: 'ok', scenes }));
/** Fake loads paint from `blob:test/<n>`, which `sourceOf` maps back to the archive URL. */
const sources: string[] = [];
const released = new Set<string>();
const paintOf = (url: string) => {
  const objectUrl = `blob:test/${sources.push(url) - 1}`;
  return { objectUrl, index: 0, release: () => { released.add(objectUrl); } };
};
const sourceOf = (src: string | null) => (src?.startsWith('blob:test/') ? sources[Number(src.slice(10))]! : src);
const srcOf = (selector: string) => sourceOf(viewer()!.querySelector(selector)!.getAttribute('src'));
const loaded: ViewerDependencies['loadImage'] = async (_archive, url) => paintOf(url);
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

beforeEach(() => {
  sources.length = 0;
  released.clear();
  // The viewer's own loader fetches the image and paints it from an object URL named after its source.
  vi.stubGlobal('fetch', vi.fn(async (input: string) => new Response(new Blob([new Uint8Array(sources.push(String(input)) - 1)], { type: 'image/png' }))));
  vi.stubGlobal('createImageBitmap', async () => ({ close: () => {} }));
  vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => `blob:test/${(blob as Blob).size}`);
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation((url) => { released.add(url); });
});

afterEach(() => {
  document.querySelector<HTMLButtonElement>('.oiv-close')?.click();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('orbital image viewer', () => {
  it('shows the opened image with its source credit and a north arrow from the crop grid', async () => {
    const landsat = scene(3, 5, { profileId: 'landsat', platform: 'landsat-9', key: 'landsat-9:1:x' });
    open(landsat, { searchHistory: history([]) });
    await settle();
    expect(srcOf('img.oiv-image')).toBe(landsat.imageUrl);
    expect(viewerText()).toContain(IMAGE_CREDIT.usgs);
    expect(viewer()!.querySelector('.oiv-north')!.getAttribute('aria-label')).toBe('North up');
  });

  it('offers a retry when the archive image fails, and paints it once the retry loads', async () => {
    const landsat = scene(3, 5, { profileId: 'landsat', platform: 'landsat-9', key: 'landsat-9:1:x' });
    let fail = true;
    open(landsat, { searchHistory: history([]), loadImage: async (_archive, url) => { if (fail) throw new Error('image failed: timeout'); return paintOf(url); } });
    await vi.waitFor(() => expect(viewer()!.querySelector('[role="alert"] [data-action="retry-image"]')).not.toBeNull());
    expect(viewer()!.querySelector('img.oiv-image')).toBeNull();
    fail = false;
    viewer()!.querySelector<HTMLButtonElement>('[data-action="retry-image"]')!.click();
    await vi.waitFor(() => expect(srcOf('img.oiv-image')).toBe(landsat.imageUrl));
  });

  it('credits EUMETSAT on a Meteosat frame and offers no time-lapse for a single frame', () => {
    openOrbitalImageViewer({ point, nowMs: NOW, selected: scenesFromFrame(meteosat)[0]!, scenes: [], historyProfile: null }, null, {});
    expect(viewerText()).toContain(IMAGE_CREDIT.eumetsat);
    expect(viewerText()).not.toContain(IMAGE_CREDIT.gibsAcknowledgement);
    expect(viewer()!.querySelector('[data-action="timelapse"]')).toBeNull();
  });

  it('opens a weather frame on the frame its thumbnail fell back to, keeping the earlier frames as other dates', () => {
    const earlier = { time: new Date(NOW - 1_200_000).toISOString(), imageUrl: `${meteosat.latest!.imageUrl}&TIME=earlier` };
    const frame: GeostationaryRow = { ...meteosat, latest: { ...meteosat.latest!, fallbacks: [earlier] } };
    const evidence: OrbitalEvidence = { passes: [], acquisitions: [], mosaics: [], frames: [frame], bestView: null, status: 'complete', failures: [], unansweredProfiles: [] };
    const subject = subjectForImage(evidence, { kind: 'frame', key: frame.layer }, { point, nowMs: NOW })!;
    expect(subject.selected.imageUrl).toBe(meteosat.latest!.imageUrl);
    expect(subject.scenes.map((scene) => scene.imageUrl)).toEqual([meteosat.latest!.imageUrl, earlier.imageUrl]);
    expect(subjectForImage(evidence, { kind: 'frame', key: frame.layer }, { point, nowMs: NOW }, earlier.imageUrl)!.selected.imageUrl).toBe(earlier.imageUrl);
    expect(subjectForImage({ ...evidence, frames: [meteosat] }, { kind: 'frame', key: frame.layer }, { point, nowMs: NOW })!.scenes).toEqual([]);
  });

  it('opens a daily mosaic on the day its thumbnail stepped back to', () => {
    const days = [{ date: '2026-11-13', imageUrl: 'https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi?TIME=2026-11-13' }, { date: '2026-11-12', imageUrl: 'https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi?TIME=2026-11-12' }];
    const mosaic: DailyMosaicRow = { kind: 'daily-mosaic', archive: 'nasa-gibs', source: 'MODIS Terra', layer: 'MODIS_Terra_CorrectedReflectance_TrueColor', noradId: 25994, days };
    const evidence: OrbitalEvidence = { passes: [], acquisitions: [], mosaics: [mosaic], frames: [], bestView: null, status: 'complete', failures: [], unansweredProfiles: [] };
    expect(subjectForImage(evidence, { kind: 'mosaic', key: mosaic.layer }, { point, nowMs: NOW })!.selected.imageUrl).toBe(days[0]!.imageUrl);
    expect(subjectForImage(evidence, { kind: 'mosaic', key: mosaic.layer }, { point, nowMs: NOW }, days[1]!.imageUrl)!.selected.imageUrl).toBe(days[1]!.imageUrl);
  });

  it('leaves the day the thumbnail found blank at the point out of compare', () => {
    const days = ['2026-11-13', '2026-11-12', '2026-11-11'].map((date) => ({ date, imageUrl: `https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi?TIME=${date}` }));
    const mosaic: DailyMosaicRow = { kind: 'daily-mosaic', archive: 'nasa-gibs', source: 'MODIS Terra', layer: 'MODIS_Terra_CorrectedReflectance_TrueColor', noradId: 25994, days };
    const evidence: OrbitalEvidence = { passes: [], acquisitions: [], mosaics: [mosaic], frames: [], bestView: null, status: 'complete', failures: [], unansweredProfiles: [] };
    const blank = days[0]!.imageUrl;
    const subject = subjectForImage(evidence, { kind: 'mosaic', key: mosaic.layer }, { point, nowMs: NOW }, days[1]!.imageUrl, (url) => url === blank)!;
    expect(subject.selected.imageUrl).toBe(days[1]!.imageUrl);
    expect(subject.scenes.map((scene) => scene.dateLabel)).toEqual(['2026-11-12', '2026-11-11']);
  });

  it('offers compare only when a second scene of the same collection exists', async () => {
    const selected = scene(1, 5);
    const radar = scene(40, null, { profileId: 'sentinel-1', platform: 'sentinel-1c', key: 'sentinel-1c:1:x' });
    open(selected, { searchHistory: history([selected]) }, [radar]);
    await settle();
    expect(viewer()!.querySelector('[data-mode="change"]'), 'a radar scene is no baseline for an optical one').toBeNull();
    expect(viewer()!.querySelector('.oiv-slider')).toBeNull();

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
    expect(viewerText()).toContain('Archive orientation; north not marked');
    expect(searchHistory).not.toHaveBeenCalled();

    document.querySelector<HTMLButtonElement>('.oiv-close')!.click();
    const earthSearchOnly = scene(40, 5, { key: 'sentinel-2c:1:es', imageUrl: preview('S2C_es') });
    open(scene(1, 5), { searchHistory: history([earthSearchOnly]) }, [earthSearchOnly]);
    await settle();
    expect(viewer()!.querySelector('[data-mode="change"]'), 'a whole-scene preview is no second scene').toBeNull();
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
    expect(meta).toMatchObject({ Pixel: '10M', 'Scene cloud': '5%', 'Sun elev.': '40°' });
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
    expect(srcOf('.oiv-before')).toBe(expected.imageUrl);

    viewer()!.querySelector<HTMLButtonElement>(`.oiv-date[data-key="${nearButRecent.key}"]`)!.click();
    await settle();
    expect(srcOf('.oiv-before')).toBe(nearButRecent.imageUrl);
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
    expect(toggle.textContent).toBe('Include cloudy dates (3)');
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
      loadImage: (_archive, url) => new Promise((resolve) => pending.set(url, () => resolve(paintOf(url)))),
    });
    await settle();
    showChange();
    const status = () => viewer()!.querySelector('.oiv-compare [role="status"]')!.textContent;
    expect(viewer()!.querySelector('.oiv-slider')).toBeNull();
    expect(status()).toBe('Frames loaded: 0 of 2');
    pending.get(selected.imageUrl!)!();
    await settle();
    expect(viewer()!.querySelector('.oiv-slider')).toBeNull();
    expect(status()).toBe('Frames loaded: 1 of 2');
    pending.get(other.imageUrl!)!();
    await settle();
    expect(srcOf('.oiv-before')).toBe(other.imageUrl);
    expect(srcOf('.oiv-after')).toBe(selected.imageUrl);
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

  it('keeps Escape working after the focused tab is replaced', async () => {
    open(scene(1, 5), { searchHistory: history([scene(1, 5), scene(40, 3)]) });
    await settle();
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
    expect(viewerText()).toContain('Microsoft Planetary Computer timed out; older scenes are missing.');
    expect(viewer()!.querySelector('[data-mode="change"]'), 'no second scene yet').toBeNull();
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
    expect([...document.querySelectorAll('img')].every((img) => new URL(sourceOf(img.getAttribute('src'))!).hostname === 'planetarycomputer.microsoft.com')).toBe(true);
    expect(viewer()!.querySelector('[data-mode="change"]'), 'an image off the allowlist is no second scene').toBeNull();
  });
});

describe('viewer images and the point', () => {
  const pointHost = /(^|\.)(planetarycomputer\.microsoft\.com|gibs\.earthdata\.nasa\.gov|view\.eumetsat\.int)$/;
  const imageSrcs = () => [...document.querySelectorAll('.oiv-dialog img')].map((img) => img.getAttribute('src') ?? '');
  const onPointHost = (src: string) => { try { return pointHost.test(new URL(src).hostname); } catch { return false; } };

  it('paints the image and both compare sides from blob: URLs and releases them on a date change and on close', async () => {
    const selected = scene(1, 5);
    const first = scene(36, 4);
    const second = scene(50, 2);
    openOrbitalImageViewer({ point, nowMs: NOW, selected: sceneFromAcquisition(selected), scenes: [], historyProfile: 'sentinel-2' }, null, { searchHistory: history([selected, first, second]) });
    await vi.waitFor(() => expect(imageSrcs()).toHaveLength(1));
    expect(imageSrcs().every((src) => src.startsWith('blob:') && !onPointHost(src))).toBe(true);
    expect(srcOf('img.oiv-image')).toBe(selected.imageUrl);

    showChange();
    await vi.waitFor(() => expect(viewer()!.querySelector('.oiv-slider')).not.toBeNull());
    expect(imageSrcs()).toHaveLength(2);
    expect(imageSrcs().every((src) => src.startsWith('blob:') && !onPointHost(src))).toBe(true);
    const firstBlob = viewer()!.querySelector('.oiv-before')!.getAttribute('src')!;
    expect(sourceOf(firstBlob)).toBe(first.imageUrl);

    viewer()!.querySelector<HTMLButtonElement>(`.oiv-date[data-key="${second.key}"]`)!.click();
    await vi.waitFor(() => expect(srcOf('.oiv-before')).toBe(second.imageUrl));
    expect(imageSrcs().every((src) => src.startsWith('blob:') && !onPointHost(src))).toBe(true);
    expect(released.has(firstBlob), 'the date left is released').toBe(true);
    const shown = imageSrcs();
    expect(shown.some((src) => released.has(src))).toBe(false);

    document.querySelector<HTMLButtonElement>('.oiv-close')!.click();
    expect(shown.every((src) => released.has(src)), 'closing releases every blob').toBe(true);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('paints a weather frame only once loaded, and leaves no blob from a load that lands after close', async () => {
    let finish: (() => void) | null = null;
    vi.stubGlobal('fetch', vi.fn((input: string) => new Promise<Response>((resolve) => {
      finish = () => resolve(new Response(new Blob([new Uint8Array(sources.push(String(input)) - 1)], { type: 'image/png' })));
    })));
    const viewerPage = openOrbitalImageViewer({ point, nowMs: NOW, selected: scenesFromFrame(meteosat)[0]!, scenes: [], historyProfile: null }, null, {});
    await settle();
    expect(imageSrcs()).toHaveLength(0);
    expect(viewer()!.querySelector('.oiv-skeleton')).not.toBeNull();
    viewerPage.close();
    finish!();
    await settle();
    await settle();
    const created = vi.mocked(URL.createObjectURL).mock.results.map((result) => result.value as string);
    expect(created.every((src) => released.has(src)), 'a load that lands after close leaves no blob behind').toBe(true);
    expect(imageSrcs()).toHaveLength(0);
  });
});

describe('opening the viewer from the lookup sheet', () => {
  it('returns focus to the evidence sheet when the image that opened the viewer was re-rendered away', async () => {
    const sheet = Object.assign(document.createElement('section'), { className: 'imagery-evidence-sheet', tabIndex: -1 });
    document.body.append(sheet);
    onTestFinished(() => sheet.remove());
    open(scene(2, 5), {}, [], document.createElement('button'));
    await vi.waitFor(() => expect(viewer()).not.toBeNull());
    viewer()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(viewer()).toBeNull();
    expect(document.activeElement).toBe(sheet);
  });

  it('opens from the latest image, and Escape closes only the viewer and returns focus to that image', async () => {
    const acquisition = scene(2, 5);
    const evidence: OrbitalEvidence = { passes: [], acquisitions: [acquisition], mosaics: [], frames: [], bestView: acquisition, status: 'complete', failures: [], unansweredProfiles: [] };
    const page = new OrbitalWatchPage({ onClose: vi.fn(), onRetry: vi.fn() });
    page.open(point, null);
    page.render({ kind: 'passes', lookup: { point, window: { startMs: NOW - 30 * DAY, endMs: NOW + 2 * DAY }, nowMs: NOW, catalog: { status: 'fresh', fetchedAt: NOW, inventoryVersion: 't' }, passes: [], satellites: [], daylight: [], computedOn: 'worker' }, archives: { kind: 'answered', evidence } });
    expect(subjectForImage(evidence, { kind: 'acquisition', key: acquisition.key }, { point, nowMs: NOW })!.selected.imageUrl).toBe(acquisition.imageUrl);

    const trigger = document.querySelector<HTMLButtonElement>('[data-section="latest"] [data-action="view-image"]')!;
    trigger.click();
    await vi.waitFor(() => expect(viewer()).not.toBeNull());
    expect(document.activeElement).toBe(viewer());

    viewer()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(viewer()).toBeNull();
    expect(page.isOpen).toBe(true);
    expect(document.activeElement).toBe(trigger);
    page.close();
  });

  it('drops a viewer whose chunk lands after the sheet reopened at another place', async () => {
    const acquisition = scene(2, 5);
    const evidence: OrbitalEvidence = { passes: [], acquisitions: [acquisition], mosaics: [], frames: [], bestView: acquisition, status: 'complete', failures: [], unansweredProfiles: [] };
    const state = (at: typeof point) => ({ kind: 'passes' as const, lookup: { point: at, window: { startMs: NOW - 30 * DAY, endMs: NOW + 2 * DAY }, nowMs: NOW, catalog: { status: 'fresh' as const, fetchedAt: NOW, inventoryVersion: 't' }, passes: [], satellites: [], daylight: [], computedOn: 'worker' as const }, archives: { kind: 'answered' as const, evidence } });
    const page = new OrbitalWatchPage({ onClose: vi.fn(), onRetry: vi.fn() });
    page.open(point, null);
    page.render(state(point));
    document.querySelector<HTMLButtonElement>('[data-section="latest"] [data-action="view-image"]')!.click();
    page.close();
    const elsewhere = { lat: 48.85, lon: 2.35 };
    page.open(elsewhere, null);
    page.render(state(elsewhere));
    await import('@/components/OrbitalImageViewer');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(viewer()).toBeNull();
    page.close();
  });

  it('opens the hero image from the sheet summary', async () => {
    const acquisition = scene(2, 5);
    const evidence: OrbitalEvidence = { passes: [], acquisitions: [acquisition], mosaics: [], frames: [], bestView: acquisition, status: 'complete', failures: [], unansweredProfiles: [] };
    const page = new OrbitalWatchPage({ onClose: vi.fn(), onRetry: vi.fn() });
    page.open(point, null);
    page.render({ kind: 'passes', lookup: { point, window: { startMs: NOW - 30 * DAY, endMs: NOW + 2 * DAY }, nowMs: NOW, catalog: { status: 'fresh', fetchedAt: NOW, inventoryVersion: 't' }, passes: [], satellites: [], daylight: [], computedOn: 'worker' }, archives: { kind: 'answered', evidence } });
    await vi.waitFor(() => expect(document.querySelector('[data-section="latest"] .ow-tile img[src^="blob:"]')).not.toBeNull());
    document.querySelector<HTMLButtonElement>('[data-section="latest"] [data-action="view-image"]')!.click();
    await vi.waitFor(() => expect(viewer()).not.toBeNull());
    await vi.waitFor(() => expect(sourceOf(viewer()!.querySelector('img.oiv-image')?.getAttribute('src') ?? null)).toBe(acquisition.imageUrl));
    expect(vi.mocked(fetch).mock.calls.filter(([url]) => String(url) === acquisition.imageUrl), 'the viewer reuses the sheet\'s copy').toHaveLength(1);
    document.querySelector<HTMLButtonElement>('.oiv-close')!.click();
    expect(released.size, 'closing the viewer leaves the sheet\'s copy alone').toBe(0);
    page.close();
  });
});
