#!/usr/bin/env node

/**
 * Seed aviation data to Redis for the 3 seedable aviation endpoints:
 * - getAirportOpsSummary (AviationStack delays + NOTAM closures)
 * - getCarrierOps (derived from airport flights)
 * - listAviationNews (RSS feeds)
 *
 * NOT seeded (inherently on-demand, user-specific inputs):
 * - getFlightStatus (specific flight number lookup)
 * - trackAircraft (bounding-box or icao24 lookup)
 * - listAirportFlights (arbitrary airport + direction + limit combos)
 */

import { loadEnvFile, CHROME_UA, runSeed, writeExtraKeyWithMeta, sleep } from './_seed-utils.mjs';
import { unwrapEnvelope } from './_seed-envelope-source.mjs';

loadEnvFile(import.meta.url);

const DEFAULT_AIRPORTS = ['IST', 'ESB', 'SAW', 'LHR', 'FRA', 'CDG'];
const OPS_CACHE_KEY = `aviation:ops-summary:v1:${[...DEFAULT_AIRPORTS].sort().join(',')}`;
const NEWS_CACHE_KEY = 'aviation:news::24:v1'; // empty entities, 24h window
const OPS_TTL = 2400;
const NEWS_TTL = 2400;

const AVIATIONSTACK_URL = 'https://api.aviationstack.com/v1/flights';

// ─── Airport Ops Summary (AviationStack + NOTAM) ───

async function fetchAviationStackFlights(airports) {
  const apiKey = process.env.AVIATIONSTACK_API;
  if (!apiKey) return { alerts: [], healthy: false };

  const alerts = [];
  for (const iata of airports) {
    try {
      const params = new URLSearchParams({
        access_key: apiKey, dep_iata: iata, limit: '100',
      });
      const resp = await fetch(`${AVIATIONSTACK_URL}?${params}`, {
        headers: { 'User-Agent': CHROME_UA },
        signal: AbortSignal.timeout(10_000),
      });
      if (!resp.ok) { console.warn(`  AviationStack ${iata}: HTTP ${resp.status}`); continue; }
      const json = await resp.json();
      if (json.error) { console.warn(`  AviationStack ${iata}: ${json.error.message}`); continue; }
      const flights = json.data || [];
      const total = flights.length;
      const delayed = flights.filter(f => (f.departure?.delay ?? 0) > 0);
      const cancelled = flights.filter(f => f.flight_status === 'cancelled');
      const totalDelay = delayed.reduce((s, f) => s + (f.departure?.delay ?? 0), 0);

      alerts.push({
        iata,
        totalFlights: total,
        delayedFlightsPct: total > 0 ? Math.round((delayed.length / total) * 1000) / 10 : 0,
        avgDelayMinutes: delayed.length > 0 ? Math.round(totalDelay / delayed.length) : 0,
        cancelledFlights: cancelled.length,
        reason: delayed.length > 3 ? 'Multiple delays reported' : '',
      });
      await sleep(300); // rate limit
    } catch (e) {
      console.warn(`  AviationStack ${iata}: ${e.message}`);
    }
  }
  return { alerts, healthy: alerts.length > 0 };
}

