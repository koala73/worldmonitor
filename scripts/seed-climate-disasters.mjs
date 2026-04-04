#!/usr/bin/env node

import { loadEnvFile, runSeed, CHROME_UA, verifySeedKey, loadSharedConfig } from './_seed-utils.mjs';
import { extractCountryCode } from './shared/geo-extract.mjs';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

loadEnvFile(import.meta.url);

const CANONICAL_KEY = 'climate:disasters:v1';
const NATURAL_EVENTS_KEY = 'natural:events:v1';
const CACHE_TTL = 64800; // 18h — 3x the 6h cron interval (gold standard)

const RELIEFWEB_ENDPOINTS = [
  'https://api.reliefweb.int/v1/disasters',
  'https://api.reliefweb.int/v2/disasters',
];

const RELIEFWEB_TYPE_TO_CANONICAL = {
  FL: 'flood',
  TC: 'cyclone',
  DR: 'drought',
  HT: 'heatwave',
  WF: 'wildfire',
};

const COUNTRY_BBOXES = loadSharedConfig('country-bboxes.json');
const __dirname = dirname(fileURLToPath(import.meta.url));
const COUNTRY_GEOJSON = JSON.parse(readFileSync(join(__dirname, '..', 'public', 'data', 'countries.geojson'), 'utf8'));

const COUNTRY_NAME_BY_CODE = {};
const ISO3_TO_ISO2 = {};

for (const feature of COUNTRY_GEOJSON?.features || []) {
  const properties = feature?.properties || {};
  const iso2 = String(properties['ISO3166-1-Alpha-2'] || '').trim().toUpperCase();
  const iso3 = String(properties['ISO3166-1-Alpha-3'] || '').trim().toUpperCase();
  const name = String(properties.name || '').trim();
  if (/^[A-Z]{2}$/.test(iso2) && name) COUNTRY_NAME_BY_CODE[iso2] = name;
  if (/^[A-Z]{2}$/.test(iso2) && /^[A-Z]{3}$/.test(iso3)) ISO3_TO_ISO2[iso3] = iso2;
}

const COUNTRY_CODES_BY_BBOX_AREA = Object.entries(COUNTRY_BBOXES)
  .filter(([, bbox]) => Array.isArray(bbox) && bbox.length === 4)
  .sort(([, a], [, b]) => {
    const areaA = Math.abs((Number(a[2]) - Number(a[0])) * (Number(a[3]) - Number(a[1])));
    const areaB = Math.abs((Number(b[2]) - Number(b[0])) * (Number(b[3]) - Number(b[1])));
    return areaA - areaB;
  })
  .map(([code]) => code);

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value == null) return [];
  return [value];
}

function stableHash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
}

function parseTimestamp(value) {
  const ts = new Date(value || '').getTime();
  return Number.isFinite(ts) && ts > 0 ? ts : Date.now();
}

function normalizeStatus(status) {
  const value = String(status || '').toLowerCase().trim();
  if (value === 'current') return 'ongoing';
  if (value === 'alert' || value === 'ongoing' || value === 'past') return value;
  return 'ongoing';
}

function normalizeDisasterName(value) {
  return String(value || '')
    .replace(/^[\u{1F534}\u{1F7E0}\u{1F7E2}\s-]+/u, '')
    .trim();
}

function mapReliefType(typeCode, typeName) {
  const code = String(typeCode || '').toUpperCase();
  if (RELIEFWEB_TYPE_TO_CANONICAL[code]) return RELIEFWEB_TYPE_TO_CANONICAL[code];
  const lower = String(typeName || '').toLowerCase();
  if (lower.includes('flood')) return 'flood';
  if (lower.includes('cyclone') || lower.includes('hurricane') || lower.includes('typhoon') || lower.includes('storm')) return 'cyclone';
  if (lower.includes('drought')) return 'drought';
  if (lower.includes('heat')) return 'heatwave';
  if (lower.includes('wildfire') || lower.includes('fire')) return 'wildfire';
  return '';
}

function getNaturalSourceMeta(event) {
  const name = String(event?.sourceName || '').toLowerCase();
  const url = String(event?.sourceUrl || '').toLowerCase();
  const id = String(event?.id || '');
  if (name === 'nasa firms' || name.startsWith('firms') || url.includes('firms.modaps.')) return { source: 'NASA FIRMS' };
  if (name === 'gdacs' || name.startsWith('gdacs') || url.includes('gdacs.org') || id.startsWith('gdacs-')) return { source: 'GDACS' };
  return null;
}

