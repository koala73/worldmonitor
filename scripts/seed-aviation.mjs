#!/usr/bin/env node

/**
 * Consolidated aviation seeder. Writes four Redis keys from one cron tick:
 *
 *   aviation:delays:intl:v3      — AviationStack per-airport delay aggregates (51 intl)
 *   aviation:delays:faa:v1       — FAA ASWS XML delays (30 US)
 *   aviation:notam:closures:v2   — ICAO NOTAM closures (60 global)
 *   aviation:news::24:v1         — RSS news prewarmer (list-aviation-news.ts cache)
 *
 * Also publishes notifications for new severe/major airport disruptions and new
 * NOTAM closures via the standard wm:events:queue LPUSH + wm:notif:scan-dedup SETNX.
 * Prev-alerted state is persisted to Redis so short-lived cron invocations don't
 * re-notify on every tick.
 *
 * Supersedes: scripts/seed-airport-delays.mjs (deleted) + the in-process seed
 * loops that used to live inside scripts/ais-relay.cjs (stripped). ais-relay still
 * hosts the /aviationstack live proxy for user-triggered flight lookups.
 */

import {
  loadEnvFile,
  CHROME_UA,
  runSeed,
  writeExtraKeyWithMeta,
  extendExistingTtl,
  acquireLockSafely,
  releaseLock,
  getRedisCredentials,
} from './_seed-utils.mjs';

loadEnvFile(import.meta.url);

// ─── Redis keys / TTLs ───────────────────────────────────────────────────────

const INTL_KEY         = 'aviation:delays:intl:v3';
const FAA_KEY          = 'aviation:delays:faa:v1';
const NOTAM_KEY        = 'aviation:notam:closures:v2';
const NEWS_KEY         = 'aviation:news::24:v1';

const INTL_TTL  = 10_800; // 3h — survives ~5 consecutive missed 30min cron ticks
const FAA_TTL   = 7_200;  // 2h
const NOTAM_TTL = 7_200;  // 2h
const NEWS_TTL  = 2_400;  // 40min

// health.js expects these exact meta keys (api/health.js:222,223,269)
const INTL_META_KEY  = 'seed-meta:aviation:intl';
const FAA_META_KEY   = 'seed-meta:aviation:faa';
const NOTAM_META_KEY = 'seed-meta:aviation:notam';

// Notification dedup state (persisted so cron runs don't spam on every tick)
const AVIATION_PREV_ALERTED_KEY = 'notifications:dedup:aviation:prev-alerted:v1';
const NOTAM_PREV_CLOSED_KEY     = 'notam:prev-closed-state:v1';
const PREV_STATE_TTL            = 86_400; // 24h — longer than any realistic cron cadence

// ─── Unified airport registry ────────────────────────────────────────────────
// Each row declares: iata, icao, name, city, country, region, lat, lon (where
// known), and which data sources cover it:
//   'aviationstack' — AviationStack /v1/flights?dep_iata={iata}
//   'faa'           — FAA ASWS XML filter matches this IATA
//   'notam'         — ICAO NOTAM list includes this ICAO
// lat/lon/city are only required for rows with 'aviationstack' (feed the
// AirportDelayAlert envelope).

