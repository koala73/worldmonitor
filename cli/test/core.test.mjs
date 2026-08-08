import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  API_KEY_HEADER,
  DEFAULT_BASE_URL,
  DEFAULT_MCP_URL,
  USER_AGENT,
  UsageError,
  VERSION,
  formatOutput,
  parseArgs,
  planRequest,
  renderListing,
  resolveConfig,
  summarizeSpec,
} from '../src/core.mjs';
import { run } from '../src/run.mjs';

describe('version', () => {
  it('core VERSION stays in sync with package.json (guards `npm version` bumps)', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    assert.equal(VERSION, pkg.version);
    assert.ok(USER_AGENT.includes(VERSION), 'User-Agent should embed the version');
  });
});

function rpcOf(plan) {
  return JSON.parse(plan.body);
}

describe('parseArgs', () => {
  it('separates command, positionals, options and params', () => {
    const p = parseArgs(['conflicts', '--country', 'IR', '--limit', '5', '--compact']);
    assert.equal(p.command, 'conflicts');
    assert.deepEqual(p.params, { country: 'IR', limit: '5' });
    assert.equal(p.options.compact, true);
  });

  it('supports --key=value form and value flags', () => {
    const p = parseArgs(['risk', 'DE', '--api-key=wm_abc', '--mcp-url', 'http://x/mcp']);
    assert.deepEqual(p.positionals, ['DE']);
    assert.equal(p.options.apiKey, 'wm_abc');
    assert.equal(p.options.mcpUrl, 'http://x/mcp');
  });

  it('treats a bare unknown flag as boolean true', () => {
    const p = parseArgs(['disasters', '--active_only']);
    assert.equal(p.params.active_only, true);
  });

  it('does not mistake negative numbers for flags', () => {
    const p = parseArgs(['call', 'get_market_data', '--offset', '-5']);
    assert.equal(p.params.offset, '-5');
  });

  it('stops flag parsing at --', () => {
    const p = parseArgs(['get', '--', '/api/health']);
    assert.deepEqual(p.positionals, ['/api/health']);
  });
});

describe('planRequest — MCP curated commands', () => {
  it('maps a curated command to the right tool with a positional argument', () => {
    const plan = planRequest(parseArgs(['risk', 'IR']));
    assert.equal(plan.kind, 'mcp');
    assert.equal(plan.url, DEFAULT_MCP_URL);
    const rpc = rpcOf(plan);
    assert.equal(rpc.method, 'tools/call');
    assert.deepEqual(rpc.params, { name: 'get_country_risk', arguments: { country_code: 'IR' } });
  });

  it('merges --key value flags into the tool arguments', () => {
    const plan = planRequest(parseArgs(['conflicts', '--country', 'IR', '--limit', '5']));
    assert.deepEqual(rpcOf(plan).params.arguments, { country: 'IR', limit: '5' });
  });

  it('sets the User-Agent and (when present) the API key header', () => {
    const plan = planRequest(parseArgs(['world', '--api-key', 'wm_key']));
    assert.equal(plan.headers['user-agent'], USER_AGENT);
    assert.equal(plan.headers[API_KEY_HEADER], 'wm_key');
    assert.match(plan.headers.accept, /text\/event-stream/);
  });

  it('reads the API key from config/env', () => {
    const plan = planRequest(parseArgs(['world']), { apiKey: 'wm_env' });
    assert.equal(plan.headers[API_KEY_HEADER], 'wm_env');
  });

  it('throws UsageError for a missing required positional', () => {
    assert.throws(() => planRequest(parseArgs(['risk'])), UsageError);
  });
});

describe('planRequest — generic MCP', () => {
  it('lists tools (public) with no params', () => {
    const plan = planRequest(parseArgs(['tools']));
    assert.equal(rpcOf(plan).method, 'tools/list');
    assert.equal(rpcOf(plan).params, undefined);
  });

  it('builds a tools/call for an arbitrary tool', () => {
    const plan = planRequest(parseArgs(['call', 'get_market_data', '--asset_class', 'crypto']));
    assert.deepEqual(rpcOf(plan).params, {
      name: 'get_market_data',
      arguments: { asset_class: 'crypto' },
    });
  });

  it('accepts a typed --args JSON object', () => {
    const plan = planRequest(parseArgs(['call', 'get_market_data', '--args', '{"limit":5}']));
    assert.deepEqual(rpcOf(plan).params.arguments, { limit: 5 });
  });

  it('throws UsageError for call without a tool name', () => {
    assert.throws(() => planRequest(parseArgs(['call'])), UsageError);
  });

  it('throws UsageError for invalid --args JSON', () => {
    assert.throws(() => planRequest(parseArgs(['call', 't', '--args', '{bad'])), UsageError);
  });
});

