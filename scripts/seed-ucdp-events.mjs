#!/usr/bin/env node

import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { loadEnvFile } from './_seed-utils.mjs';
import { unwrapEnvelope } from './_seed-envelope-source.mjs';
import { compactUcdpDashboardPayload } from './_ucdp-dashboard.mjs';
// GED Candidate discovery/fetch/merge is shared with scripts/ais-relay.cjs so the
// two UCDP writers cannot drift (they already had, on discovery concurrency and
// probe timeout). CJS module imported from ESM, as seed-market-quotes.mjs does
// with scripts/shared/notification-dedup.cjs.
import ucdpCandidate from './shared/ucdp-candidate.cjs';

const {
  CANDIDATE_MAX_PAGES,
  buildCandidateVersions,
  discoverCandidateVersion: discoverCandidateRelease,
  fetchCandidatePages,
  capWithAnnualFloor,
  candidateContentMeta,
} = ucdpCandidate;

const REDIS_KEY = 'conflict:ucdp-events:v1';
// Dashboard-sized projection. The bootstrap slow tier hydrates from THIS key so
// every client stops downloading 2,000 events (662 KB) to render 150 rows and a
// handful of derived numbers (#5300). The canonical key above is untouched and
// still serves the RPC, MCP and the map layer.
const BOOTSTRAP_KEY = 'conflict:ucdp-events-bootstrap:v1';
const BOOTSTRAP_META_KEY = 'seed-meta:conflict:ucdp-events-bootstrap';
const UCDP_PAGE_SIZE = 1000;
const MAX_PAGES = 6;
const MAX_EVENTS = 2000; // Redis payload guard; widening needs live UCDP volume + Upstash payload validation.
// Retained Redis input window. CII v8's classifier accepts a 2-year window, but
// this writer fetches the newest pages only and keeps at most MAX_EVENTS from a
// 365-day trailing slice until retention is deliberately widened.
const TRAILING_WINDOW_MS = 365 * 24 * 60 * 60 * 1000;

const VIOLENCE_TYPE_MAP = {
  1: 'UCDP_VIOLENCE_TYPE_STATE_BASED',
  2: 'UCDP_VIOLENCE_TYPE_NON_STATE',
  3: 'UCDP_VIOLENCE_TYPE_ONE_SIDED',
};

const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function maskToken(token) {
  if (!token || token.length < 8) return '***';
  return token.slice(0, 4) + '***' + token.slice(-4);
}

function buildVersionCandidates() {
  const year = new Date().getFullYear() - 2000;
  return [...new Set([`${year}.1`, `${year - 1}.1`, '25.1', '24.1'])];
}

// UCDP also publishes GED Candidate releases monthly ('${year}.0.N'), with "not
// more than a month's lag globally" per UCDP's docs — unlike the ANNUAL release
// above, which is finalized once a year and lags ~7 months behind by the time
// the next one lands. Window construction, discovery, paging and merge semantics
// live in scripts/shared/ucdp-candidate.cjs (imported above) so this cron and
// the relay seeder stay identical in behaviour; only the transport differs.

// Page fetches keep the generous 90s budget (a 1000-row page of a 418k-row
// release is slow); candidate DISCOVERY passes a much shorter timeout, because
// it fires six speculative probes and this script runs inside the relay-backup
// bundle, which SIGKILLs the UCDP section at 300s.
async function fetchGedPage(version, page, token, timeoutMs = 90_000) {
  const headers = { Accept: 'application/json', 'User-Agent': CHROME_UA };
  if (token) headers['x-ucdp-access-token'] = token;
  const resp = await fetch(
    `https://ucdpapi.pcr.uu.se/api/gedevents/${version}?pagesize=${UCDP_PAGE_SIZE}&page=${page}`,
    { headers, signal: AbortSignal.timeout(timeoutMs) },
  );
  if (!resp.ok) throw new Error(`UCDP GED API error (${version}, page ${page}): ${resp.status}`);
  return resp.json();
}

async function discoverVersion(token, fetchPage = fetchGedPage, candidates = buildVersionCandidates()) {
  console.log(`  Probing versions sequentially: ${candidates.join(', ')}`);
  for (const version of candidates) {
    try {
      console.log(`  Trying v${version}...`);
      const page0 = await fetchPage(version, 0, token);
      if (!Array.isArray(page0?.Result) || page0.Result.length === 0) continue;
      console.log(`  Found v${version} with ${page0.Result.length} events on page 0`);
      return { version, page0 };
    } catch (err) {
      console.warn(`  v${version} failed: ${err.message}`);
    }
  }
  throw new Error('No valid UCDP GED version found');
}

// Binds the token into the (version, page, timeoutMs) shape the shared candidate
// helpers call, so transport stays here and merge semantics stay shared.
function candidateFetcher(token) {
  return (version, page, timeoutMs) => fetchGedPage(version, page, token, timeoutMs);
}