const AIRPORTS = [
  // ── Americas — AviationStack + NOTAM ──
  { iata: 'YYZ', icao: 'CYYZ', name: 'Toronto Pearson',           city: 'Toronto',      country: 'Canada',   lat: 43.6777,  lon: -79.6248, region: 'americas', sources: ['aviationstack', 'notam'] },
  { iata: 'YVR', icao: 'CYVR', name: 'Vancouver International',   city: 'Vancouver',    country: 'Canada',   lat: 49.1947,  lon: -123.1792, region: 'americas', sources: ['aviationstack'] },
  { iata: 'MEX', icao: 'MMMX', name: 'Mexico City International', city: 'Mexico City',  country: 'Mexico',   lat: 19.4363,  lon: -99.0721, region: 'americas', sources: ['aviationstack', 'notam'] },
  { iata: 'GRU', icao: 'SBGR', name: 'São Paulo–Guarulhos',       city: 'São Paulo',    country: 'Brazil',   lat: -23.4356, lon: -46.4731, region: 'americas', sources: ['aviationstack', 'notam'] },
  { iata: 'EZE', icao: 'SAEZ', name: 'Ministro Pistarini',        city: 'Buenos Aires', country: 'Argentina', lat: -34.8222, lon: -58.5358, region: 'americas', sources: ['aviationstack'] },
  { iata: 'BOG', icao: 'SKBO', name: 'El Dorado International',   city: 'Bogotá',       country: 'Colombia', lat: 4.7016,   lon: -74.1469, region: 'americas', sources: ['aviationstack', 'notam'] },
  { iata: 'SCL', icao: 'SCEL', name: 'Arturo Merino Benítez',     city: 'Santiago',     country: 'Chile',    lat: -33.3930, lon: -70.7858, region: 'americas', sources: ['aviationstack', 'notam'] },

  // ── Americas — FAA + NOTAM (US only; many dual-covered with AviationStack too for intl flights) ──
  { iata: 'ATL', icao: 'KATL', name: 'Hartsfield–Jackson Atlanta',            city: 'Atlanta',       country: 'USA', region: 'americas', sources: ['faa', 'notam'] },
  { iata: 'ORD', icao: 'KORD', name: "Chicago O'Hare",                         city: 'Chicago',       country: 'USA', region: 'americas', sources: ['faa', 'notam'] },
  { iata: 'DFW', icao: 'KDFW', name: 'Dallas/Fort Worth',                     city: 'Dallas',        country: 'USA', region: 'americas', sources: ['faa', 'notam'] },
  { iata: 'DEN', icao: 'KDEN', name: 'Denver International',                  city: 'Denver',        country: 'USA', region: 'americas', sources: ['faa', 'notam'] },
  { iata: 'LAX', icao: 'KLAX', name: 'Los Angeles International',             city: 'Los Angeles',   country: 'USA', region: 'americas', sources: ['faa', 'notam'] },
  { iata: 'JFK', icao: 'KJFK', name: 'John F. Kennedy International',         city: 'New York',      country: 'USA', region: 'americas', sources: ['faa', 'notam'] },
  { iata: 'SFO', icao: 'KSFO', name: 'San Francisco International',           city: 'San Francisco', country: 'USA', region: 'americas', sources: ['faa', 'notam'] },
  { iata: 'SEA', icao: 'KSEA', name: 'Seattle–Tacoma International',          city: 'Seattle',       country: 'USA', region: 'americas', sources: ['faa'] },
  { iata: 'LAS', icao: 'KLAS', name: 'Harry Reid International',              city: 'Las Vegas',     country: 'USA', region: 'americas', sources: ['faa'] },
  { iata: 'MCO', icao: 'KMCO', name: 'Orlando International',                 city: 'Orlando',       country: 'USA', region: 'americas', sources: ['faa'] },
  { iata: 'EWR', icao: 'KEWR', name: 'Newark Liberty International',          city: 'Newark',        country: 'USA', region: 'americas', sources: ['faa'] },
  { iata: 'CLT', icao: 'KCLT', name: 'Charlotte Douglas International',       city: 'Charlotte',     country: 'USA', region: 'americas', sources: ['faa'] },
  { iata: 'PHX', icao: 'KPHX', name: 'Phoenix Sky Harbor International',      city: 'Phoenix',       country: 'USA', region: 'americas', sources: ['faa'] },
  { iata: 'IAH', icao: 'KIAH', name: 'George Bush Intercontinental',          city: 'Houston',       country: 'USA', region: 'americas', sources: ['faa'] },
  { iata: 'MIA', icao: 'KMIA', name: 'Miami International',                   city: 'Miami',         country: 'USA', region: 'americas', sources: ['faa'] },
  { iata: 'BOS', icao: 'KBOS', name: 'Logan International',                   city: 'Boston',        country: 'USA', region: 'americas', sources: ['faa'] },
  { iata: 'MSP', icao: 'KMSP', name: 'Minneapolis–Saint Paul International',  city: 'Minneapolis',   country: 'USA', region: 'americas', sources: ['faa'] },
  { iata: 'DTW', icao: 'KDTW', name: 'Detroit Metropolitan',                  city: 'Detroit',       country: 'USA', region: 'americas', sources: ['faa'] },
  { iata: 'FLL', icao: 'KFLL', name: 'Fort Lauderdale–Hollywood',             city: 'Fort Lauderdale', country: 'USA', region: 'americas', sources: ['faa'] },
  { iata: 'PHL', icao: 'KPHL', name: 'Philadelphia International',            city: 'Philadelphia',  country: 'USA', region: 'americas', sources: ['faa'] },
  { iata: 'LGA', icao: 'KLGA', name: 'LaGuardia',                             city: 'New York',      country: 'USA', region: 'americas', sources: ['faa'] },
  { iata: 'BWI', icao: 'KBWI', name: 'Baltimore/Washington International',    city: 'Baltimore',     country: 'USA', region: 'americas', sources: ['faa'] },
  { iata: 'SLC', icao: 'KSLC', name: 'Salt Lake City International',          city: 'Salt Lake City', country: 'USA', region: 'americas', sources: ['faa'] },
  { iata: 'SAN', icao: 'KSAN', name: 'San Diego International',               city: 'San Diego',     country: 'USA', region: 'americas', sources: ['faa'] },
  { iata: 'IAD', icao: 'KIAD', name: 'Washington Dulles International',       city: 'Washington',    country: 'USA', region: 'americas', sources: ['faa'] },
  { iata: 'DCA', icao: 'KDCA', name: 'Ronald Reagan Washington National',     city: 'Washington',    country: 'USA', region: 'americas', sources: ['faa'] },
  { iata: 'MDW', icao: 'KMDW', name: 'Chicago Midway International',          city: 'Chicago',       country: 'USA', region: 'americas', sources: ['faa'] },
  { iata: 'TPA', icao: 'KTPA', name: 'Tampa International',                   city: 'Tampa',         country: 'USA', region: 'americas', sources: ['faa'] },
  { iata: 'HNL', icao: 'PHNL', name: 'Daniel K. Inouye International',        city: 'Honolulu',      country: 'USA', region: 'americas', sources: ['faa'] },
  { iata: 'PDX', icao: 'KPDX', name: 'Portland International',                city: 'Portland',      country: 'USA', region: 'americas', sources: ['faa'] },

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
  { iata: 'OSL', icao: 'ENGM', name: 'Oslo Gardermoen',      city: 'Oslo',      country: 'Norway',  region: 'europe', sources: ['notam'] },
  { iata: 'ARN', icao: 'ESSA', name: 'Stockholm Arlanda',    city: 'Stockholm', country: 'Sweden',  region: 'europe', sources: ['notam'] },
  { iata: 'HEL', icao: 'EFHK', name: 'Helsinki-Vantaa',      city: 'Helsinki',  country: 'Finland', region: 'europe', sources: ['notam'] },

  // ── APAC — AviationStack + NOTAM ──
  { iata: 'HND', icao: 'RJTT', name: 'Tokyo Haneda',                 city: 'Tokyo',        country: 'Japan',       lat: 35.5494, lon: 139.7798, region: 'apac', sources: ['aviationstack', 'notam'] },
  { iata: 'NRT', icao: 'RJAA', name: 'Narita International',         city: 'Tokyo',        country: 'Japan',       lat: 35.7720, lon: 140.3929, region: 'apac', sources: ['aviationstack'] },
  { iata: 'PEK', icao: 'ZBAA', name: 'Beijing Capital',              city: 'Beijing',      country: 'China',       lat: 40.0799, lon: 116.6031, region: 'apac', sources: ['aviationstack', 'notam'] },
  { iata: 'PVG', icao: 'ZSPD', name: 'Shanghai Pudong',              city: 'Shanghai',     country: 'China',       lat: 31.1443, lon: 121.8083, region: 'apac', sources: ['aviationstack'] },
  { iata: 'HKG', icao: 'VHHH', name: 'Hong Kong International',      city: 'Hong Kong',    country: 'China',       lat: 22.3080, lon: 113.9185, region: 'apac', sources: ['aviationstack', 'notam'] },
  { iata: 'SIN', icao: 'WSSS', name: 'Singapore Changi',             city: 'Singapore',    country: 'Singapore',   lat: 1.3644,  lon: 103.9915, region: 'apac', sources: ['aviationstack', 'notam'] },
  { iata: 'ICN', icao: 'RKSI', name: 'Incheon International',        city: 'Seoul',        country: 'South Korea', lat: 37.4602, lon: 126.4407, region: 'apac', sources: ['aviationstack', 'notam'] },
  { iata: 'BKK', icao: 'VTBS', name: 'Suvarnabhumi Airport',         city: 'Bangkok',      country: 'Thailand',    lat: 13.6900, lon: 100.7501, region: 'apac', sources: ['aviationstack', 'notam'] },
  { iata: 'SYD', icao: 'YSSY', name: 'Sydney Kingsford Smith',       city: 'Sydney',       country: 'Australia',   lat: -33.9461, lon: 151.1772, region: 'apac', sources: ['aviationstack', 'notam'] },
  { iata: 'DEL', icao: 'VIDP', name: 'Indira Gandhi International',  city: 'Delhi',        country: 'India',       lat: 28.5562, lon: 77.1000,  region: 'apac', sources: ['aviationstack', 'notam'] },
  { iata: 'BOM', icao: 'VABB', name: 'Chhatrapati Shivaji Maharaj',  city: 'Mumbai',       country: 'India',       lat: 19.0896, lon: 72.8656,  region: 'apac', sources: ['aviationstack'] },
  { iata: 'KUL', icao: 'WMKK', name: 'Kuala Lumpur International',   city: 'Kuala Lumpur', country: 'Malaysia',    lat: 2.7456,  lon: 101.7099, region: 'apac', sources: ['aviationstack', 'notam'] },
  { iata: 'CAN', icao: 'ZGGG', name: 'Guangzhou Baiyun International', city: 'Guangzhou',  country: 'China',       lat: 23.3924, lon: 113.2988, region: 'apac', sources: ['aviationstack'] },
  { iata: 'TPE', icao: 'RCTP', name: 'Taiwan Taoyuan International', city: 'Taipei',       country: 'Taiwan',      lat: 25.0797, lon: 121.2342, region: 'apac', sources: ['aviationstack'] },
  { iata: 'MNL', icao: 'RPLL', name: 'Ninoy Aquino International',   city: 'Manila',       country: 'Philippines', lat: 14.5086, lon: 121.0197, region: 'apac', sources: ['aviationstack'] },
  // APAC NOTAM-only
  { iata: 'KMG', icao: 'ZPPP', name: 'Kunming Changshui',            city: 'Kunming',      country: 'China',       region: 'apac', sources: ['notam'] },

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
  { iata: 'JED', icao: 'OEJN', name: 'King Abdulaziz',               city: 'Jeddah',       country: 'Saudi Arabia', region: 'mena', sources: ['notam'] },
  { iata: 'MED', icao: 'OEMA', name: 'Prince Mohammad bin Abdulaziz', city: 'Medina',       country: 'Saudi Arabia', region: 'mena', sources: ['notam'] },
  { iata: 'DMM', icao: 'OEDF', name: 'King Fahd International',       city: 'Dammam',       country: 'Saudi Arabia', region: 'mena', sources: ['notam'] },
  { iata: 'SHJ', icao: 'OMSJ', name: 'Sharjah International',         city: 'Sharjah',      country: 'UAE',          region: 'mena', sources: ['notam'] },
  { iata: 'BAH', icao: 'OBBI', name: 'Bahrain International',         city: 'Manama',       country: 'Bahrain',      region: 'mena', sources: ['notam'] },
  { iata: 'MCT', icao: 'OOMS', name: 'Muscat International',          city: 'Muscat',       country: 'Oman',         region: 'mena', sources: ['notam'] },
  { iata: 'BEY', icao: 'OLBA', name: 'Beirut–Rafic Hariri',           city: 'Beirut',       country: 'Lebanon',      region: 'mena', sources: ['notam'] },
  { iata: 'DAM', icao: 'OSDI', name: 'Damascus International',        city: 'Damascus',     country: 'Syria',        region: 'mena', sources: ['notam'] },
  { iata: 'BGW', icao: 'ORBI', name: 'Baghdad International',         city: 'Baghdad',      country: 'Iraq',         region: 'mena', sources: ['notam'] },
  { iata: 'IKA', icao: 'OIIE', name: 'Imam Khomeini International',   city: 'Tehran',       country: 'Iran',         region: 'mena', sources: ['notam'] },
  { iata: 'SYZ', icao: 'OISS', name: 'Shiraz International',          city: 'Shiraz',       country: 'Iran',         region: 'mena', sources: ['notam'] },
  { iata: 'MHD', icao: 'OIMM', name: 'Mashhad International',         city: 'Mashhad',      country: 'Iran',         region: 'mena', sources: ['notam'] },
  { iata: 'BND', icao: 'OIKB', name: 'Bandar Abbas International',    city: 'Bandar Abbas', country: 'Iran',         region: 'mena', sources: ['notam'] },
  { iata: 'TUN', icao: 'DTTA', name: 'Tunis–Carthage',                city: 'Tunis',        country: 'Tunisia',      region: 'mena', sources: ['notam'] },
  { iata: 'ALG', icao: 'DAAG', name: 'Houari Boumediene',             city: 'Algiers',      country: 'Algeria',      region: 'mena', sources: ['notam'] },
  { iata: 'TIP', icao: 'HLLT', name: 'Tripoli International',         city: 'Tripoli',      country: 'Libya',        region: 'mena', sources: ['notam'] },

  // ── Africa — AviationStack + NOTAM ──
  { iata: 'JNB', icao: 'FAOR', name: "O.R. Tambo International",      city: 'Johannesburg', country: 'South Africa', lat: -26.1392, lon: 28.2460, region: 'africa', sources: ['aviationstack', 'notam'] },
  { iata: 'NBO', icao: 'HKJK', name: 'Jomo Kenyatta International',   city: 'Nairobi',      country: 'Kenya',        lat: -1.3192,  lon: 36.9278, region: 'africa', sources: ['aviationstack', 'notam'] },
  { iata: 'LOS', icao: 'DNMM', name: 'Murtala Muhammed International', city: 'Lagos',       country: 'Nigeria',      lat: 6.5774,   lon: 3.3212,  region: 'africa', sources: ['aviationstack', 'notam'] },
  { iata: 'ADD', icao: 'HAAB', name: 'Bole International',            city: 'Addis Ababa',  country: 'Ethiopia',     lat: 8.9779,   lon: 38.7993, region: 'africa', sources: ['aviationstack'] },
  { iata: 'CPT', icao: 'FACT', name: 'Cape Town International',       city: 'Cape Town',    country: 'South Africa', lat: -33.9715, lon: 18.6021, region: 'africa', sources: ['aviationstack'] },
  // Africa NOTAM-only
  { iata: 'GBE', icao: 'FBSK', name: 'Sir Seretse Khama International', city: 'Gaborone',    country: 'Botswana',    region: 'africa', sources: ['notam'] },
];

