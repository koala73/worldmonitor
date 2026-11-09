// Unit coverage for scripts/mcp-tool-canary.mjs (the scheduled authenticated
// MCP tool canary). Two things are pinned here:
//   1. Every failure mode the canary exists to catch turns the run red, and a
//      single transient failure is absorbed by the one retry.
//   2. Fixture coverage against the in-repo tool registry: a PR that adds a
//      read-only tool whose input rejects {} must add a canary fixture in the
//      same PR, and a fixture may not outlive its tool.

import { describe, it, before } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  buildFixtures,
  evaluateCall,
  finalizeRun,
  findUncoveredTools,
  isWellFormedKey,
  parseRpcBody,
  publishIssue,
  renderMarkdown,
  requiresInput,
  runCanary,
  selectCanaryTools,
  summarize,
  ISSUE_TITLE,
} from '../scripts/mcp-tool-canary.mjs';

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: { cached_at: { type: 'string' }, stale: { type: 'boolean' }, data: { type: 'object', required: ['items'] } },
  required: ['data'],
};

function tool(name, extra = {}) {
  return {
    name,
    annotations: { readOnlyHint: true },
    inputSchema: { type: 'object', properties: {}, required: [] },
    outputSchema: OUTPUT_SCHEMA,
    ...extra,
  };
}

function rpcResult(result, id = 1) {
  return JSON.stringify({ jsonrpc: '2.0', id, result });
}

const GOOD = { content: [{ type: 'text', text: '{}' }], structuredContent: { cached_at: 'x', stale: false, data: { items: [] } } };

// Fake MCP endpoint: `tools` drives tools/list; `responder(name, args, attempt)`
// returns { status, body } or throws for tools/call.
function fakeFetch(tools, responder) {
  const attempts = new Map();
  const calls = [];
  const fetchImpl = async (_url, init) => {
    const msg = JSON.parse(init.body);
    assert.equal(init.headers['X-WorldMonitor-Key'], 'wm_test');
    if (msg.method === 'tools/list') {
      return new Response(rpcResult({ tools }, msg.id), { status: 200 });
    }
    const { name, arguments: args } = msg.params;
    const n = (attempts.get(name) ?? 0) + 1;
    attempts.set(name, n);
    calls.push({ name, args, attempt: n });
    const r = await responder(name, args, n);
    return new Response(r.body, { status: r.status ?? 200 });
  };
  return { fetchImpl, calls };
}

const FAST = { retryDelayMs: 0, minStartGapMs: 0, log: () => {} };

describe('evaluateCall', () => {
  it('passes a 200 answer whose structuredContent matches the schema', () => {
    const v = evaluateCall({ status: 200, body: rpcResult(GOOD) }, null);
    assert.equal(v.ok, true);
  });

  it('fails each way a 200 can still be a broken tool', () => {
    assert.equal(evaluateCall({ status: 200, body: rpcResult({ isError: true, content: [{ type: 'text', text: 'boom' }] }) }).kind, 'tool_error');
    assert.equal(evaluateCall({ status: 200, body: rpcResult({ content: [] }) }).kind, 'no_structured');
    assert.equal(evaluateCall({ status: 200, body: JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32603, message: 'x' } }) }).kind, 'rpc_error');
    assert.equal(evaluateCall({ status: 200, body: '<html>' }).kind, 'rpc_error');
    assert.equal(evaluateCall({ status: 502, body: '' }).kind, 'http');
    assert.equal(evaluateCall({ timedOut: true }).kind, 'timeout');
    assert.equal(evaluateCall({ error: 'ECONNRESET' }).kind, 'transport');
  });

  it('accepts only the JSON-RPC error codes a fixture names', () => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32002, message: 'user-bound' } });
    assert.equal(evaluateCall({ status: 200, body }, null, { acceptRpcErrorCodes: [-32002] }).ok, true);
    assert.equal(evaluateCall({ status: 200, body }, null, { acceptRpcErrorCodes: [] }).ok, false);
  });

  it('reads a single-message SSE body', () => {
    assert.deepEqual(parseRpcBody(`event: message\ndata: ${rpcResult(GOOD)}\n\n`).result, GOOD);
  });
});

