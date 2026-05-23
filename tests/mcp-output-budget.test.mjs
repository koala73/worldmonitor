// Per-tool output byte-budget regression test (v1.7.0).
//
// Mirrors the runtime byte-accounting gate in `dispatchToolsCall`
// (`api/mcp.ts` — search `textBytes > budget`):
//
//   fixture.data
//     → tool._postFilter(structuredClone(fixture.data), {})   // skipped if no _postFilter
//     → { cached_at, stale, data: filtered }                  // reassembled envelope
//     → JSON.stringify(envelope)
//     → utf8ByteLength(...)
//
// One test case per fixture-tool pair, so a failure names the offending tool
// directly. Assertion: `observed <= tool._outputBudgetBytes`. The failure
// message includes tool name, observed bytes, budget bytes, and the delta so
// the dev sees immediately how far over they are.
//
// Default-args identity path only: no JMESPath projection, no `summary: true`.
// This is the upper-bound path the per-tool budgets are sized for — a JMESPath
// or summary call shrinks the response further, so testing the unprojected
// path is the bound the runtime gate cares about.
//
// Coverage caveat: only 3/39 tools have captured fixtures today
// (`tests/fixtures/jmespath-samples/`). Each new fixture added there will be
// picked up by this test the next CI run. Mocked-response contract coverage
// for the other tools is a separate follow-up.
//
// `KNOWN_OVER_BUDGET` documents tools that currently exceed their declared
// budget on default args. Each entry is a known-issue exception with a
// recorded reason and a deletion criterion. The exclusion is itself
// regression-signal: a NEW over-budget tool (not in the map) fails the test;
// an exclusion that becomes obsolete (tool now under budget) ALSO fails so
// the entry can't go stale and mask a future regression.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { __testing__, utf8ByteLength } from '../api/mcp.ts';

const FIXTURES_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'jmespath-samples',
);

// Kept in lockstep with `tests/mcp-output-schema-coverage.test.mjs` and
// `scripts/mcp-budget-check.mjs`. Three rows — duplicating is cheaper than
// threading a shared module just for this.
const FIXTURES = [
  { file: 'fat-get-market-data.response.json', tool: 'get_market_data' },
  { file: 'medium-get-conflict-events.response.json', tool: 'get_conflict_events' },
  { file: 'thin-get-chokepoint-status.response.json', tool: 'get_chokepoint_status' },
];

// Tools whose default-args envelope is currently over its declared
// `_outputBudgetBytes` and which the runtime gate is therefore already
// rejecting in production with the `_budget_exceeded` envelope. Each entry
// MUST be deleted once the underlying tool is brought back under budget,
// otherwise the exclusion masks future regressions (the test guards both
// directions — see `KNOWN_OVER_BUDGET entry is now stale` below).
//
// Keep in sync with the same const in `scripts/mcp-budget-check.mjs`.
const KNOWN_OVER_BUDGET = new Map([
  ['get_market_data',
    'commodities-bootstrap ships 30 quotes per the universal default `limit` — that single key alone is ~133 KB, more than the entire 128 KB budget. Default-args calls currently return the runtime `_budget_exceeded` envelope. Delete this entry once the per-key default cap is tightened (or the per-tool budget raised with justification) so the envelope fits under budget.'],
]);

describe('api/mcp.ts — per-tool output byte-budget regression (v1.7.0)', () => {
  // Dead-entry guard: a KNOWN_OVER_BUDGET name that doesn't appear in
  // FIXTURES can't be measured, so the exclusion is unfalsifiable and must
  // be removed. (When a new fixture is added in the future and exposes a
  // genuine over-budget tool, the dev will add both the fixture AND a
  // KNOWN_OVER_BUDGET entry — this guard prevents adding the entry alone.)
  it('every KNOWN_OVER_BUDGET entry names a tool with a fixture in this file', () => {
    const fixtureTools = new Set(FIXTURES.map((f) => f.tool));
    const dead = [...KNOWN_OVER_BUDGET.keys()].filter((name) => !fixtureTools.has(name));
    assert.deepEqual(dead, [], `KNOWN_OVER_BUDGET names tools without a fixture: ${dead.join(', ')}`);
  });

  for (const { file, tool: toolName } of FIXTURES) {
    it(`${toolName}: default-args response stays under _outputBudgetBytes (${file})`, () => {
      const tool = __testing__.TOOL_REGISTRY.find((t) => t.name === toolName);
      assert.ok(tool, `tool ${toolName} not found in TOOL_REGISTRY`);

      const fixture = JSON.parse(readFileSync(path.join(FIXTURES_DIR, file), 'utf8'));
      const filtered = tool._postFilter
        ? tool._postFilter(structuredClone(fixture.data), {})
        : fixture.data;
      const envelope = { cached_at: fixture.cached_at, stale: fixture.stale, data: filtered };
      const observed = utf8ByteLength(JSON.stringify(envelope));
      const budget = tool._outputBudgetBytes;
      const delta = observed - budget;

      if (KNOWN_OVER_BUDGET.has(toolName)) {
        // Expected over-budget. If the observation is now under budget, the
        // entry is stale and must be removed — otherwise the exclusion
        // would silently absorb a future regression.
        assert.ok(
          delta > 0,
          `${toolName}: observed=${observed} bytes, budget=${budget} bytes (UNDER by ${-delta}). KNOWN_OVER_BUDGET entry is now stale — delete it from this file so the standard over-budget assertion gates this tool again.`,
        );
        // Still over, as expected. Surface the known-issue context so a dev
        // running the suite locally sees why it's allowed.
        process.stderr.write(
          `[mcp-output-budget] KNOWN over-budget: ${toolName} observed=${observed} budget=${budget} delta=+${delta}B — ${KNOWN_OVER_BUDGET.get(toolName)}\n`,
        );
        return;
      }

      assert.ok(
        delta <= 0,
        `${toolName}: observed=${observed} bytes, budget=${budget} bytes, over by ${delta} bytes (fixture: ${file})`,
      );
    });
  }
});