// Derived per-source views (built once at module load)
const AVIATIONSTACK_LIST = AIRPORTS.filter(a => a.sources.includes('aviationstack'));
const FAA_LIST           = AIRPORTS.filter(a => a.sources.includes('faa')).map(a => a.iata);
const NOTAM_LIST         = AIRPORTS.filter(a => a.sources.includes('notam')).map(a => a.icao);

// iata → aviationstack-enriched meta (for building AirportDelayAlert envelopes
// with coordinates — aviationstack rows are the only ones with lat/lon).
const AIRPORT_META = Object.fromEntries(AVIATIONSTACK_LIST.map(a => [a.iata, a]));

// iata → FAA-row meta (icao/name/city/country for alert envelopes; no lat/lon
// by design — FAA rows are US-regional airports we don't render on the globe).
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
const RESOLVED_STATUSES = new Set(['cancelled', 'landed', 'active', 'arrived', 'diverted']);

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
    return result?.result === 'OK' ? 'OK' : null;
  } catch { return null; }
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
    const dedupKey = `wm:notif:scan-dedup:${eventType}${variantSuffix}:${notifyHash(`${eventType}:${payload.title ?? ''}`)}`;
    const isNew = await upstashSetNx(dedupKey, '1', dedupTtl);
    if (!isNew) {
      console.log(`[Notify] Dedup hit — ${eventType}: ${String(payload.title ?? '').slice(0, 60)}`);
      return;
    }
    const msg = JSON.stringify({ eventType, payload, severity, ...(variant ? { variant } : {}), publishedAt: Date.now() });
    const ok = await upstashLpush('wm:events:queue', msg);
    if (ok) {
      console.log(`[Notify] Queued ${severity} event: ${eventType} — ${String(payload.title ?? '').slice(0, 60)}`);
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

async function fetchAviationStackSingle(apiKey, iata) {
  const today = new Date().toISOString().slice(0, 10);
  const url = `${AVIATIONSTACK_URL}?access_key=${apiKey}&dep_iata=${iata}&flight_date=${today}&limit=100`;
  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': CHROME_UA },
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) {
      console.warn(`[Aviation] ${iata}: HTTP ${resp.status}`);
      return { ok: false, alert: null };
    }
    const json = await resp.json();
    if (json.error) {
      console.warn(`[Aviation] ${iata}: ${json.error.message}`);
      return { ok: false, alert: null };
    }
    const flights = json?.data ?? [];
    const alert = aviationAggregateFlights(iata, flights);
    return { ok: true, alert };
  } catch (err) {
    console.warn(`[Aviation] ${iata}: fetch error: ${err?.message || err}`);
    return { ok: false, alert: null };
  }
}

