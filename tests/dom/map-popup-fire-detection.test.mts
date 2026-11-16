/**
 * #10713: a FIRMS fire detection is itself a satellite observation, so its popup
 * states the detection's own facts, carries the imagery row, and shows the GIBS
 * daily mosaic of the detection's date only when the archive has one. An empty
 * archive must never read as an image of the fire.
 */
import i18next from 'i18next';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ArchiveImageResult } from '@/services/orbital/archive-image';
import type { FireMosaic } from '@/services/orbital/fire-mosaic';
import en from '@/locales/en.json';

const harness = vi.hoisted(() => ({
  archive: [] as Array<{ url: string; resolve: (r: ArchiveImageResult) => void; signal?: AbortSignal }>,
  imagery: [] as Array<{ target: unknown; signal?: AbortSignal }>,
}));

vi.mock('globe.gl', () => ({ default: vi.fn() }));
vi.mock('@/config/orbital-watch-flag', () => ({ ORBITAL_WATCH_ENABLED: true }));
vi.mock('@/services/orbital/archive-image', () => ({
  loadArchiveImage: vi.fn((_archive: string, candidates: string[], options: { signal?: AbortSignal } = {}) =>
    new Promise<ArchiveImageResult>((resolve) => harness.archive.push({ url: candidates[0]!, resolve, signal: options.signal }))),
}));
vi.mock('@/services/orbital/object-imagery', () => ({
  loadObjectImagery: vi.fn((target: unknown, signal?: AbortSignal) => {
    harness.imagery.push({ target, signal });
    return new Promise(() => {});
  }),
}));
// jsdom has no canvas: the no-data check answers "has data" unless a test says otherwise.
const noData = vi.hoisted(() => ({ empty: false }));
vi.mock('@/services/orbital/image-no-data', () => ({ noDataAtPoint: () => noData.empty }));

import { MapPopup } from '@/components/MapPopup';
import {
  fireDetectionPopupData,
  mountFireMosaic,
  renderFireDetectionPopup,
  type FireDetectionPopupData,
} from '@/components/map-popup-fire';
import { hasImageryRow, imageryTargetFor } from '@/components/map-popup-imagery';

const FIRE: FireDetectionPopupData = {
  lat: 48.5, lon: 37.25, brightness: 351.2, frp: 12.34, confidence: 95, region: 'Ukraine',
  acq_date: '2026-11-14', daynight: 'D', detected_at: Date.parse('2026-11-14T10:42:00Z'), satellite: 'N', source: 'firms',
};
const MOSAIC_URL = 'https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi?LAYERS=VIIRS_SNPP_CorrectedReflectance_TrueColor&BBOX=48,37,49,38';
const found = (over: Partial<Extract<FireMosaic, { status: 'found' }>> = {}): FireMosaic => ({
  status: 'found', source: 'VIIRS Suomi NPP', date: '2026-11-14', archive: 'nasa-gibs', candidates: [MOSAIC_URL], pointInCrop: { x: 0.5, y: 0.5 }, ...over,
});
const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
const okImage = (release = vi.fn()): ArchiveImageResult => ({ status: 'ok', image: { objectUrl: 'blob:fire-mosaic', index: 0, release } });

beforeAll(async () => {
  if (!i18next.isInitialized) {
    await i18next.init({ lng: 'en', fallbackLng: 'en', resources: { en: { translation: en as Record<string, unknown> } }, interpolation: { escapeValue: false } });
  }
});
beforeEach(() => {
  harness.archive.length = 0;
  harness.imagery.length = 0;
  noData.empty = false;
  document.body.innerHTML = '';
});
afterEach(() => { document.body.innerHTML = ''; });

describe('fire detection popup facts', () => {
  it('states the detection time in UTC, the satellite, the confidence, the power and the source credit', () => {
    const html = renderFireDetectionPopup(FIRE);
    const text = new DOMParser().parseFromString(html, 'text/html').body.textContent ?? '';
    expect(text).toMatch(/14 Nov 2026|Nov 14, 2026/);
    expect(text).toContain('10:42');
    expect(text).toContain('UTC');
    expect(text).toContain('VIIRS Suomi NPP');
    expect(text).toContain('High');
    expect(text).toContain('12.3 MW');
    expect(text).toContain('Ukraine');
    expect(text).toContain('NASA FIRMS');
  });

  it('leaves out the power when the detection carries none, and the confidence when unspecified', () => {
    const text = new DOMParser().parseFromString(renderFireDetectionPopup({ ...FIRE, frp: 0, confidence: 0 }), 'text/html').body.textContent ?? '';
    expect(text).not.toContain('MW');
    expect(text).not.toContain('Confidence');
  });

  it('names an unrecognised satellite as reported rather than guessing an instrument', () => {
    const text = new DOMParser().parseFromString(renderFireDetectionPopup({ ...FIRE, satellite: 'ZZ9' }), 'text/html').body.textContent ?? '';
    expect(text).toContain('ZZ9');
  });

  it('escapes the reported region and satellite', () => {
    const html = renderFireDetectionPopup({ ...FIRE, region: '<img src=x onerror=alert(1)>', satellite: '<b>' });
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('<b>');
  });
});