function isClimateNaturalEvent(event) {
  if (!event || typeof event !== 'object') return false;
  const sourceMeta = getNaturalSourceMeta(event);
  if (!sourceMeta) return false;

  if (event.category === 'floods' || event.category === 'wildfires') return true;
  if (event.category !== 'severeStorms') return false;
  if (sourceMeta.source !== 'GDACS') return false;

  const text = `${event.categoryTitle || ''} ${event.classification || ''} ${event.title || ''}`.toLowerCase();
  if (event.stormId || event.stormName) return true;
  return /tropical|cyclone|hurricane|typhoon|depression/.test(text);
}

function mapNaturalType(event) {
  if (event.category === 'floods') return 'flood';
  if (event.category === 'wildfires') return 'wildfire';
  if (event.category === 'severeStorms') return 'cyclone';
  return '';
}

function mapNaturalSource(event) {
  return getNaturalSourceMeta(event)?.source || '';
}

function mapNaturalSeverity(event, source) {
  const title = String(event.title || '');
  const desc = String(event.description || '').toLowerCase();
  const stormCategory = Number(event.stormCategory);

  if (title.includes('\u{1F534}') || /\bred\b/.test(desc)) return 'red';
  if (title.includes('\u{1F7E0}') || /\borange\b/.test(desc)) return 'orange';
  if (Number.isFinite(stormCategory)) {
    if (stormCategory >= 3) return 'red';
    if (stormCategory >= 1) return 'orange';
  }
  if (source === 'NASA FIRMS') {
    const magnitude = Number(event.magnitude || 0);
    if (magnitude >= 400) return 'red';
    if (magnitude >= 300) return 'orange';
  }
  return 'green';
}

function mapNaturalStatus(event, severity) {
  if (event.closed === true) return 'past';
  if (severity === 'red' || severity === 'orange') return 'alert';
  return 'ongoing';
}

function getCountryCenter(countryCode) {
  const bbox = COUNTRY_BBOXES[countryCode];
  if (!Array.isArray(bbox) || bbox.length !== 4) return { lat: 0, lng: 0 };
  return {
    lat: (Number(bbox[0]) + Number(bbox[2])) / 2,
    lng: (Number(bbox[1]) + Number(bbox[3])) / 2,
  };
}

function normalizeCountryCode(code) {
  const value = String(code || '').toUpperCase();
  return /^[A-Z]{2}$/.test(value) ? value : '';
}

function getCountryName(countryCode) {
  return COUNTRY_NAME_BY_CODE[normalizeCountryCode(countryCode)] || '';
}

function getCountryCodeFromIso3(code) {
  const value = String(code || '').toUpperCase();
  return /^[A-Z]{3}$/.test(value) ? (ISO3_TO_ISO2[value] || '') : '';
}

function findCountryCodeByCoordinates(lat, lng) {
  const latNum = Number(lat);
  const lngNum = Number(lng);
  if (!Number.isFinite(latNum) || !Number.isFinite(lngNum)) return '';
  for (const code of COUNTRY_CODES_BY_BBOX_AREA) {
    const bbox = COUNTRY_BBOXES[code];
    if (!Array.isArray(bbox) || bbox.length !== 4) continue;
    const [minLat, minLng, maxLat, maxLng] = bbox.map(Number);
    if (latNum >= minLat && latNum <= maxLat && lngNum >= minLng && lngNum <= maxLng) {
      return code;
    }
  }
  return '';
}

function resolveCountryInfo({ code = '', iso3 = '', name = '', lat = NaN, lng = NaN, fallbackText = '' } = {}) {
  const normalizedName = String(name || '').trim();
  const fromIso2 = normalizeCountryCode(code);
  const fromIso3 = getCountryCodeFromIso3(iso3);
  const fromText = normalizeCountryCode(extractCountryCode(`${normalizedName} ${fallbackText}`));
  const fromPoint = findCountryCodeByCoordinates(lat, lng);
  const countryCode = fromIso2 || fromIso3 || fromText || fromPoint;
  return {
    countryCode,
    country: normalizedName || getCountryName(countryCode),
  };
}

