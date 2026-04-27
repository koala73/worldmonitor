#!/usr/bin/env node
// Plan 2026-04-26-001 §U7 — Full-country dry-run validation.
//
// Reads two ranking snapshots from production Upstash (read-only):
//   1. PRE bump: parsed from a hardcoded fallback prefix override OR
//      whatever ranking key was live before the v14→v15 bump.
//   2. POST bump: the current RESILIENCE_RANKING_CACHE_KEY (imported
//      dynamically from _shared.ts; do NOT hardcode).
//
// Emits a CSV at tmp/resilience-rebalance-<timestamp>.csv with columns:
//   iso2, pre_score, post_score, score_delta, pre_rank, post_rank,
//   rank_delta, population_millions, pop_lt_11m
//
// Validates: count of pop<11m in pre top-20 vs post top-20.
//
// This script is a one-shot validation runner, NOT a test. It runs
// LOCALLY against production-read-only data. It does NOT write to
// Redis. It does NOT run in CI.
//
// Usage:
//   PRE_RANKING_KEY=resilience:ranking:v14 \
//     node --import tsx/esm scripts/dry-run-resilience-rebalance.mjs
//
// Population source: economic:imf:labor:v1 (RESILIENCE_IMF_LABOR_KEY).
// Per ImfLaborEntry shape — countries[iso2].populationMillions.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { loadEnvFile, getRedisCredentials } from './_seed-utils.mjs';

loadEnvFile(import.meta.url);

if (process.env.CI === 'true') {
  console.error('FATAL: dry-run-resilience-rebalance.mjs must NOT run in CI (manual one-shot validation only)');
  process.exit(2);
}

const { RESILIENCE_RANKING_CACHE_KEY } = await import('../server/worldmonitor/resilience/v1/_shared.ts');
const POST_RANKING_KEY = RESILIENCE_RANKING_CACHE_KEY;
const PRE_RANKING_KEY = process.env.PRE_RANKING_KEY ?? null;
const IMF_LABOR_KEY = 'economic:imf:labor:v1';

if (!PRE_RANKING_KEY) {
  console.error('FATAL: PRE_RANKING_KEY env var is required (e.g. resilience:ranking:v14)');
  process.exit(2);
}
console.log(`[dry-run] PRE  ranking: ${PRE_RANKING_KEY}`);
console.log(`[dry-run] POST ranking: ${POST_RANKING_KEY}`);

const credentials = getRedisCredentials();
if (!credentials || !credentials.url || !credentials.token) {
  console.error('FATAL: Upstash Redis credentials missing in env (.env)');
  process.exit(2);
}
const { url: REDIS_URL, token: REDIS_TOKEN } = credentials;

// --- Read-only Upstash GET ----------------------------------------------------
//
// Defense in depth: this script issues ONLY GET operations. It MUST NOT
// log REDIS_URL or REDIS_TOKEN to stdout, stderr, or any file. Errors
// log only the error class + message.
async function redisGet(key) {
  let resp;
  try {
    resp = await fetch(`${REDIS_URL}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${REDIS_TOKEN}` },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    throw new Error(`Upstash GET network error (${err.constructor?.name ?? 'Error'}): ${err.message}`);
  }
  if (!resp.ok) {
    throw new Error(`Upstash GET HTTP ${resp.status} for key (redacted)`);
  }
  const body = await resp.json();
  if (!body || body.result == null) return null;
  try {
    return JSON.parse(body.result);
  } catch {
    return null;
  }
}

function unwrapEnvelope(raw) {
  // payload may be a raw object or wrapped { data, source, fetchedAt }.
  // Always unwrap when the wrapper shape is detected — even when
  // `data` is null — so the downstream null-check produces a clear
  // FATAL instead of silently treating the wrapper object as the
  // payload (which would yield empty rankings + empty pop map).
  if (raw && typeof raw === 'object' && 'data' in raw) return raw.data;
  return raw;
}

// --- Read both rankings + population payload ---------------------------------

