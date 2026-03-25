#!/usr/bin/env node

/**
 * Seed conflict + intelligence data to Redis.
 *
 * Seedable (fixed/predictable inputs):
 * - listAcledEvents (all countries, last 30 days)
 * - getHumanitarianSummary (top conflict countries)
 * - getPizzintStatus (base + gdelt variants)
 *
 * NOT seeded (inherently on-demand, user-specific):
 * - classifyEvent: per-headline LLM classification (sha256 cache key)
 * - deductSituation: per-query LLM deduction
 * - getCountryIntelBrief: per-country LLM brief with context hash
 * - getCountryFacts: per-country REST Countries + Wikidata + Wikipedia
 * - searchGdeltDocuments: per-query GDELT search
 */

import { loadEnvFile, CHROME_UA, runSeed, writeExtraKeyWithMeta, sleep } from './_seed-utils.mjs';

loadEnvFile(import.meta.url);

const ACLED_CACHE_KEY = 'conflict:acled:v1:all:0:0';
const ACLED_TTL = 900;
const HAPI_CACHE_KEY_PREFIX = 'conflict:humanitarian:v1';
const HAPI_TTL = 21600;
const PIZZINT_TTL = 600;

// Top conflict countries (ISO2) for humanitarian pre-seeding
const CONFLICT_COUNTRIES = [
  'AF', 'SY', 'UA', 'SD', 'SS', 'SO', 'CD', 'MM', 'YE', 'ET',
  'IQ', 'PS', 'LY', 'ML', 'BF', 'NE', 'NG', 'CM', 'MZ', 'HT',
];

const ISO2_TO_ISO3 = {
  AF: 'AFG', SY: 'SYR', UA: 'UKR', SD: 'SDN', SS: 'SSD', SO: 'SOM',
  CD: 'COD', MM: 'MMR', YE: 'YEM', ET: 'ETH', IQ: 'IRQ', PS: 'PSE',
  LY: 'LBY', ML: 'MLI', BF: 'BFA', NE: 'NER', NG: 'NGA', CM: 'CMR',
  MZ: 'MOZ', HT: 'HTI',
};

// ─── ACLED Events ───

async function fetchAcledToken() {
  // Priority 1: ACLED_EMAIL + ACLED_PASSWORD -> OAuth flow (matches server/acled-auth.ts)
  const email = process.env.ACLED_EMAIL?.trim();
  const password = process.env.ACLED_PASSWORD?.trim();
  if (email && password) {
    const body = new URLSearchParams({
      username: email, password, grant_type: 'password', client_id: 'acled',
    });
    const resp = await fetch('https://acleddata.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': CHROME_UA },
      body,
      signal: AbortSignal.timeout(15_000),
    });
    if (!resp.ok) throw new Error(`ACLED OAuth failed: HTTP ${resp.status}`);
    const data = await resp.json();
    if (data.access_token) return data.access_token;
    throw new Error('ACLED OAuth response missing access_token');
  }

  // Priority 2: Static token fallback (legacy)
  const staticToken = process.env.ACLED_ACCESS_TOKEN?.trim();
  if (staticToken) return staticToken;

  return null;
}

