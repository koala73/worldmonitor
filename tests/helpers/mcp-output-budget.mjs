// Shared single-source-of-truth for `tests/mcp-output-budget.test.mjs` and
// `scripts/mcp-budget-check.mjs`. Holds the fixture→tool mapping, the
// `KNOWN_OVER_BUDGET` exclusion map, the measurement function, and the
// composite check used by both consumers so they cannot drift.
//
// Why one module: when the same gate was inlined in both files, the
// `Map` / `Set` shapes drifted, the script's exit code skipped the
// stale-entry + dead-entry guards the test enforces, and the
// "Keep in sync" comments were a manual contract no one would catch
// breaking. Single source eliminates all three.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { __testing__, utf8ByteLength } from '../../api/mcp.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURES_DIR = path.resolve(HERE, '..', 'fixtures', 'jmespath-samples');

// (fixture file, tool name). Add a row when capturing a new fixture under
// `tests/fixtures/jmespath-samples/`. Each entry is automatically picked up
// by both the test (one node-test case per entry) and the script (one row
// in the markdown table).
export const FIXTURES = [
  { file: 'fat-get-market-data.response.json', tool: 'get_market_data' },
  { file: 'medium-get-conflict-events.response.json', tool: 'get_conflict_events' },
  { file: 'thin-get-chokepoint-status.response.json', tool: 'get_chokepoint_status' },
];

// Tools whose default-args envelope is currently over their declared
// `_outputBudgetBytes`. Each entry: tool name → reason + deletion criterion.
// The bidirectional guards in `runBudgetChecks` (below) ensure entries can't
// go stale: a tool that drops back under budget while still listed here
// fails the check; a tool listed here without a fixture in `FIXTURES` also
// fails. Remove an entry once the underlying tool is brought back under
// budget.
export const KNOWN_OVER_BUDGET = new Map([
  ['get_market_data',
    'commodities-bootstrap ships 30 quotes per the universal default `limit` — that single key alone is ~133 KB, more than the entire 128 KB budget. Default-args calls currently return the runtime `_budget_exceeded` envelope. Delete this entry once the per-key default cap is tightened (or the per-tool budget raised with justification) so the envelope fits under budget.'],
]);

export function readFixture(file) {
  return JSON.parse(readFileSync(path.join(FIXTURES_DIR, file), 'utf8'));
}

// Replays the runtime byte-accounting pipeline (`dispatchToolsCall`,
// default-args identity path: no JMESPath, no `summary: true`) against a
// captured fixture envelope and returns the byte count the runtime gate
// would compare against `tool._outputBudgetBytes`.
export function measure(tool, fixture) {
  const filtered = tool._postFilter
    ? tool._postFilter(structuredClone(fixture.data), {})
    : fixture.data;
  const envelope = { cached_at: fixture.cached_at, stale: fixture.stale, data: filtered };
  return utf8ByteLength(JSON.stringify(envelope));
}

// Per-fixture outcome categories. The two consumers (test + script) map
// each row to their own surface (assertion vs printed status), but the
// classification logic lives here so both agree on what counts as a
// failure.
//
//   ok            — observed ≤ budget, tool not in KNOWN_OVER_BUDGET
//   over          — observed > budget, tool not in KNOWN_OVER_BUDGET (FAIL)
//   known-over    — observed > budget, tool in KNOWN_OVER_BUDGET (allowed)
//   stale         — observed ≤ budget, tool in KNOWN_OVER_BUDGET (FAIL —
//                   delete the entry)
//   missing-tool  — tool name not found in TOOL_REGISTRY (FAIL)
//   missing-file  — fixture file not present on disk (FAIL)
export function classify(observed, budget, toolName, knownOverBudget = KNOWN_OVER_BUDGET) {
  const isKnown = knownOverBudget.has(toolName);
  const over = observed > budget;
  if (over && isKnown) return 'known-over';
  if (over) return 'over';
  if (!over && isKnown) return 'stale';
  return 'ok';
}

// Run all (fixture, tool) measurements PLUS the dead-entry guard. Returns a
// list of row records the consumers render however they want. The test
// turns each row into an assertion; the script turns each row into a
// markdown row + an exit code.
export function runBudgetChecks() {
  const rows = [];
  for (const { file, tool: toolName } of FIXTURES) {
    const tool = __testing__.TOOL_REGISTRY.find((t) => t.name === toolName);
    if (!tool) {
      rows.push({ file, tool: toolName, status: 'missing-tool', budget: null, observed: null });
      continue;
    }
    let fixture;
    try {
      fixture = readFixture(file);
    } catch (e) {
      rows.push({ file, tool: toolName, status: 'missing-file', budget: tool._outputBudgetBytes, observed: null, error: e.message });
      continue;
    }
    const observed = measure(tool, fixture);
    const budget = tool._outputBudgetBytes;
    rows.push({ file, tool: toolName, status: classify(observed, budget, toolName), budget, observed });
  }
  // Dead-entry guard: every KNOWN_OVER_BUDGET name must reference a tool
  // with a fixture in this file (unfalsifiable exclusions = silent risk).
  const fixtureTools = new Set(FIXTURES.map((f) => f.tool));
  const dead = [...KNOWN_OVER_BUDGET.keys()].filter((name) => !fixtureTools.has(name));
  return { rows, deadEntries: dead };
}
