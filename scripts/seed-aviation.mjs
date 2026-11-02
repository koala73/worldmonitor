#!/usr/bin/env node

/**
 * Consolidated aviation seeder. Writes four Redis keys from one cron tick:
 *
 *   aviation:delays:intl:v3      — AviationStack per-airport delay aggregates (56 intl)
 *   aviation:delays:faa:v1       — FAA ASWS XML delays (30 US)
 *   aviation:notam:closures:v2   — ICAO NOTAM closures (60 global)
 *   aviation:news:feeds:v2         — RSS news prewarmer (list-aviation-news.ts cache)
 *
 * Also publishes notifications for new severe/major airport disruptions and new
 * NOTAM closures via the standard wm:events:queue LPUSH + wm:notif:scan-dedup SETNX.
 * Prev-alerted state is persisted to Redis so short-lived cron invocations don't
 * re-notify on every tick.
 *
 * @notification-source: domain (aviation)
 *   publishNotificationEvent() calls in this file build payload.title from
 *   structured airport/ICAO/delay/NOTAM fields. Events are NOT RSS-origin
 *   and MUST NOT set payload.description. Enforced by
 *   tests/notification-relay-payload-audit.test.mjs.
 *
 * Supersedes: scripts/seed-airport-delays.mjs (deleted) + the in-process seed
 * loops that used to live inside scripts/ais-relay.cjs (stripped). ais-relay still
 * hosts the /aviationstack live proxy for user-triggered flight lookups.
 */

import { XMLParser } from 'fast-xml-parser';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  loadEnvFile,
  CHROME_UA,
  runSeed,
  writeExtraKeyWithMeta,
  writeSeedMeta,
  extendExistingTtl,
  acquireLockSafely,
  releaseLock,
  getRedisCredentials,
  readCanonicalValue,
  markPreservableFetchFailure,
} from './_seed-utils.mjs';
import notificationDedup from './shared/notification-dedup.cjs';
import countryNameMap from './shared/country-name-to-iso2.cjs';
import { unwrapEnvelope } from './_seed-envelope-source.mjs';
import { airportNotifyLocation } from './lib/airport-notify-location.mjs';
import { NARROW_CLOSURE_TEXT, NMS_ACTIVATION_KEY, NMS_CLOSURES_KEY, isFreshNmsClosures, mergeClosureSources } from './lib/nms-notam.mjs';

const {
  buildDedupMaterial,
  classifySetNxResult,
  recordDedupOutcome,
} = notificationDedup;
const { countryNameToIso2 } = countryNameMap;

loadEnvFile(import.meta.url);

// ─── Redis keys / TTLs ───────────────────────────────────────────────────────

const INTL_KEY         = 'aviation:delays:intl:v3';
const FAA_KEY          = 'aviation:delays:faa:v1';
const NOTAM_KEY        = 'aviation:notam:closures:v2';
export const NEWS_KEY  = 'aviation:news:feeds:v2';
// Page-load hydration aggregate. Health (api/health.js BOOTSTRAP_KEYS.flightDelays)
// reads STRLEN here, and its record count from BOOTSTRAP_META_KEY below — which
// must be written from THIS payload, not from a contributing source's own count
// (#6987). Historically only written as a 1800s RPC side-effect inside
// list-airport-delays.ts — quiet user windows >30min would let it expire, tripping
// EMPTY (CRIT) even with healthy upstream feeds. Now produced canonically by this
// seeder; RPC keeps its write at the same TTL as a courtesy mid-tick refresh.
// #3707: bumped to v2 after the UNKNOWN-row coverage fix so post-deploy clients
// don't briefly see pre-fix cached payloads that synthesise NORMAL rows for
// uncovered airports.
export const BOOTSTRAP_KEY = 'aviation:delays-bootstrap:v2';
// Freshness + count for the aggregate above. flightDelays previously borrowed
// seed-meta:aviation:faa, which counts FAA alerts only: a quiet FAA window
// published recordCount=0 while this aggregate still served ~115 alerts from
// AviationStack and NOTAM, and health read that zero as EMPTY_DATA (#6987).
export const BOOTSTRAP_META_KEY = 'seed-meta:aviation:delays-bootstrap';

const INTL_TTL      = 10_800; // 3h — survives ~5 consecutive missed 30min cron ticks
const FAA_TTL       = 7_200;  // 2h
const NOTAM_TTL     = 7_200;  // 2h
// Must equal api/health.js SEED_META.notamClosures.maxStaleMin: last-good
// closures stop being retained once health would call them stale.
const NOTAM_MAX_STALE_MIN = 240;
export const NEWS_TTL = 2_400;  // 40min
const BOOTSTRAP_TTL = 7_200;  // 2h — matches FAA/NOTAM; survives ~4 missed cron ticks

function nonNegativeEnv(name, fallback, max = Number.POSITIVE_INFINITY) {
  const value = process.env[name]?.trim();
  if (!value) return fallback;
  const raw = Number(value);
  return Number.isFinite(raw) && raw >= 0 ? Math.min(raw, max) : fallback;
}

// AviationStack quota guard. AviationStack is a PAID, per-airport API: one call
// per airport (~55 today) on EVERY cron tick, with no upstream batching. Intl
// airport-delay data moves slowly (already cached 30min client-side, 3h Redis
// TTL), so re-buying all 55 airports on a 10–30min cron burns quota for data we
// already hold. When the last successful intl publish is younger than this, we
// SKIP the fetch entirely and just extend the last-good TTLs — turning the cron
// cadence into an effective floor of INTL_MIN_REFRESH_MIN between paid fetches.
//
// Keep at or below runSeed's maxStaleMin (90) minus one 30min cron interval so
// seed-meta fetchedAt never ages into a false STALE_SEED: 55min default leaves
// headroom even on a 30min cron (worst-case fetchedAt age ≈ 55+30 = 85 < 90).
// Set to 0 to disable the gate (fetch every tick, legacy behaviour). Override
// via AVIATIONSTACK_MIN_REFRESH_MIN.
const MAX_INTL_MIN_REFRESH_MIN = 60;
const INTL_MIN_REFRESH_MIN = nonNegativeEnv('AVIATIONSTACK_MIN_REFRESH_MIN', 55, MAX_INTL_MIN_REFRESH_MIN);

// health.js expects these exact meta keys (api/health.js:222,223,269)
const INTL_META_KEY  = 'seed-meta:aviation:intl';
const FAA_META_KEY   = 'seed-meta:aviation:faa';
const NOTAM_META_KEY = 'seed-meta:aviation:notam';

// Notification dedup state (persisted so cron runs don't spam on every tick)
const AVIATION_PREV_ALERTED_KEY = 'notifications:dedup:aviation:prev-alerted:v1';
const NOTAM_PREV_CLOSED_KEY     = 'notam:prev-closed-state:v1';
const PREV_STATE_TTL            = 86_400; // 24h — longer than any realistic cron cadence

// ─── Unified airport registry ────────────────────────────────────────────────
// Each row declares: iata, icao, name, city, country, region, lat, lon, and
// which data sources cover it:
//   'aviationstack' — AviationStack /v1/flights?dep_iata={iata}
//   'faa'           — FAA ASWS XML filter matches this IATA
//   'notam'         — ICAO NOTAM list includes this ICAO
// Every row needs real lat/lon: each one becomes a map marker, and a missing
// position used to publish at 0,0 (tests/aviation-airport-coordinates.test.mjs).

// Keep this provider contract narrow and evidence-backed: these are individual
// hubs AviationStack is expected to return, not a claim that every airport in
// China's ICAO allocation is covered.
export const CHINA_AVIATIONSTACK_HUBS = [
  { iata: 'PEK', icao: 'ZBAA', name: 'Beijing Capital',                 city: 'Beijing',   country: 'China', lat: 40.0799, lon: 116.6031, region: 'apac', sources: ['aviationstack', 'notam'] },
  { iata: 'PVG', icao: 'ZSPD', name: 'Shanghai Pudong',                 city: 'Shanghai',  country: 'China', lat: 31.1443, lon: 121.8083, region: 'apac', sources: ['aviationstack'] },
  { iata: 'CAN', icao: 'ZGGG', name: 'Guangzhou Baiyun International', city: 'Guangzhou', country: 'China', lat: 23.3924, lon: 113.2988, region: 'apac', sources: ['aviationstack'] },
  { iata: 'SZX', icao: 'ZGSZ', name: "Shenzhen Bao'an International", city: 'Shenzhen',  country: 'China', lat: 22.6393, lon: 113.8107, region: 'apac', sources: ['aviationstack'] },
  { iata: 'CTU', icao: 'ZUUU', name: 'Chengdu Shuangliu International', city: 'Chengdu',  country: 'China', lat: 30.5785, lon: 103.9471, region: 'apac', sources: ['aviationstack'] },
  { iata: 'KMG', icao: 'ZPPP', name: 'Kunming Changshui',              city: 'Kunming',   country: 'China', lat: 25.1019, lon: 102.9292, region: 'apac', sources: ['aviationstack', 'notam'] },
  { iata: 'URC', icao: 'ZWWW', name: 'Urumqi Diwopu International',    city: 'Urumqi',    country: 'China', lat: 43.9071, lon: 87.4742,  region: 'apac', sources: ['aviationstack'] },
  { iata: 'HKG', icao: 'VHHH', name: 'Hong Kong International',        city: 'Hong Kong', country: 'China', lat: 22.3080, lon: 113.9185, region: 'apac', sources: ['aviationstack', 'notam'] },
];

