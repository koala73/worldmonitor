// Candidate orbit-manoeuvre detection from a history of mean orbit elements (#9110).
//
// Pure: no I/O, no clock. The seeder supplies the history and `nowMs`.
//
// Each satellite's history is turned into three series: semi-major axis, inclination, and the
// RAAN left over after J2 nodal regression is removed. A step is a candidate manoeuvre when the
// element at one epoch leaves the trend of the baseline window before it by more than the
// threshold, and the next epoch confirms the new level. A one-epoch jump that the next epoch
// does not repeat is an element-set refit, not a burn.
//
// Fails closed: a satellite without a full baseline, with a stale newest epoch, with a gap
// between the compared epochs, or decaying towards re-entry gets no candidate and a status
// that says why. No candidate never means "no manoeuvre".

export const MANEUVER_DETECTION_VERSION = 1;

const MU_KM3_S2 = 398_600.4418;
const EARTH_RADIUS_KM = 6378.137;
const J2 = 1.082_626_68e-3;
const DAY_MS = 86_400_000;
const DEG = Math.PI / 180;
const GEO_RADIUS_KM = 42_164;

export const DEFAULT_DETECTION_OPTIONS = Object.freeze({
  // Length of the trend window before a compared epoch. The history must reach this far back.
  baselineDays: 10,
  // Fewest epochs the baseline window must hold.
  minBaselineEpochs: 5,
  // A compared or confirming epoch further than this from its neighbour is not compared.
  maxGapDays: 3,
  // A satellite whose newest epoch is older than this is not evaluated.
  maxEpochAgeDays: 3,
  // Threshold = max(regime floor, sigmaMultiplier x robust scatter of the baseline residuals).
  sigmaMultiplier: 6,
  // The confirming epoch must keep at least this fraction of the step, with the same sign.
  confirmFraction: 0.5,
  // Perigee below this altitude is decay towards re-entry: semi-major axis falls fast and
  // irregularly, so the satellite is not evaluated.
  decayPerigeeKm: 250,
});

// Floors per orbit regime, in km for semi-major axis and degrees for the angles.
// RAAN is not compared below `raanMinInclinationDeg`, where the node is poorly defined.
export const REGIME_FLOORS = Object.freeze({
  leo: Object.freeze({ semiMajorAxis: 0.2, inclination: 0.01, raan: 0.02, raanMinInclinationDeg: 1 }),
  meo: Object.freeze({ semiMajorAxis: 1, inclination: 0.01, raan: 0.02, raanMinInclinationDeg: 1 }),
  geo: Object.freeze({ semiMajorAxis: 2, inclination: 0.02, raan: 0.2, raanMinInclinationDeg: 1 }),
  heo: Object.freeze({ semiMajorAxis: 5, inclination: 0.05, raan: 0.1, raanMinInclinationDeg: 1 }),
});

const ELEMENT_UNITS = Object.freeze({ semiMajorAxis: 'km', inclination: 'deg', raan: 'deg' });

