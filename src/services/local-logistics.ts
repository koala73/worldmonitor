import { haversineKm } from './proximity-filter';
import { readOfflineCacheEntry, writeOfflineCacheEntry } from './offline-alert-cache';
import type { SavedPlace } from './saved-places';
import {
  LOCAL_LOGISTICS_CATEGORIES,
  LOCAL_LOGISTICS_CATEGORY_LABELS,
  type LocalLogisticsSnapshot,
  type LogisticsCategory,
  type LogisticsFreshness,
  type LogisticsHazardCompatibility,
  type LogisticsNode,
  type LogisticsStatus,
} from './local-logistics-types';
export { LOCAL_LOGISTICS_CATEGORIES, LOCAL_LOGISTICS_CATEGORY_LABELS } from './local-logistics-types';
export type { LocalLogisticsSnapshot, LogisticsCategory, LogisticsNode } from './local-logistics-types';

interface LocalLogisticsApiNode {
  id: string;
  category: LogisticsCategory;
  name: string;
  lat: number;
  lon: number;
  distanceKm?: number;
  source: string;
  freshness?: LogisticsFreshness;
  status?: LogisticsStatus;
  hazardCompatibility?: LogisticsHazardCompatibility;
  fetchedAt?: string;
  address?: string;
  url?: string;
}

interface LocalLogisticsApiResponse {
  nodes?: LocalLogisticsApiNode[];
  fetchedAt?: string;
}

interface FetchLocalLogisticsOptions {
  categories?: LogisticsCategory[];
  radiusKm?: number;
  limitPerCategory?: number;
}

interface BuildSnapshotOptions {
  fetchedAt?: Date;
  isStale?: boolean;
  staleAgeMs?: number;
  source?: LocalLogisticsSnapshot['source'];
}

interface CachedLocalLogisticsSnapshot {
  placeId: string;
  placeName: string;
  categories: LogisticsCategory[];
  nodes: (Omit<LogisticsNode, 'fetchedAt'> & { fetchedAt: string })[];
  fetchedAt: string;
}

interface LocalLogisticsBriefItem {
  kind: 'logistics';
  label: string;
  value: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  link?: string;
}

const LOCAL_LOGISTICS_CACHE_PREFIX = 'local-logistics';
const DEFAULT_RADIUS_KM = 25;
const DEFAULT_LIMIT_PER_CATEGORY = 3;
const memoryCache = new Map<string, CachedLocalLogisticsSnapshot>();

function buildCacheKey(placeId: string): string {
  return `${LOCAL_LOGISTICS_CACHE_PREFIX}:${placeId}`;
}

function emitLocalLogisticsUpdated(snapshot: LocalLogisticsSnapshot): void {
  if (typeof document === 'undefined' || typeof CustomEvent === 'undefined') return;
  document.dispatchEvent(new CustomEvent('wm:local-logistics-updated', { detail: snapshot }));
}

function normalizeFreshness(value: LogisticsFreshness | undefined, fetchedAt: Date): LogisticsFreshness {
  if (value) return value;
  const ageMs = Date.now() - fetchedAt.getTime();
  if (ageMs <= 6 * 60 * 60 * 1000) return 'fresh';
  if (ageMs <= 24 * 60 * 60 * 1000) return 'recent';
  return 'stale';
}

function normalizeStatus(value: LogisticsStatus | undefined): LogisticsStatus {
  return value === 'open' || value === 'limited' ? value : 'unknown';
}

function normalizeHazardCompatibility(value: LogisticsHazardCompatibility | undefined, category: LogisticsCategory): LogisticsHazardCompatibility {
  if (value === 'evacuation' || value === 'medical' || value === 'supply' || value === 'general') return value;
  if (category === 'shelter') return 'evacuation';
  if (category === 'hospital' || category === 'pharmacy') return 'medical';
  if (category === 'fuel' || category === 'water') return 'supply';
  return 'general';
}

