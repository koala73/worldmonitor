/**
 * Join Google Trends exports into Convo Hotspots:
 * - time_series_*.csv → ai-trends-global.ts (monthly worldwide interest)
 * - by_region_*.csv → trends channel country pins on each product landmark
 *
 * The by-region export is ONE relative ranking for the whole selected Trends
 * window (not per-month). We place the same geo pattern on each landmark and
 * scale weight by that landmark month's global interest (intensity varies in
 * time; relative geography is the period average). Missing region coords → skip.
 *
 * Usage:
 *   node scripts/join-google-trends-exports-ai-convo.mjs [regionCsv] [timeCsv]
 *
 * Defaults to scripts/_trends-ai-convo/ copies of the user Downloads exports.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const TRENDS_DIR = path.join(__dirname, '_trends-ai-convo');
const ISO = path.join(__dirname, '_iso3166.csv');
const CENT = path.join(__dirname, '_country-centroids.csv');
const OUT_SERIES = path.join(ROOT, 'src/config/ai-trends-global.ts');
const OUT_CONVO = path.join(ROOT, 'src/config/ai-convo-hotspots.ts');

const SOURCE =
  'Google Trends — query "artificial intelligence", worldwide; Interest over time + Interest by region (user export 2023-01-01 … 2026-09-21)';

const LANDMARKS = [
  { id: 'chatgpt', ms: Date.UTC(2022, 10, 30), headline: 'ChatGPT' },
  { id: 'msft-openai-2023', ms: Date.UTC(2023, 0, 23), headline: 'MSFT–OpenAI' },
  { id: 'gpt4-claude', ms: Date.UTC(2023, 2, 14), headline: 'GPT-4 · Claude' },
  { id: 'llama2', ms: Date.UTC(2023, 6, 18), headline: 'Llama 2' },
  { id: 'devday-2023', ms: Date.UTC(2023, 10, 6), headline: 'DevDay' },
  { id: 'gpt4o', ms: Date.UTC(2024, 4, 13), headline: 'GPT-4o' },
  { id: 'claude-35-sonnet', ms: Date.UTC(2024, 5, 21), headline: 'Claude 3.5' },
];

const REGION_ALIASES = {
  'united states': 'United States of America',
  'united kingdom': 'United Kingdom of Great Britain and Northern Ireland',
  'south korea': 'Korea, Republic of',
  'north korea': "Korea, Democratic People's Republic of",
  russia: 'Russian Federation',
  vietnam: 'Viet Nam',
  iran: 'Iran, Islamic Republic of',
  syria: 'Syrian Arab Republic',
  tanzania: 'Tanzania, United Republic of',
  bolivia: 'Bolivia, Plurinational State of',
  venezuela: 'Venezuela, Bolivarian Republic of',
  moldova: 'Moldova, Republic of',
  'czech republic': 'Czechia',
  taiwan: 'Taiwan, Province of China',
  palestine: 'Palestine, State of',
  brunei: 'Brunei Darussalam',
  laos: "Lao People's Democratic Republic",
  'hong kong': 'Hong Kong',
  macau: 'Macao',
  macao: 'Macao',
  'st. helena': 'Saint Helena, Ascension and Tristan da Cunha',
  'saint helena': 'Saint Helena, Ascension and Tristan da Cunha',
  "cote d'ivoire": "Côte d'Ivoire",
  'ivory coast': "Côte d'Ivoire",
  myanmar: 'Myanmar',
  türkiye: 'Türkiye',
  turkiye: 'Türkiye',
  turkey: 'Türkiye',
  netherlands: 'Netherlands, Kingdom of the',
  'u.s. virgin islands': 'Virgin Islands, U.S.',
};

function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  const rows = [];
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
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
    rows.push(cols);
  }
  return rows;
}

function loadIsoByName() {
  const rows = parseCsv(fs.readFileSync(ISO, 'utf8'));
  const byName = new Map();
  for (const r of rows.slice(1)) {
    const name = (r[0] || '').trim();
    const alpha2 = (r[1] || '').trim();
    const alpha3 = (r[2] || '').trim();
    if (!name || !alpha2) continue;
    byName.set(name.toLowerCase(), { alpha2, alpha3, name });
  }
  for (const [alias, formal] of Object.entries(REGION_ALIASES)) {
    const hit = byName.get(formal.toLowerCase());
    if (hit) byName.set(alias, hit);
  }
  const us = [...byName.values()].find((x) => x.alpha2 === 'US');
  if (us) byName.set('united states', us);
  const gb = [...byName.values()].find((x) => x.alpha2 === 'GB');
  if (gb) byName.set('united kingdom', gb);
  const kr = [...byName.values()].find((x) => x.alpha2 === 'KR');
  if (kr) byName.set('south korea', kr);
  const hk = [...byName.values()].find((x) => x.alpha2 === 'HK');
  if (hk) byName.set('hong kong', hk);
  return byName;
}

function loadCentroids() {
  const rows = parseCsv(fs.readFileSync(CENT, 'utf8'));
  const map = new Map();
  for (const r of rows.slice(1)) {
    const alpha2 = (r[0] || '').trim();
    const lat = Number(r[1]);
    const lon = Number(r[2]);
    const name = (r[3] || '').trim();
    if (!alpha2 || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    map.set(alpha2, { lat, lon, name: name || alpha2 });
  }
  return map;
}

function parseTimeSeries(text) {
  const rows = parseCsv(text);
  const byMonth = new Map();
  for (const r of rows.slice(1)) {
    const raw = (r[0] || '').trim();
    const interest = Number(r[1]);
    if (!raw || !Number.isFinite(interest)) continue;
    // "2023-01-01" → "2023-01"
    const month = raw.slice(0, 7);
    byMonth.set(month, interest);
  }
  return byMonth;
}

function parseRegions(text, byName, centroids) {
  const rows = parseCsv(text);
  const out = [];
  let unmapped = 0;
  for (const r of rows.slice(1)) {
    const region = (r[0] || '').trim();
    const interest = Number(r[1]);
    if (!region || !Number.isFinite(interest) || interest <= 0) continue;
    const hit = byName.get(region.toLowerCase());
    if (!hit) {
      unmapped++;
      console.warn('  unmapped region:', region);
      continue;
    }
    const cent = centroids.get(hit.alpha2);
    if (!cent) {
      unmapped++;
      console.warn('  no centroid:', region, hit.alpha2);
      continue;
    }
    out.push({
      iso2: hit.alpha2,
      iso3: hit.alpha3,
      name: cent.name,
      lat: cent.lat,
      lon: cent.lon,
      interest,
      regionLabel: region,
    });
  }
  return { regions: out, unmapped };
}

function monthKey(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function loadPriorNonTrends() {
  if (!fs.existsSync(OUT_CONVO)) return [];
  const text = fs.readFileSync(OUT_CONVO, 'utf8');
  const m = text.match(
    /export const AI_CONVO_HOTSPOT_POINTS: readonly AiConvoHotspotPoint\[\] = (\[[\s\S]*?\]);/,
  );
  if (!m) return [];
  try {
    return JSON.parse(m[1]).filter((p) => p.channel !== 'trends');
  } catch {
    return [];
  }
}

function emitSeries(byMonth) {
  const series = [...byMonth.entries()]
    .map(([month, interest]) => ({ month, interest }))
    .sort((a, b) => a.month.localeCompare(b.month));
  const landmarkInterest = LANDMARKS.map((lm) => ({
    landmarkId: lm.id,
    headline: lm.headline,
    landmarkMs: lm.ms,
    month: monthKey(lm.ms),
    interest: byMonth.has(monthKey(lm.ms)) ? byMonth.get(monthKey(lm.ms)) : null,
  }));
  fs.writeFileSync(
    OUT_SERIES,
    `/**
 * Google Trends Interest over time — query "artificial intelligence", worldwide.
 *
 * Source: scripts/_trends-ai-convo/time_series_Worldwide_*.csv
 * Cite: ${SOURCE}
 *
 * Regenerate: node scripts/join-google-trends-exports-ai-convo.mjs
 */

