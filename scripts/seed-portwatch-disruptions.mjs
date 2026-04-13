#!/usr/bin/env node

import { loadEnvFile, runSeed, CHROME_UA } from './_seed-utils.mjs';

loadEnvFile(import.meta.url);

export const CANONICAL_KEY = 'portwatch:disruptions:active:v1';
const TTL = 7_200; // 2h — 2× the 1h cron interval

const ARCGIS_BASE =
  'https://services9.arcgis.com/weJ1QsnbMYJlCHdG/arcgis/rest/services/portwatch_disruptions_database/FeatureServer/0/query';
const FETCH_TIMEOUT = 30_000;
const DAYS_BACK = 30; // events that ended within 30 days, or are still active

// Format a JS timestamp as an ArcGIS SQL timestamp literal:
//   timestamp 'YYYY-MM-DD HH:MM:SS'
// The ArcGIS SQL parser rejects bare epoch-ms numbers against Date-typed
// fields with "Cannot perform query. Invalid query parameters." (observed
// 3× retry failure in prod, every run, portwatch:disruptions:active:v1
// missing from Redis).
export function toArcgisTimestamp(epochMs) {
  return new Date(epochMs).toISOString().slice(0, 19).replace('T', ' ');
}

export async function fetchAll() {
  const sinceEpoch = Date.now() - DAYS_BACK * 86_400_000;
  const sinceSql = toArcgisTimestamp(sinceEpoch);

  const params = new URLSearchParams({
    where: `todate > timestamp '${sinceSql}' OR todate IS NULL`,
    outFields: [
      'eventid', 'eventtype', 'eventname', 'alertlevel', 'country',
      'fromdate', 'todate', 'severitytext', 'lat', 'long',
      'affectedports', 'n_affectedports',
    ].join(','),
    orderByFields: 'fromdate DESC',
    resultRecordCount: '2000', // ArcGIS service max; no pagination — global disruptions rarely exceed a few hundred
    outSR: '4326',
    f: 'json',
  });

  const resp = await fetch(`${ARCGIS_BASE}?${params}`, {
    headers: { 'User-Agent': CHROME_UA, Accept: 'application/json' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT),
  });
  if (!resp.ok) throw new Error(`ArcGIS HTTP ${resp.status}`);
  const body = await resp.json();
  if (body.error) throw new Error(`ArcGIS disruptions error: ${body.error.message}`);

  const now = Date.now();
  const events = (body.features ?? [])
    .filter(f => f.attributes?.eventid != null)
    .map(f => {
      const a = f.attributes;
      return {
        eventId: Number(a.eventid),
        eventType: String(a.eventtype || ''),
        eventName: String(a.eventname || ''),
        alertLevel: String(a.alertlevel || '').toUpperCase(),
        country: String(a.country || ''),
        fromDate: a.fromdate ? new Date(a.fromdate).toISOString().slice(0, 10) : '',
        toDate: a.todate ? new Date(a.todate).toISOString().slice(0, 10) : null,
        active: !a.todate || a.todate > now,
        severityText: String(a.severitytext || ''),
        lat: Number(a.lat ?? 0),
        lon: Number(a.long ?? 0),
        affectedPorts: a.affectedports
          ? String(a.affectedports).split(',').map(s => s.trim()).filter(Boolean)
          : [],
        affectedPortCount: Number(a.n_affectedports ?? 0),
      };
    });

  if (!events.length) throw new Error('No disruption events returned from ArcGIS');
  return { events, fetchedAt: new Date().toISOString() };
}

export function validateFn(data) {
  return data && Array.isArray(data.events) && data.events.length > 0;
}

const isMain = process.argv[1]?.endsWith('seed-portwatch-disruptions.mjs');
if (isMain) {
  runSeed('portwatch', 'disruptions', CANONICAL_KEY, fetchAll, {
    validateFn,
    ttlSeconds: TTL,
    sourceVersion: 'imf-portwatch-disruptions-arcgis-v1',
    recordCount: (data) => data?.events?.length ?? 0,
  }).catch((err) => {
    const cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : '';
    console.error('FATAL:', (err.message || err) + cause);
    process.exit(1);
  });
}
