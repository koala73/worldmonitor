#!/usr/bin/env node
// Release-gate audit harness for the resilience scorer. Emits a Markdown
// report that surfaces cohort-level ranking sanity issues BEFORE they reach
// publication. Designed as a release gate, not a commit gate — see
// docs/methodology/cohort-sanity-release-gate.md for the interpretation
// contract and the explicit anti-pattern note on rank-targeted acceptance
// criteria.
//
// What this does:
//   1. Fetch the live ranking via GET /api/resilience/v1/get-resilience-ranking.
//   2. For every country in the named cohorts (GCC, OECD-nuclear, ASEAN-
//      trade-hub, LatAm-petro, African-fragile, post-Soviet, stressed-debt),
//      fetch the full per-dimension score via GET
//      /api/resilience/v1/get-resilience-score?countryCode=XX.
//   3. Emit a Markdown report with:
//        - Full ranking table (top N + grey-outs summary)
//        - Per-cohort per-dimension breakdown (score / coverage / imputation)
//        - Contribution decomposition: per country, per dim,
//          (score × coverage × dimWeight × domainWeight) toward overall
//        - Flagged patterns: saturated dimensions (>95 across cohort),
//          low-coverage outliers (coverage < 0.5 where peers are 1.0),
//          identical-score clusters (same score across all cohort members)
//        - Top-N movers vs a baseline snapshot (optional)
//
// What this does NOT do:
//   - Assert country rank orderings ("AE > KW"). That would couple the gate
//     to outcome-seeking; the audit is intentionally descriptive.
//   - Fail the build. It's a report generator. Release review reads the
//     report and decides whether to hold publication.
//
// Usage:
//   WORLDMONITOR_API_KEY=wm_xxx API_BASE=https://api.worldmonitor.app \
//     node scripts/audit-resilience-cohorts.mjs
//   WORLDMONITOR_API_KEY=wm_xxx API_BASE=... \
//     BASELINE=docs/snapshots/resilience-ranking-live-pre-cohort-audit-2026-04-24.json \
//     OUT=/tmp/audit.md node scripts/audit-resilience-cohorts.mjs
//   FIXTURE=tests/fixtures/resilience-audit-fixture.json node scripts/audit-resilience-cohorts.mjs
//
// Auth: the resilience ranking + score endpoints are in PREMIUM_RPC_PATHS
// (see src/shared/premium-paths.ts). A valid WORLDMONITOR_API_KEY is
// required whether running from a trusted browser origin or not — the
// premium gate forces the key.
//
// Fixture mode (FIXTURE env): reads a JSON file with shape
//   { ranking: GetResilienceRankingResponse, scores: { [cc]: GetResilienceScoreResponse } }
// and builds the report without any network calls. Useful for offline runs
// and for regression-comparing the audit output itself across scorer
// changes (diff the Markdown).

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

const FIXTURE_PATH = process.env.FIXTURE || '';
const API_BASE = (process.env.API_BASE || '').replace(/\/$/, '');
if (!FIXTURE_PATH) {
  if (!API_BASE) {
    console.error('[audit-resilience-cohorts] API_BASE env var required (e.g. https://api.worldmonitor.app), or FIXTURE=path.json for offline mode');
    process.exit(2);
  }
  if (!process.env.WORLDMONITOR_API_KEY) {
    console.error('[audit-resilience-cohorts] WORLDMONITOR_API_KEY env var required; resilience RPC paths are in PREMIUM_RPC_PATHS.');
    process.exit(2);
  }
}

const RANKING_URL = `${API_BASE}/api/resilience/v1/get-resilience-ranking`;
const SCORE_URL = (cc) => `${API_BASE}/api/resilience/v1/get-resilience-score?countryCode=${encodeURIComponent(cc)}`;
const BASELINE_PATH = process.env.BASELINE || '';
const OUT_PATH = process.env.OUT || '';
const TOP_N_FULL_RANKING = Number(process.env.TOP_N || 60);
const MOVERS_N = Number(process.env.MOVERS_N || 30);
const CONCURRENCY = Number(process.env.CONCURRENCY || 6);

