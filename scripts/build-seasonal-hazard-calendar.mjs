#!/usr/bin/env node
/**
 * Builds shared/seasonal-hazard-calendar.json (#10511): for each country and
 * month, in how many years of the window GDACS recorded a tropical cyclone or
 * flood event that began in that month.
 *
 * This is recorded history, not a forecast. The travel risk assessment cites
 * it as "events in N of M years" and never as a prediction. GDACS history for
 * wildfire and drought is not served by the archive search endpoint, so this
 * calendar covers tropical cyclones and floods only.
 *
 * Run by hand about once a year: `node scripts/build-seasonal-hazard-calendar.mjs`.
 */

import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const GDACS_ARCHIVE_URL = 'https://www.gdacs.org/gdacsapi/api/events/geteventlist/SEARCH';
export const GDACS_HAZARDS = ['TC', 'FL'];
/**
 * First year each hazard's archive coverage is consistent. GDACS has no cyclone
 * records before 2011, and its flood volume rises about fivefold from 2019, so
 * an earlier start would count a change in coverage as a change in floods.
 */
export const HAZARD_FIRST_YEAR = { TC: 2011, FL: 2019 };
const PAGE_SIZE = 100;
const MAX_PAGES = 40;
const USER_AGENT = 'WorldMonitor/1.0 (+https://www.worldmonitor.app)';
const OUT_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'shared', 'seasonal-hazard-calendar.json');

/**
 * @param {Array<{ type: string, eventId: string|number, fromDate: string, countries: string[] }>} events
 * @param {Record<string, { fromYear: number, toYear: number }>} windows per hazard
 * @returns {Record<string, Record<string, number[]>>} country -> hazard -> 12 counts of distinct years with an event starting that month
 */
export function aggregateSeasonalCalendar(events, windows) {
  const yearsByCell = new Map();
  for (const event of events) {
    const match = /^(\d{4})-(\d{2})-\d{2}/.exec(event.fromDate ?? '');
    if (!match) continue;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const window = windows[event.type];
    if (!window || year < window.fromYear || year > window.toYear || month < 1 || month > 12) continue;
    for (const country of new Set(event.countries)) {
      if (!/^[A-Z]{2}$/.test(country)) continue;
      const cell = `${country}:${event.type}:${month}`;
      if (!yearsByCell.has(cell)) yearsByCell.set(cell, new Set());
      yearsByCell.get(cell).add(year);
    }
  }
  const calendar = {};
  for (const [cell, years] of yearsByCell) {
    const [country, type, month] = cell.split(':');
    calendar[country] ??= {};
    calendar[country][type] ??= Array(12).fill(0);
    calendar[country][type][Number(month) - 1] = years.size;
  }
  const sorted = {};
  for (const country of Object.keys(calendar).sort()) {
    sorted[country] = {};
    for (const type of GDACS_HAZARDS) if (calendar[country][type]) sorted[country][type] = calendar[country][type];
  }
  return sorted;
}

export async function fetchPage(type, fromDate, toDate, page, fetchFn, retryDelayMs = 2_000) {
  const url = new URL(GDACS_ARCHIVE_URL);
  url.search = new URLSearchParams({
    eventlist: type,
    fromdate: fromDate,
    todate: toDate,
    alertlevel: 'Green;Orange;Red',
    pagesize: String(PAGE_SIZE),
    pagenumber: String(page),
  }).toString();
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetchFn(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' }, signal: AbortSignal.timeout(60_000) });
      const text = await response.text();
      if (response.status === 204 || (response.ok && text.trim() === '')) return [];
      if (response.ok) {
        const body = JSON.parse(text);
        if (Array.isArray(body.features)) return body.features;
      }
      throw new Error(`HTTP ${response.status}: invalid archive page`);
    } catch (error) {
      if (attempt === 3) throw new Error(`GDACS archive ${type} ${fromDate}..${toDate} page ${page}: ${error.message}`, { cause: error });
    }
    await new Promise((resolve) => setTimeout(resolve, retryDelayMs * attempt));
  }
  return [];
}

export async function fetchGdacsEvents(windows, fetchFn = (...args) => globalThis.fetch(...args)) {
  const events = [];
  const perYear = {};
  for (const type of GDACS_HAZARDS) {
    for (let year = windows[type].fromYear; year <= windows[type].toYear; year++) {
      let total = 0;
      let complete = false;
      for (let page = 1; page <= MAX_PAGES; page++) {
        const features = await fetchPage(type, `${year}-01-01`, `${year}-12-31`, page, fetchFn);
        for (const feature of features) {
          const props = feature?.properties ?? {};
          events.push({
            type,
            eventId: props.eventid,
            fromDate: props.fromdate,
            countries: (props.affectedcountries ?? []).map((c) => String(c?.iso2 ?? '').toUpperCase()),
          });
        }
        total += features.length;
        if (features.length < PAGE_SIZE) {
          complete = true;
          break;
        }
      }
      if (!complete) throw new Error(`GDACS archive ${type} ${year}: pagination limit reached (${MAX_PAGES * PAGE_SIZE} records); calendar not written`);
      perYear[`${type}:${year}`] = total;
    }
  }
  return { events, perYear };
}

async function main() {
  const toYear = new Date().getUTCFullYear() - 1;
  const windows = Object.fromEntries(GDACS_HAZARDS.map((type) => [type, { fromYear: HAZARD_FIRST_YEAR[type], toYear }]));
  const { events, perYear } = await fetchGdacsEvents(windows);
  console.error('events per hazard-year', JSON.stringify(perYear));
  const countries = aggregateSeasonalCalendar(events, windows);
  const output = {
    source: 'GDACS event archive (Global Disaster Alert and Coordination System, EU Joint Research Centre and UN OCHA)',
    sourceUrl: 'https://www.gdacs.org/',
    method: 'For each country and month, the number of years in the window with at least one GDACS-recorded event of that hazard starting in that month. Recorded history, not a forecast.',
    hazards: { TC: 'Tropical cyclone', FL: 'Flood' },
    windows,
    generatedAt: new Date().toISOString().slice(0, 10),
    countries,
  };
  await writeFile(OUT_PATH, `${JSON.stringify(output)}\n`);
  console.error(`wrote ${Object.keys(countries).length} countries to ${OUT_PATH}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error.message); process.exit(1); });
}
