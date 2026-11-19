#!/usr/bin/env -S npx tsx
// The 20-place live check for the point lookup (issue #10705): computes every
// open-mission pass over the last 7 days from current CelesTrak elements, runs
// the lookup's own archive search and matching against Earth Search and
// Planetary Computer, and measures how long each archive takes to publish.
// Network only; nothing here runs in CI.
//
// Usage: npx tsx scripts/orbital-live-check.mts [--out docs/audits/orbital-live-check-<date>.json] [--elements gp.json]

import { readFileSync, writeFileSync } from 'node:fs';
import { selectProfiledSatellites, CELESTRAK_ACTIVE_URL } from './_orbital-catalog.mjs';
import { acquiresAt, isLandOrCoast } from '../shared/orbital/coverage.js';
import { OPTICAL_MIN_SUN_ELEVATION_DEG } from '../shared/orbital/tiers.js';
import { profileFor } from '../src/services/orbital/pass-query.ts';
import { runPassJob, type CatalogSatellite } from '../src/services/orbital/pass-job.ts';
import { findArchiveEvidence, PROFILE_ARCHIVES } from '../src/services/orbital/match.ts';
import { STAC_ARCHIVES, type ImagingProfileId, type StacArchiveId } from '../src/services/orbital/archive-stac.ts';

export const PLACES: Record<string, { lat: number; lon: number }> = {
  paris: { lat: 48.857, lon: 2.352 },
  reykjavik: { lat: 64.147, lon: -21.942 },
  denver: { lat: 39.739, lon: -104.99 },
  dubai: { lat: 25.205, lon: 55.271 },
  nairobi: { lat: -1.286, lon: 36.817 },
  tokyo: { lat: 35.676, lon: 139.65 },
  sydney: { lat: -33.869, lon: 151.209 },
  'sao-paulo': { lat: -23.55, lon: -46.633 },
  moscow: { lat: 55.756, lon: 37.617 },
  beijing: { lat: 39.904, lon: 116.407 },
  delhi: { lat: 28.614, lon: 77.209 },
  cairo: { lat: 30.044, lon: 31.236 },
  lagos: { lat: 6.524, lon: 3.379 },
  'buenos-aires': { lat: -34.604, lon: -58.382 },
  anchorage: { lat: 61.218, lon: -149.9 },
  singapore: { lat: 1.352, lon: 103.82 },
  'cape-town': { lat: -33.925, lon: 18.424 },
  kyiv: { lat: 50.45, lon: 30.523 },
  tehran: { lat: 35.689, lon: 51.389 },
  'mexico-city': { lat: 19.433, lon: -99.133 },
};

/** Open water and ice the old land-coast mask got wrong, checked against what each archive holds. */
export const COVERAGE_PROBES: Record<string, { lat: number; lon: number }> = {
  'central-mediterranean': { lat: 35, lon: 18 },
  caspian: { lat: 42, lon: 50.8 },
  'black-sea': { lat: 43.5, lon: 34 },
  'persian-gulf': { lat: 27, lon: 51.5 },
  'red-sea': { lat: 20, lon: 38.8 },
  'antarctic-plateau': { lat: -80, lon: 0 },
  'gulf-of-mexico': { lat: 25, lon: -90 },
  'hudson-bay': { lat: 60, lon: -85 },
  'sea-of-japan': { lat: 40, lon: 135 },
  'bay-of-bengal': { lat: 15, lon: 88 },
  'mid-atlantic': { lat: 30, lon: -40 },
  'fram-strait': { lat: 79, lon: 0 },
  'central-greenland': { lat: 72, lon: -40 },
  'arctic-ocean-83n': { lat: 83.5, lon: -40 },
};

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const LOOKBACK_DAYS = 7;
const COVERAGE_PROBE_DAYS = 12;
// Lag is read from scenes sensed 20 to 40 days ago, so a scene published up
// to 20 days late is still counted instead of silently missing.
const LAG_SENSED_FROM_DAYS = 40;
const LAG_SENSED_TO_DAYS = 20;
const USER_AGENT = 'WorldMonitor orbital live check (+https://www.worldmonitor.app)';
const PROFILES = Object.keys(PROFILE_ARCHIVES) as ImagingProfileId[];
const COLLECTION: Record<StacArchiveId, Partial<Record<ImagingProfileId, string>>> = Object.fromEntries(
  (Object.keys(STAC_ARCHIVES) as StacArchiveId[]).map((archive) => [archive,
    Object.fromEntries(Object.entries(STAC_ARCHIVES[archive].collections).map(([collection, profile]) => [profile, collection]))]),
) as never;

