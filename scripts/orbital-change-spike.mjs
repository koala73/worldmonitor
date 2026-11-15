#!/usr/bin/env node
// Research spike for #10763: candidate change-detection methods replayed against the same
// committed sample and known-change fixtures as scripts/replay-orbital-change.mjs, so each
// method's row in the plan's target table is reproducible. Nothing here is used in production.
//
//   node scripts/orbital-change-spike.mjs          every method at its default and best swept setting
//   node scripts/orbital-change-spike.mjs --json
import { CHANGE_THRESHOLDS, changesFrom, geometryKey, advanceTrack, newTrack } from './shared/orbital/flag-record.js';
import { observationFromStatistics } from './_orbital-change.mjs';
import { isMainModule } from './lib/main-module.mjs';
import { recordedAcquisitions, replay, replaySeries } from './replay-orbital-change.mjs';

const DAY_MS = 86_400_000;

/** Recorded scenes as observations grouped by orbit geometry, oldest first, one per acquisition time. */
export function geometrySeries(scenes) {
  const acquisitions = recordedAcquisitions(scenes);
  const statistics = new Map(scenes.map((scene) => [scene.itemId, scene.statistics]));
  const byGeometry = new Map();
  const seen = new Set();
  for (const scene of acquisitions.filter((a) => a.radar).sort((a, b) => a.datetime.localeCompare(b.datetime))) {
    const key = geometryKey(scene.radar);
    if (seen.has(`${key}@${scene.datetime}`)) continue;
    seen.add(`${key}@${scene.datetime}`);
    const observation = observationFromStatistics(scene, statistics.get(scene.itemId));
    if (!observation) continue;
    byGeometry.set(key, [...(byGeometry.get(key) ?? []), { ...observation, geometryKey: key, geometry: scene.radar }]);
  }
  return byGeometry;
}

const event = (kind, observation, changes) => ({ kind, datetime: observation.datetime, geometryKey: observation.geometryKey, changes });
const byTime = (events) => events.sort((a, b) => a.datetime.localeCompare(b.datetime));
const sameDirection = (a, b) => a.component === b.component && Math.sign(a.deltaDb) === Math.sign(b.deltaDb);

/**
 * Method A, persistent shift: one deviating scene raises nothing. A change is raised when two
 * consecutive scenes of the same geometry deviate the same way, confirmed by a third, and
 * retracted by a scene that does not deviate. The baseline is longer (up to 20 scenes).
 */
export function persistentShift(params = {}) {
  const t = { ...CHANGE_THRESHOLDS, maxBaselineScenes: 20, absoluteFloorDb: 1, ...params };
  return async ({ scenes }) => {
    const events = [];
    for (const series of geometrySeries(scenes).values()) {
      let baseline = [];
      let run = [];
      let raised = false;
      for (const observation of series) {
        const changes = baseline.length >= t.minBaselineScenes ? changesFrom(baseline, observation, t) : [];
        const repeated = run.length ? changes.filter((c) => run.at(-1).changes.some((r) => sameDirection(r, c))) : changes;
        if (changes.length && repeated.length) {
          run.push({ observation, changes: repeated });
          if (run.length === 2) { raised = true; events.push(event('raised', observation, repeated)); }
          if (run.length === 3) {
            events.push(event('confirmed', observation, repeated));
            baseline = run.map((r) => r.observation);
            run = [];
            raised = false;
          }
          continue;
        }
        if (raised) events.push(event('retracted', observation, []));
        raised = false;
        run = changes.length ? [{ observation, changes }] : [];
        if (!changes.length) baseline = [...baseline, observation].slice(-t.maxBaselineScenes);
      }
    }
    return byTime(events);
  };
}

/**
 * Method B, cross-geometry consensus: each geometry scores its scenes against its own baseline as
 * today, but only a scene from a different geometry within `windowDays` can confirm or retract a
 * raised change; repeats from the raising geometry count for nothing.
 */
export function crossGeometryConsensus(params = {}) {
  const t = { ...CHANGE_THRESHOLDS, windowDays: 12, ...params };
  return async ({ scenes }) => {
    const series = geometrySeries(scenes);
    const timeline = [...series.values()].flat().sort((a, b) => a.datetime.localeCompare(b.datetime));
    const baselines = new Map();
    const events = [];
    let candidate = null;
    for (const observation of timeline) {
      const baseline = baselines.get(observation.geometryKey) ?? [];
      const changes = baseline.length >= t.minBaselineScenes ? changesFrom(baseline, observation, t) : [];
      if (candidate && Date.parse(observation.datetime) - Date.parse(candidate.observation.datetime) > t.windowDays * DAY_MS) {
        events.push(event('retracted', observation, []));
        candidate = null;
      }
      if (candidate && observation.geometryKey !== candidate.observation.geometryKey) {
        const repeated = changes.filter((c) => candidate.changes.some((r) => sameDirection(r, c)));
        if (repeated.length) {
          events.push(event('confirmed', observation, repeated));
          baselines.set(observation.geometryKey, [observation]);
          baselines.set(candidate.observation.geometryKey, [candidate.observation]);
          candidate = null;
          continue;
        }
        if (candidate.changes.every((r) => Number.isFinite(observation.values[r.component]))) {
          events.push(event('retracted', observation, []));
          candidate = null;
        }
      } else if (!candidate && changes.length) {
        candidate = { observation, changes };
        events.push(event('raised', observation, changes));
        continue;
      }
      if (!changes.length) baselines.set(observation.geometryKey, [...baseline, observation].slice(-t.maxBaselineScenes));
    }
    return byTime(events);
  };
}

