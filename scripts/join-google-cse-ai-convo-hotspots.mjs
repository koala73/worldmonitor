/**
 * Optional Google Custom Search join for Convo Hotspots `trends` channel.
 *
 * Pulls estimated totalResults by country (`cr=countryXX`) for each product-era
 * keyword window. Google documents totalResults as an estimate — we store it
 * with that caveat; missing key/country ≠ invent.
 *
 * Requires:
 *   GOOGLE_CSE_API_KEY
 *   GOOGLE_CSE_CX          (Programmable Search Engine id)
 *
 * Usage (from apps/worldmonitor):
 *   node scripts/join-google-cse-ai-convo-hotspots.mjs
 *
 * Writes/merges into src/config/ai-convo-hotspots.ts (channel: trends).
 * Also caches CSVs under scripts/_trends-ai-convo/<landmarkId>.csv
 *
 * Historical absolute ranges use sort=date:r:YYYYMMDD:YYYYMMDD (approximate).
 * Without API keys the script exits 0 and leaves the catalog unchanged.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CENT = path.join(__dirname, '_country-centroids.csv');
const TRENDS_DIR = path.join(__dirname, '_trends-ai-convo');
const OUT = path.join(ROOT, 'src/config/ai-convo-hotspots.ts');
const RAW_DIR = path.join(__dirname, '_google-cse-ai-convo-raw');

const API_KEY = process.env.GOOGLE_CSE_API_KEY || '';
const CX = process.env.GOOGLE_CSE_CX || '';

const COUNTRIES = [
  'US', 'GB', 'CA', 'AU', 'DE', 'FR', 'IN', 'JP', 'BR', 'KR', 'MX', 'IT', 'ES',
  'NL', 'SE', 'PL', 'ID', 'TR', 'SA', 'AE', 'SG', 'ZA', 'NG', 'AR', 'CL',
];

const WINDOWS = [
  {
    id: 'chatgpt',
    ms: Date.UTC(2022, 10, 30),
    headline: 'ChatGPT',
    q: 'ChatGPT',
    days: 7,
  },
  {
    id: 'msft-openai-2023',
    ms: Date.UTC(2023, 0, 23),
    headline: 'MSFT–OpenAI',
    q: 'ChatGPT OR "Microsoft OpenAI"',
    days: 7,
  },
  {
    id: 'gpt4-claude',
    ms: Date.UTC(2023, 2, 14),
    headline: 'GPT-4 · Claude',
    q: 'GPT-4 OR "Claude AI"',
    days: 7,
  },
  {
    id: 'llama2',
    ms: Date.UTC(2023, 6, 18),
    headline: 'Llama 2',
    q: '"Llama 2" OR Llama2',
    days: 7,
  },
  {
    id: 'devday-2023',
    ms: Date.UTC(2023, 10, 6),
    headline: 'DevDay',
    q: 'OpenAI DevDay OR "GPT-4 Turbo"',
    days: 7,
  },
  {
    id: 'gpt4o',
    ms: Date.UTC(2024, 4, 13),
    headline: 'GPT-4o',
    q: 'GPT-4o OR "GPT 4o"',
    days: 7,
  },
  {
    id: 'claude-35-sonnet',
    ms: Date.UTC(2024, 5, 21),
    headline: 'Claude 3.5',
    q: '"Claude 3.5" OR "Claude 3.5 Sonnet"',
    days: 7,
  },
];

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function ymd(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`;
}

function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  const rows = [];
  for (let li = 1; li < lines.length; li++) {
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

function loadCentroids() {
  const map = new Map();
  for (const r of parseCsv(fs.readFileSync(CENT, 'utf8'))) {
    const iso2 = (r[0] || '').trim();
    const lat = Number(r[1]);
    const lon = Number(r[2]);
    const name = (r[3] || '').trim();
    if (!iso2 || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    map.set(iso2, { lat, lon, name: name || iso2 });
  }
  return map;
}

async function cseTotal(q, iso2, startYmd, endYmd) {
  const params = new URLSearchParams({
    key: API_KEY,
    cx: CX,
    q,
    cr: `country${iso2}`,
    num: '1',
    sort: `date:r:${startYmd}:${endYmd}`,
  });
  const url = `https://www.googleapis.com/customsearch/v1?${params}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'WorldMonitor-AI-ConvoHotspots/1.0' },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`CSE ${res.status}: ${text.slice(0, 160)}`);
  }
  const json = JSON.parse(text);
  const total = Number(json.searchInformation?.totalResults || 0);
  return Number.isFinite(total) ? total : 0;
}

function loadCatalogPoints() {
  if (!fs.existsSync(OUT)) return [];
  const text = fs.readFileSync(OUT, 'utf8');
  const m = text.match(
    /export const AI_CONVO_HOTSPOT_POINTS: readonly AiConvoHotspotPoint\[\] = (\[[\s\S]*?\]);/,
  );
  if (!m) return [];
  try {
    return JSON.parse(m[1]);
  } catch {
    return [];
  }
}

function writeCatalog(points) {
  const ends = [...new Set(points.map((p) => p.landmarkMs))].sort((a, b) => a - b);
  const landmarkIds = [...new Set(points.map((p) => p.landmarkId))];
  const meta = landmarkIds.map((id) => {
    const subset = points.filter((p) => p.landmarkId === id);
    const ms = subset[0]?.landmarkMs ?? 0;
    const headline = WINDOWS.find((w) => w.id === id)?.headline ?? id;
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
    const gaps = [];
    if (!channels.trends) gaps.push('Google Trends/CSE join required');
    if (!channels.news) gaps.push('GDELT or live AI news geo required');
    if (!channels.social) gaps.push('Social geotag corpus required');
    return {
      landmarkId: id,
      headline,
      landmarkMs: ms,
      windowDays: 7,
      channels,
      gaps,
    };
  });

  const body = `/**
 * AI Convo Hotspots — attention around product-era timeline windows.
 *
 * Regenerated by wiki-country / Google CSE / GDELT join scripts.
 * Missing channel ≠ invent.
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
};

export const AI_CONVO_HOTSPOT_META: readonly AiConvoLandmarkMeta[] = ${JSON.stringify(meta, null, 2)};

export const AI_CONVO_HOTSPOT_POINTS: readonly AiConvoHotspotPoint[] = ${JSON.stringify(points, null, 2)};

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
`;
  fs.writeFileSync(OUT, body, 'utf8');
}

async function main() {
  if (!API_KEY || !CX) {
    console.log(
      'GOOGLE_CSE_API_KEY / GOOGLE_CSE_CX not set — skipping (missing ≠ invent).',
    );
    console.log(
      'Create a Programmable Search Engine + API key, then re-run this script.',
    );
    process.exit(0);
  }

  fs.mkdirSync(TRENDS_DIR, { recursive: true });
  fs.mkdirSync(RAW_DIR, { recursive: true });
  const centroids = loadCentroids();
  const prior = loadCatalogPoints().filter((p) => p.channel !== 'trends');
  const trendsPoints = [];

  for (const win of WINDOWS) {
    console.log(`window ${win.id}…`);
    const start = ymd(win.ms);
    const end = ymd(win.ms + win.days * 86400000);
    const csvRows = ['country,iso2,interest'];
    for (const iso2 of COUNTRIES) {
      const cent = centroids.get(iso2);
      if (!cent) continue;
      await sleep(350);
      let total = 0;
      try {
        total = await cseTotal(win.q, iso2, start, end);
      } catch (e) {
        console.warn(`  ${iso2}:`, e.message);
        continue;
      }
      if (total <= 0) continue;
      // Cap display weight so one huge US estimate does not crush the map
      const weight = Math.min(100, Math.round(Math.log10(total + 1) * 25));
      csvRows.push(`${cent.name},${iso2},${weight}`);
      trendsPoints.push({
        id: `convo-trends-${win.id}-${iso2}`,
        landmarkId: win.id,
        landmarkMs: win.ms,
        channel: 'trends',
        iso2,
        iso3: '',
        name: cent.name,
        lat: cent.lat,
        lon: cent.lon,
        weight,
        detail: `Google CSE ~${total.toLocaleString()} results (${start}–${end}, estimate)`,
        sourceUrl: 'https://developers.google.com/custom-search',
      });
      console.log(`  ${iso2}: ~${total}`);
    }
    fs.writeFileSync(
      path.join(TRENDS_DIR, `${win.id}.csv`),
      csvRows.join('\n') + '\n',
      'utf8',
    );
  }

  const seen = new Set();
  const merged = [];
  for (const p of [...prior, ...trendsPoints]) {
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    merged.push(p);
  }
  writeCatalog(merged);
  console.log('wrote', OUT, 'trends points', trendsPoints.length);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
