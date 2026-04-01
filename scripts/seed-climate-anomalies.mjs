#!/usr/bin/env node

import { loadEnvFile, runSeed, sleep, verifySeedKey } from './_seed-utils.mjs';
import { CLIMATE_ZONES, MIN_CLIMATE_ZONE_COUNT, hasRequiredClimateZones } from './_climate-zones.mjs';
import { chunkItems, fetchOpenMeteoArchiveBatch } from './_open-meteo-archive.mjs';
import { CLIMATE_ZONE_NORMALS_KEY } from './seed-climate-zone-normals.mjs';

loadEnvFile(import.meta.url);

const CANONICAL_KEY = 'climate:anomalies:v2';
const CACHE_TTL = 10800; // 3h
const ANOMALY_BATCH_SIZE = 8;
const ANOMALY_BATCH_DELAY_MS = 750;
// Daily precipitation deltas are in mm/day (Open-Meteo daily precipitation_sum).
// Thresholds were calibrated against ERA5-style daily precipitation distributions.
const PRECIP_MODERATE_THRESHOLD = 6;
const PRECIP_EXTREME_THRESHOLD = 12;
const PRECIP_MIXED_THRESHOLD = 3;
const TEMP_TO_PRECIP_RATIO = 3;

function avg(arr) {
  return arr.length ? arr.reduce((sum, value) => sum + value, 0) / arr.length : 0;
}

function round(value, decimals = 1) {
  const scale = 10 ** decimals;
  return Math.round(value * scale) / scale;
}

function classifySeverity(tempDelta, precipDelta) {
  const absTemp = Math.abs(tempDelta);
  const absPrecip = Math.abs(precipDelta);
  if (absTemp >= 5 || absPrecip >= PRECIP_EXTREME_THRESHOLD) return 'ANOMALY_SEVERITY_EXTREME';
  if (absTemp >= 3 || absPrecip >= PRECIP_MODERATE_THRESHOLD) return 'ANOMALY_SEVERITY_MODERATE';
  return 'ANOMALY_SEVERITY_NORMAL';
}

function classifyType(tempDelta, precipDelta) {
  const absTemp = Math.abs(tempDelta);
  const absPrecip = Math.abs(precipDelta);
  if (absTemp >= absPrecip / TEMP_TO_PRECIP_RATIO) {
    if (tempDelta > 0 && precipDelta < -PRECIP_MIXED_THRESHOLD) return 'ANOMALY_TYPE_MIXED';
    if (tempDelta > 3) return 'ANOMALY_TYPE_WARM';
    if (tempDelta < -3) return 'ANOMALY_TYPE_COLD';
  }
  if (precipDelta > PRECIP_MODERATE_THRESHOLD) return 'ANOMALY_TYPE_WET';
  if (precipDelta < -PRECIP_MODERATE_THRESHOLD) return 'ANOMALY_TYPE_DRY';
  if (tempDelta > 0) return 'ANOMALY_TYPE_WARM';
  return 'ANOMALY_TYPE_COLD';
}

export function indexZoneNormals(payload) {
  const index = new Map();
  for (const zone of payload?.normals ?? []) {
    for (const month of zone?.months ?? []) {
      index.set(`${zone.zone}:${month.month}`, month);
    }
  }
  return index;
}

export function buildClimateAnomaly(zone, daily, monthlyNormal) {
  const observations = [];
  const times = daily?.time ?? [];
  const temps = daily?.temperature_2m_mean ?? [];
  const precips = daily?.precipitation_sum ?? [];

  for (let i = 0; i < times.length; i++) {
    const time = times[i];
    const temp = temps[i];
    const precip = precips[i];
    if (typeof time !== 'string' || temp == null || precip == null) continue;
    observations.push({
      date: time,
      temp: Number(temp),
      precip: Number(precip),
    });
  }

  if (observations.length < 7) return null;

  const recent = observations.slice(-7);
  const tempDelta = round(avg(recent.map((entry) => entry.temp)) - monthlyNormal.tempMean);
  const precipDelta = round(avg(recent.map((entry) => entry.precip)) - monthlyNormal.precipMean);

  return {
    zone: zone.name,
    location: { latitude: zone.lat, longitude: zone.lon },
    tempDelta,
    precipDelta,
    severity: classifySeverity(tempDelta, precipDelta),
    type: classifyType(tempDelta, precipDelta),
    period: `${recent[0].date} to ${recent.at(-1).date}`,
  };
}