async function fetchAcledEvents() {
  const token = await fetchAcledToken();
  if (!token) throw new Error('Missing ACLED credentials (ACLED_EMAIL+ACLED_PASSWORD or ACLED_ACCESS_TOKEN)');

  const now = Date.now();
  const startDate = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  const endDate = new Date(now).toISOString().split('T')[0];

  const params = new URLSearchParams({
    event_type: 'Battles|Explosions/Remote violence|Violence against civilians',
    event_date: `${startDate}|${endDate}`,
    event_date_where: 'BETWEEN',
    limit: '500',
    _format: 'json',
  });

  const resp = await fetch(`https://acleddata.com/api/acled/read?${params}`, {
    headers: { Accept: 'application/json', Authorization: `Bearer ${token}`, 'User-Agent': CHROME_UA },
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) throw new Error(`ACLED HTTP ${resp.status}`);
  const data = await resp.json();
  if (data.error || data.message) throw new Error(data.error || data.message);

  const rawEvents = data.data || [];
  const events = rawEvents
    .filter(e => {
      const lat = parseFloat(e.latitude || '');
      const lon = parseFloat(e.longitude || '');
      return Number.isFinite(lat) && Number.isFinite(lon) && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;
    })
    .map(e => ({
      id: `acled-${e.event_id_cnty}`,
      eventType: e.event_type || '',
      country: e.country || '',
      location: { latitude: parseFloat(e.latitude || '0'), longitude: parseFloat(e.longitude || '0') },
      occurredAt: new Date(e.event_date || '').getTime(),
      fatalities: parseInt(e.fatalities || '', 10) || 0,
      actors: [e.actor1, e.actor2].filter(Boolean),
      source: e.source || '',
      admin1: e.admin1 || '',
    }));

  console.log(`  ACLED: ${events.length} events (${startDate} to ${endDate})`);
  return { events, pagination: undefined };
}

// ─── Humanitarian Summary (HAPI) ───

async function fetchHapiSummary(countryCode) {
  const iso3 = ISO2_TO_ISO3[countryCode];
  if (!iso3) return null;

  const appId = Buffer.from('worldmonitor:monitor@worldmonitor.app').toString('base64');
  const url = `https://hapi.humdata.org/api/v2/coordination-context/conflict-events?output_format=json&limit=1000&offset=0&app_identifier=${appId}&location_code=${iso3}`;

  const resp = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': CHROME_UA },
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) return null;
  const rawData = await resp.json();
  const records = rawData.data || [];

  const agg = { eventsTotal: 0, eventsPV: 0, eventsCT: 0, eventsDem: 0, fatPV: 0, fatCT: 0, month: '', locationName: '' };
  for (const r of records) {
    if ((r.location_code || '') !== iso3) continue;
    const month = r.reference_period_start || '';
    const eventType = (r.event_type || '').toLowerCase();
    const events = r.events || 0;
    const fatalities = r.fatalities || 0;
    if (!agg.locationName) agg.locationName = r.location_name || '';
    if (month > agg.month) { agg.month = month; agg.eventsTotal = 0; agg.eventsPV = 0; agg.eventsCT = 0; agg.eventsDem = 0; agg.fatPV = 0; agg.fatCT = 0; }
    if (month === agg.month) {
      agg.eventsTotal += events;
      if (eventType.includes('political_violence')) { agg.eventsPV += events; agg.fatPV += fatalities; }
      if (eventType.includes('civilian_targeting')) { agg.eventsCT += events; agg.fatCT += fatalities; }
      if (eventType.includes('demonstration')) agg.eventsDem += events;
    }
  }
  if (!agg.month) return null;

  return {
    summary: {
      countryCode: countryCode.toUpperCase(),
      countryName: agg.locationName,
      conflictEventsTotal: agg.eventsTotal,
      conflictPoliticalViolenceEvents: agg.eventsPV + agg.eventsCT,
      conflictFatalities: agg.fatPV + agg.fatCT,
      referencePeriod: agg.month,
      conflictDemonstrations: agg.eventsDem,
      updatedAt: Date.now(),
    },
  };
}

async function fetchAllHumanitarianSummaries() {
  const results = {};
  for (const cc of CONFLICT_COUNTRIES) {
    try {
      const data = await fetchHapiSummary(cc);
      if (data?.summary) results[cc] = data;
      await sleep(300);
    } catch (e) {
      console.warn(`  HAPI ${cc}: ${e.message}`);
    }
  }
  console.log(`  Humanitarian: ${Object.keys(results).length}/${CONFLICT_COUNTRIES.length} countries`);
  return results;
}

// ─── PizzINT Status ───

async function fetchPizzintStatus() {
  const resp = await fetch('https://www.pizzint.watch/api/dashboard-data', {
    headers: { Accept: 'application/json', 'User-Agent': CHROME_UA },
    signal: AbortSignal.timeout(10_000),
  });
  if (!resp.ok) return null;
  const raw = await resp.json();
  if (!raw.success || !raw.data) return null;

  const locations = raw.data.map(d => ({
    placeId: d.place_id, name: d.name, address: d.address,
    currentPopularity: d.current_popularity,
    percentageOfUsual: d.percentage_of_usual ?? 0,
    isSpike: d.is_spike, spikeMagnitude: d.spike_magnitude ?? 0,
    dataSource: d.data_source, recordedAt: d.recorded_at,
    dataFreshness: d.data_freshness === 'fresh' ? 'DATA_FRESHNESS_FRESH' : 'DATA_FRESHNESS_STALE',
    isClosedNow: d.is_closed_now ?? false, lat: d.lat ?? 0, lng: d.lng ?? 0,
  }));

  const open = locations.filter(l => !l.isClosedNow);
  const spikes = locations.filter(l => l.isSpike).length;
  const avgPop = open.length > 0 ? open.reduce((s, l) => s + l.currentPopularity, 0) / open.length : 0;
  const adjusted = Math.min(100, avgPop + spikes * 10);
  let defconLevel = 5, defconLabel = 'Normal Activity';
  if (adjusted >= 85) { defconLevel = 1; defconLabel = 'Maximum Activity'; }
  else if (adjusted >= 70) { defconLevel = 2; defconLabel = 'High Activity'; }
  else if (adjusted >= 50) { defconLevel = 3; defconLabel = 'Elevated Activity'; }
  else if (adjusted >= 25) { defconLevel = 4; defconLabel = 'Above Normal'; }

  const hasFresh = locations.some(l => l.dataFreshness === 'DATA_FRESHNESS_FRESH');
  const pizzint = {
    defconLevel, defconLabel, aggregateActivity: Math.round(avgPop),
    activeSpikes: spikes, locationsMonitored: locations.length, locationsOpen: open.length,
    updatedAt: Date.now(),
    dataFreshness: hasFresh ? 'DATA_FRESHNESS_FRESH' : 'DATA_FRESHNESS_STALE',
    locations,
  };

  console.log(`  PizzINT: DEFCON ${defconLevel}, ${locations.length} locations, ${spikes} spikes`);
  return pizzint;
}

