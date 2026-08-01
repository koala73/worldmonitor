import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  fetchOfacSourceResponse,
  resolveOfacProxyUrl,
} from '../scripts/_sanctions-source.mjs';
import { withRetry } from '../scripts/_seed-utils.mjs';

const SOURCE_URL = 'https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/sdn_advanced.xml';
const SIGNED_S3_URL = 'https://wc2h-sls-prod-public-published.s3.us-gov-west-1.amazonaws.com/Published/example/SDN_ADVANCED.XML?X-Amz-Signature=redacted';

function response(status, body = '<xml/>', headers = {}) {
  return new Response(body, { status, headers });
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
});
