// Plan 2026-04-26-002 §U1 — Resilience cohort anti-inversion fixture (PR 0).
//
// PURPOSE — STRUCTURAL CI GATE FOR THE UNIVERSE + COVERAGE REBUILD
//
// PR #3425's post-merge cohort dry-run captured the empirical signature
// of the structural problem this rebuild exists to solve: tiny states
// (TV/PW/NR/MC) keep climbing in the v15 ranking even after targeted
// scorer fixes correctly de-rated HICs. The targeted fixes can't reach
// the universe + coverage handling defects. This test pins the cohort
// invariants so future rebuild PRs can tighten thresholds in lockstep
// with the corresponding fix:
//
//   PR 0 (this file): PERMISSIVE thresholds, passes against current v15.
//   PR 3 (coverage penalty): TIGHTENS median(G7) > median(microstate) + 10pt
//                            and min(G7) >= max(Sub-Saharan-LIC) - 10pt.
//   PR 4 (stable-absence recal): contributes to the same invariants.
//   PR 5 (per-capita normalization): TIGHTENS count(microstate) in top 20 <= 1.
//
// SOURCE OF TRUTH — COHORT MEMBERSHIP
//
// Membership is committed JSON at server/worldmonitor/resilience/v1/cohorts/
// so it can be reviewed independently from test code. DO NOT inline cohort
// lists here.
//
// READ PATTERN — READ-ONLY UPSTASH GET, SKIP-ON-MISSING-CREDS
//
// Reads live `resilience:ranking:vN` from production Upstash via the
// pattern from scripts/dry-run-resilience-rebalance.mjs. The test SKIPS
// (does not fail) when UPSTASH_REDIS_REST_URL is unset — required so
// CI-without-prod-creds and dev-without-.env environments still pass.
// When credentials ARE present, the test runs the invariants live.
//
// SAFETY — READ-ONLY
//
// Only HTTP GET against the ranking key. No mass DEL, no SET, no
// pipeline mutations. Defense-in-depth: the redisGet helper is the
// only Upstash interaction in this file.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';

const here = dirname(fileURLToPath(import.meta.url));
const COHORTS_DIR = resolve(here, '../server/worldmonitor/resilience/v1/cohorts');

interface CohortFile {
  name: string;
  description: string;
  iso2: string[];
}

function loadCohort(filename: string): CohortFile {
  const path = resolve(COHORTS_DIR, filename);
  const raw = readFileSync(path, 'utf8');
  const parsed = JSON.parse(raw) as CohortFile;
  if (!parsed.name || !Array.isArray(parsed.iso2)) {
    throw new Error(`Cohort file ${filename} missing required fields {name, iso2}`);
  }
  return parsed;
}

const ISO2_RE = /^[A-Z]{2}$/;

const cohorts = {
  g7: loadCohort('g7.json'),
  nordics: loadCohort('nordics.json'),
  gcc: loadCohort('gcc.json'),
  subSaharanLic: loadCohort('sub-saharan-lic.json'),
  microstateTerritories: loadCohort('microstate-territories.json'),
};

// --- Phase 1: cohort fixture self-tests (always run, no creds needed) ----------

describe('cohort JSON fixtures (Plan 2026-04-26-002 §U1)', () => {
  for (const [key, cohort] of Object.entries(cohorts)) {
    describe(`${key}`, () => {
      it('parses to a non-empty array of valid ISO2 codes', () => {
        assert.ok(cohort.iso2.length > 0, `${key} cohort must be non-empty`);
        for (const iso of cohort.iso2) {
          assert.ok(ISO2_RE.test(iso),
            `${key} contains invalid ISO2 code "${iso}" (must match /^[A-Z]{2}$/)`);
        }
      });

      it('has no duplicate entries', () => {
        const set = new Set(cohort.iso2);
        assert.equal(set.size, cohort.iso2.length,
          `${key} contains duplicates: ${cohort.iso2.length - set.size} extra entries`);
      });

      it('carries a non-empty description (anti-mystery-cohort gate)', () => {
        assert.ok(typeof cohort.description === 'string' && cohort.description.length > 50,
          `${key} description must explain the cohort's purpose (got ${cohort.description?.length ?? 0} chars)`);
      });
    });
  }

  it('cohorts are mutually disjoint where intent requires it', () => {
    // G7 ∩ Nordics: empty (no Nordic country is in G7)
    const g7Set = new Set(cohorts.g7.iso2);
    const overlap = cohorts.nordics.iso2.filter((iso) => g7Set.has(iso));
    assert.deepEqual(overlap, [],
      `G7 and Nordics must be disjoint; overlap: ${overlap.join(', ')}`);

    // G7 ∩ GCC: empty
    const gccOverlap = cohorts.gcc.iso2.filter((iso) => g7Set.has(iso));
    assert.deepEqual(gccOverlap, [],
      `G7 and GCC must be disjoint; overlap: ${gccOverlap.join(', ')}`);

    // microstate-territories ∩ G7: empty
    const microG7 = cohorts.microstateTerritories.iso2.filter((iso) => g7Set.has(iso));
    assert.deepEqual(microG7, [],
      `microstate-territories and G7 must be disjoint; overlap: ${microG7.join(', ')}`);
  });
});

