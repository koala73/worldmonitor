#!/usr/bin/env -S npx tsx
/**
 * Validates every key in ENDPOINT_RATE_POLICIES (server/_shared/rate-limit.ts)
 * is a real gateway route by checking the OpenAPI specs generated from protos.
 * Catches rename-drift that causes policies to become dead code (the
 * sanctions-entity-search review finding — the policy key was
 * `/api/sanctions/v1/lookup-entity` but the proto RPC generates path
 * `/api/sanctions/v1/lookup-sanction-entity`, so the 30/min limit never
 * applied and the endpoint fell through to the 600/min global limiter).
 *
 * Runs in the same pre-push + CI context as lint:api-contract. Invoked via
 * `tsx` so it can import the policy object straight from the TS source
 * (#3278) — the previous regex-parse implementation would silently break if
 * the source object literal was reformatted.
 *
 * PR #3821 r2: also resolves keys against api/api-route-exceptions.json so
 * top-level Vercel Edge Functions (e.g. /api/mcp-proxy, an external-protocol
 * exception that can't flow through the gateway) can register a policy and
 * enforce it in-handler via `checkScopedRateLimit` without becoming invisible
 * to this audit. Without this branch, /api/mcp-proxy would silently slip
 * through future endpoint-coverage checks even though it has a live limit.
 *
 * Also validates three decision registries exported from rate-limit.ts:
 *   - FAIL_CLOSED_ENDPOINT_RATE_POLICY_REQUIRED: expensive/sensitive routes
 *     that must have an endpoint policy so Redis degradation fails closed.
 *   - GLOBAL_RATE_LIMIT_FALLBACK_READ_ROUTES: deliberately read-only gateway
 *     routes that are allowed to inherit the global fail-open fallback.
 *   - RATE_LIMIT_MUTATION_FALLBACK_EXEMPT: NON-GET routes deliberately allowed
 *     to inherit the fail-open fallback (each with a justification).
 *
 * #4676 (systemic guardrail): enumerate EVERY non-GET (post/put/patch/delete)
 * route from the generated OpenAPI metadata and require each to be either
 * covered by ENDPOINT_RATE_POLICIES or explicitly listed in
 * RATE_LIMIT_MUTATION_FALLBACK_EXEMPT. Previously the audit only checked
 * registry internal consistency, so an expensive/mutation route omitted from
 * every registry would pass CI and silently fail OPEN on a Redis outage. New
 * non-GET routes now have to be triaged into one bucket or the other.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse as parseYaml } from 'yaml';

const ROOT = new URL('..', import.meta.url).pathname;
const OPENAPI_DIR = join(ROOT, 'docs/api');
const RATE_LIMIT_SRC = join(ROOT, 'server/_shared/rate-limit.ts');
const API_EXCEPTIONS = join(ROOT, 'api/api-route-exceptions.json');
const RUNTIME_RATE_LIMIT_DIRS = ['server', 'api'].map((dir) => join(ROOT, dir));
const RUNTIME_SOURCE_EXTENSIONS = new Set(['.js', '.cjs', '.mjs', '.ts', '.tsx']);

async function extractRateLimitPolicyModule() {
  // Dynamic import via the file URL — works under tsx (the shebang) which
  // transparently transpiles TS. Importing the live object means any reformat
  // of the source literal can never desync the lint from the runtime.
  const mod = await import(pathToFileURL(RATE_LIMIT_SRC).href);
  if (!mod.ENDPOINT_RATE_POLICIES || typeof mod.ENDPOINT_RATE_POLICIES !== 'object') {
    throw new Error(
      `${RATE_LIMIT_SRC} no longer exports ENDPOINT_RATE_POLICIES — the lint relies on it (#3278).`,
    );
  }
  if (!mod.FAIL_CLOSED_ENDPOINT_RATE_POLICY_REQUIRED || typeof mod.FAIL_CLOSED_ENDPOINT_RATE_POLICY_REQUIRED !== 'object') {
    throw new Error(
      `${RATE_LIMIT_SRC} no longer exports FAIL_CLOSED_ENDPOINT_RATE_POLICY_REQUIRED — expensive routes need an auditable fail-closed registry (#4676).`,
    );
  }
  if (!mod.GLOBAL_RATE_LIMIT_FALLBACK_READ_ROUTES || typeof mod.GLOBAL_RATE_LIMIT_FALLBACK_READ_ROUTES !== 'object') {
    throw new Error(
      `${RATE_LIMIT_SRC} no longer exports GLOBAL_RATE_LIMIT_FALLBACK_READ_ROUTES — accepted fail-open read routes need an auditable registry (#4676).`,
    );
  }
  if (!mod.RATE_LIMIT_MUTATION_FALLBACK_EXEMPT || typeof mod.RATE_LIMIT_MUTATION_FALLBACK_EXEMPT !== 'object') {
    throw new Error(
      `${RATE_LIMIT_SRC} no longer exports RATE_LIMIT_MUTATION_FALLBACK_EXEMPT — non-GET routes that deliberately keep the fail-open fallback need an auditable exemption registry (#4676).`,
    );
  }
  return mod;
}

function extractRoutesFromOpenApi() {
  // Parse the OpenAPI YAML rather than regex-scrape for top-level `paths:`
  // keys — the earlier `/^\s{4}(\/api\/[^\s:]+):/gm` hard-coded 4-space
  // indent, so any YAML formatter change (2-space indent, flow style, line
  // folding) would silently drop routes and let policy-drift slip through
  // (#3287 greptile nit 3).
  const routes = new Map();
  const files = readdirSync(OPENAPI_DIR).filter((f) => f.endsWith('.openapi.yaml'));
  for (const file of files) {
    const doc = parseYaml(readFileSync(join(OPENAPI_DIR, file), 'utf8'));
    const paths = doc?.paths;
    if (!paths || typeof paths !== 'object') continue;
    for (const [route, operations] of Object.entries(paths)) {
      if (!route.startsWith('/api/') || !operations || typeof operations !== 'object') continue;
      routes.set(
        route,
        new Set(
          Object.keys(operations)
            .map((method) => method.toLowerCase())
            .filter((method) => ['get', 'post', 'put', 'patch', 'delete'].includes(method)),
        ),
      );
    }
  }
  return routes;
}

function extractEdgeFunctionRoutes() {
  // Top-level Vercel Edge Functions registered as non-proto exceptions in
  // api/api-route-exceptions.json don't appear in docs/api/*.openapi.yaml
  // (no proto → no generated path). They can still register a rate-limit
  // policy that's enforced in-handler via `checkScopedRateLimit` — most
  // notably /api/mcp-proxy (PR #3821 / #3805 review). Convert each exception
  // file path (e.g. "api/mcp-proxy.ts") to its URL path ("/api/mcp-proxy")
  // and accept it as a legitimate policy target.
  const routes = new Set();
  let doc;
  try {
    doc = JSON.parse(readFileSync(API_EXCEPTIONS, 'utf8'));
  } catch (err) {
    // Don't hard-fail if the exceptions file moves — gateway-route validation
    // (the original behaviour) still runs. Surface a warning so the loss of
    // edge-function coverage is visible.
    console.warn(`⚠ could not read ${API_EXCEPTIONS}: ${err.message}`);
    return routes;
  }
  const exceptions = Array.isArray(doc?.exceptions) ? doc.exceptions : [];
  for (const entry of exceptions) {
    const filePath = typeof entry?.path === 'string' ? entry.path : null;
    if (!filePath?.startsWith('api/')) continue;
    // api/mcp-proxy.ts → /api/mcp-proxy ; api/oauth/token.ts → /api/oauth/token
    const urlPath = `/${filePath.replace(/\.(ts|js|tsx|jsx|mjs|cjs)$/i, '')}`;
    routes.add(urlPath);
  }
  return routes;
}

function listRuntimeSourceFiles(dir, files = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.next' || entry.name === 'dist') continue;
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      listRuntimeSourceFiles(fullPath, files);
      continue;
    }
    if (!entry.isFile()) continue;
    const dot = entry.name.lastIndexOf('.');
    const ext = dot === -1 ? '' : entry.name.slice(dot);
    if (RUNTIME_SOURCE_EXTENSIONS.has(ext)) files.push(fullPath);
  }
  return files;
}

function toRepoRelativePath(pathname) {
  return pathname.slice(ROOT.length).replace(/^\/+/, '');
}

function findEndpointRateLimitFailOpenOptOuts() {
  // The endpoint limiter is the guardrail for routes listed in
  // FAIL_CLOSED_ENDPOINT_RATE_POLICY_REQUIRED. Its helper still exposes an
  // escape hatch for tests/backcompat, but production runtime callers must not
  // pass `{ failClosed: false }` and silently nullify the registry.
  const findings = [];
  const callWithFailOpenOptOut =
    /checkEndpointRateLimit\s*\([\s\S]*?\{[\s\S]*?failClosed\s*:\s*false[\s\S]*?\}\s*\)/g;

  for (const dir of RUNTIME_RATE_LIMIT_DIRS) {
    for (const file of listRuntimeSourceFiles(dir)) {
      if (file === RATE_LIMIT_SRC) continue;
      const src = readFileSync(file, 'utf8');
      if (!src.includes('checkEndpointRateLimit') || !src.includes('failClosed')) continue;
      for (const match of src.matchAll(callWithFailOpenOptOut)) {
        const line = src.slice(0, match.index).split('\n').length;
        findings.push(`${toRepoRelativePath(file)}:${line}`);
      }
    }
  }

  return findings;
}

async function main() {
  const rateLimitPolicyModule = await extractRateLimitPolicyModule();
  const keys = Object.keys(rateLimitPolicyModule.ENDPOINT_RATE_POLICIES);
  const failClosedRequired = Object.keys(rateLimitPolicyModule.FAIL_CLOSED_ENDPOINT_RATE_POLICY_REQUIRED);
  const globalFallbackReadRoutes = Object.keys(rateLimitPolicyModule.GLOBAL_RATE_LIMIT_FALLBACK_READ_ROUTES);
  const mutationFallbackExempt = Object.keys(rateLimitPolicyModule.RATE_LIMIT_MUTATION_FALLBACK_EXEMPT);
  const gatewayRoutes = extractRoutesFromOpenApi();
  const edgeRoutes = extractEdgeFunctionRoutes();
  const gatewayRoutePaths = new Set(gatewayRoutes.keys());
  const missing = keys.filter((k) => !gatewayRoutePaths.has(k) && !edgeRoutes.has(k));

  if (missing.length > 0) {
    console.error('✗ ENDPOINT_RATE_POLICIES key(s) do not match any gateway route OR edge-function exception:\n');
    for (const key of missing) {
      console.error(`  - ${key}`);
    }
    console.error('\nEach key must be either:');
    console.error('  (a) a proto-generated RPC path that appears in docs/api/<Service>.openapi.yaml');
    console.error('      (gateway-enforced via checkEndpointRateLimit), OR');
    console.error('  (b) a top-level Vercel Edge Function registered in');
    console.error('      api/api-route-exceptions.json (enforced in-handler via checkScopedRateLimit).');
    console.error('\nChecklist:');
    console.error('  1. The key matches the path in docs/api/<Service>.openapi.yaml exactly, OR');
    console.error('     api/<that-key>.ts (or .js) is listed in api/api-route-exceptions.json.');
    console.error('  2. If you renamed the RPC in proto, update the policy key to match.');
    console.error('  3. If the policy is for a non-proto legacy route, remove it once that route is migrated.\n');
    console.error('Similar issues in history: review of #3242 flagged the sanctions-entity-search');
    console.error('policy under `/api/sanctions/v1/lookup-entity` when the generated path was');
    console.error('`/api/sanctions/v1/lookup-sanction-entity` — the policy was dead code.');
    process.exit(1);
  }

  const requiredWithoutPolicy = failClosedRequired.filter((k) => !keys.includes(k));
  if (requiredWithoutPolicy.length > 0) {
    console.error('✗ fail-closed endpoint(s) are missing ENDPOINT_RATE_POLICIES entries:\n');
    for (const key of requiredWithoutPolicy) {
      console.error(`  - ${key}`);
    }
    console.error('\nRoutes listed in FAIL_CLOSED_ENDPOINT_RATE_POLICY_REQUIRED perform expensive,');
    console.error('provider-backed, mutation-like, checkout, lead-capture, live, or otherwise');
    console.error('sensitive work. They must declare endpoint-specific policies so Redis');
    console.error('missing/degraded windows return 503 instead of inheriting the global fail-open fallback.\n');
    process.exit(1);
  }

  const fallbackWithPolicy = globalFallbackReadRoutes.filter((k) => keys.includes(k));
  const fallbackMissingRoute = globalFallbackReadRoutes.filter((k) => !gatewayRoutePaths.has(k));
  const fallbackNonGet = globalFallbackReadRoutes.filter((k) => {
    if (!gatewayRoutePaths.has(k)) return false;
    const methods = gatewayRoutes.get(k);
    return !methods || methods.size !== 1 || !methods.has('get');
  });
  if (fallbackWithPolicy.length > 0 || fallbackMissingRoute.length > 0 || fallbackNonGet.length > 0) {
    console.error('✗ GLOBAL_RATE_LIMIT_FALLBACK_READ_ROUTES contains invalid route decisions:\n');
    if (fallbackWithPolicy.length > 0) {
      console.error('  Routes that already have endpoint-specific policies:');
      for (const key of fallbackWithPolicy) console.error(`    - ${key}`);
    }
    if (fallbackMissingRoute.length > 0) {
      console.error('  Routes that do not appear in generated OpenAPI gateway specs:');
      for (const key of fallbackMissingRoute) console.error(`    - ${key}`);
    }
    if (fallbackNonGet.length > 0) {
      console.error('  Routes that are not generated GET-only/read endpoints:');
      for (const key of fallbackNonGet) console.error(`    - ${key}`);
    }
    console.error('\nOnly low-cost read-only gateway routes may document acceptance of the');
    console.error('availability-first global fallback. Expensive or mutation-like routes belong');
    console.error('in ENDPOINT_RATE_POLICIES and FAIL_CLOSED_ENDPOINT_RATE_POLICY_REQUIRED.\n');
    process.exit(1);
  }

  // --- Systemic coverage: every non-GET route must be triaged (#4676) ---
  // Build the set of generated non-GET (post/put/patch/delete) gateway routes.
  const nonGetRoutes = [];
  for (const [route, methods] of gatewayRoutes) {
    const hasMutation = [...methods].some((m) => m !== 'get');
    if (hasMutation) nonGetRoutes.push(route);
  }
  nonGetRoutes.sort();
  const keySet = new Set(keys);
  const exemptSet = new Set(mutationFallbackExempt);

  // First: hygiene on the exemption registry itself so it can't rot into a
  // rubber stamp. Every entry must (a) name a real generated non-GET gateway
  // route and (b) not also carry an endpoint policy (redundant + contradictory).
  const exemptNotNonGet = mutationFallbackExempt.filter((k) => !nonGetRoutes.includes(k));
  const exemptWithPolicy = mutationFallbackExempt.filter((k) => keySet.has(k));
  if (exemptNotNonGet.length > 0 || exemptWithPolicy.length > 0) {
    console.error('✗ RATE_LIMIT_MUTATION_FALLBACK_EXEMPT contains invalid entries:\n');
    if (exemptNotNonGet.length > 0) {
      console.error('  Entries that are not generated non-GET (post/put/patch/delete) gateway routes:');
      for (const key of exemptNotNonGet) console.error(`    - ${key}`);
      console.error('  (A read-only route belongs in GLOBAL_RATE_LIMIT_FALLBACK_READ_ROUTES, and');
      console.error('   a renamed/removed route should be dropped from the exemption set.)');
    }
    if (exemptWithPolicy.length > 0) {
      console.error('  Entries that already have an ENDPOINT_RATE_POLICIES policy (remove the exemption):');
      for (const key of exemptWithPolicy) console.error(`    - ${key}`);
    }
    console.error('');
    process.exit(1);
  }

  // Then: the core guardrail — no non-GET route may be silently uncovered.
  const uncoveredNonGet = nonGetRoutes.filter((r) => !keySet.has(r) && !exemptSet.has(r));
  if (uncoveredNonGet.length > 0) {
    console.error('✗ non-GET route(s) are neither rate-limited nor explicitly exempt:\n');
    for (const key of uncoveredNonGet) {
      const methods = [...gatewayRoutes.get(key)].filter((m) => m !== 'get').sort();
      console.error(`  - ${key} [${methods.join(',')}]`);
    }
    console.error('\nEvery generated post/put/patch/delete route can mutate state or spend on');
    console.error('external providers/LLMs, so it must NOT silently inherit the availability-first');
    console.error('global fallback on a Redis outage. Triage each route above into exactly one of:\n');
    console.error('  (a) ENDPOINT_RATE_POLICIES + FAIL_CLOSED_ENDPOINT_RATE_POLICY_REQUIRED');
    console.error('      (server/_shared/rate-limit.ts) — the route is expensive / provider-backed /');
    console.error('      mutation-like and should return 503 when the limiter is unavailable, OR');
    console.error('  (b) RATE_LIMIT_MUTATION_FALLBACK_EXEMPT (server/_shared/rate-limit.ts) — the');
    console.error('      route is safe to fail open (add a justification comment/reason explaining');
    console.error('      why: e.g. read-only despite POST, Redis-only write, already auth-gated).\n');
    process.exit(1);
  }

  const endpointFailOpenOptOuts = findEndpointRateLimitFailOpenOptOuts();
  if (endpointFailOpenOptOuts.length > 0) {
    console.error('✗ production runtime caller(s) opt out of fail-closed endpoint rate limiting:\n');
    for (const location of endpointFailOpenOptOuts) {
      console.error(`  - ${location}`);
    }
    console.error('\nRoutes in FAIL_CLOSED_ENDPOINT_RATE_POLICY_REQUIRED rely on');
    console.error('checkEndpointRateLimit defaulting to fail closed when Redis is unavailable.');
    console.error('Do not pass { failClosed: false } from server/ or api/ runtime code;');
    console.error('move genuinely safe non-GET routes to RATE_LIMIT_MUTATION_FALLBACK_EXEMPT');
    console.error('or documented read routes to GLOBAL_RATE_LIMIT_FALLBACK_READ_ROUTES instead.\n');
    process.exit(1);
  }

  console.log(
    `✓ rate-limit policies clean: ${keys.length} policies validated against ${gatewayRoutes.size} gateway routes + ${edgeRoutes.size} edge-function exceptions; ${failClosedRequired.length} fail-closed requirements, ${globalFallbackReadRoutes.length} global-fallback read decisions, and ${nonGetRoutes.length} non-GET routes (${mutationFallbackExempt.length} explicitly exempt) audited.`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
