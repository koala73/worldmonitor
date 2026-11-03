import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import Ajv2020 from 'ajv/dist/2020.js';
import handler from '../api/mcp.ts';
import { TOOL_REGISTRY, buildPublicTool, toolAccess, toolWeight } from '../api/mcp/registry/index.ts';

const originalFetch = globalThis.fetch;
const originalSecret = process.env.MCP_INTERNAL_HMAC_SECRET;
const originalKeys = process.env.WORLDMONITOR_VALID_KEYS;
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const [key, value] of [['MCP_INTERNAL_HMAC_SECRET', originalSecret], ['WORLDMONITOR_VALID_KEYS', originalKeys]]) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});
const tool = () => {
  const found = TOOL_REGISTRY.find(candidate => candidate.name === 'get_stock_research');
  assert.ok(found, 'get_stock_research must be callable');
  return found;
};
const call = args => tool()._execute(args, 'https://worldmonitor.app', { kind: 'env_key', apiKey: 'wm_stock_fixture' });
const analysis = { available: true, symbol: 'AAPL', signal: 'Hold', signalScore: 0,
  generatedAt: '2026-09-30T12:00:00Z', fallback: true, provider: 'technical', model: '',
  ratingSignal: 'Watch', engineVersion: 'v8', riskFactors: ['fixture risk'], headlines: [],
};
const backtest = { available: true, symbol: 'AAPL', evaluations: [], winRate: 0,
  ratingBasis: 'technical-only', engineVersion: 'v4', evalWindowDays: 10,
};

