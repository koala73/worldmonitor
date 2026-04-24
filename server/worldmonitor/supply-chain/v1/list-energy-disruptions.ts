import { getCachedJson } from '../../../_shared/redis';
import { ENERGY_DISRUPTIONS_KEY } from '../../../_shared/cache-keys';
import type {
  ListEnergyDisruptionsRequest,
  ListEnergyDisruptionsResponse,
  EnergyDisruptionEntry,
} from '../../../../src/generated/server/worldmonitor/supply_chain/v1/service_server';

interface RawRegistry {
  classifierVersion?: string;
  updatedAt?: string;
  events?: Record<string, unknown>;
}

function coerceString(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

function coerceNumber(v: unknown, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function coerceStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map(t => coerceString(t)).filter(s => s.length > 0);
}

export function projectDisruption(raw: unknown): EnergyDisruptionEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string' || r.id.length === 0) return null;

  const sources = Array.isArray(r.sources)
    ? (r.sources as unknown[]).map(s => {
        const o = (s ?? {}) as Record<string, unknown>;
        return {
          authority: coerceString(o.authority),
          title: coerceString(o.title),
          url: coerceString(o.url),
          date: coerceString(o.date),
          sourceType: coerceString(o.sourceType),
        };
      })
    : [];

  return {
    id: coerceString(r.id),
    assetId: coerceString(r.assetId),
    assetType: coerceString(r.assetType),
    eventType: coerceString(r.eventType),
    startAt: coerceString(r.startAt),
    // `endAt: null` in seed → empty string in proto.
    endAt: typeof r.endAt === 'string' ? r.endAt : '',
    capacityOfflineBcmYr: coerceNumber(r.capacityOfflineBcmYr),
    capacityOfflineMbd: coerceNumber(r.capacityOfflineMbd),
    causeChain: coerceStringArray(r.causeChain),
    shortDescription: coerceString(r.shortDescription),
    sources,
    classifierVersion: coerceString(r.classifierVersion, 'v1'),
    classifierConfidence: coerceNumber(r.classifierConfidence),
    lastEvidenceUpdate: coerceString(r.lastEvidenceUpdate),
    // Seed-denormalised countries[] (plan §R/#5 decision B). The registry
    // seeder joins each event's assetId against the pipeline/storage
    // registries and emits the touched ISO2 set. Legacy rows written
    // before the denorm shipped can still exist in Redis transiently; we
    // surface an empty array there so the field is always present on the
    // wire but consumers can detect pre-denorm data by checking length.
    countries: coerceStringArray(r.countries),
  };
}

function matches(event: EnergyDisruptionEntry, req: ListEnergyDisruptionsRequest): boolean {
  if (req.assetId && event.assetId !== req.assetId) return false;
  if (req.assetType && event.assetType !== req.assetType) return false;
  if (req.ongoingOnly && event.endAt !== '') return false;
  return true;
}

export async function listEnergyDisruptions(
  _ctx: unknown,
  req: ListEnergyDisruptionsRequest,
): Promise<ListEnergyDisruptionsResponse> {
  const raw = (await getCachedJson(ENERGY_DISRUPTIONS_KEY)) as RawRegistry | null;

  // upstreamUnavailable fires only on raw-null (Redis returned nothing),
  // matching the contract enforced by sibling handlers (list-pipelines,
  // list-storage-facilities, list-fuel-shortages). A partial write where
  // `raw` exists but `events` is missing is NOT a Redis failure — it's a
  // producer bug or an empty registry, and the right behavior is to return
  // an empty list, not claim upstream is down.
  if (!raw) {
    return {
      events: [],
      fetchedAt: new Date().toISOString(),
      classifierVersion: '',
      upstreamUnavailable: true,
    };
  }

  const events = Object.values(raw.events ?? {})
    .map(projectDisruption)
    .filter((e): e is EnergyDisruptionEntry => e != null)
    .filter(e => matches(e, req))
    // Newest first so panel timelines show recent events up top without
    // the client having to sort.
    .sort((a, b) => b.startAt.localeCompare(a.startAt));

  return {
    events,
    fetchedAt: raw.updatedAt ?? new Date().toISOString(),
    classifierVersion: raw.classifierVersion ?? 'v1',
    upstreamUnavailable: false,
  };
}
