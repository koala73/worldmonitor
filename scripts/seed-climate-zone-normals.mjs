#!/usr/bin/env node

import { loadEnvFile, runSeed, sleep } from './_seed-utils.mjs';
import { CLIMATE_ZONES, MIN_CLIMATE_ZONE_COUNT, hasRequiredClimateZones } from './_climate-zones.mjs';
import { chunkItems, fetchOpenMeteoArchiveBatch } from './_open-meteo-archive.mjs';

loadEnvFile(import.meta.url);

export const CLIMATE_ZONE_NORMALS_KEY = 'climate:zone-normals:v1';
// Keep the previous baseline available across monthly cron gaps; health.js enforces freshness separately.
const NORMALS_TTL = 95 * 24 * 60 * 60; // 95 days = >3x a 31-day monthly interval
const NORMALS_START = '1991-01-01';
const NORMALS_END = '2020-12-31';
const NORMALS_BATCH_SIZE = 2;
const NORMALS_BATCH_DELAY_MS = 3_000;

function round(value, decimals = 2) {
  const scale = 10 ** decimals;
  return Math.round(value * scale) / scale;
}

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

export function computeMonthlyNormals(daily) {
  const dailyBucketByYearMonth = new Map();
  for (let month = 1; month <= 12; month++) {
    dailyBucketByYearMonth.set(month, new Map());
  }

  const times = daily?.time ?? [];
  const temps = daily?.temperature_2m_mean ?? [];
  const precips = daily?.precipitation_sum ?? [];

  for (let i = 0; i < times.length; i++) {
    const time = times[i];
    const temp = temps[i];
    const precip = precips[i];
    if (typeof time !== 'string' || temp == null || precip == null) continue;
    const year = Number(time.slice(0, 4));
    const month = Number(time.slice(5, 7));
    if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) continue;
    const key = `${year}-${String(month).padStart(2, '0')}`;
    const bucket = dailyBucketByYearMonth.get(month);
    const existing = bucket.get(key);
    if (existing) {
      existing.temps.push(Number(temp));
      existing.precips.push(Number(precip));
      continue;
    }
    bucket.set(key, {
      temps: [Number(temp)],
      precips: [Number(precip)],
    });
  }

  return Array.from(dailyBucketByYearMonth.entries())
    .map(([month, bucket]) => {
      const monthlyMeans = Array.from(bucket.values())
        .map((entry) => ({
          tempMean: average(entry.temps),
          precipMean: average(entry.precips),
        }))
        .filter((entry) => Number.isFinite(entry.tempMean) && Number.isFinite(entry.precipMean));

      if (monthlyMeans.length === 0) return null;

      return {
        month,
        tempMean: round(average(monthlyMeans.map((entry) => entry.tempMean))),
        precipMean: round(average(monthlyMeans.map((entry) => entry.precipMean))),
      };
    })
    .filter((entry) => entry != null && Number.isFinite(entry.tempMean) && Number.isFinite(entry.precipMean));
}

export function buildZoneNormalsFromBatch(zones, batchPayloads) {
  return zones.flatMap((zone, index) => {
    const data = batchPayloads[index];
    const months = computeMonthlyNormals(data?.daily);
    if (months.length !== 12) {
      console.warn(`  [CLIMATE_NORMALS] Open-Meteo normals incomplete for ${zone.name}: expected 12 months, got ${months.length}`);
      return [];
    }

    return [{
      zone: zone.name,
      location: { latitude: zone.lat, longitude: zone.lon },
      months,
    }];
  });
}

export async function fetchClimateZoneNormals() {
  const normals = [];
  let failures = 0;

  for (const batch of chunkItems(CLIMATE_ZONES, NORMALS_BATCH_SIZE)) {
    try {
      const payloads = await fetchOpenMeteoArchiveBatch(batch, {
        startDate: NORMALS_START,
        endDate: NORMALS_END,
        daily: ['temperature_2m_mean', 'precipitation_sum'],
        timeoutMs: 30_000,
        maxRetries: 4,
        retryBaseMs: 5_000,
        label: `normals batch (${batch.map((zone) => zone.name).join(', ')})`,
      });
      const batchNormals = buildZoneNormalsFromBatch(batch, payloads);
      normals.push(...batchNormals);
      failures += Math.max(0, batch.length - batchNormals.length);
    } catch (err) {
      console.log(`  [CLIMATE_NORMALS] ${err?.message ?? err}`);
      failures += batch.length;
    }
    await sleep(NORMALS_BATCH_DELAY_MS);
  }

  if (normals.length < MIN_CLIMATE_ZONE_COUNT) {
    throw new Error(`Only ${normals.length}/${CLIMATE_ZONES.length} zones returned normals (${failures} errors)`);
  }
  if (!hasRequiredClimateZones(normals, (zone) => zone.zone)) {
    throw new Error('Missing one or more required climate-specific zone normals');
  }

  return {
    referencePeriod: '1991-2020',
    fetchedAt: Date.now(),
    normals,
  };
}

function validate(data) {
  return Array.isArray(data?.normals)
    && data.normals.length >= MIN_CLIMATE_ZONE_COUNT
    && hasRequiredClimateZones(data.normals, (zone) => zone.zone)
    && data.normals.every((zone) => Array.isArray(zone?.months) && zone.months.length === 12);
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/^file:\/\//, ''));
if (isMain) {
  runSeed('climate', 'zone-normals', CLIMATE_ZONE_NORMALS_KEY, fetchClimateZoneNormals, {
    validateFn: validate,
    ttlSeconds: NORMALS_TTL,
    sourceVersion: 'open-meteo-wmo-1991-2020-v1',
  }).catch((err) => {
    const cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : '';
    console.error('FATAL:', (err.message || err) + cause);
    process.exit(1);
  });
}
