/**
 * Join generative-AI usage by country × period onto centroids for AI Usage map.
 *
 * Sources (merged; missing ≠ invent):
 *   1. OWID / Microsoft — population usage share (H1 2025 onward)
 *      https://ourworldindata.org/grapher/estimated-share-people-generative-ai
 *   2. WildChat-1M — opt-in ChatGPT conversation share by country × quarter
 *      (boom-era before OWID; not population %). Aggregate first:
 *      python scripts/aggregate_wildchat_ai_usage.py
 *      → scripts/_wildchat-usage-by-country-quarter.csv
 *
 * Usage (from apps/worldmonitor):
 *   node scripts/join-owid-ai-conversation-growth.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OWID_URL =
  'https://ourworldindata.org/grapher/estimated-share-people-generative-ai.csv';
const RAW = path.join(__dirname, '_owid-ai-raw.csv');
const WILDCHAT = path.join(__dirname, '_wildchat-usage-by-country-quarter.csv');
const ISO = path.join(__dirname, '_iso3166.csv');
const CENT = path.join(__dirname, '_country-centroids.csv');
const OUT = path.join(ROOT, 'src/config/ai-conversation-growth.ts');

/** First OWID wave end — WildChat boom-era rows must end before this. */
const OWID_FIRST_MS = Date.parse('2025-06-30T00:00:00Z');

async function ensureRaw() {
  if (fs.existsSync(RAW) && fs.statSync(RAW).size > 1000) return;
  const res = await fetch(OWID_URL, {
    headers: { 'User-Agent': 'worldmonitor-ai-conversation-growth/1.0' },
  });
  if (!res.ok) throw new Error(`OWID fetch failed: ${res.status}`);
  fs.writeFileSync(RAW, await res.text(), 'utf8');
}

function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  const header = lines[0].split(',');
  return lines.slice(1).map((line) => {
    const cols = [];
    let cur = '';
    let q = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') {
        q = !q;
        continue;
      }
      if (c === ',' && !q) {
        cols.push(cur);
        cur = '';
        continue;
      }
      cur += c;
    }
    cols.push(cur);
    const row = {};
    header.forEach((h, i) => {
      row[h] = cols[i] ?? '';
    });
    return row;
  });
}

function loadIso3ToIso2() {
  const rows = parseCsv(fs.readFileSync(ISO, 'utf8'));
  const map = new Map();
  for (const r of rows) {
    const a2 = r['alpha-2'];
    const a3 = r['alpha-3'];
    if (a2 && a3) map.set(a3, a2);
  }
  return map;
}

