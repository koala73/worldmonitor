// deduct-situation degrades to `{ analysis: '', provider: 'error' }` when no
// LLM provider answers. analyze_situation passed that through as a successful
// tool result, so an MCP caller saw an empty analysis with no error. A
// provider failure must reach the caller as the retryable source-unavailable
// error every other upstream outage uses.
import { afterEach, describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { dispatchToolsCall } from '../api/mcp/dispatch.ts';

const ORIGINAL_FETCH = globalThis.fetch;
process.env.MCP_TELEMETRY = 'false';

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});

async function callAnalyzeSituation(deductBody) {
  globalThis.fetch = async (input) => {
    assert.match(String(input instanceof Request ? input.url : input), /\/api\/intelligence\/v1\/deduct-situation$/);
    return new Response(JSON.stringify(deductBody), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const originalWarn = console.warn;
  const originalError = console.error;
  console.warn = () => {};
  console.error = () => {};
  try {
    const res = await dispatchToolsCall(
      new Request('http://localhost/mcp'),
      { kind: 'env_key', apiKey: 'test' },
      {},
      { id: 7, params: { name: 'analyze_situation', arguments: { query: 'Hormuz tanker traffic implications' } } },
      {},
    );
    return await res.json();
  } finally {
    console.warn = originalWarn;
    console.error = originalError;
  }
}

describe('analyze_situation provider failure', () => {
  it('reports provider "error" as a retryable source-unavailable error, not an empty success', async () => {
    const body = await callAnalyzeSituation({ analysis: '', model: '', provider: 'error' });

    assert.equal(body.result, undefined, `expected no tool result, got ${JSON.stringify(body.result)}`);
    assert.equal(body.error?.code, -32003);
    assert.equal(body.error?.data?.retryable, true);
    assert.deepEqual(body.error?.data?.failed_inputs, ['deduct-situation']);
  });

  it('reports a blank query (provider "skipped") as invalid params, not an outage', async () => {
    const body = await callAnalyzeSituation({ analysis: '', model: '', provider: 'skipped' });

    assert.equal(body.result, undefined);
    assert.equal(body.error?.code, -32602);
    assert.equal(body.error?.data?.violations?.[0]?.field, 'query');
  });

  it('still returns a real analysis as a successful result', async () => {
    const body = await callAnalyzeSituation({ analysis: '**Bottom line**\n- x', model: 'deepseek/deepseek-v4-flash', provider: 'openrouter' });

    assert.equal(body.error, undefined, `unexpected error ${JSON.stringify(body.error)}`);
    assert.equal(body.result.structuredContent.analysis, '**Bottom line**\n- x');
    assert.notEqual(body.result.isError, true);
  });
});
