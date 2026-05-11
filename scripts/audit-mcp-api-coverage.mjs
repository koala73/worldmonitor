#!/usr/bin/env node
/**
 * MCP↔API coverage audit (Tier-4 plan, U2).
 *
 * One-shot audit script that walks every OpenAPI operation in
 * `docs/api/*.openapi.json` and produces a categorized report mapping each
 * `(METHOD, path)` op -> `{ handler, classification, cacheKeys }`.
 *
 * The output is the SEED INPUT for U3's `_apiPaths` population on every
 * TOOL_REGISTRY entry + U4's `EXCLUDED_FROM_MCP_PARITY` map. After U3+U4
 * land, this script becomes documentation / reference — humans re-run it
 * to verify a fresh OpenAPI op against the live TOOL_REGISTRY before
 * deciding whether to extend a tool's `_apiPaths` or add an exclusion.
 *
 * The audit is NOT a test-time dependency — the parity test only reads
 * the explicit `_apiPaths` declarations on TOOL_REGISTRY entries and the
 * `EXCLUDED_FROM_MCP_PARITY` map, never source code.
 *
 * Classification rules (handler source's `server/_shared/redis` imports):
 *   - imports `cachedFetchJson` / `cachedFetchJsonWithMeta`
 *       -> fetch-on-miss (on-demand RPC, talks to an upstream)
 *   - imports only `getCachedJson` / `getRawJson` / `getCachedJsonBatch`
 *       -> pure-read (Redis-only)
 *   - imports `setCachedJson` / `deleteRedisKey` / `runRedisPipeline`
 *       -> mutating (writes state)
 *   - no helper imports found
 *       -> unknown (manual triage required)
 *
 * Additionally annotates `llm-passthrough` when the handler imports
 * `callLlm` from `server/_shared/llm` — same handler may be both
 * `fetch-on-miss` AND `llm-passthrough` (canonical example:
 * `classify-event`).
 *
 * Cross-reference: every extracted cache key is checked against
 * `api/mcp.ts::TOOL_REGISTRY` `_cacheKeys` / `_coverageKeys` to emit
 * `covered by <toolName>` hints. The hand-maintained
 * `EXECUTE_PASSTHROUGH_FETCHES` map at the top of the file mirrors the
 * `_execute` body fetch URLs in `api/mcp.ts` so passthrough-fetch tools
 * (`get_country_risk`, `get_airspace`, `get_news_intelligence`, ...) get
 * their own coverage hint.
 *
 * Run:
 *   node scripts/audit-mcp-api-coverage.mjs
 *
 * Exits 0 always. Prints a categorized count summary followed by a
 * per-op table grouped by category.
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// -----------------------------------------------------------------------------
// Repo paths
// -----------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const SPECS_DIR = join(REPO_ROOT, 'docs', 'api');
const HANDLERS_ROOT = join(REPO_ROOT, 'server', 'worldmonitor');
const MCP_FILE = join(REPO_ROOT, 'api', 'mcp.ts');

// -----------------------------------------------------------------------------
// HTTP-method allowlist (matches the U1 walker in tests/mcp-api-parity.test.mjs).
// -----------------------------------------------------------------------------

const HTTP_METHODS = new Set([
  'get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'trace',
]);

// -----------------------------------------------------------------------------
// `_execute` passthrough-fetch map — hand-maintained from `api/mcp.ts`.
// Each entry lists the API paths a given MCP tool fetches inside its
// `_execute` body. Regenerate by grepping `api/mcp.ts` for
// `\${base}/api/` callsites and grouping them under each tool's `name`.
// Mirror entries here when a new `_execute` tool is added in `api/mcp.ts`.
// -----------------------------------------------------------------------------

const EXECUTE_PASSTHROUGH_FETCHES = {
  get_world_brief: [
    'GET /api/news/v1/list-feed-digest',
    'POST /api/news/v1/summarize-article',
  ],
  get_country_brief: [
    'GET /api/news/v1/list-feed-digest',
    // NOTE: api/mcp.ts:660 POSTs to this URL even though the OpenAPI spec
    // declares it as GET (IntelligenceService.openapi.json). Listed here
    // as GET to match the live OpenAPI surface — the implementer should
    // reconcile the method drift in a follow-up before locking U3's
    // _apiPaths entry. Either the spec needs `post:` added, or mcp.ts
    // should switch to GET with query params.
    'GET /api/intelligence/v1/get-country-intel-brief',
  ],
  get_country_risk: [
    'GET /api/intelligence/v1/get-country-risk',
  ],
  get_airspace: [
    'GET /api/aviation/v1/track-aircraft',
    'GET /api/military/v1/list-military-flights',
  ],
  get_maritime_activity: [
    'GET /api/maritime/v1/get-vessel-snapshot',
  ],
  analyze_situation: [
    'POST /api/intelligence/v1/deduct-situation',
  ],
  generate_forecasts: [
    'POST /api/forecast/v1/get-forecasts',
  ],
  search_flights: [
    'GET /api/aviation/v1/search-google-flights',
  ],
  search_flight_prices_by_date: [
    'GET /api/aviation/v1/search-google-dates',
  ],
  // `get_news_intelligence` is a cache tool in api/mcp.ts (uses
  // _cacheKeys), NOT an _execute tool. Listed here in plan prose for
  // historical context but covered by the cache-key cross-reference,
  // not by this map.
};

// -----------------------------------------------------------------------------
// OpenAPI walker — same shape as tests/mcp-api-parity.test.mjs::collectApiOperations.
// -----------------------------------------------------------------------------

function loadOpenApiOperations(specsDir) {
  /** @type {Array<{spec:string, method:string, path:string, operationId:string}>} */
  const ops = [];
  const files = readdirSync(specsDir).filter((f) => f.endsWith('.openapi.json'));
  for (const f of files) {
    let spec;
    try {
      spec = JSON.parse(readFileSync(join(specsDir, f), 'utf8'));
    } catch (err) {
      console.warn(`[audit] skipping malformed spec ${f}: ${err.message}`);
      continue;
    }
    const paths = spec?.paths;
    if (!paths || typeof paths !== 'object') continue;
    for (const path of Object.keys(paths)) {
      const pathObj = paths[path];
      if (!pathObj || typeof pathObj !== 'object') continue;
      for (const key of Object.keys(pathObj)) {
        if (!HTTP_METHODS.has(key.toLowerCase())) continue;
        const opMeta = pathObj[key];
        const operationId = (opMeta && typeof opMeta === 'object' && typeof opMeta.operationId === 'string')
          ? opMeta.operationId
          : '';
        ops.push({
          spec: f,
          method: key.toUpperCase(),
          path,
          operationId,
        });
      }
    }
  }
  return ops;
}

