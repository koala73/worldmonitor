#!/usr/bin/env node
// Regenerates scripts/shared/news-places.json: place name -> ISO2, used to credit a
// headline to the country of a city or region it names ("Drone strike on Kharkiv",
// "Missile hits Dammam airport") when the headline names no country.
//
// Source rows come from scripts/data/outbreak-places.json (GeoNames cities of at least
// 100k people plus first-level regions, see scripts/build-outbreak-places.mjs). A
// headline is not a medical bulletin, so this keeps only names that are unlikely to be
// ordinary words in English news:
//   - names found in more than one country are dropped (Tripoli, Victoria, Hamilton);
//   - single words that are lowercase English words are dropped (Brent, Lira, Meta, Bath);
//   - single words that are common given names are dropped (Austin, Charlotte, George);
//   - names equal to a country name are dropped, since the country lookup covers them;
//   - EXCLUDED_NAMES drops the rest that review found used as plain words.
// The word lists are the macOS/BSD system dictionaries, so regeneration runs locally
// and the output is committed; production never reads the dictionaries.
//
// Usage: node scripts/build-news-places.mjs [--check] [words] [propernames]

import { readFileSync, writeFileSync } from 'node:fs';

const SOURCE = new URL('./data/outbreak-places.json', import.meta.url);
const COUNTRY_NAMES = new URL('./shared/country-names.json', import.meta.url);
const TARGET = new URL('./shared/news-places.json', import.meta.url);

const EXCLUDED_NAMES = new Set([
  'duma', 'reading', 'warren', 'split', 'mobile', 'surprise', 'independence', 'nice',
  'orange', 'florence', 'victoria', 'york', 'wellington', 'jackson', 'lincoln', 'phoenix',
  'aurora', 'concord', 'liberty', 'union', 'providence', 'paradise', 'eden', 'temple',
  // People, institutions and brands that share a city's name.
  'austin', 'charlotte', 'henderson', 'madison', 'montgomery', 'richardson', 'thornton',
  'edison', 'clovis', 'davie', 'fargo', 'lancaster', 'durham', 'sutton', 'milton', 'darwin',
  'perth', 'windsor', 'regina', 'ajax', 'whitby', 'preston', 'bolton', 'mansfield', 'newport',
  'levis', 'columbia', 'oxford', 'dartmouth', 'hampton', 'lexington', 'salinas', 'plano',
  'provo', 'reno', 'burlington', 'bedford', 'meads', 'chinatown', 'koreatown',
  // Odessa, Texas: headlines mean Odesa, Ukraine, which GeoNames spells without the double s.
  'odessa',
]);

const args = process.argv.slice(2);
const check = args.includes('--check');
const [wordsPath = '/usr/share/dict/words', namesPath = '/usr/share/dict/propernames'] = args.filter((a) => a !== '--check');

const normalize = (name) => name.normalize('NFKD').replace(/\p{Diacritic}/gu, '').toLowerCase()
  .replace(/['.(),/-]/g, ' ').replace(/\s+/g, ' ').trim();

function buildPlaces() {
  const commonWords = new Set(readFileSync(wordsPath, 'utf8').split('\n').filter((w) => w && w === w.toLowerCase()));
  const givenNames = new Set(readFileSync(namesPath, 'utf8').split('\n').map((w) => w.trim().toLowerCase()).filter(Boolean));
  const countryNames = new Set(Object.keys(JSON.parse(readFileSync(COUNTRY_NAMES, 'utf8'))).map(normalize));
  const rows = JSON.parse(readFileSync(SOURCE, 'utf8'));

  const countriesByName = new Map();
  for (const [iso2, places] of Object.entries(rows)) {
    for (const [name] of places) {
      const key = normalize(name);
      if (!countriesByName.has(key)) countriesByName.set(key, new Set());
      countriesByName.get(key).add(iso2);
    }
  }

  const out = {};
  for (const [name, iso2s] of [...countriesByName].sort(([a], [b]) => a.localeCompare(b))) {
    if (iso2s.size !== 1 || name.length < 4) continue;
    if (countryNames.has(name) || EXCLUDED_NAMES.has(name)) continue;
    if (!name.includes(' ') && (commonWords.has(name) || givenNames.has(name))) continue;
    out[name] = [...iso2s][0];
  }
  return out;
}

const next = `${JSON.stringify(buildPlaces(), null, 0)}\n`;
if (check) {
  if (readFileSync(TARGET, 'utf8') !== next) {
    console.error('scripts/shared/news-places.json is stale: run node scripts/build-news-places.mjs');
    process.exit(1);
  }
} else {
  writeFileSync(TARGET, next);
  console.log(`[news-places] ${Object.keys(JSON.parse(next)).length} names`);
}
