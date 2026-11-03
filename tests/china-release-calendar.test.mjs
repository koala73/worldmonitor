import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  FETCH_BUDGET_EXHAUSTED_REASON,
  NBS_CALENDAR_INDEX_URL,
  NBS_REQUEST_TIMEOUT_MS,
  NBS_TOTAL_FETCH_BUDGET_MS,
  NBS_TRANSIENT_FETCH_ATTEMPTS,
  NBS_TRANSIENT_RETRY_DELAY_MS,
  PERMANENT_TLS_CODES,
  TLS_CERT_UNTRUSTED_REASON,
  buildLprCandidates,
  fetchChinaReleaseCalendar,
  mergeVerifiedLprDates,
  parseChinaMoneyLprNotices,
  parseNbsReleaseCalendar,
} from '../scripts/china-macro/calendar.mjs';
import { PROXY_FALLBACK_BUDGET_MS } from '../scripts/china-macro/source-runtime.mjs';

// fetchChinaReleaseCalendar defaults proxyUrl to process.env.PROXY_URL; an
// exported shell value would route the direct-failure tests through a real proxy.
delete process.env.PROXY_URL;

const fixture = (name) => readFileSync(resolve(import.meta.dirname, 'fixtures/china-macro', name), 'utf8');
const MAX_NBS_RESPONSE_BYTES = 2 * 1024 * 1024;
const TEST_NOW = Date.parse('2026-07-13T00:00:00Z');
const ALLOWED_REDIRECT_URL = `${NBS_CALENDAR_INDEX_URL}redirected.html`;
const CALENDAR_PAGE_URL = `${NBS_CALENDAR_INDEX_URL}calendar.html`;
const INDEX_ANCHOR = '<a href="calendar.html">2026 release calendar</a>';
const PARSEABLE_PROXY = 'http://user:pass@proxy.test:8080';
const chinaMoneyResponse = () => new Response(fixture('chinamoney-lpr.json'), {
  headers: { 'Content-Type': 'application/json' },
});
const nbsPage = (url) => (String(url) === NBS_CALENDAR_INDEX_URL ? INDEX_ANCHOR : fixture('nbs-calendar.html'));
const proxyResult = (body, { status = 200, location = '' } = {}) => ({
  status, location, buffer: Buffer.from(body), contentType: 'text/html', headers: {},
});
const connectionRefused = () => Object.assign(new TypeError('fetch failed'), {
  cause: Object.assign(new Error('connect ECONNREFUSED secret-address'), { code: 'ECONNREFUSED' }),
});
const hangTimeout = () => Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });

describe('NBS calendar transport diagnostics', () => {
  it('logs nested transport codes without secrets and preserves the failed request sequence', async (t) => {
    const logs = [];
    t.mock.method(console, 'warn', (line) => logs.push(JSON.parse(line)));
    const requests = [];
    const sleeps = [];
    const decisions = [];
    await assert.rejects(fetchChinaReleaseCalendar({
      now: TEST_NOW,
      fetchFn: async (url, options) => {
        requests.push({ url, redirect: options.redirect });
        throw Object.assign(new TypeError('secret-token https://user:pass@example.test'), {
          cause: { code: 'ENOTFOUND', message: 'secret-host', address: 'secret-address' },
        });
      },
      sleepFn: async (ms) => sleeps.push(ms),
      onDecision: (entry) => decisions.push(entry),
    }), /NBS_REQUIRED_SOURCE_UNAVAILABLE:FETCH_FAILED/);
    assert.deepEqual(requests, Array(3).fill({ url: NBS_CALENDAR_INDEX_URL, redirect: 'manual' }));
    assert.deepEqual(sleeps, [500, 1000]);
    assert.equal(decisions[0].requestCount, 3);
    assert.equal(decisions[0].checkedAt, new Date(TEST_NOW).toISOString());
    assert.deepEqual(logs, [1, 2, 3].map((attempt) => ({
      event: 'china_calendar_transport_failure', host: 'www.stats.gov.cn',
      resource: 'index', transport: 'direct', attempt, code: 'ENOTFOUND',
    })));
  });

  it('labels annual-page failures and retains HTTP status without emitting the URL', async (t) => {
    const logs = [];
    t.mock.method(console, 'warn', (line) => logs.push(JSON.parse(line)));
    await assert.rejects(fetchChinaReleaseCalendar({
      now: TEST_NOW,
      fetchFn: async (url) => url === NBS_CALENDAR_INDEX_URL
        ? new Response('<a href="calendar.html?secret-token">2026</a>')
        : new Response('secret-body', { status: 403 }),
      onDecision: () => {},
    }), /NBS_REQUIRED_SOURCE_UNAVAILABLE:HTTP_403/);
    assert.deepEqual(logs, [{
      event: 'china_calendar_transport_failure', host: 'www.stats.gov.cn',
      resource: 'calendar', transport: 'direct', attempt: 1, code: 'UNKNOWN', httpStatus: 403,
    }]);
  });

  it('bounds cause traversal and only emits approved codes and statuses', async (t) => {
    const logs = [];
    t.mock.method(console, 'warn', (line) => logs.push(JSON.parse(line)));
    const cycle = { code: 'secret-token' };
    cycle.cause = cycle;
    const cases = [
      [cycle, 'UNKNOWN'],
      [{ cause: { cause: { cause: { code: 'ECONNRESET' } } } }, 'ECONNRESET'],
      [{ cause: { cause: { cause: { cause: { code: 'ECONNRESET' } } } } }, 'UNKNOWN'],
      [{ name: 'TimeoutError' }, 'TIMEOUT'],
      [{ code: 'CERT_HAS_EXPIRED' }, 'CERT_HAS_EXPIRED'],
      [{ code: 'secret-token', status: 999 }, 'UNKNOWN'],
    ];
    for (const [error, expectedCode] of cases) {
      logs.length = 0;
      await assert.rejects(fetchChinaReleaseCalendar({
        now: TEST_NOW, fetchFn: async () => { throw error; },
        sleepFn: async () => {}, onDecision: () => {},
      }));
      assert.ok(logs.length > 0);
      for (const entry of logs) {
        assert.equal(entry.code, expectedCode);
        assert.equal(entry.httpStatus, undefined);
        assert.equal(JSON.stringify(entry).includes('secret'), false);
      }
    }
  });

  it('preserves recovery and source clocks when the diagnostic logger throws', async (t) => {
    let logCalls = 0;
    t.mock.method(console, 'warn', () => { logCalls++; throw new Error('logger unavailable'); });
    let nbsCalls = 0;
    const sleeps = [];
    const calendar = await fetchChinaReleaseCalendar({
      now: TEST_NOW,
      fetchFn: async (url) => {
        if (String(url).includes('chinamoney')) return chinaMoneyResponse();
        if (++nbsCalls === 1) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
        return new Response(fixture('nbs-calendar.html'));
      },
      sleepFn: async (ms) => sleeps.push(ms), onDecision: () => {},
    });
    assert.equal(logCalls, 1);
    assert.equal(nbsCalls, 2);
    assert.deepEqual(sleeps, [500]);
    assert.equal(calendar.generatedAt, new Date(TEST_NOW).toISOString());
    assert.ok(calendar.events.length > 0);
  });
});

