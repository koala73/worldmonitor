import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import {
  YahooQuoteSummaryClient,
  buildCurlConfig,
  buildSectorSeedMeta,
  buildSectorValuationCoverage,
  buildSectorValuationPublication,
  parseV7Quote,
  parseV7QuoteBatch,
  parseCurlResponse,
  parseQuoteSummary,
  requestCurlText,
  requestHttpsText,
} from '../scripts/_yahoo-sector-valuations.cjs';

const cookieResponse = (cookie = 'A3=test-cookie') => ({
  status: 404,
  headers: { 'set-cookie': [`${cookie}; Path=/; Secure`] },
  body: '',
});

const crumbResponse = (crumb = 'test-crumb') => ({
  status: 200,
  headers: {},
  body: crumb,
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

const valuationResponse = (symbol = 'XLK') => ({
  status: 200,
  headers: {},
  body: JSON.stringify({
    quoteSummary: {
      result: [{
        symbol,
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

function symbolFromSummaryUrl(url) {
  const match = String(url).match(/\/quoteSummary\/([^?/]+)/);
  return match ? decodeURIComponent(match[1]) : 'XLK';
}

const v7ValuationResponse = (symbol = 'XLK') => ({
  status: 200,
  headers: {},
  body: JSON.stringify({
    quoteResponse: {
      result: [{ symbol, trailingPE: 31.2, forwardPE: 27.4, beta: 1.08 }],
      error: null,
    },
  }),
});

function requestKind(url) {
  if (url.includes('fc.yahoo.com')) return 'cookie';
  if (url.includes('/v1/test/getcrumb')) return 'crumb';
  if (url.includes('/v7/finance/quote?')) return 'v7';
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

  it('rejects quoteSummary payloads for a different requested symbol', () => {
    assert.deepEqual(parseQuoteSummary(JSON.stringify({
      quoteSummary: {
        result: [{
          symbol: 'XLF',
          summaryDetail: { trailingPE: { raw: 10 }, forwardPE: { raw: 9 } },
          defaultKeyStatistics: {},
        }],
      },
    }), 'XLK'), {
      kind: 'identity_mismatch',
      value: null,
      failure: 'quote_symbol_mismatch',
    });
  });

  it('accepts quoteSummary identity via price.symbol when top-level symbol is absent', () => {
    const result = parseQuoteSummary(JSON.stringify({
      quoteSummary: {
        result: [{
          price: { symbol: 'XLK' },
          summaryDetail: {
            trailingPE: { raw: 31.2 },
            forwardPE: { raw: 27.4 },
          },
          defaultKeyStatistics: {
            beta: { raw: 1.08 },
            ytdReturn: { raw: 0.16 },
            threeYearAverageReturn: { raw: 0.24 },
            fiveYearAverageReturn: { raw: 0.18 },
          },
        }],
      },
    }), 'XLK');
    assert.equal(result.kind, 'success');
    assert.equal(result.value.trailingPE, 31.2);
  });

  it('classifies a successful response with no PE fields as field-level loss', () => {
    assert.deepEqual(parseQuoteSummary(JSON.stringify({
      quoteSummary: {
        result: [{ summaryDetail: {}, defaultKeyStatistics: {} }],
      },
    })), {
      kind: 'missing_fields',
      value: {
        trailingPE: null,
        forwardPE: null,
        beta: null,
        ytdReturn: null,
        threeYearReturn: null,
        fiveYearReturn: null,
      },
      missingFields: ['trailingPE', 'forwardPE'],
    });
  });

  it('treats Yahoo display-only N/A values as missing numeric fields', () => {
    assert.deepEqual(parseQuoteSummary(JSON.stringify({
      quoteSummary: {
        result: [{
          summaryDetail: {
            trailingPE: { raw: null, fmt: 'N/A' },
            forwardPE: { raw: null, fmt: 'N/A' },
          },
          defaultKeyStatistics: {},
        }],
      },
    })), {
      kind: 'missing_fields',
      value: {
        trailingPE: null,
        forwardPE: null,
        beta: null,
        ytdReturn: null,
        threeYearReturn: null,
        fiveYearReturn: null,
      },
      missingFields: ['trailingPE', 'forwardPE'],
    });
  });

  it('rejects an error-bearing response even when Yahoo includes a result', () => {
    assert.deepEqual(parseV7Quote(JSON.stringify({
      quoteResponse: {
        result: [{ symbol: 'XLK', trailingPE: 25 }],
        error: { code: 'Unauthorized', description: 'not used as a diagnostic' },
      },
    })), {
      kind: 'upstream_error',
      value: null,
      failure: 'quote_response_error',
    });
  });
});

describe('YahooQuoteSummaryClient', () => {
  it('requests the price module so ETF quoteSummary responses carry symbol identity', async () => {
    let summaryUrl = '';
    const client = new YahooQuoteSummaryClient({
      directRequest: async (url) => {
        const kind = requestKind(url);
        if (kind === 'cookie') return cookieResponse();
        if (kind === 'crumb') return crumbResponse();
        summaryUrl = url;
        const response = valuationResponse('XLK');
        const body = JSON.parse(response.body);
        const result = body.quoteSummary.result[0];
        delete result.symbol;
        result.price = { symbol: 'XLK' };
        return { ...response, body: JSON.stringify(body) };
      },
      resolveProxyString: () => '',
      sleepFn: async () => {},
    });

    const result = await client.fetchDetailed('XLK');

    assert.equal(result.kind, 'success');
    assert.deepEqual(
      new URL(summaryUrl).searchParams.get('modules')?.split(',').sort(),
      ['defaultKeyStatistics', 'price', 'summaryDetail'],
    );
  });

  it('bounds direct and proxy Invalid Crumb retries, cools down, then recovers', async () => {
    let now = 1_700_000_000_000;
    let recovered = false;
    const calls = [];
    const sessions = { direct: 0, proxy: 0 };
    const summaryRequests = [];
    const warnings = [];

    const makeRequest = (transport) => async (url, options) => {
      const kind = requestKind(url);
      calls.push(`${transport}:${kind}`);
      if (kind === 'cookie') {
        sessions[transport]++;
        return cookieResponse(`A3=${transport}-cookie-${sessions[transport]}`);
      }
      if (kind === 'crumb') return crumbResponse(`${transport}-crumb-${sessions[transport]}`);
      if (kind === 'summary') {
        summaryRequests.push({
          transport,
          cookie: options?.headers?.Cookie,
          url,
        });
      }
      const isFreshSession = url.includes(`crumb=${transport}-crumb-${sessions[transport]}`)
        && sessions[transport] > 1;
      return recovered && isFreshSession
        ? valuationResponse(symbolFromSummaryUrl(url))
        : unauthorizedResponse();
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
    for (const transport of ['direct', 'proxy']) {
      const requests = summaryRequests.filter((request) => request.transport === transport);
      assert.equal(requests.length, 2);
      assert.equal(requests[0].cookie, `A3=${transport}-cookie-1`);
      assert.equal(requests[1].cookie, `A3=${transport}-cookie-2`);
      assert.match(requests[0].url, new RegExp(`crumb=${transport}-crumb-1`));
      assert.match(requests[1].url, new RegExp(`crumb=${transport}-crumb-2`));
    }

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

  it('bounds upstream failure descriptions before logging route diagnostics', async () => {
    const warnings = [];
    const client = new YahooQuoteSummaryClient({
      directRequest: async () => ({
        status: 503,
        headers: {},
        body: JSON.stringify({ finance: { error: { description: `${'provider detail '.repeat(100)}\nnext line` } } }),
      }),
      sleepFn: async () => {},
      logger: { warn: (message, context) => warnings.push({ message, context }) },
    });

    assert.equal(await client.fetch('XLK'), null);
    assert.ok(warnings[0].context.failure.length <= 170);
    assert.doesNotMatch(warnings[0].context.failure, /\s{2,}|\n/);
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
        return valuationResponse(symbolFromSummaryUrl(url));
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

  it('falls back to proxy when direct quoteSummary fields are display-only N/A', async () => {
    const calls = [];
    const client = new YahooQuoteSummaryClient({
      directRequest: async (url) => {
        calls.push(`direct:${requestKind(url)}`);
        const kind = requestKind(url);
        if (kind === 'cookie') return cookieResponse('A3=direct-cookie');
        if (kind === 'crumb') return crumbResponse('direct-crumb');
        return {
          status: 200,
          headers: {},
          body: JSON.stringify({
            quoteSummary: {
              result: [{
                summaryDetail: {
                  trailingPE: { raw: null, fmt: 'N/A' },
                  forwardPE: { raw: null, fmt: 'N/A' },
                },
                defaultKeyStatistics: {},
              }],
            },
          }),
        };
      },
      proxyRequest: async (url) => {
        calls.push(`proxy:${requestKind(url)}`);
        const kind = requestKind(url);
        if (kind === 'cookie') return cookieResponse('A3=proxy-cookie');
        if (kind === 'crumb') return crumbResponse('proxy-crumb');
        return valuationResponse(symbolFromSummaryUrl(url));
      },
      resolveProxyString: () => 'proxy.example:10000',
      sleepFn: async () => {},
      logger: { warn() {} },
    });

    const result = await client.fetch('XLK');
    assert.equal(result?.source, 'yahoo_quote_summary_authenticated_proxy');
    assert.deepEqual(calls, ['direct:cookie', 'direct:crumb', 'direct:summary', 'proxy:cookie', 'proxy:crumb', 'proxy:summary']);
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
        return valuationResponse(symbolFromSummaryUrl(url));
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
        return valuationResponse(symbolFromSummaryUrl(url));
      },
      requestSpacingMs: 150,
      sleepFn: async (ms) => delays.push(ms),
    });

    await client.fetch('XLK');
    assert.deepEqual(delays, [150, 150, 150]);
  });

  it('uses the authenticated cookie and crumb session for v7 valuation quotes', async () => {
    const calls = [];
    const client = new YahooQuoteSummaryClient({
      directRequest: async (url, options) => {
        calls.push({ url, options });
        const kind = requestKind(url);
        if (kind === 'cookie') return cookieResponse('A3=v7-cookie');
        if (kind === 'crumb') return crumbResponse('v7-crumb');
        assert.equal(kind, 'v7');
        return v7ValuationResponse();
      },
      sleepFn: async () => {},
    });

    const result = await client.fetchV7Detailed('XLK');
    assert.equal(result.kind, 'success');
    assert.equal(result.value.source, 'yahoo_v7_quote_authenticated_direct');
    assert.equal(calls.length, 3);
    assert.equal(calls[2].options.headers.Cookie, 'A3=v7-cookie');
    assert.match(calls[2].url, /symbols=XLK&crumb=v7-crumb/);
  });

  it('rejects a v7 response for a different requested symbol without cooling the route', async () => {
    const warnings = [];
    let now = 1_700_000_000_000;
    const client = new YahooQuoteSummaryClient({
      directRequest: async (url) => {
        const kind = requestKind(url);
        if (kind === 'cookie') return cookieResponse('A3=v7-cookie');
        if (kind === 'crumb') return crumbResponse('v7-crumb');
        return v7ValuationResponse('XLF');
      },
      sleepFn: async () => {},
      now: () => now,
      logger: { warn: (message, context) => warnings.push({ message, context }) },
    });

    const result = await client.fetchV7Detailed('XLK');
    assert.equal(result.kind, 'identity_mismatch');
    assert.equal(result.diagnostic.responseClass, 'identity_mismatch');
    assert.equal(result.diagnostic.failure, 'quote_symbol_mismatch');
    assert.equal(warnings.length, 0, 'identity mismatch must not arm a multi-minute cooldown');

    // A second call immediately after must still attempt the network path
    // (not short-circuit as cooldown).
    const second = await client.fetchV7Detailed('XLK');
    assert.equal(second.kind, 'identity_mismatch');
    assert.equal(warnings.length, 0);
    now += 1; // keep clock stable for readability
  });

  it('keeps quoteSummary usable after a v7Quote route cooldown', async () => {
    let now = 1_700_000_000_000;
    const calls = [];
    const client = new YahooQuoteSummaryClient({
      directRequest: async (url) => {
        const kind = requestKind(url);
        calls.push(kind);
        if (kind === 'cookie') return cookieResponse('A3=shared-cookie');
        if (kind === 'crumb') return crumbResponse('shared-crumb');
        if (kind === 'v7') {
          return {
            status: 503,
            headers: {},
            body: JSON.stringify({ quoteResponse: { error: { description: 'upstream down' } } }),
          };
        }
        return valuationResponse(symbolFromSummaryUrl(url));
      },
      sleepFn: async () => {},
      now: () => now,
      cooldownMs: 300_000,
      logger: { warn() {} },
    });

    const v7 = await client.fetchV7Detailed('XLK');
    assert.equal(v7.kind, 'failed');
    assert.equal(v7.diagnostic.status, 503);

    const summary = await client.fetchDetailed('XLK');
    assert.equal(summary.kind, 'success', 'quoteSummary must not inherit the v7Quote cooldown');
    assert.equal(summary.value.trailingPE, 31.2);
    assert.ok(calls.includes('summary'), 'quoteSummary request must still fire after v7 failure');
  });

  it('preserves the shared session after a non-auth route failure', async () => {
    let cookieBootstraps = 0;
    const client = new YahooQuoteSummaryClient({
      directRequest: async (url) => {
        const kind = requestKind(url);
        if (kind === 'cookie') {
          cookieBootstraps += 1;
          return cookieResponse(`A3=cookie-${cookieBootstraps}`);
        }
        if (kind === 'crumb') return crumbResponse(`crumb-${cookieBootstraps}`);
        if (kind === 'v7') {
          return {
            status: 500,
            headers: {},
            body: '{}',
          };
        }
        return valuationResponse(symbolFromSummaryUrl(url));
      },
      sleepFn: async () => {},
      cooldownMs: 300_000,
      logger: { warn() {} },
    });

    await client.fetchV7Detailed('XLK');
    assert.equal(cookieBootstraps, 1);
    await client.fetchDetailed('XLF');
    assert.equal(cookieBootstraps, 1, '5xx on v7 must not force a full cookie re-bootstrap for quoteSummary');
  });
});

describe('parseV7Quote', () => {
  it('parses authenticated v7 valuation fields', () => {
    const result = parseV7Quote(JSON.stringify({
      quoteResponse: {
        result: [{ trailingPE: 25.3, forwardPE: 22.1, beta: 1.05 }],
      },
    }));
    assert.equal(result.kind, 'success');
    assert.equal(result.value.trailingPE, 25.3);
    assert.equal(result.value.forwardPE, 22.1);
    assert.equal(result.value.beta, 1.05);
  });

  it('records a field-level absence when a usable valuation is partial', () => {
    assert.deepEqual(parseV7Quote(JSON.stringify({
      quoteResponse: {
        result: [{ trailingPE: 25.3, beta: 1.05 }],
      },
    })), {
      kind: 'success',
      value: {
        trailingPE: 25.3,
        forwardPE: null,
        beta: 1.05,
        ytdReturn: null,
        threeYearReturn: null,
        fiveYearReturn: null,
      },
      missingFields: ['forwardPE'],
    });
  });

  it('rejects a response whose symbol does not match the requested ticker', () => {
    assert.deepEqual(parseV7Quote(JSON.stringify({
      quoteResponse: { result: [{ symbol: 'XLF', trailingPE: 25.3, forwardPE: 22.1 }] },
    }), 'XLK'), {
      kind: 'identity_mismatch',
      value: null,
      failure: 'quote_symbol_mismatch',
    });
  });

  it('classifies a symbol with no PE fields as unavailable', () => {
    assert.deepEqual(parseV7Quote(JSON.stringify({
      quoteResponse: { result: [{ beta: 1.1 }] },
    })), {
      kind: 'missing_fields',
      value: {
        trailingPE: null,
        forwardPE: null,
        beta: 1.1,
        ytdReturn: null,
        threeYearReturn: null,
        fiveYearReturn: null,
      },
      missingFields: ['trailingPE', 'forwardPE'],
    });
  });
});

describe('parseV7QuoteBatch', () => {
  it('maps one authenticated batch response back to requested symbols', () => {
    const result = parseV7QuoteBatch(JSON.stringify({
      quoteResponse: {
        result: [
          { symbol: 'XLK', trailingPE: 25.3, beta: 1.05 },
          { symbol: 'SMH', trailingPE: 37.2, beta: 1.2 },
        ],
      },
    }), ['XLK', 'SMH']);

    assert.equal(result.kind, 'success');
    assert.equal(result.value.valuations.XLK.trailingPE, 25.3);
    assert.equal(result.value.valuations.SMH.trailingPE, 37.2);
  });

  // A batch that covered only some requested symbols must NOT report route
  // success: _fetchRoute returns on the first successful transport, so calling
  // this 'success' would deny the uncovered symbols the proxy leg.
  it('reports partial (not success) when some requested symbols are uncovered', () => {
    const result = parseV7QuoteBatch(JSON.stringify({
      quoteResponse: {
        result: [
          { symbol: 'XLK', trailingPE: 25.3, beta: 1.05 },
          { symbol: 'SMH', trailingPE: 37.2, beta: 1.2 },
        ],
      },
    }), ['XLK', 'SMH', 'XLV']);

    assert.equal(result.kind, 'partial');
    assert.equal(result.value.valuations.XLK.trailingPE, 25.3);
    assert.equal(result.value.outcomes.XLV.kind, 'no_data');
    assert.ok(!('XLV' in result.value.valuations));
  });

  it('reports a fully unmatched batch by its first outcome, not success', () => {
    const result = parseV7QuoteBatch(JSON.stringify({
      quoteResponse: { result: [{ symbol: 'SPY', trailingPE: 21 }] },
    }), ['XLK', 'SMH']);

    assert.equal(result.kind, 'no_data');
    assert.deepEqual(result.value.valuations, {});
    assert.equal(result.value.outcomes.XLK.kind, 'no_data');
  });

  it('classifies an upstream error envelope without inventing valuations', () => {
    const result = parseV7QuoteBatch(JSON.stringify({
      quoteResponse: { error: 'Invalid crumb', result: null },
    }), ['XLK']);

    assert.equal(result.kind, 'upstream_error');
    assert.equal(result.failure, 'quote_response_error');
    assert.equal(result.value, null);
  });

  it('returns invalid_json for a garbage body', () => {
    assert.equal(parseV7QuoteBatch('<html>429</html>', ['XLK']).kind, 'invalid_json');
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

  it('publishes unavailable symbols, route diagnostics, and stale last-good provenance', () => {
    const coverage = buildSectorValuationCoverage({
      valuationCount: 8,
      expectedCount: 12,
      fetchedAt,
      sources: ['yahoo_v7_quote_authenticated_direct'],
      unavailableSymbols: ['SMH', 'XLK'],
      valuationDiagnostics: [{
        symbol: 'XLK',
        outcomes: [{ route: 'v7Quote', transport: 'direct', responseClass: 'http_401' }],
      }],
      lastGoodFetchedAt: fetchedAt - 60_000,
      lastGoodMetricsUsed: ['XLF'],
    });
    assert.deepEqual(coverage.unavailableSymbols, ['SMH', 'XLK']);
    assert.deepEqual(coverage.valuationDiagnostics[0].outcomes[0], {
      route: 'v7Quote',
      transport: 'direct',
      responseClass: 'http_401',
    });
    assert.deepEqual(coverage.lastGood, {
      fetchedAt: fetchedAt - 60_000,
      stale: true,
      symbols: ['XLF'],
    });
  });

  it('keeps coverage partial when stale last-good records fill missing symbols', () => {
    const coverage = buildSectorValuationCoverage({
      valuationCount: 12,
      expectedCount: 12,
      currentValuationCount: 8,
      fetchedAt,
      sources: ['yahoo_v7_quote_authenticated_direct'],
      unavailableSymbols: ['SMH', 'XLK', 'XLV', 'XLY'],
      lastGoodFetchedAt: fetchedAt - 60_000,
      lastGoodValuationSymbols: ['SMH', 'XLK', 'XLV', 'XLY'],
    });

    assert.equal(coverage.valuationCount, 12);
    assert.equal(coverage.currentValuationCount, 8);
    assert.equal(coverage.sourceStatus, 'partial');
    assert.equal(coverage.seedSourceState, 'partial');
    assert.equal(coverage.errorCode, 'SECTOR_VALUATIONS_PARTIAL');
    assert.deepEqual(coverage.staleValuationSymbols, ['SMH', 'XLK', 'XLV', 'XLY']);
    assert.deepEqual(coverage.lastGood, {
      fetchedAt: fetchedAt - 60_000,
      stale: true,
      symbols: ['SMH', 'XLK', 'XLV', 'XLY'],
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

  it('keeps bounded route diagnostics in both the public payload and seed metadata', () => {
    const valuationDiagnostics = [{
      symbol: 'XLK',
      outcomes: [{ route: 'v7Quote', transport: 'direct', responseClass: 'http_401' }],
    }];
    const valuationCoverage = buildSectorValuationCoverage({
      valuationCount: 8,
      expectedCount: 12,
      fetchedAt: 1_700_000_000_000,
      sources: ['yahoo_v7_quote_authenticated_direct'],
      unavailableSymbols: ['SMH'],
      valuationDiagnostics,
      lastGoodFetchedAt: 1_699_999_000_000,
      lastGoodMetricsUsed: ['XLF'],
    });

    const publication = buildSectorValuationPublication({
      sectors: [{ symbol: 'XLK' }],
      valuations: { XLK: { trailingPE: 25 } },
      valuationCoverage,
    });

    assert.deepEqual(publication.payload.valuationCoverage.valuationDiagnostics, valuationDiagnostics);
    assert.deepEqual(publication.meta.valuationDiagnostics, valuationDiagnostics);
    assert.deepEqual(publication.payload.valuationCoverage.lastGood, {
      fetchedAt: 1_699_999_000_000,
      stale: true,
      symbols: ['XLF'],
    });
  });
});

describe('sector seed metadata write contract', () => {
  it('does not advance freshness when the canonical payload write fails', () => {
    const sectorMeta = {
      fetchedAt: 1_700_000_000_000,
      recordCount: 12,
      valuationRecordCount: 12,
      expectedValuationRecordCount: 12,
      valuationSourceStatus: 'ok',
      valuationSource: 'yahoo_v7_quote_authenticated_direct',
      sourceState: 'ok',
      sourceVersion: 'market-sectors',
    };

    assert.deepEqual(buildSectorSeedMeta(sectorMeta, false), {
      recordCount: 12,
      valuationRecordCount: 12,
      expectedValuationRecordCount: 12,
      valuationSourceStatus: 'ok',
      valuationSource: 'yahoo_v7_quote_authenticated_direct',
      sourceState: 'error',
      sourceVersion: 'market-sectors',
      fetchedAt: null,
      errorCode: 'SECTOR_DATA_WRITE_FAILED',
    });
    assert.deepEqual(buildSectorSeedMeta(sectorMeta, true), sectorMeta);
  });
});

// Yahoo populates its quote fundamentals cache PER RESIDENTIAL EXIT IP. Measured
// on 2026-08-05 across 10 rotated Decodo sticky exits: 3 returned trailingPE for
// all 12 sector ETFs, 7 dropped the entire 9-key fundamentals block for exactly
// XLK/XLV/XLY/SMH. The seeder pins one sticky port, so a pinned bad exit makes
// every 5-minute cycle partial -- the observed 46/61 partial rate matches the
// ~70% bad-exit rate. Retrying the SAME exit can never recover those symbols;
// only landing on a different exit can.
const v7BatchResponse = (symbols, { truncated = [] } = {}) => ({
  status: 200,
  headers: {},
  body: JSON.stringify({
    quoteResponse: {
      result: symbols.map((symbol) => (
        truncated.includes(symbol)
          // A truncated row is HTTP 200 with the fundamentals keys absent --
          // not an error, and not a null-valued field.
          ? { symbol, regularMarketPrice: 100 }
          : { symbol, trailingPE: 31.2, beta: 1.08 }
      )),
      error: null,
    },
  }),
});

function symbolsFromQuoteUrl(url) {
  return (new URL(url).searchParams.get('symbols') || '').split(',').filter(Boolean);
}

/**
 * Simulates the measured upstream: `badExits` drop fundamentals for `truncated`
 * symbols; every other exit serves them. Records one entry per request so a test
 * can assert exit rotation, per-exit session isolation, and request volume.
 */
function exitHarness({ badExits = [], truncated = [], directTruncated = true } = {}) {
  const requests = [];
  const sessionsByExit = new Map();

  const handle = (transport) => async (url, options) => {
    const kind = requestKind(url);
    const exit = transport === 'direct' ? 'direct' : String(options?.proxy || '');
    requests.push({ transport, exit, kind, cookie: options?.headers?.Cookie, url });
    if (kind === 'cookie') {
      sessionsByExit.set(exit, (sessionsByExit.get(exit) || 0) + 1);
      return cookieResponse(`A3=${exit}-cookie-${sessionsByExit.get(exit)}`);
    }
    if (kind === 'crumb') return crumbResponse(`${exit}-crumb-${sessionsByExit.get(exit)}`);
    const symbols = symbolsFromQuoteUrl(url);
    const isBad = transport === 'direct' ? directTruncated : badExits.includes(exit);
    return v7BatchResponse(symbols, { truncated: isBad ? truncated : [] });
  };

  return {
    requests,
    directRequest: handle('direct'),
    proxyRequest: handle('proxy'),
    quoteRequests: () => requests.filter((r) => r.kind === 'v7'),
    exitsTried: () => [...new Set(
      requests.filter((r) => r.kind === 'v7' && r.transport === 'proxy').map((r) => r.exit),
    )],
  };
}

describe('YahooQuoteSummaryClient exit rotation', () => {
  const SECTORS = ['XLK', 'XLF', 'XLV'];
  const TRUNCATED = ['XLK', 'XLV'];

  it('does not issue a request for an empty symbol set', async () => {
    let requests = 0;
    const client = new YahooQuoteSummaryClient({
      directRequest: async () => { requests += 1; throw new Error('unexpected direct request'); },
      proxyRequest: async () => { requests += 1; throw new Error('unexpected proxy request'); },
      resolveProxyString: () => 'exit-0',
      resolveProxyStringForAttempt: (attempt) => `exit-${attempt}`,
      sleepFn: async () => {},
      logger: { warn: () => {} },
    });

    const result = await client.fetchV7BatchAcrossExits([]);

    assert.equal(requests, 0);
    assert.equal(result.kind, 'no_data');
    assert.equal(result.stopReason, 'complete');
    assert.equal(result.exitsTried, 0);
  });

  it('rotates onto a fresh exit when a 200 response omits the fundamentals block', async () => {
    const harness = exitHarness({ badExits: ['exit-0', 'exit-1'], truncated: TRUNCATED });
    const client = new YahooQuoteSummaryClient({
      directRequest: harness.directRequest,
      proxyRequest: harness.proxyRequest,
      resolveProxyString: () => 'exit-0',
      resolveProxyStringForAttempt: (attempt) => `exit-${attempt}`,
      sleepFn: async () => {},
      logger: { warn: () => {} },
    });

    const result = await client.fetchV7BatchAcrossExits(SECTORS);

    assert.equal(result.kind, 'success');
    assert.deepEqual(
      Object.keys(result.value.valuations).sort(),
      ['XLF', 'XLK', 'XLV'],
      'every symbol is recovered once a good exit is reached',
    );
    assert.equal(result.value.valuations.XLK.trailingPE, 31.2);
    assert.equal(result.lastExitAttempt, 2, 'reports the exit that completed coverage');
    assert.deepEqual(harness.exitsTried(), ['exit-0', 'exit-1', 'exit-2']);
  });

  it('gives each exit its own cookie and crumb', async () => {
    const harness = exitHarness({ badExits: ['exit-0'], truncated: TRUNCATED });
    const client = new YahooQuoteSummaryClient({
      directRequest: harness.directRequest,
      proxyRequest: harness.proxyRequest,
      resolveProxyString: () => 'exit-0',
      resolveProxyStringForAttempt: (attempt) => `exit-${attempt}`,
      sleepFn: async () => {},
      logger: { warn: () => {} },
    });

    await client.fetchV7BatchAcrossExits(SECTORS);

    // A crumb is bound to the cookie that minted it, and Yahoo ties both to the
    // originating IP. Reusing exit-0's session on exit-1 would authenticate as
    // the exit we are trying to leave.
    const quotes = harness.quoteRequests().filter((r) => r.transport === 'proxy');
    assert.ok(quotes.length >= 2);
    for (const request of quotes) {
      assert.equal(
        request.cookie,
        `A3=${request.exit}-cookie-1`,
        `${request.exit} must use its own cookie`,
      );
      assert.match(request.url, new RegExp(`crumb=${request.exit}-crumb-1`));
    }
  });

  it('stops rotating the moment coverage is complete', async () => {
    const harness = exitHarness({ badExits: [], truncated: TRUNCATED });
    const client = new YahooQuoteSummaryClient({
      directRequest: harness.directRequest,
      proxyRequest: harness.proxyRequest,
      resolveProxyString: () => 'exit-0',
      resolveProxyStringForAttempt: (attempt) => `exit-${attempt}`,
      maxExitAttempts: 8,
      sleepFn: async () => {},
      logger: { warn: () => {} },
    });

    const result = await client.fetchV7BatchAcrossExits(SECTORS);

    assert.equal(result.kind, 'success');
    // Proxy bandwidth is metered and a Decodo traffic limit has taken the fleet
    // down before: a good first exit must cost exactly one proxy quote request.
    assert.deepEqual(harness.exitsTried(), ['exit-0']);
  });

  it('bounds rotation at maxExitAttempts and keeps whatever it recovered', async () => {
    const harness = exitHarness({
      badExits: ['exit-0', 'exit-1', 'exit-2', 'exit-3', 'exit-4', 'exit-5'],
      truncated: TRUNCATED,
    });
    const client = new YahooQuoteSummaryClient({
      directRequest: harness.directRequest,
      proxyRequest: harness.proxyRequest,
      resolveProxyString: () => 'exit-0',
      resolveProxyStringForAttempt: (attempt) => `exit-${attempt}`,
      maxExitAttempts: 3,
      sleepFn: async () => {},
      logger: { warn: () => {} },
    });

    const result = await client.fetchV7BatchAcrossExits(SECTORS);

    assert.equal(harness.exitsTried().length, 3, 'rotation is capped');
    assert.equal(result.kind, 'partial');
    assert.equal(result.stopReason, 'attempt_cap_exhausted');
    assert.deepEqual(
      Object.keys(result.value.valuations),
      ['XLF'],
      'symbols the exits did cover are still returned for publication',
    );
    assert.equal(result.value.outcomes.XLK.kind, 'missing_fields');
  });

  it('classifies a fully consumed exit window as attempt-cap exhaustion at the deadline boundary', async () => {
    let now = 1_700_000_000_000;
    const deadlineAt = now + 1_000;
    const harness = exitHarness({ badExits: ['exit-0'], truncated: TRUNCATED });
    const client = new YahooQuoteSummaryClient({
      directRequest: harness.directRequest,
      proxyRequest: async (url, options) => {
        const response = await harness.proxyRequest(url, options);
        if (requestKind(url) === 'v7') now = deadlineAt;
        return response;
      },
      resolveProxyString: () => 'exit-0',
      resolveProxyStringForAttempt: (attempt) => `exit-${attempt}`,
      maxExitAttempts: 1,
      now: () => now,
      sleepFn: async () => {},
      logger: { warn: () => {} },
    });

    const result = await client.fetchV7BatchAcrossExits(SECTORS, { deadlineAt });

    assert.equal(result.kind, 'partial');
    assert.equal(result.stopReason, 'attempt_cap_exhausted');
    assert.equal(result.lastExitAttempt, 0);
    assert.equal(result.exitsTried, 1, 'the entire one-exit window was consumed');
    assert.deepEqual(harness.exitsTried(), ['exit-0']);
  });

  it('stops rotating when the valuation budget is spent', async () => {
    let now = 1_700_000_000_000;
    const harness = exitHarness({
      badExits: ['exit-0', 'exit-1', 'exit-2', 'exit-3', 'exit-4', 'exit-5', 'exit-6', 'exit-7'],
      truncated: TRUNCATED,
    });
    const client = new YahooQuoteSummaryClient({
      directRequest: harness.directRequest,
      proxyRequest: harness.proxyRequest,
      resolveProxyString: () => 'exit-0',
      resolveProxyStringForAttempt: (attempt) => `exit-${attempt}`,
      maxExitAttempts: 8,
      now: () => now,
      // Every paced gap advances the clock, so the deadline lands mid-rotation.
      sleepFn: async () => { now += 400; },
      logger: { warn: () => {} },
    });

    const result = await client.fetchV7BatchAcrossExits(SECTORS, { deadlineAt: now + 1_500 });

    assert.ok(harness.exitsTried().length < 8, 'the budget cuts rotation short');
    assert.ok(['partial', 'deadline_exceeded', 'missing_fields'].includes(result.kind));
    assert.equal(result.stopReason, 'deadline');
  });

  it('starts from the caller-supplied exit so a known-good exit is tried first', async () => {
    const harness = exitHarness({ badExits: ['exit-0', 'exit-1'], truncated: TRUNCATED });
    const client = new YahooQuoteSummaryClient({
      directRequest: harness.directRequest,
      proxyRequest: harness.proxyRequest,
      resolveProxyString: () => 'exit-0',
      resolveProxyStringForAttempt: (attempt) => `exit-${attempt}`,
      sleepFn: async () => {},
      logger: { warn: () => {} },
    });

    const result = await client.fetchV7BatchAcrossExits(SECTORS, { startExitAttempt: 2 });

    assert.equal(result.kind, 'success');
    assert.deepEqual(harness.exitsTried(), ['exit-2'], 'the cached exit is used first, not exit-0');
    assert.equal(result.lastExitAttempt, 2);
  });

  it('nominates the exit that covered the most symbols, not the last one tried', async () => {
    // Coverage can be assembled across exits. Persisting the LAST attempt as the
    // preferred exit poisons the next cycle: it starts on an exit that serves
    // only the tail of the set, then rotates fruitlessly for the rest. The best
    // single starting point is the exit that covered the most.
    const serves = { 'exit-5': ['XLK', 'XLF'], 'exit-6': ['XLK', 'XLF', 'XLV'] };
    const client = new YahooQuoteSummaryClient({
      directRequest: async () => { throw new Error('no direct'); },
      proxyRequest: async (url, options) => {
        const kind = requestKind(url);
        const exit = String(options?.proxy || '');
        if (kind === 'cookie') return cookieResponse(`A3=${exit}`);
        if (kind === 'crumb') return crumbResponse(`${exit}-crumb`);
        const requested = symbolsFromQuoteUrl(url);
        const served = serves[exit] || [];
        return v7BatchResponse(requested, {
          truncated: requested.filter((s) => !served.includes(s)),
        });
      },
      resolveProxyString: () => 'exit-5',
      resolveProxyStringForAttempt: (attempt) => `exit-${attempt}`,
      sleepFn: async () => {},
      logger: { warn: () => {} },
    });

    const result = await client.fetchV7BatchAcrossExits(SECTORS, { startExitAttempt: 5 });

    assert.equal(result.kind, 'success');
    assert.deepEqual(result.exitBySymbol, { XLK: 5, XLF: 5, XLV: 6 });
    assert.equal(result.lastExitAttempt, 6, 'lastExitAttempt reports the last exit tried');
    assert.equal(
      result.bestExitAttempt,
      6,
      'exit 6 covers the full original set, so it is the better next start',
    );
  });

  it('breaks a best-exit tie toward the earlier exit so the choice is deterministic', async () => {
    const serves = { 'exit-0': ['XLK'], 'exit-1': ['XLF'], 'exit-2': ['XLV'] };
    const client = new YahooQuoteSummaryClient({
      directRequest: async () => { throw new Error('no direct'); },
      proxyRequest: async (url, options) => {
        const kind = requestKind(url);
        const exit = String(options?.proxy || '');
        if (kind === 'cookie') return cookieResponse(`A3=${exit}`);
        if (kind === 'crumb') return crumbResponse(`${exit}-crumb`);
        const requested = symbolsFromQuoteUrl(url);
        const served = serves[exit] || [];
        return v7BatchResponse(requested, {
          truncated: requested.filter((s) => !served.includes(s)),
        });
      },
      resolveProxyString: () => 'exit-0',
      resolveProxyStringForAttempt: (attempt) => `exit-${attempt}`,
      sleepFn: async () => {},
      logger: { warn: () => {} },
    });

    const result = await client.fetchV7BatchAcrossExits(SECTORS);

    assert.equal(result.bestExitAttempt, 0);
  });

  it('reports no best exit when no exit served anything', async () => {
    const harness = exitHarness({
      badExits: ['exit-0', 'exit-1', 'exit-2'],
      truncated: SECTORS,
      directTruncated: true,
    });
    const client = new YahooQuoteSummaryClient({
      directRequest: harness.directRequest,
      proxyRequest: harness.proxyRequest,
      resolveProxyString: () => 'exit-0',
      resolveProxyStringForAttempt: (attempt) => `exit-${attempt}`,
      maxExitAttempts: 3,
      sleepFn: async () => {},
      logger: { warn: () => {} },
    });

    const result = await client.fetchV7BatchAcrossExits(SECTORS);

    assert.equal(result.bestExitAttempt, null, 'nothing was learned, so nothing is nominated');
  });

  it('labels the source by which leg actually supplied rows', async () => {
    // The direct/proxy union treats an empty proxy valuations map as a
    // contribution, so a direct-served row gets published with proxy
    // provenance. Health metadata must not claim a fetch that never happened.
    const client = new YahooQuoteSummaryClient({
      directRequest: async (url) => {
        const kind = requestKind(url);
        if (kind === 'cookie') return cookieResponse('A3=direct');
        if (kind === 'crumb') return crumbResponse('direct-crumb');
        return v7BatchResponse(symbolsFromQuoteUrl(url), { truncated: ['XLV'] });
      },
      proxyRequest: async (url) => {
        const kind = requestKind(url);
        if (kind === 'cookie') return cookieResponse('A3=proxy');
        if (kind === 'crumb') return crumbResponse('proxy-crumb');
        // Proxy covers nothing: its valuations map is present but empty.
        return v7BatchResponse(symbolsFromQuoteUrl(url), { truncated: symbolsFromQuoteUrl(url) });
      },
      resolveProxyString: () => 'exit-0',
      sleepFn: async () => {},
      logger: { warn: () => {} },
    });

    const result = await client.fetchV7BatchAcrossExits(['XLK', 'XLV']);

    assert.deepEqual(Object.keys(result.value.valuations), ['XLK']);
    assert.deepEqual(result.exitBySymbol, {}, 'a direct row is not credited to a proxy exit');
    assert.equal(result.bestExitAttempt, null, 'a direct row cannot nominate a proxy exit');
    assert.equal(result.value.outcomes.XLK.kind, 'success', 'the serving direct outcome is retained');
    assert.match(
      result.value.valuations.XLK.source,
      /_direct$/,
      'XLK came from the direct leg, so the source must not claim proxy',
    );
  });

  it('preserves per-symbol provenance when direct and proxy legs both contribute', async () => {
    const client = new YahooQuoteSummaryClient({
      directRequest: async (url) => {
        const kind = requestKind(url);
        if (kind === 'cookie') return cookieResponse('A3=direct');
        if (kind === 'crumb') return crumbResponse('direct-crumb');
        return v7BatchResponse(symbolsFromQuoteUrl(url), { truncated: ['XLV'] });
      },
      proxyRequest: async (url) => {
        const kind = requestKind(url);
        if (kind === 'cookie') return cookieResponse('A3=proxy');
        if (kind === 'crumb') return crumbResponse('proxy-crumb');
        return v7BatchResponse(symbolsFromQuoteUrl(url), { truncated: ['XLK'] });
      },
      resolveProxyString: () => 'exit-0',
      sleepFn: async () => {},
      logger: { warn: () => {} },
    });

    const result = await client.fetchV7BatchAcrossExits(['XLK', 'XLV']);

    assert.deepEqual(result.exitBySymbol, { XLV: 0 });
    assert.match(result.value.valuations.XLK.source, /_direct$/);
    assert.match(result.value.valuations.XLV.source, /_proxy$/);
    assert.equal(result.value.outcomes.XLK.kind, 'success');
    assert.equal(result.value.outcomes.XLV.kind, 'success');
  });

  it('attributes each symbol to the exit that actually served it', async () => {
    // XLF comes back on the first exit; XLK/XLV only on the third. Reporting one
    // batch-wide exit would credit XLF to an exit it never touched.
    const client = new YahooQuoteSummaryClient({
      directRequest: async () => { throw new Error('no direct'); },
      proxyRequest: async (url, options) => {
        const kind = requestKind(url);
        const exit = String(options?.proxy || '');
        if (kind === 'cookie') return cookieResponse(`A3=${exit}`);
        if (kind === 'crumb') return crumbResponse(`${exit}-crumb`);
        const requested = symbolsFromQuoteUrl(url);
        return v7BatchResponse(requested, {
          truncated: exit === 'exit-2' ? [] : TRUNCATED,
        });
      },
      resolveProxyString: () => 'exit-0',
      resolveProxyStringForAttempt: (attempt) => `exit-${attempt}`,
      sleepFn: async () => {},
      logger: { warn: () => {} },
    });

    const result = await client.fetchV7BatchAcrossExits(SECTORS);

    assert.equal(result.kind, 'success');
    assert.equal(result.exitBySymbol.XLF, 0, 'XLF was served by the first exit');
    assert.equal(result.exitBySymbol.XLK, 2);
    assert.equal(result.exitBySymbol.XLV, 2);
    assert.equal(result.exitsTried, 3);
  });

  it('reports how many exits were tried for a symbol none of them covered', async () => {
    const harness = exitHarness({
      badExits: ['exit-0', 'exit-1', 'exit-2', 'exit-3'],
      truncated: TRUNCATED,
    });
    const client = new YahooQuoteSummaryClient({
      directRequest: harness.directRequest,
      proxyRequest: harness.proxyRequest,
      resolveProxyString: () => 'exit-0',
      resolveProxyStringForAttempt: (attempt) => `exit-${attempt}`,
      maxExitAttempts: 3,
      sleepFn: async () => {},
      logger: { warn: () => {} },
    });

    const result = await client.fetchV7BatchAcrossExits(SECTORS);

    assert.equal(result.exitsTried, 3);
    assert.equal(result.exitBySymbol.XLK, undefined, 'no exit served XLK, so none is claimed');
    assert.equal(result.exitBySymbol.XLF, 0);
  });

  it('does not let one exit\'s durable failure cool down the others', async () => {
    // A 500 on exit-0 is evidence about exit-0, not about the endpoint. Sharing
    // one cooldown across exits would suppress the rotation that recovers from
    // exactly this, for the whole cooldown window.
    const seen = [];
    const client = new YahooQuoteSummaryClient({
      directRequest: async () => { throw new Error('no direct'); },
      proxyRequest: async (url, options) => {
        const kind = requestKind(url);
        const exit = String(options?.proxy || '');
        if (kind === 'cookie') return cookieResponse(`A3=${exit}`);
        if (kind === 'crumb') return crumbResponse(`${exit}-crumb`);
        seen.push(exit);
        if (exit === 'exit-0') return { status: 500, headers: {}, body: '' };
        return v7BatchResponse(symbolsFromQuoteUrl(url));
      },
      resolveProxyString: () => 'exit-0',
      resolveProxyStringForAttempt: (attempt) => `exit-${attempt}`,
      cooldownMs: 300_000,
      sleepFn: async () => {},
      logger: { warn: () => {} },
    });

    const result = await client.fetchV7BatchAcrossExits(SECTORS);

    assert.equal(result.kind, 'success', 'rotation survives a durable failure on one exit');
    assert.ok(seen.includes('exit-1'), 'the next exit is still reachable');
  });

  it('falls back to the default cap for out-of-range maxExitAttempts', async () => {
    // Every other test passes 3, 6, or 8, so the clamp branch was never executed.
    // A 0 slipping through would disable rotation entirely and silently restore
    // the pinned-exit behaviour this whole change exists to remove.
    for (const [configured, expectedAttempts] of [[0, 4], [-1, 4], [2.5, 4], [1, 1], [2, 2]]) {
      const harness = exitHarness({
        badExits: Array.from({ length: 12 }, (_, i) => `exit-${i}`),
        truncated: TRUNCATED,
      });
      const client = new YahooQuoteSummaryClient({
        directRequest: harness.directRequest,
        proxyRequest: harness.proxyRequest,
        resolveProxyString: () => 'exit-0',
        resolveProxyStringForAttempt: (attempt) => `exit-${attempt}`,
        maxExitAttempts: configured,
        sleepFn: async () => {},
        logger: { warn: () => {} },
      });

      const result = await client.fetchV7BatchAcrossExits(SECTORS);

      assert.equal(
        result.exitsTried,
        expectedAttempts,
        `maxExitAttempts: ${configured}`,
      );
    }
  });

  it('gives up quickly when every exit fails the same way', async () => {
    // A Decodo quota 407 or credential expiry fails identically on every exit.
    // Per-exit cooldowns no longer suppress that the way one shared key did, so
    // rotation must stop itself rather than probing the whole pool each cycle
    // against a provider that is already refusing traffic.
    const attempts = [];
    const client = new YahooQuoteSummaryClient({
      directRequest: async () => { throw new Error('no direct'); },
      proxyRequest: async (_url, options) => {
        attempts.push(String(options?.proxy || ''));
        return { status: 407, headers: {}, body: '' };
      },
      resolveProxyString: () => 'exit-0',
      resolveProxyStringForAttempt: (attempt) => `exit-${attempt}`,
      maxExitAttempts: 8,
      cooldownMs: 300_000,
      sleepFn: async () => {},
      logger: { warn: () => {} },
    });

    const result = await client.fetchV7BatchAcrossExits(SECTORS);

    assert.equal(result.exitsTried, 2, 'one retry for a flaky exit, then stop');
    assert.equal(new Set(attempts).size, 2);
    assert.equal(result.bestExitAttempt, null);
    assert.equal(result.stopReason, 'durable_failures');
  });

  it('counts proxy failures even when the direct leg returned a partial batch', async () => {
    const client = new YahooQuoteSummaryClient({
      directRequest: async (url) => {
        const kind = requestKind(url);
        if (kind === 'cookie') return cookieResponse('A3=direct');
        if (kind === 'crumb') return crumbResponse('direct-crumb');
        return v7BatchResponse(symbolsFromQuoteUrl(url), { truncated: TRUNCATED });
      },
      proxyRequest: async () => ({ status: 407, headers: {}, body: '' }),
      resolveProxyString: () => 'exit-0',
      resolveProxyStringForAttempt: (attempt) => `exit-${attempt}`,
      maxExitAttempts: 6,
      sleepFn: async () => {},
      logger: { warn: () => {} },
    });

    const result = await client.fetchV7BatchAcrossExits(SECTORS);

    assert.equal(result.exitsTried, 2, 'the provider-wide proxy failure stops after one retry');
    assert.deepEqual(Object.keys(result.value.valuations), ['XLF']);
    assert.equal(result.exitBySymbol.XLF, undefined, 'the direct row is not credited to a failed exit');
    assert.equal(result.stopReason, 'durable_failures');
  });

  it('stops rotating when the resolver cannot actually change the exit', async () => {
    // Non-Decodo providers and Decodo's rotating (non-sticky) ports return the
    // same route for every attempt, so further attempts re-query the identical
    // exit. Rotation cannot help there, and the requests are billed anyway.
    const quotes = [];
    const client = new YahooQuoteSummaryClient({
      directRequest: async () => { throw new Error('no direct'); },
      proxyRequest: async (url, options) => {
        const kind = requestKind(url);
        if (kind === 'cookie') return cookieResponse('A3=fixed');
        if (kind === 'crumb') return crumbResponse('fixed-crumb');
        quotes.push(String(options?.proxy || ''));
        return v7BatchResponse(symbolsFromQuoteUrl(url), { truncated: TRUNCATED });
      },
      resolveProxyString: () => 'fixed',
      resolveProxyStringForAttempt: () => 'fixed',
      maxExitAttempts: 6,
      sleepFn: async () => {},
      logger: { warn: () => {} },
    });

    const result = await client.fetchV7BatchAcrossExits(SECTORS);

    assert.equal(quotes.length, 1, 'one query against the only reachable exit, not six');
    assert.equal(result.exitsTried, 1);
    assert.equal(result.stopReason, 'repeated_route');
  });

  it('stops rotating when no proxy is configured at all', async () => {
    const harness = exitHarness({ badExits: [], truncated: TRUNCATED });
    const client = new YahooQuoteSummaryClient({
      directRequest: harness.directRequest,
      proxyRequest: harness.proxyRequest,
      resolveProxyString: () => '',
      // Wired, but yields nothing -- PROXY_URL unset. Looping would re-run the
      // same direct-only leg maxExitAttempts times for no new information.
      resolveProxyStringForAttempt: () => '',
      maxExitAttempts: 6,
      sleepFn: async () => {},
      logger: { warn: () => {} },
    });

    const result = await client.fetchV7BatchAcrossExits(SECTORS);

    const directQuotes = harness.quoteRequests().filter((r) => r.transport === 'direct');
    assert.equal(directQuotes.length, 1, 'the direct leg runs once, not once per attempt');
    assert.deepEqual(Object.keys(result.value.valuations), ['XLF']);
    assert.equal(result.stopReason, 'no_route');
  });

  it('falls back to the single-exit batch when no rotating resolver is wired', async () => {
    const harness = exitHarness({ badExits: ['exit-0'], truncated: TRUNCATED });
    const client = new YahooQuoteSummaryClient({
      directRequest: harness.directRequest,
      proxyRequest: harness.proxyRequest,
      resolveProxyString: () => 'exit-0',
      sleepFn: async () => {},
      logger: { warn: () => {} },
    });

    const result = await client.fetchV7BatchAcrossExits(SECTORS);

    assert.deepEqual(harness.exitsTried(), ['exit-0'], 'no rotation without a resolver');
    assert.equal(result.value.outcomes.XLK.kind, 'missing_fields');
    assert.equal(result.stopReason, 'single_exit');
  });
});
