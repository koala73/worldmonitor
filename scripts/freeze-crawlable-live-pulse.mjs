#!/usr/bin/env node
// Freeze last-known-good crawlable live-pulse values for country risk,
// chokepoint status, and crisis HAPI summaries. Writes
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
const REQUEST_GAP_MS = Number(process.env.PULSE_FREEZE_GAP_MS || 120);
const HTTP_TIMEOUT_MS = Number(process.env.PULSE_FREEZE_TIMEOUT_MS || 20_000);
const OUTPUT_BASENAME = process.env.PULSE_FREEZE_OUTPUT_BASENAME || '';

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
    asOf: view.computedAt === null
      ? new Date(freezeStartedAt).toISOString()
      : new Date(view.computedAt).toISOString(),
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
    warnings: view.warnings,
    description: view.description,
    todayTransits: view.todayTransits,
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
    await sleep(REQUEST_GAP_MS);
  }

  const chokepointPayload = await authedGet('/api/supply-chain/v1/get-chokepoint-status', token, base);
  const chokepoints = {};
  const chokepointErrors = [];
  for (const id of chokepointIds) {
    try {
      const view = chokepointStatusViewModel(chokepointPayload, id, freezeStartedAt);
      chokepoints[id] = chokepointRecord(view);
    } catch (error) {
      chokepointErrors.push({ id, message: error instanceof Error ? error.message : String(error) });
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
        await sleep(REQUEST_GAP_MS);
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
    },
    errors: {
      countries: countryErrors,
      chokepoints: chokepointErrors,
      crises: crisisErrors,
    },
  };

  if (Object.keys(countries).length < 100) {
    throw new Error(
      `Pulse freeze captured only ${Object.keys(countries).length} countries; expected at least 100`,
    );
  }
  if (Object.keys(chokepoints).length < 10) {
    throw new Error(
      `Pulse freeze captured only ${Object.keys(chokepoints).length} chokepoints; expected at least 10`,
    );
  }
  if (Object.keys(crisisSnapshots).length < 4) {
    throw new Error(
      `Pulse freeze captured only ${Object.keys(crisisSnapshots).length} crises; expected 4`,
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
        + `crises=${snapshot.coverage.crisisCount}`,
      );
      if (
        snapshot.coverage.countryErrorCount
        || snapshot.coverage.chokepointErrorCount
        || snapshot.coverage.crisisErrorCount
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
