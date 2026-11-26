import { writeSync } from 'node:fs';

// Stands in for runSeed: prints the arguments the seeder passed and ends the process
// once the current turn finishes, so nothing is fetched or written and every probe
// ends on its own rather than at a timeout.
export function runSeed(domain, resource, canonicalKey, _fetchFn, opts = {}) {
  const extraKeys = Array.isArray(opts.extraKeys)
    ? opts.extraKeys.map((ek) => ({ key: ek?.key ?? null, ttl: ek?.ttl ?? null, metaKey: ek?.metaKey ?? null }))
    : [];
  writeSync(1, `@@RUNSEED ${JSON.stringify({
    domain, resource, canonicalKey, ttlSeconds: opts.ttlSeconds ?? null, extraKeys,
  })}\n`);
  setImmediate(() => process.exit(0));
  return new Promise(() => {});
}
