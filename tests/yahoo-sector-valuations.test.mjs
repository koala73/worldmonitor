import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import {
  YahooQuoteSummaryClient,
  buildCurlConfig,
  buildSectorValuationCoverage,
  buildSectorValuationPublication,
  parseCurlResponse,
  parseQuoteSummary,
  requestCurlText,
  requestHttpsText,
} from '../scripts/_yahoo-sector-valuations.cjs';

const cookieResponse = () => ({
  status: 404,
  headers: { 'set-cookie': ['A3=test-cookie; Path=/; Secure'] },
  body: '',
});

const crumbResponse = () => ({
  status: 200,
  headers: {},
  body: 'test-crumb',
});

const unauthorizedResponse = () => ({
  status: 401,
  headers: {},
  body: JSON.stringify({
    finance: {
      result: null,
      error: { code: 'Unauthorized', description: 'Invalid Crumb' },
    },
  }),
});

const valuationResponse = () => ({
  status: 200,
  headers: {},
  body: JSON.stringify({
    quoteSummary: {
      result: [{
        summaryDetail: {
          trailingPE: { raw: 31.2 },
          forwardPE: { raw: 27.4 },
        },
        defaultKeyStatistics: {
          beta3Year: { raw: 1.08 },
          ytdReturn: { raw: 0.16 },
          threeYearAverageReturn: { raw: 0.24 },
          fiveYearAverageReturn: { raw: 0.18 },
        },
      }],
      error: null,
    },
  }),
});

function requestKind(url) {
  if (url.includes('fc.yahoo.com')) return 'cookie';
  if (url.includes('/v1/test/getcrumb')) return 'crumb';
  if (url.includes('/v10/finance/quoteSummary/')) return 'summary';
  throw new Error(`Unexpected Yahoo URL: ${url}`);
}

describe('requestHttpsText', () => {
  it('rejects and destroys direct responses larger than 2 MiB', async () => {
    let requestDestroyed = false;
    let responseDestroyed = false;
    const httpsGet = (_url, _options, onResponse) => {
      const request = new EventEmitter();
      request.destroy = () => {
        requestDestroyed = true;
      };

      queueMicrotask(() => {
        const response = new EventEmitter();
        response.statusCode = 200;
        response.headers = {};
        response.setEncoding = () => {};
        response.destroy = () => {
          responseDestroyed = true;
        };
        onResponse(response);
        response.emit('data', 'a'.repeat(2 * 1024 * 1024));
        response.emit('data', 'b');
        response.emit('end');
      });
      return request;
    };

    await assert.rejects(
      requestHttpsText('https://query1.finance.yahoo.com/test', { httpsGet }),
      (error) => {
        assert.equal(error.code, 'RESPONSE_TOO_LARGE');
        assert.doesNotMatch(error.message, /a{100}/);
        return true;
      },
    );
    assert.equal(requestDestroyed, true);
    assert.equal(responseDestroyed, true);
  });
});

