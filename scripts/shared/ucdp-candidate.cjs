'use strict';

// UCDP GED Candidate releases — shared by BOTH UCDP Redis writers.
//
// UCDP publishes two GED products: the ANNUAL release ('${year}.1'), finalized
// once a year and therefore ~7 months stale by the time the next one lands, and
// monthly GED CANDIDATE releases ('${year}.0.${month}') with "not more than a
// month's lag globally" per UCDP's docs. The candidate is merged ON TOP of the
// annual base — it is an addition, never a replacement (a candidate alone is
// ~1.8k events vs the annual's ~418k).
//
// This module exists because scripts/ais-relay.cjs (the primary relay seeder)
// and scripts/seed-ucdp-events.mjs (the Railway backup cron) must not drift:
// the first cut of this feature duplicated the logic and the two copies had
// already diverged on discovery concurrency and probe timeout. CommonJS so the
// CJS relay can require() it and the ESM seeder can import it — the same
// arrangement scripts/seed-market-quotes.mjs uses for
// scripts/shared/notification-dedup.cjs.

// A candidate release is far thinner than the annual, so 3 pages of 1000 covers
// a whole release with room to spare today (26.0.6 = 1795 events / 2 pages).
// The cap is a bound, not an assumption: fetchCandidatePages reports truncation
// so the caller logs it rather than silently dropping the overflow.
const CANDIDATE_MAX_PAGES = 3;

// Discovery probes every candidate concurrently under this timeout. It is
// deliberately much shorter than the per-page fetch budget: discovery is 6
// speculative probes, most of which 4xx for a not-yet-published version, and an
// unbounded probe chain would eat a seeder's entire run budget (the
// relay-backup bundle SIGKILLs the UCDP section at 300s).
const CANDIDATE_DISCOVER_TIMEOUT_MS = 15_000;

// Reserve this many slots of the capped payload for the ANNUAL base.
//
// Every candidate event is newer than every annual event, so an unreserved
// sort-newest-first-then-slice hands the candidate the entire payload as soon as
// the candidate release grows past the cap. That is not hypothetical: the
// candidate was 1795 of a 2000-event payload when this was written and grows
// ~100/month, so the annual base would have been fully evicted within months.
// get-risk-scores.ts derives each Tier-1 country's war/minor floor from this
// payload over a 2-year window, so a candidate-only payload silently drops that
// floor for every country the thin candidate does not cover.
const CANDIDATE_ANNUAL_FLOOR = 500;

// Content-age budget published into seed-meta so /api/health can tell "the
// candidate merge is working" from "the candidate merge silently died and we are
// back to annual-only data". Annual-only content runs ~7 months (~300k min)
// behind; a healthy merge keeps the newest event ~1 month old. 90 days sits well
// clear of both, absorbing UCDP publish jitter without swallowing a regression.
const UCDP_MAX_CONTENT_AGE_MIN = 129_600; // 90 days

function hasResults(page) {
  return Array.isArray(page?.Result) && page.Result.length > 0;
}

// Newest-first, bounded window around the current month (current +1 through -4).
// Discovering rather than hardcoding means a not-yet-published candidate is just
// a skipped probe and next month's release is picked up automatically. `now` is
// injectable so month/year rollover is testable without freezing the clock.
function buildCandidateVersions(now = new Date()) {
  const year = now.getFullYear() - 2000;
  const month = now.getMonth() + 1; // 1-12
  const out = [];
  for (let offset = 1; offset >= -4; offset--) {
    const m = month + offset;
    if (m >= 1 && m <= 12) out.push(`${year}.0.${m}`);
    else if (m < 1) out.push(`${year - 1}.0.${m + 12}`);
    // m > 12 rolls forward into next year. Without this branch the entry was
    // dropped entirely, silently narrowing the window to 5 every December.
    else out.push(`${year + 1}.0.${m - 12}`);
  }
  return out;
}

