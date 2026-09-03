#!/usr/bin/env node
// Freeze last-known-good crawlable live-pulse values for country risk,
// chokepoint status, crisis HAPI summaries, and the top news headlines. Writes
// docs/snapshots/crawlable-live-pulse-<YYYY-MM-DD>.json.
//
// Usage:
//   API_BASE=https://www.worldmonitor.app node scripts/freeze-crawlable-live-pulse.mjs
//
// Uses the anonymous wm-session mint path (same contract as live-tools.js).
// Builds remain deterministic: the corpus generator only reads the committed
// snapshot and never fetches live data.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  chokepointStatusViewModel,
  crisisTrackerViewModel,
  liveRiskViewModel,
} from './crawlable-live-tools.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

const API_BASE = (process.env.API_BASE || 'https://www.worldmonitor.app').replace(/\/$/, '');
const USER_AGENT = process.env.USER_AGENT
  || 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';
// `Number(env || fallback)` only substitutes the fallback for unset/empty. A typo
// like `20s` parses to NaN, which Node coerces to a ~1ms timer -- every request
// would abort instantly and surface as "captured only 0 countries" instead of a
// bad-env-var error. Fail back to the documented default explicitly.
function numberFromEnv(name, fallback) {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

const REQUEST_GAP_MS = numberFromEnv('PULSE_FREEZE_GAP_MS', 120);
const HTTP_TIMEOUT_MS = numberFromEnv('PULSE_FREEZE_TIMEOUT_MS', 20_000);
const OUTPUT_BASENAME = process.env.PULSE_FREEZE_OUTPUT_BASENAME || '';

// Countries the upstream may legitimately fail to serve in a single run before
// the freeze is considered too thin to publish. Chokepoints, crises and
// headlines are small enough sets that partial capture is never acceptable.
const MAX_COUNTRY_CAPTURE_SHORTFALL = 5;

// The welcome strip's headline card renders exactly four rows, and
// scripts/build-welcome-teasers.mjs derives them from this capture. Fewer than
// four means the card would keep whatever it rendered last -- which is the
// #7608 failure mode with a stale date on it. Gate instead.
const HEADLINE_CAPTURE_COUNT = 4;

// Aggregator hosts whose article links are opaque, expiring redirects rather
// than the publisher's own URL. A frozen row is published for up to
// MAX_LIVE_PULSE_SNAPSHOT_AGE_DAYS, and "verifiable" has to mean a reader can
// see the outlet in the URL and still reach the piece next week.
const AGGREGATOR_LINK_HOSTS = new Set(['news.google.com']);

// Operator-facing review-hygiene text the chokepoint status contract appends
// (THREAT_CONFIG_STALE_NOTE in server/worldmonitor/supply-chain/v1/get-chokepoint-status.ts).
// It is useful in the live tool but must not be frozen into the crawlable corpus,
// where it becomes indexed, quotable page content.
const INTERNAL_NOTE_RE = /\s*;?\s*Threat baseline last reviewed[^;]*?review recommended\.?/gi;
const NO_ACTIVE_DISRUPTIONS_DESCRIPTION = 'No active disruptions';

// Returns null, never a placeholder sentence. "No additional status note was
// supplied." used to be frozen here and rendered as a real <p> in <main> — an
// absence described in prose reads to a crawler as published content, and it
// was the only body text 7 of 13 chokepoint pages carried (#7530). An absent
// note has no page representation: the paragraph is emitted `hidden`.
function publishableDescription(value) {
  const cleaned = String(value || '')
    .replace(INTERNAL_NOTE_RE, '')
    .replace(/^[\s;·—-]+|[\s;·—-]+$/g, '')
    .trim();
  return cleaned && cleaned !== NO_ACTIVE_DISRUPTIONS_DESCRIPTION ? cleaned : null;
}

// Every capture gate below reports a bare count. That number says a refresh
// failed but never why, so a red scheduled run (or a hand-run freeze) starts
// from zero — the per-item errors are collected and then dropped on the throw
// path. Carry the first one into the message.
function firstCaptureCause(errors) {
  const first = errors[0];
  if (!first) return '';
  const scope = first.id ?? first.code ?? first.slug ?? 'unknown';
  return `; first error (${scope}): ${first.message}`;
}

const RESILIENCE_SNAPSHOT_RE = /^resilience-ranking-(\d{4}-\d{2}-\d{2})\.json$/;
const SNAPSHOT_DIR = path.join(REPO_ROOT, 'docs', 'snapshots');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeApiBase(apiBase) {
  return String(apiBase || API_BASE).replace(/\/$/, '');
}

async function fetchJson(url, { headers = {}, method = 'GET', body, apiBase = API_BASE } = {}) {
  const origin = normalizeApiBase(apiBase);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method,
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/json',
        Origin: origin,
        Referer: `${origin}/`,
        ...headers,
      },
      body,
      signal: controller.signal,
    });
    const text = await response.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = { raw: text.slice(0, 400) };
    }
    if (!response.ok) {
      const err = new Error(`HTTP ${response.status} for ${url}`);
      err.status = response.status;
      err.payload = payload;
      throw err;
    }
    return payload;
  } finally {
    clearTimeout(timer);
  }
}

