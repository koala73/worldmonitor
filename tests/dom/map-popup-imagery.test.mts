/**
 * #10713 unit 1: the imagery row of a map popup must stop its lookup and free
 * its image when the popup closes or another popup replaces it, and a late
 * answer for the previous object must never paint into the current popup.
 */
import i18next from 'i18next';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ArchiveImageResult } from '@/services/orbital/archive-image';
import type { ImageryTarget, ObjectImagery } from '@/services/orbital/object-imagery';
import en from '@/locales/en.json';

const harness = vi.hoisted(() => ({
  archive: [] as Array<{ resolve: (r: ArchiveImageResult) => void; signal?: AbortSignal }>,
  loads: [] as Array<{ target: unknown; signal?: AbortSignal; resolve: (v: unknown) => void; reject: (e: unknown) => void }>,
}));

vi.mock('globe.gl', () => ({ default: vi.fn() }));
vi.mock('@/config/orbital-watch-flag', () => ({ ORBITAL_WATCH_ENABLED: true }));
vi.mock('@/services/orbital/archive-image', () => ({
  loadArchiveImage: vi.fn((_archive: string, _candidates: string[], options: { signal?: AbortSignal } = {}) =>
    new Promise<ArchiveImageResult>((resolve) => harness.archive.push({ resolve, signal: options.signal }))),
}));
vi.mock('@/services/orbital/object-imagery', () => ({
  loadObjectImagery: vi.fn((target: unknown, signal?: AbortSignal) =>
    new Promise((resolve, reject) => harness.loads.push({ target, signal, resolve, reject }))),
}));

import { MapPopup } from '@/components/MapPopup';
import { imageryTargetFor, mountImageryRow, renderImageryRow } from '@/components/map-popup-imagery';
import { loadArchiveImage } from '@/services/orbital/archive-image';
import { IMAGE_CREDIT } from '@/services/orbital/credits';

const NOW = Date.parse('2026-11-15T12:00:00Z');
const imagery = (datetime = '2026-11-14T10:00:00Z'): ObjectImagery => ({
  latest: { datetime, profileId: 'sentinel-2', archive: 'planetary-computer', candidates: ['https://planetarycomputer.microsoft.com/api/data/v1/item/crop/1,2,3,4.png'] },
  nextPass: { satellite: 'SENTINEL-2B', profileId: 'sentinel-2', timeMs: NOW + 3_600_000 },
});
const okImage = (objectUrl: string, release: () => void): ArchiveImageResult => ({ status: 'ok', image: { objectUrl, index: 0, release } });
const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

beforeAll(async () => {
  if (!i18next.isInitialized) {
    await i18next.init({ lng: 'en', fallbackLng: 'en', resources: { en: { translation: en as Record<string, unknown> } }, interpolation: { escapeValue: false } });
  }
});
beforeEach(() => {
  harness.archive.length = 0;
  harness.loads.length = 0;
  vi.mocked(loadArchiveImage).mockClear();
});

function mountRow(load: (target: ImageryTarget, signal?: AbortSignal, onImageReady?: (early: ObjectImagery) => void) => Promise<ObjectImagery>) {
  const holder = document.createElement('div');
  holder.innerHTML = renderImageryRow();
  const row = holder.firstElementChild as HTMLElement;
  document.body.appendChild(row);
  const target: ImageryTarget = { kind: 'point', point: { lat: 10, lon: 20 } };
  const dispose = mountImageryRow(row, target, { onOpenEvidence: vi.fn(), onLayout: vi.fn(), load, now: () => NOW });
  return { row, dispose };
}

