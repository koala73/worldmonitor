export const config = { runtime: 'edge' };

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

function getClientIp(req: Request): string {
  return (
    req.headers.get('cf-connecting-ip') ||
    req.headers.get('x-real-ip') ||
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    '0.0.0.0'
  );
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') {
    return new Response('', { status: 405 });
  }

  const isPro = await isCallerPremium(req);
  if (!isPro) {
    return new Response(JSON.stringify({ error: 'PRO subscription required' }), {
      status: 403,
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

  // Per-user rate limit: 10 scenario jobs per user per minute (sliding window via INCR+EXPIRE).
  const identifier = getClientIp(req);
  const minute = Math.floor(Date.now() / 60_000);
  const rateLimitKey = `rate:scenario:${identifier}:${minute}`;

  const rlResp = await fetch(`${url}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify([
      ['INCR', rateLimitKey],
      ['EXPIRE', rateLimitKey, 60],
      ['LLEN', 'scenario-queue:pending'],
    ]),
    signal: AbortSignal.timeout(5_000),
  }).catch(() => null);

  if (rlResp?.ok) {
    const rlResults = (await rlResp.json()) as Array<{ result: number }>;
    const count = rlResults[0]?.result ?? 0;
    const queueDepth = rlResults[2]?.result ?? 0;

    if (count > 10) {
      return new Response(JSON.stringify({ error: 'Rate limit exceeded: 10 scenario jobs per minute' }), {
        status: 429,
        headers: {
          'Content-Type': 'application/json',
          'Retry-After': '60',
        },
      });
    }

    if (queueDepth > 100) {
      return new Response(JSON.stringify({ error: 'Scenario queue is at capacity, please try again later' }), {
        status: 429,
        headers: {
          'Content-Type': 'application/json',
          'Retry-After': '30',
        },
      });
    }
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
    JSON.stringify({ jobId, status: 'pending', statusUrl: `/api/scenario/v1/status?jobId=${jobId}` }),
    {
      status: 202,
      headers: { 'Content-Type': 'application/json' },
    },
  );
}