const [preRankingRaw, postRankingRaw, imfLaborRaw] = await Promise.all([
  redisGet(PRE_RANKING_KEY),
  redisGet(POST_RANKING_KEY),
  redisGet(IMF_LABOR_KEY),
]);

const preRanking = unwrapEnvelope(preRankingRaw);
const postRanking = unwrapEnvelope(postRankingRaw);
const imfLabor = unwrapEnvelope(imfLaborRaw);

if (!preRanking) {
  console.error(`FATAL: PRE ranking key ${PRE_RANKING_KEY} returned null/empty (TTL may have expired)`);
  process.exit(3);
}
if (!postRanking) {
  console.error(`FATAL: POST ranking key ${POST_RANKING_KEY} returned null/empty (run bulk-warm first?)`);
  process.exit(3);
}
if (!imfLabor || !imfLabor.countries) {
  console.error(`FATAL: ${IMF_LABOR_KEY} returned null/missing countries map`);
  process.exit(3);
}

// --- Index by iso2 -----------------------------------------------------------

function indexRanking(payload) {
  const items = Array.isArray(payload?.rankings)
    ? payload.rankings
    : (Array.isArray(payload?.items) ? payload.items : []);
  const out = new Map();
  let rank = 1;
  for (const entry of items) {
    const iso2 = (entry.iso2 ?? entry.countryCode ?? '').toUpperCase();
    if (!iso2) continue;
    out.set(iso2, { score: Number(entry.overallScore ?? entry.score ?? NaN), rank });
    rank++;
  }
  return out;
}

const preByIso2 = indexRanking(preRanking);
const postByIso2 = indexRanking(postRanking);

// Fail-closed validation per review fixup: this script is the post-merge
// validation gate for the v15 rebalance. It MUST NOT exit 0 on
// empty/malformed payloads — silent success on a broken ranking would
// flip the cohort gate from "validation passed" to "validation absent"
// without anyone noticing.
const MIN_RANKED_COUNTRIES = 20;
function assertRankingHealth(name, byIso2) {
  if (byIso2.size < MIN_RANKED_COUNTRIES) {
    console.error(`FATAL: ${name} ranking has only ${byIso2.size} indexed countries (< ${MIN_RANKED_COUNTRIES}); payload is malformed or empty.`);
    process.exit(7);
  }
  let finiteScored = 0;
  for (const entry of byIso2.values()) {
    if (Number.isFinite(entry.score)) finiteScored++;
  }
  if (finiteScored < MIN_RANKED_COUNTRIES) {
    console.error(`FATAL: ${name} ranking has only ${finiteScored} countries with finite scores (< ${MIN_RANKED_COUNTRIES}); the score field is missing or non-numeric in the payload (got fields like .overallScore?).`);
    process.exit(7);
  }
}
assertRankingHealth('PRE', preByIso2);
assertRankingHealth('POST', postByIso2);

// --- Population enrichment ---------------------------------------------------

function popOf(iso2) {
  const entry = imfLabor.countries?.[iso2.toUpperCase()];
  if (!entry) return null;
  const pop = Number(entry.populationMillions);
  return Number.isFinite(pop) ? pop : null;
}

// --- Build CSV rows ----------------------------------------------------------

const allCountries = new Set([...preByIso2.keys(), ...postByIso2.keys()]);
const rows = [];
let popMissing = 0;
for (const iso2 of [...allCountries].sort()) {
  const pre = preByIso2.get(iso2);
  const post = postByIso2.get(iso2);
  const pop = popOf(iso2);
  if (pop == null) popMissing++;
  rows.push({
    iso2,
    pre_score: pre?.score ?? '',
    post_score: post?.score ?? '',
    score_delta: pre && post ? (post.score - pre.score).toFixed(2) : '',
    pre_rank: pre?.rank ?? '',
    post_rank: post?.rank ?? '',
    rank_delta: pre && post ? pre.rank - post.rank : '',
    population_millions: pop != null ? pop.toFixed(1) : '',
    pop_lt_11m: pop != null ? (pop < 11 ? 'true' : 'false') : '',
  });
}

