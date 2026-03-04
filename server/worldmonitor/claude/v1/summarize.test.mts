import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { handleSummarize } from './summarize.ts';

describe('handleSummarize', () => {
  let mockFetch: ReturnType<typeof mock.fn>;
  const originalFetch = globalThis.fetch;
  const originalEnv = process.env.CLAUDE_API_KEY;

  beforeEach(() => {
    mockFetch = mock.fn(() => Promise.resolve({
      ok: false, status: 500, json: () => Promise.resolve({}),
    }));
    globalThis.fetch = mockFetch as any;
    process.env.CLAUDE_API_KEY = 'test-key';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalEnv !== undefined) {
      process.env.CLAUDE_API_KEY = originalEnv;
    } else {
      delete process.env.CLAUDE_API_KEY;
    }
  });

  it('returns summary from Claude API using Haiku model', async () => {
    mockFetch.mock.mockImplementationOnce(() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve({
        content: [{ type: 'text', text: '{"summary":"Test summary","key_points":["p1"],"sentiment":"neutral"}' }],
        usage: { input_tokens: 100, output_tokens: 50 },
      }),
    }));
    const result = await handleSummarize({ headlines: ['H1', 'H2'], region: '', language: 'en', variant: '' });
    assert.strictEqual(result.summary, 'Test summary');
    assert.deepStrictEqual(result.keyPoints, ['p1']);
    assert.strictEqual(result.sentiment, 'neutral');
    assert.strictEqual(result.status, 'ok');
    assert.strictEqual(result.provider, 'claude');
    assert.strictEqual(result.inputTokens, 100);
    assert.strictEqual(result.outputTokens, 50);
    // Verify Haiku model used
    const body = JSON.parse(mockFetch.mock.calls[0].arguments[1].body);
    assert.ok(body.model.includes('haiku'), `Expected model to include 'haiku', got: ${body.model}`);
  });

  it('returns error status when API key missing', async () => {
    delete process.env.CLAUDE_API_KEY;
    const result = await handleSummarize({ headlines: ['test'], region: '', language: 'en', variant: '' });
    assert.strictEqual(result.status, 'error');
    assert.ok(result.errorMessage.length > 0);
  });

  it('returns error status on API failure', async () => {
    mockFetch.mock.mockImplementationOnce(() => Promise.resolve({ ok: false, status: 500 }));
    const result = await handleSummarize({ headlines: ['test'], region: '', language: 'en', variant: '' });
    assert.strictEqual(result.status, 'error');
    assert.ok(result.errorMessage.includes('500'));
  });

  it('sends correct headers to Anthropic API', async () => {
    mockFetch.mock.mockImplementationOnce(() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve({
        content: [{ type: 'text', text: '{"summary":"s","key_points":[],"sentiment":"neutral"}' }],
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
    }));
    await handleSummarize({ headlines: ['test'], region: '', language: 'en', variant: '' });
    const headers = mockFetch.mock.calls[0].arguments[1].headers;
    assert.strictEqual(headers['x-api-key'], 'test-key');
    assert.strictEqual(headers['anthropic-version'], '2023-06-01');
    assert.strictEqual(headers['Content-Type'], 'application/json');
  });

  it('handles timeout via AbortController', async () => {
    mockFetch.mock.mockImplementationOnce((_url: string, opts: any) => {
      // Simulate the abort signal being used
      assert.ok(opts.signal instanceof AbortSignal, 'Should pass an AbortSignal');
      return Promise.reject(new Error('The operation was aborted'));
    });
    const result = await handleSummarize({ headlines: ['test'], region: '', language: 'en', variant: '' });
    assert.strictEqual(result.status, 'error');
    assert.ok(result.errorMessage.includes('aborted'));
  });
});
