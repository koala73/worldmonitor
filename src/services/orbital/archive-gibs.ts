import type { GeoPoint } from '../../../shared/orbital/pass-geometry.js';
import { failed, requestArchive, type ArchiveFailure, type ArchiveId, type ArchiveRequestOptions, type ArchiveResult } from './archive-result';
import { cropBox, gibsSnapshotUrl, type CropBox } from './crop-url';
import type { PassWindow } from './pass-query';

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const GIBS_DOMAINS_URL = 'https://gibs.earthdata.nasa.gov/wmts/epsg4326/best/1.0.0';
/** How far back to look for the newest geostationary frame. */
export const GEOSTATIONARY_LOOKBACK_MS = 6 * HOUR_MS;
const MAX_TIME_STEPS = 2_000;

export interface TimeRange {
  startMs: number;
  endMs: number;
  stepMs: number;
}

/** One image-per-day global layer, shown in its own row and never counted as a pass's image. No days means the source is unavailable. */
export interface DailyMosaicRow {
  kind: 'daily-mosaic';
  archive: ArchiveId;
  source: string;
  layer: string;
  noradId: number;
  days: Array<{ date: string; imageUrl: string | null }>;
}

/** The newest full-disk frame of a geostationary satellite that sees the point. */
export interface GeostationaryRow {
  kind: 'geostationary';
  archive: ArchiveId;
  source: string;
  layer: string;
  noradId: number;
  cadenceMinutes: number | null;
  latest: { time: string; imageUrl: string | null } | null;
}

interface GibsLayer {
  source: string;
  layer: string;
  matrixSet: string;
  noradId: number;
}

export const GIBS_DAILY_MOSAICS: readonly GibsLayer[] = [
  { source: 'MODIS Terra', layer: 'MODIS_Terra_CorrectedReflectance_TrueColor', matrixSet: '250m', noradId: 25994 },
  { source: 'MODIS Aqua', layer: 'MODIS_Aqua_CorrectedReflectance_TrueColor', matrixSet: '250m', noradId: 27424 },
  { source: 'VIIRS Suomi NPP', layer: 'VIIRS_SNPP_CorrectedReflectance_TrueColor', matrixSet: '250m', noradId: 37849 },
  { source: 'VIIRS NOAA-20', layer: 'VIIRS_NOAA20_CorrectedReflectance_TrueColor', matrixSet: '250m', noradId: 43013 },
];

export const GIBS_GEOSTATIONARY: readonly GibsLayer[] = [
  { source: 'GOES-East', layer: 'GOES-East_ABI_GeoColor', matrixSet: '1km', noradId: 60133 },
  { source: 'GOES-West', layer: 'GOES-West_ABI_GeoColor', matrixSet: '1km', noradId: 51850 },
  { source: 'Himawari-9', layer: 'Himawari_AHI_Band3_Red_Visible_1km', matrixSet: '1km', noradId: 41836 },
];

function periodMs(period: string): number | null {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(period);
  if (!m) return null;
  const ms = (+(m[1] ?? 0)) * DAY_MS + (+(m[2] ?? 0)) * HOUR_MS + (+(m[3] ?? 0)) * 60_000 + (+(m[4] ?? 0)) * 1000;
  return ms > 0 ? ms : null;
}

/** Parses OGC time extents such as `2026-11-06/2026-11-13/P1D,2026-11-14T00:00:00Z/...`. */
export function parseTimeDomain(text: string): TimeRange[] {
  return text.split(',').flatMap((part) => {
    const [start, end, period] = part.trim().split('/');
    const startMs = Date.parse(start ?? '');
    const endMs = Date.parse(end ?? '');
    const stepMs = periodMs(period ?? '');
    return Number.isFinite(startMs) && Number.isFinite(endMs) && stepMs !== null && endMs >= startMs ? [{ startMs, endMs, stepMs }] : [];
  });
}

/** Every time step of `ranges` inside [fromMs, toMs]. */
export function timesWithin(ranges: TimeRange[], fromMs: number, toMs: number): number[] {
  const times: number[] = [];
  for (const { startMs, endMs, stepMs } of ranges) {
    const first = startMs + Math.max(0, Math.ceil((fromMs - startMs) / stepMs)) * stepMs;
    for (let t = first; t <= Math.min(endMs, toMs) && times.length < MAX_TIME_STEPS; t += stepMs) times.push(t);
  }
  return times.sort((a, b) => a - b);
}

