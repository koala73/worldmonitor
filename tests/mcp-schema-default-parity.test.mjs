import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const MCP_SRC = readFileSync(resolve(HERE, '../api/mcp.ts'), 'utf8');

/**
 * MCP schema-vs-behaviour parity test.
 *
 * Prevents the "advertised default not enforced" bug class — the exact
 * shape that broke `search_flights` (description said `(optional, default
 * economy)` but the `_execute` used `...(params.cabin_class ? {...} : {})`
 * so the LLM-default flow never sent `cabin_class`, and the upstream
 * relay returned 0 flights).
 *
 * Two checks:
 *   1. RPC tools — for every input property whose description contains
 *      "default", the `_execute` function source MUST NOT contain the
 *      conditional-spread anti-pattern `...(params.<key> ? { <key>: ... } : {})`.
 *      Acceptable patterns: `<key>: String(params.<key> ?? <default>)` or
 *      bare `params.<key> ?? <default>` (nullish-coalescing default).
 *   2. Cache tools — for every `limit: default 30` claim, the `_postFilter`
 *      source MUST reference `DEFAULT_LIST_LIMIT` (the centrally-applied
 *      cap from v1.3.0 / issue #3678).
 *
 * Both checks operate on `Function.prototype.toString()` which preserves
 * the source under tsx/Node ESM. If a future build step minifies before
 * tests, this check needs reworking — but we run tests against source.
 */

const VALID_KEY = 'wm_test_key_123';
process.env.WORLDMONITOR_VALID_KEYS = VALID_KEY;
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;

const mod = await import('../api/mcp.ts');

/**
 * The anti-pattern: `...(params.<key> ? { <key>: <expr> } : {})`. Matches:
 *   - any whitespace
 *   - allows the captured key to be repeated literally
 *   - tolerates `String(params.<key>)` inside the `{ <key>: ... }` block
 *
 * The matcher is intentionally specific so it doesn't false-positive on
 * `String(params.<key> ?? '<default>')` (the GOOD pattern).
 */