async function stacSearch(archive: StacArchiveId, body: Record<string, unknown>): Promise<Array<Record<string, any>>> {
  const features: Array<Record<string, any>> = [];
  let request: Record<string, unknown> | null = { limit: 250, ...body };
  for (let page = 0; request && page < 20; page++) {
    const response = await fetch(STAC_ARCHIVES[archive].searchUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/geo+json', 'User-Agent': USER_AGENT },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(90_000),
    });
    if (!response.ok) throw new Error(`${archive} search ${response.status}`);
    const json = await response.json() as { features?: Array<Record<string, any>>; links?: Array<{ rel: string; body?: Record<string, unknown> }> };
    features.push(...(json.features ?? []));
    const next = json.links?.find((link) => link.rel === 'next');
    request = next?.body ? { ...request, ...next.body } : null;
  }
  return features;
}

const isoRange = (fromMs: number, toMs: number) => `${new Date(fromMs).toISOString()}/${new Date(toMs).toISOString()}`;

function quantile(values: number[], q: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)]!;
}
const round1 = (value: number | null) => (value === null ? null : Math.round(value * 10) / 10);

async function publicationLag(nowMs: number) {
  const window = isoRange(nowMs - LAG_SENSED_FROM_DAYS * DAY_MS, nowMs - LAG_SENSED_TO_DAYS * DAY_MS);
  const lags: Record<string, Record<string, number[]>> = {};
  for (const point of Object.values(PLACES)) {
    for (const archive of Object.keys(STAC_ARCHIVES) as StacArchiveId[]) {
      for (const profileId of PROFILES) {
        const collection = COLLECTION[archive][profileId];
        if (!collection) continue;
        const features = await stacSearch(archive, {
          collections: [collection],
          intersects: { type: 'Point', coordinates: [point.lon, point.lat] },
          datetime: window,
        });
        const seen = new Set<string>();
        for (const feature of features) {
          const sensed = Date.parse(feature.properties?.datetime);
          const created = Date.parse(feature.properties?.created);
          if (!Number.isFinite(sensed) || !Number.isFinite(created) || seen.has(feature.id)) continue;
          seen.add(feature.id);
          ((lags[profileId] ??= {})[archive] ??= []).push((created - sensed) / HOUR_MS);
        }
      }
    }
  }
  return Object.fromEntries(PROFILES.map((profileId) => {
    const byArchive = Object.fromEntries(Object.entries(lags[profileId] ?? {}).map(([archive, hours]) => [archive, {
      scenes: hours.length, p50Hours: round1(quantile(hours, 0.5)), p95Hours: round1(quantile(hours, 0.95)), maxHours: round1(Math.max(...hours)),
    }]));
    // A no-match only counts once the quickest archive has had its 95th-percentile lag.
    const p95s = Object.values(byArchive).map((stats) => stats.p95Hours).filter((h): h is number => h !== null);
    return [profileId, { sensed: window, byArchive, waitHours: p95s.length ? Math.ceil(Math.min(...p95s)) : null }];
  }));
}

async function coverageProbes(nowMs: number) {
  const window = isoRange(nowMs - COVERAGE_PROBE_DAYS * DAY_MS, nowMs);
  const rows: Record<string, unknown> = {};
  for (const [name, point] of Object.entries(COVERAGE_PROBES)) {
    const row: Record<string, unknown> = { ...point, landCoastMask: isLandOrCoast(point.lat, point.lon) };
    for (const profileId of ['sentinel-2', 'sentinel-1'] as const) {
      const features = await stacSearch('earth-search', {
        collections: [COLLECTION['earth-search'][profileId]!],
        intersects: { type: 'Point', coordinates: [point.lon, point.lat] },
        datetime: window,
      });
      const directions = [...new Set(features.map((f) => f.properties?.['sat:orbit_state']).filter(Boolean))].sort();
      row[profileId] = {
        archiveScenes: features.length,
        ...(profileId === 'sentinel-1' ? { archiveDirections: directions } : {}),
        mask: profileId === 'sentinel-1'
          ? { ascending: acquiresAt('sentinel-1', point, 'ascending'), descending: acquiresAt('sentinel-1', point, 'descending') }
          : acquiresAt('sentinel-2', point),
      };
    }
    rows[name] = row;
  }
  return { window, probes: rows };
}

function emptyTally() {
  return {
    pastPasses: 0, confirmed: 0, confirmedGeometryDisagreed: 0, likelyImaged: 0, notInArchive: 0, passedOverheadOther: 0,
    edgeOfSwath: 0, acquisitions: 0, acquisitionsMatched: 0,
    // Past the publication delay, in the footprint and daylight, with no image: the old land-coast rule against the per-mission one.
    expectedWithoutImageLandCoastRule: 0, expectedWithoutImageMissionRule: 0,
  };
}

