import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  CANDIDATE_MAX_PAGES,
  CANDIDATE_DISCOVER_TIMEOUT_MS,
  CANDIDATE_ANNUAL_FLOOR,
  UCDP_MAX_CONTENT_AGE_MIN,
  buildCandidateVersions,
  discoverCandidateVersion,
  fetchCandidatePages,
  capWithAnnualFloor,
  candidateContentMeta,
} = require('../scripts/shared/ucdp-candidate.cjs');

const MAX_EVENTS = 2000;

// UTC noon avoids any local-timezone shift flipping the month under the test.
const at = (year, month) => new Date(Date.UTC(year, month - 1, 15, 12));

describe('buildCandidateVersions window', () => {
  it('always yields a full 6-wide window, including December', () => {
    for (let month = 1; month <= 12; month++) {
      const versions = buildCandidateVersions(at(2026, month));
      assert.equal(versions.length, 6, `month ${month} must probe 6 candidates, got ${versions.join(', ')}`);
    }
  });

  it('rolls FORWARD into next year in December (the +1 look-ahead used to vanish)', () => {
    // December: offset +1 gives m=13. Without an m > 12 branch the entry was
    // silently dropped, narrowing the window to 5 and never probing next year.
    assert.deepEqual(buildCandidateVersions(at(2026, 12)), [
      '27.0.1', '26.0.12', '26.0.11', '26.0.10', '26.0.9', '26.0.8',
    ]);
  });

  it('rolls BACKWARD into last year in January', () => {
    assert.deepEqual(buildCandidateVersions(at(2027, 1)), [
      '27.0.2', '27.0.1', '26.0.12', '26.0.11', '26.0.10', '26.0.9',
    ]);
  });

  it('is strictly newest-first, which is what makes first-fulfilled-wins correct', () => {
    for (const month of [1, 6, 11, 12]) {
      const versions = buildCandidateVersions(at(2026, month));
      const rank = (v) => v.split('.').map(Number).reduce((acc, n) => acc * 100 + n, 0);
      for (let i = 1; i < versions.length; i++) {
        assert.ok(
          rank(versions[i - 1]) > rank(versions[i]),
          `month ${month}: ${versions[i - 1]} must sort newer than ${versions[i]}`,
        );
      }
    }
  });

  it('defaults to the real clock when no date is injected', () => {
    assert.equal(buildCandidateVersions().length, 6);
  });
});

describe('discoverCandidateVersion', () => {
  const page = (n) => ({ Result: Array.from({ length: n }, (_u, i) => ({ id: i })), TotalPages: 1 });

  it('returns null instead of throwing when no candidate is published', async () => {
    const result = await discoverCandidateVersion(async () => { throw new Error('400'); }, ['26.0.9', '26.0.8']);
    assert.equal(result, null);
  });

  it('returns null when every probe responds with an empty Result', async () => {
    const result = await discoverCandidateVersion(async () => ({ Result: [], TotalPages: 1 }), ['26.0.9']);
    assert.equal(result, null);
  });

  it('picks the NEWEST candidate that returned events, not the first to answer', async () => {
    // Newest (26.0.9) answers slowest — a first-responder race would pick 26.0.7.
    const result = await discoverCandidateVersion(async (version) => {
      if (version === '26.0.9') { await new Promise((r) => setTimeout(r, 40)); return page(3); }
      if (version === '26.0.8') throw new Error('404');
      return page(5);
    }, ['26.0.9', '26.0.8', '26.0.7']);
    assert.equal(result.version, '26.0.9');
  });

  it('skips unpublished newer releases and falls back to the newest live one', async () => {
    const result = await discoverCandidateVersion(async (version) => {
      if (version === '26.0.9' || version === '26.0.8') throw new Error('400 Bad Request');
      return page(4);
    }, ['26.0.9', '26.0.8', '26.0.7', '26.0.6']);
    assert.equal(result.version, '26.0.7');
  });

  it('probes concurrently under the short discovery timeout, not the page budget', async () => {
    const seen = [];
    let concurrent = 0;
    let peak = 0;
    await discoverCandidateVersion(async (_version, _pageNum, timeoutMs) => {
      seen.push(timeoutMs);
      concurrent++; peak = Math.max(peak, concurrent);
      await new Promise((r) => setTimeout(r, 10));
      concurrent--;
      throw new Error('404');
    }, ['26.0.9', '26.0.8', '26.0.7']);
    assert.ok(peak > 1, 'candidate probes must run concurrently, not sequentially');
    assert.deepEqual(new Set(seen), new Set([CANDIDATE_DISCOVER_TIMEOUT_MS]));
    assert.ok(CANDIDATE_DISCOVER_TIMEOUT_MS <= 30_000, 'discovery timeout must stay well inside a seeder run budget');
  });
});