describe('China official release calendar', () => {
  it('keeps blank NBS months empty and captures quarterly plus Spring Festival-shifted releases', () => {
    const events = parseNbsReleaseCalendar(fixture('nbs-calendar.html'), 2026, 'https://www.stats.gov.cn/english/PressRelease/ReleaseCalendar/202512/t20251226_1962154.html');
    assert.equal(events.some((event) => event.event === 'National Economic Performance' && event.releaseDate.startsWith('2026-02')), false);
    assert.deepEqual(
      events.filter((event) => event.event.startsWith('Preliminary Accounting')).map((event) => event.releaseDate),
      ['2026-01-20', '2026-04-17', '2026-07-16', '2026-10-20'],
    );
    assert.ok(events.some((event) => event.event.includes('Purchasing Managers') && event.releaseDate === '2026-03-04'));
    assert.ok(events.some((event) => event.event.includes('Purchasing Managers') && event.releaseDate === '2026-03-31'));
  });

  it('moves LPR candidates over weekends and official holidays, then marks only realized dates verified', () => {
    const candidates = buildLprCandidates(2026);
    assert.equal(candidates.find((event) => event.releaseDate.startsWith('2026-02')).releaseDate, '2026-02-24');
    assert.equal(candidates.find((event) => event.releaseDate.startsWith('2026-06')).releaseDate, '2026-06-22');
    assert.ok(candidates.every((event) => event.status === 'provisional'));

    const realized = parseChinaMoneyLprNotices(JSON.parse(fixture('chinamoney-lpr.json')));
    const merged = mergeVerifiedLprDates(candidates, realized);
    assert.equal(merged.find((event) => event.releaseDate === '2026-02-24').status, 'verified');
    assert.equal(merged.find((event) => event.releaseDate === '2026-06-22').status, 'verified');
    assert.equal(merged.find((event) => event.releaseDate === '2026-07-20').status, 'provisional');
  });

  it('fails closed when the official holiday calendar has not been configured for the requested year', () => {
    assert.throws(
      () => buildLprCandidates(2027),
      (error) => error?.reason === 'CHINA_HOLIDAY_CALENDAR_UNAVAILABLE',
    );
  });

  it('reports an NBS parse failure distinctly from a network failure', async () => {
    const decisions = [];
    let rejectedError;
    await assert.rejects(
      fetchChinaReleaseCalendar({
        now: Date.parse('2026-07-13T00:00:00Z'),
        fetchFn: async (url) => {
          if (String(url).endsWith('calendar.html')) return new Response('<table><tr><td>changed format</td></tr></table>');
          return new Response('<a href="calendar.html">2026 release calendar</a>');
        },
        onDecision: (decision) => decisions.push(decision),
      }),
      (error) => {
        rejectedError = error;
        return /NBS_REQUIRED_SOURCE_UNAVAILABLE:NO_NBS_EVENTS/.test(error.message);
      },
    );
    assert.equal(decisions[0]?.reason, 'NO_NBS_EVENTS');
    assert.equal(rejectedError.nonRetryable, true);
  });

  it('rejects an off-origin NBS calendar link without fetching it', async () => {
    const decisions = [];
    const requests = [];
    let rejectedError;
    await assert.rejects(
      fetchChinaReleaseCalendar({
        now: Date.parse('2026-07-13T00:00:00Z'),
        fetchFn: async (url) => {
          requests.push(String(url));
          return new Response('<a href="https://attacker.example/calendar.html">2026 release calendar</a>');
        },
        onDecision: (decision) => decisions.push(decision),
      }),
      (error) => {
        rejectedError = error;
        return /NBS_REQUIRED_SOURCE_UNAVAILABLE:UNTRUSTED_NBS_CALENDAR_URL/.test(error.message);
      },
    );
    assert.deepEqual(requests, [NBS_CALENDAR_INDEX_URL]);
    assert.equal(decisions[0]?.reason, 'UNTRUSTED_NBS_CALENDAR_URL');
    assert.equal(decisions[0]?.requestCount, 1);
    assert.equal(rejectedError.nonRetryable, true);
  });

  it('accepts a direct 200 NBS calendar response without changing its parsed output', async () => {
    const decisions = [];
    const nbsRequests = [];
    const calendar = await fetchChinaReleaseCalendar({
      now: TEST_NOW,
      fetchFn: async (url, options) => {
        if (String(url).includes('chinamoney')) return chinaMoneyResponse();
        nbsRequests.push({ url: String(url), redirect: options?.redirect });
        return new Response(fixture('nbs-calendar.html'));
      },
      onDecision: (decision) => decisions.push(decision),
    });

    assert.ok(calendar.events.some((event) => event.kind === 'nbs'));
    assert.deepEqual(nbsRequests, [{ url: NBS_CALENDAR_INDEX_URL, redirect: 'manual' }]);
    assert.deepEqual(
      decisions[0],
      {
        source: 'NBS release calendar',
        host: 'www.stats.gov.cn',
        status: 'accepted',
        reason: 'OK',
        checkedAt: new Date(TEST_NOW).toISOString(),
        optional: false,
        requestCount: 1,
      },
    );
  });

  it('follows one allowed same-origin calendar redirect and counts both HTTP hops', async () => {
    const decisions = [];
    const nbsRequests = [];
    const calendar = await fetchChinaReleaseCalendar({
      now: TEST_NOW,
      fetchFn: async (url, options) => {
        const target = String(url);
        if (target.includes('chinamoney')) return chinaMoneyResponse();
        nbsRequests.push({ url: target, redirect: options?.redirect });
        if (target === NBS_CALENDAR_INDEX_URL) {
          return new Response(null, { status: 302, headers: { Location: ALLOWED_REDIRECT_URL } });
        }
        assert.equal(target, ALLOWED_REDIRECT_URL);
        return new Response(fixture('nbs-calendar.html'));
      },
      onDecision: (decision) => decisions.push(decision),
    });

    assert.ok(calendar.events.some((event) => event.kind === 'nbs'));
    assert.deepEqual(nbsRequests, [
      { url: NBS_CALENDAR_INDEX_URL, redirect: 'manual' },
      { url: ALLOWED_REDIRECT_URL, redirect: 'manual' },
    ]);
    assert.equal(decisions[0]?.status, 'accepted');
    assert.equal(decisions[0]?.requestCount, 2);
  });

  it('rejects an off-origin redirect before fetching or parsing the redirected body', async () => {
    const decisions = [];
    const nbsRequests = [];
    let attackerBodyReturned = false;
    await assert.rejects(
      fetchChinaReleaseCalendar({
        now: TEST_NOW,
        fetchFn: async (url, options) => {
          const target = String(url);
          nbsRequests.push(target);
          if (target === NBS_CALENDAR_INDEX_URL) {
            // Model fetch's automatic-follow behavior if the production call
            // ever drops `redirect: manual`: the attacker response arrives as
            // the apparent result of this one fetch call and must not publish.
            if (options?.redirect !== 'manual') {
              attackerBodyReturned = true;
              return new Response(fixture('nbs-calendar.html'));
            }
            return new Response(null, {
              status: 302,
              headers: { Location: 'https://attacker.example/nbs-calendar.html' },
            });
          }
          throw new Error(`unexpected request: ${target}`);
        },
        onDecision: (decision) => decisions.push(decision),
      }),
      (error) => error.message === 'NBS_REQUIRED_SOURCE_UNAVAILABLE:REDIRECT_REJECTED_UNAPPROVED_URL',
    );

    assert.equal(attackerBodyReturned, false);
    assert.deepEqual(nbsRequests, [NBS_CALENDAR_INDEX_URL]);
    assert.equal(decisions[0]?.status, 'blocked');
    assert.equal(decisions[0]?.reason, 'REDIRECT_REJECTED_UNAPPROVED_URL');
    assert.equal(decisions[0]?.requestCount, 1);
  });

  it('rejects a same-origin redirect outside the approved NBS calendar path', async () => {
    const decisions = [];
    const requests = [];
    await assert.rejects(
      fetchChinaReleaseCalendar({
        now: TEST_NOW,
        fetchFn: async (url) => {
          requests.push(String(url));
          return new Response(null, {
            status: 302,
            headers: { Location: 'https://www.stats.gov.cn/english/attacker-controlled.html' },
          });
        },
        onDecision: (decision) => decisions.push(decision),
      }),
      (error) => error.message === 'NBS_REQUIRED_SOURCE_UNAVAILABLE:REDIRECT_REJECTED_UNAPPROVED_URL',
    );

    assert.deepEqual(requests, [NBS_CALENDAR_INDEX_URL]);
    assert.equal(decisions[0]?.reason, 'REDIRECT_REJECTED_UNAPPROVED_URL');
    assert.equal(decisions[0]?.requestCount, 1);
  });

  it('rejects a same-origin calendar redirect that carries userinfo', async () => {
    const decisions = [];
    const requests = [];
    let rejectedError;
    await assert.rejects(
      fetchChinaReleaseCalendar({
        now: TEST_NOW,
        fetchFn: async (url) => {
          requests.push(String(url));
          return new Response(null, {
            status: 302,
            headers: {
              Location: 'https://attacker@www.stats.gov.cn/english/PressRelease/ReleaseCalendar/',
            },
          });
        },
        onDecision: (decision) => decisions.push(decision),
      }),
      (error) => {
        rejectedError = error;
        return error.message === 'NBS_REQUIRED_SOURCE_UNAVAILABLE:REDIRECT_REJECTED_UNAPPROVED_URL';
      },
    );

    assert.deepEqual(requests, [NBS_CALENDAR_INDEX_URL]);
    assert.equal(decisions[0]?.reason, 'REDIRECT_REJECTED_UNAPPROVED_URL');
    assert.equal(decisions[0]?.requestCount, 1);
    assert.equal(rejectedError.nonRetryable, true);
  });

  it('rejects an extracted calendar href that carries userinfo without fetching it', async () => {
    const decisions = [];
    const requests = [];
    let rejectedError;
    await assert.rejects(
      fetchChinaReleaseCalendar({
        now: TEST_NOW,
        fetchFn: async (url) => {
          requests.push(String(url));
          return new Response(
            '<a href="https://user:pass@www.stats.gov.cn/english/PressRelease/ReleaseCalendar/calendar.html">2026 release calendar</a>',
          );
        },
        onDecision: (decision) => decisions.push(decision),
      }),
      (error) => {
        rejectedError = error;
        return error.message === 'NBS_REQUIRED_SOURCE_UNAVAILABLE:UNTRUSTED_NBS_CALENDAR_URL';
      },
    );

    assert.deepEqual(requests, [NBS_CALENDAR_INDEX_URL]);
    assert.equal(decisions[0]?.reason, 'UNTRUSTED_NBS_CALENDAR_URL');
    assert.equal(decisions[0]?.requestCount, 1);
    assert.equal(rejectedError.nonRetryable, true);
  });

  it('rejects a redirect with no Location header', async () => {
    const decisions = [];
    const requests = [];
    let rejectedError;
    await assert.rejects(
      fetchChinaReleaseCalendar({
        now: TEST_NOW,
        fetchFn: async (url) => {
          requests.push(String(url));
          return new Response(null, { status: 302 });
        },
        onDecision: (decision) => decisions.push(decision),
      }),
      (error) => {
        rejectedError = error;
        return error.message === 'NBS_REQUIRED_SOURCE_UNAVAILABLE:REDIRECT_WITHOUT_LOCATION';
      },
    );

    assert.deepEqual(requests, [NBS_CALENDAR_INDEX_URL]);
    assert.equal(decisions[0]?.reason, 'REDIRECT_WITHOUT_LOCATION');
    assert.equal(decisions[0]?.requestCount, 1);
    assert.equal(rejectedError.nonRetryable, true);
  });

  it('rejects a redirect whose Location is not a URL', async () => {
    const decisions = [];
    const requests = [];
    let rejectedError;
    await assert.rejects(
      fetchChinaReleaseCalendar({
        now: TEST_NOW,
        fetchFn: async (url) => {
          requests.push(String(url));
          return new Response(null, { status: 302, headers: { Location: 'http://[' } });
        },
        onDecision: (decision) => decisions.push(decision),
      }),
      (error) => {
        rejectedError = error;
        return error.message === 'NBS_REQUIRED_SOURCE_UNAVAILABLE:REDIRECT_REJECTED_INVALID_URL';
      },
    );

    assert.deepEqual(requests, [NBS_CALENDAR_INDEX_URL]);
    assert.equal(decisions[0]?.reason, 'REDIRECT_REJECTED_INVALID_URL');
    assert.equal(decisions[0]?.requestCount, 1);
    assert.equal(rejectedError.nonRetryable, true);
  });

  it('rejects encoded path traversal that still matches the calendar prefix', async () => {
    const decisions = [];
    const requests = [];
    let rejectedError;
    await assert.rejects(
      fetchChinaReleaseCalendar({
        now: TEST_NOW,
        fetchFn: async (url) => {
          requests.push(String(url));
          return new Response(null, {
            status: 302,
            headers: {
              Location: `${NBS_CALENDAR_INDEX_URL}..%2f..%2fenglish/attacker-controlled.html`,
            },
          });
        },
        onDecision: (decision) => decisions.push(decision),
      }),
      (error) => {
        rejectedError = error;
        return error.message === 'NBS_REQUIRED_SOURCE_UNAVAILABLE:REDIRECT_REJECTED_UNAPPROVED_URL';
      },
    );

    assert.deepEqual(requests, [NBS_CALENDAR_INDEX_URL]);
    assert.equal(decisions[0]?.reason, 'REDIRECT_REJECTED_UNAPPROVED_URL');
    assert.equal(decisions[0]?.requestCount, 1);
    assert.equal(rejectedError.nonRetryable, true);
  });

  it('rejects a protocol-relative redirect off the approved origin', async () => {
    const decisions = [];
    const requests = [];
    await assert.rejects(
      fetchChinaReleaseCalendar({
        now: TEST_NOW,
        fetchFn: async (url) => {
          requests.push(String(url));
          return new Response(null, {
            status: 302,
            headers: { Location: '//attacker.example/english/PressRelease/ReleaseCalendar/' },
          });
        },
        onDecision: (decision) => decisions.push(decision),
      }),
      (error) => error.message === 'NBS_REQUIRED_SOURCE_UNAVAILABLE:REDIRECT_REJECTED_UNAPPROVED_URL',
    );

    assert.deepEqual(requests, [NBS_CALENDAR_INDEX_URL]);
    assert.equal(decisions[0]?.reason, 'REDIRECT_REJECTED_UNAPPROVED_URL');
    assert.equal(decisions[0]?.requestCount, 1);
  });

  it('rejects an http redirect to the approved host', async () => {
    const decisions = [];
    const requests = [];
    await assert.rejects(
      fetchChinaReleaseCalendar({
        now: TEST_NOW,
        fetchFn: async (url) => {
          requests.push(String(url));
          return new Response(null, {
            status: 302,
            headers: { Location: 'http://www.stats.gov.cn/english/PressRelease/ReleaseCalendar/' },
          });
        },
        onDecision: (decision) => decisions.push(decision),
      }),
      (error) => error.message === 'NBS_REQUIRED_SOURCE_UNAVAILABLE:REDIRECT_REJECTED_UNAPPROVED_URL',
    );

    assert.deepEqual(requests, [NBS_CALENDAR_INDEX_URL]);
    assert.equal(decisions[0]?.reason, 'REDIRECT_REJECTED_UNAPPROVED_URL');
    assert.equal(decisions[0]?.requestCount, 1);
  });

  it('rejects an implicitly redirected response if a fetch implementation ignores manual mode', async () => {
    const decisions = [];
    const implicitlyRedirected = new Response(fixture('nbs-calendar.html'));
    Object.defineProperty(implicitlyRedirected, 'redirected', { value: true });
    await assert.rejects(
      fetchChinaReleaseCalendar({
        now: TEST_NOW,
        fetchFn: async () => implicitlyRedirected,
        onDecision: (decision) => decisions.push(decision),
      }),
      (error) => error.message === 'NBS_REQUIRED_SOURCE_UNAVAILABLE:IMPLICIT_REDIRECT',
    );

    assert.equal(decisions[0]?.reason, 'IMPLICIT_REDIRECT');
    assert.equal(decisions[0]?.requestCount, 1);
  });

  it('stops an allowed redirect chain at the sibling transport cap', async () => {
    const decisions = [];
    const requests = [];
    const secondRedirectUrl = `${NBS_CALENDAR_INDEX_URL}second.html`;
    await assert.rejects(
      fetchChinaReleaseCalendar({
        now: TEST_NOW,
        fetchFn: async (url) => {
          const target = String(url);
          requests.push(target);
          const location = target === NBS_CALENDAR_INDEX_URL
            ? ALLOWED_REDIRECT_URL
            : secondRedirectUrl;
          return new Response(null, { status: 302, headers: { Location: location } });
        },
        onDecision: (decision) => decisions.push(decision),
      }),
      (error) => error.message === 'NBS_REQUIRED_SOURCE_UNAVAILABLE:REDIRECT_LIMIT_EXCEEDED',
    );

    assert.deepEqual(requests, [NBS_CALENDAR_INDEX_URL, ALLOWED_REDIRECT_URL]);
    assert.equal(decisions[0]?.reason, 'REDIRECT_LIMIT_EXCEEDED');
    assert.equal(decisions[0]?.requestCount, 2);
  });

  it('terminates a redirect loop deterministically at the redirect cap', async () => {
    const decisions = [];
    const requests = [];
    await assert.rejects(
      fetchChinaReleaseCalendar({
        now: TEST_NOW,
        fetchFn: async (url) => {
          requests.push(String(url));
          return new Response(null, { status: 302, headers: { Location: NBS_CALENDAR_INDEX_URL } });
        },
        onDecision: (decision) => decisions.push(decision),
      }),
      (error) => error.message === 'NBS_REQUIRED_SOURCE_UNAVAILABLE:REDIRECT_LIMIT_EXCEEDED',
    );

    assert.deepEqual(requests, [NBS_CALENDAR_INDEX_URL, NBS_CALENDAR_INDEX_URL]);
    assert.equal(decisions[0]?.reason, 'REDIRECT_LIMIT_EXCEEDED');
    assert.equal(decisions[0]?.requestCount, 2);
  });

  it('rejects a response whose declared Content-Length exceeds 2 MiB before reading it', async () => {
    const decisions = [];
    let bodyAccessed = false;
    await assert.rejects(
      fetchChinaReleaseCalendar({
        now: TEST_NOW,
        fetchFn: async () => ({
          status: 200,
          ok: true,
          redirected: false,
          headers: new Headers({ 'Content-Length': String(MAX_NBS_RESPONSE_BYTES + 1) }),
          get body() {
            bodyAccessed = true;
            throw new Error('oversized declared body must not be consumed');
          },
          text: async () => {
            bodyAccessed = true;
            throw new Error('oversized declared body must not be consumed');
          },
        }),
        onDecision: (decision) => decisions.push(decision),
      }),
      (error) => error.message === 'NBS_REQUIRED_SOURCE_UNAVAILABLE:RESPONSE_TOO_LARGE',
    );

    assert.equal(bodyAccessed, false);
    assert.equal(decisions[0]?.reason, 'RESPONSE_TOO_LARGE');
    assert.equal(decisions[0]?.requestCount, 1);
  });

  it('rejects an oversized streamed body when Content-Length is absent or dishonest', async () => {
    const decisions = [];
    let cancelled = false;
    const chunks = [
      new Uint8Array(MAX_NBS_RESPONSE_BYTES),
      new Uint8Array([0x20]),
    ];
    let nextChunk = 0;
    const oversizedBody = new ReadableStream({
      pull(controller) {
        controller.enqueue(chunks[nextChunk]);
        nextChunk += 1;
      },
      cancel() {
        cancelled = true;
      },
    });

    await assert.rejects(
      fetchChinaReleaseCalendar({
        now: TEST_NOW,
        fetchFn: async () => new Response(oversizedBody),
        onDecision: (decision) => decisions.push(decision),
      }),
      (error) => error.message === 'NBS_REQUIRED_SOURCE_UNAVAILABLE:RESPONSE_TOO_LARGE',
    );

    assert.equal(cancelled, true);
    assert.equal(decisions[0]?.reason, 'RESPONSE_TOO_LARGE');
    assert.equal(decisions[0]?.requestCount, 1);
  });

  it('accepts exactly 2 MiB and preserves UTF-8 split across stream chunks', async () => {
    const chineseEvent = '居民消费价格';
    const base = fixture('nbs-calendar.html').replace('National Economic Performance', chineseEvent);
    const paddingBytes = MAX_NBS_RESPONSE_BYTES - Buffer.byteLength(base, 'utf8');
    assert.ok(paddingBytes > 0);
    const exactBody = Buffer.from(`${base}${' '.repeat(paddingBytes)}`, 'utf8');
    assert.equal(exactBody.byteLength, MAX_NBS_RESPONSE_BYTES);
    const eventStart = exactBody.indexOf(Buffer.from(chineseEvent, 'utf8'));
    assert.ok(eventStart >= 0);
    const splitInsideFirstCharacter = eventStart + 1;
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(exactBody.subarray(0, splitInsideFirstCharacter));
        controller.enqueue(exactBody.subarray(splitInsideFirstCharacter));
        controller.close();
      },
    });
    const decisions = [];
    const calendar = await fetchChinaReleaseCalendar({
      now: TEST_NOW,
      fetchFn: async (url) => (
        String(url).includes('chinamoney') ? chinaMoneyResponse() : new Response(body)
      ),
      onDecision: (decision) => decisions.push(decision),
    });

    assert.ok(calendar.events.some((event) => event.kind === 'nbs' && event.event === chineseEvent));
    assert.equal(decisions[0]?.status, 'accepted');
    assert.equal(decisions[0]?.requestCount, 1);
  });

  it('keeps redirects inside the shared NBS wall-clock budget', async () => {
    const realNow = Date.now;
    let elapsed = 0;
    const decisions = [];
    const requests = [];
    Date.now = () => realNow() + elapsed;
    try {
      await assert.rejects(
        fetchChinaReleaseCalendar({
          now: TEST_NOW,
          sleepFn: async () => {},
          fetchFn: async (url) => {
            requests.push(String(url));
            elapsed += NBS_TOTAL_FETCH_BUDGET_MS;
            return new Response(null, { status: 302, headers: { Location: ALLOWED_REDIRECT_URL } });
          },
          onDecision: (decision) => decisions.push(decision),
        }),
        (error) => error.message === `NBS_REQUIRED_SOURCE_UNAVAILABLE:${FETCH_BUDGET_EXHAUSTED_REASON}`,
      );
    } finally {
      Date.now = realNow;
    }

    assert.deepEqual(requests, [NBS_CALENDAR_INDEX_URL]);
    assert.equal(decisions[0]?.reason, FETCH_BUDGET_EXHAUSTED_REASON);
    assert.equal(decisions[0]?.requestCount, 1);
  });

  it('refuses a follow-up hop when remaining budget is less than one request timeout', async () => {
    const realNow = Date.now;
    let elapsed = 0;
    const decisions = [];
    const requests = [];
    Date.now = () => realNow() + elapsed;
    try {
      await assert.rejects(
        fetchChinaReleaseCalendar({
          now: TEST_NOW,
          sleepFn: async () => {},
          fetchFn: async (url) => {
            requests.push(String(url));
            elapsed += NBS_TOTAL_FETCH_BUDGET_MS - 5_000;
            return new Response(null, { status: 302, headers: { Location: ALLOWED_REDIRECT_URL } });
          },
          onDecision: (decision) => decisions.push(decision),
        }),
        (error) => error.message === `NBS_REQUIRED_SOURCE_UNAVAILABLE:${FETCH_BUDGET_EXHAUSTED_REASON}`,
      );
    } finally {
      Date.now = realNow;
    }

    assert.deepEqual(requests, [NBS_CALENDAR_INDEX_URL]);
    assert.equal(decisions[0]?.reason, FETCH_BUDGET_EXHAUSTED_REASON);
    assert.equal(decisions[0]?.requestCount, 1);
  });

  it('retries a transient failure after a redirect without losing HTTP-hop accounting', async () => {
    const decisions = [];
    const requests = [];
    const slept = [];
    let indexAttempts = 0;
    const calendar = await fetchChinaReleaseCalendar({
      now: TEST_NOW,
      sleepFn: async (ms) => { slept.push(ms); },
      fetchFn: async (url) => {
        const target = String(url);
        if (target.includes('chinamoney')) return chinaMoneyResponse();
        requests.push(target);
        if (target === NBS_CALENDAR_INDEX_URL) {
          indexAttempts += 1;
          if (indexAttempts === 1) {
            return new Response(null, { status: 302, headers: { Location: ALLOWED_REDIRECT_URL } });
          }
          return new Response(fixture('nbs-calendar.html'));
        }
        return new Response('', { status: 503, headers: { 'Retry-After': '5' } });
      },
      onDecision: (decision) => decisions.push(decision),
    });

    assert.ok(calendar.events.some((event) => event.kind === 'nbs'));
    assert.deepEqual(requests, [NBS_CALENDAR_INDEX_URL, ALLOWED_REDIRECT_URL, NBS_CALENDAR_INDEX_URL]);
    assert.deepEqual(slept, [5_000]);
    assert.equal(decisions[0]?.requestCount, 3);
  });

  it('recovers from a transient network failure on the NBS index', async () => {
    const decisions = [];
    const requests = [];
    const calendar = await fetchChinaReleaseCalendar({
      now: Date.parse('2026-07-13T00:00:00Z'),
      fetchFn: async (url) => {
        requests.push(String(url));
        if (String(url) === NBS_CALENDAR_INDEX_URL && requests.length === 1) {
          throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
        }
        if (String(url) === NBS_CALENDAR_INDEX_URL) return new Response('<a href="calendar.html">2026 release calendar</a>');
        if (String(url).endsWith('calendar.html')) return new Response(fixture('nbs-calendar.html'));
        return new Response(fixture('chinamoney-lpr.json'), { headers: { 'Content-Type': 'application/json' } });
      },
      onDecision: (decision) => decisions.push(decision),
    });
    assert.ok(calendar.events.some((event) => event.kind === 'nbs'));
    assert.equal(decisions[0]?.status, 'accepted');
    assert.equal(decisions[0]?.reason, 'OK');
    // The retried attempt is a real request against an official host, so the
    // audited request count must include it: 2 index attempts + 1 calendar page.
    assert.equal(decisions[0]?.requestCount, 3);
  });

  it('recovers from a transient network failure on the year-specific NBS calendar page', async () => {
    const decisions = [];
    let calendarAttempts = 0;
    const calendar = await fetchChinaReleaseCalendar({
      now: Date.parse('2026-07-13T00:00:00Z'),
      fetchFn: async (url) => {
        if (String(url) === NBS_CALENDAR_INDEX_URL) return new Response('<a href="calendar.html">2026 release calendar</a>');
        if (String(url).endsWith('calendar.html')) {
          calendarAttempts += 1;
          if (calendarAttempts === 1) throw new TypeError('fetch failed');
          return new Response(fixture('nbs-calendar.html'));
        }
        return new Response(fixture('chinamoney-lpr.json'), { headers: { 'Content-Type': 'application/json' } });
      },
      onDecision: (decision) => decisions.push(decision),
    });
    assert.ok(calendar.events.some((event) => event.kind === 'nbs'));
    assert.equal(decisions[0]?.status, 'accepted');
    assert.equal(decisions[0]?.requestCount, 3);
  });

  it('retries a transient NBS 5xx but never a permanent 4xx', async () => {
    const serverErrorRequests = [];
    const recovered = await fetchChinaReleaseCalendar({
      now: Date.parse('2026-07-13T00:00:00Z'),
      fetchFn: async (url) => {
        if (String(url) === NBS_CALENDAR_INDEX_URL) {
          serverErrorRequests.push(String(url));
          if (serverErrorRequests.length === 1) return new Response('', { status: 503 });
          return new Response('<a href="calendar.html">2026 release calendar</a>');
        }
        if (String(url).endsWith('calendar.html')) return new Response(fixture('nbs-calendar.html'));
        return new Response(fixture('chinamoney-lpr.json'), { headers: { 'Content-Type': 'application/json' } });
      },
      onDecision: () => {},
    });
    assert.ok(recovered.events.some((event) => event.kind === 'nbs'));
    assert.equal(serverErrorRequests.length, 2);

    // A permanent status must fail closed on the first response — retrying it
    // would triple the load on an official government host for no benefit.
    const forbiddenRequests = [];
    const decisions = [];
    let rejectedError;
    await assert.rejects(
      fetchChinaReleaseCalendar({
        now: Date.parse('2026-07-13T00:00:00Z'),
        fetchFn: async (url) => {
          forbiddenRequests.push(String(url));
          return new Response('', { status: 403 });
        },
        onDecision: (decision) => decisions.push(decision),
      }),
      (error) => {
        rejectedError = error;
        return /NBS_REQUIRED_SOURCE_UNAVAILABLE:HTTP_403/.test(error.message);
      },
    );
    assert.deepEqual(forbiddenRequests, [NBS_CALENDAR_INDEX_URL]);
    assert.equal(decisions[0]?.reason, 'HTTP_403');
    assert.equal(decisions[0]?.requestCount, 1);
    assert.equal(rejectedError.nonRetryable, true);
  });

  // seed-china-release-calendar.mjs holds a 180s lock inside a 240s bundle
  // section; atomicPublish makes several retried Redis round trips inside that
  // same lock after the fetch returns, so the fetch phase must leave it room.
  const SEEDER_LOCK_TTL_MS = 180_000;
  const BUNDLE_SECTION_TIMEOUT_MS = 240_000;
  const CHINAMONEY_TIMEOUT_MS = 20_000;
  // The deadline reserves each gated attempt's full timeout, so every RETRY
  // ends inside the budget. What can still land outside it is the one ungated
  // first attempt per URL — hence budget + one request, then ChinaMoney.
  const CEILING_MS = NBS_TOTAL_FETCH_BUDGET_MS + NBS_REQUEST_TIMEOUT_MS + CHINAMONEY_TIMEOUT_MS;

  /**
   * Drive a whole run on a virtual clock where every request burns its full
   * timeout and sleeps advance time, and report the observed wall time. This is
   * how the ceiling gets MEASURED rather than recomputed from the same
   * constants the implementation uses.
   */
  const measureRun = async ({
    retryAfterSeconds = null,
    indexSucceedsOnAttempt = null,
    pageSucceeds = false,
    indexHangs = false,
    pageHangs = false,
    proxyMode = null,
  } = {}) => {
    const realNow = Date.now;
    let clock = 0;
    let indexAttempts = 0;
    const exitsByUrl = new Map();
    Date.now = () => realNow() + clock;
    try {
      await fetchChinaReleaseCalendar({
        sleepFn: async (ms) => { clock += ms; },
        fetchFn: async (url) => {
          const target = String(url);
          // ChinaMoney runs ONLY when both NBS fetches succeeded — a failing NBS
          // throws first. So the longest run is the SUCCESS path, which is also
          // the only one that reaches publish and therefore the one the lock
          // budget exists for.
          if (target.includes('chinamoney')) {
            clock += CHINAMONEY_TIMEOUT_MS;
            throw new TypeError('fetch failed');
          }
          clock += NBS_REQUEST_TIMEOUT_MS;
          if (target === NBS_CALENDAR_INDEX_URL) {
            indexAttempts += 1;
            if (indexHangs) throw hangTimeout();
            if (indexSucceedsOnAttempt !== null && indexAttempts >= indexSucceedsOnAttempt) {
              return new Response(INDEX_ANCHOR);
            }
          } else {
            if (pageHangs) throw hangTimeout();
            if (pageSucceeds) return new Response(fixture('nbs-calendar.html'));
          }
          const headers = retryAfterSeconds === null ? undefined : { 'Retry-After': String(retryAfterSeconds) };
          return new Response('', { status: 503, headers });
        },
        ...(proxyMode === null ? {} : {
          proxyUrl: PARSEABLE_PROXY,
          proxyFetchFn: async (url, _config, { timeoutMs }) => {
            const exit = (exitsByUrl.get(String(url)) ?? 0) + 1;
            exitsByUrl.set(String(url), exit);
            if (proxyMode === 'fail') {
              clock += timeoutMs;
              throw new Error('exit hang');
            }
            if (proxyMode === 'succeed-on-exit-4' && exit < 4) {
              clock += Math.min(3_000, timeoutMs);
              throw new Error('exit CONNECT failed');
            }
            clock += proxyMode === 'succeed-fast' ? 1_000 : timeoutMs;
            return proxyResult(nbsPage(url));
          },
        }),
        onDecision: () => {},
      });
    } catch { /* a failing run is a valid scenario too */ } finally {
      Date.now = realNow;
    }
    return clock;
  };

  it('pins the constants the fetch-phase ceiling is derived from', () => {
    // Asserted against literals on purpose: every other retry test compares
    // against the imported constants, so raising one would move those
    // assertions with it and silently widen the budget.
    assert.equal(NBS_TRANSIENT_FETCH_ATTEMPTS, 3);
    assert.equal(NBS_REQUEST_TIMEOUT_MS, 20_000);
    assert.equal(NBS_TRANSIENT_RETRY_DELAY_MS, 500);
    assert.equal(NBS_TOTAL_FETCH_BUDGET_MS, 75_000);
    assert.equal(PROXY_FALLBACK_BUDGET_MS, 16_000);
    assert.equal(CEILING_MS, 115_000);
    // Leave the publish phase at least a third of the lock.
    assert.ok(CEILING_MS <= SEEDER_LOCK_TTL_MS * (2 / 3));
    assert.ok(CEILING_MS < BUNDLE_SECTION_TIMEOUT_MS / 2);
  });

  it('keeps the OBSERVED fetch phase inside the ceiling, including a Retry-After that fits the budget', async (t) => {
    t.mock.method(console, 'warn', () => {});
    // A hint large enough to fit the deadline check but long enough to push the
    // index's next attempt past it was the real breach: the attempt STARTED in
    // budget, succeeded 20s outside it, and the calendar page's ungated first
    // attempt added another 20s — 134s observed against a 115s claim. Sweeping
    // the hint across the budget is what catches that class, not arithmetic.
    const scenarios = [
      { label: 'all fail, no hint' },
      { label: 'all fail, short hint', retryAfterSeconds: 5 },
      { label: 'index succeeds first try, page fails', indexSucceedsOnAttempt: 1 },
      { label: 'index succeeds late, page fails', indexSucceedsOnAttempt: 2 },
      { label: 'absurd hint', retryAfterSeconds: 3_600 },
      { label: 'full success, no hint', indexSucceedsOnAttempt: 1, pageSucceeds: true },
      { label: 'both hang, every exit fails', indexHangs: true, pageHangs: true, proxyMode: 'fail' },
      { label: 'both hang, proxy succeeds on exit 4', indexHangs: true, pageHangs: true, proxyMode: 'succeed-on-exit-4' },
      { label: 'both hang, proxy succeeds at once', indexHangs: true, pageHangs: true, proxyMode: 'succeed-fast' },
      { label: 'index succeeds late, page hangs, every exit fails', indexSucceedsOnAttempt: 2, pageHangs: true, proxyMode: 'fail' },
      { label: 'index succeeds late, page hangs, proxy succeeds on exit 4', indexSucceedsOnAttempt: 2, pageHangs: true, proxyMode: 'succeed-on-exit-4' },
    ];
    // Sweep at 1s granularity: the breach only appears for hints in a narrow
    // band (large enough to push the next attempt past the deadline, small
    // enough to still pass the check), and a 5s step steps right over it.
    for (let hint = 1; hint <= 80; hint += 1) {
      scenarios.push({ label: `failing run, hint ${hint}s`, retryAfterSeconds: hint });
      scenarios.push({ label: `late index success, page fails, hint ${hint}s`, retryAfterSeconds: hint, indexSucceedsOnAttempt: 2 });
      // The costliest shape: everything eventually SUCCEEDS but slowly, so
      // ChinaMoney runs too and the whole fetch phase lands before publish.
      scenarios.push({
        label: `full success after a late retry, hint ${hint}s`,
        retryAfterSeconds: hint,
        indexSucceedsOnAttempt: 2,
        pageSucceeds: true,
      });
      // The page's ungated first hop starting late is where an unclamped
      // proxy ladder would add up to 16s on top of the 20s direct hang.
      for (const proxyMode of ['fail', 'succeed-on-exit-4']) {
        scenarios.push({
          label: `late index success, page hangs into the proxy (${proxyMode}), hint ${hint}s`,
          retryAfterSeconds: hint,
          indexSucceedsOnAttempt: 2,
          pageHangs: true,
          proxyMode,
        });
      }
    }

    let worst = { label: '', observedMs: 0 };
    for (const { label, ...options } of scenarios) {
      const observedMs = await measureRun(options);
      if (observedMs > worst.observedMs) worst = { label, observedMs };
      assert.ok(
        observedMs <= CEILING_MS,
        `${label}: observed fetch phase ${observedMs}ms exceeds the ${CEILING_MS}ms ceiling`,
      );
    }
    t.diagnostic(`worst observed fetch phase ${worst.observedMs}ms (${worst.label}) against a ${CEILING_MS}ms ceiling`);
  });

  it('shares one wall-clock budget across both NBS URLs rather than giving each a fresh one', async () => {
    // The whole point of a shared deadline: a host that hangs on the index must
    // not leave the calendar page a full budget. Without this the index could
    // burn 75s and the calendar page start another 75s, doubling the ceiling
    // the seeder's lock was sized against.
    let calendarPageAttempts = 0;
    const realNow = Date.now;
    let elapsed = 0;
    Date.now = () => realNow() + elapsed;
    try {
      await assert.rejects(
        fetchChinaReleaseCalendar({
          now: Date.parse('2026-07-13T00:00:00Z'),
          sleepFn: async () => {},
          fetchFn: async (url) => {
            if (String(url) === NBS_CALENDAR_INDEX_URL) {
              // Index succeeds, but leaves less than one backoff of budget.
              elapsed += NBS_TOTAL_FETCH_BUDGET_MS - (NBS_TRANSIENT_RETRY_DELAY_MS - 100);
              return new Response('<a href="calendar.html">2026 release calendar</a>');
            }
            calendarPageAttempts += 1;
            throw new TypeError('fetch failed');
          },
          onDecision: () => {},
        }),
        // The shared budget — not the attempt count — is what stopped it.
        (error) => error.message === `NBS_REQUIRED_SOURCE_UNAVAILABLE:${FETCH_BUDGET_EXHAUSTED_REASON}`,
      );
    } finally {
      Date.now = realNow;
    }
    // The calendar page gets ONE attempt because the index already spent the
    // shared budget. A per-URL budget would have handed it a fresh 75s and all
    // NBS_TRANSIENT_FETCH_ATTEMPTS tries.
    assert.equal(calendarPageAttempts, 1);
    assert.ok(calendarPageAttempts < NBS_TRANSIENT_FETCH_ATTEMPTS);
  });

  it('grows the backoff with each attempt and never undercuts the host Retry-After hint', async () => {
    const slept = [];
    let indexAttempts = 0;
    let pageAttempts = 0;
    const calendar = await fetchChinaReleaseCalendar({
      now: Date.parse('2026-07-13T00:00:00Z'),
      sleepFn: async (ms) => { slept.push(ms); },
      fetchFn: async (url) => {
        if (String(url) === NBS_CALENDAR_INDEX_URL) {
          indexAttempts += 1;
          // Two BARE transient failures, so the growth term is observable on
          // its own. Pairing growth with a Retry-After hint would hide it —
          // the hint dominates the max() and a flat delay would look identical.
          if (indexAttempts <= 2) return new Response('', { status: 503 });
          return new Response('<a href="calendar.html">2026 release calendar</a>');
        }
        if (String(url).endsWith('calendar.html')) {
          pageAttempts += 1;
          if (pageAttempts === 1) return new Response('', { status: 503, headers: { 'Retry-After': '5' } });
          return new Response(fixture('nbs-calendar.html'));
        }
        return new Response(fixture('chinamoney-lpr.json'), { headers: { 'Content-Type': 'application/json' } });
      },
      onDecision: () => {},
    });
    assert.ok(calendar.events.some((event) => event.kind === 'nbs'));
    // 500 then 1000 proves the growth term; 5000 proves the host's hint wins
    // over the 500ms the schedule would have used for a first retry.
    assert.deepEqual(slept, [500, 1_000, 5_000]);
  });

  for (const status of [408, 429]) {
    it(`retries a transient NBS ${status}`, async () => {
      const indexRequests = [];
      const calendar = await fetchChinaReleaseCalendar({
        now: Date.parse('2026-07-13T00:00:00Z'),
        sleepFn: async () => {},
        fetchFn: async (url) => {
          if (String(url) === NBS_CALENDAR_INDEX_URL) {
            indexRequests.push(status);
            if (indexRequests.length === 1) return new Response('', { status });
            return new Response('<a href="calendar.html">2026 release calendar</a>');
          }
          if (String(url).endsWith('calendar.html')) return new Response(fixture('nbs-calendar.html'));
          return new Response(fixture('chinamoney-lpr.json'), { headers: { 'Content-Type': 'application/json' } });
        },
        onDecision: () => {},
      });
      assert.ok(calendar.events.some((event) => event.kind === 'nbs'));
      assert.equal(indexRequests.length, 2);
    });
  }

  it('stops retrying once the shared NBS wall-clock budget is spent', async () => {
    // A host that hangs must not spend the calendar page's share of the budget.
    // Simulated by advancing past the deadline rather than sleeping 75s.
    const requests = [];
    const decisions = [];
    const realNow = Date.now;
    let elapsed = 0;
    Date.now = () => realNow() + elapsed;
    try {
      await assert.rejects(
        fetchChinaReleaseCalendar({
          now: Date.parse('2026-07-13T00:00:00Z'),
          sleepFn: async () => {},
          fetchFn: async (url) => {
            requests.push(String(url));
            elapsed += NBS_TOTAL_FETCH_BUDGET_MS; // first attempt burns the budget
            throw new TypeError('fetch failed');
          },
          onDecision: (decision) => decisions.push(decision),
        }),
        // Giving up on budget and failing permanently both used to surface as a
        // bare FETCH_FAILED, so an operator could not tell "the host is
        // hanging" from "the host is refusing" in the preflight record.
        (error) => error.message === `NBS_REQUIRED_SOURCE_UNAVAILABLE:${FETCH_BUDGET_EXHAUSTED_REASON}`,
      );
    } finally {
      Date.now = realNow;
    }
    assert.equal(decisions[0]?.reason, FETCH_BUDGET_EXHAUSTED_REASON);
    // Budget exhausted after attempt 1, so attempts 2 and 3 never fire even
    // though the failure was transient and the attempt budget allowed them.
    assert.equal(requests.length, 1);
  });

  // Node surfaces a bad chain either as a bare error carrying `code` or wrapped
  // in a TypeError whose `cause` carries it; both must fail closed.
  // Each code-based fixture deliberately carries a NEUTRAL message with no
  // certificate wording. Real Node errors do carry both, but pairing them here
  // would let the message backstop mask the code set: dropping a code from
  // PERMANENT_TLS_CODES would still pass. The neutral message isolates the arm
  // under test, so each code has to earn its own place. The last fixture is the
  // mirror image — message wording, no code — covering the backstop itself.
  const codeError = (code) => Object.assign(new TypeError('fetch failed'), {
    cause: Object.assign(new Error('connection terminated'), { code }),
  });
  // Table-driven from the exported set so EVERY member is covered: hand-listing
  // a few codes left the rest as undetected mutants while the suite still
  // claimed each code was pinned. Adding a code to the set now adds its test.
  const certFixtures = [
    ...[...PERMANENT_TLS_CODES].map((code) => [`cause.code ${code}`, () => codeError(code)]),
    ['top-level code', () => Object.assign(new Error('fetch failed'), { code: 'SELF_SIGNED_CERT_IN_CHAIN' })],
    ['message backstop, no code', () => new TypeError('self signed certificate in certificate chain')],
  ];

  it('covers every code in PERMANENT_TLS_CODES', () => {
    // Guards the table above against silently shrinking.
    assert.ok(PERMANENT_TLS_CODES.size >= 26);
    assert.equal(certFixtures.length, PERMANENT_TLS_CODES.size + 2);
  });

  for (const [shape, makeError] of certFixtures) {
    it(`fails closed on a certificate-validation failure (${shape}) instead of retrying an intercepted connection`, async () => {
      const requests = [];
      const decisions = [];
      let proxyCalls = 0;
      await assert.rejects(
        fetchChinaReleaseCalendar({
          now: Date.parse('2026-07-13T00:00:00Z'),
          sleepFn: async () => {},
          fetchFn: async (url) => {
            requests.push(String(url));
            throw makeError();
          },
          proxyUrl: PARSEABLE_PROXY,
          proxyFetchFn: async (url) => {
            proxyCalls += 1;
            return proxyResult(nbsPage(url));
          },
          onDecision: (decision) => decisions.push(decision),
        }),
        // The reason must NOT collapse into the generic FETCH_FAILED — an
        // operator has to be able to tell interception from a socket blip.
        (error) => error.message === `NBS_REQUIRED_SOURCE_UNAVAILABLE:${TLS_CERT_UNTRUSTED_REASON}`,
      );
      // A bad chain means interception, not a hiccup — one attempt, then stop.
      assert.deepEqual(requests, [NBS_CALENDAR_INDEX_URL]);
      assert.equal(decisions[0]?.reason, TLS_CERT_UNTRUSTED_REASON);
      assert.equal(decisions[0]?.requestCount, 1);
      // A different egress point hits the same untrusted peer.
      assert.equal(proxyCalls, 0);
    });
  }

  it('still fails closed once the transient NBS attempt budget is exhausted', async () => {
    const requests = [];
    const decisions = [];
    let rejectedError;
    // The ONE test left on the real sleepFn, so the production default (a real
    // setTimeout) stays exercised rather than only ever being stubbed out.
    await assert.rejects(
      fetchChinaReleaseCalendar({
        now: Date.parse('2026-07-13T00:00:00Z'),
        fetchFn: async (url) => {
          requests.push(String(url));
          throw new TypeError('fetch failed');
        },
        onDecision: (decision) => decisions.push(decision),
      }),
      (error) => {
        rejectedError = error;
        return /NBS_REQUIRED_SOURCE_UNAVAILABLE:FETCH_FAILED/.test(error.message);
      },
    );
    // Attempts ran out, not the clock — so this keeps the generic reason.
    assert.equal(requests.length, NBS_TRANSIENT_FETCH_ATTEMPTS);
    assert.ok(requests.every((url) => url === NBS_CALENDAR_INDEX_URL));
    assert.equal(decisions[0]?.reason, 'FETCH_FAILED');
    assert.equal(decisions[0]?.requestCount, NBS_TRANSIENT_FETCH_ATTEMPTS);
    assert.equal(rejectedError.nonRetryable, true);
  });

  it('records the actual NBS and ChinaMoney preflight request decisions', async () => {
    const decisions = [];
    const calendar = await fetchChinaReleaseCalendar({
      now: Date.parse('2026-07-13T00:00:00Z'),
      fetchFn: async (url) => {
        if (String(url).includes('ReleaseCalendar') && !String(url).endsWith('calendar.html')) {
          return new Response('<a href="calendar.html">2026 release calendar</a>');
        }
        if (String(url).endsWith('calendar.html')) return new Response(fixture('nbs-calendar.html'));
        return new Response(fixture('chinamoney-lpr.json'), { headers: { 'Content-Type': 'application/json' } });
      },
      onDecision: (decision) => decisions.push(decision),
    });
    assert.ok(calendar.events.length > 0);
    assert.deepEqual(
      decisions.map(({ source, status, requestCount }) => ({ source, status, requestCount })),
      [
        { source: 'NBS release calendar', status: 'accepted', requestCount: 2 },
        { source: 'PBoC/ChinaMoney LPR verification', status: 'accepted', requestCount: 1 },
      ],
    );
  });
});

