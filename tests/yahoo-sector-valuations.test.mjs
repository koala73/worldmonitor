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
