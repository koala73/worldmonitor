#!/usr/bin/env node
//
// seed-military-cii.mjs — Phase 2 of the CII unification (docs/archive/plans/unify-cii-single-source.md).
//
// Aggregates military activity per country into a single Redis key the CII engine
// (server/worldmonitor/intelligence/v1/get-risk-scores.ts) reads as one auxiliary source:
//
//   - military FLIGHTS  — read from `military:flights:v1` (already operator-classified
//                         by seed-military-flights.mjs)
//   - military VESSELS  — classified here from the relay `/ais/snapshot` candidate feed
//   - AIS DISRUPTIONS   — taken from the same relay snapshot
//
// Output key: `intelligence:military-cii:v1`
//   { assessedAt, byCountry: { ISO2: { ownFlights, foreignFlights, ownVessels,
//     foreignVessels, aisDisruptionHigh, aisDisruptionElevated, aisDisruptionLow } }, stats }
//
// "Honest counts": own vs foreign presence are stored as SEPARATE integers — the consumer
// applies any foreign-presence weighting at scoring time. This deliberately does NOT mirror
// the frontend's synthetic-`{}`-push ×2 hack (see the plan's Phase 2 notes).
// Since CII v14 the scorer reads only foreignFlights/foreignVessels: own counts follow the
// operator anywhere in the world, so routine training measured air-force size, not risk.
//
// SCHEDULING: like every other scripts/seed-*.mjs, this is a self-contained job run on a
// schedule by Railway (the cron/job config lives in the Railway dashboard, not the repo).
// Run cadence ~10 min; the output key TTL (3600s) tolerates a few skipped runs.
// Self-contained by necessity — scripts/ cannot import from server/ or src/ under the
// Railway nixpacks packaging. Code shared with the server lives in scripts/shared/.
//
// Railway service config (set up manually via Railway dashboard or `railway service`):
//   - Service name: seed-military-cii
//   - Builder: NIXPACKS (root Dockerfile not used for this seed)
//   - rootDirectory: scripts
//   - startCommand: node seed-military-cii.mjs
//   - Cron schedule: "*/10 * * * *" (every 10min UTC)
//   - Required env: UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN, WS_RELAY_URL
//   - Optional env: RELAY_SHARED_SECRET, RELAY_AUTH_HEADER

import { pathToFileURL } from 'node:url';
import { loadEnvFile, CHROME_UA, getRedisCredentials, acquireLockSafely, releaseLock, withRetry, writeFreshnessMetadata } from './_seed-utils.mjs';
// Flights, vessels and AIS disruptions are placed by real borders through the
// CII scorer's own module, so this seeder and the CII cannot disagree on a coordinate.
import { ciiCountryAt as geoToCountry } from './shared/cii-country-borders.mjs';

loadEnvFile(import.meta.url);

const LIVE_KEY = 'intelligence:military-cii:v1';
const LIVE_TTL = 3600;
const RELAY_TIMEOUT_MS = 15_000;

// ── Country reference tables (mirror server/.../get-risk-scores.ts + _shared.ts) ──────

const TIER1_COUNTRIES = {
  US: 'United States', RU: 'Russia', CN: 'China', UA: 'Ukraine', IR: 'Iran',
  IL: 'Israel', TW: 'Taiwan', KP: 'North Korea', SA: 'Saudi Arabia', TR: 'Turkey',
  PL: 'Poland', DE: 'Germany', FR: 'France', GB: 'United Kingdom', IN: 'India',
  PK: 'Pakistan', SY: 'Syria', YE: 'Yemen', MM: 'Myanmar', VE: 'Venezuela',
  CU: 'Cuba', MX: 'Mexico', BR: 'Brazil', AE: 'United Arab Emirates',
  KR: 'South Korea', IQ: 'Iraq', AF: 'Afghanistan', LB: 'Lebanon',
  EG: 'Egypt', JP: 'Japan', QA: 'Qatar',
};