/**
 * Method C, texture and polarization ratio: the scene statistics become differences that cancel a
 * shift common to the whole footprint (soil moisture, rain, calibration): bright-target contrast
 * (98th percentile minus median) per polarization and the VH/VV ratio. Scored by today's track.
 */
export function textureRatio(params = {}) {
  const t = { ...CHANGE_THRESHOLDS, absoluteFloorDb: 1, ...params };
  const derive = (values) => {
    const out = {};
    for (const pol of ['vh', 'vv']) {
      if (Number.isFinite(values[`${pol}_p98`]) && Number.isFinite(values[`${pol}_median`])) out[`${pol}_contrast`] = values[`${pol}_p98`] - values[`${pol}_median`];
    }
    if (Number.isFinite(values.vh_median) && Number.isFinite(values.vv_median)) out.vh_vv_ratio = values.vh_median - values.vv_median;
    return out;
  };
  return async ({ scenes }) => {
    const events = [];
    for (const [key, series] of geometrySeries(scenes)) {
      let track = newTrack(series[0].geometry);
      for (const observation of series) {
        const next = advanceTrack(track, { ...observation, values: derive(observation.values) }, t);
        track = next.track;
        if (next.event) events.push({ ...next.event, geometryKey: key });
      }
    }
    return byTime(events);
  };
}

export const METHODS = {
  current: { make: () => replaySeries, sweep: [{}] },
  'A persistent shift': {
    make: persistentShift,
    sweep: [{}, ...[0.5, 0.75, 1, 1.5].flatMap((absoluteFloorDb) => [2, 3].map((spreadMultiplier) => ({ absoluteFloorDb, spreadMultiplier })))],
  },
  'B cross-geometry consensus': {
    make: crossGeometryConsensus,
    sweep: [{}, ...[0.75, 1, 1.5, 2].flatMap((absoluteFloorDb) => [2, 3].flatMap((spreadMultiplier) => [12, 24].map((windowDays) => ({ absoluteFloorDb, spreadMultiplier, windowDays }))))],
  },
  'C texture and ratio': {
    make: textureRatio,
    sweep: [{}, ...[0.5, 0.75, 1, 1.5].flatMap((absoluteFloorDb) => [2, 3, 4].map((spreadMultiplier) => ({ absoluteFloorDb, spreadMultiplier })))],
  },
};

const summary = (result) => ({
  retracted: `${result.sample.scored.retracted} of ${result.sample.scored.resolved}`,
  environmental: `${result.sample.scored.likelyEnvironmental} of ${result.sample.scored.confirmed}`,
  known: `${result.knownChanges.detected} of ${result.knownChanges.of}`,
  knownDetail: result.knownChanges.results.map((k) => `${k.file.replace('.json', '')}: ${k.detected ? `raised ${k.firstRaiseInWindow.slice(0, 10)}` : 'missed'}${k.raisesOutsideWindow.length ? ` (+${k.raisesOutsideWindow.length} outside)` : ''}`),
  met: Object.values(result.targets).filter((target) => target.met).length,
  raised: result.sample.scored.raised,
});

export async function runSpike() {
  const rows = [];
  for (const [name, { make, sweep }] of Object.entries(METHODS)) {
    const runs = [];
    for (const params of sweep) runs.push({ params, ...summary(await replay({ scoreSeries: make(params) })) });
    const best = [...runs].sort((a, b) => b.met - a.met || Number(b.known.split(' ')[0]) - Number(a.known.split(' ')[0])
      || (Number(a.retracted.split(' ')[0]) / (Number(a.retracted.split(' of ')[1]) || 1)) - (Number(b.retracted.split(' ')[0]) / (Number(b.retracted.split(' of ')[1]) || 1)))[0];
    rows.push({ method: name, default: runs[0], best, settingsTried: runs.length });
  }
  return rows;
}

if (isMainModule(import.meta.url, process.argv[1])) {
  const rows = await runSpike();
  if (process.argv.includes('--json')) console.log(JSON.stringify(rows, null, 2));
  else {
    for (const row of rows) {
      for (const [label, run] of [['default', row.default], [`best of ${row.settingsTried}`, row.best]]) {
        console.log(`${row.method} [${label} ${JSON.stringify(run.params)}]: retracted ${run.retracted}; environmental ${run.environmental}; known ${run.known} (${run.knownDetail.join('; ')}); raised ${run.raised}; targets met ${run.met}/3`);
      }
    }
  }
}