async function mintSession(apiBase = API_BASE) {
  const base = normalizeApiBase(apiBase);
  const payload = await fetchJson(`${base}/api/wm-session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
    apiBase: base,
  });
  const token = String(payload?.token || '').trim();
  if (!token) throw new Error('wm-session response did not include a token');
  return token;
}

async function authedGet(pathname, token, apiBase = API_BASE) {
  const base = normalizeApiBase(apiBase);
  return fetchJson(`${base}${pathname}`, {
    headers: { Cookie: `wm-session=${token}` },
    apiBase: base,
  });
}

async function resolveLatestResilienceSnapshot() {
  const entries = await fs.readdir(SNAPSHOT_DIR);
  const candidates = entries
    .map((filename) => ({ filename, match: filename.match(RESILIENCE_SNAPSHOT_RE) }))
    .filter(({ match }) => match)
    .sort((a, b) => b.match[1].localeCompare(a.match[1]));
  if (candidates.length === 0) {
    throw new Error('No resilience ranking snapshot found');
  }
  const relativePath = path.join('docs', 'snapshots', candidates[0].filename);
  const snapshot = JSON.parse(await fs.readFile(path.join(REPO_ROOT, relativePath), 'utf8'));
  const codes = [
    ...(Array.isArray(snapshot.items) ? snapshot.items : []),
    ...(Array.isArray(snapshot.greyedOut) ? snapshot.greyedOut : []),
  ]
    .map((row) => String(row?.code || row?.countryCode || '').toUpperCase())
    .filter((code) => /^[A-Z]{2}$/.test(code));
  return { relativePath, codes: [...new Set(codes)].sort() };
}

async function loadCrises() {
  const raw = JSON.parse(
    await fs.readFile(path.join(REPO_ROOT, 'shared', 'crawlable-crises.json'), 'utf8'),
  );
  return raw.map((crisis) => ({
    slug: crisis.slug,
    coverage: crisis.coverage.map((country) => ({
      code: String(country.code).toUpperCase(),
      name: country.name,
    })),
  }));
}

async function loadChokepointIds() {
  const module = await import(pathToFileURL(
    path.join(REPO_ROOT, 'src', 'config', 'chokepoint-registry.ts'),
  ).href);
  return (module.CHOKEPOINT_REGISTRY || []).map((entry) => entry.id);
}

function isoDate(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function countryRecord(view, payload, freezeStartedAt) {
  return {
    partial: view.partial === true,
    score: view.partial ? null : view.score,
    band: view.partial ? null : view.band,
    trend: view.partial ? null : view.trend,
    advisory: view.advisory,
    sanctions: view.sanctions,
    // `computedAt === null` means the upstream supplied nothing datable. The
    // browser path deliberately renders no <time datetime> in that case; the
    // freeze must not invent one either, or every such page publishes a
    // machine-readable retrieval claim sourced from the harvest clock. The
    // harvest instant is kept separately for operator forensics.
    asOf: view.computedAt === null ? null : new Date(view.computedAt).toISOString(),
    retrievedAt: new Date(freezeStartedAt).toISOString(),
    methodologyVersion: view.methodologyVersion || '',
    geoConvergence: Number.isFinite(payload?.cii?.components?.geoConvergence)
      ? payload.cii.components.geoConvergence
      : null,
  };
}

function chokepointRecord(view) {
  return {
    disruptionScore: view.disruptionScore,
    status: view.status,
    congestion: view.congestion,
    navigationalWarnings: view.navigationalWarnings,
    navigationalWarningsAvailable: view.navigationalWarnings !== null,
    aisDisruptions: view.aisDisruptions,
    aisSnapshotAvailable: view.aisDisruptions !== null,
    description: publishableDescription(view.description),
    todayTransits: view.todayTransits,
    todayCountsAvailable: view.todayCountsAvailable,
    weekMovement: view.weekMovement,
    partial: view.partial === true,
    asOf: new Date(view.fetchedAt).toISOString(),
  };
}

function crisisRecord(view) {
  return {
    state: view.state,
    eventsTotal: view.eventsTotal,
    fatalities: view.fatalities,
    politicalViolenceEvents: view.politicalViolenceEvents,
    referencePeriod: view.referencePeriod,
    asOf: view.updatedAt === null ? null : new Date(view.updatedAt).toISOString(),
    missingCountries: view.missingCountries,
    rows: view.rows.map((row) => ({
      code: row.code,
      name: row.name,
      events: row.events,
      fatalities: row.fatalities,
      political: row.political,
      demonstrations: row.demonstrations,
      referencePeriod: row.referencePeriod,
      updatedAt: new Date(row.updatedAt).toISOString(),
    })),
  };
}

// Reduce a ListFeedDigest response to the publishable headline rows.
//
// A row reaches the homepage with a masthead beside it, so it must carry
// everything a reader needs to check that attribution: the outlet, an https
// article URL on the publisher's own host, and the publication time. #7608
// shipped four invented headlines under real Reuters/FT/AP/BBC bylines because
// the strip's fallback was hand-written prose with none of those. An item
// missing any of them is dropped here rather than published unverifiable.
//
// Ranking mirrors the browser path in pro-test/src/services/teasers.ts, so the
// frozen rows are the same ones a live fetch would replace them with.
export function selectFrozenHeadlines(payload, limit = HEADLINE_CAPTURE_COUNT) {
  const categories = payload && typeof payload === 'object' ? payload.categories : null;
  if (!categories || typeof categories !== 'object') return [];
  return Object.values(categories)
    .flatMap((bucket) => (Array.isArray(bucket?.items) ? bucket.items : []))
    .map((item) => {
      const title = String(item?.title || '').trim();
      const source = String(item?.source || '').trim();
      const url = String(item?.link || '').trim();
      const publishedAt = Number(item?.publishedAt);
      if (!title || !source || !url.startsWith('https://')) return null;
      if (!Number.isFinite(publishedAt) || publishedAt <= 0) return null;
      if (AGGREGATOR_LINK_HOSTS.has(URL.parse(url)?.hostname ?? '')) return null;
      return {
        row: { title, source, url, publishedAt: new Date(publishedAt).toISOString() },
        importanceScore: Number(item?.importanceScore) || 0,
        publishedAtMs: publishedAt,
      };
    })
    .filter((entry) => entry !== null)
    .sort((a, b) => (
      b.importanceScore - a.importanceScore
      || b.publishedAtMs - a.publishedAtMs
      || a.row.title.localeCompare(b.row.title)
    ))
    .slice(0, limit)
    .map((entry) => entry.row);
}

function signalConvergenceReference(capturedAt) {
  // Methodology-cited reference examples from docs/geographic-convergence.mdx.
  // These make the Geographic Convergence Score crawlable and attributable
  // without requiring Pro MCP access at freeze time.
  return {
    metricName: 'Geographic Convergence Score',
    methodologyPath: 'docs/geographic-convergence.mdx',
    scale: { min: 0, max: 100 },
    formula: {
      typeScore: 'event_types × 25',
      countBoost: 'min(25, total_events × 2)',
      convergenceScore: 'min(100, type_score + count_boost)',
    },
    defaultMinDomains: 3,
    thresholds: [
      { types: 4, scoreRange: '100', priority: 'Critical' },
      { types: 3, scoreRange: '90-100', priority: 'Critical' },
      { types: 3, scoreRange: '81-89', priority: 'High' },
    ],
    referenceExamples: [
      {
        label: 'Taiwan Strait Buildup',
        cell: '25°N, 121°E',
        types: ['military flights', 'naval vessels', 'protests'],
        typeCount: 3,
        totalEvents: 6,
        score: 87,
        priority: 'High',
        source: 'docs/geographic-convergence.mdx',
        kind: 'methodology-example',
      },
      {
        label: 'Middle East Flashpoint',
        cell: '32°N, 35°E',
        types: ['military flights', 'protests', 'earthquake'],
        typeCount: 3,
        totalEvents: 14,
        score: 100,
        priority: 'Critical',
        source: 'docs/geographic-convergence.mdx',
        kind: 'methodology-example',
      },
    ],
    capturedAt,
  };
}

export async function freezeCrawlableLivePulse({
  apiBase = API_BASE,
  rootDir = REPO_ROOT,
  // Injectable so the coverage gates can be exercised without a 20+ second
  // inter-request delay; production callers keep the throttled default.
  requestGapMs = REQUEST_GAP_MS,
} = {}) {
  const base = normalizeApiBase(apiBase);
  const freezeStartedAt = Date.now();
  const capturedAt = isoDate(freezeStartedAt);
  const token = await mintSession(base);
  const { relativePath: resilienceSnapshotPath, codes } = await resolveLatestResilienceSnapshot();
  const crises = await loadCrises();
  const chokepointIds = await loadChokepointIds();

  const countries = {};
  const countryErrors = [];
  for (const code of codes) {
    try {
      const payload = await authedGet(
        `/api/intelligence/v1/get-country-risk?country_code=${encodeURIComponent(code)}`,
        token,
        base,
      );
      const view = liveRiskViewModel(payload, freezeStartedAt);
      countries[code] = countryRecord(view, payload, freezeStartedAt);
    } catch (error) {
      countryErrors.push({ code, message: error instanceof Error ? error.message : String(error) });
    }
    await sleep(requestGapMs);
  }

  // Every other network call in this run degrades per-item into *Errors. Left
  // unguarded, a single transient failure here would propagate out of the
  // function and discard the ~190 country records already fetched above.
  let chokepointPayload = null;
  const chokepointErrors = [];
  try {
    chokepointPayload = await authedGet('/api/supply-chain/v1/get-chokepoint-status', token, base);
  } catch (error) {
    chokepointErrors.push({
      id: '*',
      message: error instanceof Error ? error.message : String(error),
    });
  }
  const chokepoints = {};
  if (chokepointPayload !== null) {
    for (const id of chokepointIds) {
      try {
        const view = chokepointStatusViewModel(chokepointPayload, id, freezeStartedAt);
        chokepoints[id] = chokepointRecord(view);
      } catch (error) {
        chokepointErrors.push({ id, message: error instanceof Error ? error.message : String(error) });
      }
    }
  }

  const crisisSnapshots = {};
  const crisisErrors = [];
  for (const crisis of crises) {
    try {
      const results = [];
      for (const country of crisis.coverage) {
        try {
          const payload = await authedGet(
            `/api/conflict/v1/get-humanitarian-summary?country_code=${encodeURIComponent(country.code)}`,
            token,
            base,
          );
          results.push({ code: country.code, payload });
        } catch (error) {
          results.push({ code: country.code, error });
        }
        await sleep(requestGapMs);
      }
      const view = crisisTrackerViewModel(results, crisis.coverage, freezeStartedAt);
      crisisSnapshots[crisis.slug] = crisisRecord(view);
    } catch (error) {
      crisisErrors.push({
        slug: crisis.slug,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Guarded like every other network step: a digest outage degrades into the
  // coverage gate below instead of discarding the country/chokepoint work.
  const headlineErrors = [];
  let headlines = [];
  try {
    const digest = await authedGet('/api/news/v1/list-feed-digest?variant=full&lang=en', token, base);
    headlines = selectFrozenHeadlines(digest, HEADLINE_CAPTURE_COUNT);
  } catch (error) {
    headlineErrors.push({
      id: '*',
      message: error instanceof Error ? error.message : String(error),
    });
  }

  const geoLeaders = Object.entries(countries)
    .filter(([, row]) => Number.isFinite(row.geoConvergence) && row.geoConvergence > 0)
    .sort((a, b) => b[1].geoConvergence - a[1].geoConvergence)
    .slice(0, 10)
    .map(([code, row]) => ({
      code,
      geoConvergence: row.geoConvergence,
      instabilityScore: row.score,
      asOf: row.asOf,
    }));

  const snapshot = {
    schemaVersion: 1,
    capturedAt,
    capturedAtMs: freezeStartedAt,
    apiBase: base,
    resilienceSnapshotPath,
    countries,
    chokepoints,
    crises: crisisSnapshots,
    headlines,
    signalConvergence: {
      ...signalConvergenceReference(capturedAt),
      ciiGeoConvergenceLeaders: geoLeaders,
    },
    coverage: {
      countryCount: Object.keys(countries).length,
      countryErrorCount: countryErrors.length,
      chokepointCount: Object.keys(chokepoints).length,
      chokepointErrorCount: chokepointErrors.length,
      crisisCount: Object.keys(crisisSnapshots).length,
      crisisErrorCount: crisisErrors.length,
      headlineCount: headlines.length,
      headlineErrorCount: headlineErrors.length,
    },
    errors: {
      countries: countryErrors,
      chokepoints: chokepointErrors,
      crises: crisisErrors,
      headlines: headlineErrors,
    },
  };

  // Gate against the universe the corpus actually renders, not a magic number.
  // The corpus builds one page per code/id, so a capture that clears a fixed
  // floor while missing dozens of entries would silently return those pages to
  // the pre-pulse placeholder state with a green build.
  const minCountries = Math.max(1, codes.length - MAX_COUNTRY_CAPTURE_SHORTFALL);
  if (Object.keys(countries).length < minCountries) {
    throw new Error(
      `Pulse freeze captured only ${Object.keys(countries).length} of ${codes.length} countries; `
      + `expected at least ${minCountries}`
      + firstCaptureCause(countryErrors),
    );
  }
  if (Object.keys(chokepoints).length < chokepointIds.length) {
    throw new Error(
      `Pulse freeze captured only ${Object.keys(chokepoints).length} of ${chokepointIds.length} chokepoints`
      + firstCaptureCause(chokepointErrors),
    );
  }
  if (Object.keys(crisisSnapshots).length < crises.length) {
    throw new Error(
      `Pulse freeze captured only ${Object.keys(crisisSnapshots).length} of ${crises.length} crises`
      + firstCaptureCause(crisisErrors),
    );
  }

  if (headlines.length < HEADLINE_CAPTURE_COUNT) {
    throw new Error(
      `Pulse freeze captured only ${headlines.length} of ${HEADLINE_CAPTURE_COUNT} headlines`
      + firstCaptureCause(headlineErrors),
    );
  }

  const basename = OUTPUT_BASENAME || `crawlable-live-pulse-${capturedAt}.json`;
  const outPath = path.join(rootDir, 'docs', 'snapshots', basename);
  await fs.writeFile(outPath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
  return { outPath, snapshot };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === __filename;
if (isMain) {
  freezeCrawlableLivePulse()
    .then(({ outPath, snapshot }) => {
      console.log(`[freeze-crawlable-live-pulse] wrote ${outPath}`);
      console.log(
        `[freeze-crawlable-live-pulse] countries=${snapshot.coverage.countryCount} `
        + `chokepoints=${snapshot.coverage.chokepointCount} `
        + `crises=${snapshot.coverage.crisisCount} `
        + `headlines=${snapshot.coverage.headlineCount}`,
      );
      if (
        snapshot.coverage.countryErrorCount
        || snapshot.coverage.chokepointErrorCount
        || snapshot.coverage.crisisErrorCount
        || snapshot.coverage.headlineErrorCount
      ) {
        console.warn('[freeze-crawlable-live-pulse] partial errors recorded in snapshot.errors');
      }
    })
    .catch((error) => {
      console.error('[freeze-crawlable-live-pulse] failed:', error);
      process.exitCode = 1;
    });
}

export { normalizeApiBase, mintSession, authedGet };
