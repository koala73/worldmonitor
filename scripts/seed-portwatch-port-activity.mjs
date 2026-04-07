#!/usr/bin/env node

import { loadEnvFile, runSeed, CHROME_UA, getRedisCredentials } from './_seed-utils.mjs';
import { createCountryResolvers, resolveIso2 } from './_country-resolver.mjs';

loadEnvFile(import.meta.url);

export const CANONICAL_KEY = 'supply_chain:portwatch-ports:v1:_countries';
const KEY_PREFIX = 'supply_chain:portwatch-ports:v1:';
const TTL = 259_200; // 3 days — 6× the 12h cron interval

const EP3_BASE =
  'https://services9.arcgis.com/weJ1QsnbMYJlCHdG/arcgis/rest/services/Daily_Ports_Data/FeatureServer/0/query';
const EP4_BASE =
  'https://services9.arcgis.com/weJ1QsnbMYJlCHdG/arcgis/rest/services/PortWatch_ports_database/FeatureServer/0/query';

const PAGE_SIZE = 2000;
const FETCH_TIMEOUT = 45_000;
const HISTORY_DAYS = 90;
const MAX_PORTS_PER_COUNTRY = 50;
const CONCURRENCY = 4;

function epochToTimestamp(epochMs) {
  const d = new Date(epochMs);
  const p = (n) => String(n).padStart(2, '0');
  return `timestamp '${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}'`;
}

async function fetchWithTimeout(url) {
  const resp = await fetch(url, {
    headers: { 'User-Agent': CHROME_UA, Accept: 'application/json' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT),
  });
  if (!resp.ok) throw new Error(`ArcGIS HTTP ${resp.status} for ${url.slice(0, 80)}`);
  const body = await resp.json();
  if (body.error) throw new Error(`ArcGIS error: ${body.error.message}`);
  return body;
}

async function fetchPortRef(iso3) {
  const params = new URLSearchParams({
    where: `ISO3='${iso3}'`,
    outFields: 'portid,lat,lon',
    resultRecordCount: String(PAGE_SIZE),
    outSR: '4326',
    f: 'json',
  });
  const body = await fetchWithTimeout(`${EP4_BASE}?${params}`);
  const refMap = new Map();
  for (const f of body.features ?? []) {
    const a = f.attributes;
    if (a?.portid != null) {
      refMap.set(String(a.portid), { lat: Number(a.lat ?? 0), lon: Number(a.lon ?? 0) });
    }
  }
  return refMap;
}

async function fetchActivityRows(iso3, since) {
  let offset = 0;
  const allRows = [];
  let body;
  do {
    const params = new URLSearchParams({
      where: `ISO3='${iso3}' AND date > ${epochToTimestamp(since)}`,
      outFields: 'portid,portname,ISO3,date,portcalls_tanker,import_cap_tanker,export_cap_tanker',
      orderByFields: 'date ASC',
      resultRecordCount: String(PAGE_SIZE),
      resultOffset: String(offset),
      outSR: '4326',
      f: 'json',
    });
    body = await fetchWithTimeout(`${EP3_BASE}?${params}`);
    if (body.features?.length) allRows.push(...body.features);
    offset += PAGE_SIZE;
  } while (body.exceededTransferLimit);
  return allRows;
}

function computeCountryPorts(rawRows, refMap) {
  const now = Date.now();
  const cutoff30 = now - 30 * 86400000;
  const cutoff60 = now - 60 * 86400000;
  const cutoff7 = now - 7 * 86400000;

  const portGroups = new Map();
  for (const f of rawRows) {
    const a = f.attributes;
    if (a?.portid == null || a?.date == null) continue;
    const portId = String(a.portid);
    if (!portGroups.has(portId)) portGroups.set(portId, []);
    portGroups.get(portId).push({
      date: Number(a.date),
      portname: String(a.portname || ''),
      portcalls_tanker: Number(a.portcalls_tanker ?? 0),
      import_cap_tanker: Number(a.import_cap_tanker ?? 0),
      export_cap_tanker: Number(a.export_cap_tanker ?? 0),
    });
  }

  const ports = [];
  for (const [portId, rows] of portGroups) {
    const last30 = rows.filter(r => r.date >= cutoff30);
    const prev30 = rows.filter(r => r.date >= cutoff60 && r.date < cutoff30);
    const last7 = rows.filter(r => r.date >= cutoff7);

    const tankerCalls30d = last30.reduce((s, r) => s + r.portcalls_tanker, 0);
    const tankerCalls30dPrev = prev30.reduce((s, r) => s + r.portcalls_tanker, 0);
    const importTankerDwt30d = last30.reduce((s, r) => s + r.import_cap_tanker, 0);
    const exportTankerDwt30d = last30.reduce((s, r) => s + r.export_cap_tanker, 0);

    const avg30d = tankerCalls30d / 30;
    const avg7d = last7.reduce((s, r) => s + r.portcalls_tanker, 0) / Math.max(last7.length, 1);
    const anomalySignal = avg30d > 0 && avg7d < avg30d * 0.5;

    const trendDelta = tankerCalls30dPrev > 0
      ? Math.round(((tankerCalls30d - tankerCalls30dPrev) / tankerCalls30dPrev) * 1000) / 10
      : 0;

    const portName = rows[0].portname;
    const coords = refMap.get(portId) || { lat: 0, lon: 0 };

    ports.push({
      portId,
      portName,
      lat: coords.lat,
      lon: coords.lon,
      tankerCalls30d,
      trendDelta,
      importTankerDwt30d,
      exportTankerDwt30d,
      anomalySignal,
    });
  }

  return ports
    .sort((a, b) => b.tankerCalls30d - a.tankerCalls30d)
    .slice(0, MAX_PORTS_PER_COUNTRY);
}

