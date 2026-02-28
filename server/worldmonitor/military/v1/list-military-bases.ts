declare const process: { env: Record<string, string | undefined> };

import type {
  ServerContext,
  ListMilitaryBasesRequest,
  ListMilitaryBasesResponse,
  MilitaryBaseEntry,
  MilitaryBaseCluster,
} from '../../../../src/generated/server/worldmonitor/military/v1/service_server';

import { cachedFetchJson, getCachedJson, geoSearchByBox, getHashFieldsBatch } from '../../../_shared/redis';
import { markNoCacheResponse, setResponseHeader } from '../../../_shared/response-headers';

const VALID_TYPES = new Set([
  'us-nato', 'china', 'russia', 'uk', 'france', 'india', 'italy', 'uae', 'turkey', 'japan', 'other',
]);
const VALID_KINDS = new Set([
  'base', 'airfield', 'naval_base', 'military', 'barracks', 'bunker', 'trench',
  'training_area', 'checkpoint', 'shelter', 'ammunition', 'office', 'obstacle_course',
  'nuclear_explosion_site', 'range',
]);
const COUNTRY_RE = /^[A-Z]{2}$/;

const quantize = (v: number, step: number) => Math.round(v / step) * step;

function getBboxGridStep(zoom: number): number {
  if (zoom < 5) return 5;
  if (zoom <= 7) return 1;
  return 0.5;
}

function haversineDistKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function bboxDimensionsKm(
  swLat: number, swLon: number, neLat: number, neLon: number,
): { centerLat: number; centerLon: number; widthKm: number; heightKm: number } {
  const centerLat = (swLat + neLat) / 2;
  const centerLon = (swLon + neLon) / 2;
  const heightKm = haversineDistKm(swLat, centerLon, neLat, centerLon);
  const widthKm = haversineDistKm(centerLat, swLon, centerLat, neLon);
  return { centerLat, centerLon, widthKm: Math.max(widthKm, 1), heightKm: Math.max(heightKm, 1) };
}

function getGeoSearchCap(zoom: number): number {
  if (zoom < 5) return 2000;
  if (zoom <= 7) return 5000;
  return 10000;
}

function getClusterCellSize(zoom: number): number {
  if (zoom < 4) return 5;
  if (zoom < 6) return 2;
  if (zoom < 8) return 0.5;
  return 0;
}

function clusterBases(
  bases: MilitaryBaseEntry[], cellSize: number,
): { entries: MilitaryBaseEntry[]; clusters: MilitaryBaseCluster[] } {
  if (cellSize === 0 || bases.length <= 200) return { entries: bases, clusters: [] };

  const cells = new Map<string, MilitaryBaseEntry[]>();
  for (const b of bases) {
    const ck = `${Math.floor(b.latitude / cellSize)}:${Math.floor(b.longitude / cellSize)}`;
    let arr = cells.get(ck);
    if (!arr) { arr = []; cells.set(ck, arr); }
    arr.push(b);
  }

  const entries: MilitaryBaseEntry[] = [];
  const clusters: MilitaryBaseCluster[] = [];

  for (const group of cells.values()) {
    if (group.length === 1) {
      entries.push(group[0]!);
      continue;
    }
    let latSum = 0, lonSum = 0;
    const typeCounts = new Map<string, number>();
    for (const b of group) {
      latSum += b.latitude;
      lonSum += b.longitude;
      typeCounts.set(b.type, (typeCounts.get(b.type) || 0) + 1);
    }
    let dominantType = 'other';
    let maxCount = 0;
    for (const [t, c] of typeCounts) {
      if (c > maxCount) { maxCount = c; dominantType = t; }
    }
    clusters.push({
      latitude: latSum / group.length,
      longitude: lonSum / group.length,
      count: group.length,
      dominantType,
      expansionZoom: cellSize >= 2 ? 6 : cellSize >= 0.5 ? 8 : 10,
    });
  }

  return { entries, clusters };
}

