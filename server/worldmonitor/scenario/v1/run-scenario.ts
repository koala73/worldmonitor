import type {
  ServerContext,
  RunScenarioRequest,
  RunScenarioResponse,
} from '../../../../src/generated/server/worldmonitor/scenario/v1/service_server';
import { ApiError, ValidationError } from '../../../../src/generated/server/worldmonitor/scenario/v1/service_server';

import { isCallerPremium } from '../../../_shared/premium-check';
import { runRedisPipeline } from '../../../_shared/redis';
import { getScenarioTemplate } from '../../supply-chain/v1/scenario-templates';

const QUEUE_KEY = 'scenario-queue:pending';
const MAX_QUEUE_DEPTH = 100;
const JOB_ID_CHARSET = 'abcdefghijklmnopqrstuvwxyz0123456789';

function generateJobId(): string {
  const ts = Date.now();
  let suffix = '';
  const array = new Uint8Array(8);
  crypto.getRandomValues(array);
  for (const byte of array) suffix += JOB_ID_CHARSET[byte % JOB_ID_CHARSET.length];
  return `scenario:${ts}:${suffix}`;
}

export async function runScenario(
  ctx: ServerContext,
  req: RunScenarioRequest,
): Promise<RunScenarioResponse> {
  const isPro = await isCallerPremium(ctx.request);
  if (!isPro) {
    throw new ApiError(403, 'PRO subscription required', '');
  }

  const scenarioId = (req.scenarioId ?? '').trim();
  if (!scenarioId) {
    throw new ValidationError([{ field: 'scenarioId', description: 'scenarioId is required' }]);
  }
  if (!getScenarioTemplate(scenarioId)) {
    throw new ValidationError([{ field: 'scenarioId', description: `Unknown scenario: ${scenarioId}` }]);
  }

  const iso2 = req.iso2 ? req.iso2.trim() : '';
  if (iso2 && !/^[A-Z]{2}$/.test(iso2)) {
    throw new ValidationError([{ field: 'iso2', description: 'iso2 must be a 2-letter uppercase country code' }]);
  }

  // Queue-depth backpressure. Raw key: worker reads it unprefixed, so we must too.
  const [depthEntry] = await runRedisPipeline([['LLEN', QUEUE_KEY]], true);
  const depth = typeof depthEntry?.result === 'number' ? depthEntry.result : 0;
  if (depth > MAX_QUEUE_DEPTH) {
    throw new ApiError(429, 'Scenario queue is at capacity, please try again later', '');
  }

  const jobId = generateJobId();
  const payload = JSON.stringify({
    jobId,
    scenarioId,
    iso2: iso2 || null,
    enqueuedAt: Date.now(),
  });

  // Upstash RPUSH returns the new list length; helper returns [] on transport
  // failure. Either no entry or a non-numeric result means the enqueue never
  // landed — surface as 502 so the caller retries.
  const [pushEntry] = await runRedisPipeline([['RPUSH', QUEUE_KEY, payload]], true);
  if (!pushEntry || typeof pushEntry.result !== 'number') {
    throw new ApiError(502, 'Failed to enqueue scenario job', '');
  }

  // statusUrl is a server-computed convenience URL preserved from the legacy
  // /api/scenario/v1/run contract so external callers can keep polling via the
  // response body rather than hardcoding the status path. See the proto comment
  // on RunScenarioResponse for why this matters on a v1 → v1 migration.
  return {
    jobId,
    status: 'pending',
    statusUrl: `/api/scenario/v1/get-scenario-status?jobId=${encodeURIComponent(jobId)}`,
  };
}
