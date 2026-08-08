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
 * `summary: true`).
 *
 * The fixture mapping, `KNOWN_OVER_BUDGET` exclusion list, and measurement
 * function are shared with `tests/mcp-output-budget.test.mjs` via
 * `tests/helpers/mcp-output-budget.mjs`, so the script and test cannot drift.
 *
 * Exit code: non-zero on any of the three failure modes the test gates on —
 *   - `over`   tool exceeds budget AND is not in KNOWN_OVER_BUDGET
 *   - `stale`  tool listed in KNOWN_OVER_BUDGET is now under budget
 *              (the exclusion entry must be deleted)
 *   - dead    KNOWN_OVER_BUDGET names a tool with no fixture in this suite
 *   - `missing-tool` / `missing-file` (lookup failures)
 * Same gating semantics as the test, so the script doubles as a standalone
 * CI check.
 *
 * Direct-invocation strategy: identical to `measure-jmespath-savings.mjs`.
 * Reads the fixture, runs the filter in-process. No `mcpHandler`, no cache
 * round-trip, no fetch mocking. Deterministic: same fixtures → byte-identical
 * numbers every run.
 *
 * Usage:
 *   npx tsx scripts/mcp-budget-check.mjs
 */
import {
  KNOWN_OVER_BUDGET,
  runBudgetChecks,
} from '../tests/helpers/mcp-output-budget.mjs';

function fmtBytes(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return String(n);
  if (n < 1024) return `${n} B`;
  return `${(n / 1024).toFixed(1)} KB`;
}

const { rows, deadEntries } = runBudgetChecks();

let anyFailure = false;
const tableRows = [];
for (const r of rows) {
  const budgetCell = typeof r.budget === 'number' ? fmtBytes(r.budget) : '—';
  let observedCell;
  let headroomCell = '—';
  let statusCell;
  switch (r.status) {
    case 'ok':
      observedCell = fmtBytes(r.observed);
      headroomCell = `${(((r.budget - r.observed) / r.budget) * 100).toFixed(1)}%`;
      statusCell = 'OK';
      break;
    case 'known-over':
      observedCell = fmtBytes(r.observed);
      headroomCell = `${(((r.budget - r.observed) / r.budget) * 100).toFixed(1)}%`;
      statusCell = `OVER by ${r.observed - r.budget} B (known)`;
      break;
    case 'over':
      observedCell = fmtBytes(r.observed);
      headroomCell = `${(((r.budget - r.observed) / r.budget) * 100).toFixed(1)}%`;
      statusCell = `OVER by ${r.observed - r.budget} B`;
      anyFailure = true;
      break;
    case 'stale':
      observedCell = fmtBytes(r.observed);
      headroomCell = `${(((r.budget - r.observed) / r.budget) * 100).toFixed(1)}%`;
      statusCell = `STALE — delete KNOWN_OVER_BUDGET entry (UNDER by ${r.budget - r.observed} B)`;
      anyFailure = true;
      break;
    case 'missing-tool':
      observedCell = 'tool not in registry';
      statusCell = 'ERR';
      anyFailure = true;
      break;
    case 'missing-file':
      observedCell = `fixture missing: ${r.error}`;
      statusCell = 'ERR';
      anyFailure = true;
      break;
    default:
      observedCell = '?';
      statusCell = `unknown status: ${r.status}`;
      anyFailure = true;
  }
  tableRows.push(`| \`${r.tool}\` | ${budgetCell} | ${observedCell} | ${headroomCell} | ${statusCell} |`);
}

const lines = [
  '## Per-tool output budget — observed vs declared',
  '',
  '_Reproducible. Same fixtures → byte-identical numbers every run._',
  '',
  '| Tool | Budget | Observed | Headroom | Status |',
  '|---|---:|---:|---:|---|',
  ...tableRows,
  '',
  'Measurement: `utf8ByteLength(JSON.stringify({cached_at, stale, data: _postFilter(data, {})}))` — the same chain the runtime budget gate measures (default-args identity path; no JMESPath, no summary).',
];
process.stdout.write(lines.join('\n') + '\n');

if (deadEntries.length > 0) {
  process.stderr.write(
    `\nERR: KNOWN_OVER_BUDGET entries reference tools with no fixture in this suite: ${deadEntries.join(', ')}\n  -> remove the dead entries from tests/helpers/mcp-output-budget.mjs.\n`,
  );
  anyFailure = true;
}

// Surface the documented reason for any known-over rows on stderr so a dev
// running the script locally sees the issue context without polluting the
// stdout markdown table (which is meant to be pasteable into PR bodies).
for (const r of rows) {
  if (r.status === 'known-over') {
    process.stderr.write(
      `\nKNOWN over-budget: ${r.tool} observed=${r.observed} budget=${r.budget} delta=+${r.observed - r.budget}B\n  -> ${KNOWN_OVER_BUDGET.get(r.tool)}\n`,
    );
  }
}

process.exit(anyFailure ? 1 : 0);