// Named cohorts. Membership reflects the construct question each cohort
// answers — not "who should rank where." See release-gate doc for rationale.
const COHORTS = {
  GCC: ['AE', 'SA', 'KW', 'QA', 'OM', 'BH'],
  'OECD-nuclear': ['FR', 'US', 'GB', 'JP', 'KR', 'DE', 'CA', 'FI', 'SE', 'BE'],
  'ASEAN-trade-hub': ['SG', 'MY', 'TH', 'VN', 'ID', 'PH'],
  'LatAm-petro': ['BR', 'MX', 'CO', 'VE', 'AR', 'EC'],
  'African-fragile': ['NG', 'ZA', 'ET', 'KE', 'GH', 'CD', 'SD'],
  'Post-Soviet': ['RU', 'KZ', 'AZ', 'UA', 'UZ', 'GE', 'AM'],
  'Stressed-debt': ['LK', 'PK', 'AR', 'LB', 'TR', 'EG', 'TN'],
  'Re-export-hub': ['SG', 'HK', 'NL', 'BE', 'PA', 'AE', 'MY', 'LT'],
  'SWF-heavy-exporter': ['NO', 'QA', 'KW', 'SA', 'KZ', 'AZ'],
  'Fragile-floor': ['YE', 'SY', 'SO', 'AF'],
};

// Coarse domain weights mirrored from _dimension-scorers.ts for contribution
// decomposition. The live API already returns domain.weight per country,
// so we READ that from the API rather than hardcoding — this table is only
// used for sanity-cross-check in the header.
const EXPECTED_DOMAIN_WEIGHTS = {
  economic: 0.17,
  infrastructure: 0.15,
  energy: 0.11,
  'social-governance': 0.19,
  'health-food': 0.13,
  recovery: 0.25,
};

function commitSha() {
  try {
    return execSync('git rev-parse HEAD', { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    return 'unknown';
  }
}

async function loadCountryNameMap() {
  const raw = await fs.readFile(path.join(REPO_ROOT, 'shared', 'country-names.json'), 'utf8');
  const forward = JSON.parse(raw);
  const reverse = {};
  for (const [name, iso2] of Object.entries(forward)) {
    const code = String(iso2 || '').toUpperCase();
    if (!/^[A-Z]{2}$/.test(code)) continue;
    if (reverse[code]) continue;
    reverse[code] = name.replace(/\b([a-z])/g, (_, c) => c.toUpperCase());
  }
  return reverse;
}

function apiHeaders() {
  const h = {
    accept: 'application/json',
    // Full UA (not the 10-char Node default) avoids middleware.ts's short-UA
    // bot guard that 403s bare `node` fetches on the edge path.
    'user-agent': 'audit-resilience-cohorts/1.0 (+scripts/audit-resilience-cohorts.mjs)',
  };
  if (process.env.WORLDMONITOR_API_KEY) {
    h['X-WorldMonitor-Key'] = process.env.WORLDMONITOR_API_KEY;
  }
  return h;
}

async function fetchRanking() {
  const response = await fetch(RANKING_URL, { headers: apiHeaders() });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${RANKING_URL}: ${await response.text().catch(() => '')}`);
  }
  return response.json();
}

async function fetchScore(countryCode) {
  const response = await fetch(SCORE_URL(countryCode), { headers: apiHeaders() });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${countryCode}`);
  }
  return response.json();
}

async function fetchScoresConcurrent(countryCodes) {
  const scores = new Map();
  const queue = [...countryCodes];
  async function worker() {
    while (queue.length) {
      const cc = queue.shift();
      if (!cc) return;
      try {
        const data = await fetchScore(cc);
        scores.set(cc, data);
      } catch (err) {
        console.error(`[audit] ${cc} failed: ${err.message}`);
        scores.set(cc, null);
      }
    }
  }
  const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker);
  await Promise.all(workers);
  return scores;
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

