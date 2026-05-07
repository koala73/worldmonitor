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
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse as parseYaml } from 'yaml';

const ROOT = new URL('..', import.meta.url).pathname;
const OPENAPI_DIR = join(ROOT, 'docs/api');
const RATE_LIMIT_SRC = join(ROOT, 'server/_shared/rate-limit.ts');

async function extractPolicyKeys() {
  // Dynamic import via the file URL — works under tsx (the shebang) which
  // transparently transpiles TS. Importing the live object means any reformat
  // of the source literal can never desync the lint from the runtime.
  const mod = await import(pathToFileURL(RATE_LIMIT_SRC).href);
  if (!mod.ENDPOINT_RATE_POLICIES || typeof mod.ENDPOINT_RATE_POLICIES !== 'object') {
    throw new Error(
      `${RATE_LIMIT_SRC} no longer exports ENDPOINT_RATE_POLICIES — the lint relies on it (#3278).`,
    );
  }
  return Object.keys(mod.ENDPOINT_RATE_POLICIES);
}

function extractRoutesFromOpenApi() {
  // Parse the OpenAPI YAML rather than regex-scrape for top-level `paths:`
  // keys — the earlier `/^\s{4}(\/api\/[^\s:]+):/gm` hard-coded 4-space
  // indent, so any YAML formatter change (2-space indent, flow style, line
  // folding) would silently drop routes and let policy-drift slip through
  // (#3287 greptile nit 3).
  const routes = new Set();
  const files = readdirSync(OPENAPI_DIR).filter((f) => f.endsWith('.openapi.yaml'));
  for (const file of files) {
    const doc = parseYaml(readFileSync(join(OPENAPI_DIR, file), 'utf8'));
    const paths = doc?.paths;
    if (!paths || typeof paths !== 'object') continue;
    for (const route of Object.keys(paths)) {
      if (route.startsWith('/api/')) routes.add(route);
    }
  }
  return routes;
}

async function main() {
  const keys = await extractPolicyKeys();
  const routes = extractRoutesFromOpenApi();
  const missing = keys.filter((k) => !routes.has(k));

  if (missing.length > 0) {
    console.error('✗ ENDPOINT_RATE_POLICIES key(s) do not match any generated gateway route:\n');
    for (const key of missing) {
      console.error(`  - ${key}`);
    }
    console.error('\nEach key must be a proto-generated RPC path. Check that:');
    console.error('  1. The key matches the path in docs/api/<Service>.openapi.yaml exactly.');
    console.error('  2. If you renamed the RPC in proto, update the policy key to match.');
    console.error('  3. If the policy is for a non-proto legacy route, remove it once that route is migrated.\n');
    console.error('Similar issues in history: review of #3242 flagged the sanctions-entity-search');
    console.error('policy under `/api/sanctions/v1/lookup-entity` when the generated path was');
    console.error('`/api/sanctions/v1/lookup-sanction-entity` — the policy was dead code.');
    process.exit(1);
  }

  console.log(`✓ rate-limit policies clean: ${keys.length} policies validated against ${routes.size} gateway routes.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