export async function listMilitaryBases(
  ctx: ServerContext,
  req: ListMilitaryBasesRequest,
): Promise<ListMilitaryBasesResponse> {
  try {
    const empty: ListMilitaryBasesResponse = { bases: [], clusters: [], totalInView: 0, truncated: false };

    if (!req.neLat && !req.neLon && !req.swLat && !req.swLon) return empty;

    const swLat = Math.max(-90, Math.min(90, req.swLat));
    const neLat = Math.max(-90, Math.min(90, req.neLat));
    const swLon = Math.max(-180, Math.min(180, req.swLon));
    const neLon = Math.max(-180, Math.min(180, req.neLon));
    const zoom = Math.max(0, Math.min(22, req.zoom || 3));

    const typeFilter = req.type ? req.type.toLowerCase().trim().slice(0, 20) : '';
    const kindFilter = req.kind ? req.kind.toLowerCase().trim().slice(0, 20) : '';
    const countryFilter = req.country ? req.country.toUpperCase().trim().slice(0, 20) : '';

    if (typeFilter && !VALID_TYPES.has(typeFilter)) return empty;
    if (kindFilter && !VALID_KINDS.has(kindFilter)) return empty;
    if (countryFilter && !COUNTRY_RE.test(countryFilter)) return empty;

    let activeVersion = await getCachedJson('military:bases:active') as string | null;
    let rawKeys = false;
    if (!activeVersion) {
      activeVersion = await getCachedJson('military:bases:active', true) as string | null;
      rawKeys = true;
    }
    if (!activeVersion) {
      markNoCacheResponse(ctx.request);
      setResponseHeader(ctx.request, 'X-Bases-Debug', 'no-active-version');
      console.warn('military:bases:active key missing — run seed script');
      return empty;
    }
    const v = String(activeVersion);
    setResponseHeader(ctx.request, 'X-Bases-Debug', `v=${v},raw=${rawKeys}`);
    const geoKey = `military:bases:geo:${v}`;
    const metaKey = `military:bases:meta:${v}`;

    const gridStep = getBboxGridStep(zoom);
    const qBB = [
      quantize(swLat, gridStep), quantize(swLon, gridStep),
      quantize(neLat, gridStep), quantize(neLon, gridStep),
    ].join(':');
    const cacheKey = `military:bases:v1:${qBB}:${zoom}:${typeFilter}:${kindFilter}:${countryFilter}:${v}`;

    const result = await cachedFetchJson<ListMilitaryBasesResponse>(
      cacheKey, 3600,
      async () => {
        const antimeridian = swLon > neLon;
        let allIds: string[];

        if (antimeridian) {
          const dims1 = bboxDimensionsKm(swLat, swLon, neLat, 180);
          const dims2 = bboxDimensionsKm(swLat, -180, neLat, neLon);
          const cap = getGeoSearchCap(zoom);
          const [ids1, ids2] = await Promise.all([
            geoSearchByBox(geoKey, dims1.centerLon, dims1.centerLat, dims1.widthKm, dims1.heightKm, cap, rawKeys),
            geoSearchByBox(geoKey, dims2.centerLon, dims2.centerLat, dims2.widthKm, dims2.heightKm, cap, rawKeys),
          ]);
          const seen = new Set<string>();
          allIds = [];
          for (const id of [...ids1, ...ids2]) {
            if (!seen.has(id)) { seen.add(id); allIds.push(id); }
          }
        } else {
          const dims = bboxDimensionsKm(swLat, swLon, neLat, neLon);
          const cap = getGeoSearchCap(zoom);
          allIds = await geoSearchByBox(geoKey, dims.centerLon, dims.centerLat, dims.widthKm, dims.heightKm, cap, rawKeys);
        }

        const truncated = allIds.length >= getGeoSearchCap(zoom);
        if (allIds.length === 0) return { bases: [], clusters: [], totalInView: 0, truncated: false };

        const metaMap = await getHashFieldsBatch(metaKey, allIds, rawKeys);
        const bases: MilitaryBaseEntry[] = [];

        for (const id of allIds) {
          const raw = metaMap.get(id);
          if (!raw) continue;
          let meta: Record<string, unknown>;
          try { meta = JSON.parse(raw); } catch { continue; }

          const tier = (meta.tier as number) || 2;
          if (zoom < 5 && tier > 1) continue;
          if (zoom >= 5 && zoom < 8 && tier > 2) continue;

          if (typeFilter && meta.type !== typeFilter) continue;
          if (kindFilter && meta.kind !== kindFilter) continue;
          if (countryFilter && meta.countryIso2 !== countryFilter) continue;

          bases.push({
            id: String(meta.id || id),
            name: String(meta.name || ''),
            latitude: Number(meta.lat) || 0,
            longitude: Number(meta.lon) || 0,
            kind: String(meta.kind || ''),
            countryIso2: String(meta.countryIso2 || ''),
            type: String(meta.type || 'other'),
            tier,
            catAirforce: Boolean(meta.catAirforce),
            catNaval: Boolean(meta.catNaval),
            catNuclear: Boolean(meta.catNuclear),
            catSpace: Boolean(meta.catSpace),
            catTraining: Boolean(meta.catTraining),
            branch: String(meta.branch || ''),
            status: String(meta.status || ''),
          });
        }

        const cellSize = getClusterCellSize(zoom);
        const { entries, clusters } = clusterBases(bases, cellSize);

        return {
          bases: entries,
          clusters,
          totalInView: bases.length,
          truncated,
        };
      },
    );

    if (!result) {
      markNoCacheResponse(ctx.request);
      return empty;
    }
    return result;
  } catch (err) {
    markNoCacheResponse(ctx.request);
    setResponseHeader(ctx.request, 'X-Bases-Debug', `error:${err instanceof Error ? err.message : String(err)}`);
    return { bases: [], clusters: [], totalInView: 0, truncated: false };
  }
}
