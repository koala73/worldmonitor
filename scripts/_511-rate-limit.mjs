/**
 * Per-host 511 token bucket.
 *
 * Default is 10 calls / 60 seconds (Ontario vendor 511 and the same vendor
 * AB/MB APIs). A shared Canada bucket would stall Alberta because Ontario
 * consumed the quota. Each hostname gets its own in-process bucket.
 *
 * DriveBC Open511 is paced at one request per second. A 60-token minute bucket
 * would permit a 60-request burst and would not enforce that pacing.
 *
 * Do not reuse inbound api/_rate-limit.js / the `rl:` Redis prefix — this is
 * an egress limiter inside the seeder process, not the public API limiter.
 *
 * Issue #6618 v1 / #6667.
 */

const DEFAULT_CAPACITY = 10;
const DEFAULT_WINDOW_MS = 60_000;

/** Per-host overrides for the process-wide default limiter. */
export const HOST_511_RATES = Object.freeze({
  'api.open511.gov.bc.ca': Object.freeze({ capacity: 1, windowMs: 1_000 }),
});

/**
 * @param {{
 *   capacity?: number,
 *   windowMs?: number,
 *   hostRates?: Record<string, { capacity?: number, windowMs?: number }>,
 *   now?: () => number,
 *   sleep?: (ms: number) => Promise<void>,
 * }} [opts]
 */
export function create511RateLimiter(opts = {}) {
  const defaultCapacity = opts.capacity ?? DEFAULT_CAPACITY;
  const defaultWindowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
  const hostRates = opts.hostRates ?? {};
  const now = opts.now ?? (() => Date.now());
  const sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));

  /** @type {Map<string, number[]>} */
  const stampsByHost = new Map();

  function rateFor(host) {
    const override = hostRates[host];
    return {
      capacity: override?.capacity ?? defaultCapacity,
      windowMs: override?.windowMs ?? defaultWindowMs,
    };
  }

  /**
   * Wait until this process may call `host` without exceeding that host's rate.
   * @param {string} host
   */
  async function acquire511Slot(host) {
    if (typeof host !== 'string' || host.trim() === '') {
      throw new TypeError('acquire511Slot(host) requires a non-empty hostname');
    }
    const key = host.trim().toLowerCase();
    const { capacity, windowMs } = rateFor(key);
    for (;;) {
      const nowMs = now();
      const windowStart = nowMs - windowMs;
      let stamps = stampsByHost.get(key) || [];
      stamps = stamps.filter((t) => t > windowStart);
      if (stamps.length < capacity) {
        stamps.push(nowMs);
        stampsByHost.set(key, stamps);
        return;
      }
      stampsByHost.set(key, stamps);
      const waitMs = Math.max(1, stamps[0] + windowMs - nowMs);
      await sleep(waitMs);
    }
  }

  function reset() {
    stampsByHost.clear();
  }

  /** @param {string} host */
  function pendingTokens(host) {
    const key = String(host || '').trim().toLowerCase();
    const { windowMs } = rateFor(key);
    const nowMs = now();
    const stamps = (stampsByHost.get(key) || []).filter((t) => t > nowMs - windowMs);
    return stamps.length;
  }

  return {
    acquire511Slot,
    reset,
    pendingTokens,
    pendingCount: pendingTokens,
    capacity: defaultCapacity,
    windowMs: defaultWindowMs,
    rateFor,
  };
}

const defaultLimiter = create511RateLimiter({ hostRates: HOST_511_RATES });

/** @param {string} host */
export async function acquire511Slot(host) {
  return defaultLimiter.acquire511Slot(host);
}

export function reset511RateLimiterForTests() {
  defaultLimiter.reset();
}

export const __testing__ = {
  reset() {
    defaultLimiter.reset();
  },
  pendingTokens(host) {
    return defaultLimiter.pendingTokens(host);
  },
  rateFor(host) {
    return defaultLimiter.rateFor(String(host || '').trim().toLowerCase());
  },
};
