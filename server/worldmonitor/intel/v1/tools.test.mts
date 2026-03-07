import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { TOOL_DEFINITIONS, executeToolCall } from './tools.ts';

// Helper: create a mock Response for fetch
function mockResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

describe('tool registry', () => {
  it('exports at least 30 tool definitions', () => {
    assert.ok(TOOL_DEFINITIONS.length >= 30, `Expected >= 30 tools, got ${TOOL_DEFINITIONS.length}`);
  });

  it('every tool has name, description, and input_schema', () => {
    for (const tool of TOOL_DEFINITIONS) {
      assert.ok(tool.name, `Tool missing name`);
      assert.ok(tool.description, `Tool ${tool.name} missing description`);
      assert.ok(tool.input_schema, `Tool ${tool.name} missing input_schema`);
      assert.strictEqual(tool.input_schema.type, 'object', `Tool ${tool.name} schema type should be object`);
    }
  });

  it('tool names are unique', () => {
    const names = TOOL_DEFINITIONS.map(t => t.name);
    const unique = new Set(names);
    assert.strictEqual(names.length, unique.size, `Duplicate tool names found`);
  });

  it('tool names use snake_case', () => {
    for (const tool of TOOL_DEFINITIONS) {
      assert.ok(/^[a-z][a-z0-9_]*$/.test(tool.name), `Tool name ${tool.name} should be snake_case`);
    }
  });

  it('executeToolCall returns error object for unknown tool', async () => {
    const result = await executeToolCall('nonexistent_tool', {});
    assert.ok(typeof result === 'object');
    assert.ok('error' in (result as any));
  });
});

describe('web_search tool', () => {
  it('web_search is registered', () => {
    const tool = TOOL_DEFINITIONS.find(t => t.name === 'web_search');
    assert.ok(tool, 'web_search tool should be registered');
    assert.ok(tool!.description.length > 0);
    assert.ok(tool!.input_schema.properties.query, 'should have query param');
  });

  it('web_search returns error when TAVILY_API_KEY is missing', async () => {
    const original = process.env.TAVILY_API_KEY;
    delete process.env.TAVILY_API_KEY;
    try {
      const result = await executeToolCall('web_search', { query: 'test' }) as any;
      assert.ok(result.error || result.status === 'not_configured');
    } finally {
      if (original) process.env.TAVILY_API_KEY = original;
    }
  });
});

describe('web_extract tool', () => {
  it('web_extract is registered', () => {
    const tool = TOOL_DEFINITIONS.find(t => t.name === 'web_extract');
    assert.ok(tool, 'web_extract tool should be registered');
    assert.ok(tool!.input_schema.properties.urls, 'should have urls param');
    assert.deepStrictEqual(tool!.input_schema.required, ['urls']);
  });

  it('web_extract returns error when TAVILY_API_KEY is missing', async () => {
    const original = process.env.TAVILY_API_KEY;
    delete process.env.TAVILY_API_KEY;
    try {
      const result = await executeToolCall('web_extract', { urls: ['https://example.com'] }) as any;
      assert.ok(result.error || result.status === 'not_configured');
    } finally {
      if (original) process.env.TAVILY_API_KEY = original;
    }
  });
});

describe('verify_claim tool', () => {
  it('verify_claim is registered', () => {
    const tool = TOOL_DEFINITIONS.find(t => t.name === 'verify_claim');
    assert.ok(tool, 'verify_claim tool should be registered');
    assert.ok(tool!.input_schema.properties.claim, 'should have claim param');
    assert.ok(tool!.input_schema.properties.source, 'should have source param');
    assert.deepStrictEqual(tool!.input_schema.required, ['claim']);
  });

  it('verify_claim returns not_configured when TAVILY_API_KEY is missing', async () => {
    const original = process.env.TAVILY_API_KEY;
    delete process.env.TAVILY_API_KEY;
    try {
      const result = await executeToolCall('verify_claim', { claim: 'test claim' }) as any;
      assert.ok(result.error || result.status === 'not_configured');
    } finally {
      if (original) process.env.TAVILY_API_KEY = original;
    }
  });
});

// ================================================================
// Mock-based tests — verify_claim business logic
// ================================================================