// Intentionally narrower than server's normalizeCountryName: this table only
// has to resolve the operatorCountry strings emitted by seed-military-flights
// (full country names + 'USA' / 'UK' / 'UAE'). News-title tokens like
// 'biden' / 'trump' / 'pentagon' that normalizeCountryName carries for the
// news-classification path don't apply here — flight operator labels are
// constrained vocabulary. Producer-vocabulary coverage is locked down in
// tests/seed-military-cii.test.mts ("producer operatorCountry vocabulary").
const COUNTRY_KEYWORDS = {
  US: ['united states', 'usa', 'america', 'washington'],
  RU: ['russia', 'moscow', 'kremlin'],
  CN: ['china', 'beijing', 'prc'],
  UA: ['ukraine', 'kyiv'],
  IR: ['iran', 'tehran'],
  IL: ['israel', 'tel aviv'],
  TW: ['taiwan', 'taiwanese', 'taipei'],
  KP: ['north korea', 'north korean', 'pyongyang'],
  SA: ['saudi arabia', 'riyadh'],
  TR: ['turkey', 'ankara', 'turkiye'],
  PL: ['poland', 'warsaw'],
  DE: ['germany', 'berlin'],
  FR: ['france', 'paris'],
  GB: ['britain', 'uk', 'united kingdom', 'london', 'england'],
  IN: ['india', 'delhi'],
  PK: ['pakistan', 'islamabad'],
  SY: ['syria', 'damascus'],
  YE: ['yemen', 'sanaa'],
  MM: ['myanmar', 'burma'],
  VE: ['venezuela', 'caracas'],
  CU: ['cuba', 'havana'],
  MX: ['mexico', 'mexican'],
  BR: ['brazil', 'brasilia'],
  AE: ['uae', 'emirates', 'united arab emirates'],
  KR: ['south korea', 'korean peninsula', 'seoul'],
  IQ: ['iraq', 'iraqi', 'baghdad'],
  AF: ['afghanistan', 'afghan', 'kabul'],
  LB: ['lebanon', 'lebanese', 'beirut'],
  EG: ['egypt', 'egyptian', 'cairo'],
  JP: ['japan', 'japanese', 'tokyo'],
  QA: ['qatar', 'qatari', 'doha'],
};

