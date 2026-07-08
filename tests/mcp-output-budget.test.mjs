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
// Coverage caveat: only 3/40 tools have captured fixtures today
// (`tests/fixtures/jmespath-samples/`). Each new fixture added there will be
// picked up by this test the next CI run. Mocked-response contract coverage
// for the other tools is a separate follow-up.
//
// `KNOWN_OVER_BUDGET` (in `tests/helpers/mcp-output-budget.mjs`) documents
// tools that currently exceed their declared budget on default args. The
// `tests/helpers/mcp-output-budget.mjs` module is the single source of truth
// — `scripts/mcp-budget-check.mjs` shares the same map and applies the same
// gating semantics, so the two cannot drift.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  FIXTURES,
  KNOWN_OVER_BUDGET,
  runBudgetChecks,
} from './helpers/mcp-output-budget.mjs';

describe('api/mcp.ts — per-tool output byte-budget regression (v1.7.0)', () => {
  const { rows, deadEntries } = runBudgetChecks();
  const rowByTool = new Map(rows.map((r) => [r.tool, r]));

  // Dead-entry guard: a KNOWN_OVER_BUDGET name that doesn't appear in
  // FIXTURES is unfalsifiable and must be removed. (Future fixture additions
  // will include a paired KNOWN_OVER_BUDGET entry if needed — this prevents
  // adding the exclusion alone.)
  it('every KNOWN_OVER_BUDGET entry names a tool with a fixture in this suite', () => {
    assert.deepEqual(
      deadEntries,
      [],
      `KNOWN_OVER_BUDGET names tools without a fixture: ${deadEntries.join(', ')}`,
    );
  });

  for (const { file, tool: toolName } of FIXTURES) {
    it(`${toolName}: default-args response stays under _outputBudgetBytes (${file})`, () => {
      const row = rowByTool.get(toolName);
      assert.ok(row, `no row produced for ${toolName}`);

      switch (row.status) {
        case 'ok':
          return;
        case 'missing-tool':
          assert.fail(`tool ${toolName} not found in TOOL_REGISTRY`);
          break;
        case 'missing-file':
          assert.fail(`fixture ${file} missing: ${row.error}`);
          break;
        case 'over':
          assert.fail(
            `${toolName}: observed=${row.observed} bytes, budget=${row.budget} bytes, over by ${row.observed - row.budget} bytes (fixture: ${file})`,
          );
          break;
        case 'known-over':
          // Allowed — surface the documented reason so a dev running the
          // suite locally sees the known-issue context.
          process.stderr.write(
            `[mcp-output-budget] KNOWN over-budget: ${toolName} observed=${row.observed} budget=${row.budget} delta=+${row.observed - row.budget}B — ${KNOWN_OVER_BUDGET.get(toolName)}\n`,
          );
          return;
        case 'stale':
          assert.fail(
            `${toolName}: observed=${row.observed} bytes, budget=${row.budget} bytes (UNDER by ${row.budget - row.observed}). KNOWN_OVER_BUDGET entry is now stale — delete it from tests/helpers/mcp-output-budget.mjs so the standard over-budget assertion gates this tool again.`,
          );
          break;
        default:
          assert.fail(`unknown status: ${row.status}`);
      }
    });
  }
});
