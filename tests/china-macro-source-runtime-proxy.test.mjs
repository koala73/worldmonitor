import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

import { fetchChinaMacroSnapshot } from '../scripts/china-macro/adapters.mjs';
import {
  fetchText,
  PROXY_FALLBACK_BUDGET_MS,
  requestBudget,
  shouldRetryViaProxy,
} from '../scripts/china-macro/source-runtime.mjs';

const fixture = (name) => readFileSync(resolve(import.meta.dirname, 'fixtures/china-macro', name), 'utf8');

const POLICY = {
  origin: 'https://example.test',
  path: () => true,
};

const PARSEABLE_PROXY = 'http://user:pass@proxy.test:8080';

const NBS_ROUTES = new Map([
  ['https://www.stats.gov.cn/english/PressRelease/', fixture('nbs-list.html')],
  ['https://www.stats.gov.cn/english/PressRelease/202607/t20260717_1964159.html', fixture('nbs-industrial.html')],
  ['https://www.stats.gov.cn/english/PressRelease/202607/t20260717_1964158.html', fixture('nbs-fai.html')],
  ['https://www.stats.gov.cn/english/PressRelease/202607/t20260717_1964157.html', fixture('nbs-property.html')],
  ['https://www.safe.gov.cn/safe/sjjd/index.html', fixture('safe-list.html')],
  ['https://www.safe.gov.cn/safe/2026/0706/27661.html', fixture('safe-reserves.html')],
  ['https://www.safe.gov.cn/safe/2026/0717/27704.html', fixture('safe-settlement.html')],
]);

const connectionFailure = () => Object.assign(new TypeError('fetch failed'), {
  cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
});

function proxyResult(body, { status = 200, headers = {}, location = '' } = {}) {
  const buffer = Buffer.from(body);
  return {
    status,
    location,
    buffer,
    contentType: 'text/html',
    headers,
  };
}

