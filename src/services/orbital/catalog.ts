import type { ListImagingSatellitesResponse, OmmElements } from '@/generated/client/worldmonitor/orbital/v1/service_client';
import { OrbitalServiceClient } from '@/services/generated-rpc-clients';
import { createLazyClient, getRpcBaseUrl } from '@/services/rpc-client';
import type { OmmRecord } from '../../../shared/orbital/pass-geometry.js';
import { profileFor, type CatalogSatellite } from './pass-job';

export type CatalogStatus = 'fresh' | 'stale' | 'empty';

export interface OrbitalCatalog {
  status: CatalogStatus;
  fetchedAt: number;
  inventoryVersion: string;
  satellites: CatalogSatellite[];
}

const CATALOG_TTL_MS = 30 * 60_000;

const epochMs = (epoch: string) => Date.parse(/[zZ]|[+-]\d\d:\d\d$/.test(epoch) ? epoch : `${epoch}Z`);

export function toOmmRecord(elements: OmmElements): OmmRecord {
  return {
    OBJECT_NAME: elements.objectName,
    OBJECT_ID: elements.objectId,
    EPOCH: elements.epoch,
    MEAN_MOTION: elements.meanMotion,
    ECCENTRICITY: elements.eccentricity,
    INCLINATION: elements.inclination,
    RA_OF_ASC_NODE: elements.raOfAscNode,
    ARG_OF_PERICENTER: elements.argOfPericenter,
    MEAN_ANOMALY: elements.meanAnomaly,
    EPHEMERIS_TYPE: elements.ephemerisType,
    CLASSIFICATION_TYPE: elements.classificationType,
    NORAD_CAT_ID: elements.noradCatId,
    ELEMENT_SET_NO: elements.elementSetNo,
    REV_AT_EPOCH: elements.revAtEpoch,
    BSTAR: elements.bstar,
    MEAN_MOTION_DOT: elements.meanMotionDot,
    MEAN_MOTION_DDOT: elements.meanMotionDdot,
  };
}

export function toOrbitalCatalog(response: ListImagingSatellitesResponse): OrbitalCatalog {
  const ringByNorad = new Map<number, OmmElements[]>();
  for (const day of response.ring ?? []) {
    for (const elements of day.elements ?? []) {
      const list = ringByNorad.get(elements.noradCatId) ?? [];
      list.push(elements);
      ringByNorad.set(elements.noradCatId, list);
    }
  }

  const satellites: CatalogSatellite[] = [];
  for (const satellite of response.satellites ?? []) {
    if (!profileFor(satellite.profileId)) continue;
    const byEpoch = new Map<string, OmmElements>();
    for (const elements of [...(ringByNorad.get(satellite.noradId) ?? []), ...(satellite.elements ? [satellite.elements] : [])]) {
      byEpoch.set(elements.epoch, elements);
    }
    if (byEpoch.size === 0) continue;
    const elementSets = [...byEpoch.values()]
      .sort((a, b) => epochMs(a.epoch) - epochMs(b.epoch))
      .map(toOmmRecord);
    satellites.push({ noradId: satellite.noradId, name: satellite.name, profileId: satellite.profileId, elementSets });
  }

  const status: CatalogStatus = satellites.length === 0 ? 'empty' : response.stale ? 'stale' : 'fresh';
  return { status, fetchedAt: response.fetchedAt, inventoryVersion: response.inventoryVersion, satellites };
}

const getOrbitalClient = createLazyClient(() => new OrbitalServiceClient(getRpcBaseUrl(), { fetch: (...args) => globalThis.fetch(...args) }));

let cached: { promise: Promise<OrbitalCatalog>; loadedAt: number } | null = null;

export function loadOrbitalCatalog(nowMs = Date.now()): Promise<OrbitalCatalog> {
  if (cached && nowMs - cached.loadedAt < CATALOG_TTL_MS) return cached.promise;
  const entry = {
    loadedAt: nowMs,
    promise: getOrbitalClient().listImagingSatellites({}).then(toOrbitalCatalog),
  };
  entry.promise.catch(() => {
    if (cached === entry) cached = null;
  });
  cached = entry;
  return entry.promise;
}