describe('NBS proxy fallback', () => {
  const CREDENTIAL_PATTERN = /proxy\.test|user:pass|secret/;
  const nbsRefusedDirect = async (url) => {
    if (String(url).includes('chinamoney')) return chinaMoneyResponse();
    throw connectionRefused();
  };
  const withClock = async (run) => {
    const realNow = Date.now;
    const clock = { elapsed: 0 };
    Date.now = () => realNow() + clock.elapsed;
    try {
      return await run(clock);
    } finally {
      Date.now = realNow;
    }
  };

  it('never calls the proxy and logs identically when proxyUrl is null', async (t) => {
    const logs = [];
    t.mock.method(console, 'warn', (line) => logs.push(JSON.parse(line)));
    const requests = [];
    const sleeps = [];
    const decisions = [];
    let proxyCalls = 0;
    await assert.rejects(fetchChinaReleaseCalendar({
      now: TEST_NOW,
      fetchFn: async (url, options) => {
        requests.push({ url, redirect: options.redirect });
        throw Object.assign(new TypeError('secret-token https://user:pass@example.test'), {
          cause: { code: 'ENOTFOUND', message: 'secret-host', address: 'secret-address' },
        });
      },
      proxyUrl: null,
      proxyFetchFn: async () => { proxyCalls += 1; throw new Error('unexpected proxy'); },
      sleepFn: async (ms) => sleeps.push(ms),
      onDecision: (entry) => decisions.push(entry),
    }), /NBS_REQUIRED_SOURCE_UNAVAILABLE:FETCH_FAILED/);
    assert.equal(proxyCalls, 0);
    assert.deepEqual(requests, Array(3).fill({ url: NBS_CALENDAR_INDEX_URL, redirect: 'manual' }));
    assert.deepEqual(sleeps, [500, 1000]);
    assert.deepEqual(decisions[0], {
      source: 'NBS release calendar', host: 'www.stats.gov.cn', status: 'blocked', reason: 'FETCH_FAILED',
      checkedAt: new Date(TEST_NOW).toISOString(), optional: false, requestCount: 3,
    });
    assert.deepEqual(logs, [1, 2, 3].map((attempt) => ({
      event: 'china_calendar_transport_failure', host: 'www.stats.gov.cn',
      resource: 'index', transport: 'direct', attempt, code: 'ENOTFOUND',
    })));
  });

  it('recovers both NBS pages through the proxy when direct cannot connect', async (t) => {
    const logs = [];
    t.mock.method(console, 'warn', (line) => logs.push(JSON.parse(line)));
    const proxied = [];
    const sleeps = [];
    const decisions = [];
    const calendar = await fetchChinaReleaseCalendar({
      now: TEST_NOW,
      fetchFn: nbsRefusedDirect,
      proxyUrl: PARSEABLE_PROXY,
      proxyFetchFn: async (url, _config, options) => {
        proxied.push({ url: String(url), userAgent: options.headers['User-Agent'], aborted: options.signal.aborted });
        return proxyResult(nbsPage(url));
      },
      sleepFn: async (ms) => sleeps.push(ms),
      onDecision: (entry) => decisions.push(entry),
    });
    assert.ok(calendar.events.some((event) => event.kind === 'nbs'));
    assert.deepEqual(decisions[0], {
      source: 'NBS release calendar', host: 'www.stats.gov.cn', status: 'accepted', reason: 'OK',
      checkedAt: new Date(TEST_NOW).toISOString(), optional: false, requestCount: 2, proxyFallbacks: 2,
    });
    assert.deepEqual(sleeps, []);
    assert.deepEqual(proxied, [NBS_CALENDAR_INDEX_URL, CALENDAR_PAGE_URL].map((url) => ({
      url, userAgent: 'WorldMonitor/2.10 (+https://worldmonitor.app)', aborted: false,
    })));
    assert.deepEqual(logs, ['index', 'calendar'].map((resource) => ({
      event: 'china_calendar_transport_failure', host: 'www.stats.gov.cn',
      resource, transport: 'direct', recovered: 'proxy', code: 'ECONNREFUSED',
    })));
    assert.doesNotMatch(JSON.stringify([decisions, logs]), CREDENTIAL_PATTERN);
  });

  it('counts only the hop the proxy recovered when the other page loads directly', async (t) => {
    t.mock.method(console, 'warn', () => {});
    const proxied = [];
    const decisions = [];
    const calendar = await fetchChinaReleaseCalendar({
      now: TEST_NOW,
      fetchFn: async (url, init) => (String(url) === CALENDAR_PAGE_URL
        ? nbsRefusedDirect(url, init)
        : String(url) === NBS_CALENDAR_INDEX_URL ? new Response(INDEX_ANCHOR) : chinaMoneyResponse()),
      proxyUrl: PARSEABLE_PROXY,
      proxyFetchFn: async (url) => {
        proxied.push(String(url));
        return proxyResult(nbsPage(url));
      },
      sleepFn: async () => {},
      onDecision: (entry) => decisions.push(entry),
    });
    assert.ok(calendar.events.some((event) => event.kind === 'nbs'));
    assert.deepEqual(proxied, [CALENDAR_PAGE_URL]);
    assert.equal(decisions[0].requestCount, 2);
    assert.equal(decisions[0].proxyFallbacks, 1);
  });

  it('surfaces the direct failure and stops retrying that URL once every exit fails', async (t) => {
    const logs = [];
    t.mock.method(console, 'warn', (line) => logs.push(JSON.parse(line)));
    const requests = [];
    const sleeps = [];
    const decisions = [];
    let proxyCalls = 0;
    await assert.rejects(fetchChinaReleaseCalendar({
      now: TEST_NOW,
      fetchFn: async (url) => {
        requests.push(String(url));
        throw Object.assign(new TypeError('secret-token https://user:pass@example.test'), {
          cause: { code: 'ENOTFOUND', message: 'secret-host' },
        });
      },
      proxyUrl: PARSEABLE_PROXY,
      proxyFetchFn: async () => {
        proxyCalls += 1;
        throw Object.assign(new Error('secret http://user:pass@proxy.test'), {
          cause: { code: 'ETIMEDOUT', message: 'Authorization: secret' },
          proxyFailure: { stage: 'target_tls', proxyConnectStatus: 522 },
        });
      },
      sleepFn: async (ms) => sleeps.push(ms),
      onDecision: (entry) => decisions.push(entry),
    }), /NBS_REQUIRED_SOURCE_UNAVAILABLE:FETCH_FAILED/);
    assert.deepEqual(requests, [NBS_CALENDAR_INDEX_URL]);
    assert.equal(proxyCalls, 4);
    assert.deepEqual(sleeps, []);
    assert.equal(decisions[0].requestCount, 1);
    assert.equal('proxyFallbacks' in decisions[0], false);
    assert.deepEqual(logs, [
      ...[1, 2, 3, 4].map((attempt) => ({
        event: 'china_macro_transport_failure', host: 'www.stats.gov.cn', resource: 'source',
        transport: 'proxy', attempt, code: 'ETIMEDOUT', stage: 'target_tls', proxyConnectStatus: 522,
      })),
      {
        event: 'china_calendar_transport_failure', host: 'www.stats.gov.cn',
        resource: 'index', transport: 'direct', attempt: 1, code: 'ENOTFOUND',
      },
    ]);
    assert.doesNotMatch(JSON.stringify([decisions, logs]), CREDENTIAL_PATTERN);
  });

  it('never re-asks a publisher status through the proxy', async () => {
    let proxyCalls = 0;
    const proxyFetchFn = async (url) => { proxyCalls += 1; return proxyResult(nbsPage(url)); };
    const forbidden = [];
    await assert.rejects(fetchChinaReleaseCalendar({
      now: TEST_NOW,
      fetchFn: async () => new Response('', { status: 403 }),
      proxyUrl: PARSEABLE_PROXY,
      proxyFetchFn,
      onDecision: (entry) => forbidden.push(entry),
    }), /NBS_REQUIRED_SOURCE_UNAVAILABLE:HTTP_403/);
    assert.equal(forbidden[0].requestCount, 1);

    let indexRequests = 0;
    const recovered = [];
    const calendar = await fetchChinaReleaseCalendar({
      now: TEST_NOW,
      fetchFn: async (url) => {
        if (String(url) === NBS_CALENDAR_INDEX_URL) {
          indexRequests += 1;
          return indexRequests === 1 ? new Response('', { status: 503 }) : new Response(INDEX_ANCHOR);
        }
        if (String(url) === CALENDAR_PAGE_URL) return new Response(fixture('nbs-calendar.html'));
        return chinaMoneyResponse();
      },
      proxyUrl: PARSEABLE_PROXY,
      proxyFetchFn,
      sleepFn: async () => {},
      onDecision: (entry) => recovered.push(entry),
    });
    assert.ok(calendar.events.some((event) => event.kind === 'nbs'));
    assert.equal(recovered[0].requestCount, 3);
    assert.equal('proxyFallbacks' in recovered[0], false);
    assert.equal(proxyCalls, 0);
  });

  it('never routes a caller abort through the proxy', async () => {
    const requests = [];
    let proxyCalls = 0;
    await assert.rejects(fetchChinaReleaseCalendar({
      now: TEST_NOW,
      fetchFn: async (url) => {
        requests.push(String(url));
        throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      },
      proxyUrl: PARSEABLE_PROXY,
      proxyFetchFn: async (url) => { proxyCalls += 1; return proxyResult(nbsPage(url)); },
      sleepFn: async () => {},
      onDecision: () => {},
    }), /NBS_REQUIRED_SOURCE_UNAVAILABLE:FETCH_FAILED/);
    assert.equal(requests.length, NBS_TRANSIENT_FETCH_ATTEMPTS);
    assert.equal(proxyCalls, 0);
  });

  it('applies the redirect policy to a response delivered through the proxy', async () => {
    const decisions = [];
    const calendar = await fetchChinaReleaseCalendar({
      now: TEST_NOW,
      fetchFn: nbsRefusedDirect,
      proxyUrl: PARSEABLE_PROXY,
      proxyFetchFn: async (url) => (String(url) === NBS_CALENDAR_INDEX_URL
        ? proxyResult('', { status: 302, location: ALLOWED_REDIRECT_URL })
        : proxyResult(fixture('nbs-calendar.html'))),
      onDecision: (entry) => decisions.push(entry),
    });
    assert.ok(calendar.events.some((event) => event.kind === 'nbs'));
    assert.equal(decisions[0].requestCount, 2);
    assert.equal(decisions[0].proxyFallbacks, 2);

    const rejected = [];
    let proxyCalls = 0;
    await assert.rejects(fetchChinaReleaseCalendar({
      now: TEST_NOW,
      fetchFn: nbsRefusedDirect,
      proxyUrl: PARSEABLE_PROXY,
      proxyFetchFn: async () => {
        proxyCalls += 1;
        return proxyResult('', { status: 302, location: 'https://attacker.example/nbs-calendar.html' });
      },
      onDecision: (entry) => rejected.push(entry),
    }), /NBS_REQUIRED_SOURCE_UNAVAILABLE:REDIRECT_REJECTED_UNAPPROVED_URL/);
    assert.equal(proxyCalls, 1);
    assert.equal(rejected[0].requestCount, 1);
  });

  it('reports an oversized proxied body as RESPONSE_TOO_LARGE without rotating exits', async () => {
    const decisions = [];
    let proxyCalls = 0;
    await assert.rejects(fetchChinaReleaseCalendar({
      now: TEST_NOW,
      fetchFn: nbsRefusedDirect,
      proxyUrl: PARSEABLE_PROXY,
      proxyFetchFn: async () => {
        proxyCalls += 1;
        return proxyResult('x'.repeat(MAX_NBS_RESPONSE_BYTES + 1));
      },
      sleepFn: async () => {},
      onDecision: (entry) => decisions.push(entry),
    }), /NBS_REQUIRED_SOURCE_UNAVAILABLE:RESPONSE_TOO_LARGE/);
    assert.equal(proxyCalls, 1);
    assert.equal(decisions[0].requestCount, 1);
  });

  // The real proxyFetch rejects these mid-stream (_proxy-utils.cjs) rather than
  // returning a buffer, so each shape must stop the exit rotation itself: a
  // later exit's success must not launder the first exit's verdict.
  const proxyRejection = (code, proxyFailure) => Object.assign(new Error('secret'), {
    code, ...(proxyFailure ? { proxyFailure } : {}),
  });
  for (const [label, rejection, expected] of [
    ['a streamed oversize rejection', proxyRejection('RESPONSE_TOO_LARGE', { stage: 'response_body', httpStatus: 200 }), /RESPONSE_TOO_LARGE/],
    ['a target certificate failure', Object.assign(proxyRejection(undefined, { stage: 'target_tls' }), { cause: { code: 'CERT_HAS_EXPIRED' } }), new RegExp(TLS_CERT_UNTRUSTED_REASON)],
    ['a publisher refusal whose body failed', proxyRejection('ECONNRESET', { stage: 'response_body', httpStatus: 429 }), /FETCH_FAILED/],
  ]) {
    it(`stops rotating exits on ${label}`, async (t) => {
      t.mock.method(console, 'warn', () => {});
      const decisions = [];
      let proxyCalls = 0;
      await assert.rejects(fetchChinaReleaseCalendar({
        now: TEST_NOW,
        fetchFn: nbsRefusedDirect,
        proxyUrl: PARSEABLE_PROXY,
        proxyFetchFn: async () => {
          proxyCalls += 1;
          if (proxyCalls === 1) throw rejection;
          return proxyResult(proxyCalls === 2 ? INDEX_ANCHOR : fixture('nbs-calendar.html'));
        },
        sleepFn: async () => {},
        onDecision: (entry) => decisions.push(entry),
      }), (error) => expected.test(error.message));
      assert.equal(proxyCalls, 1);
      assert.equal(decisions[0].requestCount, 1);
    });
  }

  it('caps the proxy ladder at the shared NBS deadline', async (t) => {
    t.mock.method(console, 'warn', () => {});
    const exitTimeouts = [];
    let pageRequests = 0;
    await withClock(async (clock) => {
      await assert.rejects(fetchChinaReleaseCalendar({
        now: TEST_NOW,
        sleepFn: async () => {},
        fetchFn: async (url) => {
          if (String(url) === NBS_CALENDAR_INDEX_URL) {
            clock.elapsed += NBS_TOTAL_FETCH_BUDGET_MS - 10_000;
            return new Response(INDEX_ANCHOR);
          }
          pageRequests += 1;
          throw connectionRefused();
        },
        proxyUrl: PARSEABLE_PROXY,
        proxyFetchFn: async (_url, _config, { timeoutMs }) => {
          exitTimeouts.push(timeoutMs);
          clock.elapsed += timeoutMs;
          throw new Error('exit hang');
        },
        onDecision: () => {},
      }), /NBS_REQUIRED_SOURCE_UNAVAILABLE:FETCH_FAILED/);
    });
    assert.ok(exitTimeouts.length >= 1);
    assert.ok(exitTimeouts[0] <= 10_000, `first exit got ${exitTimeouts[0]}ms of a 10s remainder`);
    assert.ok(exitTimeouts.reduce((sum, ms) => sum + ms, 0) <= 10_000);
    assert.equal(pageRequests, 1);
  });

  it('skips the proxy when the direct hop already ran past the deadline', async () => {
    let proxyCalls = 0;
    const decisions = [];
    await withClock(async (clock) => {
      await assert.rejects(fetchChinaReleaseCalendar({
        now: TEST_NOW,
        sleepFn: async () => {},
        fetchFn: async (url) => {
          if (String(url) === NBS_CALENDAR_INDEX_URL) {
            clock.elapsed += NBS_TOTAL_FETCH_BUDGET_MS - 5_000;
            return new Response(INDEX_ANCHOR);
          }
          clock.elapsed += NBS_REQUEST_TIMEOUT_MS;
          throw hangTimeout();
        },
        proxyUrl: PARSEABLE_PROXY,
        proxyFetchFn: async (url) => { proxyCalls += 1; return proxyResult(nbsPage(url)); },
        onDecision: (entry) => decisions.push(entry),
      }), (error) => error.message === `NBS_REQUIRED_SOURCE_UNAVAILABLE:${FETCH_BUDGET_EXHAUSTED_REASON}`);
    });
    assert.equal(proxyCalls, 0);
    assert.equal(decisions[0].reason, FETCH_BUDGET_EXHAUSTED_REASON);
  });
});
