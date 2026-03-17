#!/usr/bin/env node

import { loadEnvFile, CHROME_UA, getRedisCredentials, acquireLockSafely, releaseLock, withRetry, writeFreshnessMetadata, logSeedResult, verifySeedKey, extendExistingTtl } from './_seed-utils.mjs';

loadEnvFile(import.meta.url);

const FAA_CACHE_KEY = 'aviation:delays:faa:v1';
const NOTAM_CACHE_KEY = 'aviation:notam:closures:v2';
const CACHE_TTL = 7200;

const FAA_URL = 'https://nasstatus.faa.gov/api/airport-status-information';
const ICAO_NOTAM_URL = 'https://dataservices.icao.int/api/notams-realtime-list';

const NOTAM_CLOSURE_QCODES = new Set(['FA', 'AH', 'AL', 'AW', 'AC', 'AM']);

const FAA_AIRPORTS = [
  'ATL', 'ORD', 'DFW', 'DEN', 'LAX', 'JFK', 'SFO', 'SEA', 'LAS', 'MCO',
  'EWR', 'CLT', 'PHX', 'IAH', 'MIA', 'BOS', 'MSP', 'DTW', 'FLL', 'PHL',
  'LGA', 'BWI', 'SLC', 'SAN', 'IAD', 'DCA', 'MDW', 'TPA', 'HNL', 'PDX',
];

const MONITORED_AIRPORTS_ICAO = [
  // MENA
  'OEJN', 'OERK', 'OEMA', 'OEDF', 'OMDB', 'OMAA', 'OMSJ',
  'OTHH', 'OBBI', 'OOMS', 'OKBK', 'OLBA', 'OJAI', 'OSDI',
  'ORBI', 'OIIE', 'OISS', 'OIMM', 'OIKB', 'HECA', 'GMMN',
  'DTTA', 'DAAG', 'HLLT',
  // Europe
  'EGLL', 'LFPG', 'EDDF', 'EHAM', 'LEMD', 'LIRF', 'LTFM',
  'LSZH', 'LOWW', 'EKCH', 'ENGM', 'ESSA', 'EFHK', 'EPWA',
  // Americas
  'KJFK', 'KLAX', 'KORD', 'KATL', 'KDFW', 'KDEN', 'KSFO',
  'CYYZ', 'MMMX', 'SBGR', 'SCEL', 'SKBO',
  // APAC
  'RJTT', 'RKSI', 'VHHH', 'WSSS', 'VTBS', 'VIDP', 'YSSY',
  'ZBAA', 'ZPPP', 'WMKK',
  // Africa
  'FAOR', 'DNMM', 'HKJK', 'GABS',
];

function parseDelayTypeFromReason(reason) {
  const r = reason.toLowerCase();
  if (r.includes('ground stop')) return 'ground_stop';
  if (r.includes('ground delay') || r.includes('gdp')) return 'ground_delay';
  if (r.includes('departure')) return 'departure_delay';
  if (r.includes('arrival')) return 'arrival_delay';
  if (r.includes('clos')) return 'ground_stop';
  return 'general';
}

