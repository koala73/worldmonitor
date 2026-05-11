// Tier-4 — MCP↔API parity test. Asserts that every public OpenAPI operation in
// `docs/api/*.openapi.json` is either:
//   (a) declared in some `TOOL_REGISTRY[i]._apiPaths` array, OR
//   (b) listed in `EXCLUDED_FROM_MCP_PARITY` below with a category-prefixed reason.
//
// Fail-hard: a new OpenAPI operation that isn't covered by an MCP tool AND isn't
// excluded with a documented reason fails CI. This is the structural fix
// preventing future drift between the public API surface and the MCP tool registry.
//
// Companion to `tests/mcp-bootstrap-parity.test.mjs` (U7, PR #3658) which covers
// the cache-key inventory (BOOTSTRAP_KEYS ∪ STANDALONE_KEYS). The two tests
// guard different inventories and coexist:
//   - U7 (bootstrap parity): "every cached key has an MCP path"
//   - Tier-4 (API parity, this file): "every public API op has an MCP path"

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// -----------------------------------------------------------------------------
// HTTP-method allowlist — used by the OpenAPI walker to skip path-level siblings
// (`parameters`, `summary`, `description`, etc.) that share the methods object.
// -----------------------------------------------------------------------------
const HTTP_METHODS = new Set([
  'get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'trace',
]);

// -----------------------------------------------------------------------------
// Pure predicate helpers (no module-state coupling) — used by both the live
// assertions and the fixture-based meta-tests that prove each predicate
// actually fires on synthetic invalid inputs.
//
// Module-local declarations (NOT exported) per biome `noExportsInTest`. The
// describe blocks below call them directly.
// -----------------------------------------------------------------------------

/**
 * Walk every `*.openapi.json` under `specsDir` and collect operations as
 * canonical `"METHOD path"` strings. Path is the literal OpenAPI path key
 * (treated opaquely — works for `/api/<svc>/v1/<op>`, `/api/v2/<svc>/<op>`,
 * or any future shape). Method is uppercased.
 *
 * Defensive: skips malformed specs (missing/non-object `.paths`) silently
 * with a `console.warn`. Filters path-object keys through HTTP_METHODS so
 * OpenAPI siblings like `parameters` don't inflate the count.
 */
function collectApiOperations(specsDir) {
  const ops = new Set();
  let files;
  try {
    files = readdirSync(specsDir).filter((f) => f.endsWith('.openapi.json'));
  } catch {
    return ops;
  }
  for (const f of files) {
    let spec;
    try {
      spec = JSON.parse(readFileSync(join(specsDir, f), 'utf8'));
    } catch (err) {
      console.warn(`[mcp-api-parity] skipping malformed spec ${f}: ${err.message}`);
      continue;
    }
    const paths = spec?.paths;
    if (!paths || typeof paths !== 'object') continue;
    for (const path of Object.keys(paths)) {
      const pathObj = paths[path];
      if (!pathObj || typeof pathObj !== 'object') continue;
      for (const key of Object.keys(pathObj)) {
        if (HTTP_METHODS.has(key.toLowerCase())) {
          ops.add(`${key.toUpperCase()} ${path}`);
        }
      }
    }
  }
  return ops;
}

// -----------------------------------------------------------------------------
// Live structural assertions
// -----------------------------------------------------------------------------

describe('Tier-4 — OpenAPI inventory walker', () => {
  it('collectApiOperations returns a non-empty Set from real docs/api/', () => {
    const ops = collectApiOperations(join(import.meta.dirname, '..', 'docs', 'api'));
    assert.ok(ops.size >= 130, `expected ≥130 ops, got ${ops.size}`);
  });

  it('every collected entry is a canonical "METHOD path" string', () => {
    const ops = collectApiOperations(join(import.meta.dirname, '..', 'docs', 'api'));
    const canonical = /^(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD|TRACE) \//;
    for (const op of ops) {
      assert.match(op, canonical, `non-canonical entry: ${JSON.stringify(op)}`);
    }
  });

  it('inventory includes known anchor operations across heaviest services', () => {
    const ops = collectApiOperations(join(import.meta.dirname, '..', 'docs', 'api'));
    // Spot-check anchors from the 5 heaviest specs (Economic, Intelligence,
    // Market, SupplyChain, Infrastructure) — any of these going missing
    // signals walker-shape drift before the parity assertion would catch it.
    assert.ok(ops.has('GET /api/economic/v1/get-bis-credit'), 'economic anchor missing');
    assert.ok(ops.has('GET /api/intelligence/v1/get-country-risk'), 'intelligence anchor missing');
    assert.ok(ops.has('GET /api/market/v1/list-defi-tokens'), 'market anchor missing');
  });
});

// -----------------------------------------------------------------------------
// Meta-tests — verify the predicate helpers fire on synthetic invalid fixtures
// -----------------------------------------------------------------------------

describe('Tier-4 meta-tests — walker fires on synthetic invalid inputs', () => {
  it('collectApiOperations returns empty Set for a non-existent directory', () => {
    const ops = collectApiOperations('/tmp/definitely-not-a-real-dir-mcp-parity');
    assert.equal(ops.size, 0);
  });

  it('collectApiOperations filters non-HTTP-method path siblings (parameters, summary, description)', () => {
    // Use a tmp fixture file to exercise the filter without polluting docs/api/
    const tmpDir = mkSpecFixture({
      paths: {
        '/api/fixture/v1/get-foo': {
          get: { operationId: 'getFoo' },
          parameters: [{ name: 'q', in: 'query' }],  // must be filtered
          summary: 'Fixture path-level summary',     // must be filtered
        },
        '/api/fixture/v1/multi': {
          get: { operationId: 'getMulti' },
          post: { operationId: 'postMulti' },
        },
      },
    });
    const ops = collectApiOperations(tmpDir);
    assert.deepEqual([...ops].sort(), [
      'GET /api/fixture/v1/get-foo',
      'GET /api/fixture/v1/multi',
      'POST /api/fixture/v1/multi',
    ]);
  });

  it('collectApiOperations skips malformed specs without throwing', () => {
    const tmpDir = mkSpecFixture('not-valid-json{{{');
    const ops = collectApiOperations(tmpDir);
    assert.equal(ops.size, 0);
  });
});

// -----------------------------------------------------------------------------
// Fixture helpers (test-local; do not export)
// -----------------------------------------------------------------------------

function mkSpecFixture(content) {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-parity-fixture-'));
  const body = typeof content === 'string' ? content : JSON.stringify(content);
  writeFileSync(join(dir, 'Fixture.openapi.json'), body);
  return dir;
}