// --- Phase 2: live-ranking anti-inversion (skipped when creds missing) ---------

interface RankingItem {
  iso2?: string;
  countryCode?: string;
  overallScore?: number;
  score?: number;
}

interface RankingPayload {
  rankings?: RankingItem[];
  items?: RankingItem[];
}

interface EnvelopeWrapper {
  data?: RankingPayload | null;
}

async function loadSeedUtils() {
  // Dynamic import: scripts/_seed-utils.mjs is .mjs and imports loadEnvFile etc.
  // The test only calls these helpers when UPSTASH creds are present, so any
  // import-time failure on the .mjs path is swallowed gracefully below.
  return import('../scripts/_seed-utils.mjs');
}

async function loadRankingKey(): Promise<string> {
  const sharedModule = await import('../server/worldmonitor/resilience/v1/_shared.ts');
  return (sharedModule as { RESILIENCE_RANKING_CACHE_KEY: string }).RESILIENCE_RANKING_CACHE_KEY;
}

async function fetchLiveRanking(rankingKey: string, url: string, token: string): Promise<RankingPayload | null> {
  const resp = await fetch(`${url}/get/${encodeURIComponent(rankingKey)}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) {
    throw new Error(`Upstash GET ${rankingKey}: HTTP ${resp.status}`);
  }
  const body = await resp.json();
  if (!body || body.result == null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.result);
  } catch {
    return null;
  }
  // Envelope unwrap pattern from scripts/dry-run-resilience-rebalance.mjs:
  // payload may be raw or wrapped { data, source, fetchedAt }.
  if (parsed && typeof parsed === 'object' && 'data' in parsed) {
    return (parsed as EnvelopeWrapper).data ?? null;
  }
  return parsed as RankingPayload;
}

function indexByIso2(payload: RankingPayload | null): Map<string, { score: number; rank: number }> {
  const out = new Map<string, { score: number; rank: number }>();
  const items = Array.isArray(payload?.rankings)
    ? payload!.rankings!
    : (Array.isArray(payload?.items) ? payload!.items! : []);
  let rank = 1;
  for (const entry of items) {
    const iso2 = (entry.iso2 ?? entry.countryCode ?? '').toUpperCase();
    if (!iso2) continue;
    const score = Number(entry.overallScore ?? entry.score ?? NaN);
    if (!Number.isFinite(score)) continue;
    out.set(iso2, { score, rank });
    rank++;
  }
  return out;
}

function median(nums: number[]): number {
  if (nums.length === 0) return NaN;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function scoresFor(cohort: CohortFile, ranking: Map<string, { score: number; rank: number }>): number[] {
  return cohort.iso2
    .map((iso) => ranking.get(iso)?.score)
    .filter((s): s is number => typeof s === 'number');
}

describe('cohort anti-inversion against live ranking (Plan 2026-04-26-002 §U1)', () => {
  // SKIP guard: if Upstash creds are missing, all tests in this describe block
  // log + pass without running the live invariants. Required for CI-without-prod-creds.
  const upstashUrl = process.env.UPSTASH_REDIS_REST_URL;
  const upstashToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  const credsPresent = Boolean(upstashUrl && upstashToken);

  if (!credsPresent) {
    it('[skip] live invariants — UPSTASH_REDIS_REST_URL/TOKEN not set in env', () => {
      console.log('[cohort-anti-inversion] Skipping live invariants — no Upstash credentials in env. Set UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN to run.');
      assert.ok(true);
    });
    return;
  }

  // Fetch ranking once for all live invariants.
  let ranking: Map<string, { score: number; rank: number }> | null = null;
  let rankingKey = '';

  it('[setup] fetches the live ranking from production Upstash', async () => {
    // Lazy-load env helper only when creds present (avoids loading .env in CI).
    const seedUtils = await loadSeedUtils() as { loadEnvFile: (u: string) => void };
    try {
      seedUtils.loadEnvFile(import.meta.url);
    } catch {
      // Non-fatal — env may already be loaded by the harness.
    }
    rankingKey = await loadRankingKey();
    const payload = await fetchLiveRanking(rankingKey, upstashUrl!, upstashToken!);
    assert.ok(payload, `Live ranking ${rankingKey} returned null/empty — production payload missing or malformed`);
    ranking = indexByIso2(payload);
    assert.ok(ranking.size >= 100,
      `Live ranking has ${ranking.size} indexed countries — too few for cohort invariants (expect >= 100). Payload shape may have changed.`);
    console.log(`[cohort-anti-inversion] Loaded ${ranking.size} countries from ${rankingKey}`);
  });

  // Each invariant runs as a separate `it` so failures isolate.

  it('TIGHTENED (plan 002 PR 3+4+5): median(G7) > median(microstate-territories) + 15pt', () => {
    if (!ranking) return;
    const g7Median = median(scoresFor(cohorts.g7, ranking));
    const microMedian = median(scoresFor(cohorts.microstateTerritories, ranking));
    console.log(`[cohort-anti-inversion] median(G7) = ${g7Median.toFixed(2)}, median(microstate) = ${microMedian.toFixed(2)}, gap = ${(g7Median - microMedian).toFixed(2)}`);
    // Plan 2026-04-26-002 §U4+U5+U6 (combined PR 3+4+5) eliminates the
    // structural inversion: median(G7) must now exceed median(microstate-
    // territories) by 15pt+. The fix is empirically expected via three
    // levers: (U4) coverage penalty halves imputed-dim weight so micro-
    // states' stable-absence inflated stats lose grip; (U5) source-
    // comprehensiveness flag drops unrest impute from 70 → 50 for
    // tiny states; (U6) per-capita normalization stops 0-event micros
    // from out-scoring low-rate large states.
    assert.ok(g7Median > microMedian + 15,
      `STRUCTURAL FAIL: median(G7)=${g7Median.toFixed(2)} did not exceed median(microstate-territories)=${microMedian.toFixed(2)} by ≥15pt. Gap=${(g7Median - microMedian).toFixed(2)}. Plan 002 PR 3+4+5 must produce this separation; if it doesn't, U4/U5/U6 levers are mis-calibrated.`);
  });

  it('TIGHTENED (plan 002 PR 3+4+5): median(Nordics) >= median(GCC) - 5pt', () => {
    if (!ranking) return;
    const nordicMedian = median(scoresFor(cohorts.nordics, ranking));
    const gccMedian = median(scoresFor(cohorts.gcc, ranking));
    console.log(`[cohort-anti-inversion] median(Nordics) = ${nordicMedian.toFixed(2)}, median(GCC) = ${gccMedian.toFixed(2)}, gap = ${(nordicMedian - gccMedian).toFixed(2)}`);
    // Plan 002: Nordic median should be at least within 5pt of GCC.
    // GCC small-state inflation should be largely corrected via U4+U6.
    assert.ok(nordicMedian >= gccMedian - 5,
      `STRUCTURAL FAIL: Nordics median ${nordicMedian.toFixed(2)} dropped >5pt below GCC median ${gccMedian.toFixed(2)}. After plan 002 §U4+U6, GCC inflation should be largely corrected.`);
  });

  it('TIGHTENED (plan 002 PR 3): min(G7) >= max(Sub-Saharan-LIC) - 10pt', () => {
    if (!ranking) return;
    const g7Scores = scoresFor(cohorts.g7, ranking);
    const licScores = scoresFor(cohorts.subSaharanLic, ranking);
    if (g7Scores.length === 0 || licScores.length === 0) {
      console.warn(`[cohort-anti-inversion] G7 scores=${g7Scores.length}, LIC scores=${licScores.length} — skipping`);
      return;
    }
    const g7Min = Math.min(...g7Scores);
    const licMax = Math.max(...licScores);
    console.log(`[cohort-anti-inversion] min(G7) = ${g7Min.toFixed(2)}, max(Sub-Saharan-LIC) = ${licMax.toFixed(2)}, gap = ${(g7Min - licMax).toFixed(2)}`);
    assert.ok(g7Min >= licMax - 10,
      `Catastrophic floor regression: min(G7)=${g7Min.toFixed(2)} fell within 10pt of max(Sub-Saharan-LIC)=${licMax.toFixed(2)}. Recovery domain or coverage handling has regressed.`);
  });

  it('TIGHTENED (plan 002 PR 5): count(microstate-territories) in top 20 <= 1', () => {
    if (!ranking) return;
    const microSet = new Set(cohorts.microstateTerritories.iso2);
    const sorted = [...ranking.entries()]
      .sort((a, b) => b[1].score - a[1].score)
      .slice(0, 20);
    const microInTop20 = sorted.filter(([iso]) => microSet.has(iso));
    console.log(`[cohort-anti-inversion] microstate-territories in top 20: ${microInTop20.length} (${microInTop20.map(([i]) => i).join(', ')})`);
    // Per-capita normalization (U6) should ensure no more than 1 micro-
    // state appears in the top 20. If multiple do, U6's pop-floor
    // calibration or U4's imputation factor needs adjustment.
    assert.ok(microInTop20.length <= 1,
      `STRUCTURAL FAIL: ${microInTop20.length} microstate-territories appeared in top 20 (${microInTop20.map(([i]) => i).join(', ')}). Plan 002 §U6 per-capita normalization should keep this ≤ 1.`);
  });

  it('REPORT-ONLY: per-cohort coverage in the live ranking [diagnostic]', () => {
    if (!ranking) return;
    for (const [key, cohort] of Object.entries(cohorts)) {
      const present = cohort.iso2.filter((iso) => ranking!.has(iso)).length;
      console.log(`[cohort-anti-inversion] ${key}: ${present}/${cohort.iso2.length} present in ranking`);
    }
    assert.ok(true);
  });
});