export const AIRPORTS = [
  // ── Americas — AviationStack + NOTAM ──
  { iata: 'YYZ', icao: 'CYYZ', name: 'Toronto Pearson',           city: 'Toronto',      country: 'Canada',   lat: 43.6777,  lon: -79.6248, region: 'americas', sources: ['aviationstack', 'notam'] },
  { iata: 'YVR', icao: 'CYVR', name: 'Vancouver International',   city: 'Vancouver',    country: 'Canada',   lat: 49.1947,  lon: -123.1792, region: 'americas', sources: ['aviationstack'] },
  { iata: 'MEX', icao: 'MMMX', name: 'Mexico City International', city: 'Mexico City',  country: 'Mexico',   lat: 19.4363,  lon: -99.0721, region: 'americas', sources: ['aviationstack', 'notam'] },
  { iata: 'GRU', icao: 'SBGR', name: 'São Paulo–Guarulhos',       city: 'São Paulo',    country: 'Brazil',   lat: -23.4356, lon: -46.4731, region: 'americas', sources: ['aviationstack', 'notam'] },
  { iata: 'EZE', icao: 'SAEZ', name: 'Ministro Pistarini',        city: 'Buenos Aires', country: 'Argentina', lat: -34.8222, lon: -58.5358, region: 'americas', sources: ['aviationstack'] },
  { iata: 'BOG', icao: 'SKBO', name: 'El Dorado International',   city: 'Bogotá',       country: 'Colombia', lat: 4.7016,   lon: -74.1469, region: 'americas', sources: ['aviationstack', 'notam'] },
  { iata: 'SCL', icao: 'SCEL', name: 'Arturo Merino Benítez',     city: 'Santiago',     country: 'Chile',    lat: -33.3930, lon: -70.7858, region: 'americas', sources: ['aviationstack', 'notam'] },

  // Americas NOTAM-only
  { iata: 'LIM', icao: 'SPJC', name: 'Jorge Chávez International', city: 'Lima', country: 'Peru', lat: -12.0219, lon: -77.1143, region: 'americas', sources: ['notam'] },

  // ── Americas — FAA + NOTAM (US only; many dual-covered with AviationStack too for intl flights) ──
  { iata: 'ATL', icao: 'KATL', name: 'Hartsfield–Jackson Atlanta',            city: 'Atlanta',       country: 'USA', lat: 33.6407, lon: -84.4277, region: 'americas', sources: ['faa', 'notam'] },
  { iata: 'ORD', icao: 'KORD', name: "Chicago O'Hare",                         city: 'Chicago',       country: 'USA', lat: 41.9742, lon: -87.9073, region: 'americas', sources: ['faa', 'notam'] },
  { iata: 'DFW', icao: 'KDFW', name: 'Dallas/Fort Worth',                     city: 'Dallas',        country: 'USA', lat: 32.8998, lon: -97.0403, region: 'americas', sources: ['faa', 'notam'] },
  { iata: 'DEN', icao: 'KDEN', name: 'Denver International',                  city: 'Denver',        country: 'USA', lat: 39.8561, lon: -104.6737, region: 'americas', sources: ['faa', 'notam'] },
  { iata: 'LAX', icao: 'KLAX', name: 'Los Angeles International',             city: 'Los Angeles',   country: 'USA', lat: 33.9416, lon: -118.4085, region: 'americas', sources: ['faa', 'notam'] },
  { iata: 'JFK', icao: 'KJFK', name: 'John F. Kennedy International',         city: 'New York',      country: 'USA', lat: 40.6413, lon: -73.7781, region: 'americas', sources: ['faa', 'notam'] },
  { iata: 'SFO', icao: 'KSFO', name: 'San Francisco International',           city: 'San Francisco', country: 'USA', lat: 37.6213, lon: -122.3790, region: 'americas', sources: ['faa', 'notam'] },
  { iata: 'SEA', icao: 'KSEA', name: 'Seattle–Tacoma International',          city: 'Seattle',       country: 'USA', lat: 47.4502, lon: -122.3088, region: 'americas', sources: ['faa'] },
  { iata: 'LAS', icao: 'KLAS', name: 'Harry Reid International',              city: 'Las Vegas',     country: 'USA', lat: 36.0840, lon: -115.1537, region: 'americas', sources: ['faa'] },
  { iata: 'MCO', icao: 'KMCO', name: 'Orlando International',                 city: 'Orlando',       country: 'USA', lat: 28.4312, lon: -81.3081, region: 'americas', sources: ['faa'] },
  { iata: 'EWR', icao: 'KEWR', name: 'Newark Liberty International',          city: 'Newark',        country: 'USA', lat: 40.6895, lon: -74.1745, region: 'americas', sources: ['faa'] },
  { iata: 'CLT', icao: 'KCLT', name: 'Charlotte Douglas International',       city: 'Charlotte',     country: 'USA', lat: 35.2140, lon: -80.9431, region: 'americas', sources: ['faa'] },
  { iata: 'PHX', icao: 'KPHX', name: 'Phoenix Sky Harbor International',      city: 'Phoenix',       country: 'USA', lat: 33.4373, lon: -112.0078, region: 'americas', sources: ['faa'] },
  { iata: 'IAH', icao: 'KIAH', name: 'George Bush Intercontinental',          city: 'Houston',       country: 'USA', lat: 29.9902, lon: -95.3368, region: 'americas', sources: ['faa'] },
  { iata: 'MIA', icao: 'KMIA', name: 'Miami International',                   city: 'Miami',         country: 'USA', lat: 25.7959, lon: -80.2870, region: 'americas', sources: ['faa'] },
  { iata: 'BOS', icao: 'KBOS', name: 'Logan International',                   city: 'Boston',        country: 'USA', lat: 42.3656, lon: -71.0096, region: 'americas', sources: ['faa'] },
  { iata: 'MSP', icao: 'KMSP', name: 'Minneapolis–Saint Paul International',  city: 'Minneapolis',   country: 'USA', lat: 44.8848, lon: -93.2223, region: 'americas', sources: ['faa'] },
  { iata: 'DTW', icao: 'KDTW', name: 'Detroit Metropolitan',                  city: 'Detroit',       country: 'USA', lat: 42.2162, lon: -83.3554, region: 'americas', sources: ['faa'] },
  { iata: 'FLL', icao: 'KFLL', name: 'Fort Lauderdale–Hollywood',             city: 'Fort Lauderdale', country: 'USA', lat: 26.0742, lon: -80.1506, region: 'americas', sources: ['faa'] },
  { iata: 'PHL', icao: 'KPHL', name: 'Philadelphia International',            city: 'Philadelphia',  country: 'USA', lat: 39.8744, lon: -75.2424, region: 'americas', sources: ['faa'] },
  { iata: 'LGA', icao: 'KLGA', name: 'LaGuardia',                             city: 'New York',      country: 'USA', lat: 40.7769, lon: -73.8740, region: 'americas', sources: ['faa'] },
  { iata: 'BWI', icao: 'KBWI', name: 'Baltimore/Washington International',    city: 'Baltimore',     country: 'USA', lat: 39.1774, lon: -76.6684, region: 'americas', sources: ['faa'] },
  { iata: 'SLC', icao: 'KSLC', name: 'Salt Lake City International',          city: 'Salt Lake City', country: 'USA', lat: 40.7899, lon: -111.9791, region: 'americas', sources: ['faa'] },
  { iata: 'SAN', icao: 'KSAN', name: 'San Diego International',               city: 'San Diego',     country: 'USA', lat: 32.7338, lon: -117.1933, region: 'americas', sources: ['faa'] },
  { iata: 'IAD', icao: 'KIAD', name: 'Washington Dulles International',       city: 'Washington',    country: 'USA', lat: 38.9531, lon: -77.4565, region: 'americas', sources: ['faa'] },
  { iata: 'DCA', icao: 'KDCA', name: 'Ronald Reagan Washington National',     city: 'Washington',    country: 'USA', lat: 38.8512, lon: -77.0402, region: 'americas', sources: ['faa'] },
  { iata: 'MDW', icao: 'KMDW', name: 'Chicago Midway International',          city: 'Chicago',       country: 'USA', lat: 41.7868, lon: -87.7522, region: 'americas', sources: ['faa'] },
  { iata: 'TPA', icao: 'KTPA', name: 'Tampa International',                   city: 'Tampa',         country: 'USA', lat: 27.9755, lon: -82.5332, region: 'americas', sources: ['faa'] },
  { iata: 'HNL', icao: 'PHNL', name: 'Daniel K. Inouye International',        city: 'Honolulu',      country: 'USA', lat: 21.3187, lon: -157.9225, region: 'americas', sources: ['faa'] },
  { iata: 'PDX', icao: 'KPDX', name: 'Portland International',                city: 'Portland',      country: 'USA', lat: 45.5898, lon: -122.5951, region: 'americas', sources: ['faa'] },

  // ── Europe — AviationStack + NOTAM ──
  { iata: 'LHR', icao: 'EGLL', name: 'London Heathrow',               city: 'London',     country: 'UK',      lat: 51.4700, lon: -0.4543, region: 'europe', sources: ['aviationstack', 'notam'] },
  { iata: 'CDG', icao: 'LFPG', name: 'Paris Charles de Gaulle',       city: 'Paris',      country: 'France',  lat: 49.0097, lon: 2.5479,  region: 'europe', sources: ['aviationstack', 'notam'] },
  { iata: 'FRA', icao: 'EDDF', name: 'Frankfurt Airport',             city: 'Frankfurt',  country: 'Germany', lat: 50.0379, lon: 8.5622,  region: 'europe', sources: ['aviationstack', 'notam'] },
  { iata: 'AMS', icao: 'EHAM', name: 'Amsterdam Schiphol',            city: 'Amsterdam',  country: 'Netherlands', lat: 52.3105, lon: 4.7683, region: 'europe', sources: ['aviationstack', 'notam'] },
  { iata: 'MAD', icao: 'LEMD', name: 'Adolfo Suárez Madrid–Barajas',  city: 'Madrid',     country: 'Spain',   lat: 40.4983, lon: -3.5676, region: 'europe', sources: ['aviationstack', 'notam'] },
  { iata: 'FCO', icao: 'LIRF', name: 'Leonardo da Vinci–Fiumicino',   city: 'Rome',       country: 'Italy',   lat: 41.8003, lon: 12.2389, region: 'europe', sources: ['aviationstack', 'notam'] },
  { iata: 'MUC', icao: 'EDDM', name: 'Munich Airport',                city: 'Munich',     country: 'Germany', lat: 48.3537, lon: 11.7750, region: 'europe', sources: ['aviationstack'] },
  { iata: 'BCN', icao: 'LEBL', name: 'Barcelona–El Prat',             city: 'Barcelona',  country: 'Spain',   lat: 41.2974, lon: 2.0833,  region: 'europe', sources: ['aviationstack'] },
  { iata: 'ZRH', icao: 'LSZH', name: 'Zurich Airport',                city: 'Zurich',     country: 'Switzerland', lat: 47.4647, lon: 8.5492, region: 'europe', sources: ['aviationstack', 'notam'] },
  { iata: 'IST', icao: 'LTFM', name: 'Istanbul Airport',              city: 'Istanbul',   country: 'Turkey',  lat: 41.2753, lon: 28.7519, region: 'europe', sources: ['aviationstack', 'notam'] },
  { iata: 'VIE', icao: 'LOWW', name: 'Vienna International',          city: 'Vienna',     country: 'Austria', lat: 48.1103, lon: 16.5697, region: 'europe', sources: ['aviationstack', 'notam'] },
  { iata: 'CPH', icao: 'EKCH', name: 'Copenhagen Airport',            city: 'Copenhagen', country: 'Denmark', lat: 55.6180, lon: 12.6508, region: 'europe', sources: ['aviationstack', 'notam'] },
  { iata: 'DUB', icao: 'EIDW', name: 'Dublin Airport',                city: 'Dublin',     country: 'Ireland', lat: 53.4264, lon: -6.2499, region: 'europe', sources: ['aviationstack'] },
  { iata: 'LIS', icao: 'LPPT', name: 'Humberto Delgado Airport',      city: 'Lisbon',     country: 'Portugal', lat: 38.7756, lon: -9.1354, region: 'europe', sources: ['aviationstack'] },
  { iata: 'ATH', icao: 'LGAV', name: 'Athens International',          city: 'Athens',     country: 'Greece',  lat: 37.9364, lon: 23.9445, region: 'europe', sources: ['aviationstack'] },
  { iata: 'WAW', icao: 'EPWA', name: 'Warsaw Chopin Airport',         city: 'Warsaw',     country: 'Poland',  lat: 52.1657, lon: 20.9671, region: 'europe', sources: ['aviationstack', 'notam'] },
  // Europe NOTAM-only (no AviationStack coverage today)
  { iata: 'OSL', icao: 'ENGM', name: 'Oslo Gardermoen',      city: 'Oslo',      country: 'Norway',  lat: 60.1939, lon: 11.1004, region: 'europe', sources: ['notam'] },
  { iata: 'ARN', icao: 'ESSA', name: 'Stockholm Arlanda',    city: 'Stockholm', country: 'Sweden',  lat: 59.6519, lon: 17.9186, region: 'europe', sources: ['notam'] },
  { iata: 'HEL', icao: 'EFHK', name: 'Helsinki-Vantaa',      city: 'Helsinki',  country: 'Finland', lat: 60.3172, lon: 24.9633, region: 'europe', sources: ['notam'] },
  { iata: 'LGW', icao: 'EGKK', name: 'London Gatwick',             city: 'London', country: 'UK',     lat: 51.1537, lon: -0.1821, region: 'europe', sources: ['notam'] },
  { iata: 'SVO', icao: 'UUEE', name: 'Sheremetyevo International', city: 'Moscow', country: 'Russia', lat: 55.9736, lon: 37.4125, region: 'europe', sources: ['notam'] },

  // ── APAC — AviationStack + NOTAM ──
  { iata: 'HND', icao: 'RJTT', name: 'Tokyo Haneda',                 city: 'Tokyo',        country: 'Japan',       lat: 35.5494, lon: 139.7798, region: 'apac', sources: ['aviationstack', 'notam'] },
  { iata: 'NRT', icao: 'RJAA', name: 'Narita International',         city: 'Tokyo',        country: 'Japan',       lat: 35.7720, lon: 140.3929, region: 'apac', sources: ['aviationstack'] },
  ...CHINA_AVIATIONSTACK_HUBS,
  { iata: 'SIN', icao: 'WSSS', name: 'Singapore Changi',             city: 'Singapore',    country: 'Singapore',   lat: 1.3644,  lon: 103.9915, region: 'apac', sources: ['aviationstack', 'notam'] },
  { iata: 'ICN', icao: 'RKSI', name: 'Incheon International',        city: 'Seoul',        country: 'South Korea', lat: 37.4602, lon: 126.4407, region: 'apac', sources: ['aviationstack', 'notam'] },
  { iata: 'BKK', icao: 'VTBS', name: 'Suvarnabhumi Airport',         city: 'Bangkok',      country: 'Thailand',    lat: 13.6900, lon: 100.7501, region: 'apac', sources: ['aviationstack', 'notam'] },
  { iata: 'SYD', icao: 'YSSY', name: 'Sydney Kingsford Smith',       city: 'Sydney',       country: 'Australia',   lat: -33.9461, lon: 151.1772, region: 'apac', sources: ['aviationstack', 'notam'] },
  { iata: 'DEL', icao: 'VIDP', name: 'Indira Gandhi International',  city: 'Delhi',        country: 'India',       lat: 28.5562, lon: 77.1000,  region: 'apac', sources: ['aviationstack', 'notam'] },
  { iata: 'BOM', icao: 'VABB', name: 'Chhatrapati Shivaji Maharaj',  city: 'Mumbai',       country: 'India',       lat: 19.0896, lon: 72.8656,  region: 'apac', sources: ['aviationstack'] },
  { iata: 'KUL', icao: 'WMKK', name: 'Kuala Lumpur International',   city: 'Kuala Lumpur', country: 'Malaysia',    lat: 2.7456,  lon: 101.7099, region: 'apac', sources: ['aviationstack', 'notam'] },
  { iata: 'TPE', icao: 'RCTP', name: 'Taiwan Taoyuan International', city: 'Taipei',       country: 'Taiwan',      lat: 25.0797, lon: 121.2342, region: 'apac', sources: ['aviationstack'] },
  { iata: 'MNL', icao: 'RPLL', name: 'Ninoy Aquino International',   city: 'Manila',       country: 'Philippines', lat: 14.5086, lon: 121.0197, region: 'apac', sources: ['aviationstack'] },
  // APAC NOTAM-only
  { iata: 'MEL', icao: 'YMML', name: 'Melbourne Airport',            city: 'Melbourne', country: 'Australia',   lat: -37.6690, lon: 144.8410, region: 'apac', sources: ['notam'] },
  { iata: 'CGK', icao: 'WIII', name: 'Soekarno-Hatta International', city: 'Jakarta',   country: 'Indonesia',   lat: -6.1256,  lon: 106.6558, region: 'apac', sources: ['notam'] },
  { iata: 'AKL', icao: 'NZAA', name: 'Auckland Airport',             city: 'Auckland',  country: 'New Zealand', lat: -37.0082, lon: 174.7850, region: 'apac', sources: ['notam'] },
  { iata: 'KHI', icao: 'OPKC', name: 'Jinnah International',         city: 'Karachi',   country: 'Pakistan',    lat: 24.9065,  lon: 67.1610, region: 'apac', sources: ['notam'] },
  { iata: 'ISB', icao: 'OPIS', name: 'Islamabad International',      city: 'Islamabad', country: 'Pakistan',    lat: 33.5605,  lon: 72.8526, region: 'apac', sources: ['notam'] },
  { iata: 'LHE', icao: 'OPLA', name: 'Allama Iqbal International',   city: 'Lahore',    country: 'Pakistan',    lat: 31.5216,  lon: 74.4036, region: 'apac', sources: ['notam'] },

  // ── MENA — AviationStack + NOTAM ──
  { iata: 'DXB', icao: 'OMDB', name: 'Dubai International',          city: 'Dubai',       country: 'UAE',         lat: 25.2532, lon: 55.3657, region: 'mena', sources: ['aviationstack', 'notam'] },
  { iata: 'DOH', icao: 'OTHH', name: 'Hamad International',          city: 'Doha',        country: 'Qatar',       lat: 25.2731, lon: 51.6081, region: 'mena', sources: ['aviationstack', 'notam'] },
  { iata: 'AUH', icao: 'OMAA', name: 'Abu Dhabi International',      city: 'Abu Dhabi',   country: 'UAE',         lat: 24.4330, lon: 54.6511, region: 'mena', sources: ['aviationstack', 'notam'] },
  { iata: 'RUH', icao: 'OERK', name: 'King Khalid International',    city: 'Riyadh',      country: 'Saudi Arabia', lat: 24.9576, lon: 46.6988, region: 'mena', sources: ['aviationstack', 'notam'] },
  { iata: 'CAI', icao: 'HECA', name: 'Cairo International',          city: 'Cairo',       country: 'Egypt',       lat: 30.1219, lon: 31.4056, region: 'mena', sources: ['aviationstack', 'notam'] },
  { iata: 'TLV', icao: 'LLBG', name: 'Ben Gurion Airport',           city: 'Tel Aviv',    country: 'Israel',      lat: 32.0055, lon: 34.8854, region: 'mena', sources: ['aviationstack'] },
  { iata: 'AMM', icao: 'OJAI', name: 'Queen Alia International',     city: 'Amman',       country: 'Jordan',      lat: 31.7226, lon: 35.9932, region: 'mena', sources: ['aviationstack', 'notam'] },
  { iata: 'KWI', icao: 'OKBK', name: 'Kuwait International',         city: 'Kuwait City', country: 'Kuwait',      lat: 29.2266, lon: 47.9689, region: 'mena', sources: ['aviationstack', 'notam'] },
  { iata: 'CMN', icao: 'GMMN', name: 'Mohammed V International',     city: 'Casablanca',  country: 'Morocco',     lat: 33.3675, lon: -7.5898, region: 'mena', sources: ['aviationstack', 'notam'] },
  // MENA NOTAM-only
  { iata: 'JED', icao: 'OEJN', name: 'King Abdulaziz',               city: 'Jeddah',       country: 'Saudi Arabia', lat: 21.6796, lon: 39.1565, region: 'mena', sources: ['notam'] },
  { iata: 'MED', icao: 'OEMA', name: 'Prince Mohammad bin Abdulaziz', city: 'Medina',       country: 'Saudi Arabia', lat: 24.5534, lon: 39.7051, region: 'mena', sources: ['notam'] },
  { iata: 'DMM', icao: 'OEDF', name: 'King Fahd International',       city: 'Dammam',       country: 'Saudi Arabia', lat: 26.4712, lon: 49.7979, region: 'mena', sources: ['notam'] },
  { iata: 'SHJ', icao: 'OMSJ', name: 'Sharjah International',         city: 'Sharjah',      country: 'UAE',          lat: 25.3286, lon: 55.5172, region: 'mena', sources: ['notam'] },
  { iata: 'BAH', icao: 'OBBI', name: 'Bahrain International',         city: 'Manama',       country: 'Bahrain',      lat: 26.2708, lon: 50.6336, region: 'mena', sources: ['notam'] },
  { iata: 'MCT', icao: 'OOMS', name: 'Muscat International',          city: 'Muscat',       country: 'Oman',         lat: 23.5933, lon: 58.2844, region: 'mena', sources: ['notam'] },
  { iata: 'BEY', icao: 'OLBA', name: 'Beirut–Rafic Hariri',           city: 'Beirut',       country: 'Lebanon',      lat: 33.8209, lon: 35.4884, region: 'mena', sources: ['notam'] },
  { iata: 'DAM', icao: 'OSDI', name: 'Damascus International',        city: 'Damascus',     country: 'Syria',        lat: 33.4115, lon: 36.5156, region: 'mena', sources: ['notam'] },
  { iata: 'BGW', icao: 'ORBI', name: 'Baghdad International',         city: 'Baghdad',      country: 'Iraq',         lat: 33.2625, lon: 44.2346, region: 'mena', sources: ['notam'] },
  { iata: 'IKA', icao: 'OIIE', name: 'Imam Khomeini International',   city: 'Tehran',       country: 'Iran',         lat: 35.4161, lon: 51.1522, region: 'mena', sources: ['notam'] },
  { iata: 'SYZ', icao: 'OISS', name: 'Shiraz International',          city: 'Shiraz',       country: 'Iran',         lat: 29.5392, lon: 52.5899, region: 'mena', sources: ['notam'] },
  { iata: 'MHD', icao: 'OIMM', name: 'Mashhad International',         city: 'Mashhad',      country: 'Iran',         lat: 36.2352, lon: 59.6410, region: 'mena', sources: ['notam'] },
  { iata: 'BND', icao: 'OIKB', name: 'Bandar Abbas International',    city: 'Bandar Abbas', country: 'Iran',         lat: 27.2181, lon: 56.3778, region: 'mena', sources: ['notam'] },
  { iata: 'TUN', icao: 'DTTA', name: 'Tunis–Carthage',                city: 'Tunis',        country: 'Tunisia',      lat: 36.8510, lon: 10.2272, region: 'mena', sources: ['notam'] },
  { iata: 'ALG', icao: 'DAAG', name: 'Houari Boumediene',             city: 'Algiers',      country: 'Algeria',      lat: 36.6910, lon: 3.2154, region: 'mena', sources: ['notam'] },
  { iata: 'MJI', icao: 'HLLM', name: 'Mitiga International',          city: 'Tripoli',      country: 'Libya',        lat: 32.8951, lon: 13.2760, region: 'mena', sources: ['notam'] },
  { iata: 'THR', icao: 'OIII', name: 'Mehrabad International',      city: 'Tehran',   country: 'Iran',   lat: 35.6892, lon: 51.3134, region: 'mena', sources: ['notam'] },
  { iata: 'IFN', icao: 'OIFM', name: 'Isfahan International',       city: 'Isfahan',  country: 'Iran',   lat: 32.7508, lon: 51.8613, region: 'mena', sources: ['notam'] },
  { iata: 'BSR', icao: 'ORMM', name: 'Basra International',         city: 'Basra',    country: 'Iraq',   lat: 30.5491, lon: 47.6622, region: 'mena', sources: ['notam'] },
  { iata: 'EBL', icao: 'ORER', name: 'Erbil International',         city: 'Erbil',    country: 'Iraq',   lat: 36.2376, lon: 43.9632, region: 'mena', sources: ['notam'] },
  { iata: 'NJF', icao: 'ORNI', name: 'Al Najaf International',      city: 'Najaf',    country: 'Iraq',   lat: 31.9900, lon: 44.4040, region: 'mena', sources: ['notam'] },
  { iata: 'ALP', icao: 'OSAP', name: 'Aleppo International',        city: 'Aleppo',   country: 'Syria',  lat: 36.1807, lon: 37.2244, region: 'mena', sources: ['notam'] },
  { iata: 'SAH', icao: 'OYSN', name: "Sana'a International",        city: "Sana'a",   country: 'Yemen',  lat: 15.4763, lon: 44.2197, region: 'mena', sources: ['notam'] },
  { iata: 'ADE', icao: 'OYAA', name: 'Aden International',          city: 'Aden',     country: 'Yemen',  lat: 12.8295, lon: 45.0288, region: 'mena', sources: ['notam'] },
  { iata: 'DWC', icao: 'OMDW', name: 'Al Maktoum International',    city: 'Dubai',    country: 'UAE',    lat: 24.8960, lon: 55.1614, region: 'mena', sources: ['notam'] },
  { iata: 'SAW', icao: 'LTFJ', name: 'Sabiha Gökçen International', city: 'Istanbul', country: 'Turkey', lat: 40.8986, lon: 29.3092, region: 'mena', sources: ['notam'] },
  { iata: 'ESB', icao: 'LTAC', name: 'Esenboğa International',      city: 'Ankara',   country: 'Turkey', lat: 40.1281, lon: 32.9951, region: 'mena', sources: ['notam'] },
  { iata: 'ADB', icao: 'LTBJ', name: 'Adnan Menderes Airport',      city: 'Izmir',    country: 'Turkey', lat: 38.2924, lon: 27.1570, region: 'mena', sources: ['notam'] },
  { iata: 'AYT', icao: 'LTAI', name: 'Antalya Airport',             city: 'Antalya',  country: 'Turkey', lat: 36.8987, lon: 30.8005, region: 'mena', sources: ['notam'] },

  // ── Africa — AviationStack + NOTAM ──
  { iata: 'JNB', icao: 'FAOR', name: "O.R. Tambo International",      city: 'Johannesburg', country: 'South Africa', lat: -26.1392, lon: 28.2460, region: 'africa', sources: ['aviationstack', 'notam'] },
  { iata: 'NBO', icao: 'HKJK', name: 'Jomo Kenyatta International',   city: 'Nairobi',      country: 'Kenya',        lat: -1.3192,  lon: 36.9278, region: 'africa', sources: ['aviationstack', 'notam'] },
  { iata: 'LOS', icao: 'DNMM', name: 'Murtala Muhammed International', city: 'Lagos',       country: 'Nigeria',      lat: 6.5774,   lon: 3.3212,  region: 'africa', sources: ['aviationstack', 'notam'] },
  { iata: 'ADD', icao: 'HAAB', name: 'Bole International',            city: 'Addis Ababa',  country: 'Ethiopia',     lat: 8.9779,   lon: 38.7993, region: 'africa', sources: ['aviationstack'] },
  { iata: 'CPT', icao: 'FACT', name: 'Cape Town International',       city: 'Cape Town',    country: 'South Africa', lat: -33.9715, lon: 18.6021, region: 'africa', sources: ['aviationstack'] },
  // Africa NOTAM-only
  { iata: 'GBE', icao: 'FBSK', name: 'Sir Seretse Khama International', city: 'Gaborone',    country: 'Botswana',    lat: -24.5553, lon: 25.9183, region: 'africa', sources: ['notam'] },
  { iata: 'ACC', icao: 'DGAA', name: 'Kotoka International',         city: 'Accra',         country: 'Ghana',     lat: 5.6052,   lon: -0.1668, region: 'africa', sources: ['notam'] },
  { iata: 'DAR', icao: 'HTDA', name: 'Julius Nyerere International', city: 'Dar es Salaam', country: 'Tanzania',  lat: -6.8781,  lon: 39.2026, region: 'africa', sources: ['notam'] },
  { iata: 'MRU', icao: 'FIMP', name: 'Sir Seewoosagur Ramgoolam',    city: 'Mauritius',     country: 'Mauritius', lat: -20.4302, lon: 57.6836, region: 'africa', sources: ['notam'] },
  { iata: 'BEN', icao: 'HLLB', name: 'Benina International',         city: 'Benghazi',      country: 'Libya',     lat: 32.0968,  lon: 20.2695, region: 'africa', sources: ['notam'] },
  { iata: 'KRT', icao: 'HSSK', name: 'Khartoum International',       city: 'Khartoum',      country: 'Sudan',     lat: 15.5895,  lon: 32.5532, region: 'africa', sources: ['notam'] },
];