function aviationAggregateFlights(iata, flights) {
  if (flights.length === 0) return null;
  const meta = AIRPORT_META[iata];
  if (!meta) return null;

  let delayed = 0, cancelled = 0, totalDelay = 0, resolved = 0;
  for (const f of flights) {
    if (RESOLVED_STATUSES.has(f.flight_status || '')) resolved++;
    if (f.flight_status === 'cancelled') cancelled++;
    if (f.departure?.delay && f.departure.delay > 0) {
      delayed++;
      totalDelay += f.departure.delay;
    }
  }

  const total = resolved >= AVIATION_MIN_FLIGHTS_FOR_CLOSURE ? resolved : flights.length;
  const cancelledPct = (cancelled / total) * 100;
  const delayedPct = (delayed / total) * 100;
  const avgDelay = delayed > 0 ? Math.round(totalDelay / delayed) : 0;

  let severity, delayType, reason;
  if (cancelledPct >= 80 && total >= AVIATION_MIN_FLIGHTS_FOR_CLOSURE) {
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
    cancelledFlights: cancelled,
    totalFlights: total,
    reason,
    source: 'FLIGHT_DELAY_SOURCE_AVIATIONSTACK',
    updatedAt: Date.now(),
  };
}

async function seedIntlDelays() {
  const apiKey = process.env.AVIATIONSTACK_API;
  if (!apiKey) {
    console.log('[Intl] No AVIATIONSTACK_API key — skipping');
    return { alerts: [], healthy: false, skipped: true };
  }

  const t0 = Date.now();
  const alerts = [];
  let succeeded = 0, failed = 0;

  for (let i = 0; i < AVIATIONSTACK_LIST.length; i += AVIATION_BATCH_CONCURRENCY) {
    const chunk = AVIATIONSTACK_LIST.slice(i, i + AVIATION_BATCH_CONCURRENCY);
    const results = await Promise.allSettled(
      chunk.map(a => fetchAviationStackSingle(apiKey, a.iata)),
    );
    for (const r of results) {
      if (r.status === 'fulfilled') {
        if (r.value.ok) { succeeded++; if (r.value.alert) alerts.push(r.value.alert); }
        else failed++;
      } else {
        failed++;
      }
    }
  }

  const healthy = AVIATIONSTACK_LIST.length < 5 || failed <= succeeded;
  console.log(`[Intl] ${alerts.length} alerts (${succeeded} ok, ${failed} failed, healthy: ${healthy}) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  return { alerts, healthy, skipped: false };
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

function parseFaaXml(text) {
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
    if (arpt && FAA_LIST.includes(arpt)) {
      delays.set(arpt, { airport: arpt, reason: 'Airport closure', avgDelay: 120, type: 'ground_stop' });
    }
  }
  return delays;
}

async function seedFaaDelays() {
  const t0 = Date.now();
  const resp = await fetch(FAA_URL, {
    headers: { Accept: 'application/xml', 'User-Agent': CHROME_UA },
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) throw new Error(`FAA HTTP ${resp.status}`);
  const xml = await resp.text();
  const faaDelays = parseFaaXml(xml);

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
      location: { latitude: 0, longitude: 0 }, // FAA rows have no lat/lon in the registry
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
  console.log(`[FAA] ${alerts.length} alerts in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  return { alerts };
}

// ─── Section 3: NOTAM closures (ICAO) ────────────────────────────────────────

const ICAO_NOTAM_URL = 'https://dataservices.icao.int/api/notams-realtime-list';
const NOTAM_CLOSURE_QCODES = new Set(['FA', 'AH', 'AL', 'AW', 'AC', 'AM']);

// Returns: Array of NOTAMs on success, null on quota exhaustion, [] on other errors.
async function fetchIcaoNotams() {
  const apiKey = process.env.ICAO_API_KEY;
  if (!apiKey) return [];
  const locations = NOTAM_LIST.join(',');
  const url = `${ICAO_NOTAM_URL}?api_key=${apiKey}&format=json&locations=${locations}`;
  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': CHROME_UA },
      signal: AbortSignal.timeout(30_000),
    });
    const body = await resp.text();
    if (/reach call limit/i.test(body) || /quota.?exceed/i.test(body)) {
      console.warn('[NOTAM] ICAO quota exhausted ("Reach call limit")');
      return null;
    }
    if (!resp.ok) {
      console.warn(`[NOTAM] ICAO HTTP ${resp.status}`);
      return [];
    }
    const ct = resp.headers.get('content-type') || '';
    if (ct.includes('text/html')) {
      console.warn('[NOTAM] ICAO returned HTML (challenge page)');
      return [];
    }
    try {
      const data = JSON.parse(body);
      return Array.isArray(data) ? data : [];
    } catch {
      console.warn('[NOTAM] Invalid JSON from ICAO');
      return [];
    }
  } catch (err) {
    console.warn(`[NOTAM] Fetch error: ${err?.message || err}`);
    return [];
  }
}

