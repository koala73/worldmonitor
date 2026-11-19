#!/usr/bin/env node
/**
 * Reproducible tools/list description-budget measurement.
 *
 * Self-contained — no fixture file needed. Calls the live `tools/list`
 * handler and reports, per tool and in total, how many UTF-8 bytes the
 * shipped `description` uses against TOOL_DESCRIPTION_MAX_BYTES and
 * TOOL_DESCRIPTIONS_TOTAL_MAX_BYTES, how large the whole tools/list envelope
 * is, and whether every input-schema property (nested branches included)
 * carries a description. Deterministic; same source → same numbers.
 *
 * Replaces measure-tools-list-compression.mjs, which reported the savings of
 * the v1.5.0 first-sentence compression that v1.34.0 retired.
 *
 * Usage:
 *   npx tsx scripts/measure-tools-list-descriptions.mjs [--per-tool]
 */
import {
  TOOL_DESCRIPTION_MAX_BYTES,
  TOOL_DESCRIPTIONS_TOTAL_MAX_BYTES,
} from '../api/mcp/constants.ts';
import { utf8ByteLength } from '../api/mcp/utils.ts';

process.env.WORLDMONITOR_VALID_KEYS = 'wm_measure_key';
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;

const mcpMod = await import('../api/mcp.ts');

const res = await mcpMod.default(new Request('https://worldmonitor.app/mcp', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-WorldMonitor-Key': 'wm_measure_key' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
}));
const body = await res.json();
const tools = body.result.tools;

function missingDescriptions(schema, path, out) {
  if (!schema || typeof schema !== 'object') return;
  if (schema.properties && typeof schema.properties === 'object') {
    for (const [key, value] of Object.entries(schema.properties)) {
      const here = `${path}.${key}`;
      if (!(value && typeof value === 'object' && typeof value.description === 'string' && value.description.trim())) out.push(here);
      missingDescriptions(value, here, out);
    }
  }
  if (schema.items) missingDescriptions(schema.items, `${path}[]`, out);
  for (const branch of ['oneOf', 'anyOf', 'allOf']) {
    if (Array.isArray(schema[branch])) schema[branch].forEach((s, i) => missingDescriptions(s, `${path}<${branch}${i}>`, out));
  }
}

const rows = tools.map((tool) => {
  const missing = [];
  missingDescriptions(tool.inputSchema, tool.name, missing);
  return { name: tool.name, bytes: utf8ByteLength(tool.description), missing };
});
const envelopeBytes = utf8ByteLength(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { tools } }));
const totalBytes = rows.reduce((sum, row) => sum + row.bytes, 0);
const overCap = rows.filter((row) => row.bytes > TOOL_DESCRIPTION_MAX_BYTES);
const missing = rows.flatMap((row) => row.missing);
const largest = [...rows].sort((a, b) => b.bytes - a.bytes).slice(0, 5);

function fmt(n) { return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`; }

const out = [
  '## tools/list description budget',
  '',
  '| Measure | Value | Budget |',
  '|---|---:|---:|',
  `| Tools | ${tools.length} | — |`,
  `| Description bytes, total | ${fmt(totalBytes)} (${totalBytes} B) | ${fmt(TOOL_DESCRIPTIONS_TOTAL_MAX_BYTES)} |`,
  `| Largest description | ${largest[0].name} = ${largest[0].bytes} B | ${TOOL_DESCRIPTION_MAX_BYTES} B |`,
  `| Mean description | ${Math.round(totalBytes / tools.length)} B | — |`,
  `| Whole tools/list envelope | ${fmt(envelopeBytes)} (${envelopeBytes} B) | — |`,
  `| Input-schema properties without a description | ${missing.length} | 0 |`,
  '',
  `Top 5: ${largest.map((row) => `${row.name} ${row.bytes} B`).join(', ')}.`,
  '',
  'Measurement: `utf8ByteLength(JSON.stringify(envelope))` — the same helper that gates JMESPath output, so reported numbers match the runtime contract.',
];
if (process.argv.includes('--per-tool')) {
  out.push('', '| Tool | Description bytes |', '|---|---:|');
  for (const row of rows) out.push(`| ${row.name} | ${row.bytes} |`);
}
process.stdout.write(out.join('\n') + '\n');

let failed = false;
if (overCap.length) {
  process.stderr.write(`\nERROR: over the ${TOOL_DESCRIPTION_MAX_BYTES} B per-tool budget: ${overCap.map((row) => `${row.name}=${row.bytes}`).join(', ')}\n`);
  failed = true;
}
if (totalBytes > TOOL_DESCRIPTIONS_TOTAL_MAX_BYTES) {
  process.stderr.write(`\nERROR: total ${totalBytes} B exceeds the ${TOOL_DESCRIPTIONS_TOTAL_MAX_BYTES} B budget.\n`);
  failed = true;
}
if (missing.length) {
  process.stderr.write(`\nERROR: input-schema properties without a description:\n${missing.join('\n')}\n`);
  failed = true;
}
if (failed) process.exit(1);
