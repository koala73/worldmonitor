/**
 * The NASA GIBS daily mosaic that belongs to a FIRMS fire detection: the layer
 * of the instrument that made the detection, for the detection's UTC date.
 *
 * A daily mosaic is a composite of that day's passes, so finding one says the
 * archive holds the day, not that the fire is visible in it. The time-domain
 * request asks GIBS about the whole globe and carries no position; the image
 * URL does, so it is only ever painted through `loadArchiveImage`.
 */
import type { GeoPoint } from '../../../shared/orbital/pass-geometry.js';
import { GIBS_DAILY_MOSAICS, searchGibsDailyMosaics, type CropPosition } from './archive-gibs';
import type { ArchiveId, ArchiveRequestOptions } from './archive-result';

const DAY_MS = 86_400_000;

export type FireMosaic =
  | { status: 'found'; source: string; date: string; archive: ArchiveId; candidates: string[]; pointInCrop: CropPosition }
  | { status: 'none'; source?: string; date: string; reason: 'no-layer' | 'no-day' }
  | { status: 'failed' };

export interface FireInstrument {
  /** The satellite and instrument as shown to the user; the raw code for one not recognised, null when absent. */
  label: string | null;
  /** The `source` of the GIBS daily layer for this instrument, or null when GIBS has none in the stack. */
  mosaic: string | null;
}

/** FIRMS `satellite` codes: VIIRS rows use N, N20, N21; MODIS rows use Terra and Aqua (or T and A in some exports). */
const INSTRUMENTS: Record<string, FireInstrument> = {
  N: { label: 'VIIRS Suomi NPP', mosaic: 'VIIRS Suomi NPP' },
  N20: { label: 'VIIRS NOAA-20', mosaic: 'VIIRS NOAA-20' },
  N21: { label: 'VIIRS NOAA-21', mosaic: null },
  T: { label: 'MODIS Terra', mosaic: 'MODIS Terra' },
  Terra: { label: 'MODIS Terra', mosaic: 'MODIS Terra' },
  A: { label: 'MODIS Aqua', mosaic: 'MODIS Aqua' },
  Aqua: { label: 'MODIS Aqua', mosaic: 'MODIS Aqua' },
};

export function instrumentOf(satellite: string | undefined): FireInstrument {
  const code = satellite?.trim();
  if (!code) return { label: null, mosaic: null };
  return INSTRUMENTS[code] ?? { label: code, mosaic: null };
}

const isoDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export async function loadFireMosaic(point: GeoPoint, detectedAtMs: number, satellite: string | undefined, options: ArchiveRequestOptions = {}): Promise<FireMosaic> {
  const date = isoDate(detectedAtMs);
  const { mosaic } = instrumentOf(satellite);
  const layer = GIBS_DAILY_MOSAICS.find((candidate) => candidate.source === mosaic);
  if (!layer) return { status: 'none', date, reason: 'no-layer' };
  const dayStart = Date.parse(`${date}T00:00:00Z`);
  const result = await searchGibsDailyMosaics({
    point,
    window: { startMs: dayStart, endMs: dayStart + DAY_MS - 1 },
    nowMs: Date.now(),
    noradIds: new Set([layer.noradId]),
    ...options,
  });
  const row = result.status === 'ok' && (result.failures?.length ?? 0) === 0 ? result.items[0] : undefined;
  if (!row) return { status: 'failed' };
  const day = row.days.find((d) => d.date === date);
  if (!day?.imageUrl) return { status: 'none', source: layer.source, date, reason: 'no-day' };
  return { status: 'found', source: layer.source, date, archive: row.archive, candidates: [day.imageUrl], pointInCrop: row.pointInCrop ?? { x: 0.5, y: 0.5 } };
}

/** What the map holds for one FIRMS detection (`MapFire` plus the fields the popup states). */
export interface FireDetectionPopupData {
  lat: number;
  lon: number;
  brightness: number;
  frp: number;
  /** 0 when unspecified, else 20, 50 or 95 for low, nominal and high. */
  confidence: number;
  region: string;
  acq_date: string;
  daynight: string;
  /** Detection time in epoch milliseconds. */
  detected_at?: number;
  satellite?: string;
  /** Absent on rows that predate the field, which are FIRMS. */
  source?: string;
}

/**
 * Whether a map fire is a satellite detection with a position and a time. Agency-reported
 * fires (CWFIS, BC Wildfire Service) share the layer but are not satellite observations.
 */
export function isFirmsDetection(data: unknown): data is FireDetectionPopupData {
  const d = data as Partial<FireDetectionPopupData> | null;
  return !!d
    && Number.isFinite(d.lat) && Number.isFinite(d.lon)
    && Number.isFinite(d.detected_at) && d.detected_at! > 0
    && (d.source === undefined || d.source === '' || d.source === 'firms');
}