async function seedNotamClosures() {
  if (!process.env.ICAO_API_KEY) {
    console.log('[NOTAM] No ICAO_API_KEY — skipping');
    return { closedIcaos: [], reasons: {}, quotaExhausted: false, skipped: true };
  }
  const t0 = Date.now();
  const notams = await fetchIcaoNotams();
  if (notams === null) {
    // Quota exhausted — don't blank the key; signal upstream to touch TTL.
    return { closedIcaos: [], reasons: {}, quotaExhausted: true, skipped: false };
  }

  const now = Math.floor(Date.now() / 1000);
  const closedSet = new Set();
  const reasons = {};

  for (const n of notams) {
    const icao = n.itema || n.location || '';
    if (!icao || !NOTAM_LIST.includes(icao)) continue;
    if (n.endvalidity && n.endvalidity < now) continue;
    const code23 = (n.code23 || '').toUpperCase();
    const code45 = (n.code45 || '').toUpperCase();
    const text = (n.iteme || '').toUpperCase();
    const isClosureCode = NOTAM_CLOSURE_QCODES.has(code23) &&
      (code45 === 'LC' || code45 === 'AS' || code45 === 'AU' || code45 === 'XX' || code45 === 'AW');
    const isClosureText = /\b(AD CLSD|AIRPORT CLOSED|AIRSPACE CLOSED|AD NOT AVBL|CLSD TO ALL)\b/.test(text);
    if (isClosureCode || isClosureText) {
      closedSet.add(icao);
      reasons[icao] = n.iteme || 'Airport closure (NOTAM)';
    }
  }
  const closedIcaos = [...closedSet];
  console.log(`[NOTAM] ${notams.length} raw NOTAMs, ${closedIcaos.length} closures in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  return { closedIcaos, reasons, quotaExhausted: false, skipped: false };
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

function parseRssItems(xml, sourceName) {
  try {
    const items = [];
    const itemRegex = /<item[\s>]([\s\S]*?)<\/item>/gi;
    let match;
    while ((match = itemRegex.exec(xml)) !== null) {
      const block = match[1];
      const title = block.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim() || '';
      const link = block.match(/<link[^>]*>([\s\S]*?)<\/link>/i)?.[1]?.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim() || '';
      const pubDate = block.match(/<pubDate[^>]*>([\s\S]*?)<\/pubDate>/i)?.[1]?.trim() || '';
      const desc = block.match(/<description[^>]*>([\s\S]*?)<\/description>/i)?.[1]?.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim() || '';
      if (title && link) items.push({ title, link, pubDate, description: desc, _source: sourceName });
    }
    return items.slice(0, 30);
  } catch {
    return [];
  }
}

async function seedAviationNews() {
  const t0 = Date.now();
  const now = Date.now();
  const cutoff = now - 24 * 60 * 60 * 1000;
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

  const items = allItems.map((item) => {
    let publishedAt = 0;
    if (item.pubDate) try { publishedAt = new Date(item.pubDate).getTime(); } catch { /* skip */ }
    if (publishedAt && publishedAt < cutoff) return null;
    const snippet = (item.description || '').replace(/<[^>]+>/g, '').slice(0, 200);
    return {
      id: Buffer.from(item.link).toString('base64').slice(0, 32),
      title: item.title, url: item.link, sourceName: item._source,
      publishedAt: publishedAt || now, snippet, matchedEntities: [], imageUrl: '',
    };
  }).filter(Boolean).sort((a, b) => b.publishedAt - a.publishedAt);
  console.log(`[News] ${items.length} articles from ${AVIATION_RSS_FEEDS.length} feeds in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  return { items };
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
  const currentIatas = new Set(severeAlerts.map(a => a.iata).filter(Boolean));
  const prev = await upstashGet(AVIATION_PREV_ALERTED_KEY);
  const prevSet = new Set(Array.isArray(prev) ? prev : []);
  const newAlerts = severeAlerts.filter(a => a.iata && !prevSet.has(a.iata));

  // Persist current set for next tick's diff (24h TTL guards restarts).
  await upstashSet(AVIATION_PREV_ALERTED_KEY, [...currentIatas], PREV_STATE_TTL);

  for (const a of newAlerts.slice(0, 3)) {
    await publishNotificationEvent({
      eventType: 'aviation_closure',
      payload: { title: `${a.iata}${a.city ? ` (${a.city})` : ''}: ${a.reason || 'Airport disruption'}`, source: 'AviationStack' },
      severity: a.severity === 'FLIGHT_DELAY_SEVERITY_SEVERE' ? 'critical' : 'high',
      variant: undefined,
      dedupTtl: 14_400, // 4h
    });
  }
}

async function dispatchNotamNotifications(closedIcaos, reasons) {
  const prev = await upstashGet(NOTAM_PREV_CLOSED_KEY);
  const prevSet = new Set(Array.isArray(prev) ? prev : []);
  const newClosures = closedIcaos.filter(icao => !prevSet.has(icao));

  await upstashSet(NOTAM_PREV_CLOSED_KEY, closedIcaos, PREV_STATE_TTL);

  for (const icao of newClosures.slice(0, 3)) {
    await publishNotificationEvent({
      eventType: 'notam_closure',
      payload: { title: `NOTAM: ${icao} — ${reasons[icao] || 'Airport closure'}`, source: 'ICAO NOTAM' },
      severity: 'high',
      variant: undefined,
      dedupTtl: 21_600, // 6h
    });
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

async function runNotamSideCar() {
  await withLock('aviation:notam', async () => {
    try {
      const notam = await seedNotamClosures();
      if (notam.skipped) return; // no ICAO_API_KEY
      if (notam.quotaExhausted) {
        // ICAO quota exhausted ("Reach call limit") — preserve the last known
        // closure list by refreshing the data-key TTL + writing fresh meta
        // with quotaExhausted=true. Keeps api/health.js (maxStaleMin: 240)
        // green through the 24h backoff window. Matches pre-strip
        // ais-relay.cjs:2805-2808 byte-for-byte.
        try { await extendExistingTtl([NOTAM_KEY], NOTAM_TTL); } catch {}
        try {
          await upstashSet(NOTAM_META_KEY, { fetchedAt: Date.now(), recordCount: 0, quotaExhausted: true }, 604_800);
        } catch (e) { console.warn(`[NOTAM] meta write error: ${e?.message || e}`); }
        console.log(`[NOTAM] ICAO quota exhausted — extended data TTL + wrote fresh meta (quotaExhausted=true)`);
        return;
      }
      await writeExtraKeyWithMeta(
        NOTAM_KEY,
        { closedIcaos: notam.closedIcaos, reasons: notam.reasons },
        NOTAM_TTL,
        notam.closedIcaos.length,
        NOTAM_META_KEY,
      );
      console.log(`[NOTAM] wrote ${notam.closedIcaos.length} closures to ${NOTAM_KEY}`);
      try { await dispatchNotamNotifications(notam.closedIcaos, notam.reasons); }
      catch (e) { console.warn(`[NOTAM] notify error: ${e?.message || e}`); }
    } catch (err) {
      console.warn(`[NOTAM] fetch/write error: ${err?.message || err} — extending TTL`);
      try { await extendExistingTtl([NOTAM_KEY, NOTAM_META_KEY], NOTAM_TTL); } catch {}
    }
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
// and exits 0 without touching afterPublish. Consumers keep serving the
// last-good snapshot. FAA/NOTAM/news already ran via their side-cars and are
// independent — an intl outage does NOT freeze their freshness.

async function fetchIntl() {
  const result = await seedIntlDelays();
  if (!result.healthy || result.skipped) {
    const why = result.skipped
      ? 'no AVIATIONSTACK_API key'
      : 'systemic fetch failure (failures > successes)';
    throw new Error(`intl unpublishable: ${why}`);
  }
  return result;
}

export function declareRecords(data) {
  return data?.alerts?.length ?? 0;
}

// publishTransform reshapes seedIntlDelays' output into the canonical envelope
// shape consumers read ({ alerts: AirportDelayAlert[] }). declareRecords sees
// this transformed shape; afterPublish still receives the raw fetchIntl result.
function publishTransform(data) {
  return { alerts: data?.alerts ?? [] };
}

async function afterPublishIntl(data) {
  try { await dispatchAviationNotifications(data.alerts); }
  catch (e) { console.warn(`[Intl] notify error: ${e?.message || e}`); }
}

function validate(publishData) {
  // Zero alerts is a valid steady state (no current airport disruptions) —
  // but shape must be { alerts: [] } regardless.
  return !!(publishData && Array.isArray(publishData.alerts));
}

// Entry point: run the three independent side-cars sequentially, then hand off
// to runSeed for intl. runSeed calls process.exit() on every terminal path, so
// it MUST be the last thing invoked in this file.
async function main() {
  console.log('=== Aviation Seeder (side-cars + intl) ===');
  await runFaaSideCar();
  await runNotamSideCar();
  await runNewsSideCar();

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
  });
}

main().catch((err) => {
  const cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : '';
  console.error('FATAL:', (err.message || err) + cause);
  process.exit(1);
});
