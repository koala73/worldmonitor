import { getCachedJson } from '../../../_shared/redis';
import { STORAGE_FACILITIES_KEY } from '../../../_shared/cache-keys';
import type {
  ListStorageFacilitiesRequest,
  ListStorageFacilitiesResponse,
  StorageFacilityEntry,
} from '../../../../src/generated/server/worldmonitor/supply_chain/v1/service_server';
import { deriveStorageBadge } from './_storage-evidence';

/**
 * Shape of the JSON emitted by scripts/seed-storage-facilities.mjs.
 * Kept loose at the seam (Upstash returns `unknown`); the projection
 * function below narrows to the proto shape.
 */
interface RawRegistry {
  classifierVersion?: string;
  updatedAt?: string;
  facilities?: Record<string, unknown>;
}

function coerceString(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

function coerceNumber(v: unknown, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function coerceBoolean(v: unknown, fallback = false): boolean {
  return typeof v === 'boolean' ? v : fallback;
}

function coerceLatLon(v: unknown): { lat: number; lon: number } {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const obj = v as Record<string, unknown>;
    return { lat: coerceNumber(obj.lat), lon: coerceNumber(obj.lon) };
  }
  return { lat: 0, lon: 0 };
}

export function projectStorageFacility(raw: unknown): StorageFacilityEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string' || r.id.length === 0) return null;

  const evidence = (r.evidence ?? null) as Record<string, unknown> | null;
  const operatorStatement =
    evidence && typeof evidence.operatorStatement === 'object' && evidence.operatorStatement
      ? {
          text: coerceString((evidence.operatorStatement as Record<string, unknown>).text),
          url: coerceString((evidence.operatorStatement as Record<string, unknown>).url),
          date: coerceString((evidence.operatorStatement as Record<string, unknown>).date),
        }
      : undefined;
  const sanctionRefs = Array.isArray(evidence?.sanctionRefs)
    ? (evidence.sanctionRefs as unknown[]).map(s => {
        const ref = (s ?? {}) as Record<string, unknown>;
        return {
          authority: coerceString(ref.authority),
          listId: coerceString(ref.listId),
          date: coerceString(ref.date),
          url: coerceString(ref.url),
        };
      })
    : [];

  const ev = evidence
    ? {
        physicalState: coerceString(evidence.physicalState, 'unknown'),
        physicalStateSource: coerceString(evidence.physicalStateSource, 'operator'),
        operatorStatement,
        commercialState: coerceString(evidence.commercialState, 'unknown'),
        sanctionRefs,
        fillDisclosed: coerceBoolean(evidence.fillDisclosed),
        fillSource: coerceString(evidence.fillSource),
        lastEvidenceUpdate: coerceString(evidence.lastEvidenceUpdate),
        classifierVersion: coerceString(evidence.classifierVersion, 'v1'),
        classifierConfidence: coerceNumber(evidence.classifierConfidence, 0),
      }
    : undefined;

  const publicBadge = deriveStorageBadge(ev);

  return {
    id: coerceString(r.id),
    name: coerceString(r.name),
    operator: coerceString(r.operator),
    facilityType: coerceString(r.facilityType),
    country: coerceString(r.country),
    location: coerceLatLon(r.location),
    capacityTwh: coerceNumber(r.capacityTwh),
    capacityMb: coerceNumber(r.capacityMb),
    capacityMtpa: coerceNumber(r.capacityMtpa),
    workingCapacityUnit: coerceString(r.workingCapacityUnit),
    inService: coerceNumber(r.inService),
    evidence: ev,
    publicBadge,
  };
}

function collect(raw: RawRegistry | null, filterType: string): StorageFacilityEntry[] {
  if (!raw?.facilities) return [];
  const entries = Object.values(raw.facilities)
    .map(projectStorageFacility)
    .filter((f): f is StorageFacilityEntry => f != null);
  if (!filterType) return entries;
  return entries.filter(f => f.facilityType === filterType);
}

export async function listStorageFacilities(
  _ctx: unknown,
  req: ListStorageFacilitiesRequest,
): Promise<ListStorageFacilitiesResponse> {
  const raw = (await getCachedJson(STORAGE_FACILITIES_KEY)) as RawRegistry | null;

  // upstreamUnavailable is reserved for "Redis didn't return a registry".
  // A healthy registry that filters down to zero rows via facilityType is
  // a legitimate empty result — callers that asked for one facility type
  // and got no matches should see an empty list, not an error state. This
  // matches the contract in list_storage_facilities.proto and the sibling
  // list-fuel-shortages handler.
  if (!raw) {
    return {
      facilities: [],
      fetchedAt: new Date().toISOString(),
      classifierVersion: '',
      upstreamUnavailable: true,
    };
  }

  const facilities = collect(raw, req.facilityType ?? '');

  return {
    facilities,
    fetchedAt: raw.updatedAt ?? new Date().toISOString(),
    classifierVersion: raw.classifierVersion ?? 'v1',
    upstreamUnavailable: false,
  };
}