// Given a score document, compute the contribution of every dimension to the
// overall score. The overall is (by construct) a domain-weighted roll-up of
// coverage-weighted dimension means. For contribution reporting we use the
// "effective share" each dim has toward overall:
//   domainShare = domainWeight
//   withinDomainShare = (dim.coverage × dimWeight) / Σ(coverage × dimWeight) for that domain
//   overallContribution = dim.score × withinDomainShare × domainShare
// The sum of overallContribution across all dims ≈ overallScore (modulo
// pillar-combine path when enabled, which isn't contribution-decomposable
// by a clean formula).
function decomposeContributions(scoreDoc, dimWeights) {
  const rows = [];
  for (const domain of scoreDoc.domains ?? []) {
    const dims = domain.dimensions ?? [];
    let denom = 0;
    for (const d of dims) {
      const w = dimWeights[d.id] ?? 1.0;
      denom += (d.coverage ?? 0) * w;
    }
    for (const d of dims) {
      const w = dimWeights[d.id] ?? 1.0;
      const withinDomainShare = denom > 0 ? ((d.coverage ?? 0) * w) / denom : 0;
      const contribution = (d.score ?? 0) * withinDomainShare * (domain.weight ?? 0);
      rows.push({
        domainId: domain.id,
        domainWeight: domain.weight,
        dimensionId: d.id,
        score: d.score,
        coverage: d.coverage,
        imputationClass: d.imputationClass || '',
        dimWeight: w,
        withinDomainShare,
        contribution,
      });
    }
  }
  return rows;
}

// Weight multipliers mirrored from _dimension-scorers.ts. Mirror is acceptable
// here because the audit script is a diagnostic — if dim weights drift we'll
// see contribution rows that don't sum to overallScore and investigate.
const DIM_WEIGHTS = {
  macroFiscal: 1.0,
  currencyExternal: 1.0,
  tradeSanctions: 1.0,
  cyberDigital: 1.0,
  logisticsSupply: 1.0,
  infrastructure: 1.0,
  energy: 1.0,
  governanceInstitutional: 1.0,
  socialCohesion: 1.0,
  borderSecurity: 1.0,
  informationCognitive: 1.0,
  healthPublicService: 1.0,
  foodWater: 1.0,
  fiscalSpace: 1.0,
  reserveAdequacy: 1.0,
  externalDebtCoverage: 1.0,
  importConcentration: 1.0,
  stateContinuity: 1.0,
  fuelStockDays: 1.0,
  liquidReserveAdequacy: 0.5,
  sovereignFiscalBuffer: 0.5,
};