// Mirrors safeNum() in server/.../get-risk-scores.ts — keep the names aligned.
function safeNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function normalizeForCountryMatch(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

const COUNTRY_KEYWORDS_NORMALIZED = Object.fromEntries(
  Object.entries(COUNTRY_KEYWORDS).map(([code, keywords]) => [code, keywords.map(normalizeForCountryMatch)]),
);

function hasCountryPhraseMatch(normalizedText, normalizedKeyword) {
  if (!normalizedText || !normalizedKeyword) return false;
  return ` ${normalizedText} `.includes(` ${normalizedKeyword} `);
}

function normalizeCountryName(text) {
  const normalized = normalizeForCountryMatch(text);
  for (const [code, keywords] of Object.entries(COUNTRY_KEYWORDS_NORMALIZED)) {
    if (keywords.some((kw) => hasCountryPhraseMatch(normalized, kw))) return code;
  }
  return null;
}

// ── Military vessel classifier (mirror src/config/military.ts + military-vessels.ts) ──

const MILITARY_VESSEL_PATTERNS = [
  { mmsiPrefix: '3699', country: 'USA' },
  { mmsiPrefix: '369970', country: 'USA' },
  { mmsiPrefix: '232', country: 'UK' },
  { mmsiPrefix: '2320', country: 'UK' },
];

const KNOWN_NAVAL_VESSELS = [
  { name: 'USS Gerald R. Ford', hullNumber: 'CVN-78', country: 'USA' },
  { name: 'USS George H.W. Bush', hullNumber: 'CVN-77', country: 'USA' },
  { name: 'USS Ronald Reagan', hullNumber: 'CVN-76', country: 'USA' },
  { name: 'USS Harry S. Truman', hullNumber: 'CVN-75', country: 'USA' },
  { name: 'USS John C. Stennis', hullNumber: 'CVN-74', country: 'USA' },
  { name: 'USS George Washington', hullNumber: 'CVN-73', country: 'USA' },
  { name: 'USS Abraham Lincoln', hullNumber: 'CVN-72', country: 'USA' },
  { name: 'USS Theodore Roosevelt', hullNumber: 'CVN-71', country: 'USA' },
  { name: 'USS Carl Vinson', hullNumber: 'CVN-70', country: 'USA' },
  { name: 'USS Dwight D. Eisenhower', hullNumber: 'CVN-69', country: 'USA' },
  { name: 'USS Nimitz', hullNumber: 'CVN-68', country: 'USA' },
  { name: 'HMS Queen Elizabeth', hullNumber: 'R08', country: 'UK' },
  { name: 'HMS Prince of Wales', hullNumber: 'R09', country: 'UK' },
  { name: 'Liaoning', hullNumber: '16', country: 'China' },
  { name: 'Shandong', hullNumber: '17', country: 'China' },
  { name: 'Fujian', hullNumber: '18', country: 'China' },
  { name: 'Admiral Kuznetsov', country: 'Russia' },
  { name: 'USS Zumwalt', hullNumber: 'DDG-1000', country: 'USA' },
  { name: 'HMS Defender', hullNumber: 'D36', country: 'UK' },
  { name: 'HMS Duncan', hullNumber: 'D37', country: 'UK' },
  { name: 'USNS Victorious', hullNumber: 'T-AGOS-19', country: 'USA' },
  { name: 'USNS Impeccable', hullNumber: 'T-AGOS-23', country: 'USA' },
  { name: 'Yuan Wang', country: 'China' },
];

// Maritime Identification Digits → country name (first 3 digits of an MMSI).
const MILITARY_MIDS = {
  '201': 'Albania', '202': 'Andorra', '203': 'Austria', '211': 'Germany', '212': 'Cyprus',
  '213': 'Georgia', '214': 'Moldova', '215': 'Malta', '216': 'Armenia', '218': 'Germany',
  '219': 'Denmark', '220': 'Denmark', '224': 'Spain', '225': 'Spain', '226': 'France',
  '227': 'France', '228': 'France', '229': 'Malta', '230': 'Finland', '231': 'Faroe',
  '232': 'UK', '233': 'UK', '234': 'UK', '235': 'UK', '236': 'Gibraltar', '237': 'Greece',
  '238': 'Croatia', '239': 'Greece', '240': 'Greece', '241': 'Greece', '242': 'Morocco',
  '243': 'Hungary', '244': 'Netherlands', '245': 'Netherlands', '246': 'Netherlands',
  '247': 'Italy', '248': 'Malta', '249': 'Malta', '250': 'Ireland', '255': 'Portugal',
  '256': 'Malta', '257': 'Norway', '258': 'Norway', '259': 'Norway', '261': 'Poland',
  '263': 'Portugal', '264': 'Romania', '265': 'Sweden', '266': 'Sweden', '267': 'Slovakia',
  '268': 'San Marino', '269': 'Switzerland', '270': 'Czechia', '271': 'Turkey',
  '272': 'Ukraine', '273': 'Russia', '274': 'North Macedonia', '275': 'Latvia',
  '276': 'Estonia', '277': 'Lithuania', '278': 'Slovenia', '279': 'Serbia',
  '316': 'Canada', '323': 'Cuba', '338': 'USA', '345': 'Mexico', '366': 'USA',
  '367': 'USA', '368': 'USA', '369': 'USA',
  '401': 'Afghanistan', '403': 'Saudi Arabia', '405': 'Bangladesh', '408': 'Bahrain',
  '412': 'China', '413': 'China', '414': 'China', '416': 'Taiwan', '417': 'Sri Lanka',
  '419': 'India', '422': 'Iran', '423': 'Azerbaijan', '425': 'Iraq', '428': 'Israel',
  '431': 'Japan', '432': 'Japan', '434': 'Turkmenistan', '436': 'Kazakhstan',
  '437': 'Uzbekistan', '438': 'Jordan', '440': 'South Korea', '441': 'South Korea',
  '443': 'Palestine', '445': 'North Korea', '447': 'Kuwait', '450': 'Lebanon',
  '451': 'Kyrgyzstan', '453': 'Macau', '455': 'Maldives', '457': 'Mongolia',
  '459': 'Nepal', '461': 'Oman', '463': 'Pakistan', '466': 'Qatar', '468': 'Syria',
  '470': 'UAE', '472': 'Tajikistan', '473': 'Yemen', '475': 'Yemen', '477': 'Hong Kong',
  '503': 'Australia', '506': 'Myanmar', '508': 'Brunei', '512': 'New Zealand',
  '525': 'Indonesia', '533': 'Malaysia', '548': 'Philippines', '563': 'Singapore',
  '564': 'Singapore', '565': 'Singapore', '566': 'Singapore', '567': 'Thailand',
  '574': 'Vietnam',
};

// Country NAME → ISO2. The classifier tables (MILITARY_MIDS, KNOWN_NAVAL_VESSELS) carry
// names; aggregation needs ISO2. Covers every name those tables can emit so a non-TIER1
// operator resolves to a real code instead of silently becoming null.
const COUNTRY_NAME_TO_ISO2 = {
  Albania: 'AL', Andorra: 'AD', Austria: 'AT', Germany: 'DE', Cyprus: 'CY', Georgia: 'GE',
  Moldova: 'MD', Malta: 'MT', Armenia: 'AM', Denmark: 'DK', Spain: 'ES', France: 'FR',
  Finland: 'FI', Faroe: 'FO', UK: 'GB', Gibraltar: 'GI', Greece: 'GR', Croatia: 'HR',
  Morocco: 'MA', Hungary: 'HU', Netherlands: 'NL', Italy: 'IT', Ireland: 'IE',
  Portugal: 'PT', Norway: 'NO', Poland: 'PL', Romania: 'RO', Sweden: 'SE', Slovakia: 'SK',
  'San Marino': 'SM', Switzerland: 'CH', Czechia: 'CZ', Turkey: 'TR', Ukraine: 'UA',
  'North Macedonia': 'MK', Latvia: 'LV', Estonia: 'EE', Lithuania: 'LT', Slovenia: 'SI',
  Serbia: 'RS', Canada: 'CA', Cuba: 'CU', USA: 'US', Mexico: 'MX', Afghanistan: 'AF',
  'Saudi Arabia': 'SA', Bangladesh: 'BD', Bahrain: 'BH', China: 'CN', Taiwan: 'TW',
  'Sri Lanka': 'LK', India: 'IN', Iran: 'IR', Azerbaijan: 'AZ', Iraq: 'IQ', Israel: 'IL',
  Japan: 'JP', Turkmenistan: 'TM', Kazakhstan: 'KZ', Uzbekistan: 'UZ', Jordan: 'JO',
  'South Korea': 'KR', Palestine: 'PS', 'North Korea': 'KP', Kuwait: 'KW', Lebanon: 'LB',
  Kyrgyzstan: 'KG', Macau: 'MO', Maldives: 'MV', Mongolia: 'MN', Nepal: 'NP', Oman: 'OM',
  Pakistan: 'PK', Qatar: 'QA', Syria: 'SY', UAE: 'AE', Tajikistan: 'TJ', Yemen: 'YE',
  'Hong Kong': 'HK', Australia: 'AU', Myanmar: 'MM', Brunei: 'BN', 'New Zealand': 'NZ',
  Indonesia: 'ID', Malaysia: 'MY', Philippines: 'PH', Singapore: 'SG', Thailand: 'TH',
  Vietnam: 'VN', Russia: 'RU',
};

function analyzeMmsi(mmsi) {
  // Reject short or non-numeric IDs before the heuristics — a letter-padded MMSI
  // (corrupt / hostile relay data) must not slip through the suffix check.
  // Shape-consistent with the other three returns below — `country` is always
  // present (possibly undefined) so call sites can rely on `result.country`
  // without a null-check on the result object itself.
  if (!mmsi || mmsi.length < 9 || !/^\d+$/.test(mmsi)) return { isPotentialMilitary: false, country: undefined };
  const mid = mmsi.substring(0, 3);
  const country = MILITARY_MIDS[mid];
  for (const pattern of MILITARY_VESSEL_PATTERNS) {
    if (pattern.mmsiPrefix && mmsi.startsWith(pattern.mmsiPrefix)) {
      return { isPotentialMilitary: true, country: pattern.country };
    }
  }
  // The 00/99-suffix heuristic is noisy on civilian MMSIs; only trust it when the MID
  // resolves to a known country — drops the unknown-MID civilian false positives.
  const suffix = mmsi.substring(3);
  if (country && (suffix.startsWith('00') || suffix.startsWith('99'))) {
    return { isPotentialMilitary: true, country };
  }
  return { isPotentialMilitary: false, country };
}

function matchKnownVessel(name) {
  if (!name) return undefined;
  const normalized = name.toUpperCase().trim();
  for (const vessel of KNOWN_NAVAL_VESSELS) {
    // Hull-number substring match only for hull numbers >=3 chars — short numeric hulls
    // ('16','17','18') match civilian names by coincidence; those carriers still match
    // by their distinctive name above.
    if (normalized.includes(vessel.name.toUpperCase())
      || (vessel.hullNumber && vessel.hullNumber.length >= 3 && normalized.includes(vessel.hullNumber))) {
      return vessel;
    }
  }
  return undefined;
}

// AIS ship-type code → military marker. 35 = military ops, 50-59 = special craft.
function isMilitaryShipType(shipType) {
  return shipType === 35 || (shipType >= 50 && shipType <= 59);
}

// Returns { operatorIso2 } if the candidate classifies as military, else null.
// operatorIso2 is null when the vessel is military by ship-type alone (no operator known).
function classifyVessel(candidate) {
  const mmsi = String(candidate.mmsi || '');
  const name = String(candidate.name || '');
  const known = matchKnownVessel(name);
  const mmsiAnalysis = analyzeMmsi(mmsi);
  const aisMilitary = isMilitaryShipType(safeNum(candidate.shipType));
  if (!known && !mmsiAnalysis.isPotentialMilitary && !aisMilitary) return null;
  const operatorName = known?.country || mmsiAnalysis.country || null;
  return { operatorIso2: operatorName ? (COUNTRY_NAME_TO_ISO2[operatorName] || null) : null };
}

// ── Redis (Upstash REST) ──────────────────────────────────────────────────────────────

async function redisCommand(url, token, command) {
  const resp = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(command),
    signal: AbortSignal.timeout(10_000),
  });
  if (!resp.ok) throw new Error(`Redis ${command[0]} ${command[1]} failed: HTTP ${resp.status}`);
  return (await resp.json()).result;
}

