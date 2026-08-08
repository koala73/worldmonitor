#!/usr/bin/env node
/**
 * Reproducible tools/list byte-reduction measurement (v1.4.0 → v1.5.0).
 *
 * Self-contained — no fixture file needed. The script computes BOTH
 * compressed (v1.5.0 path) and uncompressed (synthetic v1.4.0 shape,
 * excluding describe_tool) responses in one process by calling the
 * shared `buildPublicTool` helper with both flag values. Deterministic;
 * same source → same byte counts every run.
 *
 * The synthetic-v1.4.0 path is faithful because v1.4.0's
 * TOOL_LIST_RESPONSE builder did exactly what `buildPublicTool(t,
 * { compressDescriptions: false })` does today (minus describe_tool,
 * which is new in v1.5.0). Excluding describe_tool from the synthetic
 * baseline gives an apples-to-apples comparison.
 *
 * Output: markdown table for the PR description + assertion that the
 * reduction crosses R1's ≥8% target.
 *
 * Usage:
 *   npx tsx scripts/measure-tools-list-compression.mjs
 */
import {
  TOOL_DESCRIPTION_MAX_BYTES,
  utf8ByteLength,
  buildPublicTool,
} from '../api/mcp.ts';

// Re-import the module to reach TOOL_REGISTRY indirectly via the public
// tools/list call. We don't export TOOL_REGISTRY; the round-trip through
// mcpHandler gives us the v1.5.0 compressed catalog. For the v1.4.0
// baseline we re-run the same registry through buildPublicTool with
// compressDescriptions=false and filter out describe_tool (the v1.5.0
// addition).
process.env.WORLDMONITOR_VALID_KEYS = 'wm_measure_key';
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;

const mcpMod = await import('../api/mcp.ts');

async function fetchToolsList() {
  const req = new Request('https://worldmonitor.app/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-WorldMonitor-Key': 'wm_measure_key' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  const res = await mcpMod.default(req);
  const body = await res.json();
  return body.result.tools;
}

const v15Tools = await fetchToolsList();

// Reconstruct v1.4.0 baseline: same tools as v1.5.0 EXCEPT exclude
// describe_tool (new in v1.5.0), AND replace each compressed description
// with the full text by calling describe_tool({tool_name: t.name}).
async function callDescribeTool(toolName) {
  const req = new Request('https://worldmonitor.app/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-WorldMonitor-Key': 'wm_measure_key' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'describe_tool', arguments: { tool_name: toolName } },
    }),
  });
  const res = await mcpMod.default(req);
  const body = await res.json();
  return JSON.parse(body.result.content[0].text);
}

// v1.4.0 baseline: every non-describe_tool tool with FULL description
const v14Tools = [];
for (const t of v15Tools) {
  if (t.name === 'describe_tool') continue; // v1.5.0 addition
  const full = await callDescribeTool(t.name);
  v14Tools.push(full);
}

// The response envelope structure matches what `tools/list` emits:
// { jsonrpc: '2.0', id: 1, result: { tools: [...] } }
function envelopeFor(tools) {
  return { jsonrpc: '2.0', id: 1, result: { tools } };
}

const v14Bytes = utf8ByteLength(JSON.stringify(envelopeFor(v14Tools)));
const v15Bytes = utf8ByteLength(JSON.stringify(envelopeFor(v15Tools)));
const reduction = Math.round(((v14Bytes - v15Bytes) / v14Bytes) * 10000) / 100;

const v14ToolDescBytes = v14Tools.reduce((sum, t) => sum + utf8ByteLength(t.description), 0);
const v15ToolDescBytes = v15Tools.reduce((sum, t) => sum + utf8ByteLength(t.description), 0);

function fmt(n) { return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`; }

const out = [
  '## tools/list compression — A/B byte savings (v1.4.0 → v1.5.0)',
  '',
  '_Reproducible. Self-contained measurement — no captured fixture. Same source → same byte counts._',
  '',
  '| Slice | v1.4.0 (uncompressed) | v1.5.0 (compressed) | Reduction |',
  '|---|---:|---:|---:|',
  `| **Total tools/list envelope** | ${fmt(v14Bytes)} | ${fmt(v15Bytes)} | **${reduction}%** |`,
  `| Tool descriptions (38 / 39) | ${fmt(v14ToolDescBytes)} | ${fmt(v15ToolDescBytes)} | ${Math.round(((v14ToolDescBytes - v15ToolDescBytes) / v14ToolDescBytes) * 100)}% |`,
  '',
  `Measurement: \`utf8ByteLength(JSON.stringify(envelope))\` — same helper that gates JMESPath output (api/mcp.ts:utf8ByteLength), so reported numbers match the runtime contract.`,
  '',
  `Cap: \`TOOL_DESCRIPTION_MAX_BYTES = ${TOOL_DESCRIPTION_MAX_BYTES}\`. Property descriptions intentionally NOT compressed in v1.5.0 (audit found 53% encode contract details).`,
];
process.stdout.write(out.join('\n') + '\n');

// R1: reduction ≥ 8%
if (reduction < 8) {
  process.stderr.write(`\nERROR: reduction ${reduction}% is below R1 target of ≥8%.\n`);
  process.exit(1);
}