// Derived per-source views (built once at module load)
export const AVIATIONSTACK_LIST = AIRPORTS.filter(a => a.sources.includes('aviationstack'));
const FAA_LIST           = AIRPORTS.filter(a => a.sources.includes('faa')).map(a => a.iata);
const NOTAM_LIST         = AIRPORTS.filter(a => a.sources.includes('notam')).map(a => a.icao);
const AVIATIONSTACK_IATAS = new Set(AVIATIONSTACK_LIST.map(a => a.iata));
const FAA_IATAS = new Set(FAA_LIST);

// iata → aviationstack-enriched meta (for building AirportDelayAlert envelopes).
const AIRPORT_META = Object.fromEntries(AVIATIONSTACK_LIST.map(a => [a.iata, a]));

// iata → FAA-row meta (icao/name/city/country for alert envelopes). NOTAM-
// reachable rows carry inline lat/lon so notification payloads never depend on
// src/config/airports.ts, which does not exist in the scripts-rooted Railway
// container. tests/aviation-notify-location.test.mjs holds both registries in
// parity and fails CI on drift.
const FAA_META = Object.fromEntries(
  AIRPORTS.filter(a => a.sources.includes('faa')).map(a => [a.iata, a]),
);

// Protobuf enum mappers (mirror ais-relay.cjs mappings; consumers parse strings)
const REGION_MAP = {
  americas: 'AIRPORT_REGION_AMERICAS',
  europe:   'AIRPORT_REGION_EUROPE',
  apac:     'AIRPORT_REGION_APAC',
  mena:     'AIRPORT_REGION_MENA',
  africa:   'AIRPORT_REGION_AFRICA',
};
const DELAY_TYPE_MAP = {
  ground_stop:     'FLIGHT_DELAY_TYPE_GROUND_STOP',
  ground_delay:    'FLIGHT_DELAY_TYPE_GROUND_DELAY',
  departure_delay: 'FLIGHT_DELAY_TYPE_DEPARTURE_DELAY',
  arrival_delay:   'FLIGHT_DELAY_TYPE_ARRIVAL_DELAY',
  general:         'FLIGHT_DELAY_TYPE_GENERAL',
  closure:         'FLIGHT_DELAY_TYPE_CLOSURE',
};
const SEVERITY_MAP = {
  normal:   'FLIGHT_DELAY_SEVERITY_NORMAL',
  minor:    'FLIGHT_DELAY_SEVERITY_MINOR',
  moderate: 'FLIGHT_DELAY_SEVERITY_MODERATE',
  major:    'FLIGHT_DELAY_SEVERITY_MAJOR',
  severe:   'FLIGHT_DELAY_SEVERITY_SEVERE',
};

const AVIATION_BATCH_CONCURRENCY = 10;
const AVIATION_MIN_FLIGHTS_FOR_CLOSURE = 10;
const DEPARTED_STATUSES = new Set(['landed', 'active', 'arrived', 'diverted']);

// ─── Inline Upstash helpers (LPUSH + SETNX + GET/SET) ────────────────────────
// These aren't in _seed-utils.mjs (which focuses on SET/GET/EXPIRE). Pattern
// mirrors ais-relay.cjs upstashLpush/upstashSetNx/upstashSet/upstashGet so the
// notification queue + prev-state reads speak the same wire protocol.

async function upstashCommand(cmd) {
  const { url, token } = getRedisCredentials();
  const resp = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd),
    signal: AbortSignal.timeout(10_000),
  });
  if (!resp.ok) throw new Error(`Upstash ${cmd[0]} failed: HTTP ${resp.status}`);
  return resp.json();
}

