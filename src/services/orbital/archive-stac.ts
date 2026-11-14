import type { GeoPoint } from '../../../shared/orbital/pass-geometry.js';
import { isAllowedPreviewUrl } from '../../utils/imagery-preview';
import { formatCoordinate } from './crop-url';
import { failed, requestArchive, type ArchiveFailure, type ArchiveReply, type ArchiveRequestOptions, type ArchiveResult } from './archive-result';
import type { PassWindow } from './pass-query';

export type StacArchiveId = 'earth-search' | 'planetary-computer';
export type ImagingProfileId = 'sentinel-2' | 'sentinel-1' | 'landsat';

/** What the archive's own per-pixel classification says at the point. */
export type PointCondition = 'clear' | 'cloud' | 'cloud-shadow' | 'unknown';

export interface ArchiveItem {
  archive: StacArchiveId;
  collection: string;
  itemId: string;
  profileId: ImagingProfileId;
  /** Lower-case platform with dashes, comparable to a normalised satellite name ("sentinel-2b", "landsat-9"). */
  platform: string;
  /** Relative orbit, or the Landsat WRS path. */
  orbit: number | null;
  /** The span in which the item can have sensed the point. */
  startMs: number;
  endMs: number;
  cloudCoverPct: number | null;
  sunElevationDeg: number | null;
  resolutionM: number;
  /** A whole-scene preview on an allowlisted host. */
  previewUrl: string | null;
  /** Planetary Computer's rendering link, which also drives point crops. */
  renderedPreviewHref: string | null;
  /** The classification asset the archive can read at a point, with how to decode it. */
  classification: { asset: string; scheme: 'sentinel-2-scl' | 'landsat-qa-pixel'; epsg: number | null } | null;
}

interface StacArchiveConfig {
  searchUrl: string;
  collections: Record<string, ImagingProfileId>;
}

export const STAC_ARCHIVES: Record<StacArchiveId, StacArchiveConfig> = {
  'earth-search': {
    searchUrl: 'https://earth-search.aws.element84.com/v1/search',
    collections: { 'sentinel-2-l2a': 'sentinel-2', 'sentinel-1-grd': 'sentinel-1' },
  },
  'planetary-computer': {
    searchUrl: 'https://planetarycomputer.microsoft.com/api/stac/v1/search',
    collections: { 'sentinel-2-l2a': 'sentinel-2', 'landsat-c2-l2': 'landsat' },
  },
};

const PLANETARY_COMPUTER_STATISTICS_URL = 'https://planetarycomputer.microsoft.com/api/data/v1/item/statistics';
/** About a metre: small enough that the box reads the single pixel under the point. */
const POINT_BOX_DEG = 0.00001;
const SEARCH_LIMIT = 100;
const MINUTE_MS = 60_000;
/** A Sentinel-2 strip reaches a point within this long of its sensing start (1.5 to 12 minutes in the reference set). */
const SENTINEL_2_STRIP_REACH_MS = 20 * MINUTE_MS;
const LANDSAT_SCENE_HALF_MS = 15_000;
const NATIVE_RESOLUTION_M: Record<ImagingProfileId, number> = { 'sentinel-2': 10, 'sentinel-1': 10, landsat: 30 };

/** These previews render the visual (TCI) asset, which clips bright ground to flat white or yellow. */
const CLIPPED_PREVIEW = (_archive: StacArchiveId, profileId: ImagingProfileId) =>
  profileId === 'sentinel-2';

export const normalisePlatform = (name: string) => name.trim().toLowerCase().replace(/[\s_]+/g, '-');

type StacProperties = Record<string, unknown>;
interface StacFeature {
  id?: unknown;
  collection?: unknown;
  properties?: StacProperties;
  assets?: Record<string, { href?: unknown } | undefined>;
}

const num = (value: unknown): number | null => {
  const parsed = typeof value === 'string' ? Number(value) : value;
  return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : null;
};
const str = (value: unknown): string | null => (typeof value === 'string' && value.length > 0 ? value : null);
const time = (value: unknown): number | null => {
  const ms = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(ms) ? ms : null;
};

function compactTimeMs(compact: string): number | null {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/.exec(compact);
  return m ? Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!) : null;
}

function s3ToHttps(url: string): string {
  if (!url.startsWith('s3://')) return url;
  const rest = url.slice(5);
  const slash = rest.indexOf('/');
  return slash === -1 ? url : `https://${rest.slice(0, slash)}.s3.amazonaws.com/${rest.slice(slash + 1)}`;
}

