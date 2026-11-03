import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  describeFetchError,
  fetchOfacSourceResponse,
  resolveOfacProxyUrl,
} from '../scripts/_sanctions-source.mjs';
import { withRetry } from '../scripts/_seed-utils.mjs';

const SOURCE_URL = 'https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/sdn_advanced.xml';
const SIGNED_S3_URL = 'https://wc2h-sls-prod-public-published.s3.us-gov-west-1.amazonaws.com/Published/example/SDN_ADVANCED.XML?X-Amz-Signature=redacted';

function response(status, body = '<xml/>', headers = {}) {
  return new Response(body, { status, headers });
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Native fetch keeps the request signal attached while the body streams, so an
// abort after the headers arrive errors the body mid-read. Mirror that here.
function slowBodyFetch({ chunks, chunkDelayMs }) {
  return async (_url, { signal }) => {
    let sent = 0;
    const stream = new ReadableStream({
      start(controller) {
        signal.addEventListener('abort', () => controller.error(signal.reason), { once: true });
      },
      async pull(controller) {
        await delay(chunkDelayMs);
        if (signal.aborted) return;
        if (sent === chunks) return controller.close();
        sent += 1;
        controller.enqueue(new TextEncoder().encode('<chunk/>'));
      },
    });
    return new Response(stream, { status: 200 });
  };
}

function neverRespondingFetch(calls) {
  return (_url, { signal }) => {
    calls.push(Date.now());
    return new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  };
}

describe('OFAC source transport recovery', () => {
  it('returns a healthy direct response without touching the proxy', async () => {
    let proxyCalls = 0;
    const direct = response(200);

    const result = await fetchOfacSourceResponse(SOURCE_URL, {
      fetchFn: async () => direct,
      proxyFetchFn: async () => { proxyCalls += 1; },
      proxyUrl: 'http://user:pass@proxy.test:8000',
      sleepFn: async () => {},
    });

    assert.equal(result, direct);
    assert.equal(proxyCalls, 0);
  });

  it('uses the proxy only to obtain the redirect, then streams the trusted S3 response directly', async () => {
    const directCalls = [];
    const proxyCalls = [];
    const s3Response = response(200, '<large-stream/>');

    const result = await fetchOfacSourceResponse(SOURCE_URL, {
      fetchFn: async (url) => {
        directCalls.push(String(url));
        return directCalls.length === 1 ? response(403, 'blocked') : s3Response;
      },
      proxyFetchFn: async (url, proxyConfig, options) => {
        proxyCalls.push({ url, proxyConfig, options });
        return {
          ok: false,
          status: 302,
          location: SIGNED_S3_URL,
          buffer: Buffer.alloc(0),
          contentType: '',
        };
      },
      proxyUrl: 'http://user:pass@proxy.test:8000',
      sleepFn: async () => {},
    });

    assert.equal(result, s3Response);
    assert.deepEqual(directCalls, [SOURCE_URL, SIGNED_S3_URL]);
    assert.equal(proxyCalls.length, 1);
    assert.equal(proxyCalls[0].url, SOURCE_URL);
    assert.equal(proxyCalls[0].options.maxResponseBytes, 64 * 1024,
      'the proxy bootstrap must never buffer the large XML payload');
  });

  it('exhausts direct network retries before proxying only the redirect bootstrap', async () => {
    const events = [];
    const s3Response = response(200, '<large-stream/>');

    const result = await fetchOfacSourceResponse(SOURCE_URL, {
      fetchFn: async (url) => {
        if (String(url) === SOURCE_URL) {
          events.push('direct:source');
          throw new TypeError('fetch failed');
        }
        events.push('direct:signed-s3');
        return s3Response;
      },
      proxyFetchFn: async (_url, _proxyConfig, options) => {
        events.push('proxy:bootstrap');
        assert.equal(options.maxResponseBytes, 64 * 1024);
        return {
          ok: false,
          status: 302,
          location: SIGNED_S3_URL,
          buffer: Buffer.alloc(0),
          contentType: '',
        };
      },
      proxyUrl: 'http://user:pass@proxy.test:8000',
      sleepFn: async () => {},
    });

    assert.equal(result, s3Response);
    assert.deepEqual(events, [
      'direct:source',
      'direct:source',
      'proxy:bootstrap',
      'direct:signed-s3',
    ]);
  });

  it('retries a transient direct response before falling back', async () => {
    let attempts = 0;
    let proxyCalls = 0;
    let cancelled = false;

    const result = await fetchOfacSourceResponse(SOURCE_URL, {
      fetchFn: async () => {
        attempts += 1;
        if (attempts > 1) return response(200);
        return new Response(new ReadableStream({
          cancel() {
            cancelled = true;
          },
        }), { status: 503 });
      },
      proxyFetchFn: async () => { proxyCalls += 1; },
      proxyUrl: 'http://user:pass@proxy.test:8000',
      sleepFn: async () => {},
    });

    assert.equal(result.status, 200);
    assert.equal(cancelled, true, 'rejected response bodies must be cancelled before retrying');
    assert.equal(attempts, 2);
    assert.equal(proxyCalls, 0);
  });

  it('honors a capped Retry-After hint when retrying a direct response', async () => {
    const delays = [];
    let attempts = 0;

    const result = await fetchOfacSourceResponse(SOURCE_URL, {
      fetchFn: async () => {
        attempts += 1;
        return attempts === 1
          ? response(429, 'rate limited', { 'retry-after': '2' })
          : response(200);
      },
      proxyUrl: '',
      sleepFn: async (delayMs) => { delays.push(delayMs); },
    });

    assert.equal(result.status, 200);
    assert.equal(attempts, 2);
    assert.deepEqual(delays, [2000]);
  });

  it('does not replay the bounded transport ladder through runSeed retry', async () => {
    let outerAttempts = 0;
    let directAttempts = 0;

    await assert.rejects(
      withRetry(
        () => {
          outerAttempts += 1;
          return fetchOfacSourceResponse(SOURCE_URL, {
            fetchFn: async () => {
              directAttempts += 1;
              throw new TypeError('OFAC unavailable');
            },
            proxyUrl: '',
            sleepFn: async () => {},
          });
        },
        3,
        0,
      ),
      (error) => error.nonRetryable === true && /OFAC unavailable/.test(error.message),
    );

    assert.equal(outerAttempts, 1);
    assert.equal(directAttempts, 2);
  });

  it('rotates sticky proxy exits when OFAC rejects the first proxy request', async () => {
    const ports = [];

    const result = await fetchOfacSourceResponse(SOURCE_URL, {
      fetchFn: async (url) => String(url) === SOURCE_URL
        ? response(403, 'blocked')
        : response(200),
      proxyFetchFn: async (_url, proxyConfig) => {
        ports.push(proxyConfig.port);
        return ports.length === 1
          ? { ok: false, status: 403, location: '', buffer: Buffer.from('blocked'), contentType: 'text/html' }
          : { ok: false, status: 302, location: SIGNED_S3_URL, buffer: Buffer.alloc(0), contentType: '' };
      },
      proxyUrl: 'gate.decodo.com:10001:user:pass',
      sleepFn: async () => {},
    });

    assert.equal(result.status, 200);
    assert.deepEqual(ports, [10001, 10002]);
  });

  it('marks an untrusted redirect terminal before the outer seed retry layer', async () => {
    const directCalls = [];
    let proxyCalls = 0;

    await assert.rejects(
      withRetry(
        () => fetchOfacSourceResponse(SOURCE_URL, {
          fetchFn: async (url) => {
            directCalls.push(String(url));
            return response(403, 'blocked');
          },
          proxyFetchFn: async () => {
            proxyCalls += 1;
            return {
              ok: false,
              status: 302,
              location: 'https://attacker.example/ofac.xml',
              buffer: Buffer.alloc(0),
              contentType: '',
            };
          },
          proxyUrl: 'http://user:pass@proxy.test:8000',
          sleepFn: async () => {},
        }),
        3,
        0,
      ),
      (error) => error.nonRetryable === true && /untrusted redirect host/.test(error.message),
    );

    assert.deepEqual(directCalls, [SOURCE_URL]);
    assert.equal(proxyCalls, 1);
  });

  it('marks proxy CONNECT rejection terminal without exposing credentials', async () => {
    let directCalls = 0;
    let proxyCalls = 0;

    await assert.rejects(
      withRetry(
        () => fetchOfacSourceResponse(SOURCE_URL, {
          fetchFn: async () => {
            directCalls += 1;
            return response(403, 'blocked');
          },
          proxyFetchFn: async () => {
            proxyCalls += 1;
            throw Object.assign(
              new Error('Proxy CONNECT: HTTP/1.1 407 Proxy Authentication Required'),
              { proxyConnect: true, status: 407 },
            );
          },
          proxyUrl: 'http://proxy-user:proxy-secret@proxy.test:8000',
          sleepFn: async () => {},
        }),
        3,
        0,
      ),
      (error) => error.nonRetryable === true
        && error.proxyConnect === true
        && !error.message.includes('proxy-secret'),
    );

    assert.equal(directCalls, 1);
    assert.equal(proxyCalls, 1);
  });

  it('marks invalid proxy configuration terminal before making a proxy request', async () => {
    let directCalls = 0;
    let proxyCalls = 0;

    await assert.rejects(
      withRetry(
        () => fetchOfacSourceResponse(SOURCE_URL, {
          fetchFn: async () => {
            directCalls += 1;
            return response(403, 'blocked');
          },
          proxyFetchFn: async () => { proxyCalls += 1; },
          proxyUrl: 'not-a-proxy',
          sleepFn: async () => {},
        }),
        3,
        0,
      ),
      (error) => error.nonRetryable === true
        && error.message === 'OFAC proxy configuration is invalid',
    );

    assert.equal(directCalls, 1);
    assert.equal(proxyCalls, 0);
  });

  it('never sends signed XML through the proxy when the direct S3 download fails', async () => {
    const directCalls = [];
    let proxyCalls = 0;

    await assert.rejects(
      fetchOfacSourceResponse(SOURCE_URL, {
        fetchFn: async (url) => {
          directCalls.push(String(url));
          if (String(url) === SOURCE_URL) return response(403, 'blocked');
          throw new TypeError('signed S3 network failure');
        },
        proxyFetchFn: async () => {
          proxyCalls += 1;
          return {
            ok: false,
            status: 302,
            location: SIGNED_S3_URL,
            buffer: Buffer.alloc(0),
            contentType: '',
          };
        },
        proxyUrl: 'http://user:pass@proxy.test:8000',
        sleepFn: async () => {},
      }),
      /signed S3 network failure/,
    );

    assert.deepEqual(directCalls, [SOURCE_URL, SIGNED_S3_URL, SIGNED_S3_URL]);
    assert.equal(proxyCalls, 1);
  });

  it('prefers OFAC_PROXY_URL while retaining PROXY_URL as a compatibility fallback', () => {
    assert.equal(resolveOfacProxyUrl({
      OFAC_PROXY_URL: 'http://ofac-exit.test:8000',
      PROXY_URL: 'http://shared-exit.test:9000',
    }), 'http://ofac-exit.test:8000');
    assert.equal(resolveOfacProxyUrl({ PROXY_URL: 'http://shared-exit.test:9000' }),
      'http://shared-exit.test:9000');
    assert.equal(resolveOfacProxyUrl({}), '');
  });

  // "fetch failed" alone could not tell a refused connection from DNS or a
  // connect timeout when Railway lost egress to OFAC on 2026-09-26/27.
  it('names the socket error code behind a bare "fetch failed"', async () => {
    const refused = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('connect ECONNREFUSED 1.2.3.4:443'), { code: 'ECONNREFUSED' }),
    });
    assert.equal(describeFetchError(refused), 'fetch failed (ECONNREFUSED)');
    assert.equal(describeFetchError(new Error('The operation was aborted due to timeout')), 'The operation was aborted due to timeout');
    assert.equal(describeFetchError(Object.assign(new TypeError('fetch failed'), { cause: { code: 'x; secret' } })), 'fetch failed');

    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (...args) => warnings.push(args.join(' '));
    try {
      await fetchOfacSourceResponse(SOURCE_URL, {
        fetchFn: async (url) => {
          if (String(url) === SOURCE_URL) throw refused;
          return response(200);
        },
        proxyFetchFn: async () => ({ ok: false, status: 302, location: SIGNED_S3_URL, buffer: Buffer.alloc(0), contentType: '' }),
        proxyUrl: 'http://user:pass@proxy.test:8000',
        sleepFn: async () => {},
      });
    } finally {
      console.warn = originalWarn;
    }
    assert.ok(warnings.some((line) => line.includes('OFAC direct fetch failed (fetch failed (ECONNREFUSED))')), warnings.join('\n'));

    const s3Refused = Object.assign(new TypeError('fetch failed'), { cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } });
    await assert.rejects(
      fetchOfacSourceResponse(SOURCE_URL, {
        fetchFn: async (url) => {
          if (String(url) === SOURCE_URL) return response(403, 'blocked');
          throw s3Refused;
        },
        proxyFetchFn: async () => ({ ok: false, status: 302, location: SIGNED_S3_URL, buffer: Buffer.alloc(0), contentType: '' }),
        proxyUrl: 'http://user:pass@proxy.test:8000',
        sleepFn: async () => {},
      }),
      (error) => error.message === 'fetch failed (UND_ERR_CONNECT_TIMEOUT)' && error.nonRetryable === true,
    );
  });
});

