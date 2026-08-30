#!/usr/bin/env node
// Freeze a resilience ranking with its country score details and identities.
// Writes to docs/snapshots/resilience-ranking-<YYYY-MM-DD>.json.
//
// Usage:
//   API_BASE=https://api.worldmonitor.app node scripts/freeze-resilience-ranking.mjs
//   API_BASE=https://api.worldmonitor.app WORLDMONITOR_API_KEY=... node scripts/freeze-resilience-ranking.mjs
//   API_BASE=https://api.worldmonitor.app WORLDMONITOR_API_KEY=... \
//     RESILIENCE_RANKING_OUTPUT_BASENAME=resilience-ranking-live-post-pr1-YYYY-MM-DD.json \
//     node scripts/freeze-resilience-ranking.mjs
//
// The script reads the API by default or the production Redis snapshots when
// RESILIENCE_RANKING_SOURCE=redis. It adds per-country score details and
// Wikidata identities, then writes a frozen artifact with methodology. Pair with
// tests/resilience-ranking-snapshot.test.mts to regression-verify the ordering
// invariants (monotonic, unique ranks, anchors in expected bands) against any
// frozen snapshot committed into the repo.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execSync } from 'node:child_process';

import { Redis } from '@upstash/redis';

import { loadEnvFile } from './_seed-utils.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const LEGACY_COUNTRY_SNAPSHOT_PATH = path.join(
  REPO_ROOT,
  'docs',
  'snapshots',
  'resilience-ranking-2026-05-28.json',
);
const RESILIENCE_SCORER_PATH = path.join(
  REPO_ROOT,
  'server',
  'worldmonitor',
  'resilience',
  'v1',
  '_dimension-scorers.ts',
);

const API_BASE = (process.env.API_BASE || '').replace(/\/$/, '');
const API_ORIGIN = API_BASE ? new URL(API_BASE).origin : '';
const RANKING_BASE_URL = API_BASE ? `${API_BASE}/api/resilience/v1/get-resilience-ranking` : '';
const SCORE_URL = API_BASE ? `${API_BASE}/api/resilience/v1/get-resilience-score` : '';
const SESSION_URL = API_BASE ? `${API_BASE}/api/wm-session` : '';
const USER_AGENT = process.env.USER_AGENT
  || 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';
const FORCE_RANKING_REFRESH = (process.env.RESILIENCE_RANKING_REFRESH ?? '1').toLowerCase() !== 'false';
const RANKING_URL = API_BASE ? (() => {
  const url = new URL(RANKING_BASE_URL);
  if (FORCE_RANKING_REFRESH) url.searchParams.set('refresh', '1');
  return url.toString();
})() : '';
const METHODOLOGY_FORMULA =
  process.env.RESILIENCE_RANKING_METHODOLOGY_FORMULA || 'pillar-combined-penalized-v1';
const FORMULA_CHECK_COUNTRIES = (process.env.RESILIENCE_RANKING_FORMULA_CHECK_COUNTRIES || 'NO,US,YE')
  .split(',')
  .map((countryCode) => countryCode.trim().toUpperCase())
  .filter((countryCode) => /^[A-Z]{2}$/.test(countryCode));
const FORMULA_SCORE_TOLERANCE = Number(process.env.RESILIENCE_RANKING_FORMULA_TOLERANCE || 0.25);
const OUTPUT_BASENAME = process.env.RESILIENCE_RANKING_OUTPUT_BASENAME || '';
const DETAILS_CONCURRENCY = Number(process.env.RESILIENCE_RANKING_DETAILS_CONCURRENCY || 6);
const CAPTURE_SOURCE = process.env.RESILIENCE_RANKING_SOURCE || 'api';
const WIKIDATA_SPARQL_URL = 'https://query.wikidata.org/sparql';
const HTTP_TIMEOUT_MS = 30_000;
const COMMON_COUNTRY_NAMES = Object.freeze({
  HK: 'Hong Kong',
  LC: 'Saint Lucia',
  MM: 'Myanmar',
  MO: 'Macau',
  TR: 'Turkey',
});
const COUNTRY_REGION_NAMES = new Intl.DisplayNames(['en'], { type: 'region' });

loadEnvFile(import.meta.url, {
  only: [
    'WORLDMONITOR_API_KEY',
    'WM_API_KEY',
    'UPSTASH_REDIS_REST_URL',
    'UPSTASH_REDIS_REST_TOKEN',
  ],
});