const startOfUtcDay = (ms: number) => Math.floor(ms / DAY_MS) * DAY_MS;
const isoDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const isoSecond = (ms: number) => `${new Date(ms).toISOString().slice(0, 19)}Z`;

/** Asks GIBS which times a layer has, for the whole globe, so the request carries no point. */
export type LayerTimes =
  | { ok: true; times: number[]; stepMs: number | null }
  | { ok: false; failure: ArchiveFailure };

async function layerTimes(layer: GibsLayer, fromMs: number, toMs: number, daily: boolean, options: ArchiveRequestOptions): Promise<LayerTimes> {
  const fmt = daily ? isoDate : isoSecond;
  const url = `${GIBS_DOMAINS_URL}/${layer.layer}/default/${layer.matrixSet}/all/${fmt(fromMs)}--${fmt(toMs)}.xml`;
  const reply = await requestArchive('nasa-gibs', url, {}, options, async (response) => {
    const domain = /<Domain>([^<]*)<\/Domain>/.exec(await response.text());
    if (!domain) throw new TypeError('no time domain');
    return parseTimeDomain(domain[1]!);
  });
  if (!reply.ok) return { ok: false, failure: { ...reply.failure, source: layer.source } };
  const ranges = reply.value;
  return { ok: true, times: timesWithin(ranges, daily ? startOfUtcDay(fromMs) : fromMs, toMs), stepMs: ranges[ranges.length - 1]?.stepMs ?? null };
}

/** Every layer's failure; the whole archive counts as failed only when no layer answered. */
export function layerFailures(answers: LayerTimes[]): { failures: ArchiveFailure[]; allFailed: boolean } {
  const failures = answers.flatMap((answer) => (answer.ok ? [] : [answer.failure]));
  return { failures, allFailed: answers.length > 0 && failures.length === answers.length };
}

export interface FrameQuery extends ArchiveRequestOptions {
  point: GeoPoint;
  window: PassWindow;
  nowMs: number;
  box?: CropBox;
}

export async function searchGibsDailyMosaics(query: FrameQuery): Promise<ArchiveResult<DailyMosaicRow>> {
  const box = query.box ?? cropBox(query.point);
  const toMs = Math.min(query.window.endMs, query.nowMs);
  const answers = await Promise.all(GIBS_DAILY_MOSAICS.map((layer) => layerTimes(layer, query.window.startMs, toMs, true, query)));
  const { failures, allFailed } = layerFailures(answers);
  if (allFailed) return failed(failures[0]!);
  const items = GIBS_DAILY_MOSAICS.map((layer, i): DailyMosaicRow => {
    const answer = answers[i]!;
    const days = (answer.ok ? answer.times : []).map((t) => isoDate(t)).reverse().map((date) => ({ date, imageUrl: gibsSnapshotUrl(layer.layer, date, box) }));
    return { kind: 'daily-mosaic', archive: 'nasa-gibs', source: layer.source, layer: layer.layer, noradId: layer.noradId, days };
  });
  return { status: 'ok', archive: 'nasa-gibs', items, failures };
}

/** Frames for the geostationary satellites the pass computation found in view of the point. */
export async function searchGibsGeostationary(query: FrameQuery & { visibleNoradIds: ReadonlySet<number> }): Promise<ArchiveResult<GeostationaryRow>> {
  const layers = GIBS_GEOSTATIONARY.filter((layer) => query.visibleNoradIds.has(layer.noradId));
  const box = query.box ?? cropBox(query.point);
  const fromMs = query.nowMs - GEOSTATIONARY_LOOKBACK_MS;
  const answers = await Promise.all(layers.map((layer) => layerTimes(layer, fromMs, query.nowMs, false, query)));
  const { failures, allFailed } = layerFailures(answers);
  if (allFailed) return failed(failures[0]!);
  const items = layers.map((layer, i): GeostationaryRow => {
    const answer = answers[i]!;
    const latestMs = answer.ok ? answer.times[answer.times.length - 1] : undefined;
    const time = latestMs === undefined ? null : isoSecond(latestMs);
    return {
      kind: 'geostationary',
      archive: 'nasa-gibs',
      source: layer.source,
      layer: layer.layer,
      noradId: layer.noradId,
      cadenceMinutes: !answer.ok || answer.stepMs === null ? null : answer.stepMs / 60_000,
      latest: time ? { time, imageUrl: gibsSnapshotUrl(layer.layer, time, box) } : null,
    };
  });
  return { status: 'ok', archive: 'nasa-gibs', items, failures };
}