async function redisGetJson(url, token, key) {
  const raw = await redisCommand(url, token, ['GET', key]);
  if (!raw || typeof raw !== 'string') return null;
  try {
    const parsed = JSON.parse(raw);
    // get-risk-scores reads via getCachedJson(key, true) → unwrapEnvelope(...).data;
    // tolerate both the bare shape and a { data: ... } envelope.
    return parsed && typeof parsed === 'object' && 'data' in parsed ? parsed.data : parsed;
  } catch {
    return null;
  }
}

async function redisSetJson(url, token, key, value, ttl) {
  await redisCommand(url, token, ['SET', key, JSON.stringify(value), 'EX', ttl]);
}

async function readMilitaryFlights(readJson) {
  try {
    const flightsData = await readJson('military:flights:v1');
    const flights = Array.isArray(flightsData?.flights) ? flightsData.flights : [];
    return { ok: flights.length > 0, flights };
  } catch (err) {
    return { ok: false, flights: [], error: err };
  }
}

async function preserveLastGoodMilitaryCii(url, token, reason, missingSuffix = 'skipped publish') {
  const existing = await redisGetJson(url, token, LIVE_KEY).catch(() => null);
  if (existing && existing.byCountry) {
    await withRetry(() => redisSetJson(url, token, LIVE_KEY, existing, LIVE_TTL), 2, 1000);
    await writeFreshnessMetadata('intelligence', 'military-cii', Object.keys(existing.byCountry).length, 'seed-military-cii', LIVE_TTL);
    console.warn(`  ${reason} — preserved last-good ${LIVE_KEY}`);
    return true;
  }

  console.warn(`  ${reason}, no prior ${LIVE_KEY} — ${missingSuffix}`);
  return false;
}