function parseFaaXml(text) {
  const delays = new Map();
  const parseTag = (xml, tag) => {
    const re = new RegExp(`<${tag}>(.*?)</${tag}>`, 'gs');
    const matches = [];
    let m;
    while ((m = re.exec(xml))) matches.push(m[1]);
    return matches;
  };
  const getVal = (block, tag) => {
    const m = block.match(new RegExp(`<${tag}>(.*?)</${tag}>`));
    return m ? m[1].trim() : '';
  };

  for (const gd of parseTag(text, 'Ground_Delay')) {
    const arpt = getVal(gd, 'ARPT');
    if (arpt) {
      delays.set(arpt, {
        airport: arpt,
        reason: getVal(gd, 'Reason') || 'Ground delay',
        avgDelay: parseInt(getVal(gd, 'Avg') || '30', 10),
        type: 'ground_delay',
      });
    }
  }

  for (const gs of parseTag(text, 'Ground_Stop')) {
    const arpt = getVal(gs, 'ARPT');
    if (arpt) {
      delays.set(arpt, {
        airport: arpt,
        reason: getVal(gs, 'Reason') || 'Ground stop',
        avgDelay: 60,
        type: 'ground_stop',
      });
    }
  }

  for (const d of parseTag(text, 'Delay')) {
    const arpt = getVal(d, 'ARPT');
    if (arpt) {
      const existing = delays.get(arpt);
      if (!existing || existing.type !== 'ground_stop') {
        const min = parseInt(getVal(d, 'Min') || '15', 10);
        const max = parseInt(getVal(d, 'Max') || '30', 10);
        delays.set(arpt, {
          airport: arpt,
          reason: getVal(d, 'Reason') || 'Delays',
          avgDelay: Math.round((min + max) / 2),
          type: parseDelayTypeFromReason(getVal(d, 'Reason') || ''),
        });
      }
    }
  }

  for (const ac of parseTag(text, 'Airport')) {
    const arpt = getVal(ac, 'ARPT');
    if (arpt && FAA_AIRPORTS.includes(arpt)) {
      delays.set(arpt, {
        airport: arpt,
        reason: 'Airport closure',
        avgDelay: 120,
        type: 'ground_stop',
      });
    }
  }

  return delays;
}

function determineSeverity(avgDelay) {
  if (avgDelay >= 90) return 'severe';
  if (avgDelay >= 60) return 'major';
  if (avgDelay >= 30) return 'moderate';
  if (avgDelay >= 15) return 'minor';
  return 'normal';
}

async function redisSet(url, token, key, value, ttl) {
  const payload = JSON.stringify(value);
  const cmd = ttl ? ['SET', key, payload, 'EX', ttl] : ['SET', key, payload];
  const resp = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd),
    signal: AbortSignal.timeout(10_000),
  });
  if (!resp.ok) throw new Error(`Redis SET ${key} failed: HTTP ${resp.status}`);
}

async function seedFaaDelays() {
  console.log('[FAA] Fetching airport status...');
  const resp = await fetch(FAA_URL, {
    headers: { Accept: 'application/xml', 'User-Agent': CHROME_UA },
    signal: AbortSignal.timeout(15_000),
  });

  if (!resp.ok) {
    throw new Error(`FAA HTTP ${resp.status}`);
  }

  const xml = await resp.text();
  const faaDelays = parseFaaXml(xml);
  const alerts = [];

  for (const iata of FAA_AIRPORTS) {
    const delay = faaDelays.get(iata);
    if (delay) {
      alerts.push({
        id: `faa-${iata}`,
        iata,
        icao: '',
        name: iata,
        city: '',
        country: 'USA',
        location: { latitude: 0, longitude: 0 },
        region: 'AIRPORT_REGION_AMERICAS',
        delayType: `FLIGHT_DELAY_TYPE_${delay.type.toUpperCase()}`,
        severity: `FLIGHT_DELAY_SEVERITY_${determineSeverity(delay.avgDelay).toUpperCase()}`,
        avgDelayMinutes: delay.avgDelay,
        delayedFlightsPct: 0,
        cancelledFlights: 0,
        totalFlights: 0,
        reason: delay.reason,
        source: 'FLIGHT_DELAY_SOURCE_FAA',
        updatedAt: Date.now(),
      });
    }
  }

  console.log(`[FAA] ${alerts.length} alerts found`);
  return { alerts };
}

