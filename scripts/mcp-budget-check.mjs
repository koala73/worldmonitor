#!/usr/bin/env node
/**
 * Reproducible per-tool output byte-budget measurement.
 *
 * Reads checked-in tool-response fixtures from
 * `tests/fixtures/jmespath-samples/` and replays the runtime byte-accounting
 * pipeline against each:
 *
 *   fixture.data
 *     → tool._postFilter(structuredClone(fixture.data), {})   // skipped if no _postFilter
 *     → { cached_at, stale, data: filtered }                  // reassembled envelope
 *     → JSON.stringify(envelope)
 *     → utf8ByteLength(...)
 *
 * This is the same chain `dispatchToolsCall` measures against
 * `_outputBudgetBytes` at runtime (api/mcp.ts — search `textBytes > budget`),
 * restricted to the default-args identity path (no JMESPath projection, no
 * `summary: true`). Matching the byte count is the property the regression
 * test asserts (`tests/mcp-output-budget.test.mjs`).
 *
 * Direct-invocation strategy: identical to `measure-jmespath-savings.mjs`.
 * Reads the fixture, runs the filter in-process. No `mcpHandler`, no cache
 * round-trip, no fetch mocking. Deterministic: same fixtures → byte-identical
 * numbers every run.
 *
 * Exit code: non-zero if any tool exceeds its declared `_outputBudgetBytes`
 * AND is NOT listed in KNOWN_OVER_BUDGET. Mirrors the gating semantics of
 * the test so the script doubles as a standalone CI check.
 *
 * Usage:
 *   npx tsx scripts/mcp-budget-check.mjs
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { __testing__, utf8ByteLength } from '../api/mcp.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const FIXTURES_DIR = resolve(ROOT, 'tests/fixtures/jmespath-samples');

// Fixture → tool mapping. Kept in lockstep with the same const in
// `tests/mcp-output-schema-coverage.test.mjs` and
// `tests/mcp-output-budget.test.mjs`.
const FIXTURES = [
  { file: 'fat-get-market-data.response.json', tool: 'get_market_data' },
  { file: 'medium-get-conflict-events.response.json', tool: 'get_conflict_events' },
  { file: 'thin-get-chokepoint-status.response.json', tool: 'get_chokepoint_status' },
];

// Tools whose default-args envelope is currently over its declared
// `_outputBudgetBytes` and which the runtime gate is therefore already
// rejecting in production with the `_budget_exceeded` envelope.
// Keep in sync with the same const in `tests/mcp-output-budget.test.mjs`.
const KNOWN_OVER_BUDGET = new Set([
  'get_market_data',
]);

function fmtBytes(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return String(n);
  if (n < 1024) return `${n} B`;
  return `${(n / 1024).toFixed(1)} KB`;
}

function measure(tool, fixture) {
  const filtered = tool._postFilter
    ? tool._postFilter(structuredClone(fixture.data), {})
    : fixture.data;
  const envelope = { cached_at: fixture.cached_at, stale: fixture.stale, data: filtered };
  return utf8ByteLength(JSON.stringify(envelope));
}

const rows = [];
let unexpectedOver = false;
for (const { file, tool: toolName } of FIXTURES) {
  const tool = __testing__.TOOL_REGISTRY.find((t) => t.name === toolName);
  if (!tool) {
    rows.push({ tool: toolName, budget: '—', observed: 'tool not in registry', headroom: '—', status: 'ERR' });
    unexpectedOver = true;
    continue;
  }
  let fixture;
  try {
    fixture = JSON.parse(readFileSync(resolve(FIXTURES_DIR, file), 'utf8'));
  } catch (e) {
    const note = e.code === 'ENOENT' ? 'fixture missing' : e.message;
    rows.push({ tool: toolName, budget: tool._outputBudgetBytes, observed: note, headroom: '—', status: 'ERR' });
    unexpectedOver = true;
    continue;
  }
  const observed = measure(tool, fixture);
  const budget = tool._outputBudgetBytes;
  const headroomPct = budget > 0 ? ((budget - observed) / budget) * 100 : 0;
  let status;
  if (observed > budget) {
    if (KNOWN_OVER_BUDGET.has(toolName)) {
      status = `OVER by ${observed - budget} B (known)`;
    } else {
      status = `OVER by ${observed - budget} B`;
      unexpectedOver = true;
    }
  } else {
    status = 'OK';
  }
  rows.push({ tool: toolName, budget, observed, headroom: headroomPct, status });
}

const lines = [
  '## Per-tool output budget — observed vs declared',
  '',
  '_Reproducible. Same fixtures → byte-identical numbers every run._',
  '',
  '| Tool | Budget | Observed | Headroom | Status |',
  '|---|---:|---:|---:|---|',
];
for (const r of rows) {
  const budget = typeof r.budget === 'number' ? fmtBytes(r.budget) : r.budget;
  const observed = typeof r.observed === 'number' ? fmtBytes(r.observed) : r.observed;
  const headroom = typeof r.headroom === 'number' ? `${r.headroom.toFixed(1)}%` : r.headroom;
  lines.push(`| \`${r.tool}\` | ${budget} | ${observed} | ${headroom} | ${r.status} |`);
}
lines.push(
  '',
  'Measurement: `utf8ByteLength(JSON.stringify({cached_at, stale, data: _postFilter(data, {})}))` — the same chain the runtime budget gate measures (default-args identity path; no JMESPath, no summary).',
);
process.stdout.write(lines.join('\n') + '\n');

process.exit(unexpectedOver ? 1 : 0);
