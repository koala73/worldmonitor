#!/usr/bin/env node
// Builds scripts/shared/judged-subject-terms.json: the words a headline uses for
// every subject a judged forecast can name (#8990). The judged resolver shows a
// judge only items that match the forecast's subject, so this table decides
// what evidence exists for a question.
//
// Countries come from every ISO code in shared/country-names.json, with names,
// aliases, demonyms and exclusions from shared/country-mention.js plus the
// capitals and keywords in scripts/data/country-codes.json (the CII names the
// forecast emitter uses). Non-country regions come from REGIONS below. The
// build fails when any region label the emitter can produce
// (seed-forecasts.mjs EMITTED_REGION_LABELS) resolves to neither.
//
// Usage: node scripts/build-judged-subject-terms.mjs [--check]
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { countryMentionTerms } from '../shared/country-mention.js';
import { normalizeSubjectText as normalize } from './seed-forecast-resolutions.mjs';

const OUTPUT = fileURLToPath(new URL('./shared/judged-subject-terms.json', import.meta.url));
const COUNTRY_NAMES = JSON.parse(readFileSync(new URL('../shared/country-names.json', import.meta.url), 'utf8'));
const COUNTRY_CODES = JSON.parse(readFileSync(new URL('./data/country-codes.json', import.meta.url), 'utf8'));

// Names that are also common words, people, US states or neighbours' names.
// A weak term counts only when the same item also carries one of its co-terms
// or one of the country's strong terms.
const AMBIGUOUS = {
  GE: { weak: ['georgia'], co: ['tbilisi', 'caucasus', 'abkhazia', 'ossetia', 'georgian dream', 'kobakhidze', 'ivanishvili', 'batumi', 'kremlin', 'moscow'] },
  JO: { weak: ['jordan'], co: ['amman', 'hashemite', 'king abdullah', 'israel', 'israeli', 'gaza', 'west bank', 'syria', 'iraq', 'middle east', 'palestinian'] },
  TD: { weak: ['chad'], co: ['ndjamena', 'n djamena', 'sahel', 'darfur', 'sudan', 'sudanese', 'deby', 'africa', 'african'] },
  NE: { weak: ['niger'], co: ['niamey', 'sahel', 'tiani', 'junta', 'mali', 'burkina', 'ecowas', 'africa', 'african'] },
  TR: { weak: ['turkey'], co: ['ankara', 'erdogan', 'istanbul', 'kurdish', 'pkk', 'syria', 'nato', 'lira', 'turkiye'] },
  CG: { weak: ['congo'], co: ['brazzaville', 'sassou'] },
  CD: { weak: ['congo'], co: ['kinshasa', 'goma', 'kivu', 'ituri', 'm23', 'tshisekedi', 'ebola', 'drc', 'rwanda'] },
};
// Further exclusions on top of country-mention's.
const EXTRA_EXCLUSIONS = {
  NE: ['niger state', 'niger delta', 'niger river'],
  US: ['latin america', 'south america', 'central america', 'north america'],
};
// country-codes keywords that name something else in ordinary news.
const DROPPED_KEYWORDS = {
  US: ['america'],
};
// Places and forms the other sources miss.
const EXTRA_TERMS = {
  AF: ['taliban'],
  CD: ['m23', 'goma'],
  ET: ['addis ababa', 'tigray', 'amhara'],
  GB: ['u k', 'uk'],
  IL: ['israeli'],
  IR: ['tehran', 'iranian'],
  KP: ['dprk', 'kim jong un'],
  MZ: ['cabo delgado'],
  NG: ['boko haram'],
  PK: ['khyber', 'balochistan', 'waziristan'],
  PS: ['hamas', 'palestinian', 'palestinians'],
  RU: ['kremlin'],
  SD: ['rsf', 'el fasher'],
  SY: ['aleppo', 'idlib'],
  TW: ['taiwan strait'],
  UA: ['kiev', 'kharkiv', 'donbas', 'odesa'],
  US: ['u s'],
  YE: ['houthi', 'houthis', 'sanaa'],
};

