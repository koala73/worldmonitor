#!/usr/bin/env node

import { loadEnvFile, CHROME_UA, runSeed } from './_seed-utils.mjs';

loadEnvFile(import.meta.url);

const GDELT_GEO_URL = 'https://api.gdeltproject.org/api/v2/geo/geo';
const ACLED_API_URL = 'https://acleddata.com/api/acled/read';
const CANONICAL_KEY = 'unrest:events:v1';
const CACHE_TTL = 3600;

// ---------- ACLED Event Type Mapping (from _shared.ts) ----------

function mapAcledEventType(eventType, subEventType) {
  const lower = (eventType + ' ' + subEventType).toLowerCase();
  if (lower.includes('riot') || lower.includes('mob violence')) return 'UNREST_EVENT_TYPE_RIOT';
  if (lower.includes('strike')) return 'UNREST_EVENT_TYPE_STRIKE';
  if (lower.includes('demonstration')) return 'UNREST_EVENT_TYPE_DEMONSTRATION';
  if (lower.includes('protest')) return 'UNREST_EVENT_TYPE_PROTEST';
  return 'UNREST_EVENT_TYPE_CIVIL_UNREST';
}

// ---------- Severity Classification (from _shared.ts) ----------

function classifySeverity(fatalities, eventType) {
  if (fatalities > 0 || eventType.toLowerCase().includes('riot')) return 'SEVERITY_LEVEL_HIGH';
  if (eventType.toLowerCase().includes('protest')) return 'SEVERITY_LEVEL_MEDIUM';
  return 'SEVERITY_LEVEL_LOW';
}

function classifyGdeltSeverity(count, name) {
  const lowerName = name.toLowerCase();
  if (count > 100 || lowerName.includes('riot') || lowerName.includes('clash')) return 'SEVERITY_LEVEL_HIGH';
  if (count < 25) return 'SEVERITY_LEVEL_LOW';
  return 'SEVERITY_LEVEL_MEDIUM';
}

function classifyGdeltEventType(name) {
  const lowerName = name.toLowerCase();
  if (lowerName.includes('riot')) return 'UNREST_EVENT_TYPE_RIOT';
  if (lowerName.includes('strike')) return 'UNREST_EVENT_TYPE_STRIKE';
  if (lowerName.includes('demonstration')) return 'UNREST_EVENT_TYPE_DEMONSTRATION';
  return 'UNREST_EVENT_TYPE_PROTEST';
}

// ---------- Deduplication (from _shared.ts) ----------

function deduplicateEvents(events) {
  const unique = new Map();
  for (const event of events) {
    const lat = event.location?.latitude ?? 0;
    const lon = event.location?.longitude ?? 0;
    const latKey = Math.round(lat * 10) / 10;
    const lonKey = Math.round(lon * 10) / 10;
    const dateKey = new Date(event.occurredAt).toISOString().split('T')[0];
    const key = `${latKey}:${lonKey}:${dateKey}`;

    const existing = unique.get(key);
    if (!existing) {
      unique.set(key, event);
    } else if (event.sourceType === 'UNREST_SOURCE_TYPE_ACLED' && existing.sourceType !== 'UNREST_SOURCE_TYPE_ACLED') {
      event.sources = [...new Set([...event.sources, ...existing.sources])];
      unique.set(key, event);
    } else if (existing.sourceType === 'UNREST_SOURCE_TYPE_ACLED') {
      existing.sources = [...new Set([...existing.sources, ...event.sources])];
    } else {
      existing.sources = [...new Set([...existing.sources, ...event.sources])];
      if (existing.sources.length >= 2) existing.confidence = 'CONFIDENCE_LEVEL_HIGH';
    }
  }
  return Array.from(unique.values());
}

// ---------- Sort (from _shared.ts) ----------

function sortBySeverityAndRecency(events) {
  const severityOrder = {
    SEVERITY_LEVEL_HIGH: 0,
    SEVERITY_LEVEL_MEDIUM: 1,
    SEVERITY_LEVEL_LOW: 2,
    SEVERITY_LEVEL_UNSPECIFIED: 3,
  };
  return events.sort((a, b) => {
    const sevDiff = (severityOrder[a.severity] ?? 3) - (severityOrder[b.severity] ?? 3);
    if (sevDiff !== 0) return sevDiff;
    return b.occurredAt - a.occurredAt;
  });
}

// ---------- ACLED Fetch ----------

