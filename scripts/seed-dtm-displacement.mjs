#!/usr/bin/env node
// Internal displacement by first-level region from IOM's Displacement Tracking
// Matrix (DTM API v3). DTM publishes survey rounds per operation, so each
// operation keeps only its latest round. Operations in the same country
// overlap (DRC countrywide monitoring also covers Ituri), so totals are never
// summed across operations.

import { loadEnvFile, CHROME_UA, runSeed, withRetry } from './_seed-utils.mjs';
import { DAY_MIN, tokensToContentMeta } from './_content-age-helpers.mjs';
import { getOptionalUpstashCreds, upstashCommand } from './_upstash-rest.mjs';
import admin1Points from './data/dtm-admin1-points.json' with { type: 'json' };
import iso3ToIso2 from './shared/iso3-to-iso2.json' with { type: 'json' };

loadEnvFile(import.meta.url);

export const DTM_CANONICAL_KEY = 'displacement:dtm:v1';
export const DTM_ACTIVATION_KEY = 'seed-activated:displacement:dtm';
const DTM_API = 'https://dtmapi.iom.int/v3/displacement';
const CACHE_TTL_SECONDS = 3 * 24 * 60 * 60;
const LOOKBACK_MONTHS = 18;
const FETCH_CONCURRENCY = 4;
const REQUEST_TIMEOUT_MS = 30_000;
export const MAX_FLOWS_PER_OPERATION = 30;
export const MIN_OPERATIONS = 15;

function nonRetryable(message) {
  const err = new Error(message);
  err.nonRetryable = true;
  return err;
}