const REGIONS = {
  africa: { terms: ['africa', 'african'], countries: [] },
  americas: { terms: ['americas', 'latin america', 'south america', 'central america', 'caribbean'], countries: [] },
  'asia-pacific': { terms: ['asia pacific', 'indo pacific', 'south china sea', 'taiwan strait'], countries: ['TW'] },
  'baltic sea': { terms: ['baltic', 'kaliningrad', 'gulf of finland'], countries: ['EE', 'LV', 'LT'] },
  'baltic theater': { terms: ['baltic', 'nordic', 'kaliningrad'], countries: ['EE', 'LV', 'LT', 'FI', 'SE'] },
  'black sea': { terms: ['black sea', 'crimea', 'crimean', 'odesa', 'sevastopol', 'kerch', 'novorossiysk', 'bosphorus'], countries: [] },
  'eastern mediterranean': { terms: ['eastern mediterranean', 'east mediterranean', 'levant', 'aegean'], countries: ['CY', 'LB'] },
  europe: { terms: ['europe', 'european', 'eu'], countries: [] },
  'iran theater': { terms: ['persian gulf', 'hormuz'], countries: ['IR'] },
  'israel/gaza': { terms: ['idf'], countries: ['IL', 'PS'] },
  'kerch strait': { terms: ['kerch', 'crimean bridge'], countries: [] },
  'korean peninsula': { terms: ['korean peninsula', 'korea', 'korean', 'dprk'], countries: ['KP', 'KR'] },
  'latin america': { terms: ['latin america', 'south america', 'central america', 'caribbean'], countries: [] },
  'middle east': { terms: ['middle east', 'mideast', 'hezbollah', 'houthi', 'houthis', 'persian gulf', 'hormuz'], countries: ['IR', 'IL', 'PS', 'LB', 'SY', 'IQ', 'YE', 'SA', 'QA', 'AE', 'KW', 'BH', 'OM', 'JO'] },
  'northern europe': { terms: ['northern europe', 'baltic', 'nordic', 'scandinavia', 'kaliningrad'], countries: ['FI', 'SE', 'NO', 'DK', 'EE', 'LV', 'LT'] },
  oceania: { terms: ['oceania', 'pacific islands'], countries: ['AU', 'NZ'] },
  'persian gulf': { terms: ['persian gulf', 'gulf of oman', 'hormuz'], countries: ['IR', 'QA', 'BH', 'KW', 'SA', 'AE', 'OM'] },
  'red sea': { terms: ['red sea', 'houthi', 'houthis', 'bab el mandeb', 'suez', 'gulf of aden'], countries: [] },
  sahel: { terms: ['sahel'], countries: ['ML', 'NE', 'BF', 'TD'] },
  'south china sea': { terms: ['south china sea', 'spratly', 'paracel', 'scarborough shoal', 'second thomas shoal'], countries: [] },
  'strait of hormuz': { terms: ['hormuz'], countries: [] },
  'taiwan strait': { terms: ['taiwan strait'], countries: ['TW'] },
  'western pacific': { terms: ['western pacific', 'taiwan strait', 'south china sea', 'east china sea', 'philippine sea', 'guam', 'okinawa'], countries: ['TW'] },
  'yemen/red sea': { terms: ['red sea', 'houthi', 'houthis', 'bab el mandeb', 'gulf of aden'], countries: ['YE'] },
  // Chokepoints (server/_shared/chokepoint-registry.ts display names).
  'bab el-mandeb': { terms: ['bab el mandeb', 'red sea', 'houthi', 'houthis', 'gulf of aden'], countries: [] },
  'bosporus strait': { terms: ['bosporus', 'bosphorus'], countries: [] },
  'cape of good hope': { terms: ['cape of good hope'], countries: [] },
  'dover strait': { terms: ['dover', 'english channel'], countries: [] },
  'korea strait': { terms: ['korea strait', 'tsushima'], countries: [] },
  'lombok strait': { terms: ['lombok'], countries: [] },
  'panama canal': { terms: ['panama canal'], countries: [] },
  'strait of gibraltar': { terms: ['gibraltar'], countries: [] },
  'strait of malacca': { terms: ['malacca'], countries: [] },
  'suez canal': { terms: ['suez'], countries: [] },
};
const CHOKEPOINT_REGISTRY = readFileSync(new URL('../server/_shared/chokepoint-registry.ts', import.meta.url), 'utf8');
const CHOKEPOINT_LABELS = [...CHOKEPOINT_REGISTRY.matchAll(/displayName: '([^']+)'/g)].map((match) => match[1]);

