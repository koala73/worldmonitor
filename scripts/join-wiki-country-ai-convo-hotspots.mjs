/**
 * Scrape Wikimedia top-per-country pageviews for AI product-era windows onto
 * Convo Hotspots (wiki channel) — real country locations + views_ceil amounts.
 *
 * Endpoint: /metrics/pageviews/top-per-country/{country}/all-access/{y}/{m}/{d}
 * Cite: Wikimedia Analytics API (CC0). Missing country day = no row (missing ≠ invent).
 *
 * Google Trends / GDELT / social: not invented here. Optional merges:
 *   scripts/_trends-ai-convo/<id>.csv
 *   join-gdelt-ai-convo-hotspots.mjs
 *
 * Usage (from apps/worldmonitor):
 *   node scripts/join-wiki-country-ai-convo-hotspots.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CENT = path.join(__dirname, '_country-centroids.csv');
const RAW_DIR = path.join(__dirname, '_wiki-country-ai-convo-raw');
const TRENDS_DIR = path.join(__dirname, '_trends-ai-convo');
const OUT = path.join(ROOT, 'src/config/ai-convo-hotspots.ts');
const UA =
  'WorldMonitor-AI-ConvoHotspots/1.0 (https://www.worldmonitor.app; research join)';

/** Major + high-coverage ISO2 set (centroids must exist). */
const COUNTRIES = [
  'US', 'GB', 'CA', 'AU', 'NZ', 'IE', 'DE', 'FR', 'ES', 'IT', 'NL', 'BE', 'CH',
  'AT', 'SE', 'NO', 'DK', 'FI', 'PL', 'CZ', 'PT', 'GR', 'RO', 'HU', 'UA', 'RU',
  'TR', 'IL', 'SA', 'AE', 'EG', 'ZA', 'NG', 'KE', 'IN', 'PK', 'BD', 'LK', 'CN',
  'JP', 'KR', 'TW', 'HK', 'SG', 'MY', 'ID', 'TH', 'VN', 'PH', 'BR', 'MX', 'AR',
  'CL', 'CO', 'PE', 'UY', 'CR', 'PA',
];

const WINDOWS = [
  {
    id: 'chatgpt',
    ms: Date.UTC(2022, 10, 30),
    headline: 'ChatGPT',
    days: 7,
    needles: ['chatgpt'],
  },
  {
    id: 'msft-openai-2023',
    ms: Date.UTC(2023, 0, 23),
    headline: 'MSFT–OpenAI',
    days: 7,
    needles: ['chatgpt', 'openai'],
  },
  {
    id: 'gpt4-claude',
    ms: Date.UTC(2023, 2, 14),
    headline: 'GPT-4 · Claude',
    days: 7,
    needles: ['gpt-4', 'gpt_4', 'claude'],
  },
  {
    id: 'llama2',
    ms: Date.UTC(2023, 6, 18),
    headline: 'Llama 2',
    days: 7,
    needles: ['llama_2', 'llama 2', 'llama2'],
  },
  {
    id: 'devday-2023',
    ms: Date.UTC(2023, 10, 6),
    headline: 'DevDay',
    days: 7,
    needles: ['openai', 'chatgpt', 'gpt-4'],
  },
  {
    id: 'gpt4o',
    ms: Date.UTC(2024, 4, 13),
    headline: 'GPT-4o',
    days: 7,
    needles: ['gpt-4o', 'gpt_4o', 'chatgpt'],
  },
  {
    id: 'claude-35-sonnet',
    ms: Date.UTC(2024, 5, 21),
    headline: 'Claude 3.5',
    days: 7,
    needles: ['claude'],
  },
];

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function ymdParts(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return {
    y: String(d.getUTCFullYear()),
    m: p(d.getUTCMonth() + 1),
    d: p(d.getUTCDate()),
    stamp: `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`,
  };
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
  const rows = parseCsv(fs.readFileSync(CENT, 'utf8'));
  const map = new Map();
  for (const r of rows) {
    const alpha2 = (r[0] || '').trim();
    const lat = Number(r[1]);
    const lon = Number(r[2]);
    const name = (r[3] || '').trim();
    if (!alpha2 || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    map.set(alpha2, { lat, lon, name: name || alpha2 });
  }
  return map;
}

async function fetchTop(country, y, m, d) {
  fs.mkdirSync(RAW_DIR, { recursive: true });
  const cache = path.join(RAW_DIR, `${country}-${y}${m}${d}.json`);
  if (fs.existsSync(cache) && fs.statSync(cache).size > 20) {
    return JSON.parse(fs.readFileSync(cache, 'utf8'));
  }
  const url = `https://wikimedia.org/api/rest_v1/metrics/pageviews/top-per-country/${country}/all-access/${y}/${m}/${d}`;
  let lastErr = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt) await sleep(400 * attempt);
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
    });
    if (res.status === 404) {
      fs.writeFileSync(cache, '{"items":[]}', 'utf8');
      return { items: [] };
    }
    if (res.status === 429) {
      lastErr = new Error('429');
      await sleep(1500 * (attempt + 1));
      continue;
    }
    if (!res.ok) {
      lastErr = new Error(String(res.status));
      continue;
    }
    const json = await res.json();
    fs.writeFileSync(cache, JSON.stringify(json), 'utf8');
    return json;
  }
  throw lastErr ?? new Error(`fetch failed ${country} ${y}${m}${d}`);
}

