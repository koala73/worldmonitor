#!/usr/bin/env node
// Lists in-service international submarine cables in TeleGeography's open data
// (submarinecablemap.com) that are missing from the curated CABLE_REGIONS list.
// Usage: node scripts/check-submarine-cable-gaps.mjs [--out scripts/data/submarine-cable-gaps.md] [--min-countries 2]
import { writeFileSync } from 'node:fs';
import { CABLE_REGIONS } from './seed-submarine-cables.mjs';

const BASE = 'https://www.submarinecablemap.com/api/v3';
const args = process.argv.slice(2);
const outPath = args.includes('--out') ? args[args.indexOf('--out') + 1] : null;
if (args.includes('--out') && (!outPath || outPath.startsWith('--'))) throw new Error('--out requires a path');
const minCountries = args.includes('--min-countries') ? Number(args[args.indexOf('--min-countries') + 1]) : 2;
if (!Number.isInteger(minCountries) || minCountries < 1) throw new Error('--min-countries must be a positive integer');
const UA = { 'User-Agent': 'Mozilla/5.0 (worldmonitor cable gap check)' };

const curated = new Set(CABLE_REGIONS.flatMap((r) => r.ids));
const catalogResponse = await fetch(`${BASE}/cable/all.json`, { headers: UA });
if (!catalogResponse.ok) throw new Error(`Cable catalog HTTP ${catalogResponse.status}`);
const all = await catalogResponse.json();
if (!Array.isArray(all) || all.some((c) => typeof c?.id !== 'string' || !c.id.trim())) {
  throw new Error('Invalid cable catalog');
}
const candidates = all.filter((c) => !curated.has(c.id));

const gaps = [];
const failures = [];
const queue = [...candidates];
async function worker() {
  while (queue.length) {
    const c = queue.shift();
    try {
      const res = await fetch(`${BASE}/cable/${c.id}.json`, { headers: UA });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = await res.json();
      if (!d || typeof d.name !== 'string' || !Array.isArray(d.landing_points)
        || d.landing_points.some((lp) => typeof lp?.country !== 'string' || !lp.country.trim())) {
        throw new Error('Invalid cable detail');
      }
      if (d.is_planned) continue;
      if (d.rfs_year && d.rfs_year > new Date().getUTCFullYear()) continue;
      const countries = [...new Set(d.landing_points.map((lp) => lp.country))];
      if (countries.length < minCountries) continue;
      gaps.push({ id: c.id, name: d.name, rfs: d.rfs_year ?? null, length: d.length ?? '', countries });
    } catch (error) {
      failures.push(`${c.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
await Promise.all(Array.from({ length: 8 }, worker));
if (failures.length > 0) {
  throw new Error(`Incomplete cable gap scan (${failures.length} failed):\n${failures.join('\n')}`);
}

const lengthKm = (s) => Number(String(s).replace(/[^0-9.]/g, '')) || 0;
gaps.sort((a, b) => b.countries.length - a.countries.length || lengthKm(b.length) - lengthKm(a.length));

const lines = [
  '# Submarine cable gaps vs TeleGeography',
  '',
  `Generated ${new Date().toISOString().slice(0, 10)} by \`node scripts/check-submarine-cable-gaps.mjs --out ${outPath ?? '<path>'}\`.`,
  `Source: ${BASE}/cable/all.json (+ per-cable detail). Curated list: ${curated.size} cables. TeleGeography: ${all.length} cables.`,
  `Missing in-service cables landing in ${minCountries}+ countries: ${gaps.length}. Sorted by country count, then length.`,
  'To add one: append its slug to CABLE_REGIONS in scripts/seed-submarine-cables.mjs and mirror the seeded entry in src/config/geo-map.ts.',
  '',
  '| Slug | Name | RFS | Length | Countries |',
  '| --- | --- | --- | --- | --- |',
  ...gaps.map((g) => `| ${g.id} | ${g.name.replace(/\|/g, '/')} | ${g.rfs ?? ''} | ${g.length} | ${g.countries.join(', ')} |`),
  '',
];
if (outPath) writeFileSync(outPath, lines.join('\n'));
else console.log(lines.join('\n'));
console.error(`${gaps.length} gaps (curated ${curated.size}, upstream ${all.length})`);