async function fetchGdeltTensions() {
  const pairs = 'usa_russia,russia_ukraine,usa_china,china_taiwan,usa_iran,usa_venezuela';
  const resp = await fetch(`https://www.pizzint.watch/api/gdelt/batch?pairs=${encodeURIComponent(pairs)}&method=gpr`, {
    headers: { Accept: 'application/json', 'User-Agent': CHROME_UA },
    signal: AbortSignal.timeout(10_000),
  });
  if (!resp.ok) return [];
  const raw = await resp.json();
  return Object.entries(raw).map(([pairKey, dataPoints]) => {
    const countries = pairKey.split('_');
    const latest = dataPoints[dataPoints.length - 1];
    const prev = dataPoints.length > 1 ? dataPoints[dataPoints.length - 2] : latest;
    const change = prev.v > 0 ? ((latest.v - prev.v) / prev.v) * 100 : 0;
    return {
      id: pairKey, countries, label: countries.map(c => c.toUpperCase()).join(' - '),
      score: latest?.v ?? 0,
      trend: change > 5 ? 'TREND_DIRECTION_RISING' : change < -5 ? 'TREND_DIRECTION_FALLING' : 'TREND_DIRECTION_STABLE',
      changePercent: Math.round(change * 10) / 10, region: 'global',
    };
  });
}

// ─── Main ───

async function fetchAll() {
  const [acled, hapi, pizzint, gdelt] = await Promise.allSettled([
    fetchAcledEvents(),
    fetchAllHumanitarianSummaries(),
    fetchPizzintStatus(),
    fetchGdeltTensions(),
  ]);

  const ac = acled.status === 'fulfilled' ? acled.value : null;
  const ha = hapi.status === 'fulfilled' ? hapi.value : null;
  const pi = pizzint.status === 'fulfilled' ? pizzint.value : null;
  const gd = gdelt.status === 'fulfilled' ? gdelt.value : null;

  if (acled.status === 'rejected') console.warn(`  ACLED failed: ${acled.reason?.message || acled.reason}`);
  if (hapi.status === 'rejected') console.warn(`  HAPI failed: ${hapi.reason?.message || hapi.reason}`);
  if (pizzint.status === 'rejected') console.warn(`  PizzINT failed: ${pizzint.reason?.message || pizzint.reason}`);
  if (gdelt.status === 'rejected') console.warn(`  GDELT failed: ${gdelt.reason?.message || gdelt.reason}`);

  if (!ac && !ha && !pi) throw new Error('All conflict/intel fetches failed');

  // Write secondary keys BEFORE returning (runSeed calls process.exit after primary write)
  if (ha) { for (const [cc, data] of Object.entries(ha)) await writeExtraKeyWithMeta(`${HAPI_CACHE_KEY_PREFIX}:${cc}`, data, HAPI_TTL, 1); }
  if (pi) await writeExtraKeyWithMeta('intel:pizzint:v1:base', { pizzint: pi, tensionPairs: [] }, PIZZINT_TTL, pi.locationsMonitored ?? 0);
  if (pi && gd) await writeExtraKeyWithMeta('intel:pizzint:v1:gdelt', { pizzint: pi, tensionPairs: gd }, PIZZINT_TTL, gd.length ?? 0);

  return ac || { events: [], pagination: undefined };
}

function validate(data) {
  return data != null && Array.isArray(data.events);
}

runSeed('conflict', 'acled-intel', ACLED_CACHE_KEY, fetchAll, {
  validateFn: validate,
  ttlSeconds: ACLED_TTL,
  sourceVersion: 'acled-hapi-pizzint',
}).catch((err) => {
  const _cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : ''; console.error('FATAL:', (err.message || err) + _cause);
  process.exit(1);
});
