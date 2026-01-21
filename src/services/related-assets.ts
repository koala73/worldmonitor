import type { ClusteredEvent, RelatedAsset, AssetType, RelatedAssetContext } from '@/types';
import {
  UNDERSEA_CABLES,
  AI_DATA_CENTERS,
  TECH_COMPANIES,
  AI_RESEARCH_LABS,
  STARTUP_ECOSYSTEMS,
} from '@/config';

const MAX_DISTANCE_KM = 600;
const MAX_ASSETS_PER_TYPE = 3;

const ASSET_KEYWORDS: Record<AssetType, string[]> = {
  cable: ['cable', 'undersea cable', 'subsea cable', 'fiber cable', 'fiber optic', 'internet cable'],
  datacenter: ['datacenter', 'data center', 'server farm', 'colocation', 'hyperscale'],
  'tech-company': ['tech company', 'technology company', 'startup', 'silicon valley', 'ai company'],
  'ai-lab': ['ai research', 'ai lab', 'research lab', 'machine learning', 'deep learning'],
  'startup-ecosystem': ['startup hub', 'tech hub', 'innovation hub', 'venture capital', 'ecosystem'],
};

const ASSET_LABELS: Record<AssetType, string> = {
  cable: 'Cable',
  datacenter: 'Datacenter',
  'tech-company': 'Tech Company',
  'ai-lab': 'AI Lab',
  'startup-ecosystem': 'Startup Hub',
};

interface AssetOrigin {
  lat: number;
  lon: number;
  label: string;
}

function toTitleLower(titles: string[]): string[] {
  return titles.map(title => title.toLowerCase());
}

function detectAssetTypes(titles: string[]): AssetType[] {
  const normalized = toTitleLower(titles);
  const types = Object.entries(ASSET_KEYWORDS)
    .filter(([, keywords]) =>
      normalized.some(title => keywords.some(keyword => title.includes(keyword)))
    )
    .map(([type]) => type as AssetType);
  return types;
}

function inferOrigin(titles: string[]): AssetOrigin | null {
  // Try to infer origin from tech company names or AI lab names in titles
  const companyCandidates = TECH_COMPANIES.map((company) => ({
    label: company.name,
    lat: company.lat,
    lon: company.lon,
    score: titles.some(title => title.toLowerCase().includes(company.name.toLowerCase())) ? 1 : 0,
  })).filter(candidate => candidate.score > 0);

  const labCandidates = AI_RESEARCH_LABS.map((lab) => ({
    label: lab.name,
    lat: lab.lat,
    lon: lab.lon,
    score: titles.some(title => title.toLowerCase().includes(lab.name.toLowerCase())) ? 1 : 0,
  })).filter(candidate => candidate.score > 0);

  const allCandidates = [...companyCandidates, ...labCandidates];
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
    case 'cable':
      return UNDERSEA_CABLES.map(cable => {
        const mid = midpoint(cable.points);
        if (!mid) return null;
        return { id: cable.id, name: cable.name, lat: mid.lat, lon: mid.lon };
      });
    case 'datacenter':
      return AI_DATA_CENTERS.map(dc => ({ id: dc.id, name: dc.name, lat: dc.lat, lon: dc.lon }));
    case 'tech-company':
      return TECH_COMPANIES.map(company => ({ id: company.id, name: company.name, lat: company.lat, lon: company.lon }));
    case 'ai-lab':
      return AI_RESEARCH_LABS.map(lab => ({ id: lab.id, name: lab.name, lat: lab.lat, lon: lab.lon }));
    case 'startup-ecosystem':
      return STARTUP_ECOSYSTEMS.map(ecosystem => ({ id: ecosystem.id, name: ecosystem.name, lat: ecosystem.lat, lon: ecosystem.lon }));
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
  return ASSET_LABELS[type];
}

export { MAX_DISTANCE_KM };