export function buildClimateAnomalyFromResponse(zone, payload, normalsIndex) {
  const latestDate = payload?.daily?.time?.filter((value) => typeof value === 'string').at(-1);
  if (!latestDate) return null;
  const month = Number(latestDate.slice(5, 7));
  const monthlyNormal = normalsIndex.get(`${zone.name}:${month}`);
  if (!monthlyNormal) {
    console.warn(`  [CLIMATE] Missing monthly normal for ${zone.name} month ${month}; skipping zone`);
    return null;
  }

  return buildClimateAnomaly(zone, payload.daily, monthlyNormal);
}

export function buildClimateAnomaliesFromBatch(zones, batchPayloads, normalsIndex) {
  return zones
    .map((zone, index) => buildClimateAnomalyFromResponse(zone, batchPayloads[index], normalsIndex))
    .filter((anomaly) => anomaly != null);
}

function toIsoDate(date) {
  return date.toISOString().slice(0, 10);
}

export async function fetchClimateAnomalies() {
  // ## First Deploy
  // The anomaly cron depends on the monthly normals cache. Seed
  // `node scripts/seed-climate-zone-normals.mjs` once before enabling the
  // anomaly cron in a fresh environment, otherwise every 2h anomaly run will
  // fail until the monthly normals cron executes on the 1st of the month.
  const normalsPayload = await verifySeedKey(CLIMATE_ZONE_NORMALS_KEY).catch(() => null);
  if (!normalsPayload?.normals?.length) {
    throw new Error(`Missing ${CLIMATE_ZONE_NORMALS_KEY} baseline; run node scripts/seed-climate-zone-normals.mjs before enabling the anomaly cron`);
  }
  const normalsIndex = indexZoneNormals(normalsPayload);

  const endDate = toIsoDate(new Date());
  const startDate = toIsoDate(new Date(Date.now() - 21 * 24 * 60 * 60 * 1000));

  const anomalies = [];
  let failures = 0;
  for (const batch of chunkItems(CLIMATE_ZONES, ANOMALY_BATCH_SIZE)) {
    try {
      const payloads = await fetchOpenMeteoArchiveBatch(batch, {
        startDate,
        endDate,
        daily: ['temperature_2m_mean', 'precipitation_sum'],
        timeoutMs: 20_000,
        maxRetries: 4,
        retryBaseMs: 3_000,
        label: `anomalies batch (${batch.map((zone) => zone.name).join(', ')})`,
      });
      anomalies.push(...buildClimateAnomaliesFromBatch(batch, payloads, normalsIndex));
    } catch (err) {
      console.log(`  [CLIMATE] ${err?.message ?? err}`);
      failures += batch.length;
    }
    await sleep(ANOMALY_BATCH_DELAY_MS);
  }

  if (anomalies.length < MIN_CLIMATE_ZONE_COUNT) {
    throw new Error(`Only ${anomalies.length}/${CLIMATE_ZONES.length} zones returned data (${failures} errors) — skipping write to preserve previous Redis data`);
  }
  if (!hasRequiredClimateZones(anomalies, (zone) => zone.zone)) {
    throw new Error('Missing one or more required climate-specific anomalies');
  }

  return { anomalies, pagination: undefined };
}

function validate(data) {
  return Array.isArray(data?.anomalies)
    && data.anomalies.length >= MIN_CLIMATE_ZONE_COUNT
    && hasRequiredClimateZones(data.anomalies, (zone) => zone.zone);
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/^file:\/\//, ''));
if (isMain) {
  runSeed('climate', 'anomalies', CANONICAL_KEY, fetchClimateAnomalies, {
    validateFn: validate,
    ttlSeconds: CACHE_TTL,
    sourceVersion: 'open-meteo-archive-wmo-1991-2020-v1',
  }).catch((err) => {
    const cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : '';
    console.error('FATAL:', (err.message || err) + cause);
    process.exit(1);
  });
}
