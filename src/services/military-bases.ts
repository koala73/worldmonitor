import {
  MilitaryServiceClient,
  type ListMilitaryBasesResponse,
  type MilitaryBaseEntry,
  type MilitaryBaseCluster,
} from '@/generated/client/worldmonitor/military/v1/service_client';
import type { MilitaryBase, MilitaryBaseType, MilitaryBaseEnriched } from '@/types';

const client = new MilitaryServiceClient('', { fetch: (...args) => globalThis.fetch(...args) });

interface CachedResult {
  bases: MilitaryBaseEnriched[];
  clusters: MilitaryBaseCluster[];
  totalInView: number;
  truncated: boolean;
  bbox: string;
  zoom: number;
}

const quantize = (v: number, step: number) => Math.round(v / step) * step;

function getBboxGridStep(zoom: number): number {
  if (zoom < 5) return 5;
  if (zoom <= 7) return 1;
  return 0.5;
}

function quantizeBbox(swLat: number, swLon: number, neLat: number, neLon: number, zoom: number): string {
  const step = getBboxGridStep(zoom);
  return [quantize(swLat, step), quantize(swLon, step), quantize(neLat, step), quantize(neLon, step)].join(':');
}

function entryToEnriched(e: MilitaryBaseEntry): MilitaryBaseEnriched {
  return {
    id: e.id,
    name: e.name,
    lat: e.latitude,
    lon: e.longitude,
    type: (e.type || 'other') as MilitaryBaseType,
    country: e.countryIso2,
    arm: e.branch,
    status: (e.status || undefined) as MilitaryBase['status'],
    kind: e.kind,
    tier: e.tier,
    catAirforce: e.catAirforce,
    catNaval: e.catNaval,
    catNuclear: e.catNuclear,
    catSpace: e.catSpace,
    catTraining: e.catTraining,
  };
}

let lastResult: CachedResult | null = null;
let pendingFetch: Promise<CachedResult | null> | null = null;

export type { MilitaryBaseCluster };

export async function fetchMilitaryBases(
  swLat: number, swLon: number, neLat: number, neLon: number,
  zoom: number,
  filters?: { type?: string; kind?: string; country?: string },
): Promise<CachedResult | null> {
  const qBbox = quantizeBbox(swLat, swLon, neLat, neLon, zoom);
  const floorZoom = Math.floor(zoom);

  if (lastResult && lastResult.bbox === qBbox && lastResult.zoom === floorZoom) {
    return lastResult;
  }

  if (pendingFetch) return pendingFetch;

  pendingFetch = (async () => {
    try {
      const resp: ListMilitaryBasesResponse = await client.listMilitaryBases({
        swLat, swLon, neLat, neLon,
        zoom: floorZoom,
        type: filters?.type || '',
        kind: filters?.kind || '',
        country: filters?.country || '',
      });

      const bases = resp.bases.map(entryToEnriched);
      const result: CachedResult = {
        bases,
        clusters: resp.clusters,
        totalInView: resp.totalInView,
        truncated: resp.truncated,
        bbox: qBbox,
        zoom: floorZoom,
      };
      lastResult = result;
      return result;
    } catch (err) {
      console.error('[bases-svc] error', err);
      return lastResult;
    } finally {
      pendingFetch = null;
    }
  })();

  return pendingFetch;
}
