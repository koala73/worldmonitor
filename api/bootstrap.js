import { getCorsHeaders, isDisallowedOrigin } from './_cors.js';
import { validateApiKey } from './_api-key.js';
import { getCachedJsonBatch } from '../server/_shared/redis.ts';
import { BOOTSTRAP_CACHE_KEYS } from '../server/_shared/cache-keys.ts';

export const config = { runtime: 'edge' };

export default async function handler(req) {
  if (isDisallowedOrigin(req))
    return new Response('Forbidden', { status: 403 });

  const cors = getCorsHeaders(req);
  if (req.method === 'OPTIONS')
    return new Response(null, { status: 204, headers: cors });

  const apiKeyResult = validateApiKey(req);
  if (apiKeyResult.required && !apiKeyResult.valid)
    return new Response(JSON.stringify({ error: apiKeyResult.error }), {
      status: 401, headers: { ...cors, 'Content-Type': 'application/json' },
    });

  const url = new URL(req.url);
  const requested = url.searchParams.get('keys')?.split(',').filter(Boolean);
  const registry = requested
    ? Object.fromEntries(Object.entries(BOOTSTRAP_CACHE_KEYS).filter(([k]) => requested.includes(k)))
    : BOOTSTRAP_CACHE_KEYS;

  const keys = Object.values(registry);
  const names = Object.keys(registry);

  let cached;
  try {
    cached = await Promise.race([
      getCachedJsonBatch(keys),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000)),
    ]);
  } catch {
    return new Response(JSON.stringify({ data: {}, missing: names }), {
      status: 200,
      headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' },
    });
  }

  const data = {};
  const missing = [];
  for (let i = 0; i < names.length; i++) {
    const val = cached.get(keys[i]);
    if (val !== undefined) data[names[i]] = val;
    else missing.push(names[i]);
  }

  return new Response(JSON.stringify({ data, missing }), {
    status: 200,
    headers: {
      ...cors,
      'Content-Type': 'application/json',
      'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=30',
    },
  });
}
