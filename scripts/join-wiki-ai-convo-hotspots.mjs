/**
 * Join Wikimedia pageviews for AI product-era articles across language editions
 * onto primary-country centroids — Convo Hotspots attention channel (wiki).
 *
 * Also emits empty `trends` / `social` / `news` channel slots when those joins
 * are missing (missing ≠ invent). GDELT news join:
 *   node scripts/join-gdelt-ai-convo-hotspots.mjs
 * Google Trends geo CSVs (required): scripts/_trends-ai-convo/*.csv
 * Social geotags: still required (no reliable public geo corpus in-repo).
 *
 * Source: https://wikimedia.org/api/rest_v1/
 * Cite: Wikimedia Foundation Pageviews API.
 *
 * Usage (from apps/worldmonitor):
 *   node scripts/join-wiki-ai-convo-hotspots.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CENT = path.join(__dirname, '_country-centroids.csv');
const TRENDS_DIR = path.join(__dirname, '_trends-ai-convo');
const OUT = path.join(ROOT, 'src/config/ai-convo-hotspots.ts');
const UA =
  'WorldMonitor-AI-ConvoHotspots/1.0 (https://www.worldmonitor.app; research join)';

/**
 * Language Wikipedia → ISO2 for primary-country placement.
 * Approximation: language edition ≠ national border; documented as such.
 */
const LANG_PRIMARY_ISO2 = {
  en: 'US',
  zh: 'CN',
  es: 'ES',
  hi: 'IN',
  ar: 'SA',
  pt: 'BR',
  ja: 'JP',
  de: 'DE',
  fr: 'FR',
  ru: 'RU',
  ko: 'KR',
  it: 'IT',
  id: 'ID',
  tr: 'TR',
  vi: 'VN',
  pl: 'PL',
  nl: 'NL',
  th: 'TH',
  uk: 'UA',
  cs: 'CZ',
  ro: 'RO',
  hu: 'HU',
  sv: 'SE',
  fi: 'FI',
  no: 'NO',
  da: 'DK',
  el: 'GR',
  he: 'IL',
  fa: 'IR',
  bn: 'BD',
  ta: 'IN',
  mr: 'IN',
  te: 'IN',
  ms: 'MY',
  tl: 'PH',
  sw: 'KE',
  ca: 'ES',
  bg: 'BG',
  hr: 'HR',
  sk: 'SK',
  lt: 'LT',
  lv: 'LV',
  et: 'EE',
  sl: 'SI',
  sr: 'RS',
};