// -----------------------------------------------------------------------------
// Spec filename -> (service, version). Strips trailing `Service`, splits any
// `V<N>` suffix into version, kebab-cases the leftover PascalCase service name.
//   `EconomicService.openapi.json`        -> { service: 'economic',        version: 'v1' }
//   `ShippingV2Service.openapi.json`      -> { service: 'shipping',        version: 'v2' }
//   `ConsumerPricesService.openapi.json`  -> { service: 'consumer-prices', version: 'v1' }
// -----------------------------------------------------------------------------

function specFilenameToService(filename) {
  let base = filename.replace(/\.openapi\.json$/i, '');
  if (base.endsWith('Service')) base = base.slice(0, -'Service'.length);
  let version = 'v1';
  const vMatch = base.match(/V(\d+)$/);
  if (vMatch) {
    version = `v${vMatch[1]}`;
    base = base.slice(0, vMatch.index);
  }
  const service = base.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
  return { service, version };
}

// -----------------------------------------------------------------------------
// PascalCase operationId -> camelCase function name (matches the export name
// imported by `server/worldmonitor/<service>/<version>/handler.ts`).
//   `ListInternetDdosAttacks` -> `listInternetDdosAttacks`
//   `GetBisCredit`            -> `getBisCredit`
// -----------------------------------------------------------------------------

function pascalToCamel(s) {
  if (!s) return s;
  return s.charAt(0).toLowerCase() + s.slice(1);
}

