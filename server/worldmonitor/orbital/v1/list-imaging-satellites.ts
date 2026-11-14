/**
 * RPC: listImagingSatellites -- serves the imaging catalog that
 * scripts/seed-orbital-catalog.mjs publishes, plus the sensor-profile
 * inventory it was matched against. Nothing is fetched from CelesTrak here.
 *
 * Satellites are matched to profiles again on read, so a catalog seeded under
 * an older inventory never names a profile this response does not list.
 */
import type {
  CatalogDay,
  ImagingSatellite,
  ListImagingSatellitesRequest,
  ListImagingSatellitesResponse,
  OmmElements,
  SensorProfile,
  ServerContext,
} from '../../../../src/generated/server/worldmonitor/orbital/v1/service_server';
import {
  matchSensorProfile,
  SENSOR_INVENTORY_VERSION,
  SENSOR_PROFILES,
} from '../../../../shared/orbital/sensor-profiles.js';
import { ORBITAL_CATALOG_KEY } from '../../../_shared/cache-keys';
import { readCachedJson } from '../../../_shared/redis';
import { markNoStoreFallbackResponse } from '../../../_shared/response-headers';

/** Must equal api/health.js SEED_META.orbitalCatalog.maxStaleMin; pinned by tests. */
export const ORBITAL_CATALOG_MAX_STALE_MINUTES = 540;

interface StoredSatellite {
  noradId: number;
  name: string;
  profileId: string;
  elements: Record<string, unknown>;
}

interface StoredCatalog {
  source: string;
  fetchedAt: number;
  satellites: StoredSatellite[];
  ring: Array<{ day: string; fetchedAt: number; elements: Array<Record<string, unknown>> }>;
}

const PROFILES: SensorProfile[] = SENSOR_PROFILES.map((profile) => ({
  id: profile.id,
  family: profile.family,
  operator: profile.operator,
  category: profile.category,
  coverage: profile.coverage,
  sources: [...profile.sources],
}));

function num(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function toOmmElements(omm: Record<string, unknown>): OmmElements {
  return {
    objectName: str(omm.OBJECT_NAME),
    objectId: str(omm.OBJECT_ID),
    epoch: str(omm.EPOCH),
    meanMotion: num(omm.MEAN_MOTION),
    eccentricity: num(omm.ECCENTRICITY),
    inclination: num(omm.INCLINATION),
    raOfAscNode: num(omm.RA_OF_ASC_NODE),
    argOfPericenter: num(omm.ARG_OF_PERICENTER),
    meanAnomaly: num(omm.MEAN_ANOMALY),
    ephemerisType: num(omm.EPHEMERIS_TYPE),
    classificationType: str(omm.CLASSIFICATION_TYPE),
    noradCatId: num(omm.NORAD_CAT_ID),
    elementSetNo: num(omm.ELEMENT_SET_NO),
    revAtEpoch: num(omm.REV_AT_EPOCH),
    bstar: num(omm.BSTAR),
    meanMotionDot: num(omm.MEAN_MOTION_DOT),
    meanMotionDdot: num(omm.MEAN_MOTION_DDOT),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asStoredCatalog(value: unknown): StoredCatalog | null {
  if (!isRecord(value) || !Array.isArray(value.satellites) || !Number.isFinite(value.fetchedAt)) return null;
  return {
    source: str(value.source),
    fetchedAt: value.fetchedAt as number,
    satellites: value.satellites.filter((s): s is StoredSatellite => isRecord(s) && isRecord(s.elements)),
    ring: Array.isArray(value.ring)
      ? value.ring.filter((d): d is StoredCatalog['ring'][number] =>
        isRecord(d) && typeof d.day === 'string' && Array.isArray(d.elements))
      : [],
  };
}

function profiledElements(omm: unknown): OmmElements | null {
  if (!isRecord(omm)) return null;
  return matchSensorProfile(num(omm.NORAD_CAT_ID), str(omm.OBJECT_NAME)) ? toOmmElements(omm) : null;
}

function emptyCatalog(): ListImagingSatellitesResponse {
  return {
    inventoryVersion: SENSOR_INVENTORY_VERSION,
    profiles: PROFILES,
    satellites: [],
    ring: [],
    fetchedAt: 0,
    source: '',
    stale: true,
  };
}

/** Re-matches a stored catalog against the current sensor inventory; stale when empty or older than the health limit. */
export function toCatalogResponse(value: unknown, nowMs: number): ListImagingSatellitesResponse {
  const catalog = asStoredCatalog(value);
  if (!catalog) return emptyCatalog();
  const satellites: ImagingSatellite[] = [];
  for (const stored of catalog.satellites) {
    const elements = toOmmElements(stored.elements);
    const profile = matchSensorProfile(elements.noradCatId, elements.objectName);
    if (profile) satellites.push({ noradId: elements.noradCatId, name: elements.objectName, profileId: profile.id, elements });
  }
  const ring: CatalogDay[] = catalog.ring.map((day) => ({
    day: day.day,
    fetchedAt: num(day.fetchedAt),
    elements: day.elements.map(profiledElements).filter((e): e is OmmElements => e !== null),
  }));
  return {
    inventoryVersion: SENSOR_INVENTORY_VERSION,
    profiles: PROFILES,
    satellites,
    ring,
    fetchedAt: catalog.fetchedAt,
    source: catalog.source,
    stale: satellites.length === 0 || nowMs - catalog.fetchedAt > ORBITAL_CATALOG_MAX_STALE_MINUTES * 60_000,
  };
}

/** Serves the seeded imaging catalog; a missing or unreadable key yields an uncached empty stale catalog. */
export async function listImagingSatellites(
  ctx: ServerContext,
  _req: ListImagingSatellitesRequest,
): Promise<ListImagingSatellitesResponse> {
  const read = await readCachedJson(ORBITAL_CATALOG_KEY, true);
  if (read.status === 'error') {
    const message = read.error instanceof Error ? read.error.message : String(read.error);
    console.warn(`[orbital-catalog] ${ORBITAL_CATALOG_KEY} read failed: ${message}`);
  }
  const response = read.status === 'hit' ? toCatalogResponse(read.value, Date.now()) : emptyCatalog();
  // An empty catalog must not sit in the CDN for the slow tier's hour after the seeder recovers.
  return response.satellites.length === 0 ? markNoStoreFallbackResponse(ctx.request, response) : response;
}
