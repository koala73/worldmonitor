#!/usr/bin/env node
// Freeze a live snapshot of the resilience ranking for regression-verification
// of published figures. Writes to docs/snapshots/resilience-ranking-<YYYY-MM-DD>.json.
//
// Usage:
//   API_BASE=https://api.worldmonitor.app node scripts/freeze-resilience-ranking.mjs
//   API_BASE=https://api.worldmonitor.app WORLDMONITOR_API_KEY=... node scripts/freeze-resilience-ranking.mjs
//
// The script hits GET /api/resilience/v1/get-resilience-ranking, enriches each
// item with the country name (shared/country-names.json reverse-lookup), and
// writes a frozen JSON artifact alongside a methodology block. Pair with
// tests/resilience-ranking-snapshot.test.mts to regression-verify the ordering
// invariants (monotonic, unique ranks, anchors in expected bands) against any
// frozen snapshot committed into the repo.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

const API_BASE = (process.env.API_BASE || '').replace(/\/$/, '');
if (!API_BASE) {
  console.error('[freeze-resilience-ranking] API_BASE env var required (e.g. https://api.worldmonitor.app)');
  process.exit(2);
}

const RANKING_URL = `${API_BASE}/api/resilience/v1/get-resilience-ranking`;

function commitSha() {
  try {
    return execSync('git rev-parse HEAD', { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim();
  } catch {
    return 'unknown';
  }
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

async function fetchRanking() {
  const headers = { accept: 'application/json' };
  if (process.env.WORLDMONITOR_API_KEY) {
    headers['X-WorldMonitor-Key'] = process.env.WORLDMONITOR_API_KEY;
  }
  const response = await fetch(RANKING_URL, { headers });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${RANKING_URL}: ${await response.text().catch(() => '')}`);
  }
  return response.json();
}

function round1(n) {
  return Math.round(n * 10) / 10;
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
    rankStable: Boolean(item.rankStable),
  }));
}

async function main() {
  const nameMap = await loadCountryNameMap();
  const ranking = await fetchRanking();

  const items = Array.isArray(ranking.items) ? ranking.items : [];
  const greyedOut = Array.isArray(ranking.greyedOut) ? ranking.greyedOut : [];

  const ranked = enrichItems(items, nameMap, 1);
  const capturedAt = new Date().toISOString().slice(0, 10);

  const snapshot = {
    capturedAt,
    source: `Live capture via ${RANKING_URL}`,
    commitSha: commitSha(),
    schemaVersion: '2.0',
    methodology: {
      overallScoreFormula:
        'sum(domain.score * domain.weight) across 6 domains; weights: economic=0.17, infrastructure=0.15, energy=0.11, social-governance=0.19, health-food=0.13, recovery=0.25 (sum=1.00).',
      domainCount: 6,
      dimensionCount: 19,
      pillarCount: 3,
      coverageLabel:
        "Mean dimension coverage (avg of the 19 per-dimension coverage values). Labelled 'Dimension coverage' in publications to avoid the ambiguity of 'Data coverage'.",
      greyOutThreshold: 0.40,
    },
    totals: {
      rankedCountries: ranked.length,
      greyedOutCount: greyedOut.length,
    },
    items: ranked,
    greyedOut: greyedOut.map((item) => ({
      countryCode: item.countryCode,
      countryName: nameMap[item.countryCode] ?? item.countryCode,
      overallCoverage: Math.round((item.overallCoverage ?? 0) * 100) / 100,
    })),
  };

  const outPath = path.join(REPO_ROOT, 'docs', 'snapshots', `resilience-ranking-${capturedAt}.json`);
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
  console.log(`[freeze-resilience-ranking] wrote ${outPath}`);
  console.log(`[freeze-resilience-ranking] items=${ranked.length} greyedOut=${greyedOut.length} commit=${snapshot.commitSha.slice(0, 10)}`);
}

main().catch((err) => {
  console.error('[freeze-resilience-ranking] failed:', err);
  process.exit(1);
});