describe('which detections get the popup', () => {
  it('opens for a FIRMS detection and for a row that predates the source field', () => {
    expect(fireDetectionPopupData(FIRE, true)).toMatchObject({ lat: 48.5, lon: 37.25 });
    expect(fireDetectionPopupData({ ...FIRE, source: undefined }, true)).not.toBeNull();
  });

  it('stays closed for agency-reported fires, which are not satellite observations', () => {
    expect(fireDetectionPopupData({ ...FIRE, source: 'cwfis' }, true)).toBeNull();
    expect(fireDetectionPopupData({ ...FIRE, source: 'bcws' }, true)).toBeNull();
  });

  it('stays closed for a detection without a position or a time', () => {
    expect(fireDetectionPopupData({ ...FIRE, lat: NaN }, true)).toBeNull();
    expect(fireDetectionPopupData({ ...FIRE, detected_at: undefined }, true)).toBeNull();
  });

  it('is off with the Orbital Watch flag off', () => {
    expect(fireDetectionPopupData(FIRE, false)).toBeNull();
    expect(hasImageryRow('fireDetection', FIRE, false)).toBe(false);
  });

  it('gets the point imagery row of #10733 at the detection position', () => {
    expect(imageryTargetFor('fireDetection', FIRE)).toEqual({ kind: 'point', point: { lat: 48.5, lon: 37.25 } });
    expect(imageryTargetFor('fireDetection', { ...FIRE, source: 'cwfis' })).toBeNull();
    expect(hasImageryRow('fireDetection', FIRE, true)).toBe(true);
  });
});

describe('daily mosaic of the detection date', () => {
  function mount(load: () => Promise<FireMosaic>) {
    const holder = document.createElement('div');
    holder.innerHTML = renderFireDetectionPopup(FIRE);
    document.body.appendChild(holder);
    const onLayout = vi.fn();
    const dispose = mountFireMosaic(holder, FIRE, { onLayout, load });
    return { holder, onLayout, dispose };
  }

  it('shows the mosaic image with its date, instrument and credit when the archive has the day', async () => {
    const { holder } = mount(async () => found());
    await flush();
    harness.archive[0]!.resolve(okImage());
    await flush();
    const img = holder.querySelector<HTMLImageElement>('[data-fire-mosaic-image] img');
    expect(img?.getAttribute('src')).toBe('blob:fire-mosaic');
    const text = holder.querySelector('[data-fire-mosaic]')!.textContent ?? '';
    expect(text).toContain('VIIRS Suomi NPP');
    expect(text).toMatch(/14 Nov 2026|Nov 14, 2026/);
    expect(text).toContain('NASA GIBS');
    // The caption says what a daily mosaic is, so it never claims the fire is visible.
    expect(text).toContain('cloud or smoke');
  });

  it('never puts the detection position into img.src', async () => {
    const { holder } = mount(async () => found());
    await flush();
    harness.archive[0]!.resolve(okImage());
    await flush();
    expect(holder.querySelector('img')!.src).not.toContain('gibs.earthdata.nasa.gov');
  });

  it('claims no image when the archive has no mosaic for that date', async () => {
    const { holder } = mount(async () => ({ status: 'none', source: 'VIIRS Suomi NPP', date: '2026-11-14', reason: 'no-day' }));
    await flush();
    const section = holder.querySelector('[data-fire-mosaic]')!;
    expect(section.querySelector('img')).toBeNull();
    expect(section.querySelector('[data-fire-mosaic-image]')).toBeNull();
    expect(section.textContent).toContain('no VIIRS Suomi NPP mosaic');
    expect(harness.archive).toHaveLength(0);
  });

  it('claims no image for a satellite GIBS has no daily layer for', async () => {
    const { holder } = mount(async () => ({ status: 'none', date: '2026-11-14', reason: 'no-layer' }));
    await flush();
    const section = holder.querySelector('[data-fire-mosaic]')!;
    expect(section.querySelector('img')).toBeNull();
    expect(section.textContent).toContain('No daily mosaic');
  });

  it('says the archive did not answer when the lookup fails', async () => {
    const { holder } = mount(async () => ({ status: 'failed' }));
    await flush();
    expect(holder.querySelector('[data-fire-mosaic] img')).toBeNull();
    expect(holder.querySelector('[data-fire-mosaic]')!.textContent).toContain('did not load');
  });

  it('drops the frame when the archive returns an image with no data at the point', async () => {
    const { holder } = mount(async () => found());
    await flush();
    harness.archive[0]!.resolve(okImage());
    await flush();
    const img = holder.querySelector<HTMLImageElement>('[data-fire-mosaic-image] img')!;
    noData.empty = true;
    img.dispatchEvent(new Event('load'));
    await flush();
    expect(holder.querySelector('[data-fire-mosaic] img')).toBeNull();
    expect(holder.querySelector('[data-fire-mosaic]')!.textContent).toContain('no VIIRS Suomi NPP mosaic');
  });

  it('drops the frame when the image does not load', async () => {
    const { holder } = mount(async () => found());
    await flush();
    harness.archive[0]!.resolve({ status: 'failed', failure: { archive: 'nasa-gibs', reason: 'network' } as never });
    await flush();
    expect(holder.querySelector('[data-fire-mosaic] img')).toBeNull();
    expect(holder.querySelector('[data-fire-mosaic]')!.textContent).toContain('did not load');
  });

  it('aborts the lookup and frees the image on dispose', async () => {
    const release = vi.fn();
    let signal: AbortSignal | undefined;
    const { holder, dispose } = mount(async () => found());
    await flush();
    signal = harness.archive[0]!.signal;
    harness.archive[0]!.resolve(okImage(release));
    await flush();
    expect(holder.querySelector('img')).not.toBeNull();
    dispose();
    expect(release).toHaveBeenCalledTimes(1);
    expect(signal?.aborted).toBe(true);
  });

  it('paints nothing from a lookup that answers after dispose', async () => {
    let resolve!: (m: FireMosaic) => void;
    const { holder, dispose } = mount(() => new Promise<FireMosaic>((r) => { resolve = r; }));
    dispose();
    resolve(found());
    await flush();
    expect(harness.archive).toHaveLength(0);
    expect(holder.querySelector('img')).toBeNull();
  });
});

