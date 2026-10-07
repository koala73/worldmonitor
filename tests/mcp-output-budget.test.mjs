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
// Coverage caveat: only 3/42 tools have captured fixtures today
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
import { isOrdinaryMarketDefault, presentDefaultMarketData } from '../api/mcp/registry/cache-tools.ts';

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

describe('ordinary market response presentation', () => {
  const budget = 131072;
  const bytes = value => Buffer.byteLength(JSON.stringify(value));
  it('limits fitting to ordinary defaults, including normalized empty filters', () => {
    for (const args of [{}, { symbols: [], asset_class: [] }, { symbols: [' '] }]) assert.equal(isOrdinaryMarketDefault(args), true);
    for (const args of [{ limit: 30 }, { summary: false }, { jmespath: '' }, { refresh: false }, { request_id: '' }, { panel_request: '' }, { symbols: ['AAPL'] }, { asset_class: ['equity'] }]) assert.equal(isOrdinaryMarketDefault(args), false);
  });
  it('skips a giant row while preserving later whole rows, full series and immutable source metadata', () => {
    const retained = { symbol: 'SMALL', sparkline: [1, 2, 3], label: 'é\\"' };
    const input = { panelRequest: { token: 'receipt' }, data: {
      'stocks-bootstrap': { asOf: 'source-clock', quotes: [{ symbol: 'GIANT', name: 'x'.repeat(budget) }, retained] },
      'commodities-bootstrap': { quotes: [{ symbol: 'GOLD', sparkline: [4, 5, 6] }] },
      physical: { untouched: [1, 2, 3] },
    } };
    const original = structuredClone(input);
    const output = presentDefaultMarketData(input, budget);
    assert.ok(bytes(output) <= budget);
    assert.deepEqual(output.data['stocks-bootstrap'].quotes, [retained]);
    assert.deepEqual(output.data['commodities-bootstrap'], input.data['commodities-bootstrap']);
    assert.deepEqual(output.data.physical, input.data.physical);
    assert.equal(output.data['stocks-bootstrap'].asOf, 'source-clock');
    assert.deepEqual(output.panelRequest, input.panelRequest);
    assert.deepEqual(output.transportCoverage.collections['stocks-bootstrap.quotes'], { state: 'available', original_count: 2, returned_count: 1, omitted_count: 1, omission_reason: 'output_budget' });
    assert.deepEqual(input, original);
  });
  it('reports a feasible but skewed allocation without claiming every class fits', () => {
    const input = { data: { 'stocks-bootstrap': { quotes: [{ symbol: 'LARGE', name: 'x'.repeat(120000) }] }, 'commodities-bootstrap': { quotes: [{ symbol: 'GOLD', name: 'x'.repeat(20000) }] } } };
    const output = presentDefaultMarketData(input, budget);
    assert.equal(output.data['stocks-bootstrap'].quotes.length, 1);
    assert.equal(output.data['commodities-bootstrap'].quotes.length, 0);
    assert.equal(output.transportCoverage.collections['commodities-bootstrap.quotes'].omission_reason, 'output_budget');
    assert.ok(bytes(output) <= budget);
  });
  it('distinguishes empty arrays from missing, null and unavailable collections', () => {
    const output = presentDefaultMarketData({ data: { 'stocks-bootstrap': { quotes: [] }, crypto: null, sectors: { sectors: 'invalid' } } }, budget);
    const coverage = output.transportCoverage.collections;
    assert.equal(coverage['stocks-bootstrap.quotes'].original_count, 0);
    for (const [key, state] of [['crypto.quotes', 'null'], ['commodities-bootstrap.quotes', 'missing'], ['sectors.sectors', 'unavailable']]) {
      assert.equal(coverage[key].state, state);
      assert.equal(coverage[key].original_count, null);
      assert.equal(coverage[key].returned_count, null);
    }
  });
  it('counts exact UTF-8 bytes with escaped text and receipt, then omits the whole one-byte-over row', () => {
    const input = { panelRequest: { token: 'signed-receipt' }, data: { 'stocks-bootstrap': { quotes: [{ symbol: 'é', name: '\\"', padding: '' }] } } };
    const overhead = bytes(presentDefaultMarketData(input, budget));
    input.data['stocks-bootstrap'].quotes[0].padding = 'x'.repeat(budget - overhead);
    const original = structuredClone(input);
    assert.equal(bytes(presentDefaultMarketData(input, budget)), budget);
    input.data['stocks-bootstrap'].quotes[0].padding += 'x';
    const output = presentDefaultMarketData(input, budget);
    assert.equal(output.data['stocks-bootstrap'].quotes.length, 0);
    assert.equal(output.transportCoverage.collections['stocks-bootstrap.quotes'].omitted_count, 1);
    assert.equal(input.data['stocks-bootstrap'].quotes[0].padding.length, original.data['stocks-bootstrap'].quotes[0].padding.length + 1);
  });
  it('leaves an oversized retained metadata cohort for the generic output gate', () => {
    const input = { data: { 'stocks-bootstrap': { quotes: [] }, physical: { metadata: 'x'.repeat(budget) } } };
    assert.equal(presentDefaultMarketData(input, budget), input);
    assert.ok(bytes(input) > budget);
  });
});
