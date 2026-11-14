#!/usr/bin/env node
// Measures how much of each watched land site's change-scoring footprint is permanent
// water in ESA WorldCover 2021 (10 m, class 80), and writes the reviewed table the change
// scorer reads. A site whose footprint is mostly water is a water point, not land.
// Needs network access to Planetary Computer; it is not part of `npm run generate`.
// Usage: node scripts/measure-orbital-site-water.mjs
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { footprintFeature } from './_orbital-change.mjs';
import { isMainModule } from './lib/main-module.mjs';
import { WATCHED_SITES } from './shared/orbital-watched-sites.generated.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const SITE_WATER_OUTPUT = 'scripts/shared/orbital-site-water.mjs';
const STATISTICS_URL = 'https://planetarycomputer.microsoft.com/api/data/v1/item/statistics';
const USER_AGENT = 'WorldMonitor-Seed/1.0 (https://www.worldmonitor.app)';
const WATER_CLASS = 80;

/** The WorldCover 2021 tile holding a point: tiles are 3 degrees, named by their south-west corner. */
export function worldCoverItem({ lat, lon }) {
  const south = Math.floor(lat / 3) * 3;
  const west = Math.floor(lon / 3) * 3;
  const ns = `${south < 0 ? 'S' : 'N'}${String(Math.abs(south)).padStart(2, '0')}`;
  const ew = `${west < 0 ? 'W' : 'E'}${String(Math.abs(west)).padStart(3, '0')}`;
  return `ESA_WorldCover_10m_2021_v200_${ns}${ew}`;
}

/** Percent of the footprint's valid pixels that are permanent water, from a categorical histogram. */
export function waterPercent(band) {
  const [counts, values] = band?.histogram ?? [];
  if (!Array.isArray(counts) || !Array.isArray(values) || !(band.valid_pixels > 0)) return null;
  const water = values.reduce((sum, value, i) => (value === WATER_CLASS ? sum + counts[i] : sum), 0);
  return Math.round((1000 * water) / band.valid_pixels) / 10;
}

async function measure(site) {
  const url = `${STATISTICS_URL}?collection=esa-worldcover&item=${worldCoverItem(site)}&assets=map&categorical=true`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'User-Agent': USER_AGENT, 'Content-Type': 'application/json' },
    body: JSON.stringify(footprintFeature(site)),
    signal: AbortSignal.timeout(30_000),
  });
  if (response.status === 404) return null; // open ocean: WorldCover has no tile
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${site.id}`);
  return waterPercent((await response.json())?.properties?.statistics?.map_b1);
}

async function main() {
  const water = {};
  for (const site of WATCHED_SITES.filter((s) => s.surface === 'land')) {
    let percent;
    for (let attempt = 0; ; attempt += 1) {
      try { percent = await measure(site); break; } catch (error) {
        if (attempt >= 2) throw error;
        await new Promise((resolve) => setTimeout(resolve, 2_000 * (attempt + 1)));
      }
    }
    water[site.id] = percent ?? 100;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const lines = Object.entries(water).sort(([a], [b]) => a.localeCompare(b)).map(([id, pct]) => `  ${JSON.stringify(id)}: ${pct},`);
  writeFileSync(join(ROOT, SITE_WATER_OUTPUT), `// Measured by scripts/measure-orbital-site-water.mjs from ESA WorldCover 2021 (class 80,
// permanent water) over each land site's change-scoring footprint. Do not edit by hand.
// A site with no WorldCover tile (open ocean) counts as 100.

/** Percent of each watched land site's change-scoring footprint that is permanent water. */
export const SITE_WATER_PERCENT = Object.freeze({
${lines.join('\n')}
});
`);
  console.log(`wrote ${SITE_WATER_OUTPUT} (${lines.length} sites)`);
}

if (isMainModule(import.meta.url, process.argv[1])) main().catch((error) => { console.error(error); process.exit(1); });