// Probes all candidates CONCURRENTLY under a short discovery timeout and returns
// null (never throws) when none is published yet — the candidate is an addition
// on top of the annual base, never a replacement, so its absence is not an error.
async function discoverCandidateVersion(token, fetchPage = candidateFetcher(token), candidates = buildCandidateVersions()) {
  console.log(`  Probing candidate versions: ${candidates.join(', ')}`);
  const found = await discoverCandidateRelease(fetchPage, candidates);
  if (!found) {
    console.log('  No candidate release available this cycle — continuing with annual only');
    return null;
  }
  console.log(`  Found candidate v${found.version} with ${found.first.Result.length} events on page 0`);
  return found;
}

// Extend the TTL on the existing canonical key + its seed-meta instead of
// overwriting last-good data. Deliberately does NOT write a fresh seed-meta:
// health must reflect the age of the data actually being served, not the time
// of a failed attempt.
async function extendExistingTtl(redisUrl, redisToken) {
  try {
    const expire = (key, ttl) => fetch(redisUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${redisToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(['EXPIRE', key, ttl]),
      signal: AbortSignal.timeout(5_000),
    });
    const r1 = await expire(REDIS_KEY, 86400);
    if (!r1.ok) console.warn(`  EXPIRE ${REDIS_KEY} failed: HTTP ${r1.status}`);
    const r2 = await expire('seed-meta:conflict:ucdp-events', 604800);
    if (!r2.ok) console.warn(`  EXPIRE seed-meta failed: HTTP ${r2.status}`);
    if (r1.ok && r2.ok) console.log(`  Extended TTL on ${REDIS_KEY} and seed-meta`);
  } catch (e) { console.warn(`  TTL extension failed: ${e.message}`); }
}

function parseDateMs(value) {
  if (!value) return NaN;
  return Date.parse(String(value));
}

function getMaxDateMs(events) {
  let maxMs = NaN;
  for (const event of events) {
    const ms = parseDateMs(event?.date_start);
    if (!Number.isFinite(ms)) continue;
    if (!Number.isFinite(maxMs) || ms > maxMs) maxMs = ms;
  }
  return maxMs;
}

