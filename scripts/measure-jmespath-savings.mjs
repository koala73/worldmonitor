#!/usr/bin/env node
/**
 * Reproducible JMESPath savings measurement (U6).
 *
 * Reads checked-in tool-response fixtures from
 * `tests/fixtures/jmespath-samples/` and runs `applyJmespath` directly
 * on each (no `mcpHandler`, no cache path, no fetch mocking). For each
 * fixture: measures `utf8ByteLength` of the wire-shaped `text` returned
 * both with and without a deterministic agent-style projection, then
 * emits a markdown table for the PR description.
 *
 * Direct-invocation strategy: `executeTool()` reads cache via
 * `readJsonFromUpstash` which calls `fetch()` directly, NOT
 * `deps.redisPipeline`. Mocking `deps` wouldn't intercept those reads.
 * Calling `applyJmespath` on the already-assembled tool response is
 * simpler AND uniquely correct for what we're measuring — the
 * projection delta, not a cache-path benchmark.
 *
 * Deterministic: same fixtures + same expressions → byte-identical
 * output every run. Reviewers re-run to verify PR numbers.
 *
 * Usage:
 *   npx tsx scripts/measure-jmespath-savings.mjs
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyJmespath, utf8ByteLength } from '../api/mcp.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const FIXTURES_DIR = resolve(ROOT, 'tests/fixtures/jmespath-samples');

// Three deterministic agent-style projections, one per fixture size class.
// Keep these stable across runs so reported numbers are reproducible.
// Cache keys are labelled by their last meaningful segment after stripping
// version tags (NON_LABEL = /^(v\d+|\d+|stale|sebuf)$/), so:
//   `market:stocks-bootstrap:v1` -> `data["stocks-bootstrap"]`
//   `conflict:ucdp-events:v1`    -> `data["ucdp-events"]`
//   `supply_chain:transit-summaries:v1` -> `data["transit-summaries"]`
// Hyphenated keys MUST be quoted in JMESPath (`data."stocks-bootstrap"`).
const CASES = [
  {
    name: 'fat',
    tool: 'get_market_data',
    fixture: 'fat-get-market-data.response.json',
    expr: '{stocks: data."stocks-bootstrap".quotes[*].{s:symbol,p:price}, commodities: data."commodities-bootstrap".quotes[*].{s:symbol,p:price}, crypto: data.crypto.quotes[*].{s:symbol,p:price}}',
  },
  {
    name: 'medium',
    tool: 'get_conflict_events',
    fixture: 'medium-get-conflict-events.response.json',
    expr: '{ucdp: data."ucdp-events".events[*].{c:country,k:fatalities,t:title}, iran: data."iran-events".events[*].{c:country,k:fatalities,t:title}, unrest: data.events[*].{c:country,t:title}}',
  },
  {
    name: 'thin',
    tool: 'get_chokepoint_status',
    fixture: 'thin-get-chokepoint-status.response.json',
    // Real shape is `summaries: { suez: {...}, hormuz_strait: {...} }` — a
    // map of chokepoint-id → status object — NOT a flat array. JMESPath
    // `values(@)` flattens the map values; `keys(@)` would give the
    // chokepoint IDs. Project to {id, risk, disruption} tuples.
    expr: '{chokepoints: keys(data."transit-summaries".summaries), risk: values(data."transit-summaries".summaries)[*].riskLevel, disruption: values(data."transit-summaries".summaries)[*].disruptionPct}',
  },
];

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  return `${(n / 1024).toFixed(1)} KB`;
}

const rows = [];
let allOk = true;
for (const c of CASES) {
  const fixturePath = resolve(FIXTURES_DIR, c.fixture);
  let payload;
  try {
    payload = JSON.parse(readFileSync(fixturePath, 'utf8'));
  } catch (e) {
    process.stderr.write(`SKIP ${c.name} (${c.tool}): ${e.code === 'ENOENT' ? 'fixture not yet captured' : e.message}\n`);
    rows.push({ name: c.name, tool: c.tool, expr: c.expr, unproj: '—', proj: '—', pct: '—', note: 'fixture missing' });
    allOk = false;
    continue;
  }
  const identity = applyJmespath(payload, undefined);
  const projected = applyJmespath(payload, c.expr);
  if (projected.failed) {
    process.stderr.write(`FAIL ${c.name} projection: ${projected.failed} (${projected.text.slice(0, 200)})\n`);
    rows.push({ name: c.name, tool: c.tool, expr: c.expr, unproj: utf8ByteLength(identity.text), proj: 'ERR', pct: '—', note: projected.failed });
    allOk = false;
    continue;
  }
  const u = utf8ByteLength(identity.text);
  const p = utf8ByteLength(projected.text);
  const pct = u === 0 ? 0 : Math.round(((u - p) / u) * 1000) / 10;
  rows.push({ name: c.name, tool: c.tool, expr: c.expr, unproj: u, proj: p, pct });
}

const lines = [
  '## JMESPath projection — A/B byte savings',
  '',
  '_Reproducible. Same fixtures + same expressions → byte-identical output every run._',
  '',
  '| Case | Tool | Unprojected (utf8) | Projected (utf8) | Reduction | Projection expression |',
  '|---|---|---:|---:|---:|---|',
];
for (const r of rows) {
  const u = typeof r.unproj === 'number' ? fmtBytes(r.unproj) : r.unproj;
  const p = typeof r.proj === 'number' ? fmtBytes(r.proj) : r.proj;
  const pct = typeof r.pct === 'number' ? `${r.pct}%` : r.pct;
  const note = r.note ? ` _(${r.note})_` : '';
  lines.push(`| **${r.name}** | \`${r.tool}\` | ${u} | ${p} | ${pct}${note} | \`${r.expr}\` |`);
}
lines.push('', `Measurement: \`utf8ByteLength(applyJmespath(fixture, expr).text)\` — same helper that gates the runtime output cap (\`JMESPATH_MAX_OUTPUT_BYTES\`), so reported numbers match the runtime contract.`);
process.stdout.write(lines.join('\n') + '\n');

process.exit(allOk ? 0 : 1);
