import type { ListWebcamsRequest, ListWebcamsResponse, WebcamEntry, WebcamCluster, ServerContext } from '../../../../src/generated/server/worldmonitor/webcam/v1/service_server';
import { geoSearchByBox, getHashFieldsBatch, getCachedJson, setCachedJson } from '../../../_shared/redis';

const MAX_RESULTS = 2000;
const RESPONSE_CACHE_TTL = 3600; // 1 hour

function getClusterCellSize(zoom: number): number {
  if (zoom < 3) return 8;
  if (zoom <= 4) return 5;
  if (zoom <= 6) return 2;
  if (zoom <= 8) return 0.5;
  return 0; // no clustering
}

function clusterWebcams(
  webcams: Array<{ webcamId: string; title: string; lat: number; lng: number; category: string; country: string }>,
  cellSize: number,
): { singles: WebcamEntry[]; clusters: WebcamCluster[] } {
  if (cellSize <= 0) {
    return {
      singles: webcams.map(w => ({
        webcamId: w.webcamId, title: w.title,
        lat: w.lat, lng: w.lng,
        category: w.category, country: w.country,
      })),
      clusters: [],
    };
  }

  const buckets = new Map<string, typeof webcams>();
  for (const w of webcams) {
    const key = `${Math.floor(w.lat / cellSize)}:${Math.floor(w.lng / cellSize)}`;
    let bucket = buckets.get(key);
    if (!bucket) { bucket = []; buckets.set(key, bucket); }
    bucket.push(w);
  }

  const singles: WebcamEntry[] = [];
  const clusters: WebcamCluster[] = [];

  for (const bucket of buckets.values()) {
    if (bucket.length === 1) {
      const w = bucket[0]!;
      singles.push({
        webcamId: w.webcamId, title: w.title,
        lat: w.lat, lng: w.lng,
        category: w.category, country: w.country,
      });
    } else {
      // Circular mean for longitude (antimeridian-safe)
      const toRad = Math.PI / 180;
      const toDeg = 180 / Math.PI;
      let sinSum = 0, cosSum = 0, latSum = 0;
      const catSet = new Set<string>();
      for (const w of bucket) {
        latSum += w.lat;
        sinSum += Math.sin(w.lng * toRad);
        cosSum += Math.cos(w.lng * toRad);
        catSet.add(w.category);
      }
      clusters.push({
        lat: latSum / bucket.length,
        lng: Math.atan2(sinSum, cosSum) * toDeg,
        count: bucket.length,
        categories: [...catSet],
      });
    }
  }

  return { singles, clusters };
}

export async function listWebcams(_ctx: ServerContext, req: ListWebcamsRequest): Promise<ListWebcamsResponse> {
  const { zoom = 3 } = req;

  // Quantize bounds so the GEOSEARCH matches the cache key semantics.
  // Every viewport that maps to the same quantized key gets the same superset query.
  const qW = Math.floor(req.boundW ?? -180);
  const qS = Math.floor(req.boundS ?? -90);
  const qE = Math.ceil(req.boundE ?? 180);
  const qN = Math.ceil(req.boundN ?? 90);

  // Read active version
  const versionResult = await getCachedJson('webcam:cameras:active');
  const version = versionResult != null ? String(versionResult) : null;
  if (!version) {
    return { webcams: [], clusters: [], totalInView: 0 };
  }

  // Check response cache (quantized bbox + zoom + version)
  const cacheKey = `webcam:resp:${version}:${zoom}:${qW}:${qS}:${qE}:${qN}`;
  const cached = await getCachedJson(cacheKey) as ListWebcamsResponse | null;
  if (cached) return cached;

  const geoKey = `webcam:cameras:geo:${version}`;
  const metaKey = `webcam:cameras:meta:${version}`;

  // Compute center and dimensions for GEOSEARCH using quantized bounds
  const centerLat = (qN + qS) / 2;
  const heightKm = Math.abs(qN - qS) * 111.32;

  // Antimeridian: if W > E, split into two queries
  let ids: string[];
  if (qW > qE) {
    const centerLon1 = (qW + 180) / 2;
    const centerLon2 = (-180 + qE) / 2;
    const width1 = (180 - qW) * 111.32 * Math.cos(centerLat * Math.PI / 180);
    const width2 = (qE + 180) * 111.32 * Math.cos(centerLat * Math.PI / 180);
    const [ids1, ids2] = await Promise.all([
      geoSearchByBox(geoKey, centerLon1, centerLat, width1, heightKm, MAX_RESULTS, true),
      geoSearchByBox(geoKey, centerLon2, centerLat, width2, heightKm, MAX_RESULTS, true),
    ]);
    ids = [...ids1, ...ids2];
  } else {
    const centerLon = (qW + qE) / 2;
    const widthKm = equirectangularWidthKm(qS, qN, qW, qE);
    ids = await geoSearchByBox(geoKey, centerLon, centerLat, widthKm, heightKm, MAX_RESULTS, true);
  }

  if (ids.length === 0) {
    const empty: ListWebcamsResponse = { webcams: [], clusters: [], totalInView: 0 };
    await setCachedJson(cacheKey, empty, RESPONSE_CACHE_TTL);
    return empty;
  }

  // Fetch metadata
  const metaMap = await getHashFieldsBatch(metaKey, ids, true);
  const webcams: Array<{ webcamId: string; title: string; lat: number; lng: number; category: string; country: string }> = [];

  for (const id of ids) {
    const raw = metaMap.get(id);
    if (!raw) continue;
    try {
      const meta = JSON.parse(raw);
      webcams.push({
        webcamId: id,
        title: meta.title || '',
        lat: meta.lat || 0,
        lng: meta.lng || 0,
        category: meta.category || 'other',
        country: meta.country || '',
      });
    } catch { /* skip malformed */ }
  }

  const cellSize = getClusterCellSize(zoom);
  const { singles, clusters } = clusterWebcams(webcams, cellSize);

  const result: ListWebcamsResponse = {
    webcams: singles,
    clusters,
    totalInView: webcams.length,
  };

  setCachedJson(cacheKey, result, RESPONSE_CACHE_TTL).catch(err => {
    console.warn('[webcam] response cache write failed:', err);
  });

  return result;
}

function equirectangularWidthKm(s: number, n: number, w: number, e: number): number {
  const midLat = ((s + n) / 2) * Math.PI / 180;
  return Math.abs(e - w) * 111.32 * Math.cos(midLat);
}