export type AiTrendsGlobalPoint = {
  month: string;
  interest: number;
};

export type AiTrendsLandmarkInterest = {
  landmarkId: string;
  headline: string;
  landmarkMs: number;
  month: string;
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
  return { series, landmarkInterest };
}

function emitConvo(prior, regions, byMonth, landmarkInterest) {
  const maxGlobal = Math.max(1, ...[...byMonth.values()]);
  const trendsPoints = [];
  for (const lm of LANDMARKS) {
    const g = byMonth.get(monthKey(lm.ms));
    // ChatGPT Nov 2022: use Dec 2022 row if present (nearest in export)
    let globalInterest = g ?? null;
    if (globalInterest == null && lm.id === 'chatgpt') {
      globalInterest = byMonth.get('2022-12') ?? null;
    }
    const scale = globalInterest == null ? 0 : globalInterest / maxGlobal;
    if (scale <= 0) continue;
    for (const r of regions) {
      const weight = Math.max(1, Math.round(r.interest * scale));
      trendsPoints.push({
        id: `convo-trends-${lm.id}-${r.iso2}`,
        landmarkId: lm.id,
        landmarkMs: lm.ms,
        channel: 'trends',
        iso2: r.iso2,
        iso3: r.iso3,
        name: r.name,
        lat: r.lat,
        lon: r.lon,
        weight,
        detail: `Trends AI interest ${r.interest} (region, period avg) × global ${globalInterest} → ${weight}`,
        sourceUrl: 'https://trends.google.com/trends/explore?q=artificial%20intelligence',
      });
    }
  }

  const allPoints = [...prior, ...trendsPoints];
  const ends = [...new Set(allPoints.map((p) => p.landmarkMs))].sort(
    (a, b) => a - b,
  );

  const meta = LANDMARKS.map((lm) => {
    const subset = allPoints.filter((p) => p.landmarkMs === lm.ms);
    const channels = {};
    for (const ch of ['wiki', 'trends', 'news', 'social']) {
      const s = subset.filter((p) => p.channel === ch);
      if (s.length) {
        channels[ch] = {
          pointCount: s.length,
          weightSum: s.reduce((a, p) => a + p.weight, 0),
        };
      }
    }
    const li = landmarkInterest.find((x) => x.landmarkId === lm.id);
    const gaps = [];
    if (!channels.news) gaps.push('GDELT or live AI news geo required');
    if (!channels.social) gaps.push('Social geotag corpus required');
    if (!channels.trends) {
      gaps.push('No Trends month row for this landmark (or scale=0)');
    } else {
      gaps.push(
        'Trends region ranks are period-average (2023-01…2026-09), scaled by monthly global interest — not per-era geo',
      );
    }
    return {
      landmarkId: lm.id,
      headline: lm.headline,
      landmarkMs: lm.ms,
      windowDays: 7,
      channels,
      gaps,
      globalTrendsInterest:
        li?.interest ??
        (lm.id === 'chatgpt' ? byMonth.get('2022-12') ?? null : null),
    };
  });

  fs.writeFileSync(
    OUT_CONVO,
    `/**
 * AI Convo Hotspots — attention around product-era timeline windows.
 *
 * Channels:
 * - \`wiki\` — Wikimedia top-per-country pageviews
 * - \`trends\` — Google Trends by region (period avg) × monthly global interest
 * - \`news\` / \`social\` — required joins (missing ≠ invent)
 *
 * Regenerate Trends: node scripts/join-google-trends-exports-ai-convo.mjs
 * Regenerate wiki: node scripts/join-wiki-country-ai-convo-hotspots.mjs
 */

export type AiConvoChannel = 'wiki' | 'trends' | 'news' | 'social';

export type AiConvoHotspotPoint = {
  id: string;
  landmarkId: string;
  landmarkMs: number;
  channel: AiConvoChannel;
  iso2: string;
  iso3: string;
  name: string;
  lat: number;
  lon: number;
  weight: number;
  detail: string;
  sourceUrl: string;
};

export type AiConvoLandmarkMeta = {
  landmarkId: string;
  headline: string;
  landmarkMs: number;
  windowDays: number;
  channels: Partial<Record<AiConvoChannel, { pointCount: number; weightSum: number }>>;
  gaps: string[];
  globalTrendsInterest?: number | null;
};

export const AI_CONVO_HOTSPOT_META: readonly AiConvoLandmarkMeta[] = ${JSON.stringify(meta, null, 2)};

export const AI_CONVO_HOTSPOT_POINTS: readonly AiConvoHotspotPoint[] = ${JSON.stringify(allPoints, null, 2)};

export const AI_CONVO_LANDMARK_MS: readonly number[] = ${JSON.stringify(ends)};

export function aiConvoHotspotPointsAt(focusMs: number | null): AiConvoHotspotPoint[] {
  if (AI_CONVO_HOTSPOT_POINTS.length === 0) return [];
  if (focusMs == null) {
    let latest: number | null = null;
    for (const t of AI_CONVO_LANDMARK_MS) {
      if (AI_CONVO_HOTSPOT_POINTS.some((p) => p.landmarkMs === t)) latest = t;
    }
    if (latest == null) return [];
    return AI_CONVO_HOTSPOT_POINTS.filter((p) => p.landmarkMs === latest);
  }
  if (!AI_CONVO_LANDMARK_MS.includes(focusMs)) return [];
  return AI_CONVO_HOTSPOT_POINTS.filter((p) => p.landmarkMs === focusMs);
}
`,
    'utf8',
  );
  return trendsPoints.length;
}