function flagDimensionPatterns(cohortName, cohortCodes, scoreMap) {
  const flags = [];
  // Collect per-dimension values across the cohort.
  const byDim = new Map();
  for (const cc of cohortCodes) {
    const doc = scoreMap.get(cc);
    if (!doc) continue;
    for (const domain of doc.domains ?? []) {
      for (const dim of domain.dimensions ?? []) {
        if (!byDim.has(dim.id)) byDim.set(dim.id, []);
        byDim.get(dim.id).push({ cc, score: dim.score, coverage: dim.coverage, imputationClass: dim.imputationClass });
      }
    }
  }
  for (const [dimId, entries] of byDim.entries()) {
    // Saturated dim: every member scores > 95
    if (entries.length >= 3 && entries.every((e) => e.score > 95)) {
      flags.push({
        cohort: cohortName,
        kind: 'saturated-high',
        dimension: dimId,
        message: `Every cohort member scores > 95 on ${dimId}; dim contributes zero discrimination within the cohort.`,
      });
    }
    // Saturated low: every member scores < 5
    if (entries.length >= 3 && entries.every((e) => e.score < 5)) {
      flags.push({
        cohort: cohortName,
        kind: 'saturated-low',
        dimension: dimId,
        message: `Every cohort member scores < 5 on ${dimId}; construct may not apply or seed is missing.`,
      });
    }
    // Identical score across cohort (variance = 0 and ≥ 3 entries)
    if (entries.length >= 3) {
      const first = entries[0].score;
      if (entries.every((e) => e.score === first) && first > 0 && first < 100) {
        flags.push({
          cohort: cohortName,
          kind: 'identical-scores',
          dimension: dimId,
          message: `All ${entries.length} cohort members have identical ${dimId} = ${first}; possible imputed-default or region-default leak.`,
        });
      }
    }
    // Low-coverage outlier: one entry has coverage < 0.5 while peers ≥ 0.9
    const lowCov = entries.filter((e) => (e.coverage ?? 0) < 0.5);
    const highCov = entries.filter((e) => (e.coverage ?? 0) >= 0.9);
    if (lowCov.length && highCov.length >= lowCov.length * 2) {
      flags.push({
        cohort: cohortName,
        kind: 'coverage-outlier',
        dimension: dimId,
        message: `Low coverage on ${dimId}: ${lowCov.map((e) => `${e.cc}(${round2(e.coverage)})`).join(', ')}; peers have full coverage.`,
      });
    }
  }
  return flags;
}

function computeMovers(currentItems, baselineItems, n) {
  if (!baselineItems) return [];
  const baselineByCc = new Map(baselineItems.map((x) => [x.countryCode, x]));
  const currentByCc = new Map(currentItems.map((x) => [x.countryCode, x]));
  const deltas = [];
  for (const [cc, cur] of currentByCc.entries()) {
    const prev = baselineByCc.get(cc);
    if (!prev) continue;
    const curScore = typeof cur.overallScore === 'number' ? cur.overallScore : null;
    const prevScore = typeof prev.overallScoreRaw === 'number' ? prev.overallScoreRaw : (typeof prev.overallScore === 'number' ? prev.overallScore : null);
    if (curScore == null || prevScore == null) continue;
    deltas.push({
      countryCode: cc,
      scoreDelta: curScore - prevScore,
      curScore,
      prevScore,
      curRank: cur.__rank,
      prevRank: prev.rank ?? null,
    });
  }
  deltas.sort((a, b) => Math.abs(b.scoreDelta) - Math.abs(a.scoreDelta));
  return deltas.slice(0, n);
}

function fmtDelta(delta) {
  if (delta === 0) return '·';
  const sign = delta > 0 ? '+' : '−';
  return `${sign}${Math.abs(delta).toFixed(2)}`;
}

function section(label, body) {
  return `\n## ${label}\n\n${body}\n`;
}