// ── Relay ────────────────────────────────────────────────────────────────────────────

function getRelayBaseUrl() {
  const relayUrl = process.env.WS_RELAY_URL;
  if (!relayUrl) return null;
  return relayUrl.replace(/^ws(s?):\/\//, 'http$1://').replace(/\/$/, '');
}

function getRelayHeaders() {
  const headers = { Accept: 'application/json', 'User-Agent': CHROME_UA };
  const relaySecret = process.env.RELAY_SHARED_SECRET;
  if (relaySecret) {
    const relayHeader = (process.env.RELAY_AUTH_HEADER || 'x-relay-key').toLowerCase();
    headers[relayHeader] = relaySecret;
    if (relayHeader !== 'authorization') headers.Authorization = `Bearer ${relaySecret}`;
  }
  return headers;
}

// Returns { ok, candidateReports, disruptions }. ok=false when the relay is missing or
// unreachable (after retries) — the caller must NOT publish the empty arrays as fresh data.
async function fetchRelaySnapshot() {
  const base = getRelayBaseUrl();
  if (!base) {
    console.warn('  WS_RELAY_URL not set — vessels + AIS disruptions skipped');
    return { ok: false, candidateReports: [], disruptions: [] };
  }
  try {
    const data = await withRetry(async () => {
      const resp = await fetch(`${base}/ais/snapshot?candidates=true`, {
        headers: getRelayHeaders(),
        signal: AbortSignal.timeout(RELAY_TIMEOUT_MS),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      return resp.json();
    }, 2, 1000);
    // Cap to bound classification work — a hostile/buggy relay must not OOM the job
    // or overrun the lock TTL. Consumers in get-risk-scores cap reads at maxLen=10000.
    const cap = (a) => (Array.isArray(a) ? a.slice(0, 20_000) : []);
    return { ok: true, candidateReports: cap(data.candidateReports), disruptions: cap(data.disruptions) };
  } catch (err) {
    console.warn(`  relay /ais/snapshot failed (${err.message || err}) — vessels + AIS skipped`);
    return { ok: false, candidateReports: [], disruptions: [] };
  }
}

// ── Aggregation ──────────────────────────────────────────────────────────────────────

function emptyCountryRecord() {
  return {
    ownFlights: 0, foreignFlights: 0, ownVessels: 0, foreignVessels: 0,
    aisDisruptionHigh: 0, aisDisruptionElevated: 0, aisDisruptionLow: 0,
  };
}

function aggregate(flights, candidateReports, disruptions) {
  const byCountry = {};
  for (const code of Object.keys(TIER1_COUNTRIES)) byCountry[code] = emptyCountryRecord();

  // Flights — operator country owns it; a flight located in a different country counts
  // as foreign presence there (the dual-attribution intent of ingestMilitaryForCII).
  // When the operator is unknown (seed-military-flights emits the literal
  // operatorCountry: 'Unknown' for `other`-class matches without source metadata, and
  // non-TIER1 / coalition strings like 'NATO' also fall through normalizeCountryName)
  // we count once as local presence — same logic as the vessel branch — because we
  // cannot assert foreignness without a resolved operator, and foreignFlights is
  // x2-weighted in the C3 security formula.
  for (const f of flights) {
    const op = normalizeCountryName(f.operatorCountry);
    const loc = geoToCountry(safeNum(f.lat), safeNum(f.lon));
    if (op && byCountry[op]) byCountry[op].ownFlights++;
    if (loc && byCountry[loc]) {
      if (op && loc !== op) byCountry[loc].foreignFlights++;
      else if (!op) byCountry[loc].ownFlights++;
    }
  }

  // Vessels — classify each candidate AIS report, then attribute.
  let militaryVesselCount = 0;
  for (const c of candidateReports) {
    const cls = classifyVessel(c);
    if (!cls) continue;
    militaryVesselCount++;
    const op = cls.operatorIso2;
    const loc = geoToCountry(safeNum(c.lat), safeNum(c.lon));
    if (op && byCountry[op]) byCountry[op].ownVessels++;
    if (loc && byCountry[loc]) {
      if (op && loc !== op) byCountry[loc].foreignVessels++;
      // Operator unknown (e.g. classified by AIS ship-type alone): count once as local
      // presence, NOT as foreign — foreignVessels is ×2-weighted in the CII security
      // formula, and we cannot assert a vessel is foreign without knowing its operator.
      else if (!op) byCountry[loc].ownVessels++;
    }
  }

  // AIS disruptions — attributed by location.
  for (const d of disruptions) {
    const code = geoToCountry(safeNum(d.lat), safeNum(d.lon));
    if (!code || !byCountry[code]) continue;
    const sev = String(d.severity || '').toLowerCase();
    if (sev === 'high') byCountry[code].aisDisruptionHigh++;
    else if (sev === 'elevated') byCountry[code].aisDisruptionElevated++;
    else byCountry[code].aisDisruptionLow++;
  }

  return { byCountry, militaryVesselCount };
}

// ── Main ─────────────────────────────────────────────────────────────────────────────

async function main() {
  const startMs = Date.now();
  const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const { url, token } = getRedisCredentials();

  console.log('=== intelligence:military-cii Seed ===');

  // 180s TTL leaves headroom above worst-case runtime (flights read + relay fetch, each
  // with up to 2 retries) so a slow run cannot expire the lock and let a second run race.
  const lockResult = await acquireLockSafely('intelligence:military-cii', runId, 180_000, { label: 'military-cii' });
  if (lockResult.skipped || !lockResult.locked) {
    console.log('  SKIPPED: another seed run in progress');
    process.exit(0);
  }

  try {
    // Military flights — already classified upstream by seed-military-flights.mjs.
    const flightsRead = await readMilitaryFlights((key) => redisGetJson(url, token, key));
    if (!flightsRead.ok) {
      const reason = flightsRead.error
        ? `military:flights:v1 read failed (${flightsRead.error.message || flightsRead.error})`
        : 'military:flights:v1 read returned no flights';
      await preserveLastGoodMilitaryCii(url, token, reason);
      return;
    }
    const flights = flightsRead.flights;

    const relay = await fetchRelaySnapshot();
    console.log(`  inputs: ${flights.length} flights, ${relay.candidateReports.length} vessel candidates, ${relay.disruptions.length} AIS disruptions`);

    // Relay unavailable: do NOT overwrite last-good vessel/AIS data with zeros. Re-publish
    // the existing key (refreshing its TTL) so the CII engine keeps the last-good military
    // signal until the relay recovers; fall through to a flights-only publish only when
    // there is no prior key (cold start).
    if (!relay.ok) {
      console.warn(`  relay unavailable - preserving last-good complete military CII if present; ${flights.length} freshly read flights will not be published unless this is a cold start`);
      if (await preserveLastGoodMilitaryCii(url, token, 'relay unavailable (vessels/AIS not overwritten)', 'publishing flights-only')) return;
    }

    const { byCountry, militaryVesselCount } = aggregate(
      flights,
      relay.ok ? relay.candidateReports : [],
      relay.ok ? relay.disruptions : [],
    );

    const totals = Object.values(byCountry).reduce((acc, r) => {
      acc.ownFlights += r.ownFlights; acc.foreignFlights += r.foreignFlights;
      acc.ownVessels += r.ownVessels; acc.foreignVessels += r.foreignVessels;
      return acc;
    }, { ownFlights: 0, foreignFlights: 0, ownVessels: 0, foreignVessels: 0 });

    const payload = {
      assessedAt: Date.now(),
      byCountry,
      stats: {
        relayOk: relay.ok,
        flightsInput: flights.length,
        vesselCandidatesInput: relay.ok ? relay.candidateReports.length : 0,
        militaryVesselsClassified: militaryVesselCount,
        disruptionsInput: relay.ok ? relay.disruptions.length : 0,
        ...totals,
      },
    };

    await withRetry(() => redisSetJson(url, token, LIVE_KEY, payload, LIVE_TTL), 2, 1000);
    // Freshness record for health/seed monitoring — seed-meta:intelligence:military-cii.
    await writeFreshnessMetadata('intelligence', 'military-cii', Object.keys(byCountry).length, 'seed-military-cii', LIVE_TTL);
    console.log(`  wrote ${LIVE_KEY}: own ${totals.ownFlights}f/${totals.ownVessels}v, foreign ${totals.foreignFlights}f/${totals.foreignVessels}v across ${Object.keys(byCountry).length} countries`);
  } finally {
    await releaseLock('intelligence:military-cii', runId);
  }

  console.log(`=== Done (${Math.round(Date.now() - startMs)}ms) ===`);
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  main().catch((err) => {
    console.error(`FATAL: ${err?.stack || err}`);
    process.exit(1);
  });
}

export { aggregate, classifyVessel, analyzeMmsi, geoToCountry, normalizeCountryName, readMilitaryFlights, TIER1_COUNTRIES };
