#!/usr/bin/env node
// Regenerates shared/un-m49-regions.json: UN M49 regions, sub-regions and
// intermediate regions, each with its member ISO2 countries. Tools that take a
// region ("how does Latin America cover Finland") expand it through this table,
// so every region is a published standard rather than a hand-kept list.
//
// The source is the UNSD "Standard country or area codes for statistical use"
// overview page, parsed from its English download table. M49 omits Taiwan and
// Kosovo; SUPPLEMENTS places them where the UN geoscheme would and records why.
//
// Usage: node scripts/build-un-m49-regions.mjs [--check] [saved-overview.html]

import { readFileSync, writeFileSync } from 'node:fs';

const SOURCE_URL = 'https://unstats.un.org/unsd/methodology/m49/overview/';
const TARGET = new URL('../shared/un-m49-regions.json', import.meta.url);
// scripts/shared/ carries a byte-identical copy (tests/edge-functions.test.mjs).
const MIRROR = new URL('./shared/un-m49-regions.json', import.meta.url);

const SUPPLEMENTS = {
  TW: { region: 'Asia', subRegion: 'Eastern Asia', reason: 'Not listed by M49; geographically Eastern Asia.' },
  XK: { region: 'Europe', subRegion: 'Southern Europe', reason: 'Not listed by M49 (user-assigned ISO code); geographically Southern Europe.' },
};

export function slug(name) {
  return name.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function decode(text) {
  return text.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ').trim();
}

export function parseOverview(html) {
  const start = html.indexOf('id = "downloadTableEN"');
  if (start < 0) throw new Error('UNSD page has no English download table');
  const table = html.slice(start, html.indexOf('</table>', start));
  const rows = [...table.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)]
    .map(match => [...match[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map(cell => decode(cell[1])));
  const header = rows.shift();
  const column = name => {
    const index = header.indexOf(name);
    if (index < 0) throw new Error(`UNSD table lost its "${name}" column`);
    return index;
  };
  const cols = {
    regionCode: column('Region Code'), region: column('Region Name'),
    subCode: column('Sub-region Code'), sub: column('Sub-region Name'),
    intCode: column('Intermediate Region Code'), int: column('Intermediate Region Name'),
    iso2: column('ISO-alpha2 Code'),
  };
  return rows.map(row => ({
    iso2: row[cols.iso2],
    groups: [
      [row[cols.regionCode], row[cols.region], 'region'],
      [row[cols.subCode], row[cols.sub], 'sub-region'],
      [row[cols.intCode], row[cols.int], 'intermediate-region'],
    ].filter(([code, name]) => code && name),
  })).filter(row => /^[A-Z]{2}$/.test(row.iso2));
}

export function buildRegions(rows) {
  const regions = {};
  const add = (code, name, level, iso2) => {
    const id = slug(name);
    regions[id] ??= { code, name, level, countries: [] };
    if (regions[id].code !== code) throw new Error(`slug collision: ${id}`);
    regions[id].countries.push(iso2);
  };
  for (const row of rows) for (const [code, name, level] of row.groups) add(code, name, level, row.iso2);
  for (const [iso2, { region, subRegion }] of Object.entries(SUPPLEMENTS)) {
    if (rows.some(row => row.iso2 === iso2)) throw new Error(`${iso2} is now listed by M49; drop its supplement`);
    for (const name of [region, subRegion]) {
      const entry = regions[slug(name)];
      if (!entry) throw new Error(`supplement names unknown region ${name}`);
      entry.countries.push(iso2);
    }
  }
  for (const entry of Object.values(regions)) entry.countries.sort();
  return Object.fromEntries(Object.entries(regions).sort(([a], [b]) => a.localeCompare(b)));
}

async function main() {
  const args = process.argv.slice(2);
  const check = args.includes('--check');
  const saved = args.find(arg => !arg.startsWith('--'));
  const html = saved
    ? readFileSync(saved, 'utf8')
    : await (await fetch(SOURCE_URL, { headers: { 'User-Agent': 'worldmonitor-build/1.0 (+https://www.worldmonitor.app)' } })).text();
  const output = `${JSON.stringify({
    source: SOURCE_URL,
    note: 'UN M49 geoscheme; supplements cover areas M49 does not list.',
    supplements: Object.fromEntries(Object.entries(SUPPLEMENTS).map(([iso2, { reason }]) => [iso2, reason])),
    regions: buildRegions(parseOverview(html)),
  }, null, 2)}\n`;
  if (check) {
    if (readFileSync(TARGET, 'utf8') !== output || readFileSync(MIRROR, 'utf8') !== output) {
      console.error('shared/un-m49-regions.json or its scripts/shared mirror is stale; run node scripts/build-un-m49-regions.mjs');
      process.exit(1);
    }
    return;
  }
  writeFileSync(TARGET, output);
  writeFileSync(MIRROR, output);
  console.log(`wrote ${Object.keys(JSON.parse(output).regions).length} regions`);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
