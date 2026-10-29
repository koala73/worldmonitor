#!/usr/bin/env node
import { loadEnvFile, CHROME_UA, runSeed } from './_seed-utils.mjs';
import { getOptionalUpstashCreds, upstashCommand } from './_upstash-rest.mjs';
import { isMainModule } from './lib/main-module.mjs';

const SOURCE_URL = 'https://sccd.royalnavy.mod.uk/api/ukmto/all';
export const canonicalKey = 'maritime:ukmto-incidents:v1';

function parseUtcDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?Z$/.test(value)) return NaN;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0, 19) !== value.slice(0, 19)) return NaN;
  return parsed;
}

export function normalizeIncidents(value) {
  if (!Array.isArray(value) || value.length > 2000) throw new Error('Invalid UKMTO snapshot');
  const incidents = new Map();
  for (const row of value) {
    if (!row || typeof row !== 'object') throw new Error('Invalid UKMTO incident');
    const occurredAt = parseUtcDate(row.utcDateOfIncident);
    const reportedAt = parseUtcDate(row.utcDateCreated);
    if (typeof row.sitecoreId !== 'string' || !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(row.sitecoreId)
      || !Number.isInteger(row.incidentNumber) || row.incidentNumber < 1
      || !Number.isFinite(occurredAt) || occurredAt <= 0 || !Number.isFinite(reportedAt) || reportedAt <= 0
      || typeof row.locationLatitude !== 'number' || !Number.isFinite(row.locationLatitude) || Math.abs(row.locationLatitude) > 90
      || typeof row.locationLongitude !== 'number' || !Number.isFinite(row.locationLongitude) || Math.abs(row.locationLongitude) > 180
      || typeof row.incidentTypeName !== 'string' || !row.incidentTypeName.trim()
      || typeof row.place !== 'string' || typeof row.otherDetails !== 'string'
      || row.otherDetails.length > 20000) throw new Error('Invalid UKMTO incident fields');
    const incident = {
      id: row.sitecoreId.toLowerCase(), incidentNumber: row.incidentNumber,
      incidentType: row.incidentTypeName.trim(), place: row.place.trim(),
      description: row.otherDetails.trim(), occurredAt, reportedAt,
      location: { latitude: row.locationLatitude, longitude: row.locationLongitude },
    };
    const existing = incidents.get(incident.id);
    if (existing && JSON.stringify(existing) !== JSON.stringify(incident)) throw new Error('Conflicting UKMTO incident ID');
    incidents.set(incident.id, incident);
  }
  return [...incidents.values()].sort((a, b) => b.occurredAt - a.occurredAt || a.id.localeCompare(b.id));
}

export async function fetchUkmtoIncidents(_context, fetchFn = fetch) {
  const response = await fetchFn(SOURCE_URL, {
    headers: { Accept: 'application/json', 'User-Agent': CHROME_UA },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`UKMTO HTTP ${response.status}`);
  const incidents = normalizeIncidents(await response.json());
  return { incidents, fetchedAt: Date.now(), dataAvailable: true, stale: false };
}

export const seedOptions = {
  validateFn: data => Boolean(data && Array.isArray(data.incidents) && Number.isFinite(data.fetchedAt) && data.fetchedAt > 0),
  declareRecords: data => data.incidents.length,
  ttlSeconds: 86400,
  maxStaleMin: 15,
  schemaVersion: 1,
  zeroIsValid: true,
  sourceVersion: 'ukmto-site-json-v1',
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
