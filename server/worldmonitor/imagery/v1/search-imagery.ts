import {
  ValidationError,
  type ServerContext,
  type SearchImageryRequest,
  type SearchImageryResponse,
  type ImageryScene,
} from '../../../../src/generated/server/worldmonitor/imagery/v1/service_server';
import { cachedFetchJsonWithMeta } from '../../../_shared/redis';
import { CHROME_UA } from '../../../_shared/constants';
import { sha256Hex } from '../../../_shared/hash';

const STAC_SEARCH = 'https://earth-search.aws.element84.com/v1/search';
const COLLECTIONS = ['sentinel-2-l2a', 'sentinel-1-grd'];
const CACHE_TTL = 3600;

function validateBbox(bbox: string): [number, number, number, number] | null {
  const parts = bbox.split(',').map(Number);
  if (parts.length !== 4 || parts.some(Number.isNaN)) return null;
  const w = parts[0]!;
  const s = parts[1]!;
  const e = parts[2]!;
  const n = parts[3]!;
  if (w < -180 || w > 180 || e < -180 || e > 180) return null;
  if (s < -90 || s > 90 || n < -90 || n > 90) return null;
  if (w >= e || s >= n) return null;
  return [w, s, e, n];
}

function normalizeDatetime(value: string): string | null {
  if (value.length > 80) return null;
  const parts = value.trim().split('/');
  if (parts.length > 2) return null;
  const normalized = parts.map(part => {
    if (parts.length === 2 && (part === '' || part === '..')) return { value: '..', order: '' };
    const match = /^(\d{4}-\d{2}-\d{2})(?:[Tt]([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.(\d{1,9}))?([Zz]|[+-](?:[01]\d|2[0-3]):[0-5]\d))?$/.exec(part);
    if (!match) return null;
    const date = match[1]!;
    const day = new Date(`${date}T00:00:00Z`);
    if (!Number.isFinite(day.getTime()) || day.toISOString().slice(0, 10) !== date) return null;
    if (!match[2]) return { value: date, order: `${date}T00:00:00.000000000Z` };
    const instant = new Date(`${date}T${match[2]}:${match[3]}:${match[4]}${match[6]!.toUpperCase()}`).toISOString();
    if (!/^\d{4}-/.test(instant)) return null;
    const seconds = instant.slice(0, 19);
    const fraction = (match[5] ?? '').replace(/0+$/, '');
    return {
      value: `${seconds}${fraction ? `.${fraction}` : ''}Z`,
      order: `${seconds}.${fraction.padEnd(9, '0')}Z`,
    };
  });
  if (normalized.some(part => part === null)) return null;
  const start = normalized[0]!;
  const end = normalized[1];
  if (end && ((!start.order && !end.order) || (start.order && end.order && start.order > end.order))) return null;
  return normalized.map(part => part!.value).join('/');
}

interface StacFeature {
  id: string;
  properties: {
    datetime?: string;
    constellation?: string;
    platform?: string;
    'sar:instrument_mode'?: string;
    'sar:resolution_range'?: number;
    'eo:cloud_cover'?: number;
    gsd?: number;
  };
  geometry: unknown;
  bbox?: number[];
  assets?: Record<string, { href?: string; type?: string; roles?: string[] }>;
  links?: Array<{ rel: string; href: string; type?: string }>;
}

interface StacSearchResponse {
  type: string;
  features: StacFeature[];
  numberMatched?: number;
  context?: { matched?: number };
}

function s3ToHttps(url: string): string {
  if (!url.startsWith('s3://')) return url;
  const withoutProto = url.slice(5);
  const slashIdx = withoutProto.indexOf('/');
  if (slashIdx === -1) return url;
  const bucket = withoutProto.slice(0, slashIdx);
  const key = withoutProto.slice(slashIdx + 1);
  return `https://${bucket}.s3.amazonaws.com/${key}`;
}

function mapFeature(f: StacFeature): ImageryScene {
  const props = f.properties;
  const thumbnail = s3ToHttps(
    f.assets?.thumbnail?.href
    ?? f.assets?.overview?.href
    ?? f.links?.find(l => l.rel === 'thumbnail')?.href
    ?? '',
  );
  const asset = f.assets?.visual?.href
    ?? f.assets?.vv?.href
    ?? f.assets?.vh?.href
    ?? '';
  const satellite = props.constellation ?? props.platform ?? 'unknown';
  const mode = props['sar:instrument_mode'] ?? (satellite.includes('sentinel-2') ? 'MSI' : '');
  const resolution = props.gsd ?? props['sar:resolution_range'] ?? 10;

  return {
    id: f.id,
    satellite,
    datetime: props.datetime ?? '',
    resolutionM: resolution,
    mode,
    geometryGeojson: JSON.stringify(f.geometry),
    previewUrl: thumbnail,
    assetUrl: asset,
  };
}

export async function searchImagery(
  _ctx: ServerContext,
  req: SearchImageryRequest,
): Promise<SearchImageryResponse> {
  if (!req.bbox) {
    return { scenes: [], totalResults: 0, cacheHit: false };
  }

  const parsedBbox = validateBbox(req.bbox);
  if (!parsedBbox) {
    return { scenes: [], totalResults: 0, cacheHit: false };
  }

  const limit = Math.max(1, Math.min(50, req.limit || 10));
  const nowHour = new Date();
  nowHour.setMinutes(0, 0, 0);
  const weekAgo = new Date(nowHour.getTime() - 7 * 24 * 60 * 60 * 1000);
  const defaultDatetime = `${weekAgo.toISOString().split('.')[0]}Z/${nowHour.toISOString().split('.')[0]}Z`;
  const datetime = normalizeDatetime(req.datetime || defaultDatetime);
  if (datetime === null) throw new ValidationError([{ field: 'datetime', description: 'Invalid imagery datetime' }]);
  const source = (req.source ?? '').trim().toLowerCase();
  const matchedCollections = COLLECTIONS.filter(collection => collection.includes(source));
  const collections = matchedCollections.length > 0 ? matchedCollections : COLLECTIONS;
  const body = JSON.stringify({
    bbox: parsedBbox,
    datetime,
    collections,
    limit,
    sortby: [{ field: 'properties.datetime', direction: 'desc' }],
  });

  try {
    const key = `imagery:search:v2:${await sha256Hex(body)}`;
    const result = await cachedFetchJsonWithMeta<{ scenes: ImageryScene[]; totalResults: number }>(
      key,
      CACHE_TTL,
      async () => {

        const resp = await fetch(STAC_SEARCH, {
          method: 'POST',
          headers: {
            'User-Agent': CHROME_UA,
            'Content-Type': 'application/json',
            Accept: 'application/geo+json',
          },
          body,
          signal: AbortSignal.timeout(10_000),
        });

        if (!resp.ok) {
          console.warn(`[Imagery] STAC search failed: ${resp.status}`);
          return { scenes: [], totalResults: 0 };
        }

        const data = (await resp.json()) as StacSearchResponse;
        const scenes = data.features.map(mapFeature);
        const totalResults = data.numberMatched ?? data.context?.matched ?? scenes.length;

        return { scenes, totalResults };
      },
    );

    if (result.data) {
      return {
        scenes: result.data.scenes,
        totalResults: result.data.totalResults,
        cacheHit: result.source === 'cache',
      };
    }
    return { scenes: [], totalResults: 0, cacheHit: result.source === 'cache' };
  } catch (err) {
    console.warn(`[Imagery] Search failed: ${err instanceof Error ? err.message : 'unknown'}`);
    return { scenes: [], totalResults: 0, cacheHit: false };
  }
}