async function seedNotamClosures() {
  const apiKey = process.env.ICAO_API_KEY;
  if (!apiKey) {
    console.log('[NOTAM] No ICAO_API_KEY — skipping');
    return null;
  }

  console.log(`[NOTAM] Fetching closures for ${MONITORED_AIRPORTS_ICAO.length} monitored airports...`);
  const locations = MONITORED_AIRPORTS_ICAO.join(',');
  const now = Math.floor(Date.now() / 1000);

  let notams = [];
  try {
    // ICAO API only supports key via query param (no header auth)
    const url = `${ICAO_NOTAM_URL}?api_key=${apiKey}&format=json&locations=${locations}`;
    const resp = await fetch(url, {
      headers: { 'User-Agent': CHROME_UA },
      signal: AbortSignal.timeout(30_000),
    });
    if (!resp.ok) {
      console.warn(`[NOTAM] HTTP ${resp.status}`);
      return null;
    }
    const contentType = resp.headers.get('content-type') || '';
    if (contentType.includes('text/html')) {
      console.warn('[NOTAM] Got HTML instead of JSON');
      return null;
    }
    const data = await resp.json();
    if (Array.isArray(data)) notams = data;
  } catch (err) {
    console.warn(`[NOTAM] Fetch error: ${err.message}`);
    return null;
  }

  console.log(`[NOTAM] ${notams.length} raw NOTAMs received`);

  const closedSet = new Set();
  const reasons = {};

  for (const n of notams) {
    const icao = n.itema || n.location || '';
    if (!icao || !MONITORED_AIRPORTS_ICAO.includes(icao)) continue;
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

  if (closedIcaos.length > 0) {
    console.log(`[NOTAM] Closures: ${closedIcaos.join(', ')}`);
  } else {
    console.log('[NOTAM] No closures found');
  }

  return { closedIcaos, reasons };
}

async function main() {
  const startMs = Date.now();
  const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const { url, token } = getRedisCredentials();

  console.log('=== aviation:delays Seed ===');

  const lockResult = await acquireLockSafely('aviation:delays', runId, 120_000, { label: 'aviation:delays' });
  if (lockResult.skipped) {
    process.exit(0);
  }
  if (!lockResult.locked) {
    console.log('  SKIPPED: another seed run in progress');
    process.exit(0);
  }

  let faaData, notamData;
  try {
    faaData = await withRetry(seedFaaDelays);
    notamData = await seedNotamClosures();
  } catch (err) {
    await releaseLock('aviation:delays', runId);
    console.error(`  FETCH FAILED: ${err.message || err}`);
    await extendExistingTtl([FAA_CACHE_KEY, NOTAM_CACHE_KEY, 'seed-meta:aviation:delays'], CACHE_TTL);
    console.log(`\n=== Failed gracefully (${Math.round(Date.now() - startMs)}ms) ===`);
    process.exit(0);
  }

  try {
    await redisSet(url, token, FAA_CACHE_KEY, faaData, CACHE_TTL);
    console.log(`  ${FAA_CACHE_KEY}: written`);
    await writeFreshnessMetadata('aviation', 'faa', faaData.alerts.length, 'faa-asws');

    const verified1 = await verifySeedKey(FAA_CACHE_KEY);
    console.log(`  FAA verified: ${verified1 ? 'yes' : 'NO'}`);

    let notamCount = 0;
    if (notamData) {
      await redisSet(url, token, NOTAM_CACHE_KEY, notamData, CACHE_TTL);
      console.log(`  ${NOTAM_CACHE_KEY}: written`);
      notamCount = notamData.closedIcaos.length;
      await writeFreshnessMetadata('aviation', 'notam', notamCount, 'icao-notam');

      const verified2 = await verifySeedKey(NOTAM_CACHE_KEY);
      console.log(`  NOTAM verified: ${verified2 ? 'yes' : 'NO'}`);
    }

    const durationMs = Date.now() - startMs;
    logSeedResult('aviation', faaData.alerts.length + notamCount, durationMs);
    console.log(`\n=== Done (${Math.round(durationMs)}ms) ===`);
  } finally {
    await releaseLock('aviation:delays', runId);
  }
}

main().catch((err) => {
  console.error(`PUBLISH FAILED: ${err.message || err}`);
  process.exit(1);
});
