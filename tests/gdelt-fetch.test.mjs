// Executable transport regressions for the GDELT production route.
//
// The outage this guards against was amplification, not a missing retry:
// Railway direct was blocked, the shared proxy was also failing, and one DOC
// query repeated those paths before the seeder launched more DOC queries.

import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  _PROXY_DEFAULTS,
  classifyGdeltFetchError,
  fetchGdeltJson,
  resolveGdeltProxy,
  resolveGdeltProxyRoute,
} from '../scripts/_gdelt-fetch.mjs';
import { curlFetch } from '../scripts/_seed-utils.mjs';

const URL = 'https://api.gdeltproject.org/api/v2/doc/doc?query=climate&mode=ArtList&format=json';
const PAYLOAD = { articles: [{ url: 'https://example.com/x', title: 'foo' }] };
const savedProxyEnv = {
  GDELT_PROXY_URL: process.env.GDELT_PROXY_URL,
  PROXY_URL: process.env.PROXY_URL,
};

function setProxyEnv(values = {}) {
  delete process.env.GDELT_PROXY_URL;
  delete process.env.PROXY_URL;
  Object.assign(process.env, values);
}

afterEach(() => {
  for (const [name, value] of Object.entries(savedProxyEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

test('production defaults bind the GDELT-specific resolver and curl transport', () => {
  assert.equal(_PROXY_DEFAULTS.curlProxyResolver, resolveGdeltProxy);
  assert.equal(_PROXY_DEFAULTS.proxyRouteResolver, resolveGdeltProxyRoute);
  assert.equal(_PROXY_DEFAULTS.curlFetcher, curlFetch);
});

test('GDELT_PROXY_URL wins over PROXY_URL and skips the known-blocked direct route', async () => {
  setProxyEnv({
    GDELT_PROXY_URL: 'http://gdelt-user:gdelt-pass@gdelt-proxy.test:8100',
    PROXY_URL: 'http://shared-user:shared-pass@shared-proxy.test:8200',
  });
  const proxyAuths = [];
  let directCalls = 0;

  const result = await fetchGdeltJson(URL, {
    label: 'military',
    _fetch: async () => {
      directCalls += 1;
      throw new Error('direct route must not run when a proxy is configured');
    },
    _proxyCurlFetcher: (_url, proxyAuth) => {
      proxyAuths.push(proxyAuth);
      return JSON.stringify(PAYLOAD);
    },
  });

  assert.deepEqual(result, PAYLOAD);
  assert.equal(directCalls, 0);
  assert.equal(proxyAuths.length, 1, 'selected route is attempted exactly once');
  assert.match(proxyAuths[0], /@gdelt-proxy\.test:8100$/);
  assert.doesNotMatch(proxyAuths[0], /shared-proxy/);
});

test('the GDELT proxy path gives curl 30 seconds for slow residential TLS handshakes', async () => {
  setProxyEnv({ GDELT_PROXY_URL: 'http://user:pass@gdelt-proxy.test:8100' });
  let transportOptions;

  await fetchGdeltJson(URL, {
    label: 'military',
    _proxyCurlFetcher: (_url, _proxyAuth, _headers, options) => {
      transportOptions = options;
      return JSON.stringify(PAYLOAD);
    },
  });

  assert.deepEqual(transportOptions, { timeoutMs: 30_000 });
});

test('curlFetch applies its caller timeout to curl and leaves a bounded process grace period', () => {
  let invocation;
  const result = curlFetch(
    URL,
    'user:pass@gdelt-proxy.test:8100',
    { Accept: 'application/json' },
    {
      timeoutMs: 30_000,
      exec: (command, args, options) => {
        invocation = { command, args, options };
        return `${JSON.stringify(PAYLOAD)}\n200`;
      },
    },
  );

  const maxTimeIndex = invocation.args.indexOf('--max-time');
  assert.equal(invocation.command, 'curl');
  assert.equal(invocation.args[maxTimeIndex + 1], '30');
  assert.equal(invocation.options.timeout, 35_000);
  assert.deepEqual(JSON.parse(result), PAYLOAD);
});

test('curlFetch keeps the 15-second ceiling for callers that do not override it', () => {
  let invocation;
  curlFetch(URL, null, {}, {
    exec: (_command, args, options) => {
      invocation = { args, options };
      return `${JSON.stringify(PAYLOAD)}\n200`;
    },
  });

  const maxTimeIndex = invocation.args.indexOf('--max-time');
  assert.equal(invocation.args[maxTimeIndex + 1], '15');
  assert.equal(invocation.options.timeout, 20_000);
});

test('PROXY_URL remains the compatibility route when GDELT_PROXY_URL is absent', async () => {
  setProxyEnv({ PROXY_URL: 'http://user:pass@shared-proxy.test:8200' });
  const proxyAuths = [];

  await fetchGdeltJson(URL, {
    label: 'military',
    _fetch: async () => { throw new Error('direct route must not run'); },
    _proxyCurlFetcher: (_url, proxyAuth) => {
      proxyAuths.push(proxyAuth);
      return JSON.stringify(PAYLOAD);
    },
  });

  assert.equal(proxyAuths.length, 1);
  assert.match(proxyAuths[0], /@shared-proxy\.test:8200$/);
});

test('malformed configured proxies fail closed instead of falling through to direct', async () => {
  for (const [env, expectedCode] of [
    [{ GDELT_PROXY_URL: 'not-a-proxy' }, 'GDELT_SOURCE_PROXY_CONFIG'],
    [{ PROXY_URL: 'not-a-proxy' }, 'GDELT_SHARED_PROXY_CONFIG'],
  ]) {
    setProxyEnv(env);
    let directCalls = 0;
    await assert.rejects(
      fetchGdeltJson(URL, {
        label: 'military',
        _fetch: async () => {
          directCalls += 1;
          throw new Error('known-blocked direct route must not run');
        },
      }),
      (error) => {
        assert.equal(error.code, expectedCode);
        return true;
      },
    );
    assert.equal(directCalls, 0);
  }
});

test('a caller cannot opt into direct while a proxy route is configured', async () => {
  setProxyEnv({ GDELT_PROXY_URL: 'http://user:pass@gdelt-proxy.test:8100' });
  let directCalls = 0;
  await assert.rejects(
    fetchGdeltJson(URL, {
      proxyMaxAttempts: 0,
      _fetch: async () => {
        directCalls += 1;
        throw new Error('known-blocked direct route must not run');
      },
    }),
    /direct fallback is disabled when a proxy is configured/,
  );
  assert.equal(directCalls, 0);
});

test('without a configured proxy, direct is attempted once', async () => {
  setProxyEnv();
  let directCalls = 0;
  const result = await fetchGdeltJson(URL, {
    label: 'military',
    _fetch: async () => {
      directCalls += 1;
      return new Response(JSON.stringify(PAYLOAD), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
    _proxyCurlFetcher: () => { throw new Error('proxy must not run'); },
  });
  assert.deepEqual(result, PAYLOAD);
  assert.equal(directCalls, 1);
});

test('proxy HTTP 429 is classified and not retried', async () => {
  setProxyEnv({ GDELT_PROXY_URL: 'http://user:pass@gdelt-proxy.test:8100' });
  let proxyCalls = 0;
  await assert.rejects(
    fetchGdeltJson(URL, {
      label: 'military',
      _fetch: async () => { throw new Error('direct must not run'); },
      _proxyCurlFetcher: () => {
        proxyCalls += 1;
        throw Object.assign(new Error('HTTP 429'), { status: 429 });
      },
    }),
    (error) => {
      assert.equal(error.code, 'GDELT_SOURCE_PROXY_HTTP_429');
      assert.equal(error.route, 'source-proxy');
      return true;
    },
  );
  assert.equal(proxyCalls, 1);
});

test('proxy SSL_ERROR_SYSCALL is classified as TLS and not retried', async () => {
  setProxyEnv({ GDELT_PROXY_URL: 'http://user:pass@gdelt-proxy.test:8100' });
  let proxyCalls = 0;
  await assert.rejects(
    fetchGdeltJson(URL, {
      label: 'military',
      _proxyCurlFetcher: () => {
        proxyCalls += 1;
        throw new Error('curl failed: OpenSSL SSL_connect: SSL_ERROR_SYSCALL');
      },
    }),
    (error) => {
      assert.equal(error.code, 'GDELT_SOURCE_PROXY_TLS');
      return true;
    },
  );
  assert.equal(proxyCalls, 1);
});

test('direct 429 and timeout failures retain bounded route-specific codes', async () => {
  setProxyEnv();
  for (const [failure, expected] of [
    [Object.assign(new Error('HTTP 429'), { status: 429 }), 'GDELT_DIRECT_HTTP_429'],
    [Object.assign(new Error('connect timed out'), { code: 'UND_ERR_CONNECT_TIMEOUT' }), 'GDELT_DIRECT_TIMEOUT'],
  ]) {
    let directCalls = 0;
    await assert.rejects(
      fetchGdeltJson(URL, {
        _fetch: async () => {
          directCalls += 1;
          throw failure;
        },
      }),
      (error) => {
        assert.equal(error.code, expected);
        return true;
      },
    );
    assert.equal(directCalls, 1);
  }
});

test('malformed JSON is distinct from transport failure on both routes', async () => {
  assert.equal(
    classifyGdeltFetchError(new SyntaxError('Unexpected token <'), 'proxy'),
    'GDELT_PROXY_INVALID_JSON',
  );

  setProxyEnv();
  await assert.rejects(
    fetchGdeltJson(URL, {
      _fetch: async () => ({
        ok: true,
        status: 200,
        json: async () => { throw new SyntaxError('Unexpected token <'); },
      }),
    }),
    (error) => {
      assert.equal(error.code, 'GDELT_DIRECT_INVALID_JSON');
      return true;
    },
  );
});

test('same-route retry knobs fail closed instead of restoring the retry storm', async () => {
  await assert.rejects(
    fetchGdeltJson(URL, { maxRetries: 1 }),
    /same-route direct retries are disabled/,
  );
  await assert.rejects(
    fetchGdeltJson(URL, { proxyMaxAttempts: 2 }),
    /same-route proxy retries are disabled/,
  );
});
