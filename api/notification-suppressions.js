/**
 * Anonymous read of the operator notification-link suppression set (#8401).
 *
 * GET /api/notification-suppressions → { suppressed: string[], hosts: string[], updatedAt }
 *
 * The service worker consults this on notification click so an already-
 * delivered push payload stops navigating once its URL is blocked. It is
 * intentionally anonymous and uncached-per-user: the payload is an operator
 * incident control, not user data, and the SW has no auth context at click
 * time. Exact URLs are returned as SHA-256 digests because incident entries
 * can contain query or fragment secrets. Host rules remain normalized plain
 * hostnames so the service worker can match subdomains.
 *
 * Fail-open with `unavailable: true` when Redis cannot be read: the SW
 * treats that as "no information" and still navigates, rather than
 * stranding every notification click during a Redis outage.
 *
 * Origin invocations are metered per IP (60/min, fail-open). The 60s shared
 * cache plus the SW's own 60s snapshot cache means a legitimate client
 * reaches the function about once a minute per cache key, so the budget
 * only bites on callers deliberately missing the cache. A limiter outage
 * serves the snapshot unmetered, and a 429 is no-store so one caller's
 * exhausted budget is never served to other service workers (the SW treats
 * any non-OK response as "no information" and navigates).
 */

export const config = { runtime: 'edge' };

// @ts-expect-error — JS module, no declaration file
import { getCorsHeaders } from './_cors.js';
// @ts-expect-error — JS module, no declaration file
import { jsonResponse } from './_json-response.js';
// @ts-expect-error — JS module, no declaration file
import { getRedisCredentials } from './_upstash-json.js';
// @ts-expect-error — JS module, no declaration file
import { checkRateLimit } from './_rate-limit.js';

const SUPPRESSIONS_KEY = 'notif:blocked-links:v1';
const HOST_PREFIX = 'host:';
const URL_DIGEST_PREFIX = 'sha256:';
// Same resolution rule as the relay matcher and the delivery classifier
// (scripts/shared/notify-fields.cjs classifyNotificationLink).
const LINK_RESOLUTION_BASE = 'https://worldmonitor.app/';
const RESOLVABLE_LINK_PATTERN = /^(?:[a-z][a-z0-9+.-]*:|\/)/i;
// One shared cache entry: the refusal of a query string is itself cached.
const CACHEABLE_HEADERS = { 'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=30' };
const RATE_LIMIT_SCOPE = 'notification-suppressions';
const RATE_LIMIT_PER_MINUTE = 60;

function warnUnavailable(reason, context = '') {
  const suffix = context ? ` ${context}` : '';
  console.warn(`[notification-suppressions][unavailable] reason=${reason}${suffix}`);
}

function normalizeUrl(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (!RESOLVABLE_LINK_PATTERN.test(trimmed)) return null;
  let parsed;
  try {
    parsed = new URL(trimmed, LINK_RESOLUTION_BASE);
  } catch {
    return null;
  }
  const protocol = parsed.protocol.toLowerCase();
  if (protocol !== 'http:' && protocol !== 'https:') return null;
  let host = parsed.hostname.toLowerCase().replace(/\.+$/, '');
  if (host.length === 0) return null;
  const isDefaultPort =
    (protocol === 'http:' && parsed.port === '80') ||
    (protocol === 'https:' && parsed.port === '443');
  if (parsed.port && !isDefaultPort) host += `:${parsed.port}`;
  let path = parsed.pathname || '/';
  try {
    path = decodeURI(path);
  } catch {
    // Malformed % sequences stay encoded — still comparable, just verbatim.
  }
  return `${protocol}//${host}${path}${parsed.search}${parsed.hash}`;
}

function normalizeHost(raw) {
  if (typeof raw !== 'string') return null;
  let host = raw.trim().toLowerCase().replace(/\.+$/, '');
  if (host.length === 0 || host.length > 253) return null;
  if (host.includes('/') || host.includes(':') || host.includes('?') || host.includes('#') || host.includes('@') || host.includes('\\')) return null;
  // An IDN entry must be published as the punycode host a URL parses to,
  // which is what the service worker compares against.
  if (/[^\x00-\x7f]/.test(host)) {
    try {
      host = new URL(`http://${host}`).hostname.replace(/\.+$/, '');
    } catch {
      return null;
    }
  }
  if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(host)) return null;
  return host;
}