describe('runCanary', () => {
  it('is healthy when every tool answers within contract, and records stale answers without failing', async () => {
    const tools = [tool('get_a'), tool('get_b')];
    const { fetchImpl } = fakeFetch(tools, (name) => ({
      body: rpcResult(name === 'get_b' ? { ...GOOD, structuredContent: { ...GOOD.structuredContent, stale: true } } : GOOD),
    }));
    const report = await runCanary({ key: 'wm_test', fetchImpl, ...FAST });
    const s = summarize(report);
    assert.equal(s.healthy, true);
    assert.equal(s.passed.length, 2);
    assert.deepEqual(s.stale.map((r) => r.name), ['get_b']);
  });

  it('fails on an outputSchema mismatch even though the call answered 200', async () => {
    const { fetchImpl } = fakeFetch([tool('get_a')], () => ({
      body: rpcResult({ content: [], structuredContent: { data: { wrong: true } } }),
    }));
    const report = await runCanary({ key: 'wm_test', fetchImpl, ...FAST });
    assert.equal(summarize(report).healthy, false);
    assert.equal(report.results[0].kind, 'schema');
    assert.equal(report.results[0].attempts, 2);
  });

  it('absorbs one transient failure with the retry', async () => {
    const { fetchImpl, calls } = fakeFetch([tool('get_a')], (_n, _a, attempt) => (
      attempt === 1 ? { status: 503, body: '' } : { body: rpcResult(GOOD) }));
    const report = await runCanary({ key: 'wm_test', fetchImpl, ...FAST });
    assert.equal(summarize(report).healthy, true);
    assert.equal(calls.length, 2);
  });

  it('never calls a tool without readOnlyHint: true', async () => {
    const tools = [tool('get_a'), tool('start_upgrade', { annotations: { readOnlyHint: false } }), tool('report_issue', { annotations: {} })];
    const { fetchImpl, calls } = fakeFetch(tools, () => ({ body: rpcResult(GOOD) }));
    await runCanary({ key: 'wm_test', fetchImpl, ...FAST });
    assert.deepEqual(calls.map((c) => c.name), ['get_a']);
  });

  it('fails when an advertised tool needs input and has no fixture', async () => {
    const tools = [tool('get_new_thing', { inputSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] } })];
    const { fetchImpl } = fakeFetch(tools, () => ({ body: rpcResult(GOOD) }));
    const report = await runCanary({ key: 'wm_test', fetchImpl, ...FAST });
    assert.deepEqual(report.uncovered, ['get_new_thing']);
    assert.equal(summarize(report).healthy, false);
  });

  it('fails the whole run when tools/list cannot be read', async () => {
    const report = await runCanary({ key: 'wm_test', fetchImpl: async () => new Response('', { status: 500 }), ...FAST });
    assert.match(report.setupError, /tools\/list failed/);
    assert.equal(summarize(report).healthy, false);
  });

  it('chains derived arguments from the upstream tool result', async () => {
    const tools = [
      tool('get_forecast_case', { inputSchema: { type: 'object', properties: {}, required: ['forecast_id', 'generated_at'] } }),
      tool('get_forecast_predictions'),
    ];
    const upstream = { content: [], structuredContent: { cached_at: 'x', stale: false, data: { items: [], predictions: { generatedAt: 1794211442129, predictions: [{ id: 'fc-1' }] } } } };
    const { fetchImpl, calls } = fakeFetch(tools, (name) => ({ body: rpcResult(name === 'get_forecast_predictions' ? upstream : GOOD) }));
    const report = await runCanary({ key: 'wm_test', fetchImpl, ...FAST });
    assert.equal(summarize(report).healthy, true);
    assert.deepEqual(calls.find((c) => c.name === 'get_forecast_case').args, { forecast_id: 'fc-1', generated_at: '1794211442129' });
  });
});

