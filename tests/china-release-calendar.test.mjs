import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  NBS_CALENDAR_INDEX_URL,
  NBS_TRANSIENT_FETCH_ATTEMPTS,
  buildLprCandidates,
  fetchChinaReleaseCalendar,
  mergeVerifiedLprDates,
  parseChinaMoneyLprNotices,
  parseNbsReleaseCalendar,
} from '../scripts/china-macro/calendar.mjs';

const fixture = (name) => readFileSync(resolve(import.meta.dirname, 'fixtures/china-macro', name), 'utf8');

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

  it('pins the NBS transient retry budget so the fetch phase stays inside the seeder lock', () => {
    // Asserted as a literal on purpose: every other retry test compares against
    // the imported constant, so raising it would move those assertions with it
    // and silently widen the budget. seed-china-release-calendar.mjs holds a
    // 180s lock inside a 240s bundle section, and each attempt carries its own
    // 20s AbortSignal timeout across two independently-retried NBS URLs
    // (2 x (3 x 20s + 1.5s backoff) + 20s ChinaMoney = ~143s). Raising this
    // past 3 blows the lock — raise lockTtlMs first.
    assert.equal(NBS_TRANSIENT_FETCH_ATTEMPTS, 3);
  });

  // Node surfaces a bad chain either as a bare error carrying `code` or wrapped
  // in a TypeError whose `cause` carries it; both must fail closed.
  for (const [shape, makeError] of [
    ['cause.code', () => Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('unable to verify the first certificate'), { code: 'SELF_SIGNED_CERT_IN_CHAIN' }),
    })],
    ['top-level code', () => Object.assign(new Error('fetch failed'), { code: 'SELF_SIGNED_CERT_IN_CHAIN' })],
    ['message only', () => new TypeError('self signed certificate in certificate chain')],
  ]) {
    it(`fails closed on a certificate-chain error (${shape}) instead of retrying an intercepted connection`, async () => {
      const requests = [];
      const decisions = [];
      await assert.rejects(
        fetchChinaReleaseCalendar({
          now: Date.parse('2026-07-13T00:00:00Z'),
          fetchFn: async (url) => {
            requests.push(String(url));
            throw makeError();
          },
          onDecision: (decision) => decisions.push(decision),
        }),
        (error) => /NBS_REQUIRED_SOURCE_UNAVAILABLE:FETCH_FAILED/.test(error.message),
      );
      // A bad chain means interception, not a hiccup — one attempt, then stop.
      assert.deepEqual(requests, [NBS_CALENDAR_INDEX_URL]);
      assert.equal(decisions[0]?.requestCount, 1);
    });
  }

  it('still fails closed once the transient NBS retry budget is exhausted', async () => {
    const requests = [];
    const decisions = [];
    let rejectedError;
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