describe('planRequest — REST escape hatch and listing', () => {
  it('builds a health check', () => {
    const plan = planRequest(parseArgs(['health']));
    assert.equal(plan.kind, 'rest');
    assert.equal(plan.url, `${DEFAULT_BASE_URL}/api/health`);
    assert.equal(plan.headers['user-agent'], USER_AGENT);
  });

  it('builds a raw get with query params and --base-url override', () => {
    const plan = planRequest(parseArgs(['get', '/api/health', '--verbose', 'true', '--base-url', 'http://localhost:3000/']));
    assert.equal(plan.url, 'http://localhost:3000/api/health?verbose=true');
  });

  it('throws UsageError for get without a path', () => {
    assert.throws(() => planRequest(parseArgs(['get', 'notapath'])), UsageError);
  });

  it('plans an OpenAPI listing', () => {
    const plan = planRequest(parseArgs(['list', 'cyber']));
    assert.equal(plan.kind, 'list');
    assert.equal(plan.service, 'cyber');
  });

  it('throws UsageError for an unknown command', () => {
    assert.throws(() => planRequest(parseArgs(['nope'])), UsageError);
  });
});

describe('resolveConfig', () => {
  it('reads the API key and hosts from the environment', () => {
    const cfg = resolveConfig({ WORLDMONITOR_API_KEY: 'k', WORLDMONITOR_MCP_URL: 'http://m' });
    assert.equal(cfg.apiKey, 'k');
    assert.equal(cfg.mcpUrl, 'http://m');
  });
});

describe('summarizeSpec / renderListing', () => {
  const spec = {
    paths: {
      '/api/cyber/v1/list-cyber-threats': { get: { summary: 'List threats' } },
      '/api/market/v1/list-market-quotes': { get: {} },
    },
  };

  it('flattens operations', () => {
    assert.equal(summarizeSpec(spec).length, 2);
  });

  it('filters by service', () => {
    const rows = summarizeSpec(spec, 'cyber');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].service, 'cyber');
  });

  it('renders a non-empty listing', () => {
    assert.match(renderListing(summarizeSpec(spec)), /2 operation\(s\)/);
  });
});

describe('formatOutput', () => {
  it('pretty-prints by default', () => {
    assert.equal(formatOutput({ a: 1 }), '{\n  "a": 1\n}');
  });
  it('compacts with --compact', () => {
    assert.equal(formatOutput({ a: 1 }, { compact: true }), '{"a":1}');
  });
  it('passes strings through with --raw', () => {
    assert.equal(formatOutput('hello', { raw: true }), 'hello');
  });
});

// A tiny fetch stub so run() can be exercised with no network.
function stubFetch({ ok = true, status = 200, contentType = 'application/json', body = '{}' } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return {
      ok,
      status,
      headers: { get: (k) => (k.toLowerCase() === 'content-type' ? contentType : null) },
      text: async () => body,
    };
  };
  return { fetchImpl, calls };
}

function collect() {
  let out = '';
  let err = '';
  return {
    stdout: (s) => {
      out += s;
    },
    stderr: (s) => {
      err += s;
    },
    get out() {
      return out;
    },
    get err() {
      return err;
    },
  };
}