describe('review regressions (PR #10353)', () => {
  it('fails a tool whose advertised outputSchema cannot compile instead of skipping the check', async () => {
    const broken = tool('get_a', { outputSchema: { type: 'object', properties: { x: { $ref: '#/$defs/missing' } } } });
    const { fetchImpl } = fakeFetch([broken], () => ({ body: rpcResult(GOOD) }));
    const report = await runCanary({ key: 'wm_test', fetchImpl, ...FAST });
    assert.equal(report.results[0].ok, false);
    assert.equal(report.results[0].kind, 'schema_invalid');
    assert.equal(summarize(report).healthy, false);
  });

  it('stops starting calls once the run budget is spent and reports the rest as not run', async () => {
    const tools = [tool('get_a'), tool('get_b'), tool('get_c'), tool('get_d')];
    const { fetchImpl, calls } = fakeFetch(tools, async () => {
      await new Promise((r) => setTimeout(r, 40));
      return { status: 503, body: '' };
    });
    const report = await runCanary({ key: 'wm_test', fetchImpl, ...FAST, runBudgetMs: 60 });
    assert.equal(report.results.length, 4, 'every tool is accounted for');
    assert.ok(report.results.some((r) => r.kind === 'budget_exhausted'));
    assert.ok(calls.length < 8, `budget must stop retries and new calls (made ${calls.length})`);
    assert.equal(summarize(report).healthy, false);
  });

  it('counts a chained tool with nothing to chain from as a failure, so recovery cannot skip it', async () => {
    const tools = [
      tool('get_webcam_media', { inputSchema: { type: 'object', properties: {}, required: ['webcam_id'] } }),
      tool('find_webcams', { inputSchema: { type: 'object', properties: {}, required: ['bound_w'] } }),
    ];
    const empty = { content: [], structuredContent: { data: { items: [], webcams: [] } } };
    const { fetchImpl } = fakeFetch(tools, (name) => ({ body: rpcResult(name === 'find_webcams' ? empty : GOOD) }));
    const report = await runCanary({ key: 'wm_test', fetchImpl, ...FAST });
    const media = report.results.find((r) => r.name === 'get_webcam_media');
    assert.equal(media.ok, false);
    assert.equal(media.kind, 'unchained');
    assert.equal(summarize(report).healthy, false);
  });

  it('never lets the credential reach a finding detail', async () => {
    const key = 'wm_0123456789abcdef0123456789abcdef01234567';
    const fetchImpl = async () => { throw new TypeError(`Headers.append: "${key}" is an invalid header value.`); };
    const report = await runCanary({ key, fetchImpl, ...FAST });
    assert.ok(!JSON.stringify(report).includes(key), 'key leaked into the report');
    assert.ok(!JSON.stringify(report).includes(key.slice(3)), 'key body leaked into the report');
  });

  it('accepts only a single-token printable key', () => {
    assert.equal(isWellFormedKey('wm_0123456789abcdef0123456789abcdef01234567'), true);
    assert.equal(isWellFormedKey('wm_0123\n4567'), false);
    assert.equal(isWellFormedKey('wm_0123 4567'), false);
    assert.equal(isWellFormedKey(''), false);
  });

  it('emits per-tool annotations and exits 1 even when publishing the issue throws', () => {
    const report = { checkedAt: 't', url: 'u', credential: 'user', uncovered: [], setupError: null,
      results: [{ name: 'get_a', ok: false, kind: 'schema', detail: 'd', attempts: 2 }] };
    const lines = [];
    const code = finalizeRun(report, { publish: true, log: (l) => lines.push(l), publishFn: () => { throw new Error('gh down'); } });
    assert.equal(code, 1);
    assert.ok(lines.some((l) => l.startsWith('::error title=MCP canary get_a::')));
    assert.ok(lines.some((l) => l.includes('gh down')));
  });
});