describe('mountImageryRow', () => {
  afterEach(() => { document.body.replaceChildren(); });

  describe('a crop the archive has not served yet', () => {
    const radar = (datetime: string): ObjectImagery => ({ ...imagery(datetime), latest: { ...imagery(datetime).latest!, profileId: 'sentinel-1' } });
    const failed = (httpStatus: number): ArchiveImageResult => ({ status: 'failed', failure: { archive: 'planetary-computer', reason: 'http-status', httpStatus } });
    const show = async (found: ObjectImagery, result: ArchiveImageResult) => {
      const { row } = mountRow(async () => found);
      await flush();
      harness.archive[0]!.resolve(result);
      await flush();
      return row;
    };
    const processing = (row: HTMLElement) => row.querySelector('[data-orbital-image-processing]');

    it('reads as still processing for a Sentinel-1 scene under a day old that answers 404', async () => {
      const row = await show(radar('2026-11-15T09:00:00Z'), failed(404));
      expect(processing(row)?.textContent).toBe('Scene still processing. Try again later.');
      expect(row.querySelector('[data-orbital-image]')).toBeNull();
    });

    it('drops the image as before for an older Sentinel-1 404, a fresh Sentinel-1 non-404 and a fresh 404 from another mission', async () => {
      for (const [found, result] of [
        [radar('2026-11-14T09:00:00Z'), failed(404)],
        [radar('2026-11-15T09:00:00Z'), failed(500)],
        [radar('2026-11-15T09:00:00Z'), { status: 'failed', failure: { archive: 'planetary-computer', reason: 'network' } }],
        [imagery('2026-11-15T09:00:00Z'), failed(404)],
      ] as Array<[ObjectImagery, ArchiveImageResult]>) {
        harness.archive.length = 0;
        const row = await show(found, result);
        expect(processing(row)).toBeNull();
        expect(row.querySelector('[data-orbital-image]')).toBeNull();
        row.remove();
      }
    });
  });

  it('aborts its lookup on dispose and paints nothing when the answer arrives late', async () => {
    let seen: AbortSignal | undefined;
    let answer!: (v: ObjectImagery) => void;
    const { row, dispose } = mountRow((_t, signal) => { seen = signal; return new Promise((r) => { answer = r; }); });
    const loading = row.querySelector('.popup-imagery-body')!.innerHTML;

    dispose();
    expect(seen?.aborted).toBe(true);
    answer(imagery());
    await flush();

    expect(row.querySelector('.popup-imagery-body')!.innerHTML).toBe(loading);
    expect(row.querySelector('[data-orbital-open-evidence]')).toBeNull();
    expect(loadArchiveImage).not.toHaveBeenCalled();
  });

  it('paints the image from its blob URL and releases it on dispose', async () => {
    const release = vi.fn();
    const { row, dispose } = mountRow(async () => imagery());
    await flush();
    expect(harness.archive).toHaveLength(1);
    harness.archive[0]!.resolve(okImage('blob:popup-image', release));
    await flush();

    const img = row.querySelector<HTMLImageElement>('[data-orbital-image] img');
    expect(img?.getAttribute('src')).toBe('blob:popup-image');
    expect(release).not.toHaveBeenCalled();

    dispose();
    expect(harness.archive[0]!.signal?.aborted).toBe(true);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('releases an image that loads after dispose without painting it', async () => {
    const release = vi.fn();
    const { row, dispose } = mountRow(async () => imagery());
    await flush();
    dispose();
    harness.archive[0]!.resolve(okImage('blob:late-image', release));
    await flush();

    expect(release).toHaveBeenCalledTimes(1);
    expect(row.querySelector('img')).toBeNull();
  });
});

describe('#10758 item 1: the image before the next pass', () => {
  it('paints the image as soon as it is known, then fills the next pass without reloading the image', async () => {
    let finish!: (value: ObjectImagery) => void;
    const early = imagery();
    const { row, dispose } = mountRow((_target, _signal, onImageReady) => {
      onImageReady?.({ ...early, nextPass: null, nextPassPending: true });
      return new Promise<ObjectImagery>((resolve) => { finish = resolve; });
    });
    await flush();
    expect(row.querySelector('[data-orbital-next-pass]')?.textContent).toBe('…');
    expect(harness.archive).toHaveLength(1);
    harness.archive[0]!.resolve(okImage('blob:early', vi.fn()));
    await flush();
    const img = row.querySelector('img');
    expect(img?.getAttribute('src')).toBe('blob:early');

    finish({ ...early });
    await flush();
    expect(row.querySelector('[data-orbital-next-pass]')?.textContent).toContain('SENTINEL-2B');
    expect(row.querySelector('img')).toBe(img);
    expect(loadArchiveImage).toHaveBeenCalledTimes(1);
    dispose();
  });
});

describe('next-pass stat', () => {
  afterEach(() => { document.body.replaceChildren(); });

  const statLabels = async (type: string, data: unknown) => {
    const target = imageryTargetFor(type, data);
    expect(target).not.toBeNull();
    const holder = document.createElement('div');
    holder.innerHTML = renderImageryRow();
    const row = holder.firstElementChild as HTMLElement;
    document.body.appendChild(row);
    mountImageryRow(row, target!, { onOpenEvidence: vi.fn(), onLayout: vi.fn(), load: async () => imagery(), now: () => NOW });
    await flush();
    return [...row.querySelectorAll('.stat-label')].map((el) => el.textContent);
  };

  it('asks for the latest optical image of a reservoir, whose radar extent has its own row', () => {
    expect(imageryTargetFor('reservoirLevel', { lat: 10, lon: 20 })).toEqual({ kind: 'point', point: { lat: 10, lon: 20 }, ownNextPass: true, optical: true });
  });

  it('is left out of a reservoir popup, whose own card names the next ICESat-2 crossing', async () => {
    const labels = await statLabels('reservoirLevel', { lat: 10, lon: 20 });
    expect(labels).toEqual([en.orbitalWatch.popup.latest]);
  });

  it('stays in every other popup', async () => {
    const labels = await statLabels('base', { id: 'b1', lat: 10, lon: 20 });
    expect(labels).toEqual([en.orbitalWatch.popup.latest, en.orbitalWatch.popup.nextPass]);
  });
});

describe('#10768: the imagery row credits its sources', () => {
  afterEach(() => { document.body.replaceChildren(); });

  const credit = (row: HTMLElement) => row.querySelector('[data-orbital-credit]')?.textContent ?? '';
  const withProfile = (profileId: string, datetime = '2026-11-14T10:00:00Z'): ObjectImagery => ({ ...imagery(datetime), latest: { ...imagery(datetime).latest!, profileId } });

  it.each([
    ['sentinel-2', IMAGE_CREDIT.copernicus(2026)],
    ['sentinel-1', IMAGE_CREDIT.copernicus(2026)],
    ['landsat', IMAGE_CREDIT.usgs],
  ])('credits a %s image as the source attribution manifest words it', async (profileId, expected) => {
    const { row, dispose } = mountRow(async () => withProfile(profileId));
    await flush();
    expect(credit(row)).toContain(expected);
    dispose();
  });

  it('dates the Copernicus credit by the year the image was taken', async () => {
    const { row, dispose } = mountRow(async () => withProfile('sentinel-2', '2025-12-31T23:00:00Z'));
    await flush();
    expect(credit(row)).toContain(IMAGE_CREDIT.copernicus(2025));
    dispose();
  });

  it('credits CelesTrak when a next pass is shown, and not when there is none', async () => {
    const shown = mountRow(async () => imagery());
    await flush();
    expect(credit(shown.row)).toContain(IMAGE_CREDIT.celestrak);
    shown.dispose();
    document.body.replaceChildren();

    const none = mountRow(async () => ({ ...imagery(), nextPass: null }));
    await flush();
    expect(none.row.querySelector('[data-orbital-next-pass]')?.textContent).toBe(en.orbitalWatch.popup.noPass);
    expect(credit(none.row)).toContain(IMAGE_CREDIT.copernicus(2026));
    expect(credit(none.row)).not.toContain(IMAGE_CREDIT.celestrak);
    none.dispose();
  });

  it('adds the CelesTrak credit when the next pass fills in after the image', async () => {
    let finish!: (value: ObjectImagery) => void;
    const full = imagery();
    const { row, dispose } = mountRow((_target, _signal, onImageReady) => {
      onImageReady?.({ ...full, nextPass: null, nextPassPending: true });
      return new Promise<ObjectImagery>((resolve) => { finish = resolve; });
    });
    await flush();
    const creditCell = row.querySelector('[data-orbital-credit]');
    expect(credit(row)).not.toContain(IMAGE_CREDIT.celestrak);
    finish(full);
    await flush();
    expect(row.querySelector('[data-orbital-credit]')).toBe(creditCell);
    expect(credit(row)).toContain(IMAGE_CREDIT.celestrak);
    expect(loadArchiveImage).toHaveBeenCalledTimes(1);
    dispose();
  });

  it('gives no credit line when there is no image or pass to credit', async () => {
    const { row, dispose } = mountRow(async () => ({ latest: null, nextPass: null }));
    await flush();
    expect(credit(row)).toBe('');
    dispose();
  });

  it('leaves CelesTrak out of a reservoir popup, which shows no next pass of its own', async () => {
    const holder = document.createElement('div');
    holder.innerHTML = renderImageryRow();
    const row = holder.firstElementChild as HTMLElement;
    document.body.appendChild(row);
    const dispose = mountImageryRow(row, imageryTargetFor('reservoirLevel', { lat: 10, lon: 20 })!, { onOpenEvidence: vi.fn(), onLayout: vi.fn(), load: async () => imagery(), now: () => NOW });
    await flush();
    expect(credit(row)).toBe(IMAGE_CREDIT.copernicus(2026));
    dispose();
  });
});

describe('MapPopup imagery row lifecycle', () => {
  let container: HTMLElement;
  let popup: MapPopup;
  const site = (id: string, name: string, lat: number) => ({ id, name, lat, lon: 50.9, type: 'plant', status: 'active', operator: 'AEOI' });

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    popup = new MapPopup(container);
  });
  afterEach(() => { popup.hide('replacement'); container.remove(); document.body.replaceChildren(); });

  it('a late answer for the replaced object never paints into the current popup', async () => {
    // The imagery loader is imported on demand, so each lookup starts a few ticks after show().
    popup.show({ type: 'nuclear', data: site('n1', 'Bushehr', 28.8) as never, x: 10, y: 10 });
    await vi.waitFor(() => expect(harness.loads).toHaveLength(1));
    popup.show({ type: 'nuclear', data: site('n2', 'Natanz', 33.7) as never, x: 10, y: 10 });
    await vi.waitFor(() => expect(harness.loads).toHaveLength(2));
    expect(harness.loads[0]!.signal?.aborted).toBe(true);
    expect(harness.loads[1]!.signal?.aborted).toBe(false);

    harness.loads[0]!.resolve(imagery('2026-11-01T10:00:00Z'));
    await flush();
    const rows = document.querySelectorAll('[data-orbital-imagery]');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.querySelector('[data-orbital-open-evidence]')).toBeNull();
    expect(loadArchiveImage).not.toHaveBeenCalled();

    harness.loads[1]!.resolve(imagery());
    await flush();
    expect(rows[0]!.querySelector('[data-orbital-open-evidence]')).not.toBeNull();
    expect(harness.archive).toHaveLength(1);
  });

  it('closing the popup aborts the image load and releases a painted image', async () => {
    const release = vi.fn();
    popup.show({ type: 'nuclear', data: site('n1', 'Bushehr', 28.8) as never, x: 10, y: 10 });
    await vi.waitFor(() => expect(harness.loads).toHaveLength(1));
    harness.loads[0]!.resolve(imagery());
    await flush();
    harness.archive[0]!.resolve(okImage('blob:shown', release));
    await flush();
    expect(document.querySelector<HTMLImageElement>('[data-orbital-image] img')?.getAttribute('src')).toBe('blob:shown');

    popup.hide();
    expect(harness.loads[0]!.signal?.aborted).toBe(true);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('replacing the popup while its image is loading releases that image when it lands', async () => {
    const release = vi.fn();
    popup.show({ type: 'nuclear', data: site('n1', 'Bushehr', 28.8) as never, x: 10, y: 10 });
    await vi.waitFor(() => expect(harness.loads).toHaveLength(1));
    harness.loads[0]!.resolve(imagery());
    await flush();
    popup.show({ type: 'nuclear', data: site('n2', 'Natanz', 33.7) as never, x: 10, y: 10 });
    expect(harness.archive[0]!.signal?.aborted).toBe(true);

    harness.archive[0]!.resolve(okImage('blob:stale', release));
    await flush();
    expect(release).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[data-orbital-image] img')).toBeNull();
  });
});
