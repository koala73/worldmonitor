import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  NBS_CALENDAR_INDEX_URL,
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