function main() {
  fs.mkdirSync(TRENDS_DIR, { recursive: true });
  const regionSrc =
    process.argv[2] ||
    path.join(
      TRENDS_DIR,
      'by_region_Worldwide_20230101-0000_20260921-1609.csv',
    );
  const timeSrc =
    process.argv[3] ||
    path.join(
      TRENDS_DIR,
      'time_series_Worldwide_20230101-0000_20260921-1609.csv',
    );

  // Prefer CLI paths (Downloads); copy into repo for reproducibility
  const regionIn = fs.existsSync(process.argv[2] || '')
    ? process.argv[2]
    : fs.existsSync(regionSrc)
      ? regionSrc
      : null;
  const timeIn = fs.existsSync(process.argv[3] || '')
    ? process.argv[3]
    : fs.existsSync(timeSrc)
      ? timeSrc
      : null;

  const regionPath = process.argv[2] && fs.existsSync(process.argv[2])
    ? process.argv[2]
    : regionIn;
  const timePath = process.argv[3] && fs.existsSync(process.argv[3])
    ? process.argv[3]
    : timeIn;

  if (!regionPath || !timePath) {
    console.error('Need region + time CSV paths');
    process.exit(1);
  }

  const regionDest = path.join(
    TRENDS_DIR,
    'by_region_Worldwide_20230101-0000_20260921-1609.csv',
  );
  const timeDest = path.join(
    TRENDS_DIR,
    'time_series_Worldwide_20230101-0000_20260921-1609.csv',
  );
  fs.copyFileSync(regionPath, regionDest);
  fs.copyFileSync(timePath, timeDest);

  const byName = loadIsoByName();
  const centroids = loadCentroids();
  const byMonth = parseTimeSeries(fs.readFileSync(timeDest, 'utf8'));
  const { regions, unmapped } = parseRegions(
    fs.readFileSync(regionDest, 'utf8'),
    byName,
    centroids,
  );
  console.log('regions', regions.length, 'unmapped', unmapped);
  console.log('months', byMonth.size);

  const { landmarkInterest } = emitSeries(byMonth);
  const prior = loadPriorNonTrends();
  const n = emitConvo(prior, regions, byMonth, landmarkInterest);
  console.log('wrote trends points', n, 'kept prior', prior.length);
  for (const l of landmarkInterest) {
    console.log(`  ${l.landmarkId} ${l.month}: ${l.interest ?? 'null'}`);
  }
}

main();
