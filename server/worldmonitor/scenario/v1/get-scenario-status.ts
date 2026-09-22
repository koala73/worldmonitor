import type {
  ServerContext,
  GetScenarioStatusRequest,
  GetScenarioStatusResponse,
  ScenarioResult,
} from '../../../../src/generated/server/worldmonitor/scenario/v1/service_server';
import { ApiError, ValidationError } from '../../../../src/generated/server/worldmonitor/scenario/v1/service_server';

import {
  requirePremiumRpcAccess,
} from '../../../_shared/premium-check';
import { getRawJson } from '../../../_shared/redis';

// Matches jobIds produced by run-scenario.ts: `scenario:{13-digit-ts}:{8-char-suffix}`.
// Guards `GET /scenario-result/{jobId}` against path-traversal via crafted jobId.
const JOB_ID_RE = /^scenario:\d{13}:[a-z0-9]{8}$/;

interface WorkerResultEnvelope {
  status?: string;
  result?: unknown;
  error?: unknown;
}

function coerceImpactCountries(raw: unknown): ScenarioResult['topImpactCountries'] {
  if (!Array.isArray(raw)) return [];
  const out: ScenarioResult['topImpactCountries'] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const c = entry as {
      iso2?: unknown; totalImpact?: unknown; impactPct?: unknown;
      evaluatedRecords?: unknown; requestedRecords?: unknown; partialEvidence?: unknown;
    };
    const evaluatedRecords = typeof c.evaluatedRecords === 'number' && Number.isFinite(c.evaluatedRecords) ? c.evaluatedRecords : 0;
    const requestedRecords = typeof c.requestedRecords === 'number' && Number.isFinite(c.requestedRecords) ? c.requestedRecords : 0;
    out.push({
      iso2: typeof c.iso2 === 'string' ? c.iso2 : '',
      totalImpact: typeof c.totalImpact === 'number' ? c.totalImpact : 0,
      impactPct: typeof c.impactPct === 'number' ? c.impactPct : 0,
      evaluatedRecords,
      requestedRecords,
      // Trust the producer's flag when present; otherwise derive it. A result written by
      // a worker that predates these fields reports both counts as 0, which must not be
      // rendered as "partial" — hence the requestedRecords > 0 guard.
      partialEvidence: typeof c.partialEvidence === 'boolean'
        ? c.partialEvidence
        : requestedRecords > 0 && evaluatedRecords < requestedRecords,
    });
  }
  return out;
}

function coerceTemplate(raw: unknown): ScenarioResult['template'] {
  if (!raw || typeof raw !== 'object') return undefined;
  const t = raw as { name?: unknown; disruptionPct?: unknown; durationDays?: unknown; costShockMultiplier?: unknown };
  return {
    name: typeof t.name === 'string' ? t.name : '',
    disruptionPct: typeof t.disruptionPct === 'number' ? t.disruptionPct : 0,
    durationDays: typeof t.durationDays === 'number' ? t.durationDays : 0,
    costShockMultiplier: typeof t.costShockMultiplier === 'number' ? t.costShockMultiplier : 1,
  };
}

function coerceResult(raw: unknown): ScenarioResult | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Partial<ScenarioResult>;
  return {
    affectedChokepointIds: Array.isArray(r.affectedChokepointIds)
      ? r.affectedChokepointIds.filter((id): id is string => typeof id === 'string')
      : [],
    topImpactCountries: coerceImpactCountries(r.topImpactCountries),
    template: coerceTemplate(r.template),
    scenarioId: typeof r.scenarioId === 'string' ? r.scenarioId : '',
    scopedIso2: typeof r.scopedIso2 === 'string' ? r.scopedIso2 : '',
    computedAt: typeof r.computedAt === 'string' ? r.computedAt : '',
    coverage: coerceCoverage(r.coverage),
  };
}

const COVERAGE_STATES = ['evaluated', 'missing', 'malformed', 'incomplete_routes', 'not_seeded'];

