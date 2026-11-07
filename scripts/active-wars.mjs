// "What wars are happening right now?" answered from UCDP's latest month.
//
// conflict:ucdp-events:v1 holds UCDP's newest monthly candidate release, a
// complete calendar month, so the answer reads that month. It counts the
// countries where state-based fighting (a government on at least one side)
// killed at least ACTIVE_WAR_DEATH_THRESHOLD people: UCDP's armed-conflict
// threshold, applied to one month instead of a year.
import fs from 'node:fs';
import path from 'node:path';

import { feature as topojsonFeature } from 'topojson-client';

import { resolveIso2 } from './_country-resolver.mjs';

export const ACTIVE_WAR_DEATH_THRESHOLD = 25;
export const ACTIVE_WARS_SOURCE = 'UCDP Georeferenced Event Dataset (candidate release)';
const STATE_BASED = 'UCDP_VIOLENCE_TYPE_STATE_BASED';
// UCDP publishes a month roughly four weeks after it ends. A reference month
// that ended longer ago than this means the candidate feed stopped, and the
// list would answer "right now" with a stale war count.
export const MAX_REFERENCE_MONTH_AGE_DAYS = 75;
const DAY_MS = 24 * 60 * 60 * 1000;

function isoDay(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

// UCDP appends the historical name: "Yemen (North Yemen)", "Government of
// Russia (Soviet Union)". Readers know the current one.
function withoutHistoricalName(name) {
  return String(name ?? '').replace(/\s*\([^)]*\)\s*$/, '').trim();
}

// Candidate releases code actors UCDP has not identified yet as "XXX" plus
// the Gleditsch-Ward country number (XXX475 is Nigeria).
function actorName(side) {
  const name = withoutHistoricalName(side);
  return /^XXX\d+$/.test(name) ? '' : name;
}

function inRing(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * UCDP files fighting in Gaza and the West Bank under Israel. World Monitor
 * counts an event where it happens (owner ruling 2026-10-23, CII v15 B7), so
 * the freeze passes this test and those events count for Palestine.
 */
// Natural Earth 1:50m. The 1:110m countries.geojson draws Gaza as a triangle
// that leaves out Gaza City.
const PALESTINE_ISO_NUMERIC = '275';

export function palestineLocator(rootDir) {
  const topology = JSON.parse(fs.readFileSync(path.join(rootDir, 'public', 'data', 'countries-50m.json'), 'utf8'));
  const geometry = topology.objects.countries.geometries.find((entry) => entry.id === PALESTINE_ISO_NUMERIC);
  if (!geometry) throw new Error('countries-50m.json has no Palestine geometry');
  const { geometry: shape } = topojsonFeature(topology, geometry);
  const polygons = shape.type === 'MultiPolygon' ? shape.coordinates : [shape.coordinates];
  return (lat, lon) => Number.isFinite(lat) && Number.isFinite(lon) && polygons.some(([outer, ...holes]) => (
    inRing(lon, lat, outer) && !holes.some((hole) => inRing(lon, lat, hole))
  ));
}

function monthBounds(ms) {
  const date = new Date(ms);
  const start = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
  const end = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
  return { start, end, month: new Date(start).toISOString().slice(0, 7) };
}

/**
 * @param {Array<object>} events ListUcdpEventsResponse.events
 * @param {number} capturedAtMs
 * @param {{ inPalestine?: (lat: number, lon: number) => boolean }} [options]
 */
export function activeWarsReading(events, capturedAtMs, { inPalestine = () => false } = {}) {
  const dated = (Array.isArray(events) ? events : [])
    .filter((event) => Number.isFinite(Number(event?.dateStart)));
  if (dated.length === 0) throw new Error('UCDP returned no dated events');
  const latestMs = Math.max(...dated.map((event) => Number(event.dateStart)));
  const { start, end, month } = monthBounds(latestMs);
  const ageDays = (capturedAtMs - end) / DAY_MS;
  if (ageDays > MAX_REFERENCE_MONTH_AGE_DAYS) {
    throw new Error(`UCDP latest month ${month} ended ${Math.floor(ageDays)} days before capture`);
  }

  const byCountry = new Map();
  for (const event of dated) {
    const startMs = Number(event.dateStart);
    if (startMs < start || startMs >= end || event.violenceType !== STATE_BASED) continue;
    const filedName = withoutHistoricalName(event.country);
    if (!filedName) continue;
    const name = filedName === 'Israel'
      && inPalestine(Number(event.location?.latitude), Number(event.location?.longitude))
      ? 'Palestine'
      : filedName;
    const deaths = Math.max(0, Math.round(Number(event.deathsBest) || 0));
    const row = byCountry.get(name) ?? { name, deaths: 0, events: 0, dyads: new Map() };
    row.deaths += deaths;
    row.events += 1;
    const sideA = actorName(event.sideA);
    const sideB = actorName(event.sideB);
    const dyadKey = `${sideA}\u0000${sideB}`;
    const dyad = row.dyads.get(dyadKey) ?? { sideA, sideB, deaths: 0 };
    dyad.deaths += deaths;
    row.dyads.set(dyadKey, dyad);
    byCountry.set(name, row);
  }
  if (byCountry.size === 0) throw new Error(`UCDP latest month ${month} has no state-based events`);

  const rows = [...byCountry.values()].sort((a, b) => b.deaths - a.deaths || a.name.localeCompare(b.name));
  const conflicts = rows
    .filter((row) => row.deaths >= ACTIVE_WAR_DEATH_THRESHOLD)
    .map((row) => {
      // The deadliest pair, left unnamed when UCDP has not identified it: a
      // minor named pair would misstate who is doing most of the fighting.
      const [dyad] = [...row.dyads.values()].sort((a, b) => b.deaths - a.deaths);
      const identified = Boolean(dyad.sideA && dyad.sideB);
      return {
        name: row.name,
        code: resolveIso2({ name: row.name }),
        deaths: row.deaths,
        events: row.events,
        sideA: identified ? dyad.sideA : '',
        sideB: identified ? dyad.sideB : '',
      };
    });
  return {
    source: ACTIVE_WARS_SOURCE,
    referenceMonth: month,
    latestEventDate: isoDay(latestMs),
    threshold: ACTIVE_WAR_DEATH_THRESHOLD,
    countryCount: conflicts.length,
    belowThresholdCount: rows.length - conflicts.length,
    conflicts,
  };
}