// -----------------------------------------------------------------------------
// Parse a handler.ts to build operationId-camelCase -> handler-file-basename.
// Reads every `import { foo } from './bar';` line where the path is local
// (starts with `./`) and stores `foo -> bar`. Used to resolve renamed handler
// files (e.g., `listInternetDdosAttacks` exports from `./list-ddos-attacks`).
// -----------------------------------------------------------------------------

function buildHandlerImportMap(handlerSource) {
  /** @type {Record<string, string>} */
  const map = {};
  // Match `import { name1, name2 as alias, ... } from './basename';`
  // We only care about local relative imports — the handler-file resolution
  // is for files in the same directory as handler.ts.
  const importRe = /import\s*\{([^}]+)\}\s*from\s*['"](\.\/[^'"]+)['"]\s*;?/g;
  let m;
  while ((m = importRe.exec(handlerSource)) !== null) {
    const namesPart = m[1];
    const importPath = m[2]; // e.g. './list-ddos-attacks'
    const basename = importPath.replace(/^\.\//, '');
    const names = namesPart.split(',').map((n) => n.trim()).filter(Boolean);
    for (const name of names) {
      // strip `as alias` — we want the imported name, not the alias
      const baseName = name.split(/\s+as\s+/)[0].trim();
      if (baseName) map[baseName] = basename;
    }
  }
  return map;
}

// -----------------------------------------------------------------------------
// Stage-1 regex: const-name -> literal string.
// Matches  `const NAME = 'literal';`  AND  `const NAME = "literal";`.
// Allows surrounding whitespace and trailing semicolons/commas.
// -----------------------------------------------------------------------------