function matchArticles(json, needles) {
  const arts = json.items?.[0]?.articles || [];
  const hits = [];
  for (const a of arts) {
    const title = String(a.article || '').toLowerCase().replace(/_/g, ' ');
    if (!needles.some((n) => title.includes(n.replace(/_/g, ' ')))) continue;
    hits.push({
      article: String(a.article),
      project: String(a.project || ''),
      views: Number(a.views_ceil) || 0,
      rank: Number(a.rank) || 0,
    });
  }
  return hits;
}

function loadTrendsPoints(win, centroids) {
  const file = path.join(TRENDS_DIR, `${win.id}.csv`);
  if (!fs.existsSync(file)) return [];
  const rows = parseCsv(fs.readFileSync(file, 'utf8'));
  const out = [];
  for (const r of rows) {
    const iso2 = (r[1] || r[0] || '').trim().toUpperCase();
    const interest = Number(r[2] ?? r[1]);
    const cent = centroids.get(iso2);
    if (!cent || !Number.isFinite(interest) || interest <= 0) continue;
    out.push({
      id: `convo-trends-${win.id}-${iso2}`,
      landmarkId: win.id,
      landmarkMs: win.ms,
      channel: 'trends',
      iso2,
      iso3: '',
      name: cent.name,
      lat: cent.lat,
      lon: cent.lon,
      weight: interest,
      detail: `Google Trends interest ${interest}`,
      sourceUrl: 'https://trends.google.com/trends/',
    });
  }
  return out;
}

function loadPriorNonWiki() {
  if (!fs.existsSync(OUT)) return [];
  const text = fs.readFileSync(OUT, 'utf8');
  const m = text.match(
    /export const AI_CONVO_HOTSPOT_POINTS: readonly AiConvoHotspotPoint\[\] = (\[[\s\S]*?\]);/,
  );
  if (!m) return [];
  try {
    return JSON.parse(m[1]).filter((p) => p.channel !== 'wiki');
  } catch {
    return [];
  }
}

