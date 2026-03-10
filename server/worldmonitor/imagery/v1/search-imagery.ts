import type {
  ServerContext,
  SearchImageryRequest,
  SearchImageryResponse,
  ImageryScene,
} from '../../../../src/generated/server/worldmonitor/imagery/v1/service_server';
import { cachedFetchJson } from '../../../_shared/redis';
import { CHROME_UA } from '../../../_shared/constants';

const STAC_BASE = 'https://capella-open-data.s3.us-west-2.amazonaws.com';
const STAC_HOST = 'capella-open-data.s3.us-west-2.amazonaws.com';
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

function validateDatetime(dt: string): boolean {
  if (!dt) return true;
  const isoPattern = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}Z)?(\/\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}Z)?)?$/;
  if (!isoPattern.test(dt)) return false;
  const oneYearAgo = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);
  const now = new Date();
  return dt.split('/').every(part => {
    const d = new Date(part.slice(0, 10));
    return d >= oneYearAgo && d <= now;
  });
}

function isAllowedStacUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.hostname === STAC_HOST && parsed.protocol === 'https:';
  } catch { return false; }
}

function cacheKey(bbox: string, datetime: string, source: string, limit: number): string {
  const hash = fnv1a(`${bbox}|${datetime}|${source}|${limit}`).toString(36);
  return `imagery:search:${hash}`;
}

function bboxIntersects(
  sceneBbox: [number, number, number, number],
  queryBbox: [number, number, number, number],
): boolean {
  const [sw, ss, se, sn] = sceneBbox;
  const [qw, qs, qe, qn] = queryBbox;
  return sw < qe && se > qw && ss < qn && sn > qs;
}

interface StacItem {
  id: string;
  properties: {
    datetime?: string;
    constellation?: string;
    'sar:instrument_mode'?: string;
    'sar:resolution_range'?: number;
    gsd?: number;
  };
  geometry: unknown;
  bbox?: [number, number, number, number];
  assets?: Record<string, { href?: string; type?: string }>;
  links?: Array<{ rel: string; href: string; type?: string }>;
}

interface StacCollection {
  links: Array<{ rel: string; href: string }>;
}

function mapStacItem(item: StacItem): ImageryScene {
  const props = item.properties;
  const preview = item.assets?.['thumbnail']?.href
    ?? item.links?.find(l => l.rel === 'thumbnail')?.href
    ?? '';
  const asset = item.assets?.['HH']?.href
    ?? item.assets?.['VV']?.href
    ?? Object.values(item.assets ?? {})[0]?.href
    ?? '';

  return {
    id: item.id,
    satellite: props.constellation ?? 'capella',
    datetime: props.datetime ?? '',
    resolutionM: props.gsd ?? props['sar:resolution_range'] ?? 0,
    mode: props['sar:instrument_mode'] ?? '',
    geometryGeojson: JSON.stringify(item.geometry),
    previewUrl: preview,
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

  if (!validateDatetime(req.datetime)) {
    return { scenes: [], totalResults: 0, cacheHit: false };
  }

  const limit = Math.max(1, Math.min(50, req.limit || 10));
  const key = cacheKey(req.bbox, req.datetime, req.source, limit);

  try {
    const result = await cachedFetchJson<{ scenes: ImageryScene[]; totalResults: number }>(
      key,
      CACHE_TTL,
      async () => {
        const catalogUrl = `${STAC_BASE}/catalog.json`;
        const catalogResp = await fetch(catalogUrl, {
          headers: { 'User-Agent': CHROME_UA, Accept: 'application/json' },
          signal: AbortSignal.timeout(10_000),
        });

        if (!catalogResp.ok) {
          console.warn(`[Imagery] Catalog fetch failed: ${catalogResp.status}`);
          return { scenes: [], totalResults: 0 };
        }

        const catalog = (await catalogResp.json()) as StacCollection;
        const childLinks = catalog.links.filter(l => l.rel === 'child');

        const allScenes: ImageryScene[] = [];
        const collectionsToFetch = childLinks.slice(0, 5);

        for (const link of collectionsToFetch) {
          if (allScenes.length >= limit) break;

          try {
            const collUrl = link.href.startsWith('http')
              ? link.href
              : `${STAC_BASE}/${link.href}`;
            if (!isAllowedStacUrl(collUrl)) continue;
            const collResp = await fetch(collUrl, {
              headers: { 'User-Agent': CHROME_UA, Accept: 'application/json' },
              signal: AbortSignal.timeout(8_000),
            });

            if (!collResp.ok) continue;

            const collection = (await collResp.json()) as StacCollection;
            const itemLinks = collection.links.filter(l => l.rel === 'item');

            for (const itemLink of itemLinks.slice(0, 20)) {
              if (allScenes.length >= limit) break;

              try {
                const itemUrl = itemLink.href.startsWith('http')
                  ? itemLink.href
                  : `${STAC_BASE}/${itemLink.href}`;
                if (!isAllowedStacUrl(itemUrl)) continue;
                const itemResp = await fetch(itemUrl, {
                  headers: { 'User-Agent': CHROME_UA, Accept: 'application/json' },
                  signal: AbortSignal.timeout(5_000),
                });

                if (!itemResp.ok) continue;

                const item = (await itemResp.json()) as StacItem;
                if (item.bbox && !bboxIntersects(item.bbox, parsedBbox)) continue;

                allScenes.push(mapStacItem(item));
              } catch {
                continue;
              }
            }
          } catch {
            continue;
          }
        }

        return { scenes: allScenes.slice(0, limit), totalResults: allScenes.length };
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