describe('OFAC source download deadlines', () => {
  const noProxy = { proxyUrl: '', sleepFn: async () => {} };

  it('lets a body that outlasts the header timeout finish inside the body budget', { timeout: 5_000 }, async () => {
    const result = await fetchOfacSourceResponse(SOURCE_URL, {
      ...noProxy,
      fetchFn: slowBodyFetch({ chunks: 8, chunkDelayMs: 25 }),
      headerTimeoutMs: 50,
      bodyTimeoutMs: 2_000,
    });

    assert.equal(await result.text(), '<chunk/>'.repeat(8));
  });

  it('aborts a body that exceeds the body budget', { timeout: 5_000 }, async () => {
    const startedAt = Date.now();
    const result = await fetchOfacSourceResponse(SOURCE_URL, {
      ...noProxy,
      fetchFn: slowBodyFetch({ chunks: 100, chunkDelayMs: 20 }),
      headerTimeoutMs: 50,
      bodyTimeoutMs: 200,
    });

    await assert.rejects(result.text(), (error) => error.name === 'TimeoutError');
    assert.ok(Date.now() - startedAt < 1_000, 'the body must stop near its 200 ms budget, not after the full 2 s stream');
  });

  it('caps the body budget at the caller deadline', { timeout: 10_000 }, async () => {
    const startedAt = Date.now();
    const result = await fetchOfacSourceResponse(SOURCE_URL, {
      ...noProxy,
      fetchFn: slowBodyFetch({ chunks: 100, chunkDelayMs: 50 }),
      headerTimeoutMs: 50,
      bodyTimeoutMs: 8_000,
      deadlineAt: startedAt + 1_200,
    });

    await assert.rejects(result.text(), (error) => error.name === 'TimeoutError');
    const elapsed = Date.now() - startedAt;
    assert.ok(elapsed >= 1_000 && elapsed < 2_500, `body should stop near the 1.2 s deadline, stopped after ${elapsed} ms`);
  });

  it('still aborts missing headers at the header timeout and retries once', { timeout: 5_000 }, async () => {
    const calls = [];

    await assert.rejects(
      fetchOfacSourceResponse(SOURCE_URL, {
        ...noProxy,
        fetchFn: neverRespondingFetch(calls),
        headerTimeoutMs: 50,
        bodyTimeoutMs: 2_000,
      }),
      (error) => error.name === 'TimeoutError' && error.nonRetryable === true,
    );
    assert.equal(calls.length, 2);
  });
});