describe('fetchCandidatePages', () => {
  const ev = (id) => ({ id, date_start: '2026-06-01' });
  const candidate = (totalPages) => ({ version: '26.0.6', first: { Result: [ev('a')], TotalPages: totalPages } });

  it('reports complete when every page within the cap succeeds', async () => {
    const merged = await fetchCandidatePages(async () => ({ Result: [ev('b')] }), candidate(2));
    assert.equal(merged.complete, true);
    assert.equal(merged.truncated, false);
    assert.equal(merged.events.length, 2);
  });

  it('reports INCOMPLETE (not silently partial) when a page fails', async () => {
    const merged = await fetchCandidatePages(async () => { throw new Error('boom'); }, candidate(3));
    assert.equal(merged.complete, false);
    assert.equal(merged.failedPages, 2);
    assert.equal(merged.events.length, 1, 'page 0 still contributes');
  });

  it('does not let one failed page truncate the remaining pages', async () => {
    const merged = await fetchCandidatePages(async (_v, page) => {
      if (page === 1) throw new Error('transient');
      return { Result: [ev(`p${page}`)] };
    }, candidate(3));
    assert.equal(merged.failedPages, 1);
    // page 2 must still have been fetched despite page 1 failing.
    assert.deepEqual(merged.events.map((e) => e.id), ['a', 'p2']);
  });

  it('reports truncated when the release has more pages than the cap', async () => {
    const merged = await fetchCandidatePages(async () => ({ Result: [ev('x')] }), candidate(CANDIDATE_MAX_PAGES + 4));
    assert.equal(merged.truncated, true);
    assert.equal(merged.totalPages, CANDIDATE_MAX_PAGES + 4);
    assert.equal(merged.events.length, CANDIDATE_MAX_PAGES, 'never fetches beyond the cap');
  });

  it('handles a single-page release without extra requests', async () => {
    let calls = 0;
    const merged = await fetchCandidatePages(async () => { calls++; return { Result: [] }; }, candidate(1));
    assert.equal(calls, 0);
    assert.equal(merged.complete, true);
    assert.equal(merged.truncated, false);
  });
});

describe('capWithAnnualFloor', () => {
  // Candidate events are always newer than annual ones, so an unreserved
  // sort+slice hands the candidate the whole payload once it outgrows the cap.
  const build = (candidateCount, annualCount) => {
    const out = [];
    for (let i = 0; i < candidateCount; i++) out.push({ id: `c${i}`, dateStart: 2_000_000 - i });
    for (let i = 0; i < annualCount; i++) out.push({ id: `a${i}`, dateStart: 1_000_000 - i });
    return out;
  };
  const isCandidate = (e) => e.id.startsWith('c');
  const countCandidates = (list) => list.filter(isCandidate).length;

  it('is a no-op when the payload already fits under the cap', () => {
    const events = build(100, 100);
    assert.deepEqual(capWithAnnualFloor(events, isCandidate, MAX_EVENTS), events);
  });

  it('reserves the annual floor once the candidate alone exceeds the cap', () => {
    // The regression: 2500 candidate events would otherwise evict the annual
    // base entirely from a 2000-event payload.
    const capped = capWithAnnualFloor(build(2500, 3000), isCandidate, MAX_EVENTS);
    assert.equal(capped.length, MAX_EVENTS);
    assert.equal(countCandidates(capped), MAX_EVENTS - CANDIDATE_ANNUAL_FLOOR);
    assert.equal(capped.length - countCandidates(capped), CANDIDATE_ANNUAL_FLOOR);
  });

  it('keeps the annual base represented at the measured live mix', () => {
    // 1795 candidate / 2000 cap was the live mix when this was written; the
    // plain slice left only 205 annual events and trended to zero.
    const capped = capWithAnnualFloor(build(1795, 3000), isCandidate, MAX_EVENTS);
    assert.equal(capped.length, MAX_EVENTS);
    assert.equal(capped.length - countCandidates(capped), CANDIDATE_ANNUAL_FLOOR);
  });

  it('gives unused annual slots back to the candidate rather than shipping a short payload', () => {
    const capped = capWithAnnualFloor(build(2500, 100), isCandidate, MAX_EVENTS);
    assert.equal(capped.length, MAX_EVENTS, 'must not publish fewer events than the plain slice would');
    assert.equal(capped.length - countCandidates(capped), 100, 'all available annual events kept');
  });

  it('degrades to a plain newest-first cap when there is no candidate at all', () => {
    const capped = capWithAnnualFloor(build(0, 5000), isCandidate, MAX_EVENTS);
    assert.equal(capped.length, MAX_EVENTS);
    assert.equal(countCandidates(capped), 0);
  });

  it('returns events sorted newest-first', () => {
    const capped = capWithAnnualFloor(build(2500, 3000), isCandidate, MAX_EVENTS);
    for (let i = 1; i < capped.length; i++) {
      assert.ok(capped[i - 1].dateStart >= capped[i].dateStart, 'payload must stay newest-first');
    }
  });
});