describe('run', () => {
  it('prints version', async () => {
    const io = collect();
    const code = await run(['--version'], { ...io, fetch: undefined, env: {} });
    assert.equal(code, 0);
    assert.match(io.out, /^\d+\.\d+\.\d+/);
  });

  it('prints help with no command', async () => {
    const io = collect();
    const code = await run([], { ...io, env: {} });
    assert.equal(code, 0);
    assert.match(io.out, /USAGE/);
  });

  it('unwraps an MCP tools/call result', async () => {
    const io = collect();
    const { fetchImpl, calls } = stubFetch({ body: JSON.stringify({ jsonrpc: '2.0', id: 1, result: { score: 42 } }) });
    const code = await run(['risk', 'IR', '--api-key', 'wm_k'], { ...io, fetch: fetchImpl, env: {} });
    assert.equal(code, 0);
    assert.equal(calls[0].init.headers[API_KEY_HEADER], 'wm_k');
    assert.deepEqual(JSON.parse(io.out), { score: 42 });
  });

  it('parses an MCP result delivered as SSE', async () => {
    const io = collect();
    const sse = 'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"tools":[]}}\n\n';
    const { fetchImpl } = stubFetch({ contentType: 'text/event-stream', body: sse });
    const code = await run(['tools'], { ...io, fetch: fetchImpl, env: {} });
    assert.equal(code, 0);
    assert.deepEqual(JSON.parse(io.out), { tools: [] });
  });

  it('returns exit 1 and hints on an MCP auth error', async () => {
    const io = collect();
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32001, message: 'Authentication required.' } });
    const { fetchImpl } = stubFetch({ body });
    const code = await run(['risk', 'IR'], { ...io, fetch: fetchImpl, env: {} });
    assert.equal(code, 1);
    assert.match(io.err, /Authentication required/);
    assert.match(io.err, /--api-key/);
  });

  it('returns exit 1 on MCP HTTP transport errors', async () => {
    const io = collect();
    const { fetchImpl } = stubFetch({ ok: false, status: 403, contentType: 'text/html', body: '<html>challenge</html>' });
    const code = await run(['tools'], { ...io, fetch: fetchImpl, env: {} });
    assert.equal(code, 1);
    assert.equal(io.out, '');
    assert.match(io.err, /challenge/);
    assert.doesNotMatch(io.err, /--api-key/);
  });

  it('hints to pass a key on MCP HTTP 401 transport errors', async () => {
    const io = collect();
    const { fetchImpl } = stubFetch({ ok: false, status: 401, body: '{"error":"API key required"}' });
    const code = await run(['tools'], { ...io, fetch: fetchImpl, env: {} });
    assert.equal(code, 1);
    assert.match(io.err, /API key required/);
    assert.match(io.err, /--api-key/);
  });

  it('performs a REST health check', async () => {
    const io = collect();
    const { fetchImpl, calls } = stubFetch({ body: '{"status":"OK"}' });
    const code = await run(['health'], { ...io, fetch: fetchImpl, env: {} });
    assert.equal(code, 0);
    assert.match(calls[0].url, /\/api\/health$/);
    assert.deepEqual(JSON.parse(io.out), { status: 'OK' });
  });

  it('returns exit 1 and writes the body to stderr on REST HTTP error', async () => {
    const io = collect();
    const { fetchImpl } = stubFetch({ ok: false, status: 404, body: '{"error":"not found"}' });
    const code = await run(['get', '/api/nope'], { ...io, fetch: fetchImpl, env: {} });
    assert.equal(code, 1);
    assert.match(io.err, /not found/);
    // A non-auth failure must NOT suggest a key — the hint is 401-scoped.
    assert.doesNotMatch(io.err, /--api-key/);
  });

  it('hints to pass a key on a REST 401 (e.g. `health` with no key)', async () => {
    const io = collect();
    const { fetchImpl } = stubFetch({ ok: false, status: 401, body: '{"error":"API key required"}' });
    const code = await run(['health'], { ...io, fetch: fetchImpl, env: {} });
    assert.equal(code, 1);
    assert.match(io.err, /API key required/);
    assert.match(io.err, /--api-key/);
  });

  it('returns exit 2 on a usage error', async () => {
    const io = collect();
    const code = await run(['risk'], { ...io, fetch: stubFetch().fetchImpl, env: {} });
    assert.equal(code, 2);
    assert.match(io.err, /needs <country_code>/);
  });

  it('lists operations from the live spec', async () => {
    const io = collect();
    const spec = JSON.stringify({ paths: { '/api/cyber/v1/list-cyber-threats': { get: { summary: 'x' } } } });
    const { fetchImpl, calls } = stubFetch({ body: spec });
    const code = await run(['list', 'cyber'], { ...io, fetch: fetchImpl, env: {} });
    assert.equal(code, 0);
    assert.equal(calls[0].init.headers['user-agent'], USER_AGENT);
    assert.match(io.out, /list-cyber-threats/);
  });

  it('passes the API key when listing operations from a protected spec URL', async () => {
    const io = collect();
    const spec = JSON.stringify({ paths: { '/api/cyber/v1/list-cyber-threats': { get: { summary: 'x' } } } });
    const { fetchImpl, calls } = stubFetch({ body: spec });
    const code = await run(['list', 'cyber', '--api-key', 'wm_k'], { ...io, fetch: fetchImpl, env: {} });
    assert.equal(code, 0);
    assert.equal(calls[0].init.headers[API_KEY_HEADER], 'wm_k');
  });

  it('hints to pass a key on a protected spec listing 401', async () => {
    const io = collect();
    const { fetchImpl } = stubFetch({ ok: false, status: 401, body: '{"error":"API key required"}' });
    const code = await run(['list'], { ...io, fetch: fetchImpl, env: {} });
    assert.equal(code, 1);
    assert.match(io.err, /API key required/);
    assert.match(io.err, /--api-key/);
  });
});
