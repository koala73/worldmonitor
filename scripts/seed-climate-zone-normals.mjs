#!/usr/bin/env node
/**
 * seed-climate-zone-normals.mjs
 *
 * Fetches WMO 30-year climatological normals (1991-2020) for each climate zone.
 * These are used as the baseline for climate anomaly detection instead of the
 * climatologically meaningless 30-day rolling window.
 *
 * Run: Monthly (1st of month, 03:00 UTC) via Railway cron
 * Cache: climate:zone-normals:v1 (TTL 30 days)
 */

import { loadEnvFile, CHROME_UA, runSeed } from './_seed-utils.mjs';
import { ALL_ZONES, MIN_ZONES } from './_climate-zones.mjs';

loadEnvFile(import.meta.url);

const CANONICAL_KEY = 'climate:zone-normals:v1';
const CACHE_TTL = 30 * 24 * 60 * 60; // 30 days in seconds

// Month names for logging
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Fetch monthly normals for a zone using Open-Meteo archive API.
 * We fetch 1991-2020 data and aggregate to monthly means per calendar month.
 */
async function fetchZoneNormals(zone) {
  const monthlyNormals = {};

  // Initialize all months
  for (let m = 1; m <= 12; m++) {
    monthlyNormals[m] = { temps: [], precips: [] };
  }

  // Fetch each year in chunks to avoid overwhelming the API
  // Open-Meteo supports date ranges, so we fetch entire years
  const startYear = 1991;
  const endYear = 2020;

  for (let year = startYear; year <= endYear; year++) {
    const yearStart = `${year}-01-01`;
    const yearEnd = `${year}-12-31`;
    const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${zone.lat}&longitude=${zone.lon}&start_date=${yearStart}&end_date=${yearEnd}&daily=temperature_2m_mean,precipitation_sum&timezone=UTC`;

    try {
      const resp = await fetch(url, {
        headers: { 'User-Agent': CHROME_UA },
        signal: AbortSignal.timeout(20_000),
      });

      if (!resp.ok) {
        console.log(`  [ZONE_NORMALS] ${zone.name} ${year}: HTTP ${resp.status}`);
        continue;
      }

      const data = await resp.json();
      const dailyTemps = data.daily?.temperature_2m_mean ?? [];
      const dailyPrecips = data.daily?.precipitation_sum ?? [];
      const dailyDates = data.daily?.time ?? [];

      // Aggregate to monthly
      for (let i = 0; i < dailyDates.length; i++) {
        const dateStr = dailyDates[i];
        if (!dateStr) continue;
        const month = parseInt(dateStr.slice(5, 7), 10);
        const temp = dailyTemps[i];
        const precip = dailyPrecips[i];

        if (temp != null && precip != null) {
          monthlyNormals[month].temps.push(temp);
          monthlyNormals[month].precips.push(precip);
        }
      }
    } catch (err) {
      console.log(`  [ZONE_NORMALS] ${zone.name} ${year}: ${err?.message ?? err}`);
    }

    // Rate limit to be nice to Open-Meteo
    await new Promise((r) => setTimeout(r, 100));
  }

  // Compute monthly means
  const normals = [];
  for (let month = 1; month <= 12; month++) {
    const { temps, precips } = monthlyNormals[month];
    if (temps.length === 0) {
      console.log(`  [ZONE_NORMALS] ${zone.name} ${MONTH_NAMES[month - 1]}: No data`);
      continue;
    }

    const avgTemp = temps.reduce((s, v) => s + v, 0) / temps.length;
    const avgPrecip = precips.reduce((s, v) => s + v, 0) / precips.length;

    normals.push({
      month,
      monthName: MONTH_NAMES[month - 1],
      tempMean: Math.round(avgTemp * 100) / 100,
      precipMean: Math.round(avgPrecip * 100) / 100,
      sampleCount: temps.length,
    });
  }

  return {
    zone: zone.name,
    location: { latitude: zone.lat, longitude: zone.lon },
    normals,
    period: '1991-2020',
    computedAt: new Date().toISOString(),
  };
}

async function fetchAllZoneNormals() {
  const allNormals = [];
  let failures = 0;

  for (const zone of ALL_ZONES) {
    console.log(`[ZONE_NORMALS] Fetching ${zone.name} (${zone.lat}, ${zone.lon})...`);
    try {
      const result = await fetchZoneNormals(zone);
      if (result && result.normals.length > 0) {
        allNormals.push(result);
        console.log(`  → ${result.normals.length} months, ${result.normals[0].sampleCount}+ samples/month`);
      } else {
        failures++;
      }
    } catch (err) {
      console.log(`  [ZONE_NORMALS] ${zone.name}: ${err?.message ?? err}`);
      failures++;
    }
  }

  if (allNormals.length === 0) {
    throw new Error(`No zone normals fetched (${failures} failures)`);
  }

  console.log(`[ZONE_NORMALS] Completed: ${allNormals.length}/${ALL_ZONES.length} zones`);

  return { zones: allNormals, pagination: undefined };
}

function validate(data) {
  // Mirror the anomalies seeder's MIN_ZONES threshold (ceil(22 * 2/3) = 15).
  // A partial seeder run that writes fewer zones would cause the anomalies
  // seeder to throw on every run until this cache expires (up to 30 days).
  return Array.isArray(data?.zones) && data.zones.length >= MIN_ZONES;
}

runSeed('climate', 'zone-normals', CANONICAL_KEY, fetchAllZoneNormals, {
  validateFn: validate,
  ttlSeconds: CACHE_TTL,
  sourceVersion: 'open-meteo-archive-wmo-normals',
}).catch((err) => {
  const _cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : '';
  console.error('FATAL:', (err.message || err) + _cause);
  process.exit(1);
});