describe('MapPopup with a fire detection', () => {
  it('renders the facts, the mosaic section and the imagery row, and disposes them on hide', async () => {
    const popup = new MapPopup(document.body);
    popup.show({ type: 'fireDetection', data: FIRE, x: 100, y: 100 });
    const root = document.querySelector('.map-popup')!;
    expect(root.textContent).toContain('VIIRS Suomi NPP');
    expect(root.querySelector('[data-fire-mosaic]')).not.toBeNull();
    expect(root.querySelector('[data-orbital-imagery]')).not.toBeNull();
    // The imagery loader is imported on demand, so the lookup starts a few ticks after show().
    await vi.waitFor(() => expect(harness.imagery).toHaveLength(1));
    expect(harness.imagery[0]!.target).toEqual({ kind: 'point', point: { lat: 48.5, lon: 37.25 } });
    const signal = harness.imagery[0]!.signal!;
    popup.hide();
    expect(signal.aborted).toBe(true);
  });
});

describe('map fire rows', () => {
  it('carry the detection time, satellite and source from the seeded detection', async () => {
    const { toMapFires } = await import('@/services/wildfires');
    const [fire] = toMapFires([{
      location: { latitude: 48.5, longitude: 37.25 }, brightness: 351, frp: 12, confidence: 'FIRE_CONFIDENCE_HIGH', region: 'Ukraine',
      detectedAt: Date.parse('2026-11-14T10:42:00Z'), dayNight: 'D', satellite: 'N', source: 'firms',
    }]);
    expect(fire).toMatchObject({ detected_at: Date.parse('2026-11-14T10:42:00Z'), satellite: 'N', source: 'firms', confidence: 95 });
    expect(fireDetectionPopupData(fire, true)).not.toBeNull();
  });

  it('leave out a detection with no position instead of placing it at 0°, 0°', async () => {
    const { toMapFires } = await import('@/services/wildfires');
    const fires = toMapFires([{
      location: undefined, brightness: 351, frp: 12, confidence: 'FIRE_CONFIDENCE_HIGH', region: 'Ukraine',
      detectedAt: Date.parse('2026-11-14T10:42:00Z'), dayNight: 'D', satellite: 'N', source: 'firms',
    }]);
    expect(fires).toEqual([]);
  });
});