function serializeSnapshot(snapshot: LocalLogisticsSnapshot): CachedLocalLogisticsSnapshot {
  return {
    placeId: snapshot.placeId,
    placeName: snapshot.placeName,
    categories: [...snapshot.categories],
    nodes: snapshot.nodes.map((node) => ({
      ...node,
      fetchedAt: node.fetchedAt.toISOString(),
    })),
    fetchedAt: snapshot.fetchedAt.toISOString(),
  };
}

function deserializeSnapshot(cached: CachedLocalLogisticsSnapshot): LocalLogisticsSnapshot {
  const fetchedAt = new Date(cached.fetchedAt);
  const staleAgeMs = Math.max(0, Date.now() - fetchedAt.getTime());
  return {
    placeId: cached.placeId,
    placeName: cached.placeName,
    categories: [...cached.categories].sort((left, right) => left.localeCompare(right)),
    nodes: rankLocalLogisticsNodes(cached.nodes.map((node) => ({
      ...node,
      fetchedAt: new Date(node.fetchedAt),
    }))),
    fetchedAt,
    isStale: true,
    staleAgeMs,
    source: 'offline-cache',
  };
}

function statusRank(status: LogisticsStatus): number {
  return {
    open: 3,
    limited: 2,
    unknown: 1,
  }[status];
}

function freshnessRank(freshness: LogisticsFreshness): number {
  return {
    fresh: 3,
    recent: 2,
    stale: 1,
  }[freshness];
}

function formatDistance(distanceKm: number): string {
  if (!Number.isFinite(distanceKm)) return 'distance unknown';
  if (distanceKm < 10) return `${distanceKm.toFixed(1)} km away`;
  return `${Math.round(distanceKm)} km away`;
}

function formatStatus(status: LogisticsStatus): string {
  if (status === 'open') return 'likely open';
  if (status === 'limited') return 'hours listed';
  return 'status unknown';
}

function normalizeApiNode(place: SavedPlace, node: LocalLogisticsApiNode, snapshotFetchedAt: Date): LogisticsNode | null {
  if (!LOCAL_LOGISTICS_CATEGORIES.includes(node.category)) return null;
  if (!Number.isFinite(node.lat) || !Number.isFinite(node.lon)) return null;
  const fetchedAt = node.fetchedAt ? new Date(node.fetchedAt) : snapshotFetchedAt;
  return {
    id: String(node.id),
    category: node.category,
    name: node.name?.trim() || `${LOCAL_LOGISTICS_CATEGORY_LABELS[node.category]} option`,
    lat: node.lat,
    lon: node.lon,
    distanceKm: Number.isFinite(node.distanceKm)
      ? Math.max(0, node.distanceKm as number)
      : haversineKm(place.lat, place.lon, node.lat, node.lon),
    source: node.source || 'OpenStreetMap / Overpass',
    freshness: normalizeFreshness(node.freshness, fetchedAt),
    status: normalizeStatus(node.status),
    hazardCompatibility: normalizeHazardCompatibility(node.hazardCompatibility, node.category),
    fetchedAt,
    ...(node.address ? { address: node.address } : {}),
    ...(node.url ? { url: node.url } : {}),
  };
}

export function rankLocalLogisticsNodes(nodes: LogisticsNode[]): LogisticsNode[] {
  return [...nodes].sort((left, right) => {
    const statusDiff = statusRank(right.status) - statusRank(left.status);
    if (statusDiff !== 0) return statusDiff;
    const freshnessDiff = freshnessRank(right.freshness) - freshnessRank(left.freshness);
    if (freshnessDiff !== 0) return freshnessDiff;
    const distanceDiff = left.distanceKm - right.distanceKm;
    if (distanceDiff !== 0) return distanceDiff;
    return left.name.localeCompare(right.name);
  });
}