function senseSpan(archive: StacArchiveId, profileId: ImagingProfileId, p: StacProperties): [number, number] | null {
  const at = time(p.datetime);
  if (profileId === 'sentinel-2' && archive === 'planetary-computer') {
    // Planetary Computer stamps the datatake start; the datastrip start is closer to the point.
    const strip = /_S(\d{8}T\d{6})_/.exec(str(p['s2:datastrip_id']) ?? '');
    const start = (strip && compactTimeMs(strip[1]!)) ?? at;
    return start === null ? null : [start, start + SENTINEL_2_STRIP_REACH_MS];
  }
  if (profileId === 'landsat') return at === null ? null : [at - LANDSAT_SCENE_HALF_MS, at + LANDSAT_SCENE_HALF_MS];
  const start = time(p.start_datetime) ?? at;
  const end = time(p.end_datetime) ?? at;
  return start === null || end === null ? null : [start, Math.max(start, end)];
}

function orbitOf(p: StacProperties): number | null {
  const relative = num(p['sat:relative_orbit']) ?? num(p['landsat:wrs_path']);
  if (relative !== null) return relative;
  const fromUri = /_R(\d{3})_/.exec(str(p['s2:product_uri']) ?? '');
  return fromUri ? Number(fromUri[1]) : null;
}

export function parseStacItem(archive: StacArchiveId, feature: StacFeature): ArchiveItem | null {
  const collection = str(feature.collection);
  const profileId = collection ? STAC_ARCHIVES[archive].collections[collection] : undefined;
  const itemId = str(feature.id);
  const p = feature.properties;
  const platform = str(p?.platform);
  if (!collection || !profileId || !itemId || !p || !platform) return null;
  const span = senseSpan(archive, profileId, p);
  if (!span) return null;
  const assets = feature.assets ?? {};
  const href = (key: string) => {
    const raw = str(assets[key]?.href);
    return raw ? s3ToHttps(raw) : null;
  };
  const renderedPreviewHref = archive === 'planetary-computer' ? href('rendered_preview') : null;
  const thumbnail = renderedPreviewHref ?? href('thumbnail');
  const zenith = num(p['s2:mean_solar_zenith']);
  const epsg = num(p['proj:epsg']);
  const classification =
    archive !== 'planetary-computer' ? null
    : profileId === 'sentinel-2' && assets.SCL ? { asset: 'SCL', scheme: 'sentinel-2-scl' as const, epsg }
    : profileId === 'landsat' && assets.qa_pixel ? { asset: 'qa_pixel', scheme: 'landsat-qa-pixel' as const, epsg }
    : null;
  return {
    archive,
    collection,
    itemId,
    profileId,
    platform: normalisePlatform(platform),
    orbit: orbitOf(p),
    startMs: span[0],
    endMs: span[1],
    cloudCoverPct: num(p['eo:cloud_cover']),
    sunElevationDeg: num(p['view:sun_elevation']) ?? (zenith === null ? null : 90 - zenith),
    resolutionM: num(p.gsd) ?? NATIVE_RESOLUTION_M[profileId],
    previewUrl: thumbnail && isAllowedPreviewUrl(thumbnail) && !CLIPPED_PREVIEW(archive, profileId) ? thumbnail : null,
    renderedPreviewHref,
    classification,
  };
}

export interface StacSearchQuery extends ArchiveRequestOptions {
  point: GeoPoint;
  window: PassWindow;
}

const SEARCH_HEADERS = { 'Content-Type': 'application/json', Accept: 'application/geo+json' };
/** Pages followed before a search counts as unanswered rather than silently cut short. */
const MAX_SEARCH_PAGES = 10;
/** Planetary Computer stamps Sentinel-2 items with the datatake start, up to half an hour before the point is sensed. */
const SEARCH_LEAD_MS = 60 * MINUTE_MS;

interface StacLink {
  rel?: unknown;
  href?: unknown;
  method?: unknown;
  body?: unknown;
  merge?: unknown;
}

type NextRequest = { url: string; init: RequestInit } | null;

function nextRequest(links: unknown, searchUrl: string, body: Record<string, unknown>): NextRequest {
  const next = Array.isArray(links) ? (links as StacLink[]).find((link) => link?.rel === 'next') : undefined;
  const href = str(next?.href);
  let url: URL;
  try {
    url = new URL(href ?? '', searchUrl);
  } catch {
    return null;
  }
  if (!next || !href || url.origin !== new URL(searchUrl).origin) return null;
  if (String(next.method ?? 'GET').toUpperCase() !== 'POST') return { url: url.toString(), init: { method: 'GET' } };
  const nextBody = next.body && typeof next.body === 'object' ? next.body as Record<string, unknown> : {};
  return {
    url: url.toString(),
    init: { method: 'POST', headers: SEARCH_HEADERS, body: JSON.stringify(next.merge === true ? { ...body, ...nextBody } : nextBody) },
  };
}