describe('requestCurlText', () => {
  function fakeCurlProcess(responseText, onSpawn) {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = new EventEmitter();
    child.kill = () => {};
    child.stdin.end = (config) => {
      onSpawn(config);
      queueMicrotask(() => {
        child.stdout.emit('data', responseText);
        child.emit('close', 0, null);
      });
    };
    return child;
  }

  it('keeps proxy credentials and Yahoo cookies out of curl argv', async () => {
    const secretProxy = 'proxy-user:proxy-password@proxy.example:10000';
    const secretCookie = 'A3=private-cookie';
    let spawnedArgs;
    let config;
    const responseText = 'HTTP/1.1 200 OK\r\ncontent-type: application/json\r\n\r\n{}\n__WM_HTTP_STATUS__:200';
    const result = await requestCurlText('https://query1.finance.yahoo.com/test', {
      proxy: secretProxy,
      headers: { Cookie: secretCookie },
      spawnFn: (command, args) => {
        assert.equal(command, 'curl');
        spawnedArgs = args;
        return fakeCurlProcess(responseText, (input) => { config = input; });
      },
    });

    assert.equal(result.status, 200);
    assert.equal(spawnedArgs.includes(secretProxy), false);
    assert.equal(spawnedArgs.some((arg) => arg.includes(secretCookie)), false);
    assert.match(config, /proxy = "http:\/\/proxy-user:proxy-password@proxy\.example:10000"/);
    assert.match(config, /header = "Cookie: A3=private-cookie"/);
    assert.match(buildCurlConfig('https://query1.finance.yahoo.com/test', {
      proxy: secretProxy,
      headers: { Cookie: secretCookie },
    }), /url = "https:\/\/query1\.finance\.yahoo\.com\/test"/);
  });

  it('bounds proxy response buffering', async () => {
    let killed = false;
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = new EventEmitter();
    child.kill = () => { killed = true; };
    child.stdin.end = () => {
      queueMicrotask(() => child.stdout.emit('data', Buffer.alloc(2 * 1024 * 1024 + 1, 'x')));
    };

    await assert.rejects(
      requestCurlText('https://query1.finance.yahoo.com/test', {
        proxy: 'proxy.example:10000',
        spawnFn: () => child,
      }),
      (error) => error.code === 'RESPONSE_TOO_LARGE',
    );
    assert.equal(killed, true);
  });
});

describe('parseQuoteSummary', () => {
  it('classifies malformed upstream JSON as invalid_json', () => {
    assert.deepEqual(parseQuoteSummary('{not-json'), { kind: 'invalid_json', value: null });
  });

  it('classifies an empty Yahoo result as no_data', () => {
    assert.deepEqual(parseQuoteSummary(JSON.stringify({ quoteSummary: { result: [] } })), {
      kind: 'no_data',
      value: null,
    });
  });
});