// `raw` is untrusted Redis JSON, so it is typed `unknown` and narrowed here — matching
// coerceImpactCountries/coerceTemplate/coerceResult. Declaring it as the already-validated
// output type made these guards look redundant to the compiler, so a later edit that
// trusted the declared type would have compiled clean against unvalidated data.
function coerceCoverage(raw: unknown): ScenarioResult['coverage'] {
  const unknown = { status: 'unknown', countryIds: [], hs2Codes: [], records: [], manifestFetchedAt: '' };
  if (!raw || typeof raw !== 'object') return unknown;
  const c = raw as {
    status?: unknown; countryIds?: unknown; hs2Codes?: unknown;
    records?: unknown; manifestFetchedAt?: unknown;
  };
  if (typeof c.status !== 'string' || !['complete', 'partial', 'unknown'].includes(c.status)
    || !Array.isArray(c.countryIds) || !c.countryIds.every(id => typeof id === 'string')
    || !Array.isArray(c.hs2Codes) || !c.hs2Codes.every(id => typeof id === 'string')
    || !Array.isArray(c.records) || c.records.some(r => !r || typeof r !== 'object'
      || typeof r.iso2 !== 'string' || typeof r.hs2 !== 'string'
      || typeof r.state !== 'string' || !COVERAGE_STATES.includes(r.state)
      || (r.state === 'evaluated' && (!['flow_weighted', 'country_route_fallback'].includes(r.basis)
        || typeof r.rawImpact !== 'number' || !Number.isFinite(r.rawImpact) || r.rawImpact < 0)))) {
    return unknown;
  }
  const records = c.records as Array<{ iso2: string; hs2: string; state: string; basis?: unknown; rawImpact?: unknown; fetchedAt?: unknown }>;
  // Derive completeness from the records rather than echoing the stored string, so a
  // payload claiming "complete" while carrying gaps (or no records at all) cannot present
  // itself to the panel as a full result.
  const status = records.length > 0 && records.every(r => r.state === 'evaluated')
    ? 'complete'
    : c.status === 'unknown' ? 'unknown' : 'partial';
  return {
    status,
    countryIds: c.countryIds as string[],
    hs2Codes: c.hs2Codes as string[],
    manifestFetchedAt: typeof c.manifestFetchedAt === 'string' ? c.manifestFetchedAt : '',
    records: records.map(r => ({
      iso2: r.iso2, hs2: r.hs2, state: r.state,
      basis: r.state === 'evaluated' ? String(r.basis) : '',
      rawImpact: r.state === 'evaluated' ? Number(r.rawImpact) : undefined,
      fetchedAt: typeof r.fetchedAt === 'string' ? r.fetchedAt : '',
    })),
  };
}

export async function getScenarioStatus(
  ctx: ServerContext,
  req: GetScenarioStatusRequest,
): Promise<GetScenarioStatusResponse> {
  await requirePremiumRpcAccess(ctx.request, ApiError, 'PRO subscription required');

  const jobId = req.jobId ?? '';
  if (!JOB_ID_RE.test(jobId)) {
    throw new ValidationError([{ field: 'jobId', description: 'Invalid or missing jobId' }]);
  }

  // Worker writes under the raw (unprefixed) key, so we must read raw.
  let envelope: WorkerResultEnvelope | null = null;
  try {
    envelope = await getRawJson(`scenario-result:${jobId}`) as WorkerResultEnvelope | null;
  } catch {
    throw new ApiError(502, 'Failed to fetch job status', '');
  }

  if (!envelope) {
    return { status: 'pending', error: '' };
  }

  const status = typeof envelope.status === 'string' ? envelope.status : 'pending';

  if (status === 'done') {
    const result = coerceResult(envelope.result);
    return { status: 'done', result, error: '' };
  }

  if (status === 'failed') {
    const error = typeof envelope.error === 'string' ? envelope.error : 'computation_error';
    return { status: 'failed', error };
  }

  return { status, error: '' };
}
