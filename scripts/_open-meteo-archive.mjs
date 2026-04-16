import { CHROME_UA, sleep, resolveProxy, httpsProxyFetchRaw } from './_seed-utils.mjs';

const MAX_RETRY_AFTER_MS = 60_000;
const RETRYABLE_STATUSES = new Set([429, 503]);

export function chunkItems(items, size) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

export function normalizeArchiveBatchResponse(payload) {
  return Array.isArray(payload) ? payload : [payload];
}

export function parseRetryAfterMs(value) {
  if (!value) return null;

  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds > 0) {
    return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
  }

  const retryAt = Date.parse(value);
  if (Number.isFinite(retryAt)) {
    return Math.min(Math.max(retryAt - Date.now(), 1000), MAX_RETRY_AFTER_MS);
  }

  return null;
}

export async function fetchOpenMeteoArchiveBatch(zones, opts) {
  const {
    startDate,
    endDate,
    daily,
    timezone = 'UTC',
    timeoutMs = 30_000,
    maxRetries = 3,
    retryBaseMs = 2_000,
    label = zones.map((zone) => zone.name).join(', '),
  } = opts;

  const params = new URLSearchParams({
    latitude: zones.map((zone) => String(zone.lat)).join(','),
    longitude: zones.map((zone) => String(zone.lon)).join(','),
    start_date: startDate,
    end_date: endDate,
    daily: daily.join(','),
    timezone,
  });
  const url = `https://archive-api.open-meteo.com/v1/archive?${params.toString()}`;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let resp;
    try {
      resp = await fetch(url, {
        headers: { 'User-Agent': CHROME_UA },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      if (attempt < maxRetries) {
        const retryMs = retryBaseMs * 2 ** attempt;
        console.log(`  [OPEN_METEO] ${err?.message ?? err} for ${label}; retrying batch in ${Math.round(retryMs / 1000)}s`);
        await sleep(retryMs);
        continue;
      }
      throw err;
    }

    if (resp.ok) {
      const data = normalizeArchiveBatchResponse(await resp.json());
      if (data.length !== zones.length) {
        throw new Error(`Open-Meteo batch size mismatch for ${label}: expected ${zones.length}, got ${data.length}`);
      }
      return data;
    }

    if (RETRYABLE_STATUSES.has(resp.status) && attempt < maxRetries) {
      const retryMs = parseRetryAfterMs(resp.headers.get('retry-after')) ?? (retryBaseMs * 2 ** attempt);
      console.log(`  [OPEN_METEO] ${resp.status} for ${label}; retrying batch in ${Math.round(retryMs / 1000)}s`);
      await sleep(retryMs);
      continue;
    }

    // Direct attempt failed with non-retryable or after-final-retry status.
    // Open-Meteo's free tier rate-limits per source IP; Railway containers
    // share IP pools and hit 429 storms (logs.1776312819911 — every batch
    // 429'd through 4 retries on 2026-04-16). Fall through to proxy fallback
    // below before throwing.
    break;
  }

  // Proxy fallback — same pattern as fredFetchJson / imfFetchJson in
  // _seed-utils.mjs. Decodo gateway gets a different egress IP that is not
  // (yet) on Open-Meteo's per-IP throttle. Skip silently if no proxy is
  // configured (preserves existing behavior in non-Railway envs).
  const proxyAuth = resolveProxy();
  if (proxyAuth) {
    try {
      console.log(`  [OPEN_METEO] direct exhausted on ${label}; trying proxy`);
      const { buffer } = await httpsProxyFetchRaw(url, proxyAuth, {
        accept: 'application/json',
        timeoutMs,
      });
      const data = normalizeArchiveBatchResponse(JSON.parse(buffer.toString('utf8')));
      if (data.length !== zones.length) {
        throw new Error(`Open-Meteo proxy batch size mismatch for ${label}: expected ${zones.length}, got ${data.length}`);
      }
      console.log(`  [OPEN_METEO] proxy succeeded for ${label}`);
      return data;
    } catch (proxyErr) {
      console.warn(`  [OPEN_METEO] proxy fallback failed for ${label}: ${proxyErr?.message ?? proxyErr}`);
    }
  }

  throw new Error(`Open-Meteo retries exhausted for ${label}`);
}