function worldMonitorApiKey() {
  return process.env.WM_API_KEY || process.env.WORLDMONITOR_API_KEY || '';
}

const METHODOLOGY_BY_FORMULA = {
  'domain-weighted-6d': {
    overallScoreFormula:
      'sum(domain.score * domain.weight) across 6 domains; weights: economic=0.17, infrastructure=0.15, energy=0.11, social-governance=0.19, health-food=0.13, recovery=0.25 (sum=1.00).',
    notes: [
      'Legacy compensatory formula. Use only for historical snapshots captured before the pillar-combined activation.',
      'Domain scores remain useful diagnostics under both formulas, but this formula lets a strong domain fully offset a weak pillar.',
    ],
  },
  'pillar-combined-penalized-v1': {
    overallScoreFormula:
      'penalizedPillarScore(pillars): sum(pillar.score * pillar.weight) multiplied by (1 - 0.5 * (1 - min_pillar / 100)). Pillar weights: structural-readiness=0.40, live-shock-exposure=0.35, recovery-capacity=0.25.',
    penaltyAlpha: 0.5,
    notes: [
      'Current production formula after the RESILIENCE_PILLAR_COMBINE_ENABLED activation tracked in issue #3954.',
      'Every score is lower than or equal to the equivalent weighted pillar mean because the min-pillar penalty factor is <= 1.',
      'The formula is intentionally non-compensatory: one weak pillar limits the overall score instead of being fully washed out by strong domains.',
    ],
  },
};

if (!METHODOLOGY_BY_FORMULA[METHODOLOGY_FORMULA]) {
  console.error(
    `[freeze-resilience-ranking] unsupported RESILIENCE_RANKING_METHODOLOGY_FORMULA=${METHODOLOGY_FORMULA}`,
  );
  console.error(
    `[freeze-resilience-ranking] expected one of: ${Object.keys(METHODOLOGY_BY_FORMULA).join(', ')}`,
  );
  process.exit(2);
}

if (!Number.isFinite(FORMULA_SCORE_TOLERANCE) || FORMULA_SCORE_TOLERANCE <= 0) {
  console.error(
    `[freeze-resilience-ranking] RESILIENCE_RANKING_FORMULA_TOLERANCE must be a positive number, got ${process.env.RESILIENCE_RANKING_FORMULA_TOLERANCE}`,
  );
  process.exit(2);
}

if (FORMULA_CHECK_COUNTRIES.length === 0) {
  console.error('[freeze-resilience-ranking] RESILIENCE_RANKING_FORMULA_CHECK_COUNTRIES must include at least one ISO-2 country code');
  process.exit(2);
}

