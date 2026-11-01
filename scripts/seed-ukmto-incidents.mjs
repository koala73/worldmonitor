#!/usr/bin/env node
import { loadEnvFile, CHROME_UA, runSeed } from './_seed-utils.mjs';
import { getOptionalUpstashCreds, upstashCommand } from './_upstash-rest.mjs';
import { isMainModule } from './lib/main-module.mjs';

// UKMTO's own JSON backend (sccd.royalnavy.mod.uk) blocks automated clients at Cloudflare.
// hormuz.data-tracking.net republishes the same reports through a documented public API:
// UKMTO reports stay under the Open Government Licence, the republished table under CC BY 4.0.
// It refreshes every 30 minutes and asks that clients do not poll faster.
const SOURCE_URL = 'https://hormuz.data-tracking.net/api/incidents';
const REQUIRED_COLUMNS = ['id', 'type', 'lat', 'lon', 'ts', 'place', 'text'];
export const canonicalKey = 'maritime:ukmto-incidents:v1';

// The table stores each text cell as an index into a shared string list `s`; `k` names those columns.
function decodeRows(value) {
  const table = value?.t;
  if (!value || typeof value !== 'object' || value.v !== 1 || !table || !Array.isArray(table.c) || !Array.isArray(table.k)
    || !Array.isArray(table.r) || !Array.isArray(value.s) || table.r.length > 2000) throw new Error('Invalid UKMTO snapshot');
  const column = Object.fromEntries(table.c.map((name, index) => [name, index]));
  if (!REQUIRED_COLUMNS.every(name => Number.isInteger(column[name]))) throw new Error('Invalid UKMTO snapshot columns');
  const textColumns = new Set(table.k);
  return table.r.map(row => {
    if (!Array.isArray(row) || row.length !== table.c.length) throw new Error('Invalid UKMTO incident');
    return Object.fromEntries(REQUIRED_COLUMNS.map(name => {
      const cell = row[column[name]];
      if (!textColumns.has(column[name])) return [name, cell];
      if (!Number.isInteger(cell) || cell < 0 || cell >= value.s.length) throw new Error('Invalid UKMTO string reference');
      return [name, value.s[cell]];
    }));
  });
}

// The reader drops a whole snapshot when any incident date is not a representable Date.
const isRepresentableTime = ms => typeof ms === 'number' && Number.isSafeInteger(ms) && ms > 0 && Number.isFinite(new Date(ms).getTime());

export function normalizeIncidents(value) {
  const incidents = new Map();
  for (const row of decodeRows(value)) {
    const number = /^UKMTO-([1-9]\d{0,9})$/.exec(typeof row.id === 'string' ? row.id : '')?.[1];
    if (!number || Number(number) > 2 ** 31 - 1
      || !Number.isInteger(row.ts) || !isRepresentableTime(row.ts * 1000)
      || typeof row.lat !== 'number' || !Number.isFinite(row.lat) || Math.abs(row.lat) > 90
      || typeof row.lon !== 'number' || !Number.isFinite(row.lon) || Math.abs(row.lon) > 180
      || typeof row.type !== 'string' || !row.type.trim()
      || typeof row.place !== 'string' || typeof row.text !== 'string'
      || row.text.length > 20000) throw new Error('Invalid UKMTO incident fields');
    const incident = {
      id: `ukmto-${number}`, incidentNumber: Number(number),
      incidentType: row.type.trim(), place: row.place.trim(),
      description: row.text.trim(), occurredAt: row.ts * 1000,
      // The republished table has no publication time; 0 tells readers it is unknown.
      reportedAt: 0,
      location: { latitude: row.lat, longitude: row.lon },
    };
    const existing = incidents.get(incident.id);
    if (existing && JSON.stringify(existing) !== JSON.stringify(incident)) throw new Error('Conflicting UKMTO incident ID');
    incidents.set(incident.id, incident);
  }
  // The publisher repeats some reports under a second, non-UKMTO number (UKMTO-28082035 is warning 179-26).
  // Reports at the same time and position are one incident; keep its UKMTO number.
  const byEvent = new Map();
  for (const incident of [...incidents.values()].sort((a, b) => a.incidentNumber - b.incidentNumber)) {
    const event = `${incident.occurredAt}:${incident.location.latitude}:${incident.location.longitude}`;
    if (!byEvent.has(event)) byEvent.set(event, incident);
  }
  return [...byEvent.values()].sort((a, b) => b.occurredAt - a.occurredAt || a.id.localeCompare(b.id));
}

export async function fetchUkmtoIncidents(_context, fetchFn = fetch) {
  const response = await fetchFn(SOURCE_URL, {
    headers: { Accept: 'application/json', 'User-Agent': CHROME_UA },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) {
    const error = new Error(`UKMTO source HTTP ${response.status}`);
    // Access and schema failures repeat on an immediate retry; the next cron run retries them.
    if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) error.nonRetryable = true;
    throw error;
  }
  // An interrupted read stays retryable; a body that arrived but does not parse would arrive the same way again.
  const text = await response.text();
  let incidents;
  try {
    incidents = normalizeIncidents(JSON.parse(text));
  } catch (error) {
    error.nonRetryable = true;
    throw error;
  }
  return { incidents, fetchedAt: Date.now(), dataAvailable: true, stale: false };
}

export const seedOptions = {
  validateFn: data => Boolean(data && Array.isArray(data.incidents) && Number.isFinite(data.fetchedAt) && data.fetchedAt > 0
    && data.incidents.every(item => isRepresentableTime(item?.occurredAt))),
  declareRecords: data => data.incidents.length,
  ttlSeconds: 86400,
  maxStaleMin: 75,
  schemaVersion: 1,
  zeroIsValid: true,
  sourceVersion: 'hormuz-data-tracking-incidents-v1',
  emptyDataIsFailure: true,
  afterPublish: async () => {
    const creds = getOptionalUpstashCreds();
    if (creds) await upstashCommand(creds, ['SET', 'seed-activated:maritime:ukmto-incidents', '1']);
  },
};

if (isMainModule(import.meta.url, process.argv[1])) {
  loadEnvFile(import.meta.url);
  runSeed('maritime', 'ukmto-incidents', canonicalKey, fetchUkmtoIncidents, seedOptions).catch(error => {
    console.error('UKMTO seed failed:', error.message);
    process.exitCode = 1;
  });
}