// CelesTrak serves GROUP=active once per two-hour update; --elements reads a saved GP JSON array instead.
async function orbitElements(): Promise<Array<{ NORAD_CAT_ID: number; EPOCH: string }>> {
  const elementsIndex = process.argv.indexOf('--elements');
  if (elementsIndex > 0) return JSON.parse(readFileSync(process.argv[elementsIndex + 1]!, 'utf8'));
  const gp = await fetch(CELESTRAK_ACTIVE_URL, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(120_000) });
  if (!gp.ok) throw new Error(`CelesTrak ${gp.status}: ${(await gp.text()).slice(0, 200)}`);
  return gp.json();
}

async function main() {
  const nowMs = Date.now();
  const window = { startMs: nowMs - LOOKBACK_DAYS * DAY_MS, endMs: nowMs };
  const records = await orbitElements();
  const epochs = new Map(records.map((record) => [record.NORAD_CAT_ID, record.EPOCH]));
  const satellites: CatalogSatellite[] = selectProfiledSatellites(records)
    .filter((s: { profileId: string }) => PROFILES.includes(s.profileId as ImagingProfileId))
    .map((s: { noradId: number; name: string; profileId: string; elements: never }) => ({ noradId: s.noradId, name: s.name, profileId: s.profileId, elementSets: [s.elements] }));

  const totals = Object.fromEntries(PROFILES.map((p) => [p, emptyTally()]));
  const places: Record<string, unknown> = {};
  const failures: string[] = [];
  for (const [name, point] of Object.entries(PLACES)) {
    const job = await runPassJob({ point, window, nowMs, satellites });
    if (!job) throw new Error('pass job cancelled');
    const evidence = await findArchiveEvidence({ ...job, point, window, nowMs, catalog: { status: 'fresh', fetchedAt: nowMs, inventoryVersion: 'live' } as never, computedOn: 'main-thread' } as never, { timeoutMs: 60_000 });
    failures.push(...evidence.failures.filter((f) => ['earth-search', 'planetary-computer'].includes(f.archive)).map((f) => `${name}: ${f.archive} ${f.reason}`));
    const tally = Object.fromEntries(PROFILES.map((p) => [p, emptyTally()]));
    for (const pass of evidence.passes) {
      const profile = profileFor(pass.profileId);
      if (!profile || !PROFILES.includes(pass.profileId as ImagingProfileId) || pass.opportunity) continue;
      const t = tally[pass.profileId]!;
      t.pastPasses++;
      if (pass.edgeOfSwath) t.edgeOfSwath++;
      if (pass.tier.kind === 'confirmed-image') {
        t.confirmed++;
        if (pass.tier.note === 'geometry-disagreed') t.confirmedGeometryDisagreed++;
      } else if (pass.tier.kind === 'likely-imaged') t.likelyImaged++;
      else if (pass.tier.kind === 'passed-overhead' && pass.tier.note === 'not-in-archive') t.notInArchive++;
      else t.passedOverheadOther++;
      const daylight = profile.category !== 'open-optical' || pass.sunElevationDeg >= OPTICAL_MIN_SUN_ELEVATION_DEG;
      const pastWait = nowMs - pass.timeMs >= (profile.archiveWaitHours ?? 0) * HOUR_MS;
      if (pass.tier.kind !== 'confirmed-image' && pass.inFootprint && daylight && pastWait) {
        if (isLandOrCoast(point.lat, point.lon)) t.expectedWithoutImageLandCoastRule++;
        if (pass.coverage) t.expectedWithoutImageMissionRule++;
      }
    }
    for (const acquisition of evidence.acquisitions) {
      const t = tally[acquisition.profileId];
      if (!t) continue;
      t.acquisitions++;
      if (acquisition.pass) t.acquisitionsMatched++;
    }
    for (const profileId of PROFILES) {
      for (const [key, value] of Object.entries(tally[profileId]!)) (totals[profileId] as Record<string, number>)[key] += value;
    }
    places[name] = { ...point, status: evidence.status, unansweredProfiles: evidence.unansweredProfiles, tally };
    console.log(name, JSON.stringify(tally));
  }

  const result = {
    generator: 'scripts/orbital-live-check.mts',
    ranAt: new Date(nowMs).toISOString(),
    window: isoRange(window.startMs, window.endMs),
    archives: Object.fromEntries(PROFILES.map((p) => [p, PROFILE_ARCHIVES[p]])),
    satellites: satellites.map((s) => `${s.name} (${s.profileId}), elements epoch ${epochs.get(s.noradId)}`),
    totals,
    places,
    archiveFailures: failures,
    publicationLag: await publicationLag(nowMs),
    coverage: await coverageProbes(nowMs),
  };
  const outIndex = process.argv.indexOf('--out');
  const json = `${JSON.stringify(result, null, 2)}\n`;
  if (outIndex > 0) writeFileSync(process.argv[outIndex + 1]!, json);
  console.log(JSON.stringify({ totals, publicationLag: result.publicationLag }, null, 2));
}

await main();
