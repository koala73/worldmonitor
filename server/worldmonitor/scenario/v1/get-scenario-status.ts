import type {
  ServerContext,
  GetScenarioStatusRequest,
  GetScenarioStatusResponse,
  ScenarioResult,
} from '../../../../src/generated/server/worldmonitor/scenario/v1/service_server';
import { ApiError, ValidationError } from '../../../../src/generated/server/worldmonitor/scenario/v1/service_server';

import { isCallerPremium } from '../../../_shared/premium-check';
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
    const c = entry as { iso2?: unknown; totalImpact?: unknown; impactPct?: unknown };
    out.push({
      iso2: typeof c.iso2 === 'string' ? c.iso2 : '',
      totalImpact: typeof c.totalImpact === 'number' ? c.totalImpact : 0,
      impactPct: typeof c.impactPct === 'number' ? c.impactPct : 0,
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
  const r = raw as { affectedChokepointIds?: unknown; topImpactCountries?: unknown; template?: unknown };
  return {
    affectedChokepointIds: Array.isArray(r.affectedChokepointIds)
      ? r.affectedChokepointIds.filter((id): id is string => typeof id === 'string')
      : [],
    topImpactCountries: coerceImpactCountries(r.topImpactCountries),
    template: coerceTemplate(r.template),
  };
}

export async function getScenarioStatus(
  ctx: ServerContext,
  req: GetScenarioStatusRequest,
): Promise<GetScenarioStatusResponse> {
  const isPro = await isCallerPremium(ctx.request);
  if (!isPro) {
    throw new ApiError(403, 'PRO subscription required', '');
  }

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
