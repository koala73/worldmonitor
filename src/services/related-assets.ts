import type { ClusteredEvent, RelatedAsset, AssetType, RelatedAssetContext, NuclearFacility } from '@/types';
import { tokenizeForMatch, matchKeyword } from '@/utils/keyword-match';
import { t } from '@/services/i18n';
import {
  INTEL_HOTSPOTS,
  CONFLICT_ZONES,
  PIPELINES,
} from '@/config';
import { preloadMilitaryBases } from '@/services/military-base-config';

type AssetIndexEntry = { id: string; name: string; lat: number; lon: number };

// The ~86KB ai-datacenters table is lazy-loaded (not statically imported) so it
// stays off the eager dashboard critical path; related-assets is reached eagerly
// via country-intel, which would otherwise pin the table to the entry chunk.
let datacenterIndex: AssetIndexEntry[] | null = null;
let datacenterIndexPromise: Promise<void> | null = null;

export function preloadDatacenterIndex(): Promise<void> {
  if (datacenterIndex !== null) return Promise.resolve();
  if (!datacenterIndexPromise) {
    datacenterIndexPromise = import('@/config/ai-datacenters')
      .then(({ AI_DATA_CENTERS }) => {
        datacenterIndex = AI_DATA_CENTERS.map(dc => ({ id: dc.id, name: dc.name, lat: dc.lat, lon: dc.lon }));
      })
      .catch((error) => {
        datacenterIndexPromise = null;
        throw error;
      });
  }
  return datacenterIndexPromise;
}

export function preloadRelatedAssetTables(titles: string[]): Promise<boolean> {
  const types = detectAssetTypes(titles);
  const preloadTasks: Promise<void>[] = [];

  if (types.includes('datacenter') && datacenterIndex === null) {
    preloadTasks.push(preloadDatacenterIndex());
  }
  if (types.includes('cable') && cableIndex === null) {
    preloadTasks.push(preloadCableIndex());
  }
  if (types.includes('nuclear') && nuclearFacilities === null) {
    preloadTasks.push(preloadNuclearFacilities());
  }
  if (types.includes('base') && baseIndex === null) {
    preloadTasks.push(preloadBaseIndex());
  }

  if (preloadTasks.length === 0) {
    return Promise.resolve(false);
  }

  return Promise.allSettled(preloadTasks).then((results) => {
    if (results.some(result => result.status === 'fulfilled')) {
      return true;
    }

    const rejected = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (rejected) throw rejected.reason;
    return false;
  });
}

function ensureDatacenterIndex(): void {
  void preloadDatacenterIndex().catch(() => {});
}

// UNDERSEA_CABLES (~130KB) + NUCLEAR_FACILITIES (~25KB) live in the lazy geo-map
// chunk for the same reason as the datacenter table above: related-assets is
// reached eagerly via country-intel, so a static import would pin them to the
// entry chunk. Lazy-cache + return empty until loaded; a failed import leaves the
// cache null so the next query retries (no permanent suppression).
let cableIndex: AssetIndexEntry[] | null = null;
let cableIndexPromise: Promise<void> | null = null;

export function preloadCableIndex(): Promise<void> {
  if (cableIndex !== null) return Promise.resolve();
  if (!cableIndexPromise) {
    cableIndexPromise = import('@/config/geo-map')
      .then(({ UNDERSEA_CABLES }) => {
        cableIndex = UNDERSEA_CABLES.map((cable) => {
          const mid = midpoint(cable.points);
          return mid ? { id: cable.id, name: cable.name, lat: mid.lat, lon: mid.lon } : null;
        }).filter((entry): entry is AssetIndexEntry => entry !== null);
      })
      .catch((error) => {
        cableIndexPromise = null;
        throw error;
      });
  }
  return cableIndexPromise;
}

function ensureCableIndex(): void {
  void preloadCableIndex().catch(() => {});
}

let nuclearFacilities: NuclearFacility[] | null = null;
let nuclearFacilitiesPromise: Promise<void> | null = null;