export function buildLocalLogisticsSnapshot(
  place: SavedPlace,
  nodes: LogisticsNode[],
  options: BuildSnapshotOptions = {},
): LocalLogisticsSnapshot {
  const fetchedAt = options.fetchedAt ?? new Date();
  const rankedNodes = rankLocalLogisticsNodes(nodes);
  const categories = [...new Set(rankedNodes.map((node) => node.category))]
    .sort((left, right) => left.localeCompare(right));
  return {
    placeId: place.id,
    placeName: place.name,
    categories,
    nodes: rankedNodes,
    fetchedAt,
    isStale: options.isStale ?? false,
    staleAgeMs: options.staleAgeMs ?? 0,
    source: options.source ?? 'network',
  };
}

export function selectTopLocalLogisticsNodes(
  snapshot: LocalLogisticsSnapshot,
  category: LogisticsCategory | 'all' = 'all',
  limit = 3,
): LogisticsNode[] {
  const filtered = category === 'all'
    ? snapshot.nodes
    : snapshot.nodes.filter((node) => node.category === category);
  return filtered.slice(0, Math.max(1, limit));
}

export function buildLocalLogisticsBriefItems(
  snapshot: LocalLogisticsSnapshot | null,
  limit = 3,
): LocalLogisticsBriefItem[] {
  if (!snapshot) return [];
  return selectTopLocalLogisticsNodes(snapshot, 'all', limit).map((node) => ({
    kind: 'logistics',
    label: `${LOCAL_LOGISTICS_CATEGORY_LABELS[node.category]}: ${node.name}`,
    value: `${formatDistance(node.distanceKm)} · ${formatStatus(node.status)}`,
    severity: node.status === 'open' ? 'low' : 'medium',
    ...(node.url ? { link: node.url } : {}),
  }));
}

export function getCachedLocalLogistics(placeId: string): LocalLogisticsSnapshot | null {
  const cached = memoryCache.get(buildCacheKey(placeId));
  if (cached) return deserializeSnapshot(cached);
  const offline = readOfflineCacheEntry<CachedLocalLogisticsSnapshot>(buildCacheKey(placeId));
  if (!offline) return null;
  memoryCache.set(buildCacheKey(placeId), offline.data);
  return deserializeSnapshot(offline.data);
}

export async function fetchLocalLogistics(
  place: SavedPlace,
  options: FetchLocalLogisticsOptions = {},
): Promise<LocalLogisticsSnapshot> {
  const { getApiBaseUrl } = await import('./runtime');
  const categories = (options.categories?.length ? options.categories : [...LOCAL_LOGISTICS_CATEGORIES]).join(',');
  const radiusKm = Math.max(1, Math.min(place.radiusKm, options.radiusKm ?? DEFAULT_RADIUS_KM));
  const limitPerCategory = Math.max(1, Math.min(5, Math.trunc(options.limitPerCategory ?? DEFAULT_LIMIT_PER_CATEGORY)));
  const params = new URLSearchParams({
    lat: String(place.lat),
    lon: String(place.lon),
    radiusKm: String(radiusKm),
    categories,
    limitPerCategory: String(limitPerCategory),
  });

  try {
    const response = await fetch(`${getApiBaseUrl()}/api/local-logistics?${params.toString()}`, {
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json() as LocalLogisticsApiResponse;
    const snapshotFetchedAt = payload.fetchedAt ? new Date(payload.fetchedAt) : new Date();
    const nodes = (payload.nodes ?? [])
      .map((node) => normalizeApiNode(place, node, snapshotFetchedAt))
      .filter((node): node is LogisticsNode => Boolean(node));
    const snapshot = buildLocalLogisticsSnapshot(place, nodes, {
      fetchedAt: snapshotFetchedAt,
      source: 'network',
    });
    const serialized = serializeSnapshot(snapshot);
    memoryCache.set(buildCacheKey(place.id), serialized);
    writeOfflineCacheEntry(buildCacheKey(place.id), serialized);
    emitLocalLogisticsUpdated(snapshot);
    return snapshot;
  } catch (error) {
    const cached = getCachedLocalLogistics(place.id);
    if (cached) {
      emitLocalLogisticsUpdated(cached);
      return cached;
    }
    throw error;
  }
}

export type { LocalLogisticsBriefItem };