describe('verify_claim scoring logic', () => {
  let originalKey: string | undefined;
  let fetchMock: ReturnType<typeof mock.method>;

  beforeEach(() => {
    originalKey = process.env.TAVILY_API_KEY;
    process.env.TAVILY_API_KEY = 'test-key';
    fetchMock = mock.method(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchMock.mock.restore();
    if (originalKey) {
      process.env.TAVILY_API_KEY = originalKey;
    } else {
      delete process.env.TAVILY_API_KEY;
    }
  });

  it('returns corroborated when >= 2 results have score > 0.7', async () => {
    fetchMock.mock.mockImplementation(async () => mockResponse({
      results: [
        { title: 'Reuters confirms', url: 'https://reuters.com/1', content: 'Confirmed event', score: 0.85 },
        { title: 'BBC reports', url: 'https://bbc.com/1', content: 'Same event', score: 0.80 },
        { title: 'Blog post', url: 'https://blog.com/1', content: 'Tangential', score: 0.3 },
      ],
    }));

    const result = await executeToolCall('verify_claim', { claim: 'test claim', source: 'Twitter' }) as any;
    assert.strictEqual(result.status, 'corroborated');
    assert.ok(result.summary.includes('2'));
    assert.strictEqual(result.claim, 'test claim');
    assert.strictEqual(result.source, 'Twitter');
    assert.strictEqual(result.evidence.length, 3);
  });

  it('returns corroborated when exactly 1 result has score > 0.7', async () => {
    fetchMock.mock.mockImplementation(async () => mockResponse({
      results: [
        { title: 'Reuters confirms', url: 'https://reuters.com/1', content: 'Confirmed event', score: 0.75 },
        { title: 'Low relevance', url: 'https://other.com/1', content: 'Unrelated', score: 0.4 },
      ],
    }));

    const result = await executeToolCall('verify_claim', { claim: 'some claim' }) as any;
    assert.strictEqual(result.status, 'corroborated');
    assert.ok(result.summary.includes('Reuters confirms'));
    assert.strictEqual(result.source, 'unknown'); // default when not provided
  });

  it('returns unverified when results exist but none have score > 0.7', async () => {
    fetchMock.mock.mockImplementation(async () => mockResponse({
      results: [
        { title: 'Somewhat related', url: 'https://news.com/1', content: 'Vaguely related', score: 0.5 },
        { title: 'Another one', url: 'https://news.com/2', content: 'Also vague', score: 0.6 },
        { title: 'Borderline', url: 'https://news.com/3', content: 'Almost', score: 0.7 }, // exactly 0.7 is NOT > 0.7
      ],
    }));

    const result = await executeToolCall('verify_claim', { claim: 'unverified claim' }) as any;
    assert.strictEqual(result.status, 'unverified');
    assert.ok(result.summary.includes('3'));
    assert.ok(result.summary.includes('相关度不高'));
  });

  it('returns unverified when no results found', async () => {
    fetchMock.mock.mockImplementation(async () => mockResponse({ results: [] }));

    const result = await executeToolCall('verify_claim', { claim: 'obscure claim' }) as any;
    assert.strictEqual(result.status, 'unverified');
    assert.ok(result.summary.includes('未找到'));
    assert.strictEqual(result.evidence.length, 0);
  });

  it('returns unverified when results field is missing', async () => {
    fetchMock.mock.mockImplementation(async () => mockResponse({}));

    const result = await executeToolCall('verify_claim', { claim: 'missing results' }) as any;
    assert.strictEqual(result.status, 'unverified');
    assert.strictEqual(result.evidence.length, 0);
  });

  it('returns error when Tavily API returns non-200', async () => {
    fetchMock.mock.mockImplementation(async () => mockResponse({}, 429));

    const result = await executeToolCall('verify_claim', { claim: 'rate limited' }) as any;
    assert.ok(result.error);
    assert.ok(result.error.includes('429'));
  });

  it('truncates evidence snippets to 300 chars', async () => {
    const longContent = 'A'.repeat(500);
    fetchMock.mock.mockImplementation(async () => mockResponse({
      results: [
        { title: 'Long article', url: 'https://example.com/1', content: longContent, score: 0.9 },
      ],
    }));

    const result = await executeToolCall('verify_claim', { claim: 'long content' }) as any;
    assert.strictEqual(result.evidence[0].snippet.length, 300);
  });

  it('limits evidence to 5 entries even with more results', async () => {
    const results = Array.from({ length: 8 }, (_, i) => ({
      title: `Result ${i}`, url: `https://example.com/${i}`, content: `Content ${i}`, score: 0.5,
    }));
    fetchMock.mock.mockImplementation(async () => mockResponse({ results }));

    const result = await executeToolCall('verify_claim', { claim: 'many results' }) as any;
    assert.strictEqual(result.evidence.length, 5);
  });
});

// ================================================================
// Mock-based tests — web_search with fetch mock
// ================================================================

describe('web_search with mock fetch', () => {
  let originalKey: string | undefined;
  let fetchMock: ReturnType<typeof mock.method>;

  beforeEach(() => {
    originalKey = process.env.TAVILY_API_KEY;
    process.env.TAVILY_API_KEY = 'test-key';
    fetchMock = mock.method(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchMock.mock.restore();
    if (originalKey) {
      process.env.TAVILY_API_KEY = originalKey;
    } else {
      delete process.env.TAVILY_API_KEY;
    }
  });

  it('passes correct parameters to Tavily API', async () => {
    fetchMock.mock.mockImplementation(async (_url: string, init: any) => {
      const body = JSON.parse(init.body);
      assert.strictEqual(body.query, 'Iran conflict');
      assert.strictEqual(body.topic, 'news');
      assert.strictEqual(body.search_depth, 'advanced');
      assert.strictEqual(body.max_results, 8);
      assert.strictEqual(body.time_range, 'week');
      assert.deepStrictEqual(body.include_domains, ['reuters.com']);
      return mockResponse({ results: [] });
    });

    await executeToolCall('web_search', {
      query: 'Iran conflict',
      topic: 'news',
      search_depth: 'advanced',
      time_range: 'week',
      include_domains: ['reuters.com'],
    });
  });

  it('returns error on Tavily API failure', async () => {
    fetchMock.mock.mockImplementation(async () => mockResponse({}, 500));

    const result = await executeToolCall('web_search', { query: 'test' }) as any;
    assert.ok(result.error);
    assert.ok(result.error.includes('500'));
  });

  it('returns Tavily response body on success', async () => {
    const expectedBody = { results: [{ title: 'Test', url: 'https://test.com' }] };
    fetchMock.mock.mockImplementation(async () => mockResponse(expectedBody));

    const result = await executeToolCall('web_search', { query: 'test' }) as any;
    assert.deepStrictEqual(result, expectedBody);
  });
});

// ================================================================
// Mock-based tests — web_extract with fetch mock
// ================================================================

describe('web_extract with mock fetch', () => {
  let originalKey: string | undefined;
  let fetchMock: ReturnType<typeof mock.method>;

  beforeEach(() => {
    originalKey = process.env.TAVILY_API_KEY;
    process.env.TAVILY_API_KEY = 'test-key';
    fetchMock = mock.method(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchMock.mock.restore();
    if (originalKey) {
      process.env.TAVILY_API_KEY = originalKey;
    } else {
      delete process.env.TAVILY_API_KEY;
    }
  });

  it('truncates URLs to max 5', async () => {
    fetchMock.mock.mockImplementation(async (_url: string, init: any) => {
      const body = JSON.parse(init.body);
      assert.strictEqual(body.urls.length, 5);
      return mockResponse({ results: [] });
    });

    const urls = Array.from({ length: 8 }, (_, i) => `https://example.com/${i}`);
    await executeToolCall('web_extract', { urls });
  });

  it('returns error on API failure', async () => {
    fetchMock.mock.mockImplementation(async () => mockResponse({}, 403));

    const result = await executeToolCall('web_extract', { urls: ['https://example.com'] }) as any;
    assert.ok(result.error);
    assert.ok(result.error.includes('403'));
  });

  it('calls Tavily extract endpoint (not search)', async () => {
    fetchMock.mock.mockImplementation(async (url: string) => {
      assert.ok((url as string).includes('/extract'), 'Should call /extract endpoint');
      return mockResponse({ results: [{ url: 'https://example.com', raw_content: 'Article text' }] });
    });

    await executeToolCall('web_extract', { urls: ['https://example.com'] });
  });
});
