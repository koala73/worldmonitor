import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

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

// Redis read helpers exported by server/_shared/redis.ts, plus
// readRequiredSeed (server/_shared/required-seed.ts), which wraps them.
const REDIS_READ = /getCachedJson|readCachedJson|getCachedJsonBatch|readCachedJsonList|getCachedEnvelopeJson|readCachedEnvelopeJson|getRawJson|getLargeRawJson|getCachedRawString|getHashFieldsBatch|readRequiredSeed|runRedisPipeline\(\s*\[\s*\[\s*['"]ZRANGEBYSCORE['"]/;

// Anything that can leave the process: fetch and every helper spelled
// `xFetch…(`/`fetch…(` (wtoFetch, fredFetchJson, lazyFetchBilateralHs4,
// fetchJson<T>(…)), cachedFetchJson, the relay URL/header helpers, LLM calls,
// URL construction, and literal URLs. `fetchedAt` fields are excluded by the
// (?!ed) lookahead. Matched against comment-stripped source, so a comment
// that mentions "ais-relay" or a proxy does not make a handler live.
const OUTBOUND = /(?<![A-Za-z])fetch(?!ed)[A-Za-z0-9_]*(?:<[^<>()]*>)?\(|[a-z]Fetch(?!ed)[A-Za-z0-9_]*(?:<[^<>()]*>)?\(|cachedFetchJson|getRelayBaseUrl|getRelayHeaders|callLlm|new URL\(|https?:\/\//i;

const printer = ts.createPrinter({ removeComments: true });

/** Source text with every comment removed; string and regex literals stay intact. */
export function stripComments(source) {
  const file = ts.createSourceFile('handler.ts', source, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
  return printer.printFile(file);
}

export function classifyRpcHandler(source) {
  const code = stripComments(source);
  const reads = REDIS_READ.test(code);
  const outbound = OUTBOUND.test(code);
  return { seedOnly: reads && !outbound, reads, outbound };
}

/** `[{ path, method }]` for every route a generated service_server.ts serves. */
export function readGeneratedRoutes(serviceServerSource) {
  const segments = serviceServerSource.split(/\bpath: "/).slice(1);
  return segments.map((segment) => {
    const path = segment.slice(0, segment.indexOf('"'));
    const call = segment.match(/\bhandler\.([A-Za-z0-9_]+)\(/);
    if (!call) throw new Error(`no handler call follows generated path ${path}`);
    return { path, method: call[1] };
  });
}

/** Map each RPC method name a domain handler.ts imports to the file that implements it. */
function readHandlerImports(handlerSource) {
  const byMethod = new Map();
  for (const m of handlerSource.matchAll(/^import\s+\{([^}]+)\}\s+from\s+'\.\/([^']+)';/gm)) {
    for (const spec of m[1].split(',').map((s) => s.trim()).filter(Boolean)) {
      const [imported, local = imported] = spec.split(/\s+as\s+/);
      byMethod.set(local, m[2].endsWith('.ts') ? m[2] : `${m[2]}.ts`);
    }
  }
  return byMethod;
}

/**
 * Every RPC route the generated servers declare, mapped through each domain's
 * handler.ts to the file that implements it, and classified.
 *
 * @returns {{ routes: Array<{ route: string, prefix: string, method: string, file: string, seedOnly: boolean }>, byPrefix: Map<string, { total: number, seedOnly: number }> }}
 */
export function scanRpcHandlers(repoRoot) {
  const root = join(repoRoot, 'server', 'worldmonitor');
  const routes = [];
  const byPrefix = new Map();
  const classified = new Map();
  for (const domain of readdirSync(root).sort()) {
    const domainDir = join(root, domain);
    if (!statSync(domainDir).isDirectory()) continue;
    for (const version of readdirSync(domainDir).sort()) {
      if (!/^v\d+$/.test(version)) continue;
      const versionDir = join(domainDir, version);
      const handlerSource = readFileSync(join(versionDir, 'handler.ts'), 'utf8');
      // The generated directory is snake_case (supply_chain) while the handler
      // directory is kebab-case (supply-chain); handler.ts names it exactly.
      const generated = handlerSource.match(/from '((?:\.\.\/)+src\/generated\/server\/[^']+\/service_server)'/);
      if (!generated) throw new Error(`${relative(repoRoot, versionDir)}/handler.ts does not import a generated service_server`);
      const generatedSource = readFileSync(join(versionDir, `${generated[1]}.ts`), 'utf8');
      const imports = readHandlerImports(handlerSource);
      for (const { path, method } of readGeneratedRoutes(generatedSource)) {
        const implFile = imports.get(method);
        if (!implFile) throw new Error(`${relative(repoRoot, versionDir)}/handler.ts does not import ${method} for ${path}`);
        const file = relative(repoRoot, join(versionDir, implFile));
        if (!classified.has(file)) classified.set(file, classifyRpcHandler(readFileSync(join(repoRoot, file), 'utf8')).seedOnly);
        const seedOnly = classified.get(file);
        const prefix = path.slice(0, path.lastIndexOf('/') + 1);
        routes.push({ route: path, prefix, method, file, seedOnly });
        const tally = byPrefix.get(prefix) ?? { total: 0, seedOnly: 0 };
        tally.total += 1;
        if (seedOnly) tally.seedOnly += 1;
        byPrefix.set(prefix, tally);
      }
    }
  }
  return { routes, byPrefix };
}

/** Route prefixes where EVERY route is seed-only (safe to cloud-prefer by prefix). */
export function wholeSeedOnlyPrefixes(byPrefix) {
  return [...byPrefix.entries()]
    .filter(([, t]) => t.total > 0 && t.seedOnly === t.total)
    .map(([prefix]) => prefix)
    .sort();
}

/** Read the sidecar's cloud-preferred declarations from its source text. */
export function readSidecarCloudPreferred(sidecarSource) {
  const list = (name, open, close) => {
    const m = sidecarSource.match(new RegExp(`const ${name} = ${open}([\\s\\S]*?)${close}`));
    if (!m) throw new Error(`${name} not found in sidecar source`);
    // Entries never contain `//`, so dropping line comments cannot cut one.
    return [...m[1].replace(/\/\/.*$/gm, '').matchAll(/'([^']+)'/g)].map((x) => x[1]);
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