describe('YahooQuoteSummaryClient', () => {
  it('bounds direct and proxy Invalid Crumb retries, cools down, then recovers', async () => {
    let now = 1_700_000_000_000;
    let recovered = false;
    const calls = [];
    const warnings = [];

    const makeRequest = (transport) => async (url) => {
      const kind = requestKind(url);
      calls.push(`${transport}:${kind}`);
      if (kind === 'cookie') return cookieResponse();
      if (kind === 'crumb') return crumbResponse();
      return recovered ? valuationResponse() : unauthorizedResponse();
    };

    const client = new YahooQuoteSummaryClient({
      directRequest: makeRequest('direct'),
      proxyRequest: makeRequest('proxy'),
      resolveProxyString: () => 'redacted-proxy',
      now: () => now,
      cooldownMs: 300_000,
      sleepFn: async () => {},
      logger: { warn: (message, context) => warnings.push({ message, context }) },
    });

    assert.equal(await client.fetch('XLK'), null);
    assert.equal(
      calls.filter((call) => call === 'direct:summary').length,
      2,
      'a direct 401 refreshes the session exactly once',
    );
    assert.equal(
      calls.filter((call) => call === 'proxy:summary').length,
      2,
      'a proxy 401 refreshes the session exactly once',
    );
    assert.equal(warnings.length, 2, 'one bounded warning is emitted per failed route');
    assert.deepEqual(
      warnings.map((warning) => warning.context.transport),
      ['direct', 'proxy'],
      'route identity is structured rather than parsed from log text',
    );

    const callsAfterFailure = calls.length;
    assert.equal(await client.fetch('XLF'), null);
    assert.equal(calls.length, callsAfterFailure, 'cooldown prevents per-symbol retry storms');

    recovered = true;
    now += 300_001;
    const recoveredValue = await client.fetch('XLE');
    assert.deepEqual(recoveredValue, {
      trailingPE: 31.2,
      forwardPE: 27.4,
      beta: 1.08,
      ytdReturn: 0.16,
      threeYearReturn: 0.24,
      fiveYearReturn: 0.18,
      source: 'yahoo_quote_summary_authenticated_direct',
    });
  });

  it('never includes proxy credentials in transport failure logs', async () => {
    const secretProxy = 'proxy-user:proxy-password@proxy.example:10000';
    const warnings = [];
    const client = new YahooQuoteSummaryClient({
      directRequest: async () => ({ status: 503, headers: {}, body: '' }),
      proxyRequest: async () => {
        throw new Error(`Command failed: curl -x http://${secretProxy}`);
      },
      resolveProxyString: () => secretProxy,
      sleepFn: async () => {},
      logger: { warn: (message, context) => warnings.push({ message, context }) },
    });

    assert.equal(await client.fetch('XLK'), null);
    assert.equal(warnings.at(-1).context.transport, 'proxy');
    assert.doesNotMatch(JSON.stringify(warnings), /proxy-user|proxy-password/);
  });

  it('falls back to an authenticated proxy route and forwards its session', async () => {
    const proxyCalls = [];
    const client = new YahooQuoteSummaryClient({
      directRequest: async () => ({ status: 503, headers: {}, body: '' }),
      proxyRequest: async (url, options) => {
        proxyCalls.push({ url, options });
        const kind = requestKind(url);
        if (kind === 'cookie') return cookieResponse();
        if (kind === 'crumb') return crumbResponse();
        return valuationResponse();
      },
      resolveProxyString: () => 'proxy-user:proxy-password@proxy.example:10000',
      sleepFn: async () => {},
      logger: { warn() {} },
    });

    const value = await client.fetch('XLK');
    assert.equal(value?.source, 'yahoo_quote_summary_authenticated_proxy');
    assert.equal(proxyCalls.length, 3);
    assert.ok(proxyCalls.every((call) => call.options.proxy.includes('proxy.example')));
    assert.match(proxyCalls[2].url, /crumb=test-crumb/);
    assert.equal(proxyCalls[2].options.headers.Cookie, 'A3=test-cookie');
  });

  it('reuses an authenticated session until its TTL expires', async () => {
    let now = 1_700_000_000_000;
    const calls = [];
    const client = new YahooQuoteSummaryClient({
      directRequest: async (url) => {
        const kind = requestKind(url);
        calls.push(kind);
        if (kind === 'cookie') return cookieResponse();
        if (kind === 'crumb') return crumbResponse();
        return valuationResponse();
      },
      now: () => now,
      sessionTtlMs: 60_000,
      sleepFn: async () => {},
    });

    await client.fetch('XLK');
    await client.fetch('XLF');
    assert.equal(calls.filter((call) => call === 'cookie').length, 1);
    assert.equal(calls.filter((call) => call === 'crumb').length, 1);
    assert.equal(calls.filter((call) => call === 'summary').length, 2);

    now += 60_001;
    await client.fetch('XLE');
    assert.equal(calls.filter((call) => call === 'cookie').length, 2);
    assert.equal(calls.filter((call) => call === 'crumb').length, 2);
  });

  it('paces every Yahoo authentication and summary request', async () => {
    const delays = [];
    const client = new YahooQuoteSummaryClient({
      directRequest: async (url) => {
        const kind = requestKind(url);
        if (kind === 'cookie') return cookieResponse();
        if (kind === 'crumb') return crumbResponse();
        return valuationResponse();
      },
      requestSpacingMs: 150,
      sleepFn: async (ms) => delays.push(ms),
    });

    await client.fetch('XLK');
    assert.deepEqual(delays, [150, 150, 150]);
  });
});

