#!/usr/bin/env node
// Regenerates scripts/data/outbreak-places.json from GeoNames dumps
// (cities15000.txt and admin1CodesASCII.txt, CC BY 4.0, geonames.org).
//
// Headline sources (ECDC, CIDRAP, WHO briefings) name a city or region but
// give no coordinates. The disease-outbreaks seeder looks those names up within
// the item's detected country instead of pinning the country centroid.
//
// Each country maps to [name, lat, lng] rows, longest name first:
//   - cities with at least MIN_POPULATION inhabitants;
//   - first-level regions, positioned at their administrative seat (PPLA),
//     with and without a generic suffix ("Irkutsk Oblast" and "Irkutsk").
// Names under four characters and names equal to the country's own English
// name are left out, so a country-level headline keeps its centroid.
// EXCLUDED_NAMES drops place names that headlines use as ordinary words:
// compass regions left by suffix stripping ("Northern Region" -> "Northern"),
// epidemiology terms ("Delta" variant, "Corona", "Oral"), and common nouns and
// surnames that open sentences ("Reading", "Warren").
//
// Usage: node scripts/build-outbreak-places.mjs <cities15000.txt> <admin1CodesASCII.txt>

import { readFileSync, writeFileSync } from 'node:fs';

const TARGET = new URL('./data/outbreak-places.json', import.meta.url);
const MIN_POPULATION = 100_000;
// A region outranks a smaller city of the same name (Irkutsk Oblast's seat is
// Irkutsk anyway); a city this large outranks a region named like it.
const MAJOR_CITY_POPULATION = 1_000_000;
const MIN_NAME_LENGTH = 4;
const REGION_SUFFIX_RE = /\s+(?:Oblast|Krai|Kray|Province|Region|Governorate|State|Prefecture|Department|District|County|Territory|Republic|Autonomous Okrug|Okrug)$/;
const REGION_NAMES = new Intl.DisplayNames(['en'], { type: 'region' });
const EXCLUDED_NAMES = new Set([
  'North', 'South', 'East', 'West', 'Northern', 'Southern', 'Eastern', 'Western', 'Central', 'Centrale',
  'Northeast', 'Northeastern', 'Southeastern', 'Capital', 'Commonwealth', 'Free', 'Littoral', 'Maritime',
  'Oriental', 'Plateau', 'Plateaux', 'Cordillera', 'Poblacion',
  'Delta', 'Corona', 'Colon', 'Oral', 'Male', 'Mary', 'Mango', 'Bush',
  'Reading', 'Mobile', 'Independence', 'Enterprise', 'Providence', 'Surprise', 'Paradise', 'Orange',
  'Concord', 'Phoenix', 'Aurora', 'Nice', 'Split', 'Batman', 'Ogre', 'Sale', 'Mesa', 'Vista', 'Centennial',
  'Warren', 'Garland', 'Chandler', 'Gilbert', 'Newton', 'Nelson', 'Dudley', 'Harrow', 'Barking', 'Archway',
  'Falcon', 'Lander', 'Flores', 'Bolivar', 'Hidalgo', 'Mantilla', 'Lafayette', 'Davenport', 'Kitchener',
  // The US capital, its government, and a state 3,700 km away.
  'Washington',
]);

const [citiesPath, admin1Path] = process.argv.slice(2);
if (!citiesPath || !admin1Path) {
  console.error('Usage: node scripts/build-outbreak-places.mjs <cities15000.txt> <admin1CodesASCII.txt>');
  process.exit(1);
}

const round = (n) => Math.round(n * 100) / 100;
const places = new Map(); // country -> Map(name -> { lat, lng, rank })

function add(country, name, lat, lng, rank) {
  const trimmed = name.trim();
  if (trimmed.length < MIN_NAME_LENGTH || EXCLUDED_NAMES.has(trimmed)) return;
  let countryName;
  try { countryName = REGION_NAMES.of(country); } catch { return; }
  if (trimmed.toLowerCase() === String(countryName).toLowerCase()) return;
  if (!places.has(country)) places.set(country, new Map());
  const byName = places.get(country);
  const existing = byName.get(trimmed);
  if (!existing || rank > existing.rank) byName.set(trimmed, { lat: round(lat), lng: round(lng), rank });
}

const seats = new Map(); // "CC.admin1" -> { lat, lng }
const majorCities = new Map(); // "CC.name" -> { lat, lng } for cities of MAJOR_CITY_POPULATION or more
for (const line of readFileSync(citiesPath, 'utf8').split('\n')) {
  const f = line.split('\t');
  if (f.length < 15) continue;
  const [, name, asciiName] = f;
  const lat = Number(f[4]), lng = Number(f[5]);
  const featureCode = f[7], country = f[8], admin1 = f[10], population = Number(f[14]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || !/^[A-Z]{2}$/.test(country)) continue;
  if (featureCode === 'PPLA') seats.set(`${country}.${admin1}`, { lat, lng });
  if (population >= MAJOR_CITY_POPULATION) majorCities.set(`${country}.${name}`, { lat, lng });
  if (population >= MIN_POPULATION) {
    add(country, name, lat, lng, population);
    add(country, asciiName, lat, lng, population);
  }
}

for (const line of readFileSync(admin1Path, 'utf8').split('\n')) {
  const [code, name, asciiName] = line.split('\t');
  const seat = seats.get(code);
  if (!seat || !name) continue;
  const country = code.slice(0, 2);
  for (const variant of new Set([name, asciiName, name.replace(REGION_SUFFIX_RE, ''), asciiName?.replace(REGION_SUFFIX_RE, '')])) {
    if (!variant) continue;
    // GeoNames names the city "New York City"; headlines say "New York".
    const city = majorCities.get(`${country}.${variant} City`);
    if (city) add(country, variant, city.lat, city.lng, MAJOR_CITY_POPULATION);
    else add(country, variant, seat.lat, seat.lng, MAJOR_CITY_POPULATION);
  }
}

const out = {};
for (const country of [...places.keys()].sort()) {
  out[country] = [...places.get(country)]
    .sort(([a], [b]) => b.length - a.length || a.localeCompare(b))
    .map(([name, { lat, lng }]) => [name, lat, lng]);
}
writeFileSync(TARGET, `${JSON.stringify(out)}\n`);
console.log(`[outbreak-places] ${Object.keys(out).length} countries, ${Object.values(out).reduce((n, rows) => n + rows.length, 0)} names`);
