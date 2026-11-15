#!/usr/bin/env node
// Offline replay of the watched-site change scorer over recorded archive statistics, so the
// shadow-exit targets (#10615) are measured by a committed script rather than by hand.
//
//   node scripts/replay-orbital-change.mjs                 replay the committed sample and the known-change fixtures
//   node scripts/replay-orbital-change.mjs --json          the same, as JSON
//   node scripts/replay-orbital-change.mjs --threshold absoluteFloorDb=2 --threshold spreadMultiplier=4
//   node scripts/replay-orbital-change.mjs record --end 2026-11-14   re-record the sample (network)
//
// The sample protocol is the one #10651 reported: 90 days of Sentinel-1 scenes at 30 watched
// land sites taken at a fixed stride through the registry, scored with no archive backfill, so
// each geometry's first scenes build its baseline. "Likely environmental" is inferred from the
// share of permanent water in the footprint; it is not a hand review of the imagery.
import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHANGE_THRESHOLDS } from './shared/orbital/flag-record.js';
import {
  changeScoringExclusions,
  footprintFeature,
  RADAR_COLLECTION,
  radarGeometry,
  scoreSiteChange,
  STAC_RADAR_FIELDS,
} from './_orbital-change.mjs';
import { isMainModule } from './lib/main-module.mjs';
import { SITE_WATER_PERCENT } from './shared/orbital-site-water.mjs';
import { WATCHED_SITES } from './shared/orbital-watched-sites.generated.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DAY_MS = 86_400_000;
export const SAMPLE_FIXTURE = 'tests/fixtures/orbital/change-replay-sample/sample-90d-30-sites.json';
export const KNOWN_CHANGE_DIR = 'tests/fixtures/orbital/change-replay';
export const SAMPLE_SITES = 30;
export const SAMPLE_DAYS = 90;
/** A confirmed flag at a site whose footprint is at least this much water is counted as likely environmental. */
export const ENVIRONMENTAL_WATER_PERCENT = 5;
/** Shadow-exit targets from the #10615 plan's success criteria. */
export const TARGETS = Object.freeze({ maxRetractedShare: 0.1, maxEnvironmentalShare: 0.25, minKnownChangeShare: 0.5 });

/** Registry land sites at a fixed stride, so the sample spans the registry rather than its first letters. */
export function sampleSites(sites = WATCHED_SITES, count = SAMPLE_SITES) {
  const land = sites.filter((site) => site.surface === 'land').sort((a, b) => a.id.localeCompare(b.id));
  const stride = Math.max(1, Math.floor(land.length / count));
  return Array.from({ length: Math.min(count, land.length) }, (_, i) => land[i * stride]);
}

/** Recorded scenes as the acquisitions the seeder hands the scorer. */
export function recordedAcquisitions(scenes) {
  return scenes.map((recorded) => ({
    itemId: recorded.itemId,
    datetime: recorded.datetime,
    platform: recorded.platform,
    radar: radarGeometry({
      'sat:relative_orbit': recorded.relativeOrbit,
      'sat:orbit_state': recorded.orbitState,
      'sar:instrument_mode': recorded.mode,
      'sar:polarizations': recorded.polarizations,
    }),
  }));
}

/** Every event the scorer emits over one recorded series, scored once with no backfill. */
export async function replaySeries({ site, scenes, thresholds = CHANGE_THRESHOLDS }) {
  const statistics = new Map(scenes.map((recorded) => [recorded.itemId, recorded.statistics]));
  const nowMs = Math.max(...scenes.map((recorded) => Date.parse(recorded.datetime))) + DAY_MS;
  const { flag } = await scoreSiteChange({
    site: { ...site, surface: 'land' },
    acquisitions: recordedAcquisitions(scenes),
    previous: null,
    fetchStatistics: async (scene) => statistics.get(scene.itemId) ?? null,
    nowMs,
    deadlineMs: Infinity,
    thresholds,
    maxEvents: Infinity,
  });
  return flag.events;
}

