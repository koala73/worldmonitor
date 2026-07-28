import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, describe, it } from 'node:test';

import { EDGAR_UPSTREAM_TIMEOUT_MS } from '../server/_shared/sec-edgar';
import {
  COMPANY_INTEL_SEARCH_TIMEOUT_MS,
  COMPANY_INTEL_TOOL,
} from '../api/mcp/registry/company-intel-tools';

const originalFetch = globalThis.fetch;
const toolContext = { kind: 'env_key', apiKey: 'wm-test-key' } as never;
const execute = COMPANY_INTEL_TOOL._execute;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function captureFetch(payload: unknown) {
  const requests: Array<{ url: string; signal?: AbortSignal | null }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({
      url: String(input instanceof Request ? input.url : input),
      signal: init?.signal,
    });
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
  return requests;
}

describe('get_company_intelligence MCP tool view dispatch', () => {
  it('requires ticker or name for enrichment and signals views', async () => {
    captureFetch({});
    assert.deepEqual(await execute({}, 'https://x.test', toolContext), { view: 'enrichment', error: 'ticker_or_name_required' });
    assert.deepEqual(await execute({ view: 'signals' }, 'https://x.test', toolContext), { view: 'signals', error: 'ticker_or_name_required' });
  });

  it('requires query for filings-search', async () => {
    captureFetch({});
    assert.deepEqual(
      await execute({ view: 'filings-search', query: '  ' }, 'https://x.test', toolContext),
      { view: 'filings-search', error: 'query_required' },
    );
  });

  it('leaves headroom beyond EDGAR and attaches a real request deadline', async () => {
    assert.ok(
      COMPANY_INTEL_SEARCH_TIMEOUT_MS > EDGAR_UPSTREAM_TIMEOUT_MS,
      `MCP timeout ${COMPANY_INTEL_SEARCH_TIMEOUT_MS}ms must exceed EDGAR ${EDGAR_UPSTREAM_TIMEOUT_MS}ms`,
    );
    const requests = captureFetch({ results: [] });
    await execute({ view: 'filings-search', query: 'merger' }, 'https://x.test', toolContext);
    assert.ok(requests[0]?.signal instanceof AbortSignal);
    assert.equal(requests[0]?.signal?.aborted, false);
  });

  it('falls back to the enrichment view for unknown view values', async () => {
    const requests = captureFetch({ company: {} });
    const result = await execute({ view: 'bogus', ticker: 'AAPL' }, 'https://x.test', toolContext) as Record<string, unknown>;
    assert.equal(result.view, 'enrichment');
    assert.match(requests[0]?.url ?? '', /\/api\/intelligence\/v1\/get-company-enrichment\?ticker=AAPL/);
  });

  it('routes each view to its REST path and honors in-range limits', async () => {
    const requests = captureFetch({ results: [], events: [], signals: [] });
    await execute({ view: 'signals', ticker: 'AAPL' }, 'https://x.test', toolContext);
    await execute({ view: 'filings-search', query: 'merger', limit: 25 }, 'https://x.test', toolContext);
    await execute({ view: 'material-events', item_code: '5.02', limit: 100 }, 'https://x.test', toolContext);
    assert.match(requests[0]?.url ?? '', /\/api\/intelligence\/v1\/list-company-signals\?ticker=AAPL/);
    assert.match(requests[1]?.url ?? '', /\/api\/intelligence\/v1\/search-sec-filings\?.*limit=25/);
    assert.match(requests[2]?.url ?? '', /\/api\/intelligence\/v1\/list-material-events\?.*limit=100/);
    assert.match(requests[2]?.url ?? '', /item_code=5\.02/);
  });

  it('rejects a limit above the view maximum instead of silently clamping it', async () => {
    const requests = captureFetch({ results: [] });
    assert.deepEqual(
      await execute({ view: 'filings-search', query: 'merger', limit: 100 }, 'https://x.test', toolContext),
      { view: 'filings-search', error: 'limit_out_of_range' },
    );
    assert.deepEqual(
      await execute({ view: 'material-events', limit: 101 }, 'https://x.test', toolContext),
      { view: 'material-events', error: 'limit_out_of_range' },
    );
    assert.deepEqual(requests, [], 'a rejected limit must not reach the REST route');
  });

  it('publishes nested schemas agents can project without a discovery call', () => {
    const schema = COMPANY_INTEL_TOOL.outputSchema as any;
    assert.equal(schema.properties.enrichment.properties.secFilings.properties.recentFilings.items.properties.items.items.type, 'string');
    assert.equal(schema.properties.enrichment.properties.earningsSurprises.items.properties.surprisePercent.type, 'number');
    assert.equal(schema.properties.enrichment.properties.newsMentions.items.properties.publishedAtMs.type, 'number');
    assert.equal(schema.properties.signals.properties.summary.properties.byType.additionalProperties.type, 'number');
    assert.equal(schema.properties.search.properties.results.items.properties.accession.type, 'string');
    assert.equal(schema.properties.events.properties.events.items.properties.items.items.properties.code.type, 'string');
  });
});

describe('generated corporate-intelligence OpenAPI contract', () => {
  it('marks the SEC full-text query parameter required', () => {
    const spec = JSON.parse(readFileSync(
      new URL('../docs/api/IntelligenceService.openapi.json', import.meta.url),
      'utf8',
    )) as {
      paths?: Record<string, { get?: { parameters?: Array<{ name?: string; required?: boolean }> } }>;
    };
    const params = spec.paths?.['/api/intelligence/v1/search-sec-filings']?.get?.parameters ?? [];
    const query = params.find(parameter => parameter.name === 'query');
    assert.equal(query?.required, true);
  });
});