// Railway must set RELIEFWEB_APPNAME to an approved ReliefWeb appname
// before enabling this seed, or ReliefWeb fetches will fail closed.
function getReliefWebAppname() {
  const appname = String(process.env.RELIEFWEB_APPNAME || process.env.RELIEFWEB_APP_NAME || '').trim();
  if (!appname) {
    const err = new Error('RELIEFWEB_APPNAME is required; ReliefWeb now requires a pre-approved appname');
    err.isConfigError = true;
    throw err;
  }
  return appname;
}

function buildReliefWebRequestBodies() {
  return [
    {
      limit: 250,
      sort: ['date.event:desc'],
      fields: {
        include: ['name', 'country', 'primary_country', 'primary_type', 'type', 'date', 'glide', 'status', 'url'],
      },
      filter: {
        operator: 'AND',
        conditions: [
          { field: 'status', value: ['alert', 'current', 'ongoing'], operator: 'OR' },
          { field: 'type.code', value: ['FL', 'TC', 'DR', 'HT', 'WF'], operator: 'OR' },
        ],
      },
    },
  ];
}

function mapReliefItem(item) {
  const fields = item?.fields || {};

  const typedEntries = asArray(fields.type);
  const primaryType = typedEntries.find((entry) => entry?.primary) || typedEntries[0] || {};
  const fallbackPrimaryType = asArray(fields.primary_type)[0] || {};
  const type = mapReliefType(primaryType.code, primaryType.name || fallbackPrimaryType.name);
  if (!type) return null;

  const status = normalizeStatus(fields.status);
  if (status !== 'alert' && status !== 'ongoing') return null;

  const countries = [
    ...asArray(fields.primary_country),
    ...asArray(fields.country),
  ];
  const countryEntry = countries.find((country) => country?.primary) || countries[0] || {};
  const { country, countryCode } = resolveCountryInfo({
    code: countryEntry.code,
    iso3: countryEntry.iso3,
    name: countryEntry.shortname || countryEntry.name,
    fallbackText: fields.name,
  });
  if (!countryCode) return null;
  const coords = getCountryCenter(countryCode);

  const startedAt = parseTimestamp(fields?.date?.event || fields?.date?.created || fields?.date?.changed);
  const name = normalizeDisasterName(fields.name || '');
  const reliefId = fields.glide || item?.id || stableHash(`${name}-${country}-${startedAt}`);

  return {
    id: `reliefweb-${reliefId}`,
    type,
    name,
    country,
    countryCode,
    lat: coords.lat,
    lng: coords.lng,
    severity: status === 'alert' ? 'high' : 'medium',
    startedAt,
    status,
    affectedPopulation: 0,
    source: 'ReliefWeb',
    sourceUrl: String(fields.url || '').trim(),
  };
}

async function fetchReliefWeb() {
  const appname = getReliefWebAppname();
  const requestBodies = buildReliefWebRequestBodies();

  let lastError = null;
  for (const endpoint of RELIEFWEB_ENDPOINTS) {
    for (const body of requestBodies) {
      try {
        const url = `${endpoint}?appname=${encodeURIComponent(appname)}`;
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            'User-Agent': CHROME_UA,
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(20_000),
        });
        if (!response.ok) {
          const text = await response.text().catch(() => '');
          throw new Error(`HTTP ${response.status} ${text.slice(0, 160)}`);
        }

        const payload = await response.json();
        const rows = asArray(payload?.data);
        if (!rows.length) continue;

        const mapped = rows.map(mapReliefItem).filter(Boolean);
        if (mapped.length > 0) return mapped;
        if (rows.length > 0) console.warn(`[climate-disasters] ${rows.length} ReliefWeb rows returned but all mapped to null`);
      } catch (err) {
        lastError = err;
        const message = String(err?.message || err);
        if (/approved appname/i.test(message) || /HTTP 40[13]/.test(message)) {
          const cfgErr = new Error(`ReliefWeb rejected RELIEFWEB_APPNAME="${appname}" — configure an approved appname`);
          cfgErr.isConfigError = true;
          throw cfgErr;
        }
      }
    }
  }

  if (lastError) throw lastError;
  throw new Error('ReliefWeb returned no climate disaster rows');
}

