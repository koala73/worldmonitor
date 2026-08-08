export type BootstrapR2RumTier = 'fast' | 'slow';
export type BootstrapR2RumOutcome = 'success' | 'abort';
export type BootstrapR2RumRejectReason =
  | 'missing-server-timing'
  | 'invalid-server-timing'
  | 'missing-vercel-cache-status'
  | 'vercel-not-miss'
  | 'cloudflare-cache-hit'
  | 'cached-age'
  | 'invalid-duration';

export interface BootstrapR2RumSample {
  bootstrap_tier: BootstrapR2RumTier;
  device_class: 'mobile' | 'desktop';
  total_duration_ms: number;
  redis_duration_ms: number;
  non_r2_overhead_ms: number;
  outcome: BootstrapR2RumOutcome;
}

export type BootstrapR2RumResult =
  | { accepted: true; sample: BootstrapR2RumSample }
  | { accepted: false; reason: BootstrapR2RumRejectReason };

const SERVER_TIMING_RE = /(?:^|,)\s*wm_bootstrap_redis\s*;\s*dur\s*=\s*(\d+(?:\.\d+)?)\s*(?:,|$)/i;
const REDIS_DURATION_RE = /^\d+(?:\.\d+)?$/;
const REDIS_DURATION_HEADER = 'x-worldmonitor-bootstrap-redis-duration';
const CLOUDFLARE_ORIGIN_STATES = new Set(['DYNAMIC', 'BYPASS', 'MISS']);

export function selectBootstrapR2RumTier(rng: () => number = Math.random): BootstrapR2RumTier {
  return rng() < 0.5 ? 'fast' : 'slow';
}

function readRedisDuration(headers: Headers): number | null | 'invalid' {
  const rawPlatformSafeDuration = headers.get(REDIS_DURATION_HEADER);
  if (rawPlatformSafeDuration !== null) {
    const platformSafeDuration = rawPlatformSafeDuration.trim();
    if (!REDIS_DURATION_RE.test(platformSafeDuration)) return 'invalid';
    const duration = Number(platformSafeDuration);
    return Number.isFinite(duration) && duration >= 0 ? duration : 'invalid';
  }

  const raw = headers.get('server-timing');
  if (!raw) return null;
  const match = raw.match(SERVER_TIMING_RE);
  if (!match) return 'invalid';
  const duration = Number(match[1]);
  return Number.isFinite(duration) && duration >= 0 ? duration : 'invalid';
}

/**
 * Conservative candidate classifier for the U3a purge -> MISS -> HIT proof.
 * Production evidence must validate the accepted header tuple before any
 * sample is admitted to C_happy; unknown or conflicting states fail closed.
 */
export function buildBootstrapR2RumSample(
  tier: BootstrapR2RumTier,
  outcome: BootstrapR2RumOutcome,
  totalDurationMs: number,
  headers: Headers,
  deviceClass: 'mobile' | 'desktop',
): BootstrapR2RumResult {
  const redisDurationMs = readRedisDuration(headers);
  if (redisDurationMs === null) return { accepted: false, reason: 'missing-server-timing' };
  if (redisDurationMs === 'invalid') return { accepted: false, reason: 'invalid-server-timing' };

  const vercelCache = headers.get('x-vercel-cache')?.trim().toUpperCase();
  if (!vercelCache) return { accepted: false, reason: 'missing-vercel-cache-status' };
  if (vercelCache !== 'MISS') return { accepted: false, reason: 'vercel-not-miss' };

  const cloudflareCache = headers.get('cf-cache-status')?.trim().toUpperCase();
  if (cloudflareCache && !CLOUDFLARE_ORIGIN_STATES.has(cloudflareCache)) {
    return { accepted: false, reason: 'cloudflare-cache-hit' };
  }

  const rawAge = headers.get('age');
  if (rawAge != null && rawAge.trim() !== '') {
    const age = rawAge.trim();
    if (!/^\d+$/.test(age) || Number(age) !== 0) {
      return { accepted: false, reason: 'cached-age' };
    }
  }

  if (
    !Number.isFinite(totalDurationMs)
    || totalDurationMs < 0
    || redisDurationMs > totalDurationMs
  ) {
    return { accepted: false, reason: 'invalid-duration' };
  }

  return {
    accepted: true,
    sample: {
      bootstrap_tier: tier,
      device_class: deviceClass,
      total_duration_ms: totalDurationMs,
      redis_duration_ms: redisDurationMs,
      non_r2_overhead_ms: totalDurationMs - redisDurationMs,
      outcome,
    },
  };
}
