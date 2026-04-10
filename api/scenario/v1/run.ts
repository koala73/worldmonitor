export const config = { runtime: 'edge' };

// @ts-expect-error — .js import resolved by Vercel edge bundler
import { validateApiKey } from '../../_api-key.js';
import { isCallerPremium } from '../../../server/_shared/premium-check';
import { getScenarioTemplate } from '../../../server/worldmonitor/supply-chain/v1/scenario-templates';

const JOB_ID_CHARSET = 'abcdefghijklmnopqrstuvwxyz0123456789';

function generateJobId(): string {
  const ts = Date.now();
  let suffix = '';
  const array = new Uint8Array(8);
  crypto.getRandomValues(array);
  for (const byte of array) suffix += JOB_ID_CHARSET[byte % JOB_ID_CHARSET.length];
  return `scenario:${ts}:${suffix}`;
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') {
    return new Response('', { status: 405 });
  }

  validateApiKey(req, { forceKey: false });

  const isPro = await isCallerPremium(req);
  if (!isPro) {
    return new Response(JSON.stringify({ error: 'PRO subscription required' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const { scenarioId, iso2 } = body as { scenarioId?: string; iso2?: string };

  if (!scenarioId || typeof scenarioId !== 'string') {
    return new Response(JSON.stringify({ error: 'scenarioId is required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (!getScenarioTemplate(scenarioId)) {
    return new Response(JSON.stringify({ error: `Unknown scenario: ${scenarioId}` }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (iso2 !== undefined && iso2 !== null && (typeof iso2 !== 'string' || !/^[A-Z]{2}$/.test(iso2))) {
    return new Response(JSON.stringify({ error: 'iso2 must be a 2-letter uppercase country code' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    return new Response(JSON.stringify({ error: 'Service temporarily unavailable' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const jobId = generateJobId();
  const payload = JSON.stringify({
    jobId,
    scenarioId,
    iso2: iso2 ?? null,
    enqueuedAt: Date.now(),
  });

  const redisResp = await fetch(`${url}/rpush/scenario-queue%3Apending`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify([payload]),
    signal: AbortSignal.timeout(5_000),
  });

  if (!redisResp.ok) {
    console.error('[scenario/run] Redis enqueue failed:', redisResp.status);
    return new Response(JSON.stringify({ error: 'Failed to enqueue scenario job' }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  return new Response(
    JSON.stringify({ jobId, status: 'pending' }),
    {
      status: 202,
      headers: { 'Content-Type': 'application/json' },
    },
  );
}
