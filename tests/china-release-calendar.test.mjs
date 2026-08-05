import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  NBS_CALENDAR_INDEX_URL,
  NBS_REQUEST_TIMEOUT_MS,
  NBS_TOTAL_FETCH_BUDGET_MS,
  NBS_TRANSIENT_FETCH_ATTEMPTS,
  NBS_TRANSIENT_RETRY_DELAY_MS,
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

  it('bounds the worst-case NBS fetch phase well inside the seeder lock', () => {
    // Asserted against literals on purpose: every other retry test compares
    // against the imported constants, so raising one would move those
    // assertions with it and silently widen the budget. Pinning the numbers
    // here is what makes this test constrain the budget rather than restate it.
    assert.equal(NBS_TRANSIENT_FETCH_ATTEMPTS, 3);
    assert.equal(NBS_REQUEST_TIMEOUT_MS, 20_000);
    assert.equal(NBS_TRANSIENT_RETRY_DELAY_MS, 500);
    assert.equal(NBS_TOTAL_FETCH_BUDGET_MS, 75_000);

    // seed-china-release-calendar.mjs holds a 180s lock inside a 240s bundle
    // section. The wall-clock budget spans both NBS URLs, and the deadline is
    // checked BEFORE sleeping, so the worst case is the budget plus one
    // already-in-flight request, then the single ChinaMoney call.
    const SEEDER_LOCK_TTL_MS = 180_000;
    const BUNDLE_SECTION_TIMEOUT_MS = 240_000;
    const CHINAMONEY_TIMEOUT_MS = 20_000;
    const worstCaseFetchMs = NBS_TOTAL_FETCH_BUDGET_MS + NBS_REQUEST_TIMEOUT_MS + CHINAMONEY_TIMEOUT_MS;

    assert.equal(worstCaseFetchMs, 115_000);
    // Leave the publish phase at least a third of the lock: atomicPublish makes
    // several retried Redis round trips after the fetch returns.
    assert.ok(
      worstCaseFetchMs <= SEEDER_LOCK_TTL_MS * (2 / 3),
      `worst-case fetch ${worstCaseFetchMs}ms leaves too little of the ${SEEDER_LOCK_TTL_MS}ms lock for publish`,
    );
    assert.ok(worstCaseFetchMs < BUNDLE_SECTION_TIMEOUT_MS / 2);
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
        (error) => /NBS_REQUIRED_SOURCE_UNAVAILABLE:FETCH_FAILED/.test(error.message),
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
    const realNow = Date.now;
    let elapsed = 0;
    Date.now = () => realNow() + elapsed;
    try {
      await assert.rejects(
        fetchChinaReleaseCalendar({
          now: Date.parse('2026-07-13T00:00:00Z'),
          fetchFn: async (url) => {
            requests.push(String(url));
            elapsed += NBS_TOTAL_FETCH_BUDGET_MS; // first attempt burns the budget
            throw new TypeError('fetch failed');
          },
          onDecision: () => {},
        }),
        (error) => /NBS_REQUIRED_SOURCE_UNAVAILABLE:FETCH_FAILED/.test(error.message),
      );
    } finally {
      Date.now = realNow;
    }
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
  for (const [shape, makeError] of [
    ['cause.code', () => codeError('SELF_SIGNED_CERT_IN_CHAIN')],
    ['top-level code', () => Object.assign(new Error('fetch failed'), { code: 'SELF_SIGNED_CERT_IN_CHAIN' })],
    // An expired or misissued cert is just as permanent as a self-signed one:
    // the peer is not provably who it claims to be, so a retry only repeats the
    // request against that same untrusted peer.
    ['expired cert', () => codeError('CERT_HAS_EXPIRED')],
    ['hostname mismatch', () => codeError('ERR_TLS_CERT_ALTNAME_INVALID')],
    ['unverifiable leaf', () => codeError('UNABLE_TO_VERIFY_LEAF_SIGNATURE')],
    ['message backstop, no code', () => new TypeError('self signed certificate in certificate chain')],
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
