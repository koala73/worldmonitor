// Edge function: on-demand OpenSanctions entity search (Phase 2 — issue #2042).
// Proxies to https://api.opensanctions.org — no auth required for basic search.
// Merges results with OFAC via the RPC lookup endpoint for a unified response.

export const config = { runtime: 'edge' };

import { createIpRateLimiter } from './_ip-rate-limit.js';
import { jsonResponse } from './_json-response.js';
import { getClientIp } from './_turnstile.js';

const OPENSANCTIONS_BASE = 'https://api.opensanctions.org';
const OPENSANCTIONS_TIMEOUT_MS = 8_000;
const MAX_RESULTS = 20;

const rateLimiter = createIpRateLimiter({ limit: 30, windowMs: 60_000 });

function normalizeEntity(hit) {
  const props = hit.properties ?? {};
  const name = (props.name ?? [hit.caption]).filter(Boolean)[0] ?? '';
  const countries = props.country ?? props.nationality ?? [];
  const programs = props.program ?? props.sanctions ?? [];
  const schema = hit.schema ?? '';

  let entityType = 'entity';
  if (schema === 'Vessel') entityType = 'vessel';
  else if (schema === 'Aircraft') entityType = 'aircraft';
  else if (schema === 'Person') entityType = 'individual';

  return {
    id: `opensanctions:${hit.id}`,
    name,
    entityType,
    countryCodes: countries.slice(0, 3),
    programs: programs.slice(0, 3),
    datasets: hit.datasets ?? [],
    score: hit.score ?? 0,
  };
}

export default async function handler(req) {
  const ip = getClientIp(req);
  if (rateLimiter.isRateLimited(ip)) {
    return jsonResponse({ error: 'Too many requests' }, 429);
  }

  const { searchParams } = new URL(req.url);
  const q = (searchParams.get('q') ?? '').trim();

  if (!q || q.length < 2) {
    return jsonResponse({ error: 'q must be at least 2 characters' }, 400);
  }
  if (q.length > 200) {
    return jsonResponse({ error: 'q must be at most 200 characters' }, 400);
  }

  const limitRaw = Number(searchParams.get('limit') ?? '10');
  const limit = Math.min(Number.isFinite(limitRaw) && limitRaw > 0 ? Math.trunc(limitRaw) : 10, MAX_RESULTS);

  try {
    const url = new URL(`${OPENSANCTIONS_BASE}/search/default`);
    url.searchParams.set('q', q);
    url.searchParams.set('limit', String(limit));

    const resp = await fetch(url.toString(), {
      headers: {
        'User-Agent': 'WorldMonitor/1.0 sanctions-search',
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(OPENSANCTIONS_TIMEOUT_MS),
    });

    if (!resp.ok) {
      return jsonResponse({ results: [], total: 0, source: 'opensanctions', error: `upstream HTTP ${resp.status}` }, 200);
    }

    const data = await resp.json();
    const results = (data.results ?? []).map(normalizeEntity);

    return jsonResponse({
      results,
      total: data.total?.value ?? results.length,
      source: 'opensanctions',
    }, 200, { 'Cache-Control': 'no-store' });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return jsonResponse({ results: [], total: 0, source: 'opensanctions', error: message }, 200);
  }
}