const WINDOWS = [
  {
    id: 'chatgpt',
    ms: Date.UTC(2022, 10, 30),
    headline: 'ChatGPT',
    articles: { en: 'ChatGPT', de: 'ChatGPT', fr: 'ChatGPT', es: 'ChatGPT', ja: 'ChatGPT', zh: 'ChatGPT', pt: 'ChatGPT', ru: 'ChatGPT', it: 'ChatGPT', ko: 'ChatGPT', ar: 'ChatGPT', hi: 'ChatGPT', id: 'ChatGPT', tr: 'ChatGPT', vi: 'ChatGPT', pl: 'ChatGPT', nl: 'ChatGPT', uk: 'ChatGPT' },
    days: 7,
  },
  {
    id: 'msft-openai-2023',
    ms: Date.UTC(2023, 0, 23),
    headline: 'MSFT–OpenAI',
    articles: { en: 'ChatGPT', de: 'ChatGPT', fr: 'ChatGPT', ja: 'ChatGPT', zh: 'ChatGPT' },
    days: 7,
  },
  {
    id: 'gpt4-claude',
    ms: Date.UTC(2023, 2, 14),
    headline: 'GPT-4 · Claude',
    articles: { en: 'GPT-4', de: 'GPT-4', fr: 'GPT-4', ja: 'GPT-4', zh: 'GPT-4', es: 'GPT-4' },
    days: 7,
  },
  {
    id: 'llama2',
    ms: Date.UTC(2023, 6, 18),
    headline: 'Llama 2',
    articles: { en: 'Llama_2', de: 'Llama_2', fr: 'Llama_2', ja: 'Llama_2', zh: 'Llama_2' },
    days: 7,
  },
  {
    id: 'devday-2023',
    ms: Date.UTC(2023, 10, 6),
    headline: 'DevDay',
    articles: { en: 'OpenAI', de: 'OpenAI', fr: 'OpenAI', ja: 'OpenAI', zh: 'OpenAI' },
    days: 7,
  },
  {
    id: 'gpt4o',
    ms: Date.UTC(2024, 4, 13),
    headline: 'GPT-4o',
    articles: { en: 'GPT-4o', de: 'GPT-4o', fr: 'GPT-4o', ja: 'GPT-4o', zh: 'GPT-4o', es: 'GPT-4o', ko: 'GPT-4o' },
    days: 7,
  },
  {
    id: 'claude-35-sonnet',
    ms: Date.UTC(2024, 5, 21),
    headline: 'Claude 3.5',
    articles: { en: 'Claude_(language_model)', de: 'Claude_(KI)', fr: 'Claude_(intelligence_artificielle)', ja: 'Claude' },
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

async function pageviews(lang, article, startYmd, endYmd) {
  const project = `${lang}.wikipedia`;
  const encoded = encodeURIComponent(article);
  const url = `https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/${project}/all-access/user/${encoded}/daily/${startYmd}/${endYmd}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'application/json' },
  });
  if (res.status === 404) return 0;
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`pageviews ${lang}/${article}: ${res.status} ${t.slice(0, 120)}`);
  }
  const json = await res.json();
  return (json.items || []).reduce((s, i) => s + (Number(i.views) || 0), 0);
}

/** Optional Google Trends CSVs: landmarkId.csv with columns country,iso2,interest (0–100). */
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

async function wikiPointsForWindow(win, centroids) {
  const start = ymd(win.ms);
  const end = ymd(win.ms + win.days * 86400000);
  /** @type {Map<string, { views: number, langs: string[] }>} */
  const byIso = new Map();
  for (const [lang, article] of Object.entries(win.articles)) {
    const iso2 = LANG_PRIMARY_ISO2[lang];
    if (!iso2 || !centroids.has(iso2)) continue;
    await sleep(120);
    let views = 0;
    try {
      views = await pageviews(lang, article, start, end);
    } catch (e) {
      console.warn(`  skip ${lang}/${article}:`, e.message);
      continue;
    }
    if (views <= 0) continue;
    const prev = byIso.get(iso2);
    if (prev) {
      prev.views += views;
      prev.langs.push(lang);
    } else {
      byIso.set(iso2, { views, langs: [lang] });
    }
    console.log(`  ${lang}.wikipedia ${article}: ${views}`);
  }
  return [...byIso.entries()].map(([iso2, v]) => {
    const cent = centroids.get(iso2);
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
      detail: `${v.views.toLocaleString()} Wikipedia pageviews (${v.langs.join('+')})`,
      sourceUrl: `https://wikimedia.org/api/rest_v1/`,
    };
  });
}

function emitTs(meta, points) {
  const ends = [...new Set(meta.map((m) => m.landmarkMs))];
  return `/**
 * AI Convo Hotspots — attention around product-era timeline windows.
 *
 * Channels in this catalog:
 * - \`wiki\` — Wikimedia pageviews by language edition → primary-country centroid
 *   (language ≠ nation; cited Pageviews API). Proxy for public readership attention.
 * - \`trends\` — Google Trends interest-by-country when CSVs present under
 *   scripts/_trends-ai-convo/<landmarkId>.csv (required otherwise).
 * - \`news\` — GDELT publisher-country ArtList (join-gdelt-ai-convo-hotspots.mjs).
 * - \`social\` — not joined yet (no reliable public geotagged social corpus).
 *
 * Missing channel ≠ 0. Regenerate wiki:
 *   node scripts/join-wiki-ai-convo-hotspots.mjs
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
  /** Channel-native magnitude (pageviews, Trends 0–100, or article count) */
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

async function main() {
  const centroids = loadCentroids();
  const allPoints = [];
  const meta = [];

  for (const win of WINDOWS) {
    console.log(`window ${win.id}…`);
    const wiki = await wikiPointsForWindow(win, centroids);
    const trends = loadTrendsPoints(win, centroids);
    const news = []; // filled by GDELT join when available
    const social = [];
    const points = [...wiki, ...trends, ...news, ...social];
    allPoints.push(...points);

    const channels = {};
    for (const ch of ['wiki', 'trends', 'news', 'social']) {
      const subset = points.filter((p) => p.channel === ch);
      if (subset.length) {
        channels[ch] = {
          pointCount: subset.length,
          weightSum: subset.reduce((s, p) => s + p.weight, 0),
        };
      }
    }
    const gaps = [];
    if (!channels.trends) gaps.push('Google Trends interest-by-country CSV required');
    if (!channels.news) gaps.push('GDELT news join required (rate-limited / run join-gdelt script)');
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

  fs.writeFileSync(OUT, emitTs(meta, allPoints), 'utf8');
  console.log('wrote', OUT, 'points', allPoints.length);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