/** The first raise inside each known event's window; a raise before the event or after the window does not count. */
export async function replayKnownChanges({ dir = join(ROOT, KNOWN_CHANGE_DIR), thresholds } = {}) {
  const results = [];
  for (const file of readdirSync(dir).filter((name) => name.endsWith('.json')).sort()) {
    const fixture = JSON.parse(readFileSync(join(dir, file), 'utf8'));
    const events = await replaySeries({ site: { id: file, ...fixture.point }, scenes: fixture.scenes, thresholds });
    const startMs = Date.parse(fixture.event.date);
    const endMs = startMs + fixture.event.windowDays * DAY_MS;
    const raises = events.filter((event) => event.kind === 'raised');
    const inWindow = raises.find((event) => Date.parse(event.datetime) >= startMs && Date.parse(event.datetime) <= endMs) ?? null;
    results.push({
      file,
      event: fixture.event.name,
      eventDate: fixture.event.date,
      windowDays: fixture.event.windowDays,
      detected: inWindow !== null,
      firstRaiseInWindow: inWindow?.datetime ?? null,
      raisesOutsideWindow: raises.filter((event) => event !== inWindow).map((event) => event.datetime),
    });
  }
  return results;
}

/** Event counts over the recorded sample, for every sampled site and for the sites this scorer still scores. */
export async function replaySample({ fixture = JSON.parse(readFileSync(join(ROOT, SAMPLE_FIXTURE), 'utf8')), thresholds } = {}) {
  const excluded = changeScoringExclusions(WATCHED_SITES, SITE_WATER_PERCENT);
  const sites = [];
  for (const recorded of fixture.sites) {
    const events = recorded.scenes.length ? await replaySeries({ site: recorded, scenes: recorded.scenes, thresholds }) : [];
    const count = (kind) => events.filter((event) => event.kind === kind).length;
    sites.push({
      id: recorded.id,
      waterPercent: recorded.waterPercent,
      excluded: excluded.get(recorded.id) ?? null,
      scenes: recorded.scenes.length,
      raised: count('raised'),
      confirmed: count('confirmed'),
      retracted: count('retracted'),
      confirmations: events.filter((event) => event.kind === 'confirmed').map((event) => ({
        datetime: event.datetime,
        components: event.changes.map((change) => `${change.component} ${change.deltaDb > 0 ? '+' : ''}${change.deltaDb} dB`),
      })),
    });
  }
  const totals = (list) => {
    const raised = list.reduce((sum, site) => sum + site.raised, 0);
    const confirmed = list.reduce((sum, site) => sum + site.confirmed, 0);
    const retracted = list.reduce((sum, site) => sum + site.retracted, 0);
    const environmental = list.reduce((sum, site) => sum + (site.waterPercent >= ENVIRONMENTAL_WATER_PERCENT ? site.confirmed : 0), 0);
    const resolved = confirmed + retracted;
    return {
      sites: list.length,
      sitesWithScenes: list.filter((site) => site.scenes > 0).length,
      raised,
      confirmed,
      retracted,
      resolved,
      retractedShare: resolved ? Math.round((1000 * retracted) / resolved) / 1000 : null,
      likelyEnvironmental: environmental,
      environmentalShare: confirmed ? Math.round((1000 * environmental) / confirmed) / 1000 : null,
    };
  };
  return { window: { start: fixture.start, end: fixture.end }, all: totals(sites), scored: totals(sites.filter((site) => !site.excluded)), sites };
}

export async function replay({ thresholds = CHANGE_THRESHOLDS } = {}) {
  const sample = await replaySample({ thresholds });
  const known = await replayKnownChanges({ thresholds });
  const detected = known.filter((result) => result.detected).length;
  const scored = sample.scored;
  return {
    thresholds,
    sample,
    knownChanges: { detected, of: known.length, results: known },
    targets: {
      retractedShare: { value: scored.retractedShare, max: TARGETS.maxRetractedShare, met: scored.resolved > 0 && scored.retractedShare < TARGETS.maxRetractedShare },
      environmentalShare: { value: scored.environmentalShare, max: TARGETS.maxEnvironmentalShare, met: scored.confirmed > 0 && scored.environmentalShare <= TARGETS.maxEnvironmentalShare },
      knownChangeShare: { value: known.length ? detected / known.length : null, min: TARGETS.minKnownChangeShare, met: known.length > 0 && detected / known.length >= TARGETS.minKnownChangeShare },
    },
  };
}

