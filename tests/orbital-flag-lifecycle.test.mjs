// A watched site's change flag moves through baseline building, monitoring, raised and then
// confirmed or retracted, one comparable radar scene at a time. Only a scene from the same
// orbit geometry can move a track, and a change must beat both the baseline's spread and an
// absolute floor before it is raised.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  advanceTrack,
  CHANGE_THRESHOLDS,
  changesFrom,
  FLAG_WORDING,
  newTrack,
  projectFlag,
  siteFlagState,
} from '../scripts/shared/orbital/flag-record.js';

const GEOMETRY = { constellation: 'sentinel-1', relativeOrbit: 65, orbitState: 'descending', mode: 'IW', polarizations: ['VH', 'VV'] };
const BASELINE_DB = [40.0, 40.2, 39.9, 40.1, 39.8, 40.0];
const day = (n) => new Date(Date.UTC(2026, 6, 1) + n * 12 * 86_400_000).toISOString();
let sequence = 0;
const scene = (vv, vh = vv - 6) => {
  sequence += 1;
  return { itemId: `S1C_${sequence}`, datetime: day(sequence), platform: 'Sentinel-1C', values: { vv_median: vv, vh_median: vh } };
};

function fold(track, observations) {
  const events = [];
  for (const observation of observations) {
    const next = advanceTrack(track, observation);
    track = next.track;
    if (next.event) events.push(next.event);
  }
  return { track, events };
}

const monitoringTrack = () => fold(newTrack(GEOMETRY), BASELINE_DB.map((vv) => scene(vv))).track;

describe('orbital change flag lifecycle', () => {
  it('stays in baseline building after four baseline scenes and a sharp difference', () => {
    const { track, events } = fold(newTrack(GEOMETRY), [...BASELINE_DB.slice(0, 4).map((vv) => scene(vv)), scene(48)]);
    assert.equal(track.state, 'baseline-building');
    assert.deepEqual(events, []);
  });

  it('starts monitoring once the baseline holds enough scenes', () => {
    assert.equal(monitoringTrack().state, 'monitoring');
    assert.equal(monitoringTrack().baseline.length, CHANGE_THRESHOLDS.minBaselineScenes);
  });

  it('does not raise a change above the spread but below the absolute floor', () => {
    const { track, events } = fold(monitoringTrack(), [scene(41.0)]);
    assert.ok(1.0 > CHANGE_THRESHOLDS.spreadMultiplier * CHANGE_THRESHOLDS.minSigmaDb, 'the change clears the spread gate');
    assert.equal(track.state, 'monitoring');
    assert.deepEqual(events, []);
  });

  it('does not raise a change above the floor but inside a noisy baseline', () => {
    const noisy = fold(newTrack(GEOMETRY), [38, 42, 39, 41, 37.5, 42.5].map((vv) => scene(vv))).track;
    const { track } = fold(noisy, [scene(42.2)]);
    assert.equal(track.state, 'monitoring');
  });

  it('raises a change above both the spread and the floor', () => {
    const { track, events } = fold(monitoringTrack(), [scene(42.5)]);
    assert.equal(track.state, 'raised');
    assert.equal(events.length, 1);
    assert.equal(events[0].kind, 'raised');
    assert.ok(events[0].changes.some((change) => change.component === 'vv_median' && change.deltaDb >= 2));
  });

  it('confirms on the next comparable scene that changed the same way', () => {
    const { track, events } = fold(monitoringTrack(), [scene(42.5), scene(42.3)]);
    assert.equal(track.state, 'confirmed');
    assert.deepEqual(events.map((event) => event.kind), ['raised', 'confirmed']);
    assert.equal(track.baseline.length, 2, 'the baseline restarts from the changed scenes');
  });

  it('retracts on the next comparable scene that sits inside the baseline', () => {
    const { track, events } = fold(monitoringTrack(), [scene(42.5), scene(40.1)]);
    assert.equal(track.state, 'monitoring');
    assert.deepEqual(events.map((event) => event.kind), ['raised', 'retracted']);
    assert.ok(!track.baseline.some((observation) => observation.values.vv_median === 42.5), 'the retracted scene never joins the baseline');
  });

  it('does not confirm on a change in the opposite direction', () => {
    const { track, events } = fold(monitoringTrack(), [scene(42.5), scene(37.5)]);
    assert.equal(track.state, 'raised');
    assert.deepEqual(events.map((event) => event.kind), ['raised', 'raised']);
  });

  it('returns to monitoring after a confirmed change once the new baseline is built', () => {
    const { track } = fold(monitoringTrack(), [42.5, 42.3, 42.4, 42.6, 42.4, 42.5].map((vv) => scene(vv)));
    assert.equal(track.state, 'monitoring');
  });

  it('never compares a component the baseline did not measure', () => {
    const observation = { ...scene(40), values: { vv_median: 40, hh_median: 10 } };
    assert.deepEqual(changesFrom(monitoringTrack().baseline, observation), []);
  });

  it('neither confirms nor retracts a raised change from a scene that did not measure it', () => {
    const raised = fold(monitoringTrack(), [scene(42.5, 34)]).track;
    assert.deepEqual(raised.candidate.changes.map((change) => change.component), ['vv_median']);
    const next = advanceTrack(raised, { ...scene(40), values: { vh_median: 34 } });
    assert.equal(next.track.state, 'raised');
    assert.equal(next.event, null);
    assert.deepEqual(next.track.baseline, raised.baseline);
  });

  it('projects the confirming scene of a track that is still confirmed, not of a newer one that moved on', () => {
    const older = fold(monitoringTrack(), [scene(42.5), scene(42.4)]);
    const newer = fold(monitoringTrack(), [scene(42.5), scene(42.4), ...[42.3, 42.4, 42.6, 42.4].map((vv) => scene(vv))]);
    assert.equal(newer.track.state, 'monitoring');
    const flag = { state: 'confirmed', updatedAt: 1, tracks: { older: older.track, newer: newer.track }, events: [...older.events, ...newer.events] };
    const confirming = older.events.at(-1);
    assert.deepEqual(projectFlag(flag).confirmed, { geometryKey: 'older', itemId: confirming.itemId, datetime: confirming.datetime });
  });

  it('gives the site the most significant state of its tracks and projects only a confirmed scene', () => {
    const raised = fold(monitoringTrack(), [scene(42.5)]).track;
    const confirmed = fold(monitoringTrack(), [scene(42.5), scene(42.4)]);
    assert.equal(siteFlagState({ a: monitoringTrack(), b: raised }), 'raised');
    assert.equal(siteFlagState({}), 'baseline-building');
    const event = confirmed.events.at(-1);
    const flag = { state: 'confirmed', updatedAt: 1, tracks: { [event.geometryKey]: confirmed.track }, events: confirmed.events };
    assert.deepEqual(projectFlag(flag), {
      state: 'confirmed', wording: FLAG_WORDING, updatedAt: 1,
      confirmed: { geometryKey: event.geometryKey, itemId: event.itemId, datetime: event.datetime },
    });
    assert.equal(projectFlag({ state: 'raised', updatedAt: 1, tracks: { [event.geometryKey]: raised }, events: confirmed.events.slice(0, 1) }).confirmed, null);
    assert.equal(FLAG_WORDING, 'imagery statistics changed');
  });
});