async function digestUrl(url) {
  const bytes = new TextEncoder().encode(url);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return `${URL_DIGEST_PREFIX}${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

async function splitEntries(entries) {
  const exactUrls = [];
  const hosts = [];
  if (!Array.isArray(entries)) return { suppressed: [], hosts };
  for (const entry of entries) {
    if (typeof entry !== 'string') continue;
    const trimmed = entry.trim();
    if (trimmed.length === 0) continue;
    if (trimmed.toLowerCase().startsWith(HOST_PREFIX)) {
      const host = normalizeHost(trimmed.slice(HOST_PREFIX.length));
      if (host && !hosts.includes(host)) hosts.push(host);
      continue;
    }
    const url = normalizeUrl(trimmed);
    if (url && !exactUrls.includes(url)) exactUrls.push(url);
  }
  return { suppressed: await Promise.all(exactUrls.map(digestUrl)), hosts };
}

export async function readSuppressionSnapshot(fetchImpl = (...args) => globalThis.fetch(...args)) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    warnUnavailable('missing-credentials', 'source=upstash-smembers');
    return { readable: false, entries: null };
  }
  try {
    const res = await fetchImpl(`${url}/SMEMBERS/${encodeURIComponent(SUPPRESSIONS_KEY)}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'worldmonitor-edge/1.0' },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      warnUnavailable('redis-http-error', `source=upstash-smembers status=${res.status}`);
      return { readable: false, entries: null };
    }
    let json;
    try {
      json = await res.json();
    } catch {
      warnUnavailable('malformed-json', 'source=upstash-smembers');
      return { readable: false, entries: null };
    }
    const entries = json && Object.prototype.hasOwnProperty.call(json, 'result') ? json.result : undefined;
    if (!Array.isArray(entries)) {
      warnUnavailable('invalid-result', 'source=upstash-smembers');
      return { readable: false, entries: null };
    }
    return { readable: true, entries };
  } catch (error) {
    const errorName = error instanceof Error && error.name
      ? error.name.replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 64)
      : 'UnknownError';
    warnUnavailable('redis-request-error', `source=upstash-smembers error=${errorName || 'UnknownError'}`);
    return { readable: false, entries: null };
  }
}

export default async function handler(req, ctx) {
  const cors = getCorsHeaders(req, 'GET, OPTIONS');
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors });
  }
  if (req.method !== 'GET') {
    return jsonResponse({ error: 'Method not allowed' }, 405, cors);
  }
  // The service worker never sends a query. Refusing one keeps the shared
  // cache keyed on the path alone, so a random `?bust=` cannot turn this
  // anonymous endpoint into an uncached Redis read per request.
  if (new URL(req.url).search) {
    return jsonResponse({ error: 'Unexpected query string' }, 400, { ...cors, ...CACHEABLE_HEADERS });
  }

  // After the query refusal, which never touches Redis: metering it would
  // spend the Redis call the refusal exists to avoid. Fail-open (the
  // default) keeps the endpoint's contract through a limiter outage.
  const limited = await checkRateLimit(req, { ...cors, 'Cache-Control': 'no-store' }, {
    ctx,
    scope: RATE_LIMIT_SCOPE,
    limit: RATE_LIMIT_PER_MINUTE,
    window: '60 s',
  });
  if (limited) return limited;

  const creds = getRedisCredentials();
  if (!creds) {
    warnUnavailable('missing-credentials', 'source=handler');
    return jsonResponse({ suppressed: [], hosts: [], updatedAt: null, unavailable: true }, 200, {
      ...cors,
      // Never cache the fail-open shape: during a Redis blip the first miss
      // would otherwise poison the CDN and keep answering unavailable:true
      // (navigate) after Redis recovers — delaying the revoke exactly when
      // it matters.
      'Cache-Control': 'no-store',
    });
  }

  const snapshot = await readSuppressionSnapshot();
  if (!snapshot.readable) {
    return jsonResponse({ suppressed: [], hosts: [], updatedAt: null, unavailable: true }, 200, {
      ...cors,
      'Cache-Control': 'no-store',
    });
  }
  let split;
  try {
    split = await splitEntries(snapshot.entries);
  } catch (error) {
    const errorName = error instanceof Error && error.name
      ? error.name.replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 64)
      : 'UnknownError';
    warnUnavailable('url-digest-error', `source=handler error=${errorName || 'UnknownError'}`);
    return jsonResponse({ suppressed: [], hosts: [], updatedAt: null, unavailable: true }, 200, {
      ...cors,
      'Cache-Control': 'no-store',
    });
  }
  const { suppressed, hosts } = split;
  return jsonResponse({ suppressed, hosts, updatedAt: new Date().toISOString() }, 200, {
    ...cors,
    // 60s shared cache: fast enough for incident response (the SW also
    // revalidates per click past its own TTL), slow enough to absorb a
    // click storm on one hostile notification.
    ...CACHEABLE_HEADERS,
  });
}
