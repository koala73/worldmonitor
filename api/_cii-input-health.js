// Reader policy for the scored CII inputs that the risk-scores build reports on
// `seed-meta:intelligence:risk-scores` (see CII_HEALTH_INPUT_IDS in
// server/worldmonitor/intelligence/v1/get-risk-scores.ts; the two lists are
// pinned together by tests/cii-input-health.test.mts). Shared by /api/health
// and /api/seed-health so both surfaces grade a dead input the same way.
//
// The producer reports what it saw on that build:
//   live            the input moved at least one Tier-1 score
//   quiet           present and accepted, but moved no Tier-1 score
//                   (`quietSince` is when that started)
//   missing         the Redis key was absent
//   unusable        present, but the scorer rejected it (too old or malformed,
//                   or none of its records map to a country)
//   not_configured  disabled by deployment design (no ACLED credentials,
//                   IRAN_EVENTS_ENABLED off)
// An unreadable key rejects the whole build, so it surfaces as a stale
// riskScores seed-meta rather than as a per-input state.
//
// The reader adds two states of its own: `stale` when the input's own health
// check is past its staleness budget, and `unreported` when the producer did
// not report the input at all (fail closed).

// maxQuietMin: how long the input may move no Tier-1 score before that is
// implausible. null means quiet can be legitimate indefinitely (no Tier-1
// earthquake for months, no strikes in peacetime).
// missingIsQuiet: the producer writes only on change, so an absent key is the
// quiet state. The relay persists OREF history only when it changes, with a
// 7-day TTL, so a week without sirens expires the key.
const INPUTS = {
  acled:              { maxQuietMin: 360, sourceCheck: null },
  ucdp:               { maxQuietMin: 1440, sourceCheck: 'ucdpEvents' },
  gdeltCountryEvents: { maxQuietMin: 720, sourceCheck: 'gdeltCountryEvents' },
  iranEvents:         { maxQuietMin: null, sourceCheck: 'iranEvents' },
  strikePressure:     { maxQuietMin: null, sourceCheck: 'strikePressure' },
  oref:               { maxQuietMin: null, sourceCheck: null, missingIsQuiet: true },
  outages:            { maxQuietMin: null, sourceCheck: 'outages' },
  climate:            { maxQuietMin: null, sourceCheck: 'climateAnomalies' },
  fires:              { maxQuietMin: 1440, sourceCheck: 'wildfiresSummary' },
  gpsjam:             { maxQuietMin: 720, sourceCheck: 'gpsjam' },
  advisories:         { maxQuietMin: 1440, sourceCheck: null },
  displacement:       { maxQuietMin: 1440, sourceCheck: null },
  crossBorder:        { maxQuietMin: null, sourceCheck: null },
  newsInsights:       { maxQuietMin: 360, sourceCheck: 'newsInsights' },
  threatSummary:      { maxQuietMin: 360, sourceCheck: 'newsThreatSummary' },
  aviation:           { maxQuietMin: null, sourceCheck: 'flightDelays' },
  earthquakes:        { maxQuietMin: null, sourceCheck: 'earthquakes' },
  sanctionsPressure:  { maxQuietMin: 1440, sourceCheck: 'sanctionsPressure' },
  sanctionsCounts:    { maxQuietMin: 1440, sourceCheck: null },
  militaryCii:        { maxQuietMin: 720, sourceCheck: 'militaryCii' },
};

// A family is unfed when none of its inputs is live or plausibly quiet. The
// conflict family is the realtime event feeds behind Unrest and Conflict:
// UCDP is an annual floor and the strike feed is regional, so neither can
// stand in for them (UCDP is what hid the ACLED loss for months).
const FAMILIES = {
  conflict: ['acled', 'gdeltCountryEvents'],
  information: ['newsInsights', 'threatSummary'],
  security: ['militaryCii', 'gpsjam', 'aviation'],
};

export const CII_INPUT_POLICY = Object.freeze({
  inputs: Object.freeze(Object.fromEntries(Object.entries(INPUTS).map(([id, cfg]) => [id, Object.freeze(cfg)]))),
  families: Object.freeze(Object.fromEntries(Object.entries(FAMILIES).map(([id, members]) => [id, Object.freeze(members)]))),
});

const PRODUCER_STATES = new Set(['live', 'quiet', 'missing', 'unusable', 'not_configured']);
// Only "past its own staleness budget" marks an input stale here. Every other
// source-check fault is either reported by the producer (missing key) or
// leaves usable retained data behind (SEED_ERROR).
const STALE_SOURCE_STATUSES = new Set(['STALE_SEED']);
const QUIET_CLOCK_SKEW_MS = 5 * 60_000;

/**
 * Grade the producer's per-input report. `sourceStatuses` maps an input id to
 * its own health check's status when the caller has one (/api/health does,
 * /api/seed-health does not).
 */
export function assessCiiInputs(meta, now, sourceStatuses = {}) {
  const reported = meta && typeof meta === 'object' && meta.inputs && typeof meta.inputs === 'object'
    && !Array.isArray(meta.inputs)
    ? meta.inputs
    : null;
  const states = {};
  const dead = [];
  const notConfigured = [];
  const healthy = new Set();

  for (const [id, cfg] of Object.entries(CII_INPUT_POLICY.inputs)) {
    const report = reported?.[id];
    const state = report && PRODUCER_STATES.has(report.state) ? report.state : 'unreported';
    const sourceCheck = cfg.sourceCheck && STALE_SOURCE_STATUSES.has(sourceStatuses[id]) ? cfg.sourceCheck : null;
    states[id] = state;

    if (state === 'not_configured') {
      notConfigured.push(id);
    } else if (state === 'missing' && cfg.missingIsQuiet) {
      healthy.add(id);
    } else if (state === 'missing' || state === 'unusable' || state === 'unreported') {
      dead.push({ id, state });
    } else if (sourceCheck) {
      states[id] = 'stale';
      dead.push({ id, state: 'stale', sourceCheck });
    } else if (state === 'quiet') {
      const quietSince = Number(report.quietSince);
      // The producer stamps the clock on another instance, so allow small skew.
      const quietMin = Number.isFinite(quietSince) && quietSince > 0 && quietSince <= now + QUIET_CLOCK_SKEW_MS
        ? Math.max(0, Math.floor((now - quietSince) / 60_000))
        : null;
      if (quietMin === null) dead.push({ id, state });
      else if (cfg.maxQuietMin != null && quietMin > cfg.maxQuietMin) dead.push({ id, state, quietMin });
      else healthy.add(id);
    } else {
      healthy.add(id);
    }
  }

  const unfedFamilies = Object.entries(CII_INPUT_POLICY.families)
    .filter(([, members]) => !members.some((id) => healthy.has(id)))
    .map(([family]) => family);

  return { valid: reported !== null, states, dead, notConfigured, unfedFamilies };
}