function mapNaturalEvent(event) {
  const type = mapNaturalType(event);
  if (!type) return null;

  const source = mapNaturalSource(event);
  if (source !== 'GDACS' && source !== 'NASA FIRMS') return null;
  const severity = mapNaturalSeverity(event, source);
  const status = mapNaturalStatus(event, severity);
  const lat = Number(event.lat);
  const lng = Number(event.lon);
  const { country, countryCode } = resolveCountryInfo({
    lat,
    lng,
    fallbackText: `${event.title || ''} ${event.description || ''}`,
  });
  if (!countryCode) return null;
  const startedAt = parseTimestamp(event.date);

  return {
    id: String(event.id || stableHash(`${event.title || ''}-${startedAt}`)),
    type,
    name: normalizeDisasterName(event.title || event.stormName || event.categoryTitle || 'Untitled disaster'),
    country,
    countryCode,
    lat: Number.isFinite(lat) ? lat : 0,
    lng: Number.isFinite(lng) ? lng : 0,
    severity,
    startedAt,
    status,
    affectedPopulation: 0,
    source,
    sourceUrl: String(event.sourceUrl || '').trim(),
  };
}

async function fetchNaturalClimateDisasters() {
  const data = await verifySeedKey(NATURAL_EVENTS_KEY).catch(() => null);
  const events = asArray(data?.events);
  return events
    .filter(isClimateNaturalEvent)
    .map(mapNaturalEvent)
    .filter(Boolean);
}

function dedupeAndSort(entries) {
  const byId = new Set();
  const byFingerprint = new Set();
  const deduped = [];

  for (const entry of entries) {
    const idKey = `${entry.source}:${entry.id}`;
    if (byId.has(idKey)) continue;
    byId.add(idKey);

    const dayBucket = Math.floor(Number(entry.startedAt || 0) / 86_400_000);
    const fingerprint = [
      entry.type,
      entry.countryCode || entry.country || '',
      String(entry.name || '').toLowerCase(),
      dayBucket,
    ].join('|');
    if (byFingerprint.has(fingerprint)) continue;
    byFingerprint.add(fingerprint);

    deduped.push(entry);
  }

  deduped.sort((a, b) => Number(b.startedAt || 0) - Number(a.startedAt || 0));
  return deduped.slice(0, 300);
}

function toRedisDisaster(entry) {
  return {
    id: String(entry.id || ''),
    type: String(entry.type || ''),
    name: String(entry.name || ''),
    country: String(entry.country || ''),
    countryCode: String(entry.countryCode || ''),
    lat: Number(entry.lat || 0),
    lng: Number(entry.lng || 0),
    severity: String(entry.severity || ''),
    startedAt: Number(entry.startedAt || 0),
    status: String(entry.status || ''),
    affectedPopulation: Number(entry.affectedPopulation || 0),
    source: String(entry.source || ''),
    sourceUrl: String(entry.sourceUrl || ''),
  };
}

function collectDisasterSourceResults(results) {
  const failures = [];
  const combined = [];

  for (const result of results) {
    if (result.status === 'fulfilled') {
      combined.push(...asArray(result.value));
      continue;
    }
    const err = result.reason;
    if (err?.isConfigError) throw err;
    failures.push(err);
    const message = String(err?.message || err || 'unknown source failure');
    console.warn(`[seed-climate-disasters] partial source failure: ${message}`);
  }

  const disasters = dedupeAndSort(combined);
  if (disasters.length > 0) return disasters;

  const errorMessages = failures
    .map((err) => String(err?.message || err || '').trim())
    .filter(Boolean);
  throw new Error(errorMessages[0] || 'No climate disaster sources returned data');
}

async function fetchClimateDisasters() {
  const results = await Promise.allSettled([
    fetchReliefWeb(),
    fetchNaturalClimateDisasters(),
  ]);
  return { disasters: collectDisasterSourceResults(results).map(toRedisDisaster) };
}

export {
  buildReliefWebRequestBodies,
  collectDisasterSourceResults,
  getNaturalSourceMeta,
  getReliefWebAppname,
  isClimateNaturalEvent,
  findCountryCodeByCoordinates,
  mapNaturalEvent,
  toRedisDisaster,
};

function isMain() {
  return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isMain()) {
  runSeed('climate', 'disasters', CANONICAL_KEY, fetchClimateDisasters, {
    validateFn: (data) => Array.isArray(data?.disasters) && data.disasters.length > 0,
    recordCount: (data) => data?.disasters?.length || 0,
    ttlSeconds: CACHE_TTL,
    sourceVersion: 'reliefweb+natural-cache-v1',
  }).catch((err) => {
    const _cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : '';
    console.error('FATAL:', (err.message || err) + _cause);
    process.exit(1);
  });
}