describe('OFAC source caller deadline', () => {
  const proxyUrl = 'http://user:pass@proxy.test:8000';
  const redirect = { ok: false, status: 302, location: SIGNED_S3_URL, buffer: Buffer.alloc(0), contentType: '' };

  it('aborts missing headers at the deadline and starts nothing after it', { timeout: 20_000 }, async () => {
    const calls = [];
    let proxyCalls = 0;
    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (...args) => { warnings.push(args.join(' ')); };
    const startedAt = Date.now();

    try {
      await assert.rejects(
        fetchOfacSourceResponse(SOURCE_URL, {
          fetchFn: neverRespondingFetch(calls),
          proxyFetchFn: async () => { proxyCalls += 1; return redirect; },
          proxyUrl,
          sleepFn: async () => {},
          headerTimeoutMs: 4_000,
          deadlineAt: startedAt + 1_500,
        }),
        (error) => error.nonRetryable === true && /OFAC fetch deadline reached/.test(error.message),
      );
    } finally {
      console.warn = originalWarn;
    }

    assert.deepEqual(warnings.filter((w) => /via proxy/.test(w)), [],
      'a deadline stop must not log a proxy retry that never happens');
    const elapsed = Date.now() - startedAt;
    assert.ok(elapsed >= 1_000 && elapsed < 3_000, `headers should abort near the 1.5 s deadline, stopped after ${elapsed} ms`);
    assert.equal(calls.length, 1, 'no direct retry may start after the deadline');
    assert.equal(proxyCalls, 0, 'no proxy bootstrap may start after the deadline');
  });

  it('caps the proxy bootstrap timeout at the time left before the deadline', async (t) => {
    // Freeze the clock: the stub's own Date.now() read lands after the code's,
    // so a real millisecond tick between them fails the exact bound below.
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    const timeouts = [];
    const deadlineAt = Date.now() + 5_000;

    const result = await fetchOfacSourceResponse(SOURCE_URL, {
      fetchFn: async (url) => String(url) === SOURCE_URL ? response(403, 'blocked') : response(200),
      proxyFetchFn: async (_url, _proxyConfig, options) => {
        timeouts.push({ timeoutMs: options.timeoutMs, remaining: deadlineAt - Date.now() });
        return redirect;
      },
      proxyUrl,
      sleepFn: async () => {},
      deadlineAt,
    });

    assert.equal(result.status, 200);
    assert.equal(timeouts.length, 1);
    assert.ok(timeouts[0].timeoutMs <= timeouts[0].remaining,
      `proxy timeout ${timeouts[0].timeoutMs} ms exceeds the ${timeouts[0].remaining} ms left`);
  });

  it('ends the whole proxy request, tunnel and response, within one timeout', { timeout: 10_000 }, async () => {
    // proxyFetch starts a fresh timeoutMs timer for the response after the
    // tunnel opens, so only a signal passed by the caller bounds both phases.
    const deadlineAt = Date.now() + 2_500;
    const startedAt = Date.now();
    let budget;

    await assert.rejects(fetchOfacSourceResponse(SOURCE_URL, {
      fetchFn: async (url) => String(url) === SOURCE_URL ? response(403, 'blocked') : response(200),
      proxyFetchFn: async (_url, _proxyConfig, options) => {
        budget ??= options.timeoutMs;
        return new Promise((_resolve, reject) => {
          const stall = setTimeout(() => reject(new Error('proxy stub stalled')), 2 * options.timeoutMs);
          options.signal?.addEventListener('abort', () => {
            clearTimeout(stall);
            reject(options.signal.reason);
          }, { once: true });
        });
      },
      proxyUrl,
      sleepFn: async () => {},
      deadlineAt,
    }));

    const elapsed = Date.now() - startedAt;
    assert.ok(elapsed < budget + 500, `proxy request ran ${elapsed} ms against a ${budget} ms budget`);
  });

  it('never sleeps past the deadline between retries', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    const sleeps = [];
    const deadlineAt = Date.now() + 3_000;
    let attempts = 0;

    const result = await fetchOfacSourceResponse(SOURCE_URL, {
      fetchFn: async () => {
        attempts += 1;
        return attempts === 1 ? response(429, 'rate limited', { 'retry-after': '5' }) : response(200);
      },
      proxyUrl: '',
      sleepFn: async (delayMs) => { sleeps.push({ delayMs, remaining: deadlineAt - Date.now() }); },
      deadlineAt,
    });

    assert.equal(result.status, 200);
    assert.equal(sleeps.length, 1);
    assert.ok(sleeps[0].delayMs <= sleeps[0].remaining,
      `retry sleep ${sleeps[0].delayMs} ms exceeds the ${sleeps[0].remaining} ms left`);
  });
});
