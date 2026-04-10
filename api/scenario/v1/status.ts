export const config = { runtime: 'edge' };

import { isCallerPremium } from '../../../server/_shared/premium-check';

/** Matches jobIds produced by run.ts: "scenario:{timestamp}:{8-char-suffix}" */
const JOB_ID_RE = /^scenario:\d{13}:[a-z0-9]{8}$/;

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'GET') {
    return new Response('', { status: 405 });
  }

  const isPro = await isCallerPremium(req);
  if (!isPro) {
    return new Response(JSON.stringify({ error: 'PRO subscription required' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const { searchParams } = new URL(req.url);
  const jobId = searchParams.get('jobId');

  if (!jobId || !JOB_ID_RE.test(jobId)) {
    return new Response(
      JSON.stringify({ error: 'Invalid or missing jobId' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    );
  }

  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    return new Response(
      JSON.stringify({ error: 'Service temporarily unavailable' }),
      { status: 503, headers: { 'Content-Type': 'application/json' } },
    );
  }

  const resultKey = `scenario-result:${jobId}`;
  const redisResp = await fetch(`${url}/get/${encodeURIComponent(resultKey)}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(5_000),
  });

  if (!redisResp.ok) {
    console.error('[scenario/status] Redis get failed:', redisResp.status);
    return new Response(
      JSON.stringify({ error: 'Failed to fetch job status' }),
      { status: 502, headers: { 'Content-Type': 'application/json' } },
    );
  }

  const data = (await redisResp.json()) as { result?: string | null };

  if (!data.result) {
    return new Response(
      JSON.stringify({ jobId, status: 'pending' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(data.result);
  } catch {
    return new Response(
      JSON.stringify({ error: 'Corrupted job result' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    );
  }

  return new Response(
    JSON.stringify(parsed),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}