describe('parseCurlResponse', () => {
  it('ignores the proxy CONNECT preamble and parses the upstream response', () => {
    const parsed = parseCurlResponse([
      'HTTP/1.1 200 Connection established',
      '',
      'HTTP/2 401',
      'content-type: application/json',
      'set-cookie: A3=proxy-cookie; Path=/',
      '',
      '{"finance":{"error":{"description":"Invalid Crumb"}}}',
      '__WM_HTTP_STATUS__:401',
    ].join('\r\n').replace('\r\n__WM_HTTP_STATUS__:', '\n__WM_HTTP_STATUS__:'));

    assert.equal(parsed.status, 401);
    assert.deepEqual(parsed.headers['set-cookie'], ['A3=proxy-cookie; Path=/']);
    assert.equal(
      JSON.parse(parsed.body).finance.error.description,
      'Invalid Crumb',
    );
  });
});

describe('buildSectorValuationCoverage', () => {
  const fetchedAt = 1_700_000_000_000;

  it('marks partial valuation coverage separately from sector prices', () => {
    assert.deepEqual(buildSectorValuationCoverage({
      valuationCount: 3,
      expectedCount: 12,
      fetchedAt,
      sources: ['yahoo_quote_summary_authenticated_direct'],
    }), {
      valuationCount: 3,
      expectedValuationCount: 12,
      sourceStatus: 'partial',
      source: 'yahoo_quote_summary_authenticated_direct',
      fetchedAt,
      stale: false,
      seedSourceState: 'partial',
      errorCode: 'SECTOR_VALUATIONS_PARTIAL',
    });
  });

  it('marks total valuation loss degraded instead of healthy', () => {
    assert.deepEqual(buildSectorValuationCoverage({
      valuationCount: 0,
      expectedCount: 12,
      fetchedAt,
      sources: [],
    }), {
      valuationCount: 0,
      expectedValuationCount: 12,
      sourceStatus: 'degraded',
      source: 'yahoo_quote_summary_authenticated',
      fetchedAt,
      stale: false,
      seedSourceState: 'error',
      errorCode: 'SECTOR_VALUATIONS_UNAVAILABLE',
    });
  });

  it('clears degraded state after full recovery', () => {
    assert.deepEqual(buildSectorValuationCoverage({
      valuationCount: 12,
      expectedCount: 12,
      fetchedAt,
      sources: [
        'yahoo_quote_summary_authenticated_proxy',
        'yahoo_quote_summary_authenticated_direct',
      ],
    }), {
      valuationCount: 12,
      expectedValuationCount: 12,
      sourceStatus: 'ok',
      source: 'yahoo_quote_summary_authenticated_direct+yahoo_quote_summary_authenticated_proxy',
      fetchedAt,
      stale: false,
      seedSourceState: 'ok',
      errorCode: null,
    });
  });
});

describe('buildSectorValuationPublication', () => {
  it('builds the exact cache payload and degraded seed metadata', () => {
    const sectors = [{ symbol: 'XLK', name: 'XLK', change: 1.2 }];
    const valuations = {};
    const valuationCoverage = buildSectorValuationCoverage({
      valuationCount: 0,
      expectedCount: 12,
      fetchedAt: 1_700_000_000_000,
      sources: [],
    });

    assert.deepEqual(buildSectorValuationPublication({
      sectors,
      valuations,
      valuationCoverage,
    }), {
      payload: {
        sectors,
        valuations,
        valuationCoverage: {
          valuationCount: 0,
          expectedValuationCount: 12,
          sourceStatus: 'degraded',
          source: 'yahoo_quote_summary_authenticated',
          fetchedAt: 1_700_000_000_000,
          stale: false,
        },
      },
      meta: {
        fetchedAt: 1_700_000_000_000,
        recordCount: 1,
        sectorRecordCount: 1,
        valuationRecordCount: 0,
        expectedValuationRecordCount: 12,
        valuationSourceStatus: 'degraded',
        valuationSource: 'yahoo_quote_summary_authenticated',
        sourceState: 'error',
        sourceVersion: 'market-sectors',
        errorCode: 'SECTOR_VALUATIONS_UNAVAILABLE',
      },
    });
  });
});