export function preloadNuclearFacilities(): Promise<void> {
  if (nuclearFacilities !== null) return Promise.resolve();
  if (!nuclearFacilitiesPromise) {
    nuclearFacilitiesPromise = import('@/config/geo-map')
      .then(({ NUCLEAR_FACILITIES }) => {
        nuclearFacilities = NUCLEAR_FACILITIES;
      })
      .catch((error) => {
        nuclearFacilitiesPromise = null;
        throw error;
      });
  }
  return nuclearFacilitiesPromise;
}

function ensureNuclearFacilities(): void {
  void preloadNuclearFacilities().catch(() => {});
}

// MILITARY_BASES (~48KB via bases-expanded) is lazy-loaded for the same reason as
// the tables above — related-assets is reached eagerly via country-intel, so a
// static import would pin bases-expanded to the entry chunk (#4478).
let baseIndex: AssetIndexEntry[] | null = null;
let baseIndexPromise: Promise<void> | null = null;

export function preloadBaseIndex(): Promise<void> {
  if (baseIndex !== null) return Promise.resolve();
  if (!baseIndexPromise) {
    baseIndexPromise = preloadMilitaryBases()
      .then((bases) => {
        baseIndex = bases.map(base => ({ id: base.id, name: base.name, lat: base.lat, lon: base.lon }));
      })
      .catch((error) => {
        baseIndexPromise = null;
        throw error;
      });
  }
  return baseIndexPromise;
}

function ensureBaseIndex(): void {
  void preloadBaseIndex().catch(() => {});
}

// Warm all lazy infrastructure tables together so a country brief re-render picks
// up datacenters, cables, and nuclear facilities in a single refresh pass.
export function preloadInfrastructureTables(): Promise<void> {
  return Promise.all([
    preloadDatacenterIndex().catch(() => {}),
    preloadCableIndex().catch(() => {}),
    preloadNuclearFacilities().catch(() => {}),
    preloadBaseIndex().catch(() => {}),
  ]).then(() => {});
}

const MAX_DISTANCE_KM = 300;
const MAX_ASSETS_PER_TYPE = 3;

const ASSET_KEYWORDS: Record<AssetType, string[]> = {
  pipeline: ['pipeline', 'oil pipeline', 'gas pipeline', 'fuel pipeline', 'pipeline leak', 'pipeline spill'],
  cable: ['cable', 'undersea cable', 'subsea cable', 'fiber cable', 'fiber optic', 'internet cable'],
  datacenter: ['datacenter', 'data center', 'server farm', 'colocation', 'hyperscale'],
  base: ['military base', 'airbase', 'naval base', 'base', 'garrison'],
  nuclear: ['nuclear', 'reactor', 'uranium', 'enrichment', 'nuclear plant'],
};

interface AssetOrigin {
  lat: number;
  lon: number;
  label: string;
}

function detectAssetTypes(titles: string[]): AssetType[] {
  const tokenized = titles.map(t => tokenizeForMatch(t));
  const types = Object.entries(ASSET_KEYWORDS)
    .filter(([, keywords]) =>
      tokenized.some(tokens => keywords.some(keyword => matchKeyword(tokens, keyword)))
    )
    .map(([type]) => type as AssetType);
  return types;
}

function countKeywordMatches(titles: string[], keywords: string[]): number {
  const tokenized = titles.map(t => tokenizeForMatch(t));
  return keywords.reduce((count, keyword) => {
    return count + tokenized.filter(tokens => matchKeyword(tokens, keyword)).length;
  }, 0);
}

function inferOrigin(titles: string[]): AssetOrigin | null {
  const hotspotCandidates = INTEL_HOTSPOTS.map((hotspot) => ({
    label: hotspot.name,
    lat: hotspot.lat,
    lon: hotspot.lon,
    score: countKeywordMatches(titles, hotspot.keywords),
  })).filter(candidate => candidate.score > 0);

  const conflictCandidates = CONFLICT_ZONES.map((conflict) => ({
    label: conflict.name,
    lat: conflict.center[1],
    lon: conflict.center[0],
    score: countKeywordMatches(titles, conflict.keywords ?? []),
  })).filter(candidate => candidate.score > 0);

  const allCandidates = [...hotspotCandidates, ...conflictCandidates];
  if (allCandidates.length === 0) return null;

  return allCandidates.sort((a, b) => b.score - a.score)[0] ?? null;
}

function haversineDistanceKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = (value: number) => (value * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const originLat = toRad(lat1);
  const destLat = toRad(lat2);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(originLat) * Math.cos(destLat) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return 6371 * c;
}

function midpoint(points: [number, number][]): { lat: number; lon: number } | null {
  if (points.length === 0) return null;
  const mid = points[Math.floor(points.length / 2)] as [number, number];
  return { lon: mid[0], lat: mid[1] };
}

function buildAssetIndex(type: AssetType): Array<{ id: string; name: string; lat: number; lon: number } | null> {
  switch (type) {
    case 'pipeline':
      return PIPELINES.map(pipeline => {
        const mid = midpoint(pipeline.points);
        if (!mid) return null;
        return { id: pipeline.id, name: pipeline.name, lat: mid.lat, lon: mid.lon };
      });
    case 'cable':
      ensureCableIndex();
      return cableIndex ?? [];
    case 'datacenter':
      ensureDatacenterIndex();
      return datacenterIndex ?? [];
    case 'base':
      ensureBaseIndex();
      return baseIndex ?? [];
    case 'nuclear':
      ensureNuclearFacilities();
      return (nuclearFacilities ?? []).map(site => ({ id: site.id, name: site.name, lat: site.lat, lon: site.lon }));
    default:
      return [];
  }
}

function findNearbyAssets(origin: AssetOrigin, types: AssetType[]): RelatedAsset[] {
  const results: RelatedAsset[] = [];

  types.forEach((type) => {
    const candidates = buildAssetIndex(type)
      .filter((asset): asset is { id: string; name: string; lat: number; lon: number } => !!asset)
      .map((asset) => ({
        ...asset,
        distanceKm: haversineDistanceKm(origin.lat, origin.lon, asset.lat, asset.lon),
      }))
      .filter(asset => asset.distanceKm <= MAX_DISTANCE_KM)
      .sort((a, b) => a.distanceKm - b.distanceKm)
      .slice(0, MAX_ASSETS_PER_TYPE);

    candidates.forEach(candidate => {
      results.push({
        id: candidate.id,
        name: candidate.name,
        type,
        distanceKm: candidate.distanceKm,
      });
    });
  });

  return results.sort((a, b) => a.distanceKm - b.distanceKm);
}

export function getClusterAssetContext(cluster: ClusteredEvent): RelatedAssetContext | null {
  const titles = cluster.allItems.map(item => item.title);
  const types = detectAssetTypes(titles);
  if (types.length === 0) return null;

  const origin = inferOrigin(titles);
  if (!origin) return null;

  const assets = findNearbyAssets(origin, types);
  return { origin, assets, types };
}

export function getAssetLabel(type: AssetType): string {
  return t(`components.relatedAssets.${type}`);
}

export function getNearbyInfrastructure(
  lat: number, lon: number, types: AssetType[]
): RelatedAsset[] {
  return findNearbyAssets({ lat, lon, label: 'country-centroid' }, types);
}

/**
 * Country-aware infrastructure search for Country Deep Dive.
 * Uses country field/operator when available, falls back to proximity.
 * If the country has zero facilities of a type, shows nearby ones instead.
 */
export function getCountryInfrastructure(
  lat: number, lon: number, countryCode: string, types: AssetType[]
): RelatedAsset[] {
  const results: RelatedAsset[] = [];
  const codeLower = countryCode.toLowerCase();

  for (const type of types) {
    let countryAssets: RelatedAsset[] = [];

    if (type === 'nuclear') {
      ensureNuclearFacilities();
      const byOperator = (nuclearFacilities ?? [])
        .filter(f => f.operator?.toLowerCase() === codeLower)
        .map(f => ({ id: f.id, name: f.name, type, distanceKm: haversineDistanceKm(lat, lon, f.lat, f.lon) }));
      if (byOperator.length > 0) {
        countryAssets = byOperator.sort((a, b) => a.distanceKm - b.distanceKm);
      }
    }

    if (countryAssets.length > 0) {
      results.push(...countryAssets);
    } else {
      // Country has no facilities of this type (or no country match), show nearby ones
      const nearby = findNearbyAssets({ lat, lon, label: 'country-centroid' }, [type]);
      results.push(...nearby);
    }
  }

  return results;
}

export { haversineDistanceKm };

export { MAX_DISTANCE_KM };
