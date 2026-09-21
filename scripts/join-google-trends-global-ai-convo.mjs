/**
 * Join Google Trends global "Interest over time" (monthly) onto Convo landmark meta.
 *
 * Source file (user export): scripts/_trends-ai-convo/ai-global-interest-over-time.csv
 * Columns: Month,Interest over time (AI: Global)
 *
 * This series has TIME + AMOUNT but NO location — do not invent country pins.
 * Interest-by-region CSVs (country,iso2,interest per landmark) remain required
 * for the trends map channel.
 *
 * Usage:
 *   node scripts/join-google-trends-global-ai-convo.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CSV = path.join(__dirname, '_trends-ai-convo', 'ai-global-interest-over-time.csv');
const OUT_SERIES = path.join(ROOT, 'src/config/ai-trends-global.ts');
const OUT_CONVO = path.join(ROOT, 'src/config/ai-convo-hotspots.ts');

const LANDMARKS = [
  { id: 'chatgpt', ms: Date.UTC(2022, 10, 30), headline: 'ChatGPT' },
  { id: 'msft-openai-2023', ms: Date.UTC(2023, 0, 23), headline: 'MSFT–OpenAI' },
  { id: 'gpt4-claude', ms: Date.UTC(2023, 2, 14), headline: 'GPT-4 · Claude' },
  { id: 'llama2', ms: Date.UTC(2023, 6, 18), headline: 'Llama 2' },
  { id: 'devday-2023', ms: Date.UTC(2023, 10, 6), headline: 'DevDay' },
  { id: 'gpt4o', ms: Date.UTC(2024, 4, 13), headline: 'GPT-4o' },
  { id: 'claude-35-sonnet', ms: Date.UTC(2024, 5, 21), headline: 'Claude 3.5' },
];

const SOURCE =
  'Google Trends — Interest over time, query AI, worldwide (user export)';

function parseGlobalCsv(text) {
  const lines = text.trim().split(/\r?\n/).slice(1);
  /** @type {Map<string, number>} */
  const byMonth = new Map();
  for (const line of lines) {
    const [month, raw] = line.split(',');
    const interest = Number(raw);
    if (!month || !Number.isFinite(interest)) continue;
    byMonth.set(month.trim(), interest);
  }
  return byMonth;
}

function monthKey(ms) {
  const d = new Date(ms);
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${d.getUTCFullYear()}-${m}`;
}

function interestAt(byMonth, ms) {
  const key = monthKey(ms);
  if (byMonth.has(key)) return byMonth.get(key);
  return null;
}

function main() {
  if (!fs.existsSync(CSV)) {
    console.error('Missing', CSV);
    process.exit(1);
  }
  const byMonth = parseGlobalCsv(fs.readFileSync(CSV, 'utf8'));
  const series = [...byMonth.entries()]
    .map(([month, interest]) => ({ month, interest }))
    .sort((a, b) => a.month.localeCompare(b.month));

  const landmarkInterest = LANDMARKS.map((lm) => ({
    landmarkId: lm.id,
    headline: lm.headline,
    landmarkMs: lm.ms,
    month: monthKey(lm.ms),
    interest: interestAt(byMonth, lm.ms),
  }));

  fs.writeFileSync(
    OUT_SERIES,
    `/**
 * Google Trends global Interest over time for query "AI" (worldwide).
 *
 * Source: scripts/_trends-ai-convo/ai-global-interest-over-time.csv
 * Cite: ${SOURCE}
 *
 * Global series only — no country dimension. Do not invent regional pins from this.
 * Regenerate: node scripts/join-google-trends-global-ai-convo.mjs
 */

export type AiTrendsGlobalPoint = {
  month: string; // YYYY-MM
  interest: number; // 0–100
};

export type AiTrendsLandmarkInterest = {
  landmarkId: string;
  headline: string;
  landmarkMs: number;
  month: string;
  /** null when export has no row for that month (e.g. ChatGPT pre-2023) */
  interest: number | null;
};

export const AI_TRENDS_GLOBAL_SOURCE = ${JSON.stringify(SOURCE)};

export const AI_TRENDS_GLOBAL_SERIES: readonly AiTrendsGlobalPoint[] = ${JSON.stringify(series, null, 2)};

export const AI_TRENDS_LANDMARK_INTEREST: readonly AiTrendsLandmarkInterest[] = ${JSON.stringify(landmarkInterest, null, 2)};

export function aiTrendsGlobalAtMs(ms: number): number | null {
  const d = new Date(ms);
  const key = \`\${d.getUTCFullYear()}-\${String(d.getUTCMonth() + 1).padStart(2, '0')}\`;
  const hit = AI_TRENDS_GLOBAL_SERIES.find((p) => p.month === key);
  return hit?.interest ?? null;
}
`,
    'utf8',
  );
  console.log('wrote', OUT_SERIES, 'months', series.length);

  // Patch Convo meta gaps / globalTrendsInterest without rewriting wiki points
  if (!fs.existsSync(OUT_CONVO)) {
    console.warn('No ai-convo-hotspots.ts yet — series only');
    return;
  }
  let text = fs.readFileSync(OUT_CONVO, 'utf8');

  // Ensure type includes optional globalTrendsInterest
  if (!text.includes('globalTrendsInterest')) {
    text = text.replace(
      '  gaps: string[];\n};',
      '  gaps: string[];\n  /** Google Trends worldwide AI interest 0–100 for landmark month; null if export has no row */\n  globalTrendsInterest?: number | null;\n};',
    );
  }

  const metaMatch = text.match(
    /export const AI_CONVO_HOTSPOT_META: readonly AiConvoLandmarkMeta\[\] = (\[[\s\S]*?\]);/,
  );
  if (!metaMatch) {
    console.warn('Could not find AI_CONVO_HOTSPOT_META');
    fs.writeFileSync(OUT_CONVO, text, 'utf8');
    return;
  }
  const meta = JSON.parse(metaMatch[1]);
  for (const row of meta) {
    const hit = landmarkInterest.find((l) => l.landmarkId === row.landmarkId);
    row.globalTrendsInterest = hit ? hit.interest : null;
    const gaps = Array.isArray(row.gaps) ? [...row.gaps] : [];
    const filtered = gaps.filter(
      (g) =>
        !/Google Trends interest-by-country/i.test(g) &&
        !/Google Trends\/CSE/i.test(g),
    );
    // Still need by-country for map channel
    filtered.push(
      'Google Trends interest-by-region CSV required for trends map pins (this export is global time series only)',
    );
    row.gaps = [...new Set(filtered)];
  }
  text = text.replace(
    metaMatch[0],
    `export const AI_CONVO_HOTSPOT_META: readonly AiConvoLandmarkMeta[] = ${JSON.stringify(meta, null, 2)};`,
  );

  // Header note
  if (!text.includes('ai-global-interest-over-time.csv')) {
    text = text.replace(
      ' * - `trends` — Google Trends CSV join when present (not invented).',
      ' * - `trends` — country pins from interest-by-region CSVs (not invented).\n * - Global AI interest over time: `ai-trends-global.ts` (no geo).',
    );
  }

  fs.writeFileSync(OUT_CONVO, text, 'utf8');
  console.log('updated', OUT_CONVO);
  for (const l of landmarkInterest) {
    console.log(`  ${l.landmarkId} ${l.month}: ${l.interest ?? 'null (pre-export)'}`);
  }
}

main();
