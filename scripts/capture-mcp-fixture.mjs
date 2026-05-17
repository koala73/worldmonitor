#!/usr/bin/env node
/**
 * Capture a real MCP tool response for the JMESPath fixture set (U6).
 *
 * Hits the production MCP HTTP endpoint with a supplied bearer and writes
 * the response envelope (`{cached_at, stale, data}` for cache tools, or
 * the raw RPC return for `_execute` tools) to disk under
 * `tests/fixtures/jmespath-samples/`. Pass `summary: true` or any other
 * filter arg via `--arg key=value` to capture a narrowed response.
 *
 * Usage:
 *   WM_MCP_BEARER="wm_live_..." node scripts/capture-mcp-fixture.mjs \
 *     --tool get_market_data \
 *     --name fat-get-market-data
 *
 *   # With filter args:
 *   node scripts/capture-mcp-fixture.mjs --tool get_conflict_events \
 *     --name medium-get-conflict-events --arg limit=30
 *
 * The bearer must be one of:
 *   - A wm_live_... env key (header: X-WorldMonitor-Key)
 *   - A wm_pro_... Pro MCP token (header: Authorization: Bearer ...)
 *
 * Endpoint defaults to https://worldmonitor.app/mcp; override with
 * WM_MCP_ENDPOINT for staging.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const FIXTURES_DIR = resolve(ROOT, 'tests/fixtures/jmespath-samples');
const ENDPOINT = process.env.WM_MCP_ENDPOINT ?? 'https://worldmonitor.app/mcp';
const BEARER = process.env.WM_MCP_BEARER;

function parseArgs(argv) {
  const out = { args: {} };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--tool') out.tool = argv[++i];
    else if (a === '--name') out.name = argv[++i];
    else if (a === '--arg') {
      const [k, ...rest] = argv[++i].split('=');
      const v = rest.join('=');
      // Coerce numeric / boolean strings to their JS equivalents so the
      // tool receives the right type (matches MCP JSON-RPC semantics).
      let parsed = v;
      if (v === 'true') parsed = true;
      else if (v === 'false') parsed = false;
      else if (/^-?\d+(\.\d+)?$/.test(v)) parsed = Number(v);
      out.args[k] = parsed;
    }
  }
  return out;
}

function fail(msg) { process.stderr.write(`ERROR: ${msg}\n`); process.exit(1); }

const { tool, name, args } = parseArgs(process.argv);
if (!tool) fail('--tool required (e.g. get_market_data)');
if (!name) fail('--name required (e.g. fat-get-market-data)');
if (!BEARER) fail('WM_MCP_BEARER env var required');

const headers = { 'Content-Type': 'application/json' };
if (BEARER.startsWith('wm_pro_')) headers['Authorization'] = `Bearer ${BEARER}`;
else headers['X-WorldMonitor-Key'] = BEARER;

const body = JSON.stringify({
  jsonrpc: '2.0', id: 1,
  method: 'tools/call',
  params: { name: tool, arguments: args },
});

process.stdout.write(`POST ${ENDPOINT}  tool=${tool}  args=${JSON.stringify(args)}\n`);

const res = await fetch(ENDPOINT, { method: 'POST', headers, body });
if (!res.ok) fail(`HTTP ${res.status} ${res.statusText}: ${await res.text()}`);

const rpc = await res.json();
if (rpc.error) fail(`JSON-RPC error: ${JSON.stringify(rpc.error)}`);
if (!rpc.result?.content?.[0]?.text) fail(`Unexpected response shape: ${JSON.stringify(rpc).slice(0, 200)}`);

// The MCP `content[0].text` is itself a JSON string of the tool envelope.
// Parse it back so the fixture is a structured JSON document (not a
// double-escaped string).
let envelope;
try {
  envelope = JSON.parse(rpc.result.content[0].text);
} catch (e) {
  fail(`content[0].text was not valid JSON: ${e.message}`);
}

mkdirSync(FIXTURES_DIR, { recursive: true });
const target = resolve(FIXTURES_DIR, `${name}.response.json`);
writeFileSync(target, JSON.stringify(envelope, null, 2) + '\n');
// Report UTF-8 byte count — matches the runtime gate's contract
// (api/mcp.ts:utf8ByteLength) so the number a captured fixture reports
// here is comparable to what the projection cap measures.
const bytes = new TextEncoder().encode(JSON.stringify(envelope)).length;
process.stdout.write(`wrote ${target} (${bytes} UTF-8 bytes of compact JSON)\n`);