// Probe every candidate concurrently and take the newest that returned events.
// buildCandidateVersions is newest-first, so the first FULFILLED probe is by
// construction the newest available release — no version comparator needed.
//
// Returns null rather than throwing when nothing is published yet: the candidate
// is an addition on top of the annual base, so its absence is not an error.
async function discoverCandidateVersion(fetchPage, candidates = buildCandidateVersions()) {
  const settled = await Promise.allSettled(candidates.map(async (version) => {
    const first = await fetchPage(version, 0, CANDIDATE_DISCOVER_TIMEOUT_MS);
    if (!hasResults(first)) throw new Error(`${version}: no results`);
    return { version, first };
  }));
  for (const outcome of settled) {
    if (outcome.status === 'fulfilled') return outcome.value;
  }
  return null;
}

// Fetch the remainder of the candidate release, isolating per-page failures the
// same way the annual page fetch does (one bad page must not truncate the rest).
//
// Returns the events plus the two facts a caller needs so it never publishes a
// partial release labelled as a complete one:
//   complete  — every page the cap allows was fetched successfully
//   truncated — the release has MORE pages than the cap allows
async function fetchCandidatePages(fetchPage, candidate) {
  const totalPages = Math.max(1, Number(candidate?.first?.TotalPages) || 1);
  const wanted = Math.min(totalPages, CANDIDATE_MAX_PAGES);
  const FAILED = Symbol('failed');
  const rest = await Promise.all(
    Array.from({ length: Math.max(0, wanted - 1) }, (_unused, i) => (
      fetchPage(candidate.version, i + 1).catch(() => FAILED)
    )),
  );
  const events = Array.isArray(candidate?.first?.Result) ? [...candidate.first.Result] : [];
  let failedPages = 0;
  for (const page of rest) {
    if (page === FAILED) { failedPages++; continue; }
    if (Array.isArray(page?.Result)) events.push(...page.Result);
  }
  return {
    events,
    failedPages,
    complete: failedPages === 0,
    truncated: totalPages > CANDIDATE_MAX_PAGES,
    totalPages,
  };
}

// Cap the payload newest-first while guaranteeing the annual base keeps
// CANDIDATE_ANNUAL_FLOOR slots — see the constant above for why. When the annual
// base cannot fill its reservation the unused slots go back to the candidate, so
// this never publishes a SHORTER payload than the plain slice would have.
function capWithAnnualFloor(sortedNewestFirst, isCandidate, maxEvents, annualFloor = CANDIDATE_ANNUAL_FLOOR) {
  if (sortedNewestFirst.length <= maxEvents) return sortedNewestFirst;
  const candidateEvents = [];
  const annualEvents = [];
  for (const event of sortedNewestFirst) {
    (isCandidate(event) ? candidateEvents : annualEvents).push(event);
  }
  const annualReserved = Math.min(annualEvents.length, annualFloor);
  const candidateKeep = Math.min(candidateEvents.length, maxEvents - annualReserved);
  const picked = [
    ...candidateEvents.slice(0, candidateKeep),
    ...annualEvents.slice(0, maxEvents - candidateKeep),
  ];
  return picked.sort((a, b) => b.dateStart - a.dateStart);
}

// Content-age trio for seed-meta (api/health.js reads maxContentAgeMin's
// presence as the opt-in signal and reports STALE_CONTENT when the newest event
// is older than the budget).
function candidateContentMeta(cappedNewestFirst) {
  const newest = cappedNewestFirst.length > 0 ? cappedNewestFirst[0].dateStart : null;
  const oldest = cappedNewestFirst.length > 0 ? cappedNewestFirst[cappedNewestFirst.length - 1].dateStart : null;
  return {
    newestItemAt: Number.isFinite(newest) && newest > 0 ? newest : null,
    oldestItemAt: Number.isFinite(oldest) && oldest > 0 ? oldest : null,
    maxContentAgeMin: UCDP_MAX_CONTENT_AGE_MIN,
  };
}

module.exports = {
  CANDIDATE_MAX_PAGES,
  CANDIDATE_DISCOVER_TIMEOUT_MS,
  CANDIDATE_ANNUAL_FLOOR,
  UCDP_MAX_CONTENT_AGE_MIN,
  buildCandidateVersions,
  discoverCandidateVersion,
  fetchCandidatePages,
  capWithAnnualFloor,
  candidateContentMeta,
};