async function upstashGet(key) {
  try {
    const result = await upstashCommand(['GET', key]);
    if (!result?.result) return null;
    try { return JSON.parse(result.result); } catch { return null; }
  } catch { return null; }
}

// Envelope-aware GET. runSeed wraps canonical keys in `{_seed, data}` when the
// seeder opts into the seed contract (declareRecords + envelopeMeta) — INTL_KEY
// is one such key (see runSeed call w/ declareRecords below). Bare values
// (FAA_KEY, NOTAM_KEY via writeExtraKey w/o envelopeMeta) pass through.
async function upstashGetUnwrapped(key) {
  const raw = await upstashGet(key);
  return unwrapEnvelope(raw).data;
}

async function upstashSet(key, value, ttlSeconds) {
  try {
    const serialized = typeof value === 'string' ? value : JSON.stringify(value);
    const result = await upstashCommand(['SET', key, serialized, 'EX', String(ttlSeconds)]);
    return result?.result === 'OK';
  } catch { return false; }
}

async function upstashSetNx(key, value, ttlSeconds) {
  try {
    const serialized = typeof value === 'string' ? value : JSON.stringify(value);
    const result = await upstashCommand(['SET', key, serialized, 'NX', 'EX', String(ttlSeconds)]);
    return classifySetNxResult(result?.result);
  } catch { return 'error'; }
}

async function upstashLpush(key, value) {
  try {
    const serialized = typeof value === 'string' ? value : JSON.stringify(value);
    const result = await upstashCommand(['LPUSH', key, serialized]);
    return typeof result?.result === 'number' && result.result > 0;
  } catch { return false; }
}

async function upstashDel(key) {
  try {
    const result = await upstashCommand(['DEL', key]);
    return result?.result === 1;
  } catch { return false; }
}

// ─── Notification publishing ─────────────────────────────────────────────────
// Mirrors ais-relay.cjs::publishNotificationEvent: LPUSH the event onto
// wm:events:queue, guarded by a SETNX dedup key (TTL = dedupTtl). On LPUSH
// failure, rollback the dedup key so the next run can retry.

function notifyHash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
}

async function publishNotificationEvent({ eventType, payload, severity, variant, dedupTtl = 1800 }) {
  try {
    const variantSuffix = variant ? `:${variant}` : '';
    const dedupMaterial = buildDedupMaterial(eventType, payload?.title, payload?.coalesceKey);
    const dedupKey = `wm:notif:scan-dedup:${eventType}${variantSuffix}:${notifyHash(dedupMaterial)}`;
    const dedupResult = await upstashSetNx(dedupKey, '1', dedupTtl);
    const dedupDecision = recordDedupOutcome(dedupResult, {
      surface: 'seed-aviation',
      eventType,
      severity,
      fallbackKey: dedupKey,
      fallbackTtlSeconds: dedupTtl,
      emitTelemetry: ({ line }) => console.warn(line),
    });
    if (!dedupDecision.shouldPublish) {
      if (!dedupDecision.isDuplicate) return;
      console.log(`[Notify] Dedup hit — ${eventType}: ${String(payload.title ?? '').slice(0, 60)}`);
      return;
    }
    const msg = JSON.stringify({ eventType, payload, severity: dedupDecision.severity, ...(variant ? { variant } : {}), publishedAt: Date.now() });
    const ok = await upstashLpush('wm:events:queue', msg);
    if (ok) {
      console.log(`[Notify] Queued ${dedupDecision.severity} event: ${eventType} — ${String(payload.title ?? '').slice(0, 60)}`);
    } else {
      console.warn(`[Notify] LPUSH failed for ${eventType} — rolling back dedup key`);
      await upstashDel(dedupKey);
    }
  } catch (e) {
    console.warn(`[Notify] publishNotificationEvent error (${eventType}):`, e?.message || e);
  }
}

// ─── Section 1: AviationStack intl delays ────────────────────────────────────

const AVIATIONSTACK_URL = 'https://api.aviationstack.com/v1/flights';

function aviationDetermineSeverity(avgDelay, delayedPct) {
  if (avgDelay >= 60 || (delayedPct && delayedPct >= 60)) return 'severe';
  if (avgDelay >= 45 || (delayedPct && delayedPct >= 45)) return 'major';
  if (avgDelay >= 30 || (delayedPct && delayedPct >= 30)) return 'moderate';
  if (avgDelay >= 15 || (delayedPct && delayedPct >= 15)) return 'minor';
  return 'normal';
}

// AviationStack answers a rejected key with HTTP 401/403 or one of these error
// codes. They are configuration errors, not provider outages, so they must not
// ride out on last-good with exit 0 (see fetchIntl).
const AVIATIONSTACK_AUTH_ERROR_CODES = new Set([
  'invalid_access_key',
  'missing_access_key',
  'inactive_user',
  'function_access_restricted',
  'https_access_restricted',
]);