async function main() {
  loadEnvFile(import.meta.url);

  const redisUrl = process.env.UPSTASH_REDIS_REST_URL;
  const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  const ucdpToken = (process.env.UCDP_ACCESS_TOKEN || process.env.UC_DP_KEY || '').trim();

  if (!redisUrl || !redisToken) {
    console.error('Missing UPSTASH_REDIS_REST_URL or UPSTASH_REDIS_REST_TOKEN');
    process.exit(1);
  }

  console.log('=== UCDP Events Seed ===');
  console.log(`  Redis:      ${redisUrl}`);
  console.log(`  Redis Token: ${maskToken(redisToken)}`);
  console.log(`  UCDP Token: ${ucdpToken ? maskToken(ucdpToken) : '(none — unauthenticated)'}`);
  console.log();

  const { version, page0 } = await discoverVersion(ucdpToken);
  const totalPages = Math.max(1, Number(page0?.TotalPages) || 1);
  const newestPage = totalPages - 1;
  console.log(`  Version: ${version} | Total pages: ${totalPages}`);

  const FAILED = Symbol('failed');
  const pagesToFetch = [];
  for (let offset = 0; offset < MAX_PAGES && (newestPage - offset) >= 0; offset++) {
    const page = newestPage - offset;
    if (page === 0) {
      pagesToFetch.push(Promise.resolve(page0));
    } else {
      pagesToFetch.push(fetchGedPage(version, page, ucdpToken).catch(() => FAILED));
    }
  }

  const pageResults = await Promise.all(pagesToFetch);

  const allEvents = [];
  let latestDatasetMs = NaN;
  let failedPages = 0;

  for (const rawData of pageResults) {
    if (rawData === FAILED) { failedPages++; continue; }
    const events = Array.isArray(rawData?.Result) ? rawData.Result : [];
    allEvents.push(...events);
    const pageMaxMs = getMaxDateMs(events);
    if (!Number.isFinite(latestDatasetMs) && Number.isFinite(pageMaxMs)) {
      latestDatasetMs = pageMaxMs;
    }
  }

  console.log(`  Raw events: ${allEvents.length} | Failed pages: ${failedPages}`);

  // Preserve last-good data when the annual base could not be fetched AT ALL.
  //
  // This MUST run before the candidate merge. The empty-payload guard further
  // down fires on the FINAL event count, so once a healthy candidate refills the
  // payload it can no longer detect that the annual base is missing — the run
  // would publish a thin candidate-only release over the last good annual
  // payload and stamp it with a fresh seed-meta. ais-relay.cjs has always had
  // this guard ahead of its merge; this writer did not.
  if (allEvents.length === 0 && failedPages > 0) {
    console.warn(`  All ${failedPages} annual pages failed — extending existing key TTL (preserving last good data)`);
    await extendExistingTtl(redisUrl, redisToken);
    process.exit(0);
  }

  // Merge the newest GED Candidate release on top of the annual base (ADD,
  // never replace — annual is the finalized, authoritative history; replacing
  // it with a candidate, which is ~1.8k events vs ~418k, would drop nearly
  // everything outside the CII 2-year conflict recency window and flip
  // /api/health.riskScores to COVERAGE_PARTIAL — the same class of regression
  // ucdpDiscoverVersion's Promise.any history in scripts/ais-relay.cjs was
  // fixed to avoid).
  let candidateVersion = null;
  let candidateComplete = false;
  const candidateIds = new Set();
  try {
    const candidate = await discoverCandidateVersion(ucdpToken);
    if (candidate) {
      const merged = await fetchCandidatePages(candidateFetcher(ucdpToken), candidate);
      // Only claim the bare candidate version once the release was fetched
      // whole — a partial fetch labelled `26.0.6` is indistinguishable from a
      // complete one downstream.
      candidateComplete = merged.complete && !merged.truncated;
      candidateVersion = candidateComplete ? candidate.version : `${candidate.version}+partial`;
      if (merged.failedPages > 0) {
        console.warn(`  candidate v${candidate.version}: ${merged.failedPages} page(s) failed — publishing as partial`);
      }
      if (merged.truncated) {
        console.warn(`  candidate v${candidate.version}: ${merged.totalPages} pages exceeds cap ${CANDIDATE_MAX_PAGES} — ${merged.totalPages - CANDIDATE_MAX_PAGES} page(s) dropped`);
      }
      for (const event of merged.events) {
        if (event?.id != null) candidateIds.add(String(event.id));
      }
      allEvents.push(...merged.events);
      const candidateMaxMs = getMaxDateMs(merged.events);
      if (Number.isFinite(candidateMaxMs) && (!Number.isFinite(latestDatasetMs) || candidateMaxMs > latestDatasetMs)) {
        latestDatasetMs = candidateMaxMs;
      }
      console.log(`  Merged candidate v${candidateVersion}: +${merged.events.length} events`);
    }
  } catch (err) {
    console.warn(`  Candidate merge skipped: ${err.message}`);
  }

  // Dedupe by id: candidate events are appended after the annual base, so a
  // candidate's revision of an event also present in the annual release wins
  // (it's the fresher record).
  const byId = new Map();
  for (const event of allEvents) {
    const id = event?.id != null ? String(event.id) : '';
    byId.set(id || Symbol(id), event);
  }
  const dedupedEvents = [...byId.values()];

  const filtered = dedupedEvents.filter((event) => {
    if (!Number.isFinite(latestDatasetMs)) return true;
    const eventMs = parseDateMs(event?.date_start);
    if (!Number.isFinite(eventMs)) return false;
    return eventMs >= (latestDatasetMs - TRAILING_WINDOW_MS);
  });

  console.log(`  After 1-year trailing window: ${filtered.length}`);

  const mapped = filtered.map((e) => ({
    id: String(e.id || ''),
    dateStart: Date.parse(e.date_start) || 0,
    dateEnd: Date.parse(e.date_end) || 0,
    location: {
      latitude: Number(e.latitude) || 0,
      longitude: Number(e.longitude) || 0,
    },
    country: e.country || '',
    sideA: (e.side_a || '').substring(0, 200),
    sideB: (e.side_b || '').substring(0, 200),
    deathsBest: Number(e.best) || 0,
    deathsLow: Number(e.low) || 0,
    deathsHigh: Number(e.high) || 0,
    violenceType: VIOLENCE_TYPE_MAP[e.type_of_violence] || 'UCDP_VIOLENCE_TYPE_UNSPECIFIED',
    sourceOriginal: (e.source_original || '').substring(0, 300),
  }));

  mapped.sort((a, b) => b.dateStart - a.dateStart);
  // Cap newest-first, but reserve slots for the annual base. Every candidate
  // event is newer than every annual one, so a plain slice hands the whole
  // payload to the candidate as soon as it outgrows the cap — evicting the
  // history get-risk-scores.ts needs for per-country conflict floors.
  const capped = capWithAnnualFloor(mapped, (event) => candidateIds.has(event.id), MAX_EVENTS);
  if (mapped.length > MAX_EVENTS) console.log(`  Capped: ${mapped.length} → ${capped.length}`);

  // Guard: never overwrite existing data with empty results.
  // Extend TTL on existing key instead so health stays OK.
  if (capped.length === 0) {
    console.warn(`  0 events after processing — extending existing key TTL (preserving last good data)`);
    await extendExistingTtl(redisUrl, redisToken);
    process.exit(0);
  }

  const payload = {
    events: capped,
    fetchedAt: Date.now(),
    version,
    candidateVersion,
    totalRaw: allEvents.length,
    filteredCount: mapped.length,
  };

  console.log(`  Mapped: ${mapped.length} events`);
  if (mapped[0]) {
    console.log(`  Newest: ${new Date(mapped[0].dateStart).toISOString().slice(0, 10)} — ${mapped[0].country}`);
  }
  console.log();

  const body = JSON.stringify(['SET', REDIS_KEY, JSON.stringify(payload), 'EX', 86400]);
  const resp = await fetch(redisUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${redisToken}`,
      'Content-Type': 'application/json',
    },
    body,
    signal: AbortSignal.timeout(15_000),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    console.error(`Redis SET failed: HTTP ${resp.status} — ${text.slice(0, 200)}`);
    process.exit(1);
  }

  const result = await resp.json();
  console.log('  Redis SET result:', result);

  // Compact dashboard projection (#5300): rows the panel renders + aggregates and
  // classifications it derives from the full set. Best-effort — a failure here
  // must not fail the canonical publish; bootstrap falls back to reporting the key
  // missing and the client re-fetches from the RPC.
  try {
    const compact = compactUcdpDashboardPayload(payload);
    const compactBody = JSON.stringify(['SET', BOOTSTRAP_KEY, JSON.stringify(compact), 'EX', 86400]);
    const compactResp = await fetch(redisUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${redisToken}`, 'Content-Type': 'application/json' },
      body: compactBody,
      signal: AbortSignal.timeout(15_000),
    });
    if (!compactResp.ok) throw new Error(`HTTP ${compactResp.status}`);

    const compactMeta = JSON.stringify({ fetchedAt: Date.now(), recordCount: compact.events.length });
    const compactMetaResp = await fetch(redisUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${redisToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(['SET', BOOTSTRAP_META_KEY, compactMeta, 'EX', 604800]),
      signal: AbortSignal.timeout(5_000),
    });
    if (!compactMetaResp.ok) throw new Error(`seed-meta HTTP ${compactMetaResp.status}`);
    console.log(`  Wrote ${BOOTSTRAP_KEY}: ${compact.events.length} rows, ${Object.keys(compact.classifications).length} classifications (from ${compact.totalEvents} events)`);
  } catch (e) {
    console.error(`  Compact projection write failed: ${e.message} — canonical key is published, dashboard will fall back to the RPC`);
  }

  // Write seed-meta for health endpoint freshness tracking.
  // The content-age trio (newestItemAt/oldestItemAt/maxContentAgeMin) is the
  // opt-in signal api/health.js reads to report STALE_CONTENT. Without it a
  // silently dead candidate merge is invisible: fetchedAt stays fresh and
  // recordCount stays full while the data itself falls back to the annual
  // release's ~7-month lag.
  const metaKey = 'seed-meta:conflict:ucdp-events';
  const meta = {
    fetchedAt: Date.now(),
    recordCount: capped.length,
    candidateVersion,
    candidateComplete,
    annualFailedPages: failedPages,
    ...candidateContentMeta(capped),
  };
  const metaBody = JSON.stringify(['SET', metaKey, JSON.stringify(meta), 'EX', 604800]);
  await fetch(redisUrl, {
    method: 'POST',
    headers: { Authorization: `Bearer ${redisToken}`, 'Content-Type': 'application/json' },
    body: metaBody,
    signal: AbortSignal.timeout(5_000),
  }).catch(() => console.error('  seed-meta write failed'));
  console.log(`  Wrote seed-meta: ${metaKey}`);

  const getResp = await fetch(`${redisUrl}/get/${encodeURIComponent(REDIS_KEY)}`, {
    headers: { Authorization: `Bearer ${redisToken}` },
    signal: AbortSignal.timeout(5_000),
  });
  if (getResp.ok) {
    const getData = await getResp.json();
    if (getData.result) {
      const parsed = unwrapEnvelope(JSON.parse(getData.result)).data;
      console.log(`\n  Verified: ${parsed.events?.length} events in Redis`);
      console.log(`  Version: ${parsed.version} | fetchedAt: ${new Date(parsed.fetchedAt).toISOString()}`);
    }
  }

  console.log('\n=== Done ===');
}

export { buildVersionCandidates, discoverVersion, buildCandidateVersions, discoverCandidateVersion };

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch(err => {
    const _cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : ''; console.error('FATAL:', (err.message || err) + _cause);
    // Exit gracefully for cron — crashing restarts the container unnecessarily.
    // The health endpoint will flag stale data via seed-meta.
    process.exit(0);
  });
}
