// The Upstash rate-limit packages, imported on first use rather than at module
// load. The desktop sidecar ships api/ without node_modules and has no Upstash
// credentials, so a static import made every route that reaches a rate limiter
// fail to load there; the sidecar then sent those requests to the cloud, or
// answered 502 offline (#9906). Callers check the Upstash env before calling.
// scripts/check-sidecar-shipped-routes.mjs holds the line.

/** @type {Promise<{ Ratelimit: typeof import('@upstash/ratelimit').Ratelimit, Redis: typeof import('@upstash/redis').Redis }> | null} */
let modules = null;

export function loadUpstashRatelimit() {
  modules ??= Promise.all([import('@upstash/ratelimit'), import('@upstash/redis')])
    .then(([ratelimit, redis]) => ({ Ratelimit: ratelimit.Ratelimit, Redis: redis.Redis }));
  return modules;
}
