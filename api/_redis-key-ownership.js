/**
 * Per-key write-ownership classification for keys the legacy api/ layer reads
 * through `api/_upstash-json.js` (#7674).
 *
 * The deployment key prefix is a write-ownership contract (#7575/#7673): one
 * shared Upstash instance serves two writer populations — Railway seeders and
 * relays that write bare keys (they do not know the Vercel prefix scheme), and
 * Vercel deployments whose helpers prefix app-owned keys on preview. A read
 * must therefore name its namespace explicitly:
 *
 *   - `isAppOwnedRedisKey(key) === false` (the overwhelming majority of the
 *     health/bootstrap/MCP registries) → read RAW. These keys are written by
 *     the seeder fleet; prefixing would make every preview deployment ask for
 *     `preview:<sha>:…` rows no seeder ever writes (#7274, #7575).
 *   - `isAppOwnedRedisKey(key) === true` → read/write with the deployment
 *     prefix (the helper default). These keys are written by Vercel routes
 *     through the prefix-aware helpers, so a preview deployment must consume
 *     its own rows and stamp its own freshness state instead of silently
 *     reading — and writing — the production namespace (#7674).
 *
 * The set is deliberately tiny and explicit: it lists the ROUTE-OWNED
 * exceptions inside the api layer's registry reads, not the seeder fleet,
 * which is the default. Add an entry here only when a Vercel route owns the
 * key's writes.
 */
const APP_OWNED_KEYS = Object.freeze([
  // Written by server/worldmonitor/infrastructure/v1/list-temporal-anomalies
  // (request-driven rebuild + seed-meta stamp) through the prefix-aware
  // server helpers — the snapshot and its freshness stamp live in the
  // deployment's own namespace on preview.
  'temporal:anomalies:v1',
  'seed-meta:temporal:anomalies',
]);

const APP_OWNED_KEY_SET = new Set(APP_OWNED_KEYS);

/**
 * True when the key is written by Vercel routes and must be read (and
 * written) with the deployment key prefix. Everything else in the api layer's
 * registry surface is seeder-owned and must be read raw.
 */
export function isAppOwnedRedisKey(key) {
  return typeof key === 'string' && APP_OWNED_KEY_SET.has(key);
}