function badConditionalSpread(src, key) {
  // Escape regex specials in key (just in case; keys are usually plain idents).
  const esc = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\.\\.\\.\\s*\\(\\s*params\\.${esc}\\b\\s*\\?\\s*\\{\\s*${esc}\\s*:`).test(src);
}

/**
 * Extract default-claim text from a description, if any. We're permissive
 * about the phrasing (`(default X)`, `default X)`, `default X,`, etc.)
 * because tool descriptions are written in prose, not in a schema DSL.
 */
function descriptionClaimsDefault(desc) {
  if (typeof desc !== 'string') return false;
  // Ignore claims like "(optional)" alone, or comparator phrases like "default
  // sorts by date" — we want the `default <value>` pattern.
  return /\bdefault\b/i.test(desc);
}

describe('MCP schema-vs-behaviour parity (regression guard)', () => {
  // Sanity check first — the matcher must catch the actual flight-bug shape.
  describe('matcher self-check', () => {
    it('badConditionalSpread MATCHES the flight-bug shape', () => {
      const flightBugSrc = `async (params) => { const qs = new URLSearchParams({ origin: 'JFK', ...(params.cabin_class ? { cabin_class: String(params.cabin_class) } : {}) }); }`;
      assert.ok(badConditionalSpread(flightBugSrc, 'cabin_class'),
        'matcher failed to detect the exact pattern from the search_flights bug');
    });

    it('badConditionalSpread does NOT match the FIX shape', () => {
      const fixedSrc = `async (params) => { const qs = new URLSearchParams({ origin: 'JFK', cabin_class: String(params.cabin_class ?? 'economy') }); }`;
      assert.ok(!badConditionalSpread(fixedSrc, 'cabin_class'),
        'matcher false-positive on the corrected nullish-coalescing pattern');
    });

    it('badConditionalSpread does NOT match a different key', () => {
      const src = `...(params.return_date ? { return_date: String(params.return_date) } : {})`;
      assert.ok(!badConditionalSpread(src, 'cabin_class'),
        'matcher should be key-scoped, not match any conditional spread');
    });
  });

  describe('RPC tools — no conditional-spread on default-claimed properties', () => {
    const rpcTools = (mod.default && []) || []; // dummy to keep linter quiet
    // Use the exported registry via the module's TOOL_LIST_RESPONSE wire shape
    // isn't enough — we need _execute source. Reach into TOOL_REGISTRY via the
    // generated tools/list call to enumerate tool NAMES, then look up each
    // tool object via the registry directly. The registry isn't exported, so
    // we use mcpHandler's tools/list response for the name list and then
    // for each name, dig out the _execute function via a wrapper.
    //
    // Simpler: TOOL_REGISTRY is module-internal. Use the test-only re-export
    // pattern — assert via the public-shape inputSchema descriptions, but
    // pair each one against a behaviour assertion. To inspect _execute
    // source we DO need access. Since the registry isn't exported, we add
    // it via dynamic require of the module's internals. As a pragmatic
    // workaround, this test enumerates expected tool names hard-coded
    // against the snapshot and asserts each.
    //
    // CLEANER FIX (followup): export TOOL_REGISTRY behind a __TESTING__
    // namespace so this test doesn't need a hard-coded name list.

    it('flight tools — positive assertion that the cabin_class fix shape is present', () => {
      // Belt-and-braces alongside the source-wide audit. If a future PR
      // accidentally reverts the flight fix (or someone deletes the
      // _execute entirely), the negative-only check could still pass —
      // this positive check ensures the fix shape is actually emitted.
      const fixShape = /cabin_class:\s*String\(params\.cabin_class\s*\?\?\s*'economy'\)/g;
      const matches = MCP_SRC.match(fixShape) ?? [];
      assert.equal(matches.length, 2,
        `Expected exactly 2 occurrences of the cabin_class fix shape ` +
        `(search_flights + search_flight_prices_by_date), found ${matches.length}. ` +
        `If you reverted the flight fix, you also need to update or remove this test.`);
    });

    it('source-wide audit — no tool _execute body uses ...(params.<key> ? { <key>: ... } : {}) for any key whose description claims "default"', () => {
      // Source-text audit. Imperfect (description and _execute are read in
      // different ways) but it catches the exact bug shape without needing
      // a __TESTING__ export.
      const src = MCP_SRC;
      // Split on top-level tool blocks (each begins with `{ name: '<name>'`).
      const tools = src.split(/(?=\n\s{2}\{\s*\n\s+name:\s+'[a-z_]+')/);
      const violations = [];
      for (const block of tools) {
        const nameMatch = block.match(/^\s*\{\s*\n?\s*name:\s+'([a-z_]+)'/);
        if (!nameMatch) continue;
        const name = nameMatch[1];
        // For each property line `<key>: { type: ..., description: '...default...' }`
        // capture the key + description.
        const propRe = /^\s+([a-z_]+):\s*\{\s*type:\s*'[a-z]+',\s*(?:enum:\s*\[[^\]]+\],\s*)?description:\s*'([^']*)'/gm;
        let m;
        while ((m = propRe.exec(block)) !== null) {
          const key = m[1];
          const desc = m[2];
          if (!descriptionClaimsDefault(desc)) continue;
          if (key === 'limit') continue; // cache-tool limit handled separately
          if (badConditionalSpread(block, key)) {
            violations.push(`${name}.${key}: description "${desc}" claims a default but _execute uses the conditional-spread anti-pattern`);
          }
        }
      }
      assert.equal(violations.length, 0,
        `Found ${violations.length} schema-vs-behaviour mismatches:\n  - ${violations.join('\n  - ')}`);
    });
  });

  describe('cache tools — limit:default 30 is enforced via DEFAULT_LIST_LIMIT', () => {
    it('every "limit: default 30" claim has a corresponding DEFAULT_LIST_LIMIT use in the same tool block', () => {
      const src = MCP_SRC;
      const tools = src.split(/(?=\n\s{2}\{\s*\n\s+name:\s+'[a-z_]+')/);
      const violations = [];
      for (const block of tools) {
        const nameMatch = block.match(/^\s*\{\s*\n?\s*name:\s+'([a-z_]+)'/);
        if (!nameMatch) continue;
        const name = nameMatch[1];
        // Cache tool with `limit:default 30` claim?
        if (!/limit:\s*\{[^}]*default 30/.test(block)) continue;
        // Must reference DEFAULT_LIST_LIMIT somewhere in the block (typically
        // inside the _postFilter body).
        if (!/DEFAULT_LIST_LIMIT/.test(block)) {
          violations.push(`${name}: claims "limit: default 30" but block contains no DEFAULT_LIST_LIMIT reference`);
        }
      }
      assert.equal(violations.length, 0,
        `Found ${violations.length} cache-tool limit-default mismatches:\n  - ${violations.join('\n  - ')}`);
    });
  });
});