async function fetchNotamClosures() {
  try {
    const { url, token } = getRedisCredentialsFromEnv();
    const resp = await fetch(`${url}/get/${encodeURIComponent('aviation:notam:closures:v2')}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5_000),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    return data.result ? unwrapEnvelope(JSON.parse(data.result)).data : null;
  } catch {
    return null;
  }
}

function getRedisCredentialsFromEnv() {
  return {
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
  };
}

function determineSeverity(avgDelay, delayPct) {
  if (avgDelay > 90 || delayPct > 50) return 'severe';
  if (avgDelay > 60 || delayPct > 35) return 'major';
  if (avgDelay > 30 || delayPct > 20) return 'moderate';
  if (avgDelay > 15 || delayPct > 10) return 'minor';
  return 'normal';
}

function severityFromCancelRate(rate) {
  if (rate > 20) return 'severe';
  if (rate > 10) return 'major';
  if (rate > 5) return 'moderate';
  if (rate > 2) return 'minor';
  return 'normal';
}

async function fetchAirportOpsSummary() {
  const now = Date.now();
  const avResult = await fetchAviationStackFlights(DEFAULT_AIRPORTS);

  let notamClosedIcaos = new Set();
  let notamRestrictedIcaos = new Set();
  let notamReasons = {};
  const notamData = await fetchNotamClosures();
  if (notamData) {
    notamClosedIcaos = new Set(notamData.closedIcaos || []);
    notamRestrictedIcaos = new Set(notamData.restrictedIcaos || []);
    notamReasons = notamData.reasons || {};
  }

  // We don't have full MONITORED_AIRPORTS config here, build minimal map
  const ICAO_MAP = { IST: 'LTFM', ESB: 'LTAC', SAW: 'LTFJ', LHR: 'EGLL', FRA: 'EDDF', CDG: 'LFPG' };
  const NAME_MAP = { IST: 'Istanbul Airport', ESB: 'Esenboga', SAW: 'Sabiha Gokcen', LHR: 'Heathrow', FRA: 'Frankfurt', CDG: 'Charles de Gaulle' };

  const summaries = [];
  for (const iata of DEFAULT_AIRPORTS) {
    const icao = ICAO_MAP[iata] || '';
    const alert = avResult.alerts.find(a => a.iata === iata);
    const isClosed = notamClosedIcaos.has(icao);
    const isRestricted = notamRestrictedIcaos.has(icao);
    const notamText = notamReasons[icao];

    const delayPct = alert?.delayedFlightsPct ?? 0;
    const avgDelay = alert?.avgDelayMinutes ?? 0;
    const cancelledFlights = alert?.cancelledFlights ?? 0;
    const totalFlights = alert?.totalFlights ?? 0;
    const cancelRate = totalFlights > 0 ? (cancelledFlights / totalFlights) * 100 : 0;

    const cancelSev = severityFromCancelRate(cancelRate);
    const delaySev = determineSeverity(avgDelay, delayPct);
    const notamFloor = isClosed ? (totalFlights === 0 ? 'severe' : 'moderate') : isRestricted ? 'minor' : 'normal';
    const sevOrder = ['normal', 'minor', 'moderate', 'major', 'severe'];
    const sevStr = sevOrder[Math.max(sevOrder.indexOf(cancelSev), sevOrder.indexOf(delaySev), sevOrder.indexOf(notamFloor))] ?? 'normal';

    const notamFlags = [];
    if (isClosed) notamFlags.push('CLOSED');
    if (isRestricted) notamFlags.push('RESTRICTED');
    if (notamText) notamFlags.push('NOTAM');

    const topDelayReasons = [];
    if (alert?.reason) topDelayReasons.push(alert.reason);
    if ((isClosed || isRestricted) && notamText) topDelayReasons.push(notamText.slice(0, 80));

    summaries.push({
      iata, icao, name: NAME_MAP[iata] || iata, timezone: 'UTC',
      delayPct, avgDelayMinutes: avgDelay,
      cancellationRate: Math.round(cancelRate * 10) / 10,
      totalFlights, closureStatus: isClosed, notamFlags,
      severity: `FLIGHT_DELAY_SEVERITY_${sevStr.toUpperCase()}`,
      topDelayReasons,
      source: avResult.healthy ? 'aviationstack' : 'degraded',
      updatedAt: now,
    });
  }
  console.log(`  Airport ops: ${summaries.length} airports, ${avResult.alerts.length} with live data`);
  return { summaries };
}

// ─── Aviation News (RSS) ───

const AVIATION_RSS_FEEDS = [
  { url: 'https://www.flightglobal.com/rss', name: 'FlightGlobal' },
  { url: 'https://simpleflying.com/feed/', name: 'Simple Flying' },
  { url: 'https://aerotime.aero/feed', name: 'AeroTime' },
  { url: 'https://thepointsguy.com/feed/', name: 'The Points Guy' },
  { url: 'https://airlinegeeks.com/feed/', name: 'Airline Geeks' },
  { url: 'https://onemileatatime.com/feed/', name: 'One Mile at a Time' },
  { url: 'https://viewfromthewing.com/feed/', name: 'View from the Wing' },
  { url: 'https://www.aviationpros.com/rss', name: 'Aviation Pros' },
  { url: 'https://www.aviationweek.com/rss', name: 'Aviation Week' },
];

function parseRssItems(xml, sourceName) {
  try {
    // Lightweight XML parse for RSS items
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

async function fetchAviationNews() {
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

  const items = allItems
    .map((item) => {
      let publishedAt = 0;
      if (item.pubDate) try { publishedAt = new Date(item.pubDate).getTime(); } catch { /* skip */ }
      if (publishedAt && publishedAt < cutoff) return null;
      const snippet = (item.description || '').replace(/<[^>]+>/g, '').slice(0, 200);
      return {
        id: Buffer.from(item.link).toString('base64').slice(0, 32),
        title: item.title, url: item.link, sourceName: item._source,
        publishedAt: publishedAt || now, snippet,
        matchedEntities: [], imageUrl: '',
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.publishedAt - a.publishedAt);

  console.log(`  Aviation news: ${items.length} articles from ${AVIATION_RSS_FEEDS.length} feeds`);
  return { items };
}

// ─── Main ───

async function fetchAll() {
  const [ops, news] = await Promise.allSettled([
    fetchAirportOpsSummary(),
    fetchAviationNews(),
  ]);

  const opsData = ops.status === 'fulfilled' ? ops.value : null;
  const newsData = news.status === 'fulfilled' ? news.value : null;

  if (ops.status === 'rejected') console.warn(`  AirportOps failed: ${ops.reason?.message || ops.reason}`);
  if (news.status === 'rejected') console.warn(`  AviationNews failed: ${news.reason?.message || news.reason}`);

  if (!opsData && !newsData) throw new Error('All aviation fetches failed');

  // Write secondary keys BEFORE returning (runSeed calls process.exit after primary write)
  if (newsData?.items?.length > 0) await writeExtraKeyWithMeta(NEWS_CACHE_KEY, newsData, NEWS_TTL, newsData.items.length);

  return opsData || { summaries: [] };
}

function validate(data) {
  return data?.summaries?.length > 0;
}

export function declareRecords(data) {
  return data?.summaries?.length ?? 0;
}

runSeed('aviation', 'ops-news', OPS_CACHE_KEY, fetchAll, {
  validateFn: validate,
  ttlSeconds: OPS_TTL,
  sourceVersion: 'aviationstack-rss',
  declareRecords,
  schemaVersion: 1,
  maxStaleMin: 150,
}).catch((err) => {
  const _cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : ''; console.error('FATAL:', (err.message || err) + _cause);
  process.exit(1);
});