async function dtmGet(path, apiKey) {
  return withRetry(async () => {
    const resp = await fetch(`${DTM_API}/${path}`, {
      headers: { 'Ocp-Apim-Subscription-Key': apiKey, Accept: 'application/json', 'User-Agent': CHROME_UA },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (resp.status === 401 || resp.status === 403) throw nonRetryable(`DTM ${path}: HTTP ${resp.status} (check DTM_API_KEY)`);
    if (!resp.ok) throw new Error(`DTM ${path}: HTTP ${resp.status}`);
    const body = await resp.json();
    // DTM answers 200 with isSuccess=false for a bad query, and isSuccess=true
    // with an empty result when a country has no rounds in the window.
    if (body?.isSuccess !== true) throw nonRetryable(`DTM ${path}: ${(body?.errorMessages ?? []).join('; ') || 'isSuccess=false'}`);
    const result = Array.isArray(body.result) ? body.result : [];
    const total = Number(body.totalRecordsCount);
    if (Number.isFinite(total) && total > result.length) throw nonRetryable(`DTM ${path}: truncated, ${result.length} of ${total} rows`);
    return result;
  }, 2, 2000);
}

// DTM mostly uses OCHA P-codes (SD11), but some operations prefix the ISO3
// code instead of ISO2 (COD54 for CD54, NGA026 for NG026) or pad the region
// number to three digits (BJ002 for BJ02). Returns the OCHA form, so aliases of
// one region share a key. Regions whose code is not in the COD points
// (Burundi's pre-2025 provinces) have no canonical form and stay unplaced.
export function canonicalPcode(pcode, points = admin1Points) {
  if (!pcode) return null;
  if (points[pcode]) return pcode;
  const match = /^([A-Z]{2,3})(\d+)$/.exec(pcode);
  const iso2 = match && (match[1].length === 2 ? match[1] : iso3ToIso2[match[1]]);
  if (!iso2) return null;
  for (const digits of [match[2], match[2].replace(/^0/, ''), match[2].padStart(3, '0')]) {
    if (points[iso2 + digits]) return iso2 + digits;
  }
  return null;
}

export function resolveAdmin1Point(pcode, points = admin1Points) {
  const canonical = canonicalPcode(pcode, points);
  return canonical ? points[canonical] : null;
}

const toLocation = (point) => (point ? { latitude: point[0], longitude: point[1] } : undefined);
const isKnownPcode = (pcode) => typeof pcode === 'string' && /^[A-Z]{2,3}\d+$/.test(pcode);

function normalizeReason(reason) {
  const text = String(reason ?? '').trim();
  if (!text || /^no (reason for )?displacement/i.test(text)) return 'Not reported';
  return text.charAt(0).toUpperCase() + text.slice(1).toLowerCase();
}

/** Builds one snapshot per DTM operation from admin-1 rows of any number of countries. */
export function buildOperations(rows, { points = admin1Points } = {}) {
  const latestByOperation = new Map();
  for (const row of rows) {
    const date = String(row?.reportingDate ?? '').slice(0, 10);
    if (!row?.admin0Pcode || !row?.operation || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const key = `${row.admin0Pcode}\u0000${row.operation}`;
    if (!latestByOperation.has(key) || date > latestByOperation.get(key)) latestByOperation.set(key, date);
  }

  const operations = new Map();
  for (const row of rows) {
    const date = String(row?.reportingDate ?? '').slice(0, 10);
    const key = `${row?.admin0Pcode}\u0000${row?.operation}`;
    if (latestByOperation.get(key) !== date) continue;
    const idps = Number(row.numPresentIdpInd);
    if (!Number.isFinite(idps) || idps <= 0) continue;

    let op = operations.get(key);
    if (!op) {
      op = {
        countryCode: row.admin0Pcode,
        countryName: row.admin0Name || row.admin0Pcode,
        operation: row.operation,
        reportingDate: date,
        roundNumber: Number(row.roundNumber) || 0,
        totalIdps: 0,
        reasons: new Map(),
        regions: new Map(),
        flows: new Map(),
      };
      operations.set(key, op);
    }
    op.totalIdps += idps;
    op.roundNumber = Math.max(op.roundNumber, Number(row.roundNumber) || 0);
    const reason = normalizeReason(row.displacementReason);
    op.reasons.set(reason, (op.reasons.get(reason) ?? 0) + idps);

    const canonical = (pcode) => canonicalPcode(pcode, points) ?? pcode;
    const regionKey = isKnownPcode(row.admin1Pcode) ? canonical(row.admin1Pcode) : '';
    const region = op.regions.get(regionKey) ?? { pcode: regionKey, name: regionKey ? (row.admin1Name || regionKey) : 'Not specified', idps: 0 };
    region.idps += idps;
    op.regions.set(regionKey, region);

    const origin = isKnownPcode(row.idpOriginAdmin1Pcode) ? canonical(row.idpOriginAdmin1Pcode) : '';
    if (regionKey && origin && origin !== regionKey) {
      const flowKey = `${origin}>${regionKey}`;
      const flow = op.flows.get(flowKey) ?? {
        originPcode: origin,
        originName: row.idpOriginAdmin1Name || origin,
        destinationPcode: regionKey,
        destinationName: row.admin1Name || regionKey,
        idps: 0,
      };
      flow.idps += idps;
      op.flows.set(flowKey, flow);
    }
  }

  const byIdpsDesc = (a, b) => b.idps - a.idps;
  return [...operations.values()]
    .map((op) => ({
      countryCode: op.countryCode,
      countryName: op.countryName,
      operation: op.operation,
      reportingDate: op.reportingDate,
      roundNumber: op.roundNumber,
      totalIdps: op.totalIdps,
      reasons: [...op.reasons].map(([reason, idps]) => ({ reason, idps })).sort(byIdpsDesc),
      regions: [...op.regions.values()].sort(byIdpsDesc).map((region) => ({
        ...region,
        location: toLocation(resolveAdmin1Point(region.pcode, points)),
      })),
      flows: [...op.flows.values()].sort(byIdpsDesc).slice(0, MAX_FLOWS_PER_OPERATION).map((flow) => ({
        ...flow,
        originLocation: toLocation(resolveAdmin1Point(flow.originPcode, points)),
        destinationLocation: toLocation(resolveAdmin1Point(flow.destinationPcode, points)),
      })),
    }))
    .sort((a, b) => b.totalIdps - a.totalIdps);
}

function lookbackStart(nowMs) {
  const date = new Date(nowMs);
  date.setUTCMonth(date.getUTCMonth() - LOOKBACK_MONTHS, 1);
  return date.toISOString().slice(0, 10);
}

export async function fetchDtmDisplacement({ apiKey = process.env.DTM_API_KEY, nowMs = Date.now() } = {}) {
  if (!apiKey) throw new Error('DTM_API_KEY is not set');
  const countries = await dtmGet('country-list', apiKey);
  const pcodes = [...new Set(countries.map((c) => c?.admin0Pcode).filter((p) => /^[A-Z]{3}$/.test(p ?? '')))];
  if (pcodes.length === 0) throw new Error('DTM country-list returned no countries');

  const from = lookbackStart(nowMs);
  const rows = [];
  const queue = [...pcodes];
  await Promise.all(Array.from({ length: FETCH_CONCURRENCY }, async () => {
    while (queue.length > 0) {
      const pcode = queue.shift();
      rows.push(...await dtmGet(`admin1?Admin0Pcode=${pcode}&FromReportingDate=${from}`, apiKey));
    }
  }));

  const operations = buildOperations(rows);
  console.log(`  DTM: ${pcodes.length} countries, ${rows.length} rows, ${operations.length} operations since ${from}`);
  return { source: 'IOM DTM', lookbackFrom: from, operations };
}

export function validate(data) {
  return Array.isArray(data?.operations) && data.operations.length >= MIN_OPERATIONS;
}

export function declareRecords(data) {
  return data?.operations?.length ?? 0;
}

export function contentMeta(data, nowMs = Date.now()) {
  return tokensToContentMeta((data?.operations ?? []).map((op) => op.reportingDate), nowMs);
}

// Durable marker for /api/health, written only after a successful publish.
// A failed write costs one more cycle of on-demand softening, never a run.
async function markActivated() {
  try {
    const creds = getOptionalUpstashCreds();
    if (!creds) return;
    await upstashCommand(creds, ['SET', DTM_ACTIVATION_KEY, '1']);
  } catch (err) {
    console.warn(`  WARN: DTM activation marker write failed: ${err?.message || err}`);
  }
}

export const seedOptions = {
  validateFn: validate,
  ttlSeconds: CACHE_TTL_SECONDS,
  sourceVersion: 'iom-dtm-v3',
  declareRecords,
  contentMeta,
  schemaVersion: 1,
  maxStaleMin: 2880, // daily health-bundle tick; 48h = two missed ticks
  // DTM rounds are monthly at best; the newest round across all operations
  // is normally under a month old.
  maxContentAgeMin: 90 * DAY_MIN,
  emptyDataIsFailure: true,
  afterPublish: markActivated,
};

if (process.argv[1]?.endsWith('seed-dtm-displacement.mjs')) {
  runSeed('displacement', 'dtm', DTM_CANONICAL_KEY, () => fetchDtmDisplacement(), seedOptions).catch((err) => {
    const cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : '';
    console.error('FATAL:', (err.message || err) + cause);
    process.exit(1);
  });
}