const popMissingPct = popMissing / allCountries.size;
console.warn(`WARNING: ${popMissing}/${allCountries.size} countries skipped from pop_lt_11m (no populationMillions in ${IMF_LABOR_KEY}).`);
if (popMissingPct > 0.20) {
  console.error(`FATAL: ${(popMissingPct * 100).toFixed(1)}% of countries missing population data — top-20 composition gate is unreliable.`);
  process.exit(4);
}

// --- Top-20 composition stats ------------------------------------------------

function top20Composition(byIso2) {
  const sorted = [...byIso2.entries()]
    .sort((a, b) => b[1].score - a[1].score)
    .slice(0, 20);
  let smallStateCount = 0;
  let knownPop = 0;
  for (const [iso2] of sorted) {
    const pop = popOf(iso2);
    if (pop == null) continue;
    knownPop++;
    if (pop < 11) smallStateCount++;
  }
  return { smallStateCount, knownPop, sample: sorted.map(([iso2]) => iso2) };
}

const preTop20 = top20Composition(preByIso2);
const postTop20 = top20Composition(postByIso2);

console.log('---');
console.log(`PRE  top-20 composition: ${preTop20.smallStateCount}/${preTop20.knownPop} pop<11m`);
console.log(`     top-20: ${preTop20.sample.join(', ')}`);
console.log(`POST top-20 composition: ${postTop20.smallStateCount}/${postTop20.knownPop} pop<11m`);
console.log(`     top-20: ${postTop20.sample.join(', ')}`);

// --- Write CSV ---------------------------------------------------------------

const TMP_DIR = path.resolve(process.cwd(), 'tmp');
if (!existsSync(TMP_DIR)) mkdirSync(TMP_DIR, { recursive: true });

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outPath = path.join(TMP_DIR, `resilience-rebalance-${stamp}.csv`);
// Defense in depth: assert path stays under tmp/.
if (!outPath.startsWith(TMP_DIR + path.sep)) {
  console.error(`FATAL: refusing to write outside tmp/ (got ${outPath})`);
  process.exit(5);
}
const header = 'iso2,pre_score,post_score,score_delta,pre_rank,post_rank,rank_delta,population_millions,pop_lt_11m\n';
const csv = header + rows
  .map((r) => `${r.iso2},${r.pre_score},${r.post_score},${r.score_delta},${r.pre_rank},${r.post_rank},${r.rank_delta},${r.population_millions},${r.pop_lt_11m}`)
  .join('\n') + '\n';
writeFileSync(outPath, csv, 'utf8');
console.log('---');
console.log(`Wrote ${rows.length} rows to ${outPath}`);

// Fail-closed cohort gate: the top-20 composition check is meaningful only
// when both rankings have enough population coverage in their top-20 to
// make the comparison statistically reasonable. If knownPop is degenerate
// for either side, refuse to declare success.
const MIN_TOP20_POP_KNOWN = 15; // 15/20 with known population
if (preTop20.knownPop < MIN_TOP20_POP_KNOWN || postTop20.knownPop < MIN_TOP20_POP_KNOWN) {
  console.error(`FATAL: top-20 population coverage too thin for a reliable cohort gate (PRE: ${preTop20.knownPop}/20, POST: ${postTop20.knownPop}/20; minimum ${MIN_TOP20_POP_KNOWN}/20). Cannot validate the v15 rebalance from this run.`);
  process.exit(8);
}

// Cohort target check (from plan §Cohort anchors): top-20 small-state count
// should drop from ~12 to <=9.
if (postTop20.smallStateCount > 9) {
  console.warn(`COHORT-WARN: POST top-20 has ${postTop20.smallStateCount} pop<11m countries; plan target is <=9.`);
}
if (postTop20.smallStateCount > preTop20.smallStateCount) {
  console.error(`COHORT-FAIL: POST top-20 small-state count INCREASED (${preTop20.smallStateCount} → ${postTop20.smallStateCount}); the bias fix is moving the wrong direction.`);
  process.exit(6);
}
process.exit(0);