const sorted = (values) => [...new Set(values.filter(Boolean))].sort();

function countryEntry(code) {
  const mention = countryMentionTerms(code);
  const ambiguous = AMBIGUOUS[code];
  const weak = new Set(ambiguous?.weak || []);
  const dropped = new Set(DROPPED_KEYWORDS[code] || []);
  const keywords = (COUNTRY_CODES[code]?.keywords || []).map(normalize);
  const name = normalize(COUNTRY_CODES[code]?.name || '');
  const terms = sorted([...mention.names, name, ...keywords, ...(EXTRA_TERMS[code] || [])].map(normalize)
    .filter((term) => !weak.has(term) && !dropped.has(term)));
  return {
    terms,
    demonyms: sorted(mention.demonyms),
    exclusions: sorted([...mention.exclusions, ...(EXTRA_EXCLUSIONS[code] || [])].map(normalize)),
    ...(weak.size ? { weak: sorted([...weak]), coTerms: sorted(ambiguous.co.map(normalize)) } : {}),
    ...(code === 'US' ? { codeToken: 'US' } : {}),
  };
}

export function buildJudgedSubjectTerms() {
  const labels = {};
  for (const [name, code] of Object.entries(COUNTRY_NAMES)) labels[normalize(name)] = code;
  for (const [code, row] of Object.entries(COUNTRY_CODES)) labels[normalize(row.name)] = code;
  const codes = sorted(Object.values(labels));
  const countries = {};
  for (const code of codes) countries[code] = countryEntry(code);
  const regions = {};
  for (const [label, region] of Object.entries(REGIONS)) {
    for (const code of region.countries) if (!countries[code]) throw new Error(`region ${label} names unknown country ${code}`);
    regions[normalize(label)] = { terms: sorted(region.terms.map(normalize)), countries: sorted(region.countries) };
  }
  const sortedRegions = Object.fromEntries(Object.entries(regions).sort(([a], [b]) => a.localeCompare(b)));
  const sortedLabels = Object.fromEntries(Object.entries(labels).sort(([a], [b]) => a.localeCompare(b)));
  return { version: 1, regions: sortedRegions, labels: sortedLabels, countries };
}

async function main() {
  const table = buildJudgedSubjectTerms();
  const { EMITTED_REGION_LABELS } = await import('./seed-forecasts.mjs');
  const { judgedSubjectKind } = await import('./seed-forecast-resolutions.mjs');
  const uncovered = [...EMITTED_REGION_LABELS, ...CHOKEPOINT_LABELS].filter((label) => judgedSubjectKind(label, table) === 'fallback');
  if (uncovered.length) throw new Error(`emitted region labels without a subject entry: ${uncovered.join(', ')}`);
  const text = `${JSON.stringify(table, null, 1)}\n`;
  if (process.argv.includes('--check')) {
    const current = readFileSync(OUTPUT, 'utf8');
    if (current !== text) {
      console.error('scripts/shared/judged-subject-terms.json is stale; run node scripts/build-judged-subject-terms.mjs');
      process.exit(1);
    }
    console.log('judged-subject-terms.json is current');
    return;
  }
  writeFileSync(OUTPUT, text);
  console.log(`wrote ${OUTPUT}: ${Object.keys(table.countries).length} countries, ${Object.keys(table.regions).length} regions`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