function extractConstLiterals(source) {
  /** @type {Record<string, string>} */
  const map = {};
  const re = /(?:^|\n|;)\s*(?:export\s+)?const\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(['"])([^'"\n]*)\2/g;
  let m;
  while ((m = re.exec(source)) !== null) {
    map[m[1]] = m[3];
  }
  return map;
}

// -----------------------------------------------------------------------------
// Stage-2 regex: every `getCachedJson(...)` / `getRawJson(...)` /
// `getCachedJsonBatch(...)` callsite. Captures either the literal string
// argument or the identifier name (which we then resolve via the const map
// or via the sibling _shared.ts / constants.ts files).
// -----------------------------------------------------------------------------

function stripComments(source) {
  // Strip block comments /* ... */ and line comments // ... \n.
  // String literals containing comment-like text would be corrupted by this,
  // but the only thing we run on the stripped source is the cache-key
  // arg regex — which targets `(` after specific helper names — so a
  // string literal that happens to read `// foo` won't false-match.
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/[^\n]*/g, '$1');
}

function extractCacheKeyArgs(source) {
  const cleaned = stripComments(source);
  /** @type {Array<{call: string, literal?: string, ident?: string}>} */
  const args = [];
  const callRe = /(getCachedJson|getRawJson|getCachedJsonBatch)\s*\(\s*(?:(['"])([^'"\n]+)\2|([A-Za-z_][A-Za-z0-9_]*))/g;
  let m;
  while ((m = callRe.exec(cleaned)) !== null) {
    if (m[3] !== undefined) args.push({ call: m[1], literal: m[3] });
    else if (m[4] !== undefined) args.push({ call: m[1], ident: m[4] });
  }
  return args;
}

// -----------------------------------------------------------------------------
// Resolve a const identifier by walking shared modules imported from the
// handler's own source. Looks at `./_shared.ts`, `./constants.ts`, and any
// other relative-path imports that resolve to .ts files in the same directory.
//
// Returns the literal string if found, or null.
// -----------------------------------------------------------------------------

function resolveConstViaShared(identifier, handlerSource, handlerDir) {
  // Find every `import { ..., identifier, ... } from './X';` or `from '../../X';`
  // and check that shared file's exported consts. Follows any relative-path
  // import (`./` or `../`) one level deep — sufficient to catch the
  // server/_shared/cache-keys.ts pattern climate handlers use.
  const importRe = /import(?:\s+type)?\s*\{([^}]+)\}\s*from\s*['"](\.[^'"]+)['"]\s*;?/g;
  let m;
  while ((m = importRe.exec(handlerSource)) !== null) {
    const names = m[1].split(',').map((n) => n.split(/\s+as\s+/)[0].trim());
    if (!names.includes(identifier)) continue;
    const importPath = m[2];
    const candidate = resolve(handlerDir, `${importPath}.ts`);
    if (!existsSync(candidate)) continue;
    const sharedSource = readFileSync(candidate, 'utf8');
    const sharedConsts = extractConstLiterals(sharedSource);
    if (sharedConsts[identifier] !== undefined) return sharedConsts[identifier];
  }
  return null;
}

// -----------------------------------------------------------------------------
// Classify a handler by its `server/_shared/redis` import names + detect LLM
// passthrough via `callLlm` import.
// -----------------------------------------------------------------------------

const READ_HELPERS = new Set(['getCachedJson', 'getRawJson', 'getCachedJsonBatch']);
const FETCH_HELPERS = new Set(['cachedFetchJson', 'cachedFetchJsonWithMeta']);
const WRITE_HELPERS = new Set(['setCachedJson', 'deleteRedisKey', 'runRedisPipeline']);

function classifyHandler(source) {
  const annotations = [];
  // Find the redis import line.
  const importRe = /import\s*\{([^}]+)\}\s*from\s*['"][^'"]*_shared\/redis['"]\s*;?/g;
  /** @type {Set<string>} */
  const imported = new Set();
  let m;
  while ((m = importRe.exec(source)) !== null) {
    for (const name of m[1].split(',').map((n) => n.split(/\s+as\s+/)[0].trim())) {
      if (name) imported.add(name);
    }
  }
  // LLM passthrough annotation — imports from `_shared/llm` AND uses any
  // `callLlm*` helper (callLlm, callLlmReasoning, etc.).
  if (/from\s*['"][^'"]*_shared\/llm['"]/.test(source) && /\bcallLlm\w*\b/.test(source)) {
    annotations.push('llm-passthrough');
  }

  let classification = 'unknown';
  const hasFetch = [...imported].some((n) => FETCH_HELPERS.has(n));
  const hasRead = [...imported].some((n) => READ_HELPERS.has(n));
  const hasWrite = [...imported].some((n) => WRITE_HELPERS.has(n));
  if (hasFetch) classification = 'fetch-on-miss';
  else if (hasWrite) classification = 'mutating';
  else if (hasRead) classification = 'pure-read';
  else if (imported.size === 0) classification = 'unknown';
  else classification = 'unknown';

  return { classification, annotations, importedHelpers: imported };
}

// -----------------------------------------------------------------------------
// Extract ALL cache keys read by a handler. Returns deduplicated array of
// literal cache-key strings. Identifiers that cannot be resolved are
// returned with a `<unresolved:NAME>` placeholder so the implementer can
// triage manually.
// -----------------------------------------------------------------------------

function extractCacheKeys(handlerSource, handlerDir) {
  const callsites = extractCacheKeyArgs(handlerSource);
  if (callsites.length === 0) return [];
  const localConsts = extractConstLiterals(handlerSource);
  const out = new Set();
  for (const cs of callsites) {
    if (cs.literal !== undefined) {
      out.add(cs.literal);
      continue;
    }
    const ident = cs.ident;
    if (localConsts[ident] !== undefined) {
      out.add(localConsts[ident]);
      continue;
    }
    const viaShared = resolveConstViaShared(ident, handlerSource, handlerDir);
    if (viaShared !== null) {
      out.add(viaShared);
      continue;
    }
    out.add(`<unresolved:${ident}>`);
  }
  return [...out];
}

// -----------------------------------------------------------------------------
// Parse `api/mcp.ts::TOOL_REGISTRY` for every tool's `_cacheKeys` / `_coverageKeys`.
// Source-level regex — no TypeScript parse — but tolerant of:
//   - multi-line array literals
//   - `// comments` inside the array
//   - dynamic year segments like `${new Date().getUTCFullYear()}` (kept as-is
//     in the cross-reference; the audit's job is hint-emit, not exact match)
// Returns: { [toolName]: string[] } covering both static literals AND the
// surface-form of any template-string keys (template-strings emit the raw
// source line so a human can spot them).
// -----------------------------------------------------------------------------

function loadToolCacheKeys(mcpSource) {
  /** @type {Record<string, string[]>} */
  const out = {};
  // First pass: collect every `name: '<tool>'` occurrence and its source offset.
  const nameMatches = [];
  const nameRe = /\bname:\s*['"]([a-z_][a-z0-9_]*)['"]/g;
  let m;
  while ((m = nameRe.exec(mcpSource)) !== null) {
    nameMatches.push({ name: m[1], index: m.index });
  }
  // Second pass: for each tool, slice the source between this `name:` and the
  // NEXT `name:` (bounded window). Scan for `_cacheKeys` / `_coverageKeys`
  // arrays in that window only — prevents pulling keys from the next tool's
  // entry on a 5000-char overshoot.
  for (let i = 0; i < nameMatches.length; i++) {
    const { name: toolName, index } = nameMatches[i];
    const end = i + 1 < nameMatches.length ? nameMatches[i + 1].index : mcpSource.length;
    const window = mcpSource.slice(index, end);
    const keys = [];
    const keyArrRe = /_(?:cacheKeys|coverageKeys):\s*\[([\s\S]*?)\]/g;
    let am;
    while ((am = keyArrRe.exec(window)) !== null) {
      const body = am[1];
      // Extract literal strings AND template strings (raw, for hint output).
      const litRe = /['"]([^'"]+)['"]|`([^`]+)`/g;
      let lm;
      while ((lm = litRe.exec(body)) !== null) {
        const lit = lm[1] !== undefined ? lm[1] : `\`${lm[2]}\``;
        keys.push(lit);
      }
    }
    if (keys.length > 0) {
      out[toolName] = keys;
    }
  }
  return out;
}

// -----------------------------------------------------------------------------
// Resolve a handler file path from an OpenAPI op via the service's handler.ts
// import map. Returns null if the handler.ts doesn't import the operationId.
// -----------------------------------------------------------------------------

function resolveHandlerFile(service, version, operationId) {
  const handlerDir = join(HANDLERS_ROOT, service, version);
  const handlerTsPath = join(handlerDir, 'handler.ts');
  if (!existsSync(handlerTsPath)) {
    return { error: `handler.ts missing at ${handlerTsPath}` };
  }
  const handlerSource = readFileSync(handlerTsPath, 'utf8');
  const map = buildHandlerImportMap(handlerSource);
  const camelName = pascalToCamel(operationId);
  const basename = map[camelName];
  if (!basename) {
    return { error: `no import for "${camelName}" in ${service}/${version}/handler.ts` };
  }
  const candidate = join(handlerDir, `${basename}.ts`);
  if (!existsSync(candidate)) {
    return { error: `imported file missing: ${candidate}` };
  }
  return {
    handlerDir,
    handlerFile: candidate,
    handlerRelPath: `server/worldmonitor/${service}/${version}/${basename}.ts`,
    importedName: camelName,
  };
}

// -----------------------------------------------------------------------------
// Build the audit report.
// -----------------------------------------------------------------------------

function buildAuditRows() {
  const ops = loadOpenApiOperations(SPECS_DIR);
  const mcpSource = readFileSync(MCP_FILE, 'utf8');
  const toolCacheKeys = loadToolCacheKeys(mcpSource);
  // Inverse index: cacheKey -> [toolName, ...]
  /** @type {Record<string, string[]>} */
  const cacheKeyToTools = {};
  for (const [tool, keys] of Object.entries(toolCacheKeys)) {
    for (const k of keys) {
      if (!cacheKeyToTools[k]) cacheKeyToTools[k] = [];
      cacheKeyToTools[k].push(tool);
    }
  }
  // Inverse index: passthrough-fetch path -> [toolName, ...]
  /** @type {Record<string, string[]>} */
  const passthroughPathToTools = {};
  for (const [tool, paths] of Object.entries(EXECUTE_PASSTHROUGH_FETCHES)) {
    for (const p of paths) {
      if (!passthroughPathToTools[p]) passthroughPathToTools[p] = [];
      passthroughPathToTools[p].push(tool);
    }
  }

  /**
   * @type {Array<{
   *   methodPath: string,
   *   spec: string,
   *   service: string,
   *   version: string,
   *   operationId: string,
   *   handlerRelPath: string,
   *   handlerError: string|null,
   *   classification: string,
   *   annotations: string[],
   *   cacheKeys: string[],
   *   fullyCoveredByCacheKey: string[],
   *   partiallyCoveredByCacheKey: Array<{tool:string, covered:string[], missing:string[]}>,
   *   coveredByPassthrough: string[],
   *   importedHelpers: string[],
   * }>}
   */
  const rows = [];

  for (const op of ops) {
    const { service, version } = specFilenameToService(op.spec);
    const methodPath = `${op.method} ${op.path}`;
    let handlerRelPath = '';
    let handlerError = null;
    let classification = 'unknown';
    let annotations = [];
    let cacheKeys = [];
    let importedHelpers = [];
    if (!op.operationId) {
      handlerError = 'operationId missing in OpenAPI spec';
    } else {
      const resolved = resolveHandlerFile(service, version, op.operationId);
      if (resolved.error) {
        handlerError = resolved.error;
      } else {
        handlerRelPath = resolved.handlerRelPath;
        const src = readFileSync(resolved.handlerFile, 'utf8');
        const c = classifyHandler(src);
        classification = c.classification;
        annotations = c.annotations;
        importedHelpers = [...c.importedHelpers];
        if (classification === 'pure-read' || classification === 'fetch-on-miss') {
          cacheKeys = extractCacheKeys(src, resolved.handlerDir);
        }
      }
    }
    // Cross-reference: which TOOL_REGISTRY tools (if any) cover this op?
    // Distinguish FULL coverage (every handler key is in the tool's _cacheKeys)
    // from PARTIAL overlap (some keys shared, some uncovered). Partial-only
    // overlap is the false-positive trap that originally classified
    // get-gold-intelligence (5 keys, 1 shared with get_market_data) and
    // get-consumer-price-basket-series (parameterized key not in
    // get_consumer_prices) as `covered-via-cache-key`. Surface partial overlap
    // explicitly so the implementer manually decides "extend the tool" vs
    // "exclude as deferred-to-future-tool". See line ~574 categorize() below.
    const fullyCoveredByCacheKey = [];
    /** @type {Array<{tool:string, covered:string[], missing:string[]}>} */
    const partiallyCoveredByCacheKey = [];
    if (cacheKeys.length > 0) {
      // Build per-tool candidate set: any tool whose keys overlap by ≥1 key.
      /** @type {Map<string, string[]>} */
      const candidateTools = new Map();
      for (const k of cacheKeys) {
        const tools = cacheKeyToTools[k];
        if (!tools) continue;
        for (const t of tools) {
          if (!candidateTools.has(t)) candidateTools.set(t, []);
        }
      }
      // For each candidate tool, partition the handler's cache keys into
      // (covered, missing) sets and classify the relationship.
      for (const tool of candidateTools.keys()) {
        const toolKeys = new Set(toolCacheKeys[tool] ?? []);
        const covered = cacheKeys.filter((k) => toolKeys.has(k));
        const missing = cacheKeys.filter((k) => !toolKeys.has(k));
        if (missing.length === 0 && covered.length > 0) {
          fullyCoveredByCacheKey.push(tool);
        } else if (covered.length > 0) {
          partiallyCoveredByCacheKey.push({ tool, covered, missing });
        }
      }
    }
    const coveredByPassthrough = passthroughPathToTools[methodPath] ?? [];

    rows.push({
      methodPath,
      spec: op.spec,
      service,
      version,
      operationId: op.operationId,
      handlerRelPath,
      handlerError,
      classification,
      annotations,
      cacheKeys,
      fullyCoveredByCacheKey,
      partiallyCoveredByCacheKey,
      coveredByPassthrough,
      importedHelpers,
    });
  }
  return rows;
}

// -----------------------------------------------------------------------------
// Categorize rows for the summary report.
// Category precedence (highest priority first; one bucket per row):
//   covered-via-_execute      (passthrough hint exists)
//   covered-via-cache-key     (any cache key matched a tool's _cacheKeys)
//   llm-passthrough           (classification != mutating AND callLlm import)
//   mutating                  (writes redis/state)
//   fetch-on-miss             (cachedFetchJson*, not LLM, not covered)
//   partial-cache-key-overlap (handler reads >=1 key in some tool AND >=1 key
//                              NOT in that tool — implementer MUST decide:
//                              extend the tool's _cacheKeys vs exclude as
//                              deferred-to-future-tool. NEVER auto-claim
//                              coverage here — that's the false-positive trap
//                              that originally mis-classified gold-intelligence
//                              and consumer-price-basket-series.)
//   manual-mapping            (pure-read with computed key but no tool match)
//   deferred-to-future-tool   (pure-read, key not in any tool's _cacheKeys)
//   admin                     (placeholder bucket — current audit emits zero)
//   unknown                   (no helper imports OR handler resolution failed)
// -----------------------------------------------------------------------------

// CASCADE_MIRROR_EXEMPT — METHOD-path entries where partial-cache-key-overlap
// is the intentional steady-state, not a coverage gap. The API handler reads
// multiple cascade-mirror variants (live + stale + backup) of the same canonical
// payload; the MCP tool reads ONE variant (typically stale). PR #3658's U7
// EXCLUDED_FROM_MCP documents the live + backup keys as cascade-mirror siblings,
// so the data IS structurally served — just at slightly different freshness.
// Without this exemption the audit would keep flagging known-equivalent
// coverage as partial-overlap each time someone re-runs it as `_apiPaths` seed
// input.
const CASCADE_MIRROR_EXEMPT = new Set([
  'GET /api/military/v1/get-theater-posture',
]);

function categorize(row) {
  if (row.handlerError && row.classification === 'unknown'
      && row.coveredByPassthrough.length === 0
      && row.fullyCoveredByCacheKey.length === 0
      && row.partiallyCoveredByCacheKey.length === 0) {
    return 'unknown';
  }
  if (row.coveredByPassthrough.length > 0) return 'covered-via-_execute';
  if (row.fullyCoveredByCacheKey.length > 0) return 'covered-via-cache-key';
  // Cascade-mirror exemption: re-route to `covered-via-cache-key` so future
  // implementers don't keep manually triaging these as partial-overlap.
  // The CASCADE_MIRROR_EXEMPT set is the audit-author's contract that the
  // tool's stale-variant read is structurally equivalent to the API's
  // live+stale+backup cascade fallback. Documented inline at the tool's
  // _apiPaths declaration in api/mcp.ts.
  if (row.partiallyCoveredByCacheKey.length > 0 && CASCADE_MIRROR_EXEMPT.has(row.methodPath)) {
    return 'covered-via-cache-key';
  }
  // Structural-classification categories run BEFORE the pure-read partial-
  // overlap check. A fetch-on-miss / mutating / llm-passthrough handler that
  // happens to share a cache key with some tool is NOT a coverage gap — the
  // handler's structural shape is the dominant signal. Routing those into
  // partial-cache-key-overlap would disagree with the parity test, which
  // correctly bucketizes them as fetch-on-miss / mutating / llm-passthrough.
  if (row.annotations.includes('llm-passthrough') && row.classification !== 'mutating') {
    return 'llm-passthrough';
  }
  if (row.classification === 'mutating') return 'mutating';
  if (row.classification === 'fetch-on-miss') return 'fetch-on-miss';
  // Partial overlap (pure-read only): at least one shared key but the handler
  // ALSO reads keys not in any candidate tool. Surface as a distinct category
  // so the implementer treats it as "decide" not "covered". The per-tool
  // hint output lists exactly which keys are covered vs missing.
  if (row.partiallyCoveredByCacheKey.length > 0 && row.classification === 'pure-read') {
    return 'partial-cache-key-overlap';
  }
  if (row.classification === 'pure-read') {
    // pure-read but no cache-key match. Distinguish:
    //   - "manual-mapping" if it has a computed/unresolved key (parameterised)
    //   - "deferred-to-future-tool" if it has a literal key with no covering tool
    const hasUnresolved = row.cacheKeys.some((k) => k.startsWith('<unresolved:'));
    if (hasUnresolved) return 'manual-mapping';
    return 'deferred-to-future-tool';
  }
  return 'unknown';
}

// -----------------------------------------------------------------------------
// Pretty-print the report.
// -----------------------------------------------------------------------------

const CATEGORY_ORDER = [
  'covered-via-cache-key',
  'covered-via-_execute',
  'partial-cache-key-overlap',
  'fetch-on-miss',
  'mutating',
  'llm-passthrough',
  'admin',
  'manual-mapping',
  'deferred-to-future-tool',
  'unknown',
];

const CATEGORY_BLURB = {
  'covered-via-cache-key':    'fully mapped: every handler cache key is in some tool\'s _cacheKeys',
  'covered-via-_execute':     'existing _execute tools via passthrough fetch',
  'partial-cache-key-overlap':'handler shares ≥1 key with some tool BUT also reads uncovered keys — implementer decides extend vs defer',
  'fetch-on-miss':            'cachedFetchJson handlers — candidates for fetch-on-miss exclusion',
  'mutating':                 'write/delete handlers',
  'llm-passthrough':          'handlers importing callLlm — exclude from MCP',
  'admin':                    'admin/internal-only endpoints (none expected in current OpenAPI surface)',
  'manual-mapping':           'pure-read with computed/parameterized key — implementer triages',
  'deferred-to-future-tool':  'pure-read, key not in any tool\'s _cacheKeys yet',
  'unknown':                  'no redis helper imports found — manual triage required',
};

function fmtHint(row) {
  const hints = [];
  for (const t of row.coveredByPassthrough) hints.push(`covered by ${t} via _execute passthrough`);
  for (const t of row.fullyCoveredByCacheKey) hints.push(`fully covered by ${t}`);
  for (const p of row.partiallyCoveredByCacheKey) {
    hints.push(`partial overlap with ${p.tool}: covered=[${p.covered.join(',')}] missing=[${p.missing.join(',')}]`);
  }
  if (row.annotations.length > 0) hints.push(`annot:${row.annotations.join(',')}`);
  if (row.handlerError) hints.push(`ERR:${row.handlerError}`);
  return hints.join(' | ');
}

function printReport(rows) {
  /** @type {Record<string, typeof rows>} */
  const grouped = {};
  for (const c of CATEGORY_ORDER) grouped[c] = [];
  for (const row of rows) {
    const cat = categorize(row);
    grouped[cat].push(row);
  }

  const total = rows.length;
  console.log(`[mcp-api-parity audit] ${total} ops total`);
  for (const cat of CATEGORY_ORDER) {
    const count = grouped[cat].length;
    const padLabel = `${cat}:`.padEnd(26, ' ');
    const blurb = CATEGORY_BLURB[cat];
    console.log(`  ${padLabel}${String(count).padStart(3)}   (${blurb})`);
  }
  console.log('');

  for (const cat of CATEGORY_ORDER) {
    const groupRows = grouped[cat];
    if (groupRows.length === 0) continue;
    console.log('');
    console.log(`=== ${cat} (${groupRows.length}) ===`);
    // Sort within category by method+path for stable diffing.
    groupRows.sort((a, b) => a.methodPath.localeCompare(b.methodPath));
    for (const row of groupRows) {
      const handlerCol = row.handlerRelPath || `<unresolved: ${row.spec}>`;
      const keysCol = row.cacheKeys.length > 0 ? row.cacheKeys.join(',') : '-';
      const hintCol = fmtHint(row) || '-';
      console.log(`  ${row.methodPath}`);
      console.log(`    handler:   ${handlerCol}`);
      console.log(`    classify:  ${row.classification}${row.annotations.length ? ` [${row.annotations.join(',')}]` : ''}`);
      console.log(`    cacheKeys: ${keysCol}`);
      console.log(`    hint:      ${hintCol}`);
    }
  }
}

// -----------------------------------------------------------------------------
// Main
// -----------------------------------------------------------------------------

function main() {
  const rows = buildAuditRows();
  printReport(rows);
  process.exit(0);
}

main();