function buildReport({ ranking, scoreMap, nameMap, movers, capturedAt, sha }) {
  const items = ranking.items ?? [];
  const greyedOut = ranking.greyedOut ?? [];

  let md = `# Resilience cohort-sanity audit report\n\n`;
  md += `- Captured: ${capturedAt}\n- Commit: ${sha}\n- Source: ${RANKING_URL}\n- Ranked: ${items.length} · Grey-out: ${greyedOut.length}\n`;
  md += `- Generated by: \`scripts/audit-resilience-cohorts.mjs\`\n`;
  md += `- Expected domain weights: ${Object.entries(EXPECTED_DOMAIN_WEIGHTS).map(([k, v]) => `${k}=${v}`).join(', ')}\n`;
  if (BASELINE_PATH) md += `- Baseline snapshot: \`${BASELINE_PATH}\`\n`;

  // Ranking table
  let body = '| # | CC | Country | Overall | Coverage | Level | Low-conf |\n|---:|---|---|---:|---:|---|---|\n';
  items.slice(0, TOP_N_FULL_RANKING).forEach((x, i) => {
    body += `| ${i + 1} | ${x.countryCode} | ${nameMap[x.countryCode] ?? x.countryCode} | ${round1(x.overallScore)} | ${round2(x.overallCoverage)} | ${x.level} | ${x.lowConfidence ? '⚠' : ''} |\n`;
  });
  md += section(`Top ${TOP_N_FULL_RANKING} ranking`, body);

  // Per-cohort per-dimension breakdown
  for (const [cohortName, codes] of Object.entries(COHORTS)) {
    const present = codes.filter((cc) => scoreMap.get(cc));
    if (!present.length) continue;
    let cohort = `Members: ${present.join(', ')}\n\n`;

    // Collect all dims seen in this cohort.
    const dimIds = new Set();
    for (const cc of present) {
      const doc = scoreMap.get(cc);
      for (const dom of doc.domains ?? []) for (const dim of dom.dimensions ?? []) dimIds.add(dim.id);
    }
    const orderedDims = [...dimIds].sort();

    // Overall table
    cohort += `**Overall**\n\n| CC | Country | Overall | Baseline | Stress | Level |\n|---|---|---:|---:|---:|---|\n`;
    for (const cc of present) {
      const doc = scoreMap.get(cc);
      cohort += `| ${cc} | ${nameMap[cc] ?? cc} | ${round1(doc.overallScore)} | ${round1(doc.baselineScore)} | ${round1(doc.stressScore)} | ${doc.level} |\n`;
    }

    cohort += `\n**Per-dimension score** (score · coverage · imputationClass if set)\n\n`;
    cohort += `| Dim | ${present.map((cc) => cc).join(' | ')} |\n|---| ${present.map(() => '---:').join(' | ')} |\n`;
    for (const dimId of orderedDims) {
      const cells = present.map((cc) => {
        const doc = scoreMap.get(cc);
        for (const dom of doc.domains ?? []) {
          for (const dim of dom.dimensions ?? []) {
            if (dim.id === dimId) {
              const cov = round2(dim.coverage ?? 0);
              const imp = dim.imputationClass ? ` · *${dim.imputationClass}*` : '';
              return `${Math.round(dim.score ?? 0)} · ${cov}${imp}`;
            }
          }
        }
        return '—';
      });
      cohort += `| ${dimId} | ${cells.join(' | ')} |\n`;
    }

    // Contribution decomposition for the cohort (sums to overall per country).
    cohort += `\n**Contribution decomposition** (points toward overall score)\n\n`;
    cohort += `| Dim | ${present.map((cc) => cc).join(' | ')} |\n|---| ${present.map(() => '---:').join(' | ')} |\n`;
    const contribByCc = new Map(
      present.map((cc) => [cc, decomposeContributions(scoreMap.get(cc), DIM_WEIGHTS)]),
    );
    for (const dimId of orderedDims) {
      const cells = present.map((cc) => {
        const rows = contribByCc.get(cc) ?? [];
        const row = rows.find((r) => r.dimensionId === dimId);
        if (!row) return '—';
        return row.contribution.toFixed(2);
      });
      cohort += `| ${dimId} | ${cells.join(' | ')} |\n`;
    }
    // Sanity row: contribution sum vs overall
    const sums = present.map((cc) => {
      const rows = contribByCc.get(cc) ?? [];
      return rows.reduce((a, r) => a + r.contribution, 0);
    });
    cohort += `| **sum contrib** | ${sums.map((s) => s.toFixed(2)).join(' | ')} |\n`;
    const overalls = present.map((cc) => scoreMap.get(cc).overallScore);
    cohort += `| **overallScore** | ${overalls.map((s) => round1(s)).join(' | ')} |\n`;

    md += section(`Cohort: ${cohortName}`, cohort);
  }

  // Flagged patterns
  const allFlags = [];
  for (const [cohortName, codes] of Object.entries(COHORTS)) {
    allFlags.push(...flagDimensionPatterns(cohortName, codes, scoreMap));
  }
  if (allFlags.length) {
    let flagBody = `| Cohort | Kind | Dimension | Message |\n|---|---|---|---|\n`;
    for (const f of allFlags) {
      flagBody += `| ${f.cohort} | ${f.kind} | ${f.dimension} | ${f.message} |\n`;
    }
    md += section('Flagged patterns', flagBody);
  } else {
    md += section('Flagged patterns', '_No cohort-sanity patterns tripped heuristic thresholds._');
  }

  // Movers
  if (movers?.length) {
    let mvBody = `Baseline: \`${BASELINE_PATH}\`\n\n`;
    mvBody += `| CC | Country | Prev | Current | Δ | Prev rank | Current rank |\n|---|---|---:|---:|---:|---:|---:|\n`;
    for (const m of movers) {
      mvBody += `| ${m.countryCode} | ${nameMap[m.countryCode] ?? m.countryCode} | ${round1(m.prevScore)} | ${round1(m.curScore)} | ${fmtDelta(round2(m.scoreDelta))} | ${m.prevRank ?? '—'} | ${m.curRank ?? '—'} |\n`;
    }
    md += section(`Top-${MOVERS_N} movers vs baseline`, mvBody);
  }

  md += `\n---\n\n*This audit is a release-gate diagnostic, not a merge-blocker. Rank-targeted acceptance criteria are an explicit anti-pattern — see \`docs/methodology/cohort-sanity-release-gate.md\`.*\n`;
  return md;
}

