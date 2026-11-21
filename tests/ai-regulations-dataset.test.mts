import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';

import {
  AI_REGULATIONS,
  REGULATORY_ACTIONS,
  COUNTRY_REGULATION_PROFILES,
  getUpcomingDeadlines,
  getRecentActions,
} from '../src/config/ai-regulations.ts';

// Executive Order 14148, Sec. 2 (90 FR 8237, FR Doc. 2025-01901): "The following
// executive actions are hereby revoked: ... (ggg) Executive Order 14110".
describe('AI regulations dataset: EO 14110', () => {
  const eo = AI_REGULATIONS.find((r) => r.id === 'us-eo-14110');

  it('is not listed as active after its revocation', () => {
    assert.ok(eo, 'us-eo-14110 entry exists');
    assert.equal(eo.status, 'revoked');
  });

  it('has a revocation action dated 2025-01-20 sourced to the Federal Register', () => {
    const revocation = REGULATORY_ACTIONS.find(
      (a) => a.regulationId === 'us-eo-14110' && a.date === '2025-01-20',
    );
    assert.ok(revocation, 'a 2025-01-20 action for us-eo-14110 exists');
    assert.equal(revocation.type, 'executive-order');
    assert.equal(revocation.source, 'Federal Register');
  });

  it('is not counted among the United States active regulations', () => {
    const us = COUNTRY_REGULATION_PROFILES.find((p) => p.countryCode === 'US');
    assert.ok(us);
    assert.ok(!us.activeRegulations.includes('us-eo-14110'));
  });

  it('every country profile lists only regulations whose status matches the bucket', () => {
    const byId = new Map(AI_REGULATIONS.map((r) => [r.id, r]));
    for (const profile of COUNTRY_REGULATION_PROFILES) {
      for (const id of profile.activeRegulations) {
        assert.equal(byId.get(id)?.status, 'active', `${profile.countryCode} active: ${id}`);
      }
      for (const id of profile.proposedRegulations) {
        assert.equal(byId.get(id)?.status, 'proposed', `${profile.countryCode} proposed: ${id}`);
      }
    }
  });
});

const TODAY = '2026-11-02';
const AI_ACT = 'https://eur-lex.europa.eu/eli/reg/2024/1689/oj/eng';
const DIGITAL_OMNIBUS_ON_AI = 'https://eur-lex.europa.eu/eli/reg/2026/1744/oj/eng';

function withClock<T>(iso: string, run: () => T): T {
  mock.timers.enable({ apis: ['Date'], now: new Date(iso) });
  try {
    return run();
  } finally {
    mock.timers.reset();
  }
}

// Article 113 of Regulation (EU) 2024/1689, as amended by Article 1(40) of
// Regulation (EU) 2026/1744 (OJ L, 24.7.2026). The amendment replaced the
// 2 August 2026 / 2 August 2027 high-risk dates with 2 December 2027 (Annex III)
// and 2 August 2028 (Annex I), and added 2 December 2026 for the new Article 5
// prohibitions and for Article 50(2) marking by systems already on the market.
describe('AI regulations dataset: EU AI Act staged application', () => {
  const act = AI_REGULATIONS.find((r) => r.id === 'eu-ai-act');
  const deadlines = act?.deadlines ?? [];
  const on = (date: string) => deadlines.filter((d) => d.date === date);

  it('lists every application date in the amended Article 113 and Article 111', () => {
    assert.deepEqual(
      [...new Set(deadlines.map((d) => d.date))].sort(),
      ['2025-02-02', '2025-08-02', '2026-08-02', '2026-12-02', '2027-08-02', '2027-12-02', '2028-08-02'],
    );
  });

  it('cites the Digital Omnibus on AI for the postponed high-risk dates', () => {
    for (const date of ['2026-12-02', '2027-12-02', '2028-08-02']) {
      assert.ok(on(date).length > 0, `${date} listed`);
      for (const d of on(date)) assert.equal(d.source, DIGITAL_OMNIBUS_ON_AI, `${date} ${d.label}`);
    }
    assert.match(on('2027-12-02')[0]!.label, /Annex III/);
    assert.match(on('2028-08-02')[0]!.label, /Annex I\b/);
  });

  it('no longer lists high-risk obligations on the dates the amendment replaced', () => {
    for (const date of ['2026-08-02', '2027-08-02']) {
      for (const d of on(date)) assert.doesNotMatch(d.label, /high-risk/i, `${date} ${d.label}`);
    }
  });

  it('cites only adopted acts in the Official Journal, never a proposal', () => {
    for (const d of deadlines) assert.ok([AI_ACT, DIGITAL_OMNIBUS_ON_AI].includes(d.source), `${d.date} ${d.source}`);
  });

  it('records the publication of the Digital Omnibus on AI', () => {
    const action = REGULATORY_ACTIONS.find((a) => a.date === '2026-07-24' && a.regulationId === 'eu-ai-act');
    assert.ok(action, 'a 2026-07-24 action for eu-ai-act exists');
    assert.equal(action.sourceUrl, DIGITAL_OMNIBUS_ON_AI);
  });
});

