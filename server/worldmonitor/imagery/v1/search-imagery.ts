import type {
  ServerContext,
  SearchImageryRequest,
  SearchImageryResponse,
  ImageryScene,
} from '../../../../src/generated/server/worldmonitor/imagery/v1/service_server';
import { cachedFetchJson } from '../../../_shared/redis';
import { CHROME_UA } from '../../../_shared/constants';

const STAC_SEARCH = 'https://earth-search.aws.element84.com/v1/search';
const COLLECTIONS = ['sentinel-2-l2a', 'sentinel-1-grd'];
const CACHE_TTL = 3600;

function fnv1a(str: string): number {
  let hash = 2166136261;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function validateBbox(bbox: string): [number, number, number, number] | null {
  const parts = bbox.split(',').map(Number);
  if (parts.length !== 4 || parts.some(isNaN)) return null;
  const w = parts[0]!;
  const s = parts[1]!;
  const e = parts[2]!;
  const n = parts[3]!;
  if (w < -180 || w > 180 || e < -180 || e > 180) return null;
  if (s < -90 || s > 90 || n < -90 || n > 90) return null;
  if (w >= e || s >= n) return null;
  return [w, s, e, n];
}

function cacheKey(bbox: string, datetime: string, source: string, limit: number): string {
  const hash = fnv1a(`${bbox}|${datetime}|${source}|${limit}`).toString(36);
  return `imagery:search:${hash}`;
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
    f.assets?.['thumbnail']?.href
    ?? f.assets?.['overview']?.href
    ?? f.links?.find(l => l.rel === 'thumbnail')?.href
    ?? '',
  );
  const asset = f.assets?.['visual']?.href
    ?? f.assets?.['vv']?.href
    ?? f.assets?.['vh']?.href
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
  const snappedBbox = parsedBbox.map(v => Math.round(v)).join(',');
  const nowHour = new Date();
  nowHour.setMinutes(0, 0, 0);
  const weekAgo = new Date(nowHour.getTime() - 7 * 24 * 60 * 60 * 1000);
  const defaultDatetime = `${weekAgo.toISOString().split('.')[0]}Z/${nowHour.toISOString().split('.')[0]}Z`;
  const datetime = req.datetime || defaultDatetime;
  const key = cacheKey(snappedBbox, datetime, req.source, limit);

  try {
    const result = await cachedFetchJson<{ scenes: ImageryScene[]; totalResults: number }>(
      key,
      CACHE_TTL,
      async () => {

        const LEGACY_SOURCE_MAP: Record<string, string[]> = {
          capella: COLLECTIONS,
          'sentinel-1': ['sentinel-1-grd'],
          'sentinel-2': ['sentinel-2-l2a'],
        };
        let collections = COLLECTIONS;
        if (req.source) {
          const src = req.source.toLowerCase();
          const legacy = LEGACY_SOURCE_MAP[src];
          if (legacy) {
            collections = legacy;
          } else {
            const matched = COLLECTIONS.filter(c => c.toLowerCase().includes(src));
            if (matched.length > 0) collections = matched;
          }
        }

        const body = {
          bbox: parsedBbox,
          datetime,
          collections,
          limit,
          sortby: [{ field: 'properties.datetime', direction: 'desc' }],
        };

        const resp = await fetch(STAC_SEARCH, {
          method: 'POST',
          headers: {
            'User-Agent': CHROME_UA,
            'Content-Type': 'application/json',
            Accept: 'application/geo+json',
          },
          body: JSON.stringify(body),
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

    if (result) {
      return { scenes: result.scenes, totalResults: result.totalResults, cacheHit: true };
    }
    return { scenes: [], totalResults: 0, cacheHit: false };
  } catch (err) {
    console.warn(`[Imagery] Search failed: ${err instanceof Error ? err.message : 'unknown'}`);
    return { scenes: [], totalResults: 0, cacheHit: false };
  }
}
