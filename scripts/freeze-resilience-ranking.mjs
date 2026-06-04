#!/usr/bin/env node
// Freeze a live snapshot of the resilience ranking for regression-verification
// of published figures. Writes to docs/snapshots/resilience-ranking-<YYYY-MM-DD>.json.
//
// Usage:
//   API_BASE=https://api.worldmonitor.app node scripts/freeze-resilience-ranking.mjs
//   API_BASE=https://api.worldmonitor.app WORLDMONITOR_API_KEY=... node scripts/freeze-resilience-ranking.mjs
//   API_BASE=https://api.worldmonitor.app WORLDMONITOR_API_KEY=... \
//     RESILIENCE_RANKING_OUTPUT_BASENAME=resilience-ranking-live-post-pr1-YYYY-MM-DD.json \
//     node scripts/freeze-resilience-ranking.mjs
//
// The script hits GET /api/resilience/v1/get-resilience-ranking, enriches each
// item with the country name (shared/country-names.json reverse-lookup), and
// writes a frozen JSON artifact alongside a methodology block. Pair with
// tests/resilience-ranking-snapshot.test.mts to regression-verify the ordering
// invariants (monotonic, unique ranks, anchors in expected bands) against any
// frozen snapshot committed into the repo.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
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
  if (process.env.WORLDMONITOR_API_KEY) {
    headers['X-WorldMonitor-Key'] = process.env.WORLDMONITOR_API_KEY;
  } else {
    headers.cookie = await mintSessionCookie();
  }
  return headers;
}

async function fetchJson(url, headers) {
  const response = await fetch(url, { headers });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    const credentialHint = response.status === 401 && SCORE_URL && url.startsWith(SCORE_URL) && !process.env.WORLDMONITOR_API_KEY
      ? ' Set WORLDMONITOR_API_KEY to a Pro/API key; post-flip ranking snapshots must verify score anchors through get-resilience-score and cannot be captured from an unauthenticated shell.'
      : '';
    throw new Error(`HTTP ${response.status} from ${url}: ${body}${credentialHint}`);
  }
  return response.json();
}

async function fetchRanking(headers) {
  return fetchJson(RANKING_URL, headers);
}

async function fetchScore(countryCode, headers) {
  const url = new URL(SCORE_URL);
  url.searchParams.set('countryCode', countryCode);
  return fetchJson(url.toString(), headers);
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
    scoreEndpoint: SCORE_URL,
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
    rankingEndpoint: RANKING_URL,
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

function enrichItems(items, nameMap, startRank) {
  return items.map((item, i) => ({
    rank: startRank + i,
    countryCode: item.countryCode,
    countryName: nameMap[item.countryCode] ?? item.countryCode,
    overallScore: round1(item.overallScore),
    overallScoreRaw: item.overallScore,
    level: item.level,
    lowConfidence: Boolean(item.lowConfidence),
    dimensionCoverage: Math.round((item.overallCoverage ?? 0) * 100) / 100,
    headlineEligible: Boolean(item.headlineEligible),
    rankStable: Boolean(item.rankStable),
  }));
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
  if (!API_BASE) {
    console.error('[freeze-resilience-ranking] API_BASE env var required (e.g. https://api.worldmonitor.app)');
    process.exit(2);
  }
  if (FORCE_RANKING_REFRESH && !process.env.WORLDMONITOR_API_KEY) {
    console.error(
      '[freeze-resilience-ranking] WORLDMONITOR_API_KEY is required when RESILIENCE_RANKING_REFRESH is enabled; set RESILIENCE_RANKING_REFRESH=false to capture the cached public ranking instead',
    );
    process.exit(2);
  }

  const nameMap = await loadCountryNameMap();
  const methodologyMetadata = await loadResilienceMethodologyMetadata();
  const headers = await buildAuthHeaders();
  const formulaCheck = await verifyDeclaredFormula(headers);
  const ranking = await fetchRanking(headers);
  const formulaVerification = attachRankingVerification(ranking, formulaCheck);

  const items = Array.isArray(ranking.items) ? ranking.items : [];
  const greyedOut = Array.isArray(ranking.greyedOut) ? ranking.greyedOut : [];

  const ranked = enrichItems(items, nameMap, 1);
  const capturedAt = new Date().toISOString().slice(0, 10);

  const snapshot = {
    capturedAt,
    source: `Live capture via ${RANKING_URL}`,
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
      greyedOutCount: greyedOut.length,
    },
    items: ranked,
    greyedOut: greyedOut.map((item) => ({
      countryCode: item.countryCode,
      countryName: nameMap[item.countryCode] ?? item.countryCode,
      overallCoverage: Math.round((item.overallCoverage ?? 0) * 100) / 100,
      headlineEligible: Boolean(item.headlineEligible),
    })),
  };

  const outPath = resolveRankingSnapshotOutputPath(capturedAt);
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
  console.log(`[freeze-resilience-ranking] wrote ${outPath}`);
  console.log(`[freeze-resilience-ranking] items=${ranked.length} greyedOut=${greyedOut.length} commit=${snapshot.commitSha.slice(0, 10)}`);
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