/** A finite number from a number or a numeric string; null for anything else, so a missing value never becomes 0. */
function finite(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || value.trim() === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

const ZONED = /[zZ]|[+-]\d\d:\d\d$/;

function parseEpochMs(epoch) {
  if (typeof epoch === 'number') return Number.isFinite(epoch) ? epoch : null;
  if (typeof epoch !== 'string' || epoch.length === 0) return null;
  const ms = Date.parse(ZONED.test(epoch) ? epoch : `${epoch}Z`);
  if (!Number.isFinite(ms)) return null;
  // Date.parse rolls an impossible day over (2026-02-30 becomes 2 March). The calendar day the
  // epoch states must exist, whatever its zone: checked on the stated date, not the parsed instant,
  // so a valid offset epoch that crosses a UTC day boundary still passes.
  const day = /^(\d{4})-(\d{2})-(\d{2})/.exec(epoch);
  if (day) {
    const stated = new Date(Date.UTC(Number(day[1]), Number(day[2]) - 1, Number(day[3])));
    if (stated.getUTCFullYear() !== Number(day[1]) || stated.getUTCMonth() + 1 !== Number(day[2]) || stated.getUTCDate() !== Number(day[3])) return null;
  }
  return ms;
}

/**
 * One history entry from a CelesTrak OMM record, or null when a field is missing.
 * `epoch` is epoch milliseconds; angles are degrees; `meanMotion` is revolutions per day.
 */
export function historyEntryFromOmm(omm) {
  if (!omm || typeof omm !== 'object') return null;
  const entry = {
    noradId: finite(omm.NORAD_CAT_ID),
    epoch: parseEpochMs(omm.EPOCH),
    meanMotion: finite(omm.MEAN_MOTION),
    eccentricity: finite(omm.ECCENTRICITY),
    inclination: finite(omm.INCLINATION),
    raan: finite(omm.RA_OF_ASC_NODE),
    bstar: finite(omm.BSTAR),
  };
  return validEntry(entry) ? entry : null;
}

/** True for an entry this module can read: integer NORAD id, epoch milliseconds, finite elements. */
export function isHistoryEntry(entry) {
  return validEntry(entry);
}

function validEntry(entry) {
  return Boolean(entry)
    && Number.isInteger(entry.noradId) && entry.noradId > 0
    && Number.isFinite(entry.epoch)
    && Number.isFinite(entry.meanMotion) && entry.meanMotion > 0
    && Number.isFinite(entry.eccentricity) && entry.eccentricity >= 0 && entry.eccentricity < 1
    && Number.isFinite(entry.inclination) && entry.inclination >= 0 && entry.inclination <= 180
    && Number.isFinite(entry.raan)
    && (entry.bstar === null || Number.isFinite(entry.bstar));
}

/** Semi-major axis in km from mean motion in revolutions per day. */
export function semiMajorAxisKm(meanMotionRevPerDay) {
  const n = (meanMotionRevPerDay * 2 * Math.PI) / 86_400;
  return Math.cbrt(MU_KM3_S2 / (n * n));
}

/** Secular J2 nodal regression in degrees per day. */
export function j2RaanRateDegPerDay({ meanMotion, eccentricity, inclination }) {
  const a = semiMajorAxisKm(meanMotion);
  const p = a * (1 - eccentricity * eccentricity);
  const nRadPerDay = meanMotion * 2 * Math.PI;
  return (-1.5 * nRadPerDay * J2 * (EARTH_RADIUS_KM / p) ** 2 * Math.cos(inclination * DEG)) / DEG;
}

export function orbitRegime({ meanMotion, eccentricity }) {
  const a = semiMajorAxisKm(meanMotion);
  if (eccentricity >= 0.25) return 'heo';
  if (Math.abs(a - GEO_RADIUS_KM) <= 500 && eccentricity < 0.05) return 'geo';
  if (a - EARTH_RADIUS_KM < 2000) return 'leo';
  return 'meo';
}

function wrapDeg(deg) {
  return ((((deg + 180) % 360) + 360) % 360) - 180;
}

function fitLine(points) {
  const n = points.length;
  let st = 0; let sy = 0;
  for (const { t, y } of points) { st += t; sy += y; }
  const mt = st / n; const my = sy / n;
  let num = 0; let den = 0;
  for (const { t, y } of points) { num += (t - mt) * (y - my); den += (t - mt) ** 2; }
  const slope = den > 0 ? num / den : 0;
  return { predict: (t) => my + slope * (t - mt), slope };
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function robustSigma(residuals) {
  const m = median(residuals);
  return 1.4826 * median(residuals.map((r) => Math.abs(r - m)));
}

/** Sorted, de-duplicated (one entry per epoch, last wins) valid entries for one satellite. */
function cleanHistory(entries) {
  const byEpoch = new Map();
  for (const entry of entries) if (validEntry(entry)) byEpoch.set(entry.epoch, entry);
  return [...byEpoch.values()].sort((a, b) => a.epoch - b.epoch);
}

/**
 * Series per element, t in days since the first epoch. RAAN is J2-corrected and unwrapped.
 * The J2 rate comes from the satellite's median elements, not each epoch's own, so one bad
 * element set (a refit) cannot leave a lasting step in the cumulative node series.
 */
function buildSeries(history) {
  const t0 = history[0].epoch;
  const rate = j2RaanRateDegPerDay({
    meanMotion: median(history.map((e) => e.meanMotion)),
    eccentricity: median(history.map((e) => e.eccentricity)),
    inclination: median(history.map((e) => e.inclination)),
  });
  const sma = [];
  const inc = [];
  const raan = [];
  let residualRaan = 0;
  history.forEach((entry, k) => {
    const t = (entry.epoch - t0) / DAY_MS;
    sma.push({ t, y: semiMajorAxisKm(entry.meanMotion) });
    inc.push({ t, y: entry.inclination });
    if (k > 0) {
      const prev = history[k - 1];
      const dtDays = (entry.epoch - prev.epoch) / DAY_MS;
      residualRaan += wrapDeg(entry.raan - prev.raan - rate * dtDays);
    }
    raan.push({ t, y: residualRaan });
  });
  return { semiMajorAxis: sma, inclination: inc, raan };
}

function summarize(entry) {
  return {
    epoch: new Date(entry.epoch).toISOString(),
    meanMotion: entry.meanMotion,
    semiMajorAxisKm: Number(semiMajorAxisKm(entry.meanMotion).toFixed(3)),
    eccentricity: entry.eccentricity,
    inclination: entry.inclination,
    raan: entry.raan,
    bstar: entry.bstar,
  };
}

const round = (value, digits = 4) => Number(value.toFixed(digits));

/**
 * Candidate manoeuvres for one satellite's history.
 *
 * `dragDisturbed(fromMs, toMs)` answers whether atmospheric drag was disturbed (for example a
 * geomagnetic storm) over an interval: true, false, or null when unknown. Without a `false`
 * answer, a fall in semi-major axis in LEO is never flagged, because a storm drag spike looks
 * the same. A rise is always eligible: drag cannot raise an orbit.
 */
export function detectSatelliteManeuvers(entries, { nowMs, dragDisturbed, options: overrides } = {}) {
  const options = { ...DEFAULT_DETECTION_OPTIONS, ...overrides };
  const history = cleanHistory(Array.isArray(entries) ? entries : []);
  const noradId = history[0]?.noradId ?? null;
  if (history.length === 0) return { noradId, status: 'no-history', candidates: [] };

  const newest = history.at(-1);
  if (!Number.isFinite(nowMs)) throw new TypeError('detectSatelliteManeuvers needs nowMs');
  if (nowMs - newest.epoch > options.maxEpochAgeDays * DAY_MS) {
    return { noradId, status: 'stale', newestEpoch: new Date(newest.epoch).toISOString(), candidates: [] };
  }
  const perigeeKm = semiMajorAxisKm(newest.meanMotion) * (1 - newest.eccentricity) - EARTH_RADIUS_KM;
  if (perigeeKm < options.decayPerigeeKm) {
    return { noradId, status: 'decaying', perigeeKm: round(perigeeKm, 1), candidates: [] };
  }

  const regime = orbitRegime(newest);
  const floors = REGIME_FLOORS[regime];
  const series = buildSeries(history);
  const candidates = [];
  let comparedSteps = 0;
  // The newest step that can be judged is the one the newest epoch confirms.
  const latestK = history.length - 2;
  let latestJudged = false;
  let latestBlockedByGap = false;

  for (const element of Object.keys(ELEMENT_UNITS)) {
    const points = series[element];
    // The baseline never reaches back across a flagged step: the trend restarts after a burn.
    let baselineStart = 0;
    // Epochs that left the trend for one epoch only (refits): kept out of every later baseline.
    const refits = new Set();
    for (let k = 1; k + 1 < points.length; k++) {
      const prevT = points[k - 1].t;
      const windowStart = prevT - options.baselineDays;
      if (points[k].t - prevT > options.maxGapDays || points[k + 1].t - points[k].t > options.maxGapDays) {
        if (k === latestK) latestBlockedByGap = true;
        continue;
      }
      if (points[baselineStart].t > windowStart) continue;
      const indices = [];
      for (let i = baselineStart; i < k; i++) if (!refits.has(i) && points[i].t >= windowStart) indices.push(i);
      if (indices.length < options.minBaselineEpochs) continue;
      // The fitted baseline itself must cover the window: no gap at its start, inside it, or before the step.
      const times = [...indices.map((i) => points[i].t), prevT];
      if (times[0] - windowStart > options.maxGapDays || times.some((t, i) => i > 0 && t - times[i - 1] > options.maxGapDays)) {
        if (k === latestK) latestBlockedByGap = true;
        continue;
      }
      // The node is compared only where every epoch the comparison uses is inclined enough to define it.
      if (element === 'raan') {
        const used = [...indices, k - 1, k, k + 1];
        if (used.some((i) => history[i].inclination < floors.raanMinInclinationDeg)) continue;
      }
      const baseline = indices.map((i) => points[i]);

      comparedSteps++;
      if (k === latestK) latestJudged = true;
      const fit = fitLine(baseline);
      const sigma = robustSigma(baseline.map((p) => p.y - fit.predict(p.t)));
      const threshold = Math.max(floors[element], options.sigmaMultiplier * sigma);
      const residual = points[k].y - fit.predict(points[k].t);
      const confirming = points[k + 1].y - fit.predict(points[k + 1].t);
      if (Math.abs(residual) <= threshold) continue;
      if (Math.sign(confirming) !== Math.sign(residual) || Math.abs(confirming) < options.confirmFraction * Math.abs(residual)) {
        // The next epoch is back on the trend: epoch k was a refit, not a new level.
        if (Math.abs(confirming) <= threshold) refits.add(k);
        continue;
      }

      const from = history[k - 1];
      const to = history[k];
      if (element === 'semiMajorAxis' && regime === 'leo') {
        if (residual < 0) {
          const disturbed = typeof dragDisturbed === 'function' ? dragDisturbed(from.epoch, to.epoch) : null;
          if (disturbed !== false) continue;
        } else if (points[k].y <= points[k - 1].y) {
          // Above the trend but still falling: decay slowed (quieter drag), the orbit was not raised.
          continue;
        }
      }

      candidates.push({
        kind: 'candidate',
        noradId,
        element,
        unit: ELEMENT_UNITS[element],
        regime,
        fromEpoch: new Date(from.epoch).toISOString(),
        toEpoch: new Date(to.epoch).toISOString(),
        confirmedByEpoch: new Date(history[k + 1].epoch).toISOString(),
        expected: round(fit.predict(points[k].t)),
        observed: round(points[k].y),
        residual: round(residual),
        threshold: round(threshold),
        before: summarize(from),
        after: summarize(to),
      });
      baselineStart = k;
    }
  }

  // 'evaluated' only when the newest judgeable step was compared; otherwise say what stopped it,
  // so an empty candidate list is never read as covering the latest change.
  let status = 'evaluated';
  if (!latestJudged) status = latestBlockedByGap ? 'gap' : 'insufficient-baseline';
  return {
    noradId,
    status,
    regime,
    candidates: candidates.sort((a, b) => a.toEpoch.localeCompare(b.toEpoch) || a.element.localeCompare(b.element)),
  };
}

/**
 * Candidates for every satellite in a history list (entries for many satellites, any order).
 * Returns the candidates newest first and a per-satellite status so a reader can tell
 * "evaluated, nothing found" from "not evaluated".
 */
export function detectCandidateManeuvers(entries, { nowMs, dragDisturbed, options } = {}) {
  const bySatellite = new Map();
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!validEntry(entry)) continue;
    if (!bySatellite.has(entry.noradId)) bySatellite.set(entry.noradId, []);
    bySatellite.get(entry.noradId).push(entry);
  }
  const satellites = [];
  const candidates = [];
  for (const noradId of [...bySatellite.keys()].sort((a, b) => a - b)) {
    const result = detectSatelliteManeuvers(bySatellite.get(noradId), { nowMs, dragDisturbed, options });
    const { candidates: found, ...status } = result;
    satellites.push({ ...status, candidateCount: found.length });
    candidates.push(...found);
  }
  candidates.sort((a, b) => b.toEpoch.localeCompare(a.toEpoch) || a.noradId - b.noradId || a.element.localeCompare(b.element));
  return { version: MANEUVER_DETECTION_VERSION, candidates, satellites };
}