async function fetchAviationStackSingle(
  apiKey,
  airport,
  fetchFn = (...args) => globalThis.fetch(...args),
  logger = console,
) {
  const { iata } = airport;
  const today = new Date().toISOString().slice(0, 10);
  const url = `${AVIATIONSTACK_URL}?access_key=${apiKey}&dep_iata=${iata}&flight_date=${today}&limit=100`;
  try {
    const resp = await fetchFn(url, {
      headers: { 'User-Agent': CHROME_UA },
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) {
      logger.warn(`[Aviation] ${iata}: HTTP ${resp.status}`);
      const authFailed = resp.status === 401 || resp.status === 403;
      return { iata, status: 'failed', alert: null, flightCount: 0, authFailed };
    }
    const json = await resp.json();
    if (json.error) {
      logger.warn(`[Aviation] ${iata}: ${json.error.message}`);
      const authFailed = AVIATIONSTACK_AUTH_ERROR_CODES.has(json.error.code);
      return { iata, status: 'failed', alert: null, flightCount: 0, authFailed };
    }
    const flights = operatingFlights(Array.isArray(json?.data) ? json.data : []);
    if (flights.length === 0) {
      const dataType = json.data === undefined ? 'missing'
        : json.data === null ? 'null' : Array.isArray(json.data) ? 'array' : typeof json.data;
      const pagination = Object.fromEntries(['limit', 'offset', 'count', 'total'].map(key => {
        const value = json.pagination?.[key];
        return [key, Number.isSafeInteger(value) && value >= 0 ? value : null];
      }));
      logger.warn(JSON.stringify({
        event: 'aviationstack_omission', iata, requestDate: today, requestLimit: 100,
        httpStatus: resp.status, dataType,
        rawCount: Array.isArray(json.data) ? json.data.length : null,
        operatingCount: flights.length, pagination,
      }));
      logger.warn(`[Aviation] ${iata}: provider omitted hub (0 flight records)`);
      return { iata, status: 'omitted', alert: null, flightCount: 0 };
    }
    const alert = aviationAggregateFlights(iata, flights);
    return {
      iata,
      status: alert ? 'disruption' : 'normal',
      alert,
      flightCount: flights.length,
    };
  } catch (err) {
    logger.warn(`[Aviation] ${iata}: fetch error: ${err?.message || err}`);
    return { iata, status: 'failed', alert: null, flightCount: 0 };
  }
}

// A codeshare row repeats its operating flight under another airline's number,
// so rows count once per operating flight. The operating row is often not on
// the page, and late pages can hold codeshares only, so a codeshare stands in.
function operatingFlights(rows) {
  const seen = new Set();
  const operatingFirst = [...rows.filter(f => !f?.flight?.codeshared), ...rows.filter(f => f?.flight?.codeshared)];
  return operatingFirst.filter(f => {
    const shared = f?.flight?.codeshared;
    const number = shared ? shared.flight_iata : f?.flight?.iata;
    if (!number) return !shared;
    const key = `${String(number).toUpperCase()} ${f?.departure?.scheduled ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const zoneFormats = new Map();

// AviationStack writes departure times as the airport's local wall clock with
// a "+00:00" suffix, so the wall clock is read in the departure time zone.
function departureMs(departure) {
  const wall = Date.parse(departure?.scheduled ?? '');
  const zone = departure?.timezone;
  if (!Number.isFinite(wall) || !zone) return wall;
  try {
    if (!zoneFormats.has(zone)) {
      zoneFormats.set(zone, new Intl.DateTimeFormat('en-US', {
        timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric',
        hour: 'numeric', minute: 'numeric', second: 'numeric',
      }));
    }
    const offsetAt = (at) => {
      const p = Object.fromEntries(zoneFormats.get(zone).formatToParts(at).map(({ type, value }) => [type, Number(value)]));
      return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - at;
    };
    // The offset at the wall clock read as UTC can be the other side of a
    // clock change, so take it again at the first estimate of the departure.
    return wall - offsetAt(wall - offsetAt(wall));
  } catch {
    return wall;
  }
}

function aviationAggregateFlights(iata, flights) {
  if (flights.length === 0) return null;
  const meta = AIRPORT_META[iata];
  if (!meta) return null;

  // The cancellation rate is measured over flights that were due by now
  // (scheduled departure passed, or already departed), so future 'scheduled'
  // rows do not dilute a mid-day closure (#1209). It must not be measured over
  // "resolved" rows: AviationStack's first page for a busy hub is the day's
  // LATEST departures, so a page with no departed flight left only advance
  // cancellations as "resolved" — cancelled/cancelled = 100%, and RUH read as
  // closed (22/22) after it reopened. Delays are counted over the same flights
  // as the denominator; counting every row against a resolved-only total once
  // reported "179% delayed". Too few due flights → the whole page, which only
  // shows a closure: advance cancellations in the day's last hours are schedule
  // changes, and RUH read "67% flights cancelled" from one such page.
  const now = Date.now();
  const page = { flights: 0, cancelled: 0, delayed: 0, totalDelay: 0 };
  const dueOnly = { flights: 0, cancelled: 0, delayed: 0, totalDelay: 0 };
  for (const f of flights) {
    const status = f.flight_status || '';
    const scheduledAt = departureMs(f.departure);
    const isDue = DEPARTED_STATUSES.has(status) || (Number.isFinite(scheduledAt) && scheduledAt <= now);
    const delay = f.departure?.delay > 0 ? f.departure.delay : 0;
    for (const bucket of isDue ? [page, dueOnly] : [page]) {
      bucket.flights++;
      if (status === 'cancelled') bucket.cancelled++;
      if (delay > 0) {
        bucket.delayed++;
        bucket.totalDelay += delay;
      }
    }
  }

  const fromDue = dueOnly.flights >= AVIATION_MIN_FLIGHTS_FOR_CLOSURE;
  const sample = fromDue ? dueOnly : page;
  const { flights: total, cancelled, delayed, totalDelay } = sample;
  const closed = cancelled / total >= 0.8 && total >= AVIATION_MIN_FLIGHTS_FOR_CLOSURE;
  // get-airport-ops-summary rebuilds the cancellation rate from the alert, so
  // cancellations that set no level here are not reported either.
  const cancelledCount = fromDue || closed ? cancelled : 0;
  const cancelledPct = (cancelledCount / total) * 100;
  const delayedPct = (delayed / total) * 100;
  const avgDelay = delayed > 0 ? Math.round(totalDelay / delayed) : 0;

  let severity, delayType, reason;
  if (closed) {
    severity = 'severe'; delayType = 'closure';
    reason = 'Airport closure / airspace restrictions';
  } else if (cancelledPct >= 50 && total >= AVIATION_MIN_FLIGHTS_FOR_CLOSURE) {
    severity = 'major'; delayType = 'ground_stop';
    reason = `${Math.round(cancelledPct)}% flights cancelled`;
  } else if (cancelledPct >= 20 && total >= AVIATION_MIN_FLIGHTS_FOR_CLOSURE) {
    severity = 'moderate'; delayType = 'ground_delay';
    reason = `${Math.round(cancelledPct)}% flights cancelled`;
  } else if (cancelledPct >= 10 && total >= AVIATION_MIN_FLIGHTS_FOR_CLOSURE) {
    severity = 'minor'; delayType = 'general';
    reason = `${Math.round(cancelledPct)}% flights cancelled`;
  } else if (avgDelay > 0) {
    severity = aviationDetermineSeverity(avgDelay, delayedPct);
    delayType = avgDelay >= 60 ? 'ground_delay' : 'general';
    reason = `Avg ${avgDelay}min delay, ${Math.round(delayedPct)}% delayed`;
  } else {
    return null;
  }
  if (severity === 'normal') return null;

  return {
    id: `avstack-${iata}`,
    iata,
    icao: meta.icao,
    name: meta.name,
    city: meta.city,
    country: meta.country,
    location: { latitude: meta.lat, longitude: meta.lon },
    region: REGION_MAP[meta.region] || 'AIRPORT_REGION_UNSPECIFIED',
    delayType: DELAY_TYPE_MAP[delayType] || 'FLIGHT_DELAY_TYPE_GENERAL',
    severity: SEVERITY_MAP[severity] || 'FLIGHT_DELAY_SEVERITY_NORMAL',
    avgDelayMinutes: avgDelay,
    delayedFlightsPct: Math.round(delayedPct),
    cancelledFlights: cancelledCount,
    totalFlights: total,
    reason,
    source: 'FLIGHT_DELAY_SOURCE_AVIATIONSTACK',
    updatedAt: Date.now(),
  };
}

export async function seedIntlDelays({
  apiKey = process.env.AVIATIONSTACK_API,
  airports = AVIATIONSTACK_LIST,
  fetchFn = (...args) => globalThis.fetch(...args),
  logger = console,
} = {}) {
  if (!apiKey) {
    logger.log('[Intl] No AVIATIONSTACK_API key — skipping');
    return { alerts: [], coverage: [], healthy: false, skipped: true };
  }

  const t0 = Date.now();
  const alerts = [];
  const coverage = [];
  let succeeded = 0, failed = 0, omitted = 0, authFailed = 0;

  for (let i = 0; i < airports.length; i += AVIATION_BATCH_CONCURRENCY) {
    const chunk = airports.slice(i, i + AVIATION_BATCH_CONCURRENCY);
    const results = await Promise.allSettled(
      chunk.map(a => fetchAviationStackSingle(apiKey, a, fetchFn, logger)),
    );
    for (let j = 0; j < results.length; j++) {
      const r = results[j];
      if (r.status === 'fulfilled') {
        coverage.push({
          iata: r.value.iata,
          status: r.value.status,
          flightCount: r.value.flightCount,
          updatedAt: Date.now(),
        });
        if (r.value.authFailed) authFailed++;
        if (r.value.status === 'failed') failed++;
        else if (r.value.status === 'omitted') omitted++;
        else succeeded++;
        if (r.value.alert) alerts.push(r.value.alert);
      } else {
        failed++;
        coverage.push({ iata: chunk[j].iata, status: 'failed', flightCount: 0, updatedAt: Date.now() });
      }
    }
  }

  const unavailable = failed + omitted;
  const healthy = airports.length < 5 || unavailable <= succeeded;
  logger.log(`[Intl] ${alerts.length} alerts (${succeeded} covered, ${omitted} omitted, ${failed} failed, healthy: ${healthy}) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  return { alerts, coverage, healthy, skipped: false, authFailed };
}

export async function runChinaAviationStackSmoke({
  apiKey = process.env.AVIATIONSTACK_API,
  fetchFn = (...args) => globalThis.fetch(...args),
  logger = console,
} = {}) {
  const result = await seedIntlDelays({
    apiKey,
    airports: CHINA_AVIATIONSTACK_HUBS,
    fetchFn,
    logger,
  });
  const statusByIata = new Map(result.coverage.map((hub) => [hub.iata, hub.status]));
  const summary = CHINA_AVIATIONSTACK_HUBS
    .map((hub) => `${hub.iata}=${statusByIata.get(hub.iata) || 'failed'}`)
    .join(' ');
  const ok = !result.skipped && CHINA_AVIATIONSTACK_HUBS.every((hub) => {
    const status = statusByIata.get(hub.iata);
    return status === 'normal' || status === 'disruption';
  });
  logger.log(`[China aviation smoke] ${summary} result=${ok ? 'PASS' : 'FAIL'}`);
  return { ok, ...result };
}

// ─── Section 2: FAA delays (XML) ─────────────────────────────────────────────

const FAA_URL = 'https://nasstatus.faa.gov/api/airport-status-information';

function parseDelayTypeFromReason(reason) {
  const r = reason.toLowerCase();
  if (r.includes('ground stop')) return 'ground_stop';
  if (r.includes('ground delay') || r.includes('gdp')) return 'ground_delay';
  if (r.includes('departure')) return 'departure_delay';
  if (r.includes('arrival')) return 'arrival_delay';
  if (r.includes('clos')) return 'ground_stop';
  return 'general';
}

function faaSeverityFromAvg(avgDelay) {
  if (avgDelay >= 90) return 'severe';
  if (avgDelay >= 60) return 'major';
  if (avgDelay >= 30) return 'moderate';
  if (avgDelay >= 15) return 'minor';
  return 'normal';
}

export function parseFaaXml(text) {
  const delays = new Map();
  const parseTag = (xml, tag) => {
    const re = new RegExp(`<${tag}>(.*?)</${tag}>`, 'gs');
    const out = [];
    let m;
    while ((m = re.exec(xml))) out.push(m[1]);
    return out;
  };
  const getVal = (block, tag) => {
    const m = block.match(new RegExp(`<${tag}>(.*?)</${tag}>`));
    return m ? m[1].trim() : '';
  };

  for (const gd of parseTag(text, 'Ground_Delay')) {
    const arpt = getVal(gd, 'ARPT');
    if (arpt) {
      delays.set(arpt, { airport: arpt, reason: getVal(gd, 'Reason') || 'Ground delay', avgDelay: parseInt(getVal(gd, 'Avg') || '30', 10), type: 'ground_delay' });
    }
  }
  for (const gs of parseTag(text, 'Ground_Stop')) {
    const arpt = getVal(gs, 'ARPT');
    if (arpt) {
      delays.set(arpt, { airport: arpt, reason: getVal(gs, 'Reason') || 'Ground stop', avgDelay: 60, type: 'ground_stop' });
    }
  }
  for (const d of parseTag(text, 'Delay')) {
    const arpt = getVal(d, 'ARPT');
    if (arpt) {
      const existing = delays.get(arpt);
      if (!existing || existing.type !== 'ground_stop') {
        const min = parseInt(getVal(d, 'Min') || '15', 10);
        const max = parseInt(getVal(d, 'Max') || '30', 10);
        delays.set(arpt, { airport: arpt, reason: getVal(d, 'Reason') || 'Delays', avgDelay: Math.round((min + max) / 2), type: parseDelayTypeFromReason(getVal(d, 'Reason') || '') });
      }
    }
  }
  for (const ac of parseTag(text, 'Airport')) {
    const arpt = getVal(ac, 'ARPT');
    // The FAA lists LAX, SAN and LAS here all year for a NOTAM that only
    // closes them to non-scheduled transient GA. Airline service runs.
    if (NARROW_CLOSURE_TEXT.test(getVal(ac, 'Reason').toUpperCase())) continue;
    if (arpt && FAA_LIST.includes(arpt)) {
      delays.set(arpt, { airport: arpt, reason: 'Airport closure', avgDelay: 120, type: 'ground_stop' });
    }
  }
  return delays;
}

export function buildFaaAlerts(faaDelays) {
  const alerts = [];
  for (const iata of FAA_LIST) {
    const d = faaDelays.get(iata);
    if (!d) continue;
    const meta = FAA_META[iata];
    alerts.push({
      id: `faa-${iata}`,
      iata,
      icao: meta?.icao ?? '',
      name: meta?.name ?? iata,
      city: meta?.city ?? '',
      country: meta?.country ?? 'USA',
      location: { latitude: meta.lat, longitude: meta.lon },
      region: 'AIRPORT_REGION_AMERICAS',
      delayType: `FLIGHT_DELAY_TYPE_${d.type.toUpperCase()}`,
      severity: `FLIGHT_DELAY_SEVERITY_${faaSeverityFromAvg(d.avgDelay).toUpperCase()}`,
      avgDelayMinutes: d.avgDelay,
      delayedFlightsPct: 0,
      cancelledFlights: 0,
      totalFlights: 0,
      reason: d.reason,
      source: 'FLIGHT_DELAY_SOURCE_FAA',
      updatedAt: Date.now(),
    });
  }
  return alerts;
}

async function seedFaaDelays() {
  const t0 = Date.now();
  const resp = await fetch(FAA_URL, {
    headers: { Accept: 'application/xml', 'User-Agent': CHROME_UA },
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) throw new Error(`FAA HTTP ${resp.status}`);
  const xml = await resp.text();
  const alerts = buildFaaAlerts(parseFaaXml(xml));
  console.log(`[FAA] ${alerts.length} alerts in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  return { alerts };
}

// ─── Section 3: NOTAM closures (ICAO) ────────────────────────────────────────

const ICAO_NOTAM_URL = 'https://dataservices.icao.int/api/notams-realtime-list';
const NOTAM_CLOSURE_QCODES = new Set(['FA', 'AH', 'AL', 'AW', 'AC', 'AM']);
// Restrictions: NOTAM Q-codes RA (restricted area) and RO (overfly prohibited)
// + restricted code45s and text patterns. Mirrors NOTAM_RESTRICTION_QCODES +
// the restriction-text regex in server/worldmonitor/aviation/v1/_shared.ts:29,
// :440-444 — keep in lockstep so seeded NOTAM data matches the live RPC's
// classifier.
const NOTAM_RESTRICTION_QCODES = new Set(['RA', 'RO']);

// Returns the NOTAM array only for a real JSON-array answer. Every other outcome
// — quota ("Reach call limit"), non-2xx (the retired route answers 404 "Invalid
// API Call"), an HTML challenge, bad or non-array JSON, a timeout, a network
// error — throws, so the side-car keeps last-good instead of publishing an
// empty closure list as a fresh observation.
async function fetchIcaoNotams(apiKey) {
  const locations = NOTAM_LIST.join(',');
  const url = `${ICAO_NOTAM_URL}?api_key=${encodeURIComponent(apiKey)}&format=json&locations=${locations}`;
  const resp = await fetch(url, {
    headers: { 'User-Agent': CHROME_UA },
    signal: AbortSignal.timeout(30_000),
  });
  const body = await resp.text();
  if (/reach call limit/i.test(body) || /quota.?exceed/i.test(body)) {
    throw new Error(`ICAO quota exhausted (HTTP ${resp.status} "Reach call limit")`);
  }
  if (!resp.ok) throw new Error(`ICAO HTTP ${resp.status}: ${body.slice(0, 120)}`);
  const ct = resp.headers.get('content-type') || '';
  if (ct.includes('text/html')) throw new Error('ICAO returned HTML (challenge page)');
  let data;
  try {
    data = JSON.parse(body);
  } catch {
    throw new Error('ICAO returned invalid JSON');
  }
  if (!Array.isArray(data)) throw new Error(`ICAO returned non-array JSON: ${body.slice(0, 120)}`);
  return data;
}

async function seedNotamClosures() {
  const apiKey = process.env.ICAO_API_KEY;
  if (!apiKey) {
    console.log('[NOTAM] No ICAO_API_KEY — skipping');
    return { closedIcaos: [], restrictedIcaos: [], reasons: {}, skipped: true };
  }
  const t0 = Date.now();
  const notams = await fetchIcaoNotams(apiKey);

  const now = Math.floor(Date.now() / 1000);
  const closedSet = new Set();
  const restrictedSet = new Set();
  const reasons = {};

  for (const n of notams) {
    const icao = n.itema || n.location || '';
    if (!icao || !NOTAM_LIST.includes(icao)) continue;
    if (n.endvalidity && n.endvalidity < now) continue;
    const code23 = (n.code23 || '').toUpperCase();
    const code45 = (n.code45 || '').toUpperCase();
    const text = (n.iteme || '').toUpperCase();
    const closureCode45 = code45 === 'LC' || code45 === 'AS' || code45 === 'AU' || code45 === 'XX' || code45 === 'AW';
    const restrictionCode45 = code45 === 'RE' || code45 === 'RT';
    const isClosureCode = NOTAM_CLOSURE_QCODES.has(code23) && closureCode45;
    const isRestrictionCode = (NOTAM_RESTRICTION_QCODES.has(code23) || NOTAM_CLOSURE_QCODES.has(code23)) && restrictionCode45;
    const isClosureText = /\b(AD CLSD|AIRPORT CLOSED|AIRSPACE CLOSED|AD NOT AVBL|CLSD TO ALL)\b/.test(text);
    const isRestrictionText = /\b(RESTRICTED AREA|PROHIBITED AREA|DANGER AREA|TFR|TEMPORARY FLIGHT RESTRICTION)\b/.test(text);
    // Closure wins over restriction for the same NOTAM (mirrors _shared.ts
    // if/else chain at line 446-452).
    if (isClosureCode || isClosureText) {
      closedSet.add(icao);
      reasons[icao] = n.iteme || 'Airport closure (NOTAM)';
    } else if (isRestrictionCode || isRestrictionText) {
      restrictedSet.add(icao);
      reasons[icao] = n.iteme || 'Airspace restriction (NOTAM)';
    }
  }
  const closedIcaos = [...closedSet];
  const restrictedIcaos = [...restrictedSet];
  console.log(`[NOTAM] ${notams.length} raw NOTAMs, ${closedIcaos.length} closures, ${restrictedIcaos.length} restrictions in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  return { closedIcaos, restrictedIcaos, reasons, skipped: false };
}

// ─── Section 4: Aviation RSS news prewarmer ──────────────────────────────────

const AVIATION_RSS_FEEDS = [
  { url: 'https://www.flightglobal.com/rss',      name: 'FlightGlobal' },
  { url: 'https://simpleflying.com/feed/',        name: 'Simple Flying' },
  { url: 'https://aerotime.aero/feed',            name: 'AeroTime' },
  { url: 'https://thepointsguy.com/feed/',        name: 'The Points Guy' },
  { url: 'https://airlinegeeks.com/feed/',        name: 'Airline Geeks' },
  { url: 'https://onemileatatime.com/feed/',      name: 'One Mile at a Time' },
  { url: 'https://viewfromthewing.com/feed/',     name: 'View from the Wing' },
  { url: 'https://www.aviationpros.com/rss',      name: 'Aviation Pros' },
  { url: 'https://www.aviationweek.com/rss',      name: 'Aviation Week' },
];

const xmlParser = new XMLParser({ ignoreAttributes: true });

function parseRssItems(xml, sourceName) {
  try {
      const parsed = xmlParser.parse(xml);
      const channel = parsed?.rss?.channel ?? parsed?.feed ?? {};
      const rawItems = Array.isArray(channel.item) ? channel.item
          : channel.item ? [channel.item]
              : Array.isArray(channel.entry) ? channel.entry
                  : channel.entry ? [channel.entry] : [];

      // Bound matching text and serialized records: 270 x 3KiB stays below the local cache limit.
      return rawItems.slice(0, 30).map((item) => ({
          title: String(item?.title ?? '').trim().slice(0, 512),
          link: typeof (item?.link ?? item?.guid) === 'string' ? (item.link ?? item.guid).trim() : '',
          pubDate: String(item?.pubDate ?? item?.published ?? item?.updated ?? '').trim().slice(0, 128),
          description: String(item?.description ?? item?.summary ?? item?.content ?? '').trim().slice(0, 2048),
          _source: sourceName,
      })).filter(item => item.link.length > 0 && item.link.length <= 2048 && new TextEncoder().encode(JSON.stringify(item)).byteLength <= 3072);
  } catch {
      return [];
  }
}

export async function seedAviationNews() {
  const t0 = Date.now();
  const allItems = [];
  await Promise.allSettled(
    AVIATION_RSS_FEEDS.map(async (feed) => {
      try {
        const resp = await fetch(feed.url, {
          headers: { 'User-Agent': CHROME_UA, Accept: 'application/rss+xml, application/xml, text/xml, */*' },
          signal: AbortSignal.timeout(8_000),
        });
        if (!resp.ok) return;
        const xml = await resp.text();
        allItems.push(...parseRssItems(xml, feed.name));
      } catch { /* skip */ }
    }),
  );

  console.log(`[News] ${allItems.length} articles from ${AVIATION_RSS_FEEDS.length} feeds in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  return { items: allItems };
}

// ─── Section 5: Notification dispatch ────────────────────────────────────────
// Aviation: new entries into severe/major state trigger an aviation_closure notification.
// NOTAM:    new ICAOs in the closed-set trigger a notam_closure notification.
// Both sources persist their prev-state to Redis so short-lived cron runs don't
// spam on every tick.

async function dispatchAviationNotifications(alerts) {
  const severeAlerts = alerts.filter(a =>
    a.severity === 'FLIGHT_DELAY_SEVERITY_SEVERE' || a.severity === 'FLIGHT_DELAY_SEVERITY_MAJOR',
  );
  // Diff identity MUST match the publisher coalesce key (airport + severity band).
  // Diffing by airport alone would filter a MAJOR->SEVERE escalation for an
  // already-alerted airport out HERE — before the severity-aware coalesce key is
  // ever reached — so the escalation would never publish (PR #4985 review P1).
  const aviationSeverityBand = a => (a.severity === 'FLIGHT_DELAY_SEVERITY_SEVERE' ? 'critical' : 'high');
  const aviationAlertKey = a => `${a.iata}:${aviationSeverityBand(a)}`;
  const currentKeys = new Set(severeAlerts.filter(a => a.iata).map(aviationAlertKey));
  const prev = await upstashGet(AVIATION_PREV_ALERTED_KEY);
  const prevSet = new Set(Array.isArray(prev) ? prev : []);
  const newAlerts = severeAlerts.filter(a => a.iata && !prevSet.has(aviationAlertKey(a)));

  // Persist current set for next tick's diff (24h TTL guards restarts).
  // Keyed by airport+severity so a later band change is seen as a new state.
  await upstashSet(AVIATION_PREV_ALERTED_KEY, [...currentKeys], PREV_STATE_TTL);

  for (const a of newAlerts.slice(0, 3)) {
    const severity = aviationSeverityBand(a);
    // Alert rows carry the registry's country NAME ('Brazil', 'China');
    // normalize so country-scoped rules can filter (#5359 — GRU/HKG/KUL/CAN
    // criticals leaked to an Eastern-Europe-scoped user as unattributed).
    // A miss means scoped users never see this airport's alerts (relay drops
    // unattributed non-news events) — warn so it reads as a data-quality bug,
    // not silent filtering. tests/notification-relay-country-scope-5359.test.mjs
    // asserts every registry country name currently normalizes.
    const countryCode = countryNameToIso2(a.country);
    if (!countryCode) console.warn(`[Notify] aviation_closure ${a.iata}: registry country ${JSON.stringify(a.country ?? null)} did not normalize — publishing unattributed (invisible to country-scoped rules)`);
    // Same miss-warn rationale as countryCode above: an unlocated closure
    // reaches proximity rules as a title-only event, so a coordinate gap must
    // read as a data-quality bug in cron logs rather than silent non-matching.
    const site = airportNotifyLocation(a);
    if (site.lat === undefined) console.warn(`[Notify] aviation_closure ${a.iata}: no coordinates on the alert row — publishing unlocated (invisible to proximity rules)`);
    await publishNotificationEvent({
      eventType: 'aviation_closure',
      payload: {
        title: `${a.iata}${a.city ? ` (${a.city})` : ''}: ${a.reason || 'Airport disruption'}`,
        source: 'AviationStack',
        ...(countryCode ? { countryCode } : {}),
        ...site,
        // Coalesce by airport + severity band: repeated same-band disruptions
        // collapse, but a MAJOR->SEVERE escalation produces a distinct key — and
        // the prev-state diff above uses the SAME identity, so the escalation is
        // not filtered upstream (mirrors marketAlertCoalesceKey; prefix matches
        // the aviation_closure eventType and the notam:closure sibling). PR #4985.
        coalesceKey: `aviation:closure:${a.iata}:${severity}`,
      },
      severity,
      variant: undefined,
      dedupTtl: 14_400, // 4h
    });
  }
}

async function dispatchNotamNotifications(closedIcaos, reasons, sourceByIcao = {}) {
  const prev = await upstashGet(NOTAM_PREV_CLOSED_KEY);
  const prevSet = new Set(Array.isArray(prev) ? prev : []);
  const newClosures = closedIcaos.filter(icao => !prevSet.has(icao));

  await upstashSet(NOTAM_PREV_CLOSED_KEY, closedIcaos, PREV_STATE_TTL);

  for (const icao of newClosures.slice(0, 3)) {
    // NOTAM rows are keyed by ICAO; resolve country through the airport
    // registry so country-scoped rules can filter (#5359). Same miss-warn
    // rationale as dispatchAviationNotifications above.
    const airport = AIRPORTS.find(a => a.icao === icao);
    const countryCode = countryNameToIso2(airport?.country);
    if (!countryCode) console.warn(`[Notify] notam_closure ${icao}: no registry country normalized — publishing unattributed (invisible to country-scoped rules)`);
    // Same miss-warn rationale as countryCode above.
    const site = airportNotifyLocation(airport);
    if (site.lat === undefined) console.warn(`[Notify] notam_closure ${icao}: no coordinates in the airport registry — publishing unlocated (invisible to proximity rules)`);
    await publishNotificationEvent({
      eventType: 'notam_closure',
      payload: {
        title: `NOTAM: ${icao} — ${reasons[icao] || 'Airport closure'}`,
        source: sourceByIcao[icao] || 'ICAO NOTAM',
        coalesceKey: `notam:closure:${icao}`,
        ...(countryCode ? { countryCode } : {}),
        ...site,
      },
      severity: 'high',
      variant: undefined,
      dedupTtl: 21_600, // 6h
    });
  }
}

// ─── Page-load bootstrap aggregate ───────────────────────────────────────────
// Mirror of the alerts-array assembly in
// server/worldmonitor/aviation/v1/list-airport-delays.ts (FAA + intl + NOTAM
// merge + Normal-operations filler from AIRPORTS). Keep the two builders in
// lockstep — when the RPC's NOTAM merge / filler shape / enum mapping changes,
// update both. Enum-string forms here match SEVERITY_MAP/DELAY_TYPE_MAP/REGION_MAP
// at the top of this file so consumers parse identically to the RPC's output.

const SEV_ORDER = ['normal', 'minor', 'moderate', 'major', 'severe'];

function buildNormalOpsAlert(airport, source = 'FLIGHT_DELAY_SOURCE_COMPUTED') {
  return {
    id: `status-${airport.iata}`,
    iata: airport.iata,
    icao: airport.icao,
    name: airport.name,
    city: airport.city ?? '',
    country: airport.country,
    location: { latitude: airport.lat ?? 0, longitude: airport.lon ?? 0 },
    region: REGION_MAP[airport.region] ?? 'AIRPORT_REGION_AMERICAS',
    delayType: 'FLIGHT_DELAY_TYPE_GENERAL',
    severity: 'FLIGHT_DELAY_SEVERITY_NORMAL',
    avgDelayMinutes: 0,
    delayedFlightsPct: 0,
    cancelledFlights: 0,
    totalFlights: 0,
    reason: 'Normal operations',
    source,
    updatedAt: Date.now(),
  };
}

function buildUnknownOpsAlert(airport) {
  return {
    id: `unknown-${airport.iata}`,
    iata: airport.iata,
    icao: airport.icao,
    name: airport.name,
    city: airport.city ?? '',
    country: airport.country,
    location: { latitude: airport.lat ?? 0, longitude: airport.lon ?? 0 },
    region: REGION_MAP[airport.region] ?? 'AIRPORT_REGION_AMERICAS',
    delayType: 'FLIGHT_DELAY_TYPE_GENERAL',
    severity: 'FLIGHT_DELAY_SEVERITY_UNKNOWN',
    avgDelayMinutes: 0,
    delayedFlightsPct: 0,
    cancelledFlights: 0,
    totalFlights: 0,
    reason: 'Coverage unavailable',
    source: 'FLIGHT_DELAY_SOURCE_UNSPECIFIED',
    updatedAt: Date.now(),
  };
}

const NOTAM_OPEN_REASON = 'Open';

// The NOTAM feed carries this airport's NOTAMs and none closes or restricts it.
function buildNotamOpenAlert(airport) {
  return {
    ...buildNotamAlert(airport, NOTAM_OPEN_REASON, 'normal', 'general'),
    id: `notam-open-${airport.iata}`,
  };
}

function buildNotamAlert(airport, reason, severity = 'severe', delayType = 'closure') {
  const trimmed = reason.length > 200 ? reason.slice(0, 200) + '…' : reason;
  return {
    id: `notam-${airport.iata}`,
    iata: airport.iata,
    icao: airport.icao,
    name: airport.name,
    city: airport.city ?? '',
    country: airport.country,
    location: { latitude: airport.lat ?? 0, longitude: airport.lon ?? 0 },
    region: REGION_MAP[airport.region] ?? 'AIRPORT_REGION_AMERICAS',
    delayType: DELAY_TYPE_MAP[delayType] ?? 'FLIGHT_DELAY_TYPE_CLOSURE',
    severity: SEVERITY_MAP[severity] ?? 'FLIGHT_DELAY_SEVERITY_SEVERE',
    avgDelayMinutes: 0,
    delayedFlightsPct: 0,
    cancelledFlights: 0,
    totalFlights: 0,
    reason: trimmed,
    source: 'FLIGHT_DELAY_SOURCE_NOTAM',
    updatedAt: Date.now(),
  };
}

function mergeNotamWithExistingAlert(airport, notamReason, existing, severity = 'severe', delayType = 'closure') {
  if (!existing || existing.totalFlights === 0) {
    return buildNotamAlert(airport, notamReason, severity, delayType);
  }
  const cancelRate = (existing.cancelledFlights / existing.totalFlights) * 100;
  const notamCancelSev = cancelRate >= 50 ? 'severe' : cancelRate >= 25 ? 'major' : cancelRate >= 10 ? 'moderate' : 'minor';
  const existingSevName = (existing.severity ?? '')
    .replace('FLIGHT_DELAY_SEVERITY_', '').toLowerCase() || 'normal';
  const effectiveSev = SEV_ORDER[Math.max(
    SEV_ORDER.indexOf(existingSevName),
    SEV_ORDER.indexOf(notamCancelSev),
    SEV_ORDER.indexOf('moderate'), // notamFloor
  )] ?? 'moderate';
  const cancelText = `${Math.round(cancelRate)}% cxl`;
  const reason = `NOTAM: ${notamReason.slice(0, 120)} — ${cancelText}`;
  const trimmed = reason.length > 200 ? reason.slice(0, 200) + '…' : reason;
  return {
    ...existing,
    id: `notam-${airport.iata}`,
    severity: SEVERITY_MAP[effectiveSev] ?? 'FLIGHT_DELAY_SEVERITY_MODERATE',
    delayType: DELAY_TYPE_MAP[delayType] ?? 'FLIGHT_DELAY_TYPE_CLOSURE',
    reason: trimmed,
    source: 'FLIGHT_DELAY_SOURCE_NOTAM',
    updatedAt: Date.now(),
  };
}

// Parse src/config/airports.ts as text to recover the live RPC's MONITORED_AIRPORTS
// registry without a TS build step. The RPC iterates this for "Normal operations"
// filler; the seeder's local AIRPORTS list is a related-but-different set
// (carries `sources` for which feed covers each airport, omits some RPC-only
// entries, has some seeder-only entries). Today the two diverge by ~45 iata codes.
// We read both at runtime and union them by iata so the bootstrap covers every
// airport either registry knows about — match RPC output exactly + future-proof
// against drift in either direction.
//
// Memoised: read-once at module load. If parse fails (unexpected file shape, file
// missing in some packaging), we degrade to seeder's AIRPORTS only and warn —
// bootstrap is still produced, just without the RPC-only iata coverage.
let _monitoredAirportsCache = null;
function loadMonitoredAirportsFromConfigFile() {
  if (_monitoredAirportsCache !== null) return _monitoredAirportsCache;
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const path = join(here, '..', 'src', 'config', 'airports.ts');
    const src = readFileSync(path, 'utf8');
    const rows = [];
    // Match rows of shape: { iata: 'XXX', icao: 'YYYY', name: '...', city: '...',
    // country: '...', lat: N, lon: N, region: '...' }. Allows both single + double
    // quotes for `name` (some rows use double-quote to embed apostrophes).
    const rowRe = /\{\s*iata:\s*'([A-Z]{3})'\s*,\s*icao:\s*'([A-Z0-9]{3,4})'\s*,\s*name:\s*(?:'([^']*)'|"([^"]*)")\s*,\s*city:\s*(?:'([^']*)'|"([^"]*)")\s*,\s*country:\s*(?:'([^']*)'|"([^"]*)")\s*,\s*lat:\s*(-?\d+(?:\.\d+)?)\s*,\s*lon:\s*(-?\d+(?:\.\d+)?)\s*,\s*region:\s*'([a-z]+)'\s*\}/g;
    let m;
    while ((m = rowRe.exec(src)) !== null) {
      rows.push({
        iata:    m[1],
        icao:    m[2],
        name:    m[3] ?? m[4],
        city:    m[5] ?? m[6],
        country: m[7] ?? m[8],
        lat:     parseFloat(m[9]),
        lon:     parseFloat(m[10]),
        region:  m[11],
      });
    }
    if (rows.length === 0) {
      console.warn(`[Bootstrap] parsed 0 rows from ${path} — falling back to seeder AIRPORTS only`);
      _monitoredAirportsCache = [];
      return _monitoredAirportsCache;
    }
    _monitoredAirportsCache = rows;
    return rows;
  } catch (err) {
    console.warn(`[Bootstrap] failed to parse src/config/airports.ts: ${err?.message || err} — falling back to seeder AIRPORTS only`);
    _monitoredAirportsCache = [];
    return _monitoredAirportsCache;
  }
}

// Union the seeder's AIRPORTS with RPC's MONITORED_AIRPORTS by iata. Seeder rows
// win on conflict (they have the more recent canonical NOTAM/AviationStack meta).
// Logs a warning summary on first divergence so registry drift surfaces in cron
// logs without blocking writes.
let _filterRegistryWarnLogged = false;
function buildFillerRegistry() {
  const monitored = loadMonitoredAirportsFromConfigFile();
  const byIata = new Map();
  for (const a of monitored) byIata.set(a.iata, a);
  for (const a of AIRPORTS)  byIata.set(a.iata, a); // seeder wins on conflict
  if (!_filterRegistryWarnLogged) {
    const seederIatas    = new Set(AIRPORTS.map(a => a.iata));
    const monitoredIatas = new Set(monitored.map(a => a.iata));
    const monitoredOnly  = [...monitoredIatas].filter(i => !seederIatas.has(i));
    const seederOnly     = [...seederIatas].filter(i => !monitoredIatas.has(i));
    if (monitoredOnly.length > 0 || seederOnly.length > 0) {
      console.warn(`[Bootstrap] registry drift: ${monitoredOnly.length} RPC-only iatas (${monitoredOnly.slice(0, 10).join(',')}${monitoredOnly.length > 10 ? '…' : ''}), ${seederOnly.length} seeder-only iatas (${seederOnly.slice(0, 10).join(',')}${seederOnly.length > 10 ? '…' : ''}). Bootstrap covers union of both (${byIata.size} airports).`);
    }
    _filterRegistryWarnLogged = true;
  }
  return [...byIata.values()];
}

export function buildDelaysBootstrapPayload({
  faaPayload,
  intlPayload,
  notamPayload,
  fillerRegistry = buildFillerRegistry(),
} = {}) {
  const faaSourceCovered = !!faaPayload && Array.isArray(faaPayload.alerts);
  const intlSourceCovered = !!intlPayload && Array.isArray(intlPayload.alerts);
  const faaAlerts = faaSourceCovered ? faaPayload.alerts : [];
  const intlAlerts = intlSourceCovered ? intlPayload.alerts : [];
  const hasIntlCoverage = Array.isArray(intlPayload?.coverage);
  const intlCoverage = hasIntlCoverage ? intlPayload.coverage : [];
  const intlCoveredIatas = new Set(
    hasIntlCoverage
      ? intlCoverage
        .filter((hub) => hub.status === 'normal' || hub.status === 'disruption')
        .map((hub) => hub.iata)
      : [],
  );
  const closedIcaos = Array.isArray(notamPayload?.closedIcaos) ? notamPayload.closedIcaos : [];
  const restrictedIcaos = Array.isArray(notamPayload?.restrictedIcaos) ? notamPayload.restrictedIcaos : [];
  const reasons = (notamPayload?.reasons && typeof notamPayload.reasons === 'object') ? notamPayload.reasons : {};
  const notamCoveredIcaos = new Set(Array.isArray(notamPayload?.coveredIcaos) ? notamPayload.coveredIcaos : []);

  const allAlerts = [...faaAlerts, ...intlAlerts];
  const existingIatas = new Set(allAlerts.map(a => a.iata));
  const applyNotam = (icao, severity, delayType, fallback) => {
    const airport = fillerRegistry.find(a => a.icao === icao);
    if (!airport) return;
    const reason = reasons[icao] || fallback;
    if (existingIatas.has(airport.iata)) {
      const idx = allAlerts.findIndex(a => a.iata === airport.iata);
      if (idx >= 0) allAlerts[idx] = mergeNotamWithExistingAlert(airport, reason, allAlerts[idx], severity, delayType);
    } else {
      allAlerts.push(buildNotamAlert(airport, reason, severity, delayType));
      existingIatas.add(airport.iata);
    }
  };
  for (const icao of closedIcaos) applyNotam(icao, 'severe', 'closure', 'Airport closure (NOTAM)');
  for (const icao of restrictedIcaos) applyNotam(icao, 'major', 'general', 'Airspace restriction (NOTAM)');

  const alertedIatas = new Set(allAlerts.map(a => a.iata));
  for (const airport of fillerRegistry) {
    if (alertedIatas.has(airport.iata)) continue;
    const isFaaCovered = FAA_IATAS.has(airport.iata) && faaSourceCovered;
    const isIntlCovered = AVIATIONSTACK_IATAS.has(airport.iata) && intlCoveredIatas.has(airport.iata);
    if (isFaaCovered || isIntlCovered) {
      allAlerts.push(buildNormalOpsAlert(
        airport,
        isFaaCovered ? 'FLIGHT_DELAY_SOURCE_FAA' : 'FLIGHT_DELAY_SOURCE_AVIATIONSTACK',
      ));
    } else if (notamCoveredIcaos.has(airport.icao)) {
      allAlerts.push(buildNotamOpenAlert(airport));
    } else {
      allAlerts.push(buildUnknownOpsAlert(airport));
    }
  }

  return { alerts: allAlerts, coverage: intlCoverage };
}

// Build + write the page-load bootstrap aggregate. Pass `intlOverride` to use
// this-tick's intl from afterPublish (skips the Redis round-trip and avoids
// a one-tick lag); omit to fall back to the last-good intl in Redis (used by
// the pre-runSeed call so a current-tick intl failure still refreshes bootstrap).
async function writeDelaysBootstrap(intlOverride) {
  try {
    const [faaPayload, intlPayload, notamPayload] = await Promise.all([
      upstashGetUnwrapped(FAA_KEY),
      intlOverride ? Promise.resolve(intlOverride) : upstashGetUnwrapped(INTL_KEY),
      upstashGetUnwrapped(NOTAM_KEY),
    ]);

    const payload = buildDelaysBootstrapPayload({ faaPayload, intlPayload, notamPayload });
    const ok = await upstashSet(BOOTSTRAP_KEY, payload, BOOTSTRAP_TTL);
    if (ok) {
      // Only after the aggregate itself landed: a heartbeat written ahead of a
      // failed SET would claim freshness for a payload nobody stored. The meta
      // TTL (writeSeedMeta's 7d default) deliberately outlives BOOTSTRAP_TTL, so
      // an expired aggregate reads STALE_SEED against maxStaleMin rather than
      // losing its clock at the same moment it loses its data.
      await writeSeedMeta(BOOTSTRAP_KEY, payload.alerts.length, BOOTSTRAP_META_KEY);
      console.log(`[Bootstrap] wrote ${payload.alerts.length} alerts to ${BOOTSTRAP_KEY} (faa=${Array.isArray(faaPayload?.alerts) ? faaPayload.alerts.length : 0}, intl=${Array.isArray(intlPayload?.alerts) ? intlPayload.alerts.length : 0}, notam-closed=${Array.isArray(notamPayload?.closedIcaos) ? notamPayload.closedIcaos.length : 0}, notam-restricted=${Array.isArray(notamPayload?.restrictedIcaos) ? notamPayload.restrictedIcaos.length : 0})`);
    } else {
      console.warn(`[Bootstrap] SET ${BOOTSTRAP_KEY} returned false`);
    }
  } catch (err) {
    console.warn(`[Bootstrap] build/write error: ${err?.message || err}`);
  }
}

// ─── Orchestration ───────────────────────────────────────────────────────────
// runSeed's primary key = INTL (largest spend, most-consumed). FAA + NOTAM +
// News are written as "extra keys" after the primary publish. Each has its own
// seed-meta override that matches api/health.js expectations.

// ─── Side-car seed runners ───────────────────────────────────────────────────
// Each secondary data source (FAA, NOTAM, news) seeds INDEPENDENTLY of the
// AviationStack intl path. A transient intl outage or missing AVIATIONSTACK_API
// MUST NOT freeze FAA/NOTAM/news writes — they have their own upstream sources
// (FAA ASWS, ICAO API, RSS) and their own consumers (list-airport-delays,
// loadNotamClosures, list-aviation-news).
//
// Each side-car: acquires its own Redis lock (distinct from intl's lock),
// fetches, writes data-key + seed-meta on success, extends TTL on failure,
// releases the lock in finally. Sequential so concurrent Railway cron fires
// don't stomp; each source's cost is independent so total wall time ≈ sum.

async function withLock(lockDomain, body) {
  const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const lockResult = await acquireLockSafely(lockDomain, runId, 120_000, { label: lockDomain });
  if (lockResult.skipped) {
    console.log(`  ${lockDomain}: SKIPPED (Redis unavailable)`);
    return;
  }
  if (!lockResult.locked) {
    console.log(`  ${lockDomain}: SKIPPED (lock held by another run)`);
    return;
  }
  try {
    await body();
  } finally {
    await releaseLock(lockDomain, runId);
  }
}

async function runFaaSideCar() {
  await withLock('aviation:faa', async () => {
    try {
      const faa = await seedFaaDelays();
      if (faa?.alerts) {
        await writeExtraKeyWithMeta(FAA_KEY, faa, FAA_TTL, faa.alerts.length, FAA_META_KEY);
        console.log(`[FAA] wrote ${faa.alerts.length} alerts to ${FAA_KEY}`);
      }
    } catch (err) {
      console.warn(`[FAA] fetch/write error: ${err?.message || err} — extending TTL`);
      try { await extendExistingTtl([FAA_KEY, FAA_META_KEY], FAA_TTL); } catch {}
    }
  });
}

// Failure path for the NOTAM side-car. seed-meta:aviation:notam.fetchedAt is the
// last HEALTHY fetch, never the last attempt: it is not rewritten here (and its
// TTL is not touched, so it cannot be shortened into an early miss), so
// api/health.js notamClosures ages into STALE_SEED once maxStaleMin passes. The
// last-good closure list keeps serving only while it is inside that same budget;
// past it, the data key is left to expire rather than presenting days-old
// closures as current. Mirrors runSeed's graceful-failure contract.
async function preserveLastGoodNotam(reason) {
  let ageMin = null;
  try {
    const fetchedAt = (await upstashGet(NOTAM_META_KEY))?.fetchedAt;
    if (typeof fetchedAt === 'number' && Number.isFinite(fetchedAt)) ageMin = (Date.now() - fetchedAt) / 60_000;
  } catch { /* unknown age — treat as out of budget */ }
  if (ageMin !== null && ageMin <= NOTAM_MAX_STALE_MIN) {
    try { await extendExistingTtl([NOTAM_KEY], NOTAM_TTL); } catch {}
    console.warn(`[NOTAM] ${reason} — kept last-good closures (${Math.round(ageMin)}min old); seed-meta not refreshed`);
  } else {
    const age = ageMin === null ? 'unknown age' : `${Math.round(ageMin)}min old`;
    console.warn(`[NOTAM] ${reason} — last-good closures (${age}) are past maxStaleMin ${NOTAM_MAX_STALE_MIN}; letting them expire`);
  }
}

// FAA NMS closures (scripts/seed-notam-nms.mjs) cover every aerodrome NMS
// reports, foreign ones included. A snapshot older than its own freshness
// budget is not a current observation and is ignored.
async function loadNmsClosures() {
  try {
    const snapshot = await upstashGetUnwrapped(NMS_CLOSURES_KEY);
    return isFreshNmsClosures(snapshot, Date.now()) ? snapshot : null;
  } catch {
    return null;
  }
}

// An unreadable marker counts as activated: holding last-good is the safe miss.
async function isNmsActivated() {
  try {
    // upstashGet swallows read errors as null; EXISTS through upstashCommand
    // throws, so an unreadable marker reaches the catch.
    const res = await upstashCommand(['EXISTS', NMS_ACTIVATION_KEY]);
    return res?.result !== 0;
  } catch {
    return true;
  }
}

const NOTAM_SOURCE_LABELS = { nms: 'FAA NMS NOTAM', icao: 'ICAO NOTAM' };

async function runNotamSideCar() {
  await withLock('aviation:notam', async () => {
    let icao = null;
    let icaoError = null;
    try {
      const result = await seedNotamClosures();
      if (!result.skipped) icao = result;
    } catch (err) {
      icaoError = err;
    }
    const nms = await loadNmsClosures();
    if (!nms && await isNmsActivated()) {
      // NMS is the primary source once activated. Publishing ICAO alone would
      // present a partial (today: empty) list as current and reset the
      // prev-closed state, so every standing closure re-notifies on recovery.
      const icaoStatus = icaoError ? `ICAO fetch failed: ${icaoError?.message || icaoError}` : 'ICAO alone is partial';
      await preserveLastGoodNotam(`FAA NMS closures are not current (${icaoStatus})`);
      return;
    }
    if (!icao && !nms) {
      if (icaoError) await preserveLastGoodNotam(`ICAO fetch failed: ${icaoError?.message || icaoError}`);
      return; // no source configured
    }
    if (icaoError) console.warn(`[NOTAM] ICAO fetch failed: ${icaoError?.message || icaoError} — publishing FAA NMS closures alone`);
    // NMS first: its classifier is stricter, so its reason text wins.
    const notam = mergeClosureSources(
      [{ label: NOTAM_SOURCE_LABELS.nms, snapshot: nms }, { label: NOTAM_SOURCE_LABELS.icao, snapshot: icao }],
      NOTAM_LIST,
    );
    try {
      const metaWritten = await writeExtraKeyWithMeta(
        NOTAM_KEY,
        { closedIcaos: notam.closedIcaos, restrictedIcaos: notam.restrictedIcaos, reasons: notam.reasons, coveredIcaos: notam.coveredIcaos },
        NOTAM_TTL,
        notam.closedIcaos.length + notam.restrictedIcaos.length,
        NOTAM_META_KEY,
      );
      if (!metaWritten) throw new Error(`${NOTAM_META_KEY} write returned a non-OK response`);
      console.log(`[NOTAM] wrote ${notam.closedIcaos.length} closures + ${notam.restrictedIcaos.length} restrictions to ${NOTAM_KEY}`);
    } catch (err) {
      await preserveLastGoodNotam(`write error: ${err?.message || err}`);
      return;
    }
    try { await dispatchNotamNotifications(notam.closedIcaos, notam.reasons, notam.sourceByIcao); }
    catch (e) { console.warn(`[NOTAM] notify error: ${e?.message || e}`); }
  });
}

async function runNewsSideCar() {
  await withLock('aviation:news', async () => {
    try {
      const news = await seedAviationNews();
      if (news?.items?.length > 0) {
        await writeExtraKeyWithMeta(NEWS_KEY, news, NEWS_TTL, news.items.length);
        console.log(`[News] wrote ${news.items.length} articles to ${NEWS_KEY}`);
      }
    } catch (err) {
      console.warn(`[News] fetch/write error: ${err?.message || err}`);
    }
  });
}

// ─── Intl via runSeed ────────────────────────────────────────────────────────
// Intl (the paid-API, high-cost canonical) uses runSeed's full machinery:
// contract-mode envelope, retry-on-throw, graceful TTL-extend on failure,
// seed-meta freshness. When intl is unhealthy we throw to force runSeed into
// its catch path — which extends the INTL_KEY + seed-meta:aviation:intl TTLs
// and exits 0 only for a provider outage while Redis confirms last-good
// retention within maxStaleMin, without touching afterPublish. FAA/NOTAM/news
// already ran via their side-cars and are independent — an intl outage does
// NOT freeze their freshness.

// Quota guard: returns true when the last successful intl publish is younger
// than INTL_MIN_REFRESH_MIN, meaning we can serve last-good and skip the paid
// AviationStack fetch this tick. Reads seed-meta:aviation:intl, whose fetchedAt
// runSeed refreshes ONLY on a successful publish — the graceful-failure path
// leaves it stale, so a real upstream outage still retries every tick rather
// than being suppressed by the gate. Fail-open: any read error / missing meta /
// non-numeric fetchedAt → false (fetch), so we never trade freshness for a
// flaky Redis read.
export async function intlIsFresh() {
  if (INTL_MIN_REFRESH_MIN <= 0) return false;
  try {
    const meta = await readCanonicalValue(INTL_META_KEY);
    const fetchedAt = meta?.fetchedAt;
    if (typeof fetchedAt !== 'number' || !Number.isFinite(fetchedAt)) return false;
    const ageMin = (Date.now() - fetchedAt) / 60_000;
    if (ageMin < 0) return false; // clock skew — treat as stale, fetch
    return ageMin < INTL_MIN_REFRESH_MIN;
  } catch {
    return false;
  }
}

// Billing-cycle AviationStack budget backstop. Mirrors
// reserveAviationStackCalls() in server/worldmonitor/aviation/v1/_avstack-budget.ts
// — SAME Redis key + env names so the seeder and the request-time RPCs share
// one counter and one hard ceiling. Keep the two in lockstep. 'seed' kind
// reserves against the full AVIATIONSTACK_MONTHLY_BUDGET; request-time stops
// earlier (see _avstack-budget.ts), reserving headroom for this curated feed.
//
// This seeder is the bulk spender: AVIATIONSTACK_LIST.length (56) paid calls
// per sweep, ~24 sweeps/day under the 55min freshness gate — ~40.3k of the 48k
// default over a 30-day cycle, ~41.7k over a 31-day one. If that stops fitting
// the plan, the sweep cadence is the lever, not this ceiling.
export function avstackMonthlyBudget() {
  return nonNegativeEnv('AVIATIONSTACK_MONTHLY_BUDGET', 48_000);
}

const DEFAULT_CYCLE_RESET_DAY = 25;

// Clamped to 1..28 so a cycle opens in every month — an anniversary of 29-31
// would silently skip February and hand out a double-length allowance.
function cycleResetDay() {
  const raw = Number(process.env.AVIATIONSTACK_CYCLE_RESET_DAY?.trim());
  if (!Number.isInteger(raw) || raw < 1 || raw > 28) return DEFAULT_CYCLE_RESET_DAY;
  return raw;
}

/**
 * Redis counter key for the current UTC BILLING CYCLE, named by its start date.
 *
 * The window is the invoice's, not the calendar's — AviationStack bills from an
 * anniversary day (the 25th on this account), so a `<YYYY-MM>` key kept the cap
 * refusing calls into a fresh allowance and zeroing itself mid-cycle.
 *
 * The server-side reserver in server/worldmonitor/aviation/v1/_avstack-budget.ts
 * builds the SAME key; if the two ever drift, the shared ceiling splits into two
 * independent counters and silently doubles AviationStack spend. Exported so
 * that agreement can be asserted by comparing the two functions' output rather
 * than by grepping both files for `getUTCMonth()`.
 */
export function avstackBudgetKey(now = new Date()) {
  const resetDay = cycleResetDay();
  const monthOffset = now.getUTCDate() >= resetDay ? 0 : -1;
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + monthOffset, resetDay));
  const pad = (n) => String(n).padStart(2, '0');
  const cycle = `${start.getUTCFullYear()}-${pad(start.getUTCMonth() + 1)}-${pad(start.getUTCDate())}`;
  return `aviation:avstack:calls:${cycle}`;
}

export async function reserveAviationStackBudget(count) {
  const cap = avstackMonthlyBudget();
  if (cap <= 0 || count <= 0) return true; // disabled
  const { url, token } = getRedisCredentials();
  if (!url || !token) return true; // fail-open (gate already bounds spend)
  const key = avstackBudgetKey();
  const ttl = 40 * 24 * 60 * 60; // 40d
  try {
    const resp = await fetch(`${url}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify([['INCRBY', key, count], ['EXPIRE', key, ttl]]),
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) return true; // fail-open
    const results = await resp.json();
    const total = Number(results?.[0]?.result);
    if (!Number.isFinite(total)) return true;
    if (total > cap) {
      // Return the reservation so the counter reflects calls actually made.
      try {
        const refundResp = await fetch(`${url}/pipeline`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify([['DECRBY', key, count]]),
          signal: AbortSignal.timeout(10_000),
        });
        if (!refundResp.ok) {
          console.warn(`[Aviation] AviationStack seed budget refund failed with HTTP ${refundResp.status}; counter may be inflated`);
        } else {
          const refundResults = await refundResp.json();
          const refundedTotal = Number(refundResults?.[0]?.result);
          if (!Number.isFinite(refundedTotal)) {
            console.warn(`[Aviation] AviationStack seed budget refund returned no counter; counter may be inflated`);
          }
        }
      } catch (err) {
        console.warn(`[Aviation] AviationStack seed budget refund failed: ${err instanceof Error ? err.message : err}; counter may be inflated`);
      }
      return false;
    }
    return true;
  } catch {
    return true; // fail-open
  }
}

export async function fetchIntl() {
  const result = await seedIntlDelays();
  if (!result.healthy || result.skipped) {
    const why = result.skipped
      ? 'no AVIATIONSTACK_API key'
      : result.authFailed > 0
        ? `AviationStack rejected the key on ${result.authFailed} airport(s)`
        : 'systemic fetch failure (failures > successes)';
    // nonRetryable is load-bearing for the budget cap. Without it, runSeed's
    // withRetry re-runs fetchIntl up to 4x on an unhealthy tick, and EACH run
    // sweeps the FULL airport list again — so a degraded upstream costs up to
    // 4x the paid AviationStack calls while the budget counter (reserved once
    // in main()) only saw one batch, letting actual spend run past the ceiling
    // exactly when the cap matters most. Tagging the error makes withRetry exit
    // after one attempt, keeping actual calls bounded by the single
    // reservation. We lose nothing: the seeder already re-runs every cron tick.
    const err = new Error(`intl unpublishable: ${why}`);
    err.nonRetryable = true;
    // Only a real provider outage may ride out on last-good with exit 0. A
    // missing or rejected key is a configuration error and must keep crashing
    // the cron.
    if (!result.skipped && !(result.authFailed > 0)) markPreservableFetchFailure(err);
    throw err;
  }

  // A globally healthy sweep can miss required China hubs. Retry only those
  // hubs once before the publish starts the 55-minute gate, never the full
  // paid sweep. Reserve the extra calls against the same monthly ceiling.
  const unavailableHubs = CHINA_AVIATIONSTACK_HUBS.filter((hub) => result.coverage.some(
    (row) => row.iata === hub.iata && ['failed', 'omitted'].includes(row.status),
  ));
  if (unavailableHubs.length > 0 && await reserveAviationStackBudget(unavailableHubs.length)) {
    const retry = await seedIntlDelays({ airports: unavailableHubs });
    const recovered = new Map(retry.coverage
      .filter((row) => row.status === 'normal' || row.status === 'disruption')
      .map((row) => [row.iata, row]));
    // Keep the original observations and alerts for every other airport. A
    // failed retry must not manufacture coverage or refresh old timestamps.
    result.coverage = result.coverage.map((row) => recovered.get(row.iata) ?? row);
    result.alerts.push(...retry.alerts);
    console.log(`[Intl] China hub retry: ${recovered.size}/${unavailableHubs.length} recovered`);
  }
  return result;
}

export function declareRecords(data) {
  return data?.alerts?.length ?? 0;
}

// publishTransform reshapes seedIntlDelays' output into the canonical envelope
// consumers read. Coverage makes provider omission distinguishable from a
// successful hub response with no current disruption.
export function publishTransform(data) {
  return {
    alerts: data?.alerts ?? [],
    coverage: data?.coverage ?? [],
  };
}

async function afterPublishIntl(data) {
  // CONTRACT: runSeed forwards the RAW fetchIntl() result here, NOT the
  // publishTransform()'d shape. fetchIntl returns seedIntlDelays' output
  // ({ alerts, coverage, healthy, skipped, ... }). Keep the bootstrap's intl
  // envelope in lockstep with INTL_KEY so provider omissions stay observable.
  try { await dispatchAviationNotifications(data.alerts); }
  catch (e) { console.warn(`[Intl] notify error: ${e?.message || e}`); }
  // Refresh the page-load bootstrap with this-tick intl. The pre-runSeed call
  // in main() already wrote a bootstrap using last-good intl; this overwrite
  // upgrades it to current.
  await writeDelaysBootstrap(publishTransform(data));
}

export function validate(publishData) {
  // Zero alerts is a valid steady state (no current airport disruptions) —
  // but alerts and per-hub provider coverage must both retain their shape.
  return !!(
    publishData
    && Array.isArray(publishData.alerts)
    && Array.isArray(publishData.coverage)
    && publishData.coverage.every((hub) => (
      typeof hub?.iata === 'string'
      && ['normal', 'disruption', 'omitted', 'failed'].includes(hub.status)
      && Number.isInteger(hub.flightCount)
      && hub.flightCount >= 0
      && Number.isFinite(hub.updatedAt)
    ))
  );
}

// Entry point: run the three independent side-cars sequentially, then hand off
// to runSeed for intl. runSeed calls process.exit() on every terminal path, so
// it MUST be the last thing invoked in this file.
async function main() {
  console.log('=== Aviation Seeder (side-cars + intl) ===');
  await runFaaSideCar();
  await runNotamSideCar();
  await runNewsSideCar();

  // Pre-runSeed bootstrap write: ensures the page-load aggregate refreshes even
  // if intl fetch fails this tick (runSeed's catch-path skips afterPublish).
  // Uses last-good intl from Redis; afterPublishIntl will overwrite with fresh
  // intl on success.
  await writeDelaysBootstrap();

  // Quota guard — skip the paid AviationStack fetch when last-good intl is still
  // fresh. Just extend the TTLs on the canonical key + its freshness meta so
  // consumers and /api/health keep serving last-good, then exit clean. The
  // FAA/NOTAM/news side-cars (free) and the bootstrap write above already ran,
  // so the page-load aggregate is still refreshed this tick.
  if (await intlIsFresh()) {
    await extendExistingTtl([INTL_KEY, INTL_META_KEY], INTL_TTL);
    console.log(
      `[Intl] SKIPPED AviationStack fetch — last publish < ${INTL_MIN_REFRESH_MIN}min old; ` +
      `saved ${AVIATIONSTACK_LIST.length} API call(s), extended TTLs on last-good.`,
    );
    process.exit(0);
  }

  // Monthly budget backstop — reserve this tick's batch (one call per airport)
  // against the shared AviationStack counter. If we'd breach the monthly
  // ceiling, skip the fetch and serve last-good, same as the freshness gate.
  // Belt-and-braces: the freshness gate already bounds normal spend; this caps
  // the worst case (misconfigured gate, traffic spike on the shared counter).
  // Only reserve when a key is present — seedIntlDelays no-ops without one, so
  // reserving would overcount calls that never happen.
  if (process.env.AVIATIONSTACK_API && !(await reserveAviationStackBudget(AVIATIONSTACK_LIST.length))) {
    await extendExistingTtl([INTL_KEY, INTL_META_KEY], INTL_TTL);
    console.log(
      `[Intl] SKIPPED AviationStack fetch — monthly budget (${avstackMonthlyBudget()}) reached; ` +
      `extended TTLs on last-good.`,
    );
    process.exit(0);
  }

  return runSeed('aviation', 'intl', INTL_KEY, fetchIntl, {
    validateFn: validate,
    ttlSeconds: INTL_TTL,
    sourceVersion: 'aviationstack',
    schemaVersion: 3,
    declareRecords,
    publishTransform,
    afterPublish: afterPublishIntl,
    maxStaleMin: 90,
    zeroIsValid: true,
    allowPreservedFetchFailure: true,
  });
}

// isMain guard so tests/agents can `import` the pure helpers (intlIsFresh,
// reserveAviationStackBudget, declareRecords) without firing the side-cars +
// runSeed on module load (which would touch Redis and process.exit). Matches
// the repo convention (see scripts/seed-token-panels.mjs, seed-cyber-threats).
// Railway still runs the seed via `node scripts/seed-aviation.mjs` because
// argv[1] resolves to this file.
const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/^.*[\\/]/, ''));
if (isMain) (process.argv.includes('--smoke-china')
  ? runChinaAviationStackSmoke().then((result) => {
    process.exit(result.ok ? 0 : 1);
  })
  : main()).catch((err) => {
  const cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : '';
  console.error('FATAL:', (err.message || err) + cause);
  process.exit(1);
});
