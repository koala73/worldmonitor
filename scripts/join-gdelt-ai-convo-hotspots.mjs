/**
 * Join GDELT DOC ArtList coverage around AI product-era landmarks onto country
 * centroids for Convo Hotspots (news/media attention by publisher country).
 *
 * Source: https://api.gdeltproject.org/api/v2/doc/doc
 * Cite: GDELT Project (https://www.gdeltproject.org/)
 *
 * Metric: count of matching English-language articles whose GDELT
 * `sourcecountry` maps to a centroid — publisher country, not story location.
 * Google Trends geo and social geotags are separate channels (required files /
 * joins documented in REWRITE.md) — missing ≠ invent.
 *
 * Usage (from apps/worldmonitor):
 *   node scripts/join-gdelt-ai-convo-hotspots.mjs
 *
 * Caches raw ArtList JSON under scripts/_gdelt-ai-convo-raw/.
 * Prefer scraping with Python (more patient retries from a fresh IP):
 *   scripts/scrape-gdelt.cmd
 *   # or: python scripts/scrape_gdelt_ai_convo.py
 * then:
 *   node scripts/join-gdelt-ai-convo-hotspots.mjs --cache-only
 *
 * Default is --cache-only (no live GDELT fetch). Pass --fetch to pull from
 * the API here (rate-limit: ≥15s between windows).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const RAW_DIR = path.join(__dirname, '_gdelt-ai-convo-raw');
const ISO = path.join(__dirname, '_iso3166.csv');
const CENT = path.join(__dirname, '_country-centroids.csv');
const OUT = path.join(ROOT, 'src/config/ai-convo-hotspots.ts');
const UA = 'WorldMonitor-AI-ConvoHotspots/1.0 (+https://www.worldmonitor.app)';
const SLEEP_MS = 15_000;
const FETCH_TIMEOUT_MS = 90_000;

/** Product / infra eras that drive Convo windows (match ai-era-landmarks). */
const WINDOWS = [
  {
    id: 'chatgpt',
    ms: Date.UTC(2022, 10, 30),
    headline: 'ChatGPT',
    query: '"ChatGPT"',
    days: 7,
  },
  {
    id: 'msft-openai-2023',
    ms: Date.UTC(2023, 0, 23),
    headline: 'MSFT–OpenAI',
    query: '("Microsoft" OpenAI) OR "ChatGPT"',
    days: 7,
  },
  {
    id: 'gpt4-claude',
    ms: Date.UTC(2023, 2, 14),
    headline: 'GPT-4 · Claude',
    query: '"GPT-4" OR "GPT 4" OR (Claude Anthropic)',
    days: 7,
  },
  {
    id: 'llama2',
    ms: Date.UTC(2023, 6, 18),
    headline: 'Llama 2',
    query: '"Llama 2" OR Llama2',
    days: 7,
  },
  {
    id: 'devday-2023',
    ms: Date.UTC(2023, 10, 6),
    headline: 'DevDay',
    query: '"OpenAI" (DevDay OR "GPT-4 Turbo" OR GPTs)',
    days: 7,
  },
  {
    id: 'gpt4o',
    ms: Date.UTC(2024, 4, 13),
    headline: 'GPT-4o',
    query: '"GPT-4o" OR "GPT 4o"',
    days: 7,
  },
  {
    id: 'claude-35-sonnet',
    ms: Date.UTC(2024, 5, 21),
    headline: 'Claude 3.5',
    query: '"Claude 3.5" OR "Claude 3.5 Sonnet"',
    days: 7,
  },
];

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function gdeltStamp(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}000000`;
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

function loadIso() {
  const rows = parseCsv(fs.readFileSync(ISO, 'utf8'));
  /** @type {Map<string, { alpha2: string, alpha3: string, name: string }>} */
  const byName = new Map();
  for (const r of rows) {
    const name = (r[0] || '').trim();
    const alpha2 = (r[1] || '').trim();
    const alpha3 = (r[2] || '').trim();
    if (!name || !alpha2) continue;
    byName.set(name.toLowerCase(), { alpha2, alpha3, name });
  }
  // GDELT uses common English names that differ from ISO formal names
  const aliases = {
    'united states': 'United States of America',
    'united kingdom': 'United Kingdom of Great Britain and Northern Ireland',
    russia: 'Russian Federation',
    'south korea': 'Korea, Republic of',
    'north korea': "Korea, Democratic People's Republic of",
    iran: 'Iran, Islamic Republic of',
    syria: 'Syrian Arab Republic',
    venezuela: 'Venezuela, Bolivarian Republic of',
    bolivia: 'Bolivia, Plurinational State of',
    tanzania: 'Tanzania, United Republic of',
    vietnam: 'Viet Nam',
    laos: "Lao People's Democratic Republic",
    moldova: 'Moldova, Republic of',
    'czech republic': 'Czechia',
    slovakia: 'Slovakia',
    taiwan: 'Taiwan, Province of China',
    palestine: 'Palestine, State of',
    'hong kong': 'Hong Kong',
    macau: 'Macao',
    macao: 'Macao',
    brunei: 'Brunei Darussalam',
    'ivory coast': "Côte d'Ivoire",
    "cote d'ivoire": "Côte d'Ivoire",
    myanmar: 'Myanmar',
    burma: 'Myanmar',
    swamp: null,
  };
  for (const [alias, formal] of Object.entries(aliases)) {
    if (!formal) continue;
    const hit = byName.get(formal.toLowerCase());
    if (hit) byName.set(alias, hit);
  }
  // Also index bare "United States" if ISO has "United States of America"
  const us = [...byName.values()].find((x) => x.alpha2 === 'US');
  if (us) byName.set('united states', us);
  const gb = [...byName.values()].find((x) => x.alpha2 === 'GB');
  if (gb) byName.set('united kingdom', gb);
  return byName;
}

function loadCentroids() {
  const rows = parseCsv(fs.readFileSync(CENT, 'utf8'));
  /** @type {Map<string, { lat: number, lon: number, name: string }>} */
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

async function fetchArtList(win, { allowFetch }) {
  fs.mkdirSync(RAW_DIR, { recursive: true });
  const cachePath = path.join(RAW_DIR, `${win.id}.json`);
  if (fs.existsSync(cachePath) && fs.statSync(cachePath).size > 50) {
    return JSON.parse(fs.readFileSync(cachePath, 'utf8'));
  }
  if (!allowFetch) {
    throw new Error(
      `No cache for ${win.id} (${cachePath}). Run: scripts\\scrape-gdelt.cmd`,
    );
  }
  const start = gdeltStamp(win.ms);
  const end = gdeltStamp(win.ms + win.days * 24 * 60 * 60 * 1000);
  const url =
    'https://api.gdeltproject.org/api/v2/doc/doc?' +
    new URLSearchParams({
      query: win.query,
      mode: 'ArtList',
      format: 'json',
      maxrecords: '250',
      startdatetime: start,
      enddatetime: end,
      sort: 'DateDesc',
    }).toString();

  let lastErr = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    if (attempt > 0) await sleep(SLEEP_MS * (attempt + 1));
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA },
        signal: ctrl.signal,
      });
      const text = await res.text();
      if (text.startsWith('Please limit')) {
        lastErr = new Error(`GDELT rate limit for ${win.id}`);
        console.warn(`rate-limited ${win.id}, retry ${attempt + 1}`);
        continue;
      }
      if (!res.ok) {
        lastErr = new Error(`GDELT ${res.status} for ${win.id}`);
        continue;
      }
      let json;
      try {
        json = JSON.parse(text);
      } catch (e) {
        lastErr = e;
        continue;
      }
      fs.writeFileSync(cachePath, JSON.stringify(json, null, 2), 'utf8');
      return json;
    } catch (e) {
      lastErr = e;
      console.warn(`fetch error ${win.id}:`, e.cause?.code || e.message);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr ?? new Error(`GDELT failed for ${win.id}`);
}

function aggregate(win, json, byName, centroids) {
  const articles = Array.isArray(json.articles) ? json.articles : [];
  /** @type {Map<string, { count: number, sampleTitle: string, sampleUrl: string }>} */
  const bag = new Map();
  let unmapped = 0;
  for (const a of articles) {
    const countryRaw = String(a.sourcecountry || '').trim();
    if (!countryRaw) {
      unmapped++;
      continue;
    }
    const hit = byName.get(countryRaw.toLowerCase());
    if (!hit) {
      unmapped++;
      continue;
    }
    const cent = centroids.get(hit.alpha2);
    if (!cent) {
      unmapped++;
      continue;
    }
    const prev = bag.get(hit.alpha2);
    if (prev) {
      prev.count += 1;
    } else {
      bag.set(hit.alpha2, {
        count: 1,
        sampleTitle: String(a.title || '').trim(),
        sampleUrl: String(a.url || '').trim(),
      });
    }
  }
  const points = [...bag.entries()]
    .map(([alpha2, v]) => {
      const cent = centroids.get(alpha2);
      const iso = [...byName.values()].find((x) => x.alpha2 === alpha2);
      return {
        id: `convo-${win.id}-${alpha2}`,
        landmarkId: win.id,
        landmarkMs: win.ms,
        channel: 'news',
        iso2: alpha2,
        iso3: iso?.alpha3 ?? '',
        name: cent.name,
        lat: cent.lat,
        lon: cent.lon,
        articleCount: v.count,
        sampleTitle: v.sampleTitle,
        sampleUrl: v.sampleUrl,
      };
    })
    .sort((a, b) => b.articleCount - a.articleCount);

  return {
    landmarkId: win.id,
    headline: win.headline,
    landmarkMs: win.ms,
    query: win.query,
    windowDays: win.days,
    articleTotal: articles.length,
    unmappedArticles: unmapped,
    points,
  };
}

function emitTs(waves) {
  const newsPoints = waves.flatMap((w) =>
    w.points.map((p) => ({
      id: p.id,
      landmarkId: p.landmarkId,
      landmarkMs: p.landmarkMs,
      channel: 'news',
      iso2: p.iso2,
      iso3: p.iso3,
      name: p.name,
      lat: p.lat,
      lon: p.lon,
      weight: p.articleCount,
      detail: `${p.articleCount} GDELT articles · ${p.sampleTitle}`.slice(0, 160),
      sourceUrl: p.sampleUrl || 'https://www.gdeltproject.org/',
    })),
  );

  // Preserve wiki/trends/social from prior wiki join (missing ≠ wipe).
  let prior = [];
  if (fs.existsSync(OUT)) {
    const text = fs.readFileSync(OUT, 'utf8');
    const m = text.match(
      /export const AI_CONVO_HOTSPOT_POINTS: readonly AiConvoHotspotPoint\[\] = (\[[\s\S]*?\]);/,
    );
    if (m) {
      try {
        prior = JSON.parse(m[1]).filter((p) => p.channel !== 'news');
      } catch {
        prior = [];
      }
    }
  }
  const allPoints = [...prior, ...newsPoints];
  const ends = [
    ...new Set([
      ...waves.map((w) => w.landmarkMs),
      ...allPoints.map((p) => p.landmarkMs),
    ]),
  ].sort((a, b) => a - b);

  const metaById = new Map();
  // Rebuild meta from all points so wiki/trends eras survive a partial news scrape.
  for (const p of allPoints) {
    if (!metaById.has(p.landmarkId)) {
      metaById.set(p.landmarkId, {
        landmarkId: p.landmarkId,
        headline:
          waves.find((w) => w.landmarkId === p.landmarkId)?.headline ||
          p.landmarkId,
        landmarkMs: p.landmarkMs,
        windowDays:
          waves.find((w) => w.landmarkId === p.landmarkId)?.windowDays || 7,
        channels: {},
        gaps: [],
      });
    }
  }
  for (const row of metaById.values()) {
    const pts = allPoints.filter((p) => p.landmarkMs === row.landmarkMs);
    const channels = {};
    for (const ch of ['wiki', 'trends', 'news', 'social']) {
      const subset = pts.filter((p) => p.channel === ch);
      if (subset.length) {
        channels[ch] = {
          pointCount: subset.length,
          weightSum: subset.reduce((s, p) => s + p.weight, 0),
        };
      }
    }
    row.channels = channels;
    const gaps = [];
    if (!channels.news) gaps.push('GDELT news join required (or scrape more windows)');
    if (!channels.social) gaps.push('Social geotag corpus required');
    if (channels.trends) {
      gaps.push(
        'Trends region ranks are period-average; intensity scaled by monthly global interest',
      );
    }
    row.gaps = gaps;
  }
  const meta = [...metaById.values()].sort(
    (a, b) => a.landmarkMs - b.landmarkMs,
  );

  return `/**
 * AI Convo Hotspots — attention around product-era timeline windows.
 *
 * Channels: wiki (Wikimedia), trends (Google Trends CSVs), news (GDELT),
 * social (required). Merged by join scripts — missing channel ≠ invent.
 *
 * Scrape news: scripts/scrape-gdelt.cmd
 * Join news:   node scripts/join-gdelt-ai-convo-hotspots.mjs --cache-only
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
`;
}

async function main() {
  const doFetch =
    process.argv.includes('--fetch') && !process.argv.includes('--cache-only');
  if (!doFetch) {
    console.log('cache-only mode (pass --fetch to hit GDELT DOC API)');
  }

  const byName = loadIso();
  const centroids = loadCentroids();
  const waves = [];
  for (let i = 0; i < WINDOWS.length; i++) {
    const win = WINDOWS[i];
    const cachePath = path.join(RAW_DIR, `${win.id}.json`);
    const hasCache = fs.existsSync(cachePath) && fs.statSync(cachePath).size > 50;
    if (!hasCache && !doFetch) {
      console.warn(`skip ${win.id} — no cache (run scripts\\scrape-gdelt.cmd)`);
      continue;
    }
    console.log(`${hasCache ? 'load' : 'fetch'} ${win.id}…`);
    if (!hasCache && i > 0) await sleep(SLEEP_MS);
    try {
      const json = await fetchArtList(win, { allowFetch: doFetch });
      const wave = aggregate(win, json, byName, centroids);
      console.log(
        `  ${wave.articleTotal} articles → ${wave.points.length} countries (unmapped ${wave.unmappedArticles})`,
      );
      waves.push(wave);
    } catch (e) {
      console.warn(`skip ${win.id}:`, e.message || e);
    }
  }
  if (waves.length === 0) {
    console.error('No GDELT windows loaded. Scrape first, then re-run --cache-only.');
    process.exit(1);
  }
  fs.writeFileSync(OUT, emitTs(waves), 'utf8');
  console.log('wrote', OUT, `(${waves.length}/${WINDOWS.length} windows)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
