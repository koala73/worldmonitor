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

// Keep annual history for conflict floors in countries absent from the candidate.
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

// Preserve candidate releases as a whole because period-start rows can contain
// monthly death aggregates. The annual floor must not displace those rows.
function capWithAnnualFloor(sortedNewestFirst, isCandidate, maxEvents, annualFloor = CANDIDATE_ANNUAL_FLOOR) {
  if (sortedNewestFirst.length <= maxEvents) return sortedNewestFirst;
  const candidateEvents = [];
  const annualEvents = [];
  for (const event of sortedNewestFirst) {
    (isCandidate(event) ? candidateEvents : annualEvents).push(event);
  }
  const annualReserved = Math.min(annualEvents.length, annualFloor);
  const capacity = Math.max(maxEvents, candidateEvents.length + annualReserved);
  const picked = [
    ...candidateEvents,
    ...annualEvents.slice(0, capacity - candidateEvents.length),
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

// ---------------------------------------------------------------------------
// The trailing window (CII v15, Stage B6)
//
// Each GED Candidate release holds ONE month: 26.0.9 is September 2026 (plus a
// few late revisions of earlier months), 26.0.8 is August, and so on. Until
// 2026-10 both writers merged only the newest release on top of the newest six
// pages of the annual release, whose pages are not in date order. The cache
// therefore held the newest month and a scatter of annual rows: on 2026-10-23,
// 79% of its rows were from September 2026 and January-August 2026 were missing,
// while the CII read it as a trailing year. The writers now fetch the window:
//  - the annual release by date (the API's StartDate/EndDate filters) from
//    ANNUAL_LOOKBACK_MS before now to the end of the year it covers, every page;
//  - every monthly candidate release after that year, up to the newest.
// Rows are deduplicated by event id, later releases winning.
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;
// The window is anchored at the newest event, which lags now by up to the
// content-age budget (90 days); the lookback covers a year plus that lag.
const ANNUAL_LOOKBACK_MS = (365 + 120) * DAY_MS;
// About 26,000 annual events a year (2025: 25,770): a 16-month slice is under 40 pages.
const ANNUAL_WINDOW_MAX_PAGES = 50;
const WINDOW_FETCH_CONCURRENCY = 4;
// A first month with less than this much of itself inside the window can be
// legitimately empty; any other empty month followed by data is a gap.
const WINDOW_MIN_MONTH_OVERLAP_DAYS = 7;
// UCDP GED records about 1,800 events a month worldwide; a month at under a
// quarter of the median month is a missing release, not a quiet month. The
// CII's read-time check uses the same share (CII_UCDP_MIN_MONTH_SHARE).
const WINDOW_MIN_MONTH_SHARE = 0.25;

/** Last instant of the year an annual release ('26.1' covers 1989-2025) covers; NaN when unparseable. */
function annualReleaseEndMs(version) {
  const major = Number(String(version).split('.')[0]);
  return Number.isInteger(major) && major > 0 ? Date.UTC(2000 + major, 0, 1) - 1 : NaN;
}

/** { year, month } of a monthly candidate release ('26.0.9' -> 2026, 9), else null. */
function parseCandidateVersion(version) {
  const m = /^(\d{2})\.0\.(\d{1,2})$/.exec(String(version));
  if (!m) return null;
  const month = Number(m[2]);
  return month >= 1 && month <= 12 ? { year: 2000 + Number(m[1]), month } : null;
}

/** Monthly candidate versions from the month containing fromMs through newestVersion, oldest first. */
function candidateVersionsSince(fromMs, newestVersion) {
  const newest = parseCandidateVersion(newestVersion);
  if (!newest || !Number.isFinite(fromMs)) return newest ? [newestVersion] : [];
  const from = new Date(fromMs);
  const out = [];
  let year = from.getUTCFullYear();
  let month = from.getUTCMonth() + 1;
  while (year < newest.year || (year === newest.year && month <= newest.month)) {
    out.push(`${year - 2000}.0.${month}`);
    month += 1;
    if (month > 12) { month = 1; year += 1; }
  }
  return out.length ? out : [newestVersion];
}

/** The monthly candidate release for the month containing nowMs ('26.0.10' in October 2026). */
function currentCandidateVersion(nowMs = Date.now()) {
  const d = new Date(nowMs);
  return `${d.getUTCFullYear() - 2000}.0.${d.getUTCMonth() + 1}`;
}

function isoDate(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * The annual release's part of the window, by date. `fetchPage(version, page,
 * timeoutMs, query)` passes `query` as URL parameters. A first page that fails
 * counts as every page failed, so the caller's preserve-last-good guard sees it.
 */
async function fetchAnnualWindow(fetchPage, version, { nowMs = Date.now() } = {}) {
  const endMs = annualReleaseEndMs(version);
  const startMs = nowMs - ANNUAL_LOOKBACK_MS;
  if (!Number.isFinite(endMs) || startMs > endMs) {
    return { events: [], failedPages: 0, totalPages: 0, truncated: false, startDate: isoDate(startMs), endDate: null };
  }
  const query = { StartDate: isoDate(startMs), EndDate: isoDate(endMs) };
  let first;
  try {
    first = await fetchPage(version, 0, undefined, query);
  } catch {
    return { events: [], failedPages: 1, totalPages: 1, truncated: false, startDate: query.StartDate, endDate: query.EndDate };
  }
  const totalPages = Math.max(1, Number(first?.TotalPages) || 1);
  const wanted = Math.min(totalPages, ANNUAL_WINDOW_MAX_PAGES);
  const FAILED = Symbol('failed');
  const rest = await mapWithConcurrency(
    Array.from({ length: wanted - 1 }, (_unused, i) => i + 1),
    WINDOW_FETCH_CONCURRENCY,
    (page) => fetchPage(version, page, undefined, query).catch(() => FAILED),
  );
  const events = Array.isArray(first?.Result) ? [...first.Result] : [];
  let failedPages = 0;
  for (const page of rest) {
    if (page === FAILED) { failedPages++; continue; }
    if (Array.isArray(page?.Result)) events.push(...page.Result);
  }
  return { events, failedPages, totalPages, truncated: totalPages > ANNUAL_WINDOW_MAX_PAGES, startDate: query.StartDate, endDate: query.EndDate };
}

// The API answers a version it has not published with HTTP 400 (checked
// 2026-10-23 on 26.0.10); a 404 would mean the same. But a quota, an outage or a
// bad request can answer 400 too, so a 400 proves "unpublished" only for a
// release newer than the newest one that returned data (UCDP publishes the
// monthly releases in order). Anywhere else it is our fetch failing.
const UNPUBLISHED_STATUSES = new Set([400, 404]);

function candidateMonth(version) {
  const parsed = parseCandidateVersion(version);
  return parsed ? `${parsed.year}-${String(parsed.month).padStart(2, '0')}` : null;
}

function candidateRank(version) {
  const parsed = parseCandidateVersion(version);
  return parsed ? parsed.year * 12 + parsed.month : NaN;
}

/**
 * Every monthly candidate release from the month containing fromMs through
 * `throughVersion` (the writers pass the current month's release), oldest
 * first. `newest` is the newest release discovery found with data, its first
 * page in hand.
 * - A release up to `newest` that answers 400/404, an empty first page, a
 *   timeout, a network error or a 5xx is a failed fetch: missingReleases, and
 *   the window is incomplete (P9 reads short_window). UCDP has published it,
 *   since it published a later one.
 * - A release after `newest` that answers 400/404 or no rows is one UCDP has
 *   not published yet: unpublishedReleases/unpublishedMonths, the frontier, not
 *   a gap. Any other failure there is still a failed fetch.
 * - `releases` holds the releases up to `newest`, oldest first, so the last is
 *   always the newest with data.
 * - Rows dated before fromMs are dropped. fromMs starts after the annual
 *   release's last year, and a candidate's late revision of an event in that
 *   year can carry a different id from the annual's record of it (14-19% of
 *   candidate ids did not survive into annual 26.1 for Nov-Dec 2025), so the
 *   annual release alone counts those dates.
 */
async function fetchCandidateWindow(fetchPage, newest, { fromMs, throughVersion = newest.version }) {
  const newestRank = candidateRank(newest.version);
  const through = candidateRank(throughVersion) > newestRank ? throughVersion : newest.version;
  const versions = candidateVersionsSince(fromMs, through).filter((v) => v !== newest.version);
  const others = await mapWithConcurrency(versions, WINDOW_FETCH_CONCURRENCY, async (version) => {
    const frontier = candidateRank(version) > newestRank;
    const absent = (unpublished) => ({ version, frontier, missing: !unpublished, unpublished, events: [], complete: false, truncated: false, failedPages: 0 });
    try {
      const first = await fetchPage(version, 0, CANDIDATE_DISCOVER_TIMEOUT_MS);
      if (!hasResults(first)) return absent(frontier);
      return { version, frontier, missing: false, unpublished: false, ...(await fetchCandidatePages(fetchPage, { version, first })) };
    } catch (err) {
      return absent(frontier && UNPUBLISHED_STATUSES.has(Number(err?.status)));
    }
  });
  const newestRelease = { version: newest.version, frontier: false, missing: false, unpublished: false, ...(await fetchCandidatePages(fetchPage, newest)) };
  const inWindow = (event) => {
    const ms = Date.parse(String(event?.date_start || ''));
    return !Number.isFinite(fromMs) || !Number.isFinite(ms) || ms >= fromMs;
  };
  const all = [...others.filter((r) => !r.frontier), newestRelease, ...others.filter((r) => r.frontier)]
    .map((r) => ({ ...r, events: r.events.filter(inWindow) }));
  const unpublished = all.filter((r) => r.unpublished);
  return {
    releases: all.filter((r) => !r.frontier),
    complete: all.every((r) => r.unpublished || (!r.missing && r.complete && !r.truncated)),
    missingReleases: all.filter((r) => r.missing).map((r) => r.version),
    unpublishedReleases: unpublished.map((r) => r.version),
    unpublishedMonths: unpublished.map((r) => candidateMonth(r.version)).filter(Boolean),
  };
}

// An event scores the place it happens (owner ruling, 2026-10-23). UCDP GED
// codes events by the state in conflict, so Gaza and West Bank events carry
// country "Israel" (country_id 666); UCDP's own admin-1 field says where they
// happened. The aggregates the CII reads attribute those rows by that field.
// Palestine is not a CII Tier-1 country, so they feed no scored row.
const UCDP_ADM1_TERRITORIES = Object.freeze({ 'gaza strip': 'Palestine', 'west bank': 'Palestine' });

/** The country an event happened in: UCDP's country, unless its admin-1 unit is a territory listed above. */
function ucdpLocatedCountry(event) {
  const adm1 = String(event?.adm_1 || '').trim().toLowerCase();
  return Object.hasOwn(UCDP_ADM1_TERRITORIES, adm1) ? UCDP_ADM1_TERRITORIES[adm1] : (event?.country || '');
}

function utcMonth(ms) {
  return new Date(ms).toISOString().slice(0, 7);
}

/**
 * What the CII reads (server/worldmonitor/intelligence/v1/get-risk-scores.ts,
 * parseUcdpCache), from every mapped event of the window rather than the
 * capped `events` slice:
 *  - countryDays: per UCDP country name, [UTC day index, events, deaths] rows,
 *    each event counting at least one death (UCDP records an event only when it
 *    killed someone);
 *  - dailyTotals: [UTC day index, events] across every country;
 *  - months and gapMonths: events per calendar month of the window, and the
 *    months that are empty or nearly so (WINDOW_MIN_MONTH_SHARE) while a later
 *    month has rows: a missing release. A first month with under
 *    WINDOW_MIN_MONTH_OVERLAP_DAYS inside the window is not checked. No month
 *    inside the window is exempt: a release UCDP has not published can only
 *    be after the newest one with data, past the window's end.
 */
function summarizeUcdpWindow(mappedEvents, { startMs, endMs }) {
  const byCountry = new Map();
  const daily = new Map();
  const months = {};
  if (Number.isFinite(startMs) && Number.isFinite(endMs)) {
    for (let ms = Date.UTC(new Date(startMs).getUTCFullYear(), new Date(startMs).getUTCMonth(), 1); ms <= endMs;) {
      const d = new Date(ms);
      months[utcMonth(ms)] = 0;
      ms = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
    }
  }
  for (const event of mappedEvents) {
    const ms = Number(event?.dateStart);
    if (!Number.isFinite(ms) || ms <= 0 || ms < startMs || ms > endMs) continue;
    const day = Math.floor(ms / DAY_MS);
    const name = String(event.country || '');
    const deaths = Math.max(1, Number(event.deathsBest) || 0);
    daily.set(day, (daily.get(day) ?? 0) + 1);
    const month = utcMonth(ms);
    if (month in months) months[month] += 1;
    if (!name) continue;
    if (!byCountry.has(name)) byCountry.set(name, new Map());
    const days = byCountry.get(name);
    const row = days.get(day) ?? [day, 0, 0];
    row[1] += 1;
    row[2] += deaths;
    days.set(day, row);
  }
  // Events per day of each month's overlap with the window; a month under
  // WINDOW_MIN_MONTH_SHARE of the median non-empty month is a gap when a later
  // month has rows. Zero alone is not the test: the next release carries a few
  // late revisions into the month a missing release should have filled.
  const monthKeys = Object.keys(months).sort();
  const overlapDays = (month) => {
    const from = Math.max(startMs, Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1, 1));
    const to = Math.min(endMs, Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 1) - 1);
    return Math.max(1, Math.ceil((to - from) / DAY_MS));
  };
  const rates = Object.fromEntries(monthKeys.map((month) => [month, months[month] / overlapDays(month)]));
  const nonEmpty = monthKeys.map((month) => rates[month]).filter((rate) => rate > 0).sort((a, b) => a - b);
  const median = nonEmpty.length ? nonEmpty[Math.floor(nonEmpty.length / 2)] : 0;
  const gapMonths = monthKeys.filter((month, i) => rates[month] < WINDOW_MIN_MONTH_SHARE * median
    && monthKeys.slice(i + 1).some((later) => months[later] > 0)
    && !(i === 0 && overlapDays(month) < WINDOW_MIN_MONTH_OVERLAP_DAYS));
  const countryDays = {};
  for (const [name, days] of [...byCountry.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    countryDays[name] = [...days.values()].sort((a, b) => a[0] - b[0]);
  }
  return {
    countryDays,
    dailyTotals: [...daily.entries()].sort((a, b) => a[0] - b[0]),
    months,
    gapMonths,
  };
}

module.exports = {
  CANDIDATE_MAX_PAGES,
  CANDIDATE_DISCOVER_TIMEOUT_MS,
  CANDIDATE_ANNUAL_FLOOR,
  UCDP_MAX_CONTENT_AGE_MIN,
  ANNUAL_LOOKBACK_MS,
  ANNUAL_WINDOW_MAX_PAGES,
  buildCandidateVersions,
  discoverCandidateVersion,
  fetchCandidatePages,
  capWithAnnualFloor,
  candidateContentMeta,
  annualReleaseEndMs,
  candidateVersionsSince,
  currentCandidateVersion,
  fetchAnnualWindow,
  fetchCandidateWindow,
  summarizeUcdpWindow,
  ucdpLocatedCountry,
};