describe('requiresInput', () => {
  it('treats an all-branches-required oneOf as required input', () => {
    assert.equal(requiresInput({ required: [], oneOf: [{ required: ['a'] }, { required: ['b'] }] }), true);
    assert.equal(requiresInput({ required: [], oneOf: [{ required: ['a'] }, {}] }), false);
    assert.equal(requiresInput({ properties: {} }), false);
  });
});

describe('publishIssue', () => {
  const failing = { checkedAt: 't', url: 'u', credential: 'operator', results: [{ name: 'get_a', ok: false, kind: 'schema', detail: 'd', attempts: 2 }], uncovered: [], setupError: null };
  const healthy = { ...failing, results: [{ name: 'get_a', ok: true, kind: 'ok', detail: '', attempts: 1 }] };
  const botIssue = { number: 7, title: ISSUE_TITLE, user: { login: 'github-actions[bot]' } };

  function recorder(openIssues) {
    const calls = [];
    const gh = (args, payload) => {
      calls.push({ args, payload });
      if (args.includes('--paginate')) return [openIssues];
      return { number: 9 };
    };
    return { gh, calls };
  }

  it('opens an issue on failure and updates it on repeat failure', () => {
    let r = recorder([]);
    assert.equal(publishIssue(failing, { repository: 'o/r', gh: r.gh }).action, 'created');
    assert.equal(r.calls[1].payload.title, ISSUE_TITLE);
    r = recorder([botIssue]);
    assert.equal(publishIssue(failing, { repository: 'o/r', gh: r.gh }).action, 'updated');
    assert.ok(r.calls[1].args.includes('repos/o/r/issues/7'));
  });

  it('closes the open issue on recovery and does nothing when already healthy', () => {
    let r = recorder([botIssue]);
    assert.equal(publishIssue(healthy, { repository: 'o/r', gh: r.gh }).action, 'closed');
    assert.equal(r.calls.at(-1).payload.state, 'closed');
    r = recorder([]);
    assert.equal(publishIssue(healthy, { repository: 'o/r', gh: r.gh }).action, 'none');
    assert.equal(r.calls.length, 1);
  });

  it('ignores a same-titled issue a human opened', () => {
    const r = recorder([{ ...botIssue, user: { login: 'someone' } }]);
    assert.equal(publishIssue(failing, { repository: 'o/r', gh: r.gh }).action, 'created');
  });

  it('escapes table cells', () => {
    const md = renderMarkdown({ ...failing, results: [{ name: 'get_a', ok: false, kind: 'schema', detail: 'a|b\n<x>', attempts: 2 }] });
    assert.match(md, /a\\\|b &lt;x&gt;/);
  });
});

describe('fixture coverage against the in-repo tool registry', () => {
  let tools;
  before(async () => {
    process.env.WORLDMONITOR_VALID_KEYS = 'wm_test_key_canary';
    const mod = await import('../api/mcp.ts');
    tools = mod.TOOL_LIST_RESPONSE;
    assert.ok(Array.isArray(tools) && tools.length > 0, 'TOOL_LIST_RESPONSE must list tools');
  });

  it('every read-only tool whose input rejects {} has a canary fixture', () => {
    assert.deepEqual(findUncoveredTools(tools, buildFixtures()), [],
      'add a fixture to buildFixtures() in scripts/mcp-tool-canary.mjs');
  });

  it('every fixture names a registered read-only tool', () => {
    const readOnly = new Set(selectCanaryTools(tools).map((t) => t.name));
    const stale = Object.keys(buildFixtures()).filter((name) => !readOnly.has(name));
    assert.deepEqual(stale, [], 'remove fixtures for tools that are gone or not read-only');
  });

  it('every derived fixture chains from a registered read-only tool', () => {
    const readOnly = new Set(selectCanaryTools(tools).map((t) => t.name));
    for (const [name, f] of Object.entries(buildFixtures())) {
      if (typeof f.derive === 'function') assert.ok(readOnly.has(f.after), `${name} chains from unknown tool ${f.after}`);
    }
  });
});