// --- recording (network) ---

const STAC_SEARCH_URL = 'https://planetarycomputer.microsoft.com/api/stac/v1/search';
const USER_AGENT = 'WorldMonitor-Seed/1.0 (https://www.worldmonitor.app)';
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function postJson(url, body) {
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'User-Agent': USER_AGENT, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    if (response.ok) return response.json();
    await response.body?.cancel();
    if (attempt >= 3 || ![429, 500, 502, 503, 504].includes(response.status)) throw new Error(`HTTP ${response.status} for ${url}`);
    await pause(2_000 * 2 ** attempt);
  }
}

async function recordSite(site, startIso, endIso) {
  const features = [];
  let body = {
    collections: [RADAR_COLLECTION],
    intersects: { type: 'Point', coordinates: [site.lon, site.lat] },
    datetime: `${startIso}/${endIso}`,
    sortby: [{ field: 'properties.datetime', direction: 'asc' }],
    limit: 100,
    fields: { include: ['id', 'properties.datetime', 'properties.platform', ...STAC_RADAR_FIELDS], exclude: ['assets', 'links', 'geometry', 'bbox'] },
  };
  for (let page = 0; body && page < 10; page += 1) {
    const json = await postJson(STAC_SEARCH_URL, body);
    features.push(...(json.features ?? []));
    const next = json.links?.find((link) => link.rel === 'next');
    body = next?.body ? { ...body, ...next.body } : null;
  }
  const radarFeatures = features.map((feature) => ({ feature, radar: radarGeometry(feature.properties) })).filter(({ radar }) => radar);
  const scenes = new Array(radarFeatures.length);
  let next = 0;
  // Four requests in flight, started at most four a second: the seeder's archive rate.
  const worker = async () => {
    while (next < radarFeatures.length) {
      const i = next++;
      const { feature, radar } = radarFeatures[i];
      await pause(i < 4 ? i * 250 : 1_000);
      const assets = radar.polarizations.map((pol) => `assets=${pol.toLowerCase()}`).join('&');
      let statistics = null;
      try {
        const json = await postJson(`https://planetarycomputer.microsoft.com/api/data/v1/item/statistics?collection=${RADAR_COLLECTION}&item=${encodeURIComponent(feature.id)}&${assets}`, footprintFeature(site));
        statistics = {};
        for (const [band, value] of Object.entries(json?.properties?.statistics ?? {})) {
          statistics[band] = { median: value.median, percentile_98: value.percentile_98, valid_percent: value.valid_percent };
        }
      } catch (error) {
        // A scene the service keeps failing on is recorded without statistics, as the seeder skips it.
        console.error(`  ${site.id}: no statistics for ${feature.id} (${error.message})`);
      }
      scenes[i] = {
        itemId: feature.id,
        datetime: feature.properties.datetime,
        platform: feature.properties.platform ?? null,
        relativeOrbit: radar.relativeOrbit,
        orbitState: radar.orbitState,
        mode: radar.mode,
        polarizations: radar.polarizations,
        statistics,
      };
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  return scenes;
}

async function record(endDate) {
  const endMs = Date.parse(`${endDate}T00:00:00Z`);
  if (!Number.isFinite(endMs)) throw new Error('record needs --end YYYY-MM-DD');
  const start = new Date(endMs - SAMPLE_DAYS * DAY_MS).toISOString();
  const end = new Date(endMs).toISOString();
  // Sites already recorded for the same window are kept in a sidecar file, so an interrupted recording resumes.
  const partialPath = join(ROOT, `${SAMPLE_FIXTURE}.partial`);
  let partial = {};
  try {
    const saved = JSON.parse(readFileSync(partialPath, 'utf8'));
    if (saved.start === start && saved.end === end) partial = saved.sites;
  } catch { /* no partial recording */ }
  const sites = [];
  for (const site of sampleSites()) {
    const scenes = partial[site.id] ?? await recordSite(site, start, end);
    partial[site.id] = scenes;
    writeFileSync(partialPath, JSON.stringify({ start, end, sites: partial }));
    console.error(`  ${site.id}: ${scenes.length} scenes`);
    sites.push({ id: site.id, lat: site.lat, lon: site.lon, countryCode: site.countryCode, waterPercent: SITE_WATER_PERCENT[site.id] ?? null, scenes });
  }
  rmSync(partialPath, { force: true });
  const fixture = { protocol: `${SAMPLE_DAYS}-day Sentinel-1 replay, ${SAMPLE_SITES} land sites at a fixed registry stride, no backfill`, recordedAt: new Date().toISOString().slice(0, 10), start, end, sites };
  writeFileSync(join(ROOT, SAMPLE_FIXTURE), `${JSON.stringify(fixture)}\n`);
  console.error(`wrote ${SAMPLE_FIXTURE}`);
}

function parseThresholds(args) {
  const thresholds = { ...CHANGE_THRESHOLDS };
  args.forEach((arg, i) => {
    if (arg !== '--threshold') return;
    const [name, value] = String(args[i + 1]).split('=');
    if (!(name in thresholds) || !Number.isFinite(Number(value))) throw new Error(`unknown threshold ${args[i + 1]}`);
    thresholds[name] = Number(value);
  });
  return thresholds;
}

function printReport(result) {
  const { sample, knownChanges, targets } = result;
  const row = (label, t) => `${label}: ${t.sites} sites (${t.sitesWithScenes} with scenes), ${t.raised} raised, ${t.confirmed} confirmed, ${t.retracted} retracted; retracted ${t.retracted}/${t.resolved} resolved; likely environmental ${t.likelyEnvironmental}/${t.confirmed} confirmed`;
  console.log(`Thresholds: ${JSON.stringify(result.thresholds)}`);
  console.log(`Sample ${sample.window.start.slice(0, 10)} to ${sample.window.end.slice(0, 10)}`);
  console.log(`  ${row('All sampled', sample.all)}`);
  console.log(`  ${row('Still scored', sample.scored)}`);
  for (const site of sample.sites.filter((s) => s.confirmed > 0 || s.retracted > 0)) {
    console.log(`    ${site.id}${site.excluded ? ` [excluded: ${site.excluded}]` : ''} water ${site.waterPercent}%: ${site.raised} raised, ${site.confirmed} confirmed, ${site.retracted} retracted${site.confirmations.length ? `; confirmed ${site.confirmations.map((c) => `${c.datetime.slice(0, 10)} (${c.components.join(', ')})`).join('; ')}` : ''}`);
  }
  console.log(`Known changes: ${knownChanges.detected} of ${knownChanges.of} raised inside their window`);
  for (const k of knownChanges.results) {
    console.log(`  ${k.file} ${k.event} ${k.eventDate} +${k.windowDays}d: ${k.detected ? `raised ${k.firstRaiseInWindow.slice(0, 10)}` : 'missed'}${k.raisesOutsideWindow.length ? `; outside window: ${k.raisesOutsideWindow.map((d) => d.slice(0, 10)).join(', ')}` : ''}`);
  }
  for (const [name, target] of Object.entries(targets)) console.log(`Target ${name}: ${target.value} (${'max' in target ? `max ${target.max}` : `min ${target.min}`}) ${target.met ? 'met' : 'NOT met'}`);
}

async function main(args) {
  if (args[0] === 'record') {
    const end = args[args.indexOf('--end') + 1];
    return record(args.includes('--end') ? end : new Date().toISOString().slice(0, 10));
  }
  const result = await replay({ thresholds: parseThresholds(args) });
  if (args.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else printReport(result);
}

if (isMainModule(import.meta.url, process.argv[1])) main(process.argv.slice(2)).catch((error) => { console.error(error); process.exit(1); });
