import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Derive the sebuf RPC routes whose handler only READS seed-owned Redis and
 * never reaches an upstream itself (#5906).
 *
 * The desktop sidecar has no Upstash credentials, and a Redis miss is
 * graceful degradation in server/_shared/redis.ts, so such a handler answers
 * an empty 200 locally and the sidecar's `!response.ok` cloud fallback never
 * fires. Every route this returns must therefore be cloud-preferred in
 * src-tauri/sidecar/local-api-server.mjs regardless of WS_RELAY_URL.
 *
 * Classification is textual and deliberately conservative in the "live"
 * direction: any outbound-looking token marks a handler live, so a handler
 * that reads a seed and THEN falls back to its own fetch (which works locally
 * with the user's keys) is never forced to the cloud.
 */

// Redis read helpers exported by server/_shared/redis.ts.
const REDIS_READ = /getCachedJson|readCachedJson|getCachedJsonBatch|readCachedJsonList|getCachedEnvelopeJson|readCachedEnvelopeJson|getRawJson|getLargeRawJson|getCachedRawString|getHashFieldsBatch/;

// Anything that can leave the process: fetch and every helper spelled
// `xFetch…(`/`fetch…(` (wtoFetch, fredFetchJson, cachedFetchJson), relay and
// proxy helpers, LLM calls, URL construction, and literal URLs. `fetchedAt`
// fields are excluded by the (?!ed) lookahead.
const OUTBOUND = /(?<![A-Za-z])fetch(?!ed)[A-Za-z]*\(|[a-z]Fetch(?!ed)[A-Za-z]*\(|cachedFetchJson|getRelayBaseUrl|getRelayHeaders|relay|proxy|callLlm|new URL\(|https?:\/\//i;

export function classifyRpcHandler(source) {
  const reads = REDIS_READ.test(source);
  const outbound = OUTBOUND.test(source);
  return { seedOnly: reads && !outbound, reads, outbound };
}

/**
 * @returns {{ routes: Array<{ route: string, domain: string, file: string, seedOnly: boolean }>, byDomain: Map<string, { total: number, seedOnly: number }> }}
 */
export function scanRpcHandlers(repoRoot) {
  const root = join(repoRoot, 'server', 'worldmonitor');
  const routes = [];
  const byDomain = new Map();
  for (const domain of readdirSync(root).sort()) {
    const domainDir = join(root, domain);
    if (!statSync(domainDir).isDirectory()) continue;
    for (const version of readdirSync(domainDir).sort()) {
      if (!/^v\d+$/.test(version)) continue;
      const versionDir = join(domainDir, version);
      for (const file of readdirSync(versionDir).sort()) {
        if (!file.endsWith('.ts') || file.startsWith('_') || file === 'handler.ts' || file.includes('.test.')) continue;
        const source = readFileSync(join(versionDir, file), 'utf8');
        const { seedOnly } = classifyRpcHandler(source);
        // The v1 gateways live at api/{domain}/v1/[rpc].ts; a versioned family
        // lives at api/v{N}/{domain}/[rpc].ts (api/v2/shipping), so its URL is
        // /api/v2/shipping/…, not /api/shipping/v2/… (#5907).
        const route = existsSync(join(repoRoot, 'api', domain, version, '[rpc].ts'))
          ? `/api/${domain}/${version}/${file.slice(0, -3)}`
          : `/api/${version}/${domain}/${file.slice(0, -3)}`;
        routes.push({ route, domain, file: `server/worldmonitor/${domain}/${version}/${file}`, seedOnly });
        const tally = byDomain.get(domain) ?? { total: 0, seedOnly: 0 };
        tally.total += 1;
        if (seedOnly) tally.seedOnly += 1;
        byDomain.set(domain, tally);
      }
    }
  }
  return { routes, byDomain };
}

/** Domains where EVERY handler is seed-only (safe to cloud-prefer by prefix). */
export function wholeSeedOnlyDomains(byDomain) {
  return [...byDomain.entries()]
    .filter(([, t]) => t.total > 0 && t.seedOnly === t.total)
    .map(([domain]) => domain)
    .sort();
}

/** Read the sidecar's cloud-preferred declarations from its source text. */
export function readSidecarCloudPreferred(sidecarSource) {
  const list = (name, open, close) => {
    const m = sidecarSource.match(new RegExp(`const ${name} = ${open}([\\s\\S]*?)${close}`));
    if (!m) throw new Error(`${name} not found in sidecar source`);
    return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
  };
  return {
    relayGatedPrefixes: list('cloudPreferredPrefixes', '!process\\.env\\.WS_RELAY_URL\\s*\\?\\s*\\[', '\\]'),
    seedOnlyPrefixes: list('cloudPreferredSeedOnlyPrefixes', '\\[', '\\];'),
    alwaysPrefixes: list('cloudPreferredAlwaysPrefixes', '\\[', '\\];'),
    exact: list('cloudPreferredExact', 'new Set\\(\\[', '\\]\\);'),
  };
}

export function isAlwaysCloudPreferred(route, decl) {
  return decl.exact.includes(route)
    || decl.alwaysPrefixes.some((p) => route.startsWith(p))
    || decl.seedOnlyPrefixes.some((p) => route.startsWith(p));
}

/** server/worldmonitor handler file behind an exact route, in either URL shape; null when the route is not an RPC. */
export function handlerFileForRoute(route) {
  const v1 = route.match(/^\/api\/([^/]+)\/(v\d+)\/([^/]+)$/);
  if (v1) return `server/worldmonitor/${v1[1]}/${v1[2]}/${v1[3]}.ts`;
  const versioned = route.match(/^\/api\/(v\d+)\/([^/]+)\/([^/]+)$/);
  if (versioned) return `server/worldmonitor/${versioned[2]}/${versioned[1]}/${versioned[3]}.ts`;
  return null;
}