describe('AI regulations dataset: dates against the clock', () => {
  it('lists upcoming deadlines on today, none of them passed, soonest first', () => {
    const upcoming = withClock(`${TODAY}T12:00:00Z`, () => getUpcomingDeadlines());
    assert.ok(upcoming.length > 0, 'at least one deadline in the next 12 months');
    const dates = upcoming.map((u) => u.deadline.date);
    for (const date of dates) assert.ok(date >= TODAY, `${date} is not passed`);
    assert.deepEqual(dates, [...dates].sort());
    assert.equal(dates[0], '2026-12-02');
  });

  it('has regulatory actions within the last 12 months', () => {
    const recent = withClock(`${TODAY}T12:00:00Z`, () => getRecentActions(12));
    assert.ok(recent.length > 0);
  });

  it('records no action after today', () => {
    for (const a of REGULATORY_ACTIONS) assert.ok(a.date <= TODAY, `${a.id} ${a.date}`);
  });

  it('dates each country profile no earlier than its newest recorded action', () => {
    for (const profile of COUNTRY_REGULATION_PROFILES) {
      const newest = REGULATORY_ACTIONS
        .filter((a) => a.country === profile.country)
        .map((a) => a.date)
        .sort()
        .at(-1);
      if (newest) assert.ok(profile.lastUpdated >= newest, `${profile.countryCode} ${profile.lastUpdated} < ${newest}`);
    }
  });

  it('dates no country profile before 2025', () => {
    for (const profile of COUNTRY_REGULATION_PROFILES) {
      assert.ok(profile.lastUpdated >= '2025-01-01', `${profile.countryCode} ${profile.lastUpdated}`);
    }
  });
});

describe('AI regulations dataset: sources', () => {
  const https = (url: string | undefined) => typeof url === 'string' && url.startsWith('https://');

  // No primary source was found for this entry's name or date. It keeps its
  // place until one is, and must not gain a guessed link meanwhile.
  const UNSOURCED = new Set(['kr-ai-framework']);

  it('links every regulation to an https source', () => {
    for (const r of AI_REGULATIONS) {
      if (UNSOURCED.has(r.id)) assert.equal(r.link, undefined, r.id);
      else assert.ok(https(r.link), `${r.id} ${r.link}`);
    }
  });

  it('gives every action an https source', () => {
    for (const a of REGULATORY_ACTIONS) assert.ok(https(a.sourceUrl), `${a.id} ${a.sourceUrl}`);
  });

  it('gives every deadline an https source', () => {
    for (const r of AI_REGULATIONS) {
      for (const d of r.deadlines ?? []) assert.ok(https(d.source), `${r.id} ${d.date} ${d.source}`);
    }
  });
});

// Bill C-27, which contained AIDA, was still in committee when the 44th
// Parliament's first session ended on 6 January 2025 and was not reinstated
// (LEGISinfo: https://www.parl.ca/legisinfo/en/bill/44-1/c-27).
describe('AI regulations dataset: Canada AIDA', () => {
  it('is lapsed, not proposed', () => {
    assert.equal(AI_REGULATIONS.find((r) => r.id === 'ca-aida')?.status, 'lapsed');
    const ca = COUNTRY_REGULATION_PROFILES.find((p) => p.countryCode === 'CA');
    assert.ok(ca && !ca.proposedRegulations.includes('ca-aida'));
  });
});
