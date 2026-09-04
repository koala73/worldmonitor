import { readRawJsonFromUpstash, setCachedData } from './_upstash-json.js';

const RELEASES_URL = 'https://api.github.com/repos/koala73/worldmonitor/releases/latest';
const CACHE_KEY = 'github:latest-release:v1';
// Matches the s-maxage the callers already advertise, so adding the Redis tier
// does not change how stale a client can observe this — it only stops every
// CDN miss from spending one of GitHub's 60/hr unauthenticated requests.
const CACHE_TTL_SECONDS = 300;

export async function fetchLatestRelease(userAgent, timeoutMs = 5000) {
  // Redis is a load shield, not a dependency: /api/version and /api/download are
  // public and must keep answering when the cache is down or unconfigured.
  try {
    const cached = await readRawJsonFromUpstash(CACHE_KEY);
    if (cached) return cached;
  } catch {
    // fall through to the live fetch
  }

  // Bounded, and degraded to null on failure: this is the one third-party
  // call on two public routes, and untimed it held the function until the
  // platform's 300s wall instead of failing fast to the callers' documented
  // degraded paths (/api/version -> 502, /api/download -> releases-page
  // redirect) (#7211). The Redis read above and every sibling upstash call
  // were already bounded; this was the gap.
  let res;
  try {
    res = await fetch(RELEASES_URL, {
      headers: {
        'Accept': 'application/vnd.github+json',
        'User-Agent': userAgent,
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  const release = await res.json();

  try {
    await setCachedData(CACHE_KEY, release, CACHE_TTL_SECONDS);
  } catch {
    // A failed write must not fail the request that already has its answer.
  }

  return release;
}