async function main() {
  const nameMap = await loadCountryNameMap();
  let ranking;
  let scoreMap;
  if (FIXTURE_PATH) {
    const raw = await fs.readFile(path.resolve(REPO_ROOT, FIXTURE_PATH), 'utf8');
    const fixture = JSON.parse(raw);
    ranking = fixture.ranking ?? { items: [], greyedOut: [] };
    scoreMap = new Map(Object.entries(fixture.scores ?? {}));
    console.error(`[audit] FIXTURE mode: ${path.resolve(REPO_ROOT, FIXTURE_PATH)} (ranked=${(ranking.items || []).length}, scores=${scoreMap.size})`);
  } else {
    ranking = await fetchRanking();
    // Collect all unique country codes across all cohorts (dedup).
    const cohortCodes = new Set();
    for (const codes of Object.values(COHORTS)) for (const cc of codes) cohortCodes.add(cc);
    const cohortList = [...cohortCodes].sort();
    console.error(`[audit] fetching per-country scores for ${cohortList.length} cohort members at concurrency=${CONCURRENCY}`);
    scoreMap = await fetchScoresConcurrent(cohortList);
  }
  const items = ranking.items ?? [];
  items.forEach((x, i) => { x.__rank = i + 1; });

  let movers = [];
  if (BASELINE_PATH) {
    try {
      const raw = await fs.readFile(path.resolve(REPO_ROOT, BASELINE_PATH), 'utf8');
      const baseline = JSON.parse(raw);
      movers = computeMovers(items, baseline.items, MOVERS_N);
    } catch (err) {
      console.error(`[audit] baseline read failed: ${err.message}`);
    }
  }

  const capturedAt = new Date().toISOString();
  const sha = commitSha();
  const md = buildReport({ ranking, scoreMap, nameMap, movers, capturedAt, sha });

  if (OUT_PATH) {
    await fs.mkdir(path.dirname(path.resolve(REPO_ROOT, OUT_PATH)), { recursive: true });
    await fs.writeFile(path.resolve(REPO_ROOT, OUT_PATH), md, 'utf8');
    console.error(`[audit] wrote ${OUT_PATH}`);
  } else {
    process.stdout.write(md);
  }
}

main().catch((err) => {
  console.error('[audit-resilience-cohorts] failed:', err);
  process.exit(1);
});