function loadCentroids() {
  const rows = parseCsv(fs.readFileSync(CENT, 'utf8'));
  const map = new Map();
  for (const r of rows) {
    const lat = Number(r.latitude);
    const lon = Number(r.longitude);
    if (!r.country || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    map.set(r.country, { lat, lon, name: r.name || r.country });
  }
  return map;
}

function periodLabel(day) {
  if (day === '2025-06-30') return '2025 H1';
  if (day === '2025-12-31') return '2025 H2';
  if (day === '2026-03-31') return '2026 Q1';
  const [y, m] = day.split('-').map(Number);
  if (m <= 3) return `${y} Q1`;
  if (m <= 6) return `${y} Q2`;
  if (m <= 9) return `${y} Q3`;
  return `${y} Q4`;
}

async function main() {
  await ensureRaw();
  if (!fs.existsSync(ISO) || !fs.existsSync(CENT)) {
    throw new Error('Need scripts/_iso3166.csv and scripts/_country-centroids.csv');
  }

  const iso3to2 = loadIso3ToIso2();
  const cents = loadCentroids();
  const rows = parseCsv(fs.readFileSync(RAW, 'utf8'));

  const points = [];
  let skipped = 0;
  for (const r of rows) {
    const iso3 = r.Code?.trim();
    const day = r.Day?.trim();
    const share = Number(
      r['Estimated share of working-age adults who use generative AI'],
    );
    if (!iso3 || iso3 === '' || !day || !Number.isFinite(share)) {
      skipped += 1;
      continue;
    }
    const iso2 = iso3to2.get(iso3);
    const c = iso2 ? cents.get(iso2) : null;
    if (!c) {
      skipped += 1;
      continue;
    }
    const periodEndMs = Date.parse(`${day}T00:00:00Z`);
    if (!Number.isFinite(periodEndMs)) {
      skipped += 1;
      continue;
    }
    points.push({
      id: `ai-use-${iso2}-${day}`,
      iso2,
      name: r.Entity || c.name,
      lat: c.lat,
      lon: c.lon,
      sharePct: share,
      periodEndMs,
      periodLabel: periodLabel(day),
      source: 'owid',
    });
  }

  let wildchatAdded = 0;
  let wildchatSkipped = 0;
  if (fs.existsSync(WILDCHAT) && fs.statSync(WILDCHAT).size > 50) {
    const wc = parseCsv(fs.readFileSync(WILDCHAT, 'utf8'));
    for (const r of wc) {
      const iso3 = r.iso3?.trim().toUpperCase();
      const day = r.quarter_end?.trim();
      const share = Number(r.corpus_share_pct);
      if (!iso3 || !day || !Number.isFinite(share)) {
        wildchatSkipped += 1;
        continue;
      }
      const periodEndMs = Date.parse(`${day}T00:00:00Z`);
      if (!Number.isFinite(periodEndMs) || periodEndMs >= OWID_FIRST_MS) {
        wildchatSkipped += 1;
        continue;
      }
      const iso2 = iso3to2.get(iso3);
      const c = iso2 ? cents.get(iso2) : null;
      if (!c) {
        wildchatSkipped += 1;
        continue;
      }
      points.push({
        id: `ai-use-wc-${iso2}-${day}`,
        iso2,
        name: r.country_name || c.name,
        lat: c.lat,
        lon: c.lon,
        sharePct: share,
        periodEndMs,
        periodLabel: periodLabel(day),
        source: 'wildchat',
      });
      wildchatAdded += 1;
    }
  } else {
    console.warn(
      `No ${path.basename(WILDCHAT)} — boom-era quarters omitted. Run: python scripts/aggregate_wildchat_ai_usage.py`,
    );
  }

  points.sort((a, b) => a.periodEndMs - b.periodEndMs || a.iso2.localeCompare(b.iso2));

  const periods = [...new Set(points.map((p) => p.periodEndMs))].sort((a, b) => a - b);

  const body = `/**
 * Generative-AI online usage / conversation density by country × period.
 *
 * - source \`owid\`: OWID/Microsoft share of working-age adults who used a
 *   tracked generative-AI site/app (H1 2025 onward).
 * - source \`wildchat\`: WildChat-1M opt-in ChatGPT conversation share of that
 *   quarter's corpus (boom-era before OWID). Not population usage %.
 *
 * Regenerate:
 *   python scripts/aggregate_wildchat_ai_usage.py
 *   node scripts/join-owid-ai-conversation-growth.mjs
 *
 * OWID: https://ourworldindata.org/grapher/estimated-share-people-generative-ai
 * WildChat: https://huggingface.co/datasets/allenai/WildChat-1M (ODC-BY)
 */

export type AiUsageSource = 'owid' | 'wildchat';

export type AiConversationGrowthPoint = {
  id: string;
  iso2: string;
  name: string;
  lat: number;
  lon: number;
  /**
   * owid: estimated % of working-age adults using generative AI.
   * wildchat: % of WildChat conversations from this country in the quarter.
   */
  sharePct: number;
  periodEndMs: number;
  periodLabel: string;
  source: AiUsageSource;
};

export const AI_CONVERSATION_GROWTH_POINTS: readonly AiConversationGrowthPoint[] = ${JSON.stringify(points, null, 2)};

/** Distinct reporting period ends (UTC), ascending — WildChat quarters then OWID waves. */
export const AI_CONVERSATION_PERIOD_ENDS_MS: readonly number[] = ${JSON.stringify(periods)};

export function aiConversationPointsAt(focusMs: number | null): AiConversationGrowthPoint[] {
  if (AI_CONVERSATION_GROWTH_POINTS.length === 0) return [];
  if (focusMs == null) {
    const latest = AI_CONVERSATION_PERIOD_ENDS_MS[AI_CONVERSATION_PERIOD_ENDS_MS.length - 1]!;
    return AI_CONVERSATION_GROWTH_POINTS.filter((p) => p.periodEndMs === latest);
  }
  // Nearest period end at or before focus; if before first wave, empty (missing ≠ early).
  let period: number | null = null;
  for (const t of AI_CONVERSATION_PERIOD_ENDS_MS) {
    if (t <= focusMs) period = t;
  }
  if (period == null) return [];
  return AI_CONVERSATION_GROWTH_POINTS.filter((p) => p.periodEndMs === period);
}
`;

  fs.writeFileSync(OUT, body, 'utf8');
  console.log(
    `Wrote ${points.length} points (${wildchatAdded} WildChat), ${periods.length} periods → ${path.relative(ROOT, OUT)} (owid skipped ${skipped}, wildchat skipped ${wildchatSkipped})`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