function emitTs(meta, points) {
  const ends = [...new Set(points.map((p) => p.landmarkMs))].sort((a, b) => a - b);
  return `/**
 * AI Convo Hotspots — attention around product-era timeline windows.
 *
 * Channels:
 * - \`wiki\` — Wikimedia top-per-country pageviews (views_ceil) for AI article titles
 *   in each landmark's 7-day window. Real country ISO2 + centroid. CC0.
 * - \`trends\` — Google Trends CSV join when present (not invented).
 * - \`news\` — GDELT join when present (not invented).
 * - \`social\` — required (no public geotagged corpus yet).
 *
 * Regenerate: node scripts/join-wiki-country-ai-convo-hotspots.mjs
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
}

async function scrapeWindow(win, centroids) {
  /** @type {Map<string, { views: number, bestRank: number, articles: Set<string>, days: number }>} */
  const byCountry = new Map();
  for (let day = 0; day < win.days; day++) {
    const parts = ymdParts(win.ms + day * 86400000);
    for (const iso2 of COUNTRIES) {
      if (!centroids.has(iso2)) continue;
      await sleep(35);
      let json;
      try {
        json = await fetchTop(iso2, parts.y, parts.m, parts.d);
      } catch (e) {
        console.warn(`  skip ${iso2} ${parts.stamp}:`, e.message);
        continue;
      }
      const hits = matchArticles(json, win.needles);
      if (!hits.length) continue;
      const views = hits.reduce((s, h) => s + h.views, 0);
      const bestRank = Math.min(...hits.map((h) => h.rank || 9999));
      const prev = byCountry.get(iso2);
      if (prev) {
        prev.views += views;
        prev.bestRank = Math.min(prev.bestRank, bestRank);
        prev.days += 1;
        for (const h of hits) prev.articles.add(h.article);
      } else {
        byCountry.set(iso2, {
          views,
          bestRank,
          days: 1,
          articles: new Set(hits.map((h) => h.article)),
        });
      }
    }
    console.log(`  day ${parts.stamp}: ${byCountry.size} countries so far`);
  }

  return [...byCountry.entries()].map(([iso2, v]) => {
    const cent = centroids.get(iso2);
    const arts = [...v.articles].slice(0, 3).join(', ');
    return {
      id: `convo-wiki-${win.id}-${iso2}`,
      landmarkId: win.id,
      landmarkMs: win.ms,
      channel: 'wiki',
      iso2,
      iso3: '',
      name: cent.name,
      lat: cent.lat,
      lon: cent.lon,
      weight: v.views,
      detail: `${v.views.toLocaleString()} wiki views_ceil · ${v.days}d in top · rank≤${v.bestRank} · ${arts}`,
      sourceUrl:
        'https://wikimedia.org/api/rest_v1/metrics/pageviews/top-per-country/',
    };
  });
}

async function main() {
  const centroids = loadCentroids();
  const prior = loadPriorNonWiki();
  const wikiPoints = [];
  const meta = [];

  for (const win of WINDOWS) {
    console.log(`window ${win.id}…`);
    const pts = await scrapeWindow(win, centroids);
    console.log(`  → ${pts.length} countries`);
    wikiPoints.push(...pts);
    const trends = loadTrendsPoints(win, centroids);
    const combined = [
      ...pts,
      ...trends,
      ...prior.filter((p) => p.landmarkMs === win.ms),
    ];
    const channels = {};
    for (const ch of ['wiki', 'trends', 'news', 'social']) {
      const subset = combined.filter((p) => p.channel === ch);
      if (subset.length) {
        channels[ch] = {
          pointCount: subset.length,
          weightSum: subset.reduce((s, p) => s + p.weight, 0),
        };
      }
    }
    const gaps = [];
    if (!channels.trends) gaps.push('Google Trends interest-by-country CSV required');
    if (!channels.news) gaps.push('GDELT news join required (API unreachable from this host)');
    if (!channels.social) gaps.push('Social geotag corpus required');
    meta.push({
      landmarkId: win.id,
      headline: win.headline,
      landmarkMs: win.ms,
      windowDays: win.days,
      channels,
      gaps,
    });
  }

  const allPoints = [
    ...wikiPoints,
    ...prior.filter((p) => p.channel !== 'wiki'),
    ...WINDOWS.flatMap((w) => loadTrendsPoints(w, centroids)),
  ];
  // de-dupe by id
  const seen = new Set();
  const deduped = [];
  for (const p of allPoints) {
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    deduped.push(p);
  }

  fs.writeFileSync(OUT, emitTs(meta, deduped), 'utf8');
  console.log('wrote', OUT, 'points', deduped.length);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