function commitSha() {
  try {
    return execSync('git rev-parse HEAD', { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim();
  } catch {
    return 'unknown';
  }
}

function getExportedStringCollection(sourceText, exportName) {
  const declarationRe = new RegExp(
    `export\\s+const\\s+${exportName}\\b[\\s\\S]*?=\\s*(?:new\\s+Set\\s*\\()?\\s*\\[([\\s\\S]*?)\\]\\s*\\)?\\s*;`,
  );
  const match = sourceText.match(declarationRe);
  if (!match) {
    throw new Error(`Could not find exported ${exportName} in ${RESILIENCE_SCORER_PATH}`);
  }

  const arrayBody = match[1]
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
  const values = [...arrayBody.matchAll(/['"]([^'"]+)['"]/g)].map((entry) => entry[1]);
  if (values.length === 0) {
    throw new Error(`${exportName} must contain at least one string literal`);
  }

  return values;
}

export function computeResilienceMethodologyMetadataFromSource(sourceText) {
  const domainOrder = getExportedStringCollection(sourceText, 'RESILIENCE_DOMAIN_ORDER');
  const dimensionOrder = getExportedStringCollection(sourceText, 'RESILIENCE_DIMENSION_ORDER');
  const retiredDimensions = new Set(getExportedStringCollection(sourceText, 'RESILIENCE_RETIRED_DIMENSIONS'));
  const activeDimensionCount = dimensionOrder.filter((dimensionId) => !retiredDimensions.has(dimensionId)).length;

  if (activeDimensionCount <= 0) {
    throw new Error(`Derived invalid active dimension count: ${activeDimensionCount}`);
  }

  return {
    domainCount: domainOrder.length,
    serializedDimensionCount: dimensionOrder.length,
    retiredDimensionCount: retiredDimensions.size,
    activeDimensionCount,
  };
}

async function loadResilienceMethodologyMetadata() {
  const sourceText = await fs.readFile(RESILIENCE_SCORER_PATH, 'utf8');
  return computeResilienceMethodologyMetadataFromSource(sourceText);
}

let resilienceCacheKeysPromise;
function loadResilienceCacheKeys() {
  resilienceCacheKeysPromise ||= fs.readFile(
    path.join(REPO_ROOT, 'server', 'worldmonitor', 'resilience', 'v1', '_shared.ts'),
    'utf8',
  ).then((sourceText) => {
    function exportedString(name) {
      const match = sourceText.match(new RegExp(`export\\s+const\\s+${name}\\s*=\\s*['\"]([^'\"]+)['\"]`));
      if (!match) throw new Error(`Could not read ${name} from resilience _shared.ts`);
      return match[1];
    }
    return {
      ranking: exportedString('RESILIENCE_RANKING_CACHE_KEY'),
      scorePrefix: exportedString('RESILIENCE_SCORE_CACHE_PREFIX'),
    };
  });
  return resilienceCacheKeysPromise;
}

let redisClient;
function getRedisClient() {
  if (redisClient) return redisClient;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error('UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are required');
  redisClient = new Redis({
    url,
    token,
    signal: () => AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  return redisClient;
}

async function readRedisJson(key) {
  const value = await getRedisClient().get(key);
  if (value == null) throw new Error(`Redis key ${key} is missing`);
  if (value && typeof value === 'object' && '_seed' in value && 'data' in value) return value.data;
  return value;
}

export function buildSnapshotMethodology(methodologyConfig, methodologyMetadata) {
  return {
    ...methodologyConfig,
    domainCount: methodologyMetadata.domainCount,
    dimensionCount: methodologyMetadata.activeDimensionCount,
    pillarCount: 3,
    coverageLabel:
      `Mean dimension coverage (avg of the ${methodologyMetadata.activeDimensionCount} per-dimension coverage values). Labelled 'Dimension coverage' in publications to avoid the ambiguity of 'Data coverage'.`,
    greyOutThreshold: 0.40,
  };
}

async function loadCountryNameMap() {
  const raw = await fs.readFile(path.join(REPO_ROOT, 'shared', 'country-names.json'), 'utf8');
  const forward = JSON.parse(raw);
  // forward: { "albania": "AL", ... }. Build reverse: { "AL": "Albania" }.
  // When multiple names map to the same ISO-2 (e.g. "bahamas" + "bahamas the"),
  // keep the first-seen name because the file is roughly in preferred-label order.
  const reverse = {};
  for (const [name, iso2] of Object.entries(forward)) {
    const code = String(iso2 || '').toUpperCase();
    if (!/^[A-Z]{2}$/.test(code)) continue;
    if (reverse[code]) continue;
    reverse[code] = name.replace(/\b([a-z])/g, (_, c) => c.toUpperCase());
  }
  return reverse;
}

async function loadLegacyCountryNames() {
  const snapshot = JSON.parse(await fs.readFile(LEGACY_COUNTRY_SNAPSHOT_PATH, 'utf8'));
  return new Map(
    [...(snapshot.items || []), ...(snapshot.greyedOut || [])]
      .map((country) => [String(country.countryCode || '').toUpperCase(), country.countryName])
      .filter(([code, name]) => /^[A-Z]{2}$/.test(code) && typeof name === 'string' && name),
  );
}

function wikidataIdentityQuery() {
  return `SELECT ?country ?code ?countryLabel ?officialName ?officialNameRank WHERE {
  ?country wdt:P297 ?code.
  FILTER(STRLEN(?code) = 2)
  OPTIONAL {
    ?country p:P1448 ?officialNameStatement.
    ?officialNameStatement ps:P1448 ?officialName;
      wikibase:rank ?officialNameRank.
    OPTIONAL { ?officialNameStatement pq:P580 ?officialNameStart. }
    OPTIONAL { ?officialNameStatement pq:P582 ?officialNameEnd. }
    FILTER(LANG(?officialName) = "en")
    FILTER(?officialNameRank != wikibase:DeprecatedRank)
    FILTER(!BOUND(?officialNameStart) || ?officialNameStart <= NOW())
    FILTER(!BOUND(?officialNameEnd) || ?officialNameEnd > NOW())
  }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}`;
}

export function selectWikidataIdentities(countryCodes, bindings) {
  const requested = new Set(countryCodes);
  const candidates = new Map();
  for (const binding of bindings || []) {
    const code = String(binding?.code?.value || '').toUpperCase();
    const entity = String(binding?.country?.value || '');
    const qid = entity.match(/\/entity\/(Q\d+)$/)?.[1];
    const commonName = String(binding?.countryLabel?.value || '').trim();
    if (!requested.has(code) || !qid || !commonName) continue;
    const identity = {
      commonName,
      officialName: String(binding?.officialName?.value || commonName).trim(),
      officialNameRank: String(binding?.officialNameRank?.value || ''),
      sameAs: `https://www.wikidata.org/wiki/${qid}`,
    };
    candidates.set(code, [...(candidates.get(code) || []), identity]);
  }
  const identities = new Map();
  for (const [code, values] of candidates) {
    const expected = COUNTRY_REGION_NAMES.of(code)?.toLocaleLowerCase('en-US');
    values.sort((left, right) => {
      const leftExact = left.commonName.toLocaleLowerCase('en-US') === expected;
      const rightExact = right.commonName.toLocaleLowerCase('en-US') === expected;
      if (leftExact !== rightExact) return leftExact ? -1 : 1;
      const leftPreferred = left.officialNameRank.endsWith('#PreferredRank');
      const rightPreferred = right.officialNameRank.endsWith('#PreferredRank');
      if (leftPreferred !== rightPreferred) return leftPreferred ? -1 : 1;
      return left.commonName.length - right.commonName.length
        || left.commonName.localeCompare(right.commonName)
        || right.officialName.length - left.officialName.length
        || (left.officialName < right.officialName ? -1 : left.officialName > right.officialName ? 1 : 0)
        || left.sameAs.localeCompare(right.sameAs);
    });
    const { officialNameRank: _officialNameRank, ...identity } = values[0];
    identities.set(code, identity);
  }
  const missing = countryCodes.filter((code) => !identities.has(code));
  if (missing.length > 0) {
    throw new Error(`Wikidata P297 identities missing for: ${missing.join(', ')}`);
  }
  return identities;
}

async function fetchWikidataIdentities(countryCodes) {
  const url = new URL(WIKIDATA_SPARQL_URL);
  url.searchParams.set('format', 'json');
  url.searchParams.set('query', wikidataIdentityQuery());
  const response = await fetch(url, {
    headers: {
      Accept: 'application/sparql-results+json',
      'User-Agent': 'WorldMonitor-CorpusSnapshot/1.0 (https://www.worldmonitor.app/sources/)',
    },
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${WIKIDATA_SPARQL_URL}`);
  }
  const payload = await response.json();
  return selectWikidataIdentities(countryCodes, payload?.results?.bindings);
}

function normalizeCountryIdentity(code, identity, legacyName, fallbackName) {
  const commonName = COMMON_COUNTRY_NAMES[code]
    || COUNTRY_REGION_NAMES.of(code)
    || identity?.commonName
    || fallbackName
    || code;
  const officialName = identity?.officialName || identity?.commonName || commonName;
  const legacyNames = legacyName && legacyName !== commonName ? [legacyName] : [];
  const alternateNames = [...new Set([legacyName, identity?.commonName, officialName]
    .filter((name) => name && name !== commonName))];
  return {
    commonName,
    officialName,
    alternateNames,
    legacyNames,
    sameAs: identity?.sameAs || '',
  };
}

function baseHeaders() {
  return {
    accept: 'application/json, text/plain, */*',
    'accept-language': 'en-US,en;q=0.9',
    'cache-control': 'no-cache',
    origin: API_ORIGIN,
    referer: `${API_ORIGIN}/`,
    'user-agent': USER_AGENT,
  };
}

function readSetCookies(headers) {
  if (typeof headers.getSetCookie === 'function') return headers.getSetCookie();
  const cookie = headers.get('set-cookie');
  return cookie ? [cookie] : [];
}

async function mintSessionCookie() {
  const response = await fetch(SESSION_URL, {
    method: 'POST',
    headers: {
      ...baseHeaders(),
      'content-type': 'application/json',
    },
    body: '{}',
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${SESSION_URL}: ${await response.text().catch(() => '')}`);
  }

  const sessionCookie = readSetCookies(response.headers)
    .map((cookie) => cookie.match(/(?:^|,\s*)(wm-session=[^;]+)/)?.[1])
    .find(Boolean);
  if (!sessionCookie) throw new Error(`No wm-session cookie returned by ${SESSION_URL}`);
  return sessionCookie;
}

async function buildAuthHeaders() {
  const headers = baseHeaders();
  const apiKey = worldMonitorApiKey();
  if (apiKey) {
    headers['X-WorldMonitor-Key'] = apiKey;
  } else {
    headers.cookie = await mintSessionCookie();
  }
  return headers;
}

async function fetchJson(url, headers) {
  const response = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    const credentialHint = response.status === 401 && SCORE_URL && url.startsWith(SCORE_URL) && !worldMonitorApiKey()
      ? ' Set WM_API_KEY or WORLDMONITOR_API_KEY to a Pro/API key; post-flip ranking snapshots must verify score anchors through get-resilience-score and cannot be captured from an unauthenticated shell.'
      : '';
    throw new Error(`HTTP ${response.status} from ${url}: ${body}${credentialHint}`);
  }
  return response.json();
}

async function fetchRanking(headers) {
  if (CAPTURE_SOURCE === 'redis') {
    const keys = await loadResilienceCacheKeys();
    return readRedisJson(keys.ranking);
  }
  return fetchJson(RANKING_URL, headers);
}

async function fetchScore(countryCode, headers) {
  if (CAPTURE_SOURCE === 'redis') {
    const keys = await loadResilienceCacheKeys();
    return readRedisJson(`${keys.scorePrefix}${countryCode}`);
  }
  const url = new URL(SCORE_URL);
  url.searchParams.set('countryCode', countryCode);
  return fetchJson(url.toString(), headers);
}

function finiteOptionalNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function normalizeDimension(dimension, countryCode, domainId) {
  const id = String(dimension?.id || '');
  if (!id) throw new Error(`${countryCode}.${domainId} has a dimension without an id`);
  return {
    id,
    score: finiteNumber(dimension?.score, `${countryCode}.${domainId}.${id}.score`),
    coverage: finiteNumber(dimension?.coverage, `${countryCode}.${domainId}.${id}.coverage`),
    imputationClass: String(dimension?.imputationClass || ''),
    freshness: {
      lastObservedAtMs: String(dimension?.freshness?.lastObservedAtMs || ''),
      staleness: String(dimension?.freshness?.staleness || ''),
    },
  };
}

function normalizeCountryDetails(score, countryCode) {
  const domains = (score?.domains || []).map((domain) => {
    const id = String(domain?.id || '');
    if (!id) throw new Error(`${countryCode} has a domain without an id`);
    if (!Array.isArray(domain?.dimensions) || domain.dimensions.length === 0) {
      throw new Error(`${countryCode}.${id} must include dimensions`);
    }
    return {
      id,
      score: finiteNumber(domain?.score, `${countryCode}.${id}.score`),
      weight: finiteNumber(domain?.weight, `${countryCode}.${id}.weight`),
      dimensions: (domain?.dimensions || []).map(
        (dimension) => normalizeDimension(dimension, countryCode, id),
      ),
    };
  });
  const pillars = (score?.pillars || []).map((pillar) => {
    const id = String(pillar?.id || '');
    if (!id) throw new Error(`${countryCode} has a pillar without an id`);
    return {
      id,
      score: finiteNumber(pillar?.score, `${countryCode}.${id}.score`),
      weight: finiteNumber(pillar?.weight, `${countryCode}.${id}.weight`),
      coverage: finiteNumber(pillar?.coverage, `${countryCode}.${id}.coverage`),
      domainIds: (pillar?.domains || []).map((domain) => String(domain?.id || '')).filter(Boolean),
    };
  });
  if (domains.length === 0 || pillars.length === 0) {
    throw new Error(`${countryCode} score details must include domains and pillars`);
  }
  return {
    overallScore: finiteNumber(score?.overallScore, `${countryCode}.overallScore`),
    baselineScore: finiteOptionalNumber(score?.baselineScore),
    stressScore: finiteOptionalNumber(score?.stressScore),
    stressFactor: finiteOptionalNumber(score?.stressFactor),
    trend: String(score?.trend || 'unknown'),
    change30d: finiteNumber(score?.change30d, `${countryCode}.change30d`),
    imputationShare: finiteOptionalNumber(score?.imputationShare),
    dataVersion: String(score?.dataVersion || ''),
    schemaVersion: String(score?.schemaVersion || ''),
    domains,
    pillars,
  };
}

async function mapWithConcurrency(values, concurrency, operation) {
  const results = new Array(values.length);
  let cursor = 0;
  async function worker() {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await operation(values[index], index);
    }
  }
  await Promise.all(Array.from(
    { length: Math.min(concurrency, values.length) },
    () => worker(),
  ));
  return results;
}

async function fetchCountryDetails(countryCodes, headers) {
  if (!Number.isInteger(DETAILS_CONCURRENCY) || DETAILS_CONCURRENCY < 1 || DETAILS_CONCURRENCY > 12) {
    throw new Error(`RESILIENCE_RANKING_DETAILS_CONCURRENCY must be an integer from 1 to 12, got ${DETAILS_CONCURRENCY}`);
  }
  const details = await mapWithConcurrency(
    countryCodes,
    DETAILS_CONCURRENCY,
    async (countryCode) => normalizeCountryDetails(await fetchScore(countryCode, headers), countryCode),
  );
  return new Map(countryCodes.map((countryCode, index) => [countryCode, details[index]]));
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function finiteNumber(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number`);
  }
  return value;
}

function weightedScore(parts, label) {
  if (!Array.isArray(parts) || parts.length === 0) {
    throw new Error(`${label} must be a non-empty array`);
  }
  return round2(parts.reduce((sum, part, index) => {
    const score = finiteNumber(part?.score, `${label}[${index}].score`);
    const weight = finiteNumber(part?.weight, `${label}[${index}].weight`);
    return sum + score * weight;
  }, 0));
}

function pillarCombinedScore(pillars) {
  if (!Array.isArray(pillars) || pillars.length === 0) {
    throw new Error('pillars must be a non-empty array for pillar-combined verification');
  }
  const weighted = pillars.reduce((sum, pillar, index) => {
    const score = finiteNumber(pillar?.score, `pillars[${index}].score`);
    const weight = finiteNumber(pillar?.weight, `pillars[${index}].weight`);
    return sum + score * weight;
  }, 0);
  const minScore = Math.min(...pillars.map((pillar, index) => finiteNumber(pillar?.score, `pillars[${index}].score`)));
  const penalty = 1 - 0.5 * (1 - minScore / 100);
  return round2(weighted * penalty);
}

function computeFormulaScores(scorePayload, countryCode) {
  const observedOverallScore = finiteNumber(scorePayload?.overallScore, `${countryCode}.overallScore`);
  const domainWeightedScore = weightedScore(scorePayload?.domains, `${countryCode}.domains`);
  const pillarScore = pillarCombinedScore(scorePayload?.pillars);
  return { observedOverallScore, domainWeightedScore, pillarCombinedScore: pillarScore };
}

async function verifyDeclaredFormula(headers) {
  const checks = await Promise.all(FORMULA_CHECK_COUNTRIES.map(async (countryCode) => {
    const scorePayload = await fetchScore(countryCode, headers);
    const scores = computeFormulaScores(scorePayload, countryCode);
    const declaredFormulaScore = METHODOLOGY_FORMULA === 'pillar-combined-penalized-v1'
      ? scores.pillarCombinedScore
      : scores.domainWeightedScore;
    const alternateFormulaScore = METHODOLOGY_FORMULA === 'pillar-combined-penalized-v1'
      ? scores.domainWeightedScore
      : scores.pillarCombinedScore;
    const absoluteError = round2(Math.abs(scores.observedOverallScore - declaredFormulaScore));
    const alternateAbsoluteError = round2(Math.abs(scores.observedOverallScore - alternateFormulaScore));

    return {
      countryCode,
      observedOverallScore: scores.observedOverallScore,
      declaredFormulaScore,
      alternateFormulaScore,
      absoluteError,
      alternateAbsoluteError,
    };
  }));

  for (const check of checks) {
    if (check.absoluteError > FORMULA_SCORE_TOLERANCE) {
      throw new Error(
        `${check.countryCode} overallScore=${check.observedOverallScore} does not match declared ${METHODOLOGY_FORMULA} score=${check.declaredFormulaScore} within tolerance=${FORMULA_SCORE_TOLERANCE} (alternate=${check.alternateFormulaScore})`,
      );
    }
  }

  if (!checks.some((check) => check.alternateAbsoluteError > FORMULA_SCORE_TOLERANCE)) {
    throw new Error(
      `Formula verification is inconclusive: checked ${FORMULA_CHECK_COUNTRIES.join(',')} but no alternate formula differed by more than tolerance=${FORMULA_SCORE_TOLERANCE}`,
    );
  }

  console.log(
    `[freeze-resilience-ranking] verified ${METHODOLOGY_FORMULA} via score anchors: ${checks.map((check) => `${check.countryCode}=${check.observedOverallScore}`).join(' ')}`,
  );
  return {
    declaredFormula: METHODOLOGY_FORMULA,
    scoreEndpoint: CAPTURE_SOURCE === 'redis' ? 'Production Upstash Redis score cache' : SCORE_URL,
    tolerance: FORMULA_SCORE_TOLERANCE,
    checks,
  };
}

function attachRankingVerification(ranking, formulaVerification) {
  const rankingItems = [
    ...(Array.isArray(ranking.items) ? ranking.items : []),
    ...(Array.isArray(ranking.greyedOut) ? ranking.greyedOut : []),
  ];
  const rankingByCountry = new Map(rankingItems.map((item) => [item.countryCode, item]));

  return {
    ...formulaVerification,
    rankingEndpoint: CAPTURE_SOURCE === 'redis' ? 'Production Upstash Redis ranking cache' : RANKING_URL,
    checks: formulaVerification.checks.map((check) => {
      const rankingItem = rankingByCountry.get(check.countryCode);
      if (!rankingItem) {
        throw new Error(`${check.countryCode} was checked against the score endpoint but is absent from the ranking payload`);
      }
      const rankingScore = finiteNumber(rankingItem.overallScore, `${check.countryCode}.ranking.overallScore`);
      const rankingAbsoluteError = round2(Math.abs(rankingScore - check.observedOverallScore));
      if (rankingAbsoluteError > FORMULA_SCORE_TOLERANCE) {
        throw new Error(
          `${check.countryCode} ranking score=${rankingScore} differs from score endpoint overallScore=${check.observedOverallScore} by ${rankingAbsoluteError}, exceeding tolerance=${FORMULA_SCORE_TOLERANCE}`,
        );
      }
      return {
        ...check,
        rankingScore,
        rankingAbsoluteError,
      };
    }),
  };
}

function enrichItems(
  items,
  { nameMap, identities, legacyNames, detailsByCode },
  startRank,
) {
  return items.map((item, index) => {
    const countryCode = String(item.countryCode || '').toUpperCase();
    const details = detailsByCode.get(countryCode);
    if (!details) throw new Error(`Score details missing for ${countryCode}`);
    const identity = normalizeCountryIdentity(
      countryCode,
      identities.get(countryCode),
      legacyNames.get(countryCode),
      nameMap[countryCode],
    );
    const rankingScore = finiteOptionalNumber(item.overallScore) ?? details.overallScore;
    if (Math.abs(rankingScore - details.overallScore) > FORMULA_SCORE_TOLERANCE) {
      throw new Error(
        `${countryCode} ranking score=${rankingScore} differs from score details=${details.overallScore}`,
      );
    }
    return {
      rank: startRank == null ? null : startRank + index,
      countryCode,
      countryName: identity.commonName,
      identity,
      overallScore: round1(rankingScore),
      overallScoreRaw: rankingScore,
      level: item.level || 'unclassified',
      lowConfidence: Boolean(item.lowConfidence),
      dimensionCoverage: Math.round((item.overallCoverage ?? 0) * 100) / 100,
      headlineEligible: Boolean(item.headlineEligible),
      rankStable: Boolean(item.rankStable),
      baselineScore: details.baselineScore,
      stressScore: details.stressScore,
      stressFactor: details.stressFactor,
      trend: details.trend,
      change30d: details.change30d,
      imputationShare: details.imputationShare,
      dataVersion: details.dataVersion,
      scoreSchemaVersion: details.schemaVersion,
      domains: details.domains,
      pillars: details.pillars,
    };
  });
}

function resolveRankingSnapshotOutputPath(capturedAt, outputBasename = OUTPUT_BASENAME) {
  const basename = outputBasename || `resilience-ranking-${capturedAt}.json`;
  if (/[\\/]/.test(basename)) {
    throw new Error(`RESILIENCE_RANKING_OUTPUT_BASENAME must be a filename only, got ${basename}`);
  }
  const match =
    /^resilience-ranking-(\d{4}-\d{2}-\d{2})\.json$/.exec(basename) ||
    /^resilience-ranking-live-post-pr1-(\d{4}-\d{2}-\d{2})\.json$/.exec(basename);
  if (!match) {
    throw new Error(
      `RESILIENCE_RANKING_OUTPUT_BASENAME must match resilience-ranking-YYYY-MM-DD.json or resilience-ranking-live-post-pr1-YYYY-MM-DD.json, got ${basename}`,
    );
  }
  if (match[1] !== capturedAt) {
    throw new Error(
      `RESILIENCE_RANKING_OUTPUT_BASENAME date ${match[1]} must match capturedAt ${capturedAt}`,
    );
  }
  return path.join(REPO_ROOT, 'docs', 'snapshots', basename);
}

async function main() {
  if (!['api', 'redis'].includes(CAPTURE_SOURCE)) {
    console.error('[freeze-resilience-ranking] RESILIENCE_RANKING_SOURCE must be api or redis');
    process.exit(2);
  }
  if (CAPTURE_SOURCE === 'api' && !API_BASE) {
    console.error('[freeze-resilience-ranking] API_BASE env var required (e.g. https://api.worldmonitor.app)');
    process.exit(2);
  }
  if (CAPTURE_SOURCE === 'api' && FORCE_RANKING_REFRESH && !worldMonitorApiKey()) {
    console.error(
      '[freeze-resilience-ranking] WM_API_KEY or WORLDMONITOR_API_KEY is required when RESILIENCE_RANKING_REFRESH is enabled; set RESILIENCE_RANKING_REFRESH=false to capture the cached public ranking instead',
    );
    process.exit(2);
  }

  const nameMap = await loadCountryNameMap();
  const methodologyMetadata = await loadResilienceMethodologyMetadata();
  const headers = CAPTURE_SOURCE === 'api' ? await buildAuthHeaders() : {};
  const formulaCheck = await verifyDeclaredFormula(headers);
  const ranking = await fetchRanking(headers);
  const formulaVerification = attachRankingVerification(ranking, formulaCheck);

  const items = Array.isArray(ranking.items) ? ranking.items : [];
  const greyedOut = Array.isArray(ranking.greyedOut) ? ranking.greyedOut : [];
  const countryCodes = [...items, ...greyedOut].map((item) => String(item.countryCode || '').toUpperCase());
  if (new Set(countryCodes).size !== countryCodes.length) {
    throw new Error('Ranking payload contains duplicate country codes');
  }
  const legacyNames = await loadLegacyCountryNames();
  const [identities, detailsByCode] = await Promise.all([
    fetchWikidataIdentities(countryCodes),
    fetchCountryDetails(countryCodes, headers),
  ]);
  const enrichment = { nameMap, identities, legacyNames, detailsByCode };
  const ranked = enrichItems(items, enrichment, 1);
  const unranked = enrichItems(greyedOut, enrichment, null);
  const capturedAt = new Date().toISOString().slice(0, 10);

  const snapshot = {
    capturedAt,
    source: CAPTURE_SOURCE === 'redis'
      ? 'Production Upstash Redis resilience ranking snapshot'
      : `Live capture via ${RANKING_URL}`,
    snapshotNote: METHODOLOGY_FORMULA === 'pillar-combined-penalized-v1'
      ? `Post-P1-1 full-universe capture: pillar scores applied domain design weights inside pillar aggregation on ${capturedAt}.`
      : `Historical full-universe capture using the ${METHODOLOGY_FORMULA} formula on ${capturedAt}.`,
    detailSource: CAPTURE_SOURCE === 'redis'
      ? 'Production Upstash Redis per-country resilience score snapshots'
      : SCORE_URL,
    identitySource: {
      name: 'Wikidata P297 country identity',
      url: WIKIDATA_SPARQL_URL,
      license: 'CC0 1.0',
    },
    commitSha: commitSha(),
    schemaVersion: '2.0',
    methodologyFormula: METHODOLOGY_FORMULA,
    formulaVerification,
    methodology: buildSnapshotMethodology(
      METHODOLOGY_BY_FORMULA[METHODOLOGY_FORMULA],
      methodologyMetadata,
    ),
    totals: {
      rankedCountries: ranked.length,
      greyedOutCount: unranked.length,
    },
    items: ranked,
    greyedOut: unranked,
  };

  const outPath = resolveRankingSnapshotOutputPath(capturedAt);
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
  console.log(`[freeze-resilience-ranking] wrote ${outPath}`);
  console.log(`[freeze-resilience-ranking] items=${ranked.length} greyedOut=${unranked.length} commit=${snapshot.commitSha.slice(0, 10)}`);
}

export {
  resolveRankingSnapshotOutputPath,
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('[freeze-resilience-ranking] failed:', err);
    process.exit(1);
  });
}