describe('china-macro proxy fallback (#6676 NBS egress block)', () => {
  describe('shouldRetryViaProxy', () => {
    it('retries a connection-level failure', () => {
      assert.equal(shouldRetryViaProxy(connectionFailure()), true);
    });

    it('retries AbortSignal.timeout as TimeoutError', () => {
      assert.equal(
        shouldRetryViaProxy(Object.assign(new Error('The operation was aborted due to timeout'), {
          name: 'TimeoutError',
        })),
        true,
      );
    });

    it('never retries our own contract guard', () => {
      assert.equal(
        shouldRetryViaProxy({ code: 'SOURCE_CONTRACT_VIOLATION', publicReason: 'UNAPPROVED_URL' }),
        false,
      );
    });

    it('never retries a caller-initiated abort', () => {
      assert.equal(shouldRetryViaProxy(Object.assign(new Error('aborted'), { name: 'AbortError' })), false);
    });

    it('never retries a TLS chain failure', () => {
      assert.equal(shouldRetryViaProxy({ code: 'SELF_SIGNED_CERT_IN_CHAIN' }), false);
      assert.equal(shouldRetryViaProxy(new Error('self signed certificate in chain')), false);
    });

    it('never retries a thrown publisher status', () => {
      assert.equal(shouldRetryViaProxy(Object.assign(new Error('HTTP_403'), { status: 403 })), false);
      assert.equal(shouldRetryViaProxy(Object.assign(new Error('HTTP_429'), { status: 429 })), false);
      assert.equal(shouldRetryViaProxy(new Error('HTTP_403')), false);
    });
  });

  describe('fetchText', () => {
    it('leaves the direct path untouched when no proxy is configured', async () => {
      let calls = 0;
      const fetchFn = async () => {
        calls += 1;
        return new Response('<html>ok</html>', { status: 200 });
      };
      const budget = requestBudget(4);
      const result = await fetchText(fetchFn, 'https://example.test/a', {
        policy: POLICY,
        budget,
      });
      assert.match(result.text, /ok/);
      assert.equal(calls, 1);
      assert.equal(budget.count, 1, 'a healthy direct fetch must not grow a hop or a request');
    });

    it('does not reach for the proxy when the publisher ANSWERS with an error status', async () => {
      let proxyUsed = false;
      const fetchFn = async () => new Response('denied', { status: 403 });
      const budget = requestBudget(4);
      await assert.rejects(
        fetchText(fetchFn, 'https://example.test/a', {
          policy: POLICY,
          budget,
          proxyUrl: PARSEABLE_PROXY,
          onProxyFallback: () => { proxyUsed = true; },
        }),
        (err) => err?.status === 403,
        'a publisher status must propagate as itself',
      );
      assert.equal(proxyUsed, false, 'a publisher status must never be re-asked through the proxy');
    });

    it('does not reach for the proxy when fetchFn throws a publisher status', async () => {
      let proxyCalls = 0;
      const fetchFn = async () => {
        throw Object.assign(new Error('HTTP_429'), { status: 429 });
      };
      await assert.rejects(
        fetchText(fetchFn, 'https://example.test/a', {
          policy: POLICY,
          budget: requestBudget(4),
          proxyUrl: PARSEABLE_PROXY,
          proxyFetchFn: async () => {
            proxyCalls += 1;
            return proxyResult('nope');
          },
        }),
        (err) => err?.status === 429,
      );
      assert.equal(proxyCalls, 0);
    });

    it('uses a proxied 200 after a connection-level failure without a second budget unit', async () => {
      let fallbacks = 0;
      const fetchFn = async () => { throw connectionFailure(); };
      const budget = requestBudget(8);
      const result = await fetchText(fetchFn, 'https://example.test/a', {
        policy: POLICY,
        budget,
        proxyUrl: PARSEABLE_PROXY,
        onProxyFallback: () => { fallbacks += 1; },
        proxyFetchFn: async () => proxyResult('<html>via-proxy</html>'),
      });
      assert.match(result.text, /via-proxy/);
      assert.equal(fallbacks, 1);
      assert.equal(budget.count, 1, 'the proxied hop is the same logical request');
    });

    it('a request budget still bounds the next logical URL after a proxied success', async () => {
      const fetchFn = async () => { throw connectionFailure(); };
      const budget = requestBudget(1);
      const options = {
        policy: POLICY,
        budget,
        proxyUrl: PARSEABLE_PROXY,
        proxyFetchFn: async () => proxyResult('<html>ok</html>'),
      };
      await fetchText(fetchFn, 'https://example.test/a', options);
      await assert.rejects(
        fetchText(fetchFn, 'https://example.test/b', options),
        (err) => err?.code === 'SOURCE_CONTRACT_VIOLATION' && err?.publicReason === 'REQUEST_BUDGET_EXCEEDED',
      );
      assert.equal(budget.count, 1);
    });

    it('surfaces the ORIGINAL direct error when a parseable proxy also fails', async () => {
      const fetchFn = async () => { throw connectionFailure(); };
      const budget = requestBudget(8);
      await assert.rejects(
        fetchText(fetchFn, 'https://example.test/a', {
          policy: POLICY,
          budget,
          proxyUrl: PARSEABLE_PROXY,
          proxyFetchFn: async () => {
            throw Object.assign(new Error('CONNECT 522'), { proxyConnect: true });
          },
        }),
        (err) => /fetch failed/.test(String(err?.message)),
      );
      assert.equal(budget.count, 1, 'a failed proxy hop must not consume a second unit or a transient retry');
    });

    it('gives the proxy a live signal after a TimeoutError from the direct hop', async () => {
      const signals = [];
      const fetchFn = async (_url, init) => {
        assert.equal(init.signal.aborted, false);
        throw Object.assign(new Error('The operation was aborted due to timeout'), {
          name: 'TimeoutError',
        });
      };
      const result = await fetchText(fetchFn, 'https://example.test/a', {
        policy: POLICY,
        budget: requestBudget(4),
        proxyUrl: PARSEABLE_PROXY,
        proxyFetchFn: async (_url, _config, options) => {
          signals.push(options.signal);
          assert.equal(options.signal.aborted, false, 'proxy must not inherit the spent direct signal');
          return proxyResult('<html>recovered</html>');
        },
      });
      assert.match(result.text, /recovered/);
      assert.equal(signals.length, 1);
    });

    it('stops rotating exits once the fallback wall-clock budget is spent', async () => {
      let t = 1_000;
      let proxyCalls = 0;
      const fetchFn = async () => { throw connectionFailure(); };
      await assert.rejects(fetchText(fetchFn, 'https://example.test/a', {
        policy: POLICY,
        budget: requestBudget(4),
        proxyUrl: PARSEABLE_PROXY,
        now: () => t,
        proxyFetchFn: async () => {
          proxyCalls += 1;
          t += PROXY_FALLBACK_BUDGET_MS;
          throw new Error('exit hang');
        },
      }));
      assert.equal(proxyCalls, 1, 'a spent fallback budget must not start another 12s exit');
    });
  });

  describe('fetchChinaMacroSnapshot NBS robots hop', () => {
    it('routes robots.txt through the proxy when Railway cannot open stats.gov.cn', async () => {
      const proxied = [];
      const decisions = [];
      const fetchFn = async (url) => {
        const target = String(url);
        if (target.includes('www.stats.gov.cn')) throw connectionFailure();
        if (target === 'https://www.pbc.gov.cn/robots.txt') {
          return new Response('User-agent: *\nDisallow: /\n');
        }
        if (target === 'https://www.safe.gov.cn/robots.txt') {
          return new Response('not found', { status: 404 });
        }
        if (target === 'https://english.customs.gov.cn/robots.txt') {
          throw Object.assign(new Error('self signed certificate in certificate chain'), {
            code: 'SELF_SIGNED_CERT_IN_CHAIN',
          });
        }
        const body = NBS_ROUTES.get(target);
        if (!body) throw new Error(`unexpected request ${target}`);
        return new Response(body);
      };
      const snapshot = await fetchChinaMacroSnapshot({
        now: Date.parse('2026-07-25T14:30:00.000Z'),
        readCachedFn: async () => null,
        fetchFn,
        proxyUrl: PARSEABLE_PROXY,
        proxyFetchFn: async (url) => {
          proxied.push(String(url));
          if (String(url) === 'https://www.stats.gov.cn/robots.txt') {
            return proxyResult('not found', { status: 404 });
          }
          const body = NBS_ROUTES.get(String(url));
          if (!body) throw new Error(`unexpected proxy ${url}`);
          return proxyResult(body);
        },
        onDecision: (entry) => decisions.push(entry),
      });
      const nbs = snapshot.sourceDecisions.find((entry) => entry.host === 'www.stats.gov.cn');
      assert.ok(nbs, 'NBS decision must be present');
      assert.equal(nbs.status, 'accepted');
      assert.ok(nbs.proxyFallbacks >= 1);
      assert.equal(nbs.proxyDirectReason, 'FETCH_FAILED');
      assert.ok(
        proxied.includes('https://www.stats.gov.cn/robots.txt'),
        `robots.txt must be on the proxy ladder, got ${proxied.join(', ')}`,
      );
      assert.equal(
        decisions.some((entry) => entry.host === 'www.safe.gov.cn' && entry.proxyFallbacks),
        false,
        'SAFE must stay unproxied',
      );
    });
  });
});