describe('stock research MCP workflow', () => {
  it('reaches the four fixed routes with generated-client query contracts', async () => {
    const cases = [
      ['analysis', 'analyze-stock', { symbol: 'AAPL', include_news: 'false' }, analysis],
      ['backtest', 'backtest-stock', { symbol: 'AAPL', eval_window_days: '10' }, backtest],
      ['history', 'get-stock-analysis-history', { symbols: 'AAPL', include_news: 'false', limit_per_symbol: '4' }, { items: [{ symbol: 'AAPL', snapshots: [analysis] }] }],
      ['stored-backtests', 'list-stored-stock-backtests', { symbols: 'AAPL', eval_window_days: '10' }, { items: [backtest] }],
    ];
    const ajv = new Ajv2020({ strict: true, strictRequired: false, allowUnionTypes: true, validateFormats: false });
    const validate = ajv.compile(buildPublicTool(tool(), { compressDescriptions: true }).outputSchema.anyOf[0]);
    for (const [operation, route, query, data] of cases) {
      globalThis.fetch = async (input, init) => {
        const url = new URL(String(input));
        assert.equal(url.pathname, `/api/market/v1/${route}`);
        assert.deepEqual(Object.fromEntries(url.searchParams), query);
        assert.equal(init.headers['X-WorldMonitor-Key'], 'wm_stock_fixture');
        assert.equal(init.headers['User-Agent'], 'worldmonitor-mcp-edge/1.0');
        return Response.json(data);
      };
      const result = await call({ operation, symbols: [' aapl '] });
      assert.deepEqual(result, { operation, data });
      assert.ok(validate(result), JSON.stringify(validate.errors));
    }
  });

  it('preserves full watchlists and explicit options without silent truncation', async () => {
    const symbols = Array.from({ length: 50 }, (_, i) => `STOCK${i}`);
    globalThis.fetch = async input => {
      const url = new URL(String(input));
      assert.deepEqual(url.searchParams.getAll('symbols'), symbols);
      assert.equal(url.searchParams.get('limit_per_symbol'), '32');
      assert.equal(url.searchParams.get('include_news'), 'true');
      return Response.json({ items: [] });
    };
    assert.deepEqual((await call({ operation: 'history', symbols, limit_per_symbol: 32, include_news: true })).data, { items: [] });
    globalThis.fetch = async input => {
      assert.equal(new URL(String(input)).searchParams.get('eval_window_days'), '30');
      return Response.json({ available: false, symbol: 'UNKNOWN', evaluations: [] });
    };
    assert.equal((await call({ operation: 'backtest', symbols: ['UNKNOWN'], eval_window_days: 30 })).data.available, false);
  });

  it('rejects malformed symbols, limits and operation-specific options before fetching', async () => {
    globalThis.fetch = async () => assert.fail('invalid requests must not fetch');
    for (const args of [ {}, { operation: 'other', symbols: ['AAPL'] },
      { operation: 'analysis', symbols: [] }, { operation: 'analysis', symbols: ['AAPL', 'MSFT'] },
      { operation: 'history', symbols: Array(51).fill('AAPL') }, { operation: 'history', symbols: ['AAPL,A'] },
      { operation: 'history', symbols: ['AAPL\nMSFT'] }, { operation: 'history', symbols: ['A'.repeat(33)] },
      { operation: 'history', symbols: ['AAPL'], limit_per_symbol: 33 },
      { operation: 'backtest', symbols: ['AAPL'], eval_window_days: 2 },
      { operation: 'backtest', symbols: ['AAPL'], include_news: true },
      { operation: 'analysis', symbols: ['AAPL'], limit_per_symbol: 4 },
      { operation: 'history', symbols: ['AAPL'], eval_window_days: 10 },
      { operation: 'analysis', symbols: ['AAPL'], include_news: 'true' },
    ]) await assert.rejects(call(args), error => error.name === 'RpcValidationError');
  });

  it('preserves subscription, provider quota backoff and gateway validation errors', async () => {
    assert.equal(toolAccess(tool()), 'subscription');
    assert.equal(toolWeight(tool()), 2);
    assert.equal(tool().annotations.readOnlyHint, false);
    assert.equal(tool().annotations.idempotentHint, false);
    assert.equal(tool().annotations.destructiveHint, false);
    globalThis.fetch = async () => new Response(null, { status: 503, headers: { 'X-Billing-Verification': 'renewal_verification_pending', 'Retry-After': '10' } });
    await assert.rejects(call({ operation: 'analysis', symbols: ['AAPL'] }), error => error.name === 'BillingDenialError');
    globalThis.fetch = async () => new Response(null, { status: 429, headers: { 'Retry-After': '3600' } });
    await assert.rejects(call({ operation: 'backtest', symbols: ['AAPL'] }), error => error.name === 'ToolBackoffError' && error.retryAfter === '3600');
    globalThis.fetch = async () => Response.json({ violations: [{ field: 'symbol', description: 'Unknown symbol' }] }, { status: 400 });
    await assert.rejects(call({ operation: 'analysis', symbols: ['AAPL'] }), error => error.name === 'RpcValidationError' && error.violations[0].field === 'symbol');
  });

  it('signs account identity without forwarding user-key plaintext', async () => {
    process.env.MCP_INTERNAL_HMAC_SECRET = 'stock-fixture-signing-secret';
    globalThis.fetch = async (_input, init) => {
      assert.equal(init.headers['X-WM-MCP-User-Id'], 'stock-test-user');
      assert.ok(init.headers['X-WM-MCP-Internal']);
      assert.equal(init.headers['X-WorldMonitor-Key'], undefined);
      return Response.json({ items: [] });
    };
    await tool()._execute({ operation: 'history', symbols: ['AAPL'] }, 'https://worldmonitor.app', { kind: 'user_key', userId: 'stock-test-user', apiKey: 'must-not-be-forwarded' });
  });

  it('dispatches a real MCP call and denies uncredentialed stock research', async () => {
    process.env.WORLDMONITOR_VALID_KEYS = 'wm_stock_fixture';
    globalThis.fetch = async input => {
      assert.equal(new URL(String(input)).pathname, '/api/market/v1/analyze-stock');
      return Response.json(analysis);
    };
    const request = key => new Request('https://worldmonitor.app/mcp', { method: 'POST', headers: {
      'Content-Type': 'application/json', ...(key ? { 'X-WorldMonitor-Key': key } : {}),
    }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_stock_research', arguments: { operation: 'analysis', symbols: ['AAPL'] } } }) });
    const response = await handler(request('wm_stock_fixture'));
    assert.equal(response.status, 200);
    const result = (await response.json()).result;
    assert.notEqual(result.isError, true);
    assert.deepEqual(result.structuredContent, { operation: 'analysis', data: analysis });
    assert.equal((await handler(request())).status, 401);
  });
  it('returns a budget envelope for oversized saved history rather than claiming complete results', async () => {
    process.env.WORLDMONITOR_VALID_KEYS = 'wm_stock_fixture';
    globalThis.fetch = async () => Response.json({ items: [{ symbol: 'AAPL', snapshots: [{ ...analysis, summary: 'x'.repeat(600000) }] }] });
    const request = new Request('https://worldmonitor.app/mcp', { method: 'POST', headers: {
      'Content-Type': 'application/json', 'X-WorldMonitor-Key': 'wm_stock_fixture',
    }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_stock_research', arguments: { operation: 'history', symbols: ['AAPL'] } } }) });
    const response = await handler(request);
    const result = (await response.json()).result;
    assert.equal(result.structuredContent._budget_exceeded, true);
    assert.equal(result.structuredContent.budget_bytes, 524288);
    assert.match(result.structuredContent.hint, /jmespath/);
    assert.equal(result.structuredContent.data, undefined);
  });

});
