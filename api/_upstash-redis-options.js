// Options for every @upstash/redis client in api/ and server/: the rate
// limiters and the OAuth and MCP stores. Build clients with
// `new Redis(upstashRedisOptions(url, token))`, never an inline options object;
// tests/upstash-redis-signal-form.test.mjs enforces that.
//
// - `signal` is a factory. With a static AbortSignal, @upstash/redis resolves an
//   aborted call as a synthetic 200 `{ result: 'Aborted' }`, which a rate
//   limiter reads as "allowed". A factory makes the aborted call reject.
// - Two capped, jittered retries by default. `retry: false` is for callers
//   that must fail fast and own their degraded path.
// - Under the node test runner retries are off, so fail-open tests pointed at
//   a fake host degrade immediately.
//
// No imports: the desktop sidecar ships api/ without node_modules (#9906).

/** Exponential backoff for retry `attempt` (0-based), capped at 1s, with 50-100% jitter. */
export function upstashRetryBackoff(attempt) {
  return Math.round(Math.min(1_000, 100 * 2 ** attempt) * (0.5 + Math.random() * 0.5));
}

/**
 * @param {string} url
 * @param {string} token
 * @param {{ retry?: boolean, timeoutMs?: number }} [options]
 * @returns {import('@upstash/redis').RedisConfigNodejs}
 */
export function upstashRedisOptions(url, token, { retry = true, timeoutMs = 3_000 } = {}) {
  return {
    url,
    token,
    signal: () => AbortSignal.timeout(timeoutMs),
    retry: retry && !process.env.NODE_TEST_CONTEXT ? { retries: 2, backoff: upstashRetryBackoff } : false,
  };
}
