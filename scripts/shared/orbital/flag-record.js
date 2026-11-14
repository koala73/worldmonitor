// The change flag of one watched land site: radar statistics of each new scene compared
// with earlier scenes taken from the same orbit geometry. Pure functions; the site seeder
// owns fetching, persistence and whether a flag is shown.

export const FLAG_SCHEMA = 1;
export const FLAG_WORDING = 'imagery statistics changed';

/**
 * Shadow-period values. They are set from the observed spread of real scene statistics
 * and are expected to move once the shadow period's flag distribution is reviewed.
 */
export const CHANGE_THRESHOLDS = Object.freeze({
  /** Scenes a geometry needs before a new scene is scored against them. */
  minBaselineScenes: 6,
  /** Newest scenes a baseline keeps. */
  maxBaselineScenes: 12,
  /** A change must exceed this many robust standard deviations of the baseline... */
  spreadMultiplier: 3,
  /** ...and this absolute difference, in decibels. */
  absoluteFloorDb: 1.5,
  /** The spread never counts as tighter than this, so a very stable baseline is not over-sensitive. */
  minSigmaDb: 0.25,
});

/** Per-track states; the site's state is the most significant state among its tracks. */
export const TRACK_STATES = Object.freeze(['baseline-building', 'monitoring', 'raised', 'confirmed']);
const SITE_STATE_RANK = { 'baseline-building': 0, monitoring: 1, raised: 2, confirmed: 3 };

export const MAX_FLAG_EVENTS = 20;

/** One baseline is one constellation, relative orbit, pass direction, mode and polarization set. */
export function geometryKey(geometry) {
  return [geometry.constellation, geometry.relativeOrbit, geometry.orbitState, geometry.mode, geometry.polarizations.join('+')].join('|');
}

export function newTrack(geometry) {
  return { geometry, state: 'baseline-building', baseline: [], candidate: null, confirmedBy: null, lastDatetime: null };
}

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const round2 = (value) => Math.round(value * 100) / 100;

/**
 * Components of `observation` that differ from the baseline by more than both the spread
 * gate and the absolute floor. A component the baseline never measured is not compared.
 */
export function changesFrom(baseline, observation, thresholds = CHANGE_THRESHOLDS) {
  const changes = [];
  for (const [component, value] of Object.entries(observation.values)) {
    const sample = baseline.map((scene) => scene.values[component]).filter(Number.isFinite);
    if (sample.length < thresholds.minBaselineScenes) continue;
    const center = median(sample);
    const sigma = Math.max(1.4826 * median(sample.map((v) => Math.abs(v - center))), thresholds.minSigmaDb);
    const delta = value - center;
    if (Math.abs(delta) >= thresholds.absoluteFloorDb && Math.abs(delta) >= thresholds.spreadMultiplier * sigma) {
      changes.push({ component, deltaDb: round2(delta), sigmaDb: round2(sigma) });
    }
  }
  return changes;
}

const sameDirection = (a, b) => a.component === b.component && Math.sign(a.deltaDb) === Math.sign(b.deltaDb);

function grow(track, observation, thresholds) {
  const baseline = [...track.baseline, observation].slice(-thresholds.maxBaselineScenes);
  const state = baseline.length >= thresholds.minBaselineScenes ? 'monitoring' : track.state;
  return { track: { ...track, state, baseline }, event: null };
}

const eventOf = (kind, observation, changes) => ({
  kind, itemId: observation.itemId, datetime: observation.datetime, platform: observation.platform, changes,
});

// What one comparable observation does to a track, per state.
const TRANSITIONS = {
  'baseline-building': grow,
  // A confirmed change becomes the new normal: the baseline restarts from the changed scenes.
  confirmed: grow,
  monitoring(track, observation, thresholds) {
    const changes = changesFrom(track.baseline, observation, thresholds);
    if (changes.length === 0) return grow(track, observation, thresholds);
    return { track: { ...track, state: 'raised', candidate: { observation, changes } }, event: eventOf('raised', observation, changes) };
  },
  raised(track, observation, thresholds) {
    const changes = changesFrom(track.baseline, observation, thresholds);
    const repeated = changes.filter((change) => track.candidate.changes.some((raised) => sameDirection(raised, change)));
    if (repeated.length > 0) {
      return {
        track: {
          ...track, state: 'confirmed', baseline: [track.candidate.observation, observation], candidate: null,
          confirmedBy: { itemId: observation.itemId, datetime: observation.datetime },
        },
        event: eventOf('confirmed', observation, repeated),
      };
    }
    if (changes.length > 0) {
      return { track: { ...track, candidate: { observation, changes } }, event: eventOf('raised', observation, changes) };
    }
    // Only a scene that measured every raised statistic can retract the change.
    if (!track.candidate.changes.every((raised) => Number.isFinite(observation.values[raised.component]))) {
      return { track, event: null };
    }
    const retracted = grow({ ...track, state: 'monitoring', candidate: null }, observation, thresholds);
    return { track: retracted.track, event: eventOf('retracted', observation, []) };
  },
};

/** Folds one observation from the track's own geometry into it. */
export function advanceTrack(track, observation, thresholds = CHANGE_THRESHOLDS) {
  const next = TRANSITIONS[track.state](track, observation, thresholds);
  return {
    track: { ...next.track, lastDatetime: observation.datetime },
    event: next.event && { geometryKey: geometryKey(track.geometry), ...next.event },
  };
}

export function siteFlagState(tracks) {
  let state = 'baseline-building';
  for (const track of Object.values(tracks)) {
    if (SITE_STATE_RANK[track.state] > SITE_STATE_RANK[state]) state = track.state;
  }
  return state;
}

/** What a country rollup carries for a site: its state and, only when confirmed, the latest scene of a still-confirmed track. */
export function projectFlag(flag) {
  if (!flag) return null;
  let confirmed = null;
  if (flag.state === 'confirmed') {
    for (const [key, track] of Object.entries(flag.tracks)) {
      if (track.state !== 'confirmed' || !track.confirmedBy) continue;
      if (!confirmed || track.confirmedBy.datetime > confirmed.datetime) confirmed = { geometryKey: key, ...track.confirmedBy };
    }
  }
  return { state: flag.state, wording: FLAG_WORDING, updatedAt: flag.updatedAt, confirmed };
}