async function fetchAcledProtests() {
  const token = process.env.ACLED_ACCESS_TOKEN;
  if (!token) {
    console.warn('  ACLED_ACCESS_TOKEN not set, skipping ACLED');
    return [];
  }

  const now = Date.now();
  const startDate = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  const endDate = new Date(now).toISOString().split('T')[0];

  const params = new URLSearchParams({
    event_type: 'Protests',
    event_date: `${startDate}|${endDate}`,
    event_date_where: 'BETWEEN',
    limit: '500',
    _format: 'json',
  });

  const resp = await fetch(`${ACLED_API_URL}?${params}`, {
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
      'User-Agent': CHROME_UA,
    },
    signal: AbortSignal.timeout(15_000),
  });

  if (!resp.ok) throw new Error(`ACLED API error: ${resp.status}`);
  const data = await resp.json();
  if (data.message || data.error) throw new Error(data.message || data.error || 'ACLED API error');

  const rawEvents = data.data || [];
  console.log(`  ACLED: ${rawEvents.length} raw events`);

  return rawEvents
    .filter((e) => {
      const lat = parseFloat(e.latitude || '');
      const lon = parseFloat(e.longitude || '');
      return Number.isFinite(lat) && Number.isFinite(lon) && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;
    })
    .map((e) => {
      const fatalities = parseInt(e.fatalities || '', 10) || 0;
      return {
        id: `acled-${e.event_id_cnty}`,
        title: e.notes?.slice(0, 200) || `${e.sub_event_type} in ${e.location}`,
        summary: typeof e.notes === 'string' ? e.notes.substring(0, 500) : '',
        eventType: mapAcledEventType(e.event_type || '', e.sub_event_type || ''),
        city: e.location || '',
        country: e.country || '',
        region: e.admin1 || '',
        location: {
          latitude: parseFloat(e.latitude || '0'),
          longitude: parseFloat(e.longitude || '0'),
        },
        occurredAt: new Date(e.event_date || '').getTime(),
        severity: classifySeverity(fatalities, e.event_type || ''),
        fatalities,
        sources: [e.source].filter(Boolean),
        sourceType: 'UNREST_SOURCE_TYPE_ACLED',
        tags: e.tags?.split(';').map((t) => t.trim()).filter(Boolean) ?? [],
        actors: [e.actor1, e.actor2].filter(Boolean),
        confidence: 'CONFIDENCE_LEVEL_HIGH',
      };
    });
}

// ---------- GDELT Fetch ----------

async function fetchGdeltEvents() {
  const params = new URLSearchParams({
    query: 'protest',
    format: 'geojson',
    maxrecords: '250',
    timespan: '7d',
  });

  const resp = await fetch(`${GDELT_GEO_URL}?${params}`, {
    headers: { Accept: 'application/json', 'User-Agent': CHROME_UA },
    signal: AbortSignal.timeout(10_000),
  });

  if (!resp.ok) throw new Error(`GDELT API error: ${resp.status}`);

  const data = await resp.json();
  const features = data?.features || [];
  const seenLocations = new Set();
  const events = [];

  for (const feature of features) {
    const name = feature.properties?.name || '';
    if (!name || seenLocations.has(name)) continue;

    const count = feature.properties?.count || 1;
    if (count < 5) continue;

    const coords = feature.geometry?.coordinates;
    if (!Array.isArray(coords) || coords.length < 2) continue;

    const [lon, lat] = coords;
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) continue;

    seenLocations.add(name);
    const country = name.split(',').pop()?.trim() || name;

    events.push({
      id: `gdelt-${lat.toFixed(2)}-${lon.toFixed(2)}-${Date.now()}`,
      title: `${name} (${count} reports)`,
      summary: '',
      eventType: classifyGdeltEventType(name),
      city: name.split(',')[0]?.trim() || '',
      country,
      region: '',
      location: { latitude: lat, longitude: lon },
      occurredAt: Date.now(),
      severity: classifyGdeltSeverity(count, name),
      fatalities: 0,
      sources: ['GDELT'],
      sourceType: 'UNREST_SOURCE_TYPE_GDELT',
      tags: [],
      actors: [],
      confidence: count > 20 ? 'CONFIDENCE_LEVEL_HIGH' : 'CONFIDENCE_LEVEL_MEDIUM',
    });
  }

  console.log(`  GDELT: ${events.length} events`);
  return events;
}

// ---------- Main Fetch ----------

async function fetchUnrestEvents() {
  const results = await Promise.allSettled([fetchAcledProtests(), fetchGdeltEvents()]);

  const acledEvents = results[0].status === 'fulfilled' ? results[0].value : [];
  const gdeltEvents = results[1].status === 'fulfilled' ? results[1].value : [];

  if (results[0].status === 'rejected') console.warn(`  ACLED failed: ${results[0].reason?.message || results[0].reason}`);
  if (results[1].status === 'rejected') console.warn(`  GDELT failed: ${results[1].reason?.message || results[1].reason}`);

  const merged = deduplicateEvents([...acledEvents, ...gdeltEvents]);
  const sorted = sortBySeverityAndRecency(merged);

  console.log(`  Merged: ${acledEvents.length} ACLED + ${gdeltEvents.length} GDELT = ${sorted.length} deduplicated`);

  return { events: sorted, clusters: [], pagination: undefined };
}

function validate(data) {
  return Array.isArray(data?.events) && data.events.length >= 1;
}

runSeed('unrest', 'events', CANONICAL_KEY, fetchUnrestEvents, {
  validateFn: validate,
  ttlSeconds: CACHE_TTL,
  sourceVersion: 'acled+gdelt',
}).catch((err) => {
  console.error('FATAL:', err.message || err);
  process.exit(1);
});
