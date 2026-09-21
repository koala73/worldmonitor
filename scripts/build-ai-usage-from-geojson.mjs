/**
 * Offline rebuild of ai-conversation-growth.ts from OWID raw + countries.geojson
 * bbox centroids (no external centroid CSV required).
 *
 * Usage (from apps/worldmonitor):
 *   node scripts/build-ai-usage-from-geojson.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const RAW = path.join(__dirname, '_owid-ai-raw.csv');
const ISO = path.join(__dirname, '_iso3166.csv');
const GEO = path.join(ROOT, 'public/data/countries.geojson');
const OUT = path.join(ROOT, 'src/config/ai-conversation-growth.ts');

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

function bboxCentroid(geom) {
  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;
  const walk = (coords) => {
    if (typeof coords[0] === 'number') {
      const lon = coords[0];
      const lat = coords[1];
      if (lon < minLon) minLon = lon;
      if (lat < minLat) minLat = lat;
      if (lon > maxLon) maxLon = lon;
      if (lat > maxLat) maxLat = lat;
      return;
    }
    for (const c of coords) walk(c);
  };
  walk(geom.coordinates);
  if (!Number.isFinite(minLon)) return null;
  return { lat: (minLat + maxLat) / 2, lon: (minLon + maxLon) / 2 };
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

function main() {
  if (!fs.existsSync(RAW) || !fs.existsSync(ISO) || !fs.existsSync(GEO)) {
    throw new Error('Need _owid-ai-raw.csv, _iso3166.csv, and public/data/countries.geojson');
  }

  const iso3to2 = new Map();
  for (const r of parseCsv(fs.readFileSync(ISO, 'utf8'))) {
    if (r['alpha-3'] && r['alpha-2']) iso3to2.set(r['alpha-3'], r['alpha-2']);
  }

  const geo = JSON.parse(fs.readFileSync(GEO, 'utf8'));
  const cents = new Map();
  for (const feat of geo.features ?? []) {
    const code = feat.properties?.['ISO3166-1-Alpha-2'];
    if (!code || !feat.geometry) continue;
    const c = bboxCentroid(feat.geometry);
    if (!c) continue;
    const name = feat.properties?.name ?? code;
    cents.set(String(code).toUpperCase(), { ...c, name });
  }

  const points = [];
  let skipped = 0;
  for (const r of parseCsv(fs.readFileSync(RAW, 'utf8'))) {
    const iso3 = r.Code?.trim();
    const day = r.Day?.trim();
    const share = Number(r['Estimated share of working-age adults who use generative AI']);
    if (!iso3 || iso3.startsWith('OWID') || !day || !Number.isFinite(share)) {
      skipped += 1;
      continue;
    }
    const iso2 = iso3to2.get(iso3);
    const c = iso2 ? cents.get(iso2) : null;
    if (!iso2 || !c) {
      skipped += 1;
      continue;
    }
    const periodEndMs = Date.parse(`${day}T00:00:00Z`);
    if (!Number.isFinite(periodEndMs)) {
      skipped += 1;
      continue;
    }
    points.push({
      id: `ai-use-${iso3}-${day}`,
      iso2,
      iso3,
      name: r.Entity || c.name,
      lat: c.lat,
      lon: c.lon,
      sharePct: share,
      periodEndMs,
      periodLabel: periodLabel(day),
      source: 'owid',
    });
  }

  points.sort((a, b) => a.periodEndMs - b.periodEndMs || a.iso2.localeCompare(b.iso2));
  const periods = [...new Set(points.map((p) => p.periodEndMs))].sort((a, b) => a - b);

  const body = `/**
 * Generative-AI online usage / conversation density by country × period.
 *
 * - source \`owid\`: OWID/Microsoft share of working-age adults who used a
 *   tracked generative-AI site/app (H1 2025 onward).
 * - source \`wildchat\`: WildChat-1M opt-in ChatGPT conversation share (when joined).
 *
 * Regenerate:
 *   node scripts/build-ai-usage-from-geojson.mjs
 *   # or: node scripts/join-owid-ai-conversation-growth.mjs
 *
 * OWID: https://ourworldindata.org/grapher/estimated-share-people-generative-ai
 */

export type AiUsageSource = 'owid' | 'wildchat';

export type AiConversationGrowthPoint = {
  id: string;
  iso2: string;
  iso3: string;
  name: string;
  lat: number;
  lon: number;
  sharePct: number;
  periodEndMs: number;
  periodLabel: string;
  source: AiUsageSource;
};

export const AI_CONVERSATION_GROWTH_POINTS: readonly AiConversationGrowthPoint[] = ${JSON.stringify(points, null, 2)};

/** Distinct reporting period ends (UTC), ascending. */
export const AI_CONVERSATION_PERIOD_ENDS_MS: readonly number[] = ${JSON.stringify(periods)};

/** Live → latest wave; scrub → nearest period end at or before focus. */
export function aiConversationPointsAt(
  focusMs: number | null | undefined,
): AiConversationGrowthPoint[] {
  if (AI_CONVERSATION_GROWTH_POINTS.length === 0) return [];
  if (focusMs == null || !Number.isFinite(focusMs)) {
    const latest = AI_CONVERSATION_PERIOD_ENDS_MS[AI_CONVERSATION_PERIOD_ENDS_MS.length - 1]!;
    return AI_CONVERSATION_GROWTH_POINTS.filter((p) => p.periodEndMs === latest);
  }
  let period: number | null = null;
  for (const t of AI_CONVERSATION_PERIOD_ENDS_MS) {
    if (t <= focusMs) period = t;
    else break;
  }
  if (period == null) return [];
  return AI_CONVERSATION_GROWTH_POINTS.filter((p) => p.periodEndMs === period);
}
`;

  fs.writeFileSync(OUT, body, 'utf8');
  console.log(`Wrote ${points.length} points, ${periods.length} periods (skipped ${skipped}) → ${OUT}`);
  console.log('periods', periods.map((ms) => new Date(ms).toISOString().slice(0, 10)));
}

main();