interface StacSearchPage {
  features: unknown[];
  links?: unknown;
}

async function readSearchPage(response: Response): Promise<StacSearchPage> {
  const page = (await response.json()) as { features?: unknown; links?: unknown };
  if (!Array.isArray(page.features)) throw new TypeError('no features');
  return { features: page.features, links: page.links };
}

/** One search per archive, sent straight from the browser to the archive. */
export async function searchStacArchive(archive: StacArchiveId, query: StacSearchQuery): Promise<ArchiveResult<ArchiveItem>> {
  const config = STAC_ARCHIVES[archive];
  const body = {
    collections: Object.keys(config.collections),
    intersects: { type: 'Point', coordinates: [query.point.lon, query.point.lat] },
    datetime: `${new Date(query.window.startMs - SEARCH_LEAD_MS).toISOString()}/${new Date(query.window.endMs).toISOString()}`,
    limit: SEARCH_LIMIT,
  };
  const features: unknown[] = [];
  let request: NextRequest = { url: config.searchUrl, init: { method: 'POST', headers: SEARCH_HEADERS, body: JSON.stringify(body) } };
  for (let page = 0; request; page++) {
    if (page === MAX_SEARCH_PAGES) return failed({ archive, reason: 'invalid-response' });
    const reply: ArchiveReply<StacSearchPage> = await requestArchive(archive, request.url, request.init, query, readSearchPage);
    if (!reply.ok) return failed(reply.failure);
    const parsed: StacSearchPage = reply.value;
    features.push(...parsed.features);
    request = parsed.features.length > 0 ? nextRequest(parsed.links, config.searchUrl, body) : null;
  }
  const items = features.flatMap((feature) => {
    const item = feature && typeof feature === 'object' ? parseStacItem(archive, feature as StacFeature) : null;
    return item && item.endMs >= query.window.startMs && item.startMs <= query.window.endMs ? [item] : [];
  });
  return { status: 'ok', archive, items };
}

const SCL_CONDITION: Record<number, PointCondition> = {
  2: 'clear', 3: 'cloud-shadow', 4: 'clear', 5: 'clear', 6: 'clear', 7: 'clear', 8: 'cloud', 9: 'cloud', 10: 'cloud', 11: 'clear',
};

export function decodePointCondition(scheme: 'sentinel-2-scl' | 'landsat-qa-pixel', value: number | null): PointCondition {
  if (value === null || !Number.isInteger(value)) return 'unknown';
  if (scheme === 'sentinel-2-scl') return SCL_CONDITION[value] ?? 'unknown';
  const bit = (n: number) => (value & (1 << n)) !== 0;
  if (bit(0)) return 'unknown';
  if (bit(1) || bit(2) || bit(3)) return 'cloud';
  if (bit(4)) return 'cloud-shadow';
  return bit(6) || bit(7) ? 'clear' : 'unknown';
}

export interface PointConditionReading {
  condition: PointCondition;
  failure?: ArchiveFailure;
}

/** Reads the archive's classification pixel at the point. Only Planetary Computer serves this. */
export async function readPointCondition(item: ArchiveItem, point: GeoPoint, options: ArchiveRequestOptions = {}): Promise<PointConditionReading> {
  if (!item.classification) return { condition: 'unknown' };
  const params = new URLSearchParams({ collection: item.collection, item: item.itemId, assets: item.classification.asset });
  // In the scene's own grid the box falls inside the one pixel under the point; reprojected, it can land on a neighbour.
  if (item.classification.epsg !== null) params.set('dst_crs', `epsg:${item.classification.epsg}`);
  const url = `${PLANETARY_COMPUTER_STATISTICS_URL}?${params}`;
  // The point travels in the body: RUM collectors report request paths, and the archive's point route puts it there.
  const [west, east, south, north] = [point.lon - POINT_BOX_DEG, point.lon + POINT_BOX_DEG, point.lat - POINT_BOX_DEG, point.lat + POINT_BOX_DEG].map((v) => Number(formatCoordinate(v)));
  const feature = {
    type: 'Feature',
    properties: {},
    geometry: { type: 'Polygon', coordinates: [[[west, south], [east, south], [east, north], [west, north], [west, south]]] },
  };
  const init: RequestInit = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(feature) };
  const reply = await requestArchive('planetary-computer', url, init, options, async (response) => {
    const { properties } = (await response.json()) as { properties?: { statistics?: Record<string, { majority?: unknown }> } };
    const band = Object.values(properties?.statistics ?? {})[0];
    return band ? num(band.majority) : null;
  });
  return reply.ok
    ? { condition: decodePointCondition(item.classification.scheme, reply.value) }
    : { condition: 'unknown', failure: reply.failure };
}