describe('candidateContentMeta', () => {
  it('emits the content-age trio health reads as its STALE_CONTENT opt-in', () => {
    const meta = candidateContentMeta([{ dateStart: 3000 }, { dateStart: 1000 }]);
    assert.deepEqual(meta, { newestItemAt: 3000, oldestItemAt: 1000, maxContentAgeMin: UCDP_MAX_CONTENT_AGE_MIN });
    assert.ok(Number.isInteger(meta.maxContentAgeMin), 'health opts in on an INTEGER maxContentAgeMin');
  });

  it('reports null newestItemAt for an empty payload so health reads it as stale', () => {
    assert.deepEqual(candidateContentMeta([]), {
      newestItemAt: null, oldestItemAt: null, maxContentAgeMin: UCDP_MAX_CONTENT_AGE_MIN,
    });
  });

  it('budget is wide enough for a healthy merge but catches annual-only fallback', () => {
    const DAY_MIN = 24 * 60;
    // A working merge keeps the newest event ~1 month old; annual-only is ~7 months.
    assert.ok(UCDP_MAX_CONTENT_AGE_MIN > 45 * DAY_MIN, 'must not alarm on normal candidate publish lag');
    assert.ok(UCDP_MAX_CONTENT_AGE_MIN < 200 * DAY_MIN, 'must alarm before annual-only staleness looks normal');
  });
});

describe('both UCDP writers share the candidate implementation', () => {
  const relay = readFileSync('scripts/ais-relay.cjs', 'utf8');
  const cron = readFileSync('scripts/seed-ucdp-events.mjs', 'utf8');

  it('neither writer re-implements the candidate window locally', () => {
    for (const [name, src] of [['ais-relay.cjs', relay], ['seed-ucdp-events.mjs', cron]]) {
      assert.doesNotMatch(
        src,
        /for \(let offset = 1; offset >= -4; offset--\)/,
        `${name} must use the shared buildCandidateVersions, not a local copy`,
      );
    }
  });

  it('both writers load the shared module', () => {
    assert.match(relay, /require\('\.\/shared\/ucdp-candidate\.cjs'\)/);
    assert.match(cron, /from '\.\/shared\/ucdp-candidate\.cjs'/);
  });

  it('the cron preserves last-good data BEFORE merging a candidate', () => {
    // Without a pre-merge guard a healthy candidate refills the payload and the
    // final empty-check can no longer see that the annual base is missing.
    const guard = cron.indexOf('allEvents.length === 0 && failedPages > 0');
    const merge = cron.indexOf('await discoverCandidateVersion(');
    assert.notEqual(guard, -1, 'cron must guard total annual-fetch failure');
    assert.ok(guard < merge, 'the preservation guard must run BEFORE the candidate merge');
  });

  it('both writers reserve annual slots instead of a plain slice', () => {
    assert.match(relay, /ucdpCapWithAnnualFloor\(/);
    assert.match(cron, /capWithAnnualFloor\(/);
    assert.doesNotMatch(cron, /mapped\.slice\(0, MAX_EVENTS\)/, 'plain slice evicts the annual base');
  });

  it('both writers publish the content-age trio into seed-meta', () => {
    assert.match(relay, /ucdpCandidateContentMeta\(capped\)/);
    assert.match(cron, /candidateContentMeta\(capped\)/);
  });

  it('neither writer labels a partial candidate as a complete release', () => {
    for (const [name, src] of [['ais-relay.cjs', relay], ['seed-ucdp-events.mjs', cron]]) {
      assert.match(src, /\+partial/, `${name} must mark an incomplete candidate fetch`);
    }
  });
});
