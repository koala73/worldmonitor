import { getCachedJson } from '../../../_shared/redis';
import { FUEL_SHORTAGES_KEY } from '../../../_shared/cache-keys';
import type {
  ListFuelShortagesRequest,
  ListFuelShortagesResponse,
  FuelShortageEntry,
} from '../../../../src/generated/server/worldmonitor/supply_chain/v1/service_server';

/**
 * Raw Redis payload shape emitted by scripts/seed-fuel-shortages.mjs.
 * Kept loose because Upstash returns `unknown`; the projection function
 * below narrows to the proto wire format.
 */
interface RawRegistry {
  classifierVersion?: string;
  updatedAt?: string;
  shortages?: Record<string, unknown>;
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

export function projectFuelShortage(raw: unknown): FuelShortageEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string' || r.id.length === 0) return null;

  const ev = (r.evidence ?? null) as Record<string, unknown> | null;
  const evidenceSources = Array.isArray(ev?.evidenceSources)
    ? (ev.evidenceSources as unknown[]).map(s => {
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

  const evidence = ev
    ? {
        evidenceSources,
        firstRegulatorConfirmation: coerceString(ev.firstRegulatorConfirmation),
        classifierVersion: coerceString(ev.classifierVersion, 'v1'),
        classifierConfidence: coerceNumber(ev.classifierConfidence, 0),
        lastEvidenceUpdate: coerceString(ev.lastEvidenceUpdate),
      }
    : undefined;

  return {
    id: coerceString(r.id),
    country: coerceString(r.country),
    product: coerceString(r.product),
    severity: coerceString(r.severity, 'watch'),
    firstSeen: coerceString(r.firstSeen),
    lastConfirmed: coerceString(r.lastConfirmed),
    // Proto has no nullable, so empty string = unresolved.
    resolvedAt: typeof r.resolvedAt === 'string' ? r.resolvedAt : '',
    impactTypes: coerceStringArray(r.impactTypes),
    causeChain: coerceStringArray(r.causeChain),
    shortDescription: coerceString(r.shortDescription),
    evidence,
  };
}

function matches(entry: FuelShortageEntry, req: ListFuelShortagesRequest): boolean {
  if (req.country && entry.country !== req.country) return false;
  if (req.product && entry.product !== req.product) return false;
  if (req.severity && entry.severity !== req.severity) return false;
  return true;
}

export async function listFuelShortages(
  _ctx: unknown,
  req: ListFuelShortagesRequest,
): Promise<ListFuelShortagesResponse> {
  const raw = (await getCachedJson(FUEL_SHORTAGES_KEY)) as RawRegistry | null;
  if (!raw?.shortages) {
    return {
      shortages: [],
      fetchedAt: new Date().toISOString(),
      classifierVersion: '',
      upstreamUnavailable: true,
    };
  }

  const shortages = Object.values(raw.shortages)
    .map(projectFuelShortage)
    .filter((s): s is FuelShortageEntry => s != null)
    .filter(s => matches(s, req));

  return {
    shortages,
    fetchedAt: raw.updatedAt ?? new Date().toISOString(),
    classifierVersion: raw.classifierVersion ?? 'v1',
    upstreamUnavailable: false,
  };
}
