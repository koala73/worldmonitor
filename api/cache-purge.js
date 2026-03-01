import { getCorsHeaders } from './_cors.js';

export const config = { runtime: 'edge' };

const MAX_EXPLICIT_KEYS = 20;
const MAX_PATTERNS = 3;
const MAX_DELETIONS = 200;
const MAX_SCAN_ITERATIONS = 5;

const BLOCKLIST_PREFIXES = ['rl:', '__'];
const DURABLE_DATA_PREFIXES = ['military:bases:', 'conflict:iran-events:'];

function getKeyPrefix() {
  const env = process.env.VERCEL_ENV;
  if (!env || env === 'production') return '';
  const sha = process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 8) || 'dev';
  return `${env}:${sha}:`;
}

function isBlocklisted(key) {
  return BLOCKLIST_PREFIXES.some(p => key.startsWith(p));
}

function isDurableData(key) {
  return DURABLE_DATA_PREFIXES.some(p => key.startsWith(p));
}

function json(body, status, corsHeaders) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  });
}

function getRedisCredentials() {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error('Redis not configured');
  return { url, token };
}

async function redisPipeline(commands) {
  const { url, token } = getRedisCredentials();
  const resp = await fetch(`${url}/pipeline`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(commands),
    signal: AbortSignal.timeout(10_000),
  });
  if (!resp.ok) throw new Error(`Redis pipeline HTTP ${resp.status}`);
  return resp.json();
}

async function redisScan(pattern, maxIterations) {
  const { url, token } = getRedisCredentials();
  const keys = [];
  let cursor = '0';
  let truncated = false;

  for (let i = 0; i < maxIterations; i++) {
    const resp = await fetch(
      `${url}/scan/${encodeURIComponent(cursor)}/MATCH/${encodeURIComponent(pattern)}/COUNT/100`,
      {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(5_000),
      }
    );
    if (!resp.ok) throw new Error(`Redis SCAN HTTP ${resp.status}`);
    const data = await resp.json();
    const [nextCursor, batch] = data.result;
    if (batch?.length) keys.push(...batch);
    cursor = String(nextCursor);
    if (cursor === '0') break;
    if (i === maxIterations - 1) truncated = true;
  }

  return { keys, truncated };
}

async function timingSafeEqual(a, b) {
  const encoder = new TextEncoder();
  const aBuf = encoder.encode(a);
  const bBuf = encoder.encode(b);
  if (aBuf.byteLength !== bBuf.byteLength) return false;
  const key = await crypto.subtle.importKey('raw', aBuf, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, bBuf);
  const expected = await crypto.subtle.sign('HMAC', key, aBuf);
  const sigArr = new Uint8Array(sig);
  const expArr = new Uint8Array(expected);
  if (sigArr.length !== expArr.length) return false;
  let diff = 0;
  for (let i = 0; i < sigArr.length; i++) diff |= sigArr[i] ^ expArr[i];
  return diff === 0;
}

export default async function handler(req) {
  const corsHeaders = getCorsHeaders(req, 'POST, OPTIONS');

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405, corsHeaders);
  }

  const auth = req.headers.get('authorization') || '';
  const secret = process.env.RELAY_SHARED_SECRET;
  if (!secret || !(await timingSafeEqual(auth, `Bearer ${secret}`))) {
    return json({ error: 'Unauthorized' }, 401, corsHeaders);
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 422, corsHeaders);
  }

  const { keys: explicitKeys, patterns, dryRun = false } = body || {};
  const hasKeys = Array.isArray(explicitKeys) && explicitKeys.length > 0;
  const hasPatterns = Array.isArray(patterns) && patterns.length > 0;

  if (!hasKeys && !hasPatterns) {
    return json({ error: 'At least one of "keys" or "patterns" required' }, 422, corsHeaders);
  }

  if (hasKeys && explicitKeys.length > MAX_EXPLICIT_KEYS) {
    return json({ error: `"keys" exceeds max of ${MAX_EXPLICIT_KEYS}` }, 422, corsHeaders);
  }

  if (hasPatterns && patterns.length > MAX_PATTERNS) {
    return json({ error: `"patterns" exceeds max of ${MAX_PATTERNS}` }, 422, corsHeaders);
  }

  if (hasPatterns) {
    for (const p of patterns) {
      if (typeof p !== 'string' || !p.endsWith('*') || p === '*') {
        return json({ error: `Invalid pattern "${p}": must end with "*" and cannot be bare "*"` }, 422, corsHeaders);
      }
    }
  }

  const prefix = getKeyPrefix();
  const allKeys = new Set();
  let truncated = false;

  if (hasKeys) {
    for (const k of explicitKeys) {
      if (typeof k !== 'string' || !k) continue;
      if (isBlocklisted(k)) continue;
      allKeys.add(k);
    }
  }

  if (hasPatterns) {
    for (const p of patterns) {
      const prefixedPattern = prefix ? `${prefix}${p}` : p;
      const scan = await redisScan(prefixedPattern, MAX_SCAN_ITERATIONS);
      if (scan.truncated) truncated = true;
      for (const rawKey of scan.keys) {
        const unprefixed = prefix && rawKey.startsWith(prefix) ? rawKey.slice(prefix.length) : rawKey;
        if (isBlocklisted(unprefixed)) continue;
        if (isDurableData(unprefixed)) continue;
        allKeys.add(unprefixed);
      }
    }
  }

  const keyList = [...allKeys].slice(0, MAX_DELETIONS);
  if (keyList.length < allKeys.size) truncated = true;

  const ip = req.headers.get('x-real-ip') || req.headers.get('cf-connecting-ip') || 'unknown';
  const ts = new Date().toISOString();

  if (dryRun) {
    console.log('[cache-purge]', { mode: 'dry-run', matched: keyList.length, deleted: 0, truncated, dryRun: true, ip, ts });
    return json({ matched: keyList.length, deleted: 0, keys: keyList, dryRun: true, truncated }, 200, corsHeaders);
  }

  if (keyList.length === 0) {
    console.log('[cache-purge]', { mode: 'purge', matched: 0, deleted: 0, truncated, dryRun: false, ip, ts });
    return json({ matched: 0, deleted: 0, keys: [], dryRun: false, truncated }, 200, corsHeaders);
  }

  let deleted = 0;
  try {
    const commands = keyList.map(k => ['DEL', prefix ? `${prefix}${k}` : k]);
    const results = await redisPipeline(commands);
    deleted = results.reduce((sum, r) => sum + (r.result || 0), 0);
  } catch (err) {
    console.log('[cache-purge]', { mode: 'purge-error', matched: keyList.length, error: err.message, ip, ts });
    return json({ error: 'Redis pipeline failed' }, 502, corsHeaders);
  }

  console.log('[cache-purge]', { mode: 'purge', matched: keyList.length, deleted, truncated, dryRun: false, ip, ts });
  return json({ matched: keyList.length, deleted, keys: keyList, dryRun: false, truncated }, 200, corsHeaders);
}
