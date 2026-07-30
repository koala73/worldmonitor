import { getCachedJson } from '../../../_shared/redis';
import { PIPELINES_GAS_KEY, PIPELINES_OIL_KEY } from '../../../_shared/cache-keys';
import type {
  ListPipelinesRequest,
  ListPipelinesResponse,
  PipelineEntry,
} from '../../../../src/generated/server/worldmonitor/supply_chain/v1/service_server';
import { derivePublicBadge } from './_pipeline-evidence';
import { pickNewerClassifierVersion, pickNewerIsoTimestamp } from '../../../../src/shared/pipeline-evidence';

/**
 * Shape of the JSON emitted by scripts/seed-pipelines-{gas,oil}.mjs.
 * Kept loose (`unknown`) at the seam because Upstash returns `unknown`;
 * the projection function below narrows it to the proto shape.
 */
interface RawRegistry {
  classifierVersion?: string;
  updatedAt?: string;
  pipelines?: Record<string, unknown>;
}

function coerceString(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

function coerceNumber(v: unknown, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function coerceLatLon(v: unknown): { lat: number; lon: number } {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const obj = v as Record<string, unknown>;
    return { lat: coerceNumber(obj.lat), lon: coerceNumber(obj.lon) };
  }
  return { lat: 0, lon: 0 };
}

export function projectPipeline(raw: unknown): PipelineEntry | null {
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
        lastEvidenceUpdate: coerceString(evidence.lastEvidenceUpdate),
        classifierVersion: coerceString(evidence.classifierVersion, 'v1'),
        classifierConfidence: coerceNumber(evidence.classifierConfidence, 0),
      }
    : undefined;

  const publicBadge = derivePublicBadge(ev);

  const waypoints = Array.isArray(r.waypoints)
    ? (r.waypoints as unknown[]).map(coerceLatLon)
    : [];

  return {
    id: coerceString(r.id),
    name: coerceString(r.name),
    operator: coerceString(r.operator),
    commodityType: coerceString(r.commodityType),
    fromCountry: coerceString(r.fromCountry),
    toCountry: coerceString(r.toCountry),
    transitCountries: Array.isArray(r.transitCountries)
      ? (r.transitCountries as unknown[]).map(t => coerceString(t))
      : [],
    capacityBcmYr: coerceNumber(r.capacityBcmYr),
    capacityMbd: coerceNumber(r.capacityMbd),
    lengthKm: coerceNumber(r.lengthKm),
    inService: coerceNumber(r.inService),
    startPoint: coerceLatLon(r.startPoint),
    endPoint: coerceLatLon(r.endPoint),
    waypoints,
    evidence: ev,
    publicBadge,
  };
}

function collect(raw: RawRegistry | null): PipelineEntry[] {
  if (!raw?.pipelines) return [];
  return Object.values(raw.pipelines)
    .map(projectPipeline)
    .filter((p): p is PipelineEntry => p != null);
}

export async function listPipelines(
  _ctx: unknown,
  req: ListPipelinesRequest,
): Promise<ListPipelinesResponse> {
  const wantGas = !req.commodityType || req.commodityType === 'gas';
  const wantOil = !req.commodityType || req.commodityType === 'oil';

  const [gasRaw, oilRaw] = await Promise.all([
    wantGas ? getCachedJson(PIPELINES_GAS_KEY) as Promise<RawRegistry | null> : Promise.resolve(null),
    wantOil ? getCachedJson(PIPELINES_OIL_KEY) as Promise<RawRegistry | null> : Promise.resolve(null),
  ]);

  // upstreamUnavailable = "we tried to read a registry and Redis returned
  // nothing". An empty projection after a healthy fetch (e.g. a filter that
  // legitimately matches no rows) is NOT an upstream failure — it's a valid
  // zero. Matches the contract in list_pipelines.proto and the sibling
  // list-fuel-shortages / list-storage-facilities / list-energy-disruptions
  // handlers. Previously this handler lumped "filtered to zero" in with
  // "upstream down", which would push callers to error-state rendering
  // on valid empty queries.
  const anyRequested = wantGas || wantOil;
  const anyReturned = (wantGas && gasRaw) || (wantOil && oilRaw);
  if (anyRequested && !anyReturned) {
    return {
      pipelines: [],
      fetchedAt: new Date().toISOString(),
      classifierVersion: '',
      upstreamUnavailable: true,
    };
  }

  const pipelines = [...collect(gasRaw), ...collect(oilRaw)];

  // Pick the newest classifier version present across the registries. Gas
  // and oil are now seeded by separate Railway cron processes, so a
  // mixed-version window (gas=v2, oil=v1) during rollouts is a real expected
  // state — must actually compare, not prefer one side. Same logic for
  // fetchedAt: the newer seeder cycle is the accurate "last refresh" signal.
  const classifierVersion = pickNewerClassifierVersion(
    gasRaw?.classifierVersion,
    oilRaw?.classifierVersion,
  );
  const fetchedAt = pickNewerIsoTimestamp(gasRaw?.updatedAt, oilRaw?.updatedAt)
    || new Date().toISOString();

  return {
    pipelines,
    fetchedAt,
    classifierVersion,
    upstreamUnavailable: false,
  };
}