async function redisPipeline(commands) {
  const { url, token } = getRedisCredentials();
  const resp = await fetch(`${url}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'User-Agent': CHROME_UA },
    body: JSON.stringify(commands),
    signal: AbortSignal.timeout(30_000),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Redis pipeline failed: HTTP ${resp.status} — ${text.slice(0, 200)}`);
  }
  return resp.json();
}

async function processCountry(iso3, iso2, since) {
  const [refMap, rawRows] = await Promise.all([
    fetchPortRef(iso3),
    fetchActivityRows(iso3, since),
  ]);
  if (!rawRows.length) return null;
  const ports = computeCountryPorts(rawRows, refMap);
  if (!ports.length) return null;
  return { iso2, ports, fetchedAt: new Date().toISOString() };
}

export async function fetchAll() {
  const { iso3ToIso2 } = createCountryResolvers();
  const ISO3_LIST = [...iso3ToIso2.keys()];
  const since = Date.now() - HISTORY_DAYS * 86400000;

  const countryResults = new Map();
  const errors = [];

  for (let i = 0; i < ISO3_LIST.length; i += CONCURRENCY) {
    const batch = ISO3_LIST.slice(i, i + CONCURRENCY);
    const settled = await Promise.allSettled(
      batch.map(iso3 => {
        const iso2 = iso3ToIso2.get(iso3);
        return processCountry(iso3, iso2, since);
      })
    );
    for (let j = 0; j < batch.length; j++) {
      const iso3 = batch[j];
      const outcome = settled[j];
      if (outcome.status === 'rejected') {
        errors.push(`${iso3}: ${outcome.reason?.message || outcome.reason}`);
        continue;
      }
      if (!outcome.value) continue;
      const { iso2, ports, fetchedAt } = outcome.value;
      countryResults.set(iso2, { iso2, ports, fetchedAt });
    }
  }

  if (errors.length) {
    console.warn(`  [port-activity] ${errors.length} country errors: ${errors.slice(0, 5).join('; ')}${errors.length > 5 ? ' ...' : ''}`);
  }

  if (countryResults.size === 0) throw new Error('No country port data returned from ArcGIS');

  const commands = [];
  for (const [iso2, payload] of countryResults) {
    commands.push(['SET', `${KEY_PREFIX}${iso2}`, JSON.stringify(payload), 'EX', TTL]);
  }
  commands.push(['SET', CANONICAL_KEY, JSON.stringify([...countryResults.keys()]), 'EX', TTL]);
  await redisPipeline(commands);

  console.log(`  [port-activity] wrote ${countryResults.size} country keys + _countries index`);
  return { countries: [...countryResults.keys()], fetchedAt: new Date().toISOString() };
}

export function validateFn(data) {
  return data && Array.isArray(data.countries) && data.countries.length >= 50;
}

const isMain = process.argv[1]?.endsWith('seed-portwatch-port-activity.mjs');
if (isMain) {
  runSeed('supply_chain', 'portwatch-ports', CANONICAL_KEY, fetchAll, {
    validateFn,
    ttlSeconds: TTL,
    sourceVersion: 'imf-portwatch-port-activity-arcgis-v1',
    recordCount: (data) => data?.countries?.length ?? 0,
  }).catch((err) => {
    const cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : '';
    console.error('FATAL:', (err.message || err) + cause);
    process.exit(1);
  });
}
