#!/usr/bin/env node
// Lists in-service international submarine cables in TeleGeography's open data
// (submarinecablemap.com) that are missing from the curated CABLE_REGIONS list.
// Usage: node scripts/check-submarine-cable-gaps.mjs [--out scripts/data/submarine-cable-gaps.md] [--min-countries 2]
import { writeFileSync } from 'node:fs';
import { CABLE_REGIONS } from './seed-submarine-cables.mjs';

const BASE = 'https://www.submarinecablemap.com/api/v3';
const args = process.argv.slice(2);
const outPath = args.includes('--out') ? args[args.indexOf('--out') + 1] : null;
const minCountries = args.includes('--min-countries') ? Number(args[args.indexOf('--min-countries') + 1]) : 2;
const UA = { 'User-Agent': 'Mozilla/5.0 (worldmonitor cable gap check)' };

const curated = new Set(CABLE_REGIONS.flatMap((r) => r.ids));
const all = await (await fetch(`${BASE}/cable/all.json`, { headers: UA })).json();
const candidates = all.filter((c) => !curated.has(c.id));

const gaps = [];
const queue = [...candidates];
async function worker() {
  while (queue.length) {
    const c = queue.shift();
    try {
      const res = await fetch(`${BASE}/cable/${c.id}.json`, { headers: UA });
      const d = await res.json();
      if (d.is_planned) continue;
      if (d.rfs_year && d.rfs_year > new Date().getUTCFullYear()) continue;
      const countries = [...new Set((d.landing_points ?? []).map((lp) => lp.country).filter(Boolean))];
      if (countries.length < minCountries) continue;
      gaps.push({ id: c.id, name: d.name, rfs: d.rfs_year ?? null, length: d.length ?? '', countries });
    } catch { /* skip unreadable entries */ }
  }
}
await Promise.all(Array.from({ length: 8 }, worker));

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
