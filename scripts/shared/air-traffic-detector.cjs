'use strict';

/**
 * @notification-source: domain
 *   payload.title is built from the measured departure ratio and onset bin.
 *   Not RSS-origin; MUST NOT set payload.description.
 *   Enforced by tests/notification-relay-payload-audit.test.mjs.
 */

// National departure-collapse detector over the 5-minute air traffic series.
// Thresholds come from replaying the adsb.lol archive (tests/fixtures/
// air-traffic-archive-series.json.gz): across 111 days, holidays, the
// 2026-11-01 DST change and two regional ATC outages included, the lowest
// ordinary two-bin ratio is 0.49 (July 4 evening, 22:40Z, and Halloween
// evening, 2026-11-01 02:40Z), and single bins dip to 0.44. At 0.40 the
// 2026-11-13 national ground stop enters at 21:10Z, 16 minutes after the
// official 20:54Z stop; 0.45 entered at 20:55Z, but a single Halloween bin
// already read under it.

const { BIN_MS } = require('./air-traffic-aggregate.cjs');

const SIGNAL = 'usLowClimbingAirline';
const ENTER_RATIO = 0.4;
// Departures stayed near half of normal through the night after the
// 2026-11-13 stop was lifted at 01:15Z; an exit at 0.5 recovered at 03:35Z and
// re-entered at 11:15Z. At 0.7 the one recovery lands at 12:25Z, when the
// morning schedule was back.
const EXIT_RATIO = 0.7;
const CONSECUTIVE = 2;
// Bins whose baseline is under this share of the day's peak baseline are quiet
// hours: too few departures for a ratio to mean anything.
const QUIET_SHARE = 0.25;
// The OpenSky feed is alive. A dead feed reads near 0; ordinary days never read
// below 0.39 of Europe's same-local-time baseline, and a US stop pulls Europe
// down too (0.54 by the end of the 2026-11-13 stop), so this stays low.
const EUROPE_MIN = 0.3;
// OpenSky still sees the country. Against Wingbits for the same bin, ordinary
// bins read 0.91 to 1.02. Without a Wingbits point, against OpenSky's own
// baseline: ordinary bins never read below 0.59 and the 2026-11-13 entry read 0.87.
const COVERAGE_MIN_VS_WINGBITS = 0.8;
const COVERAGE_MIN_VS_BASELINE = 0.6;
const BASELINE_WEEKS = 4;
const MIN_BASELINE_DAYS = 2;
const US_TZ = 'America/New_York';
const EUROPE_TZ = 'Europe/Paris';
const DAY_MS = 86_400_000;

const STATES = Object.freeze({ NORMAL: 'normal', COLLAPSED: 'collapsed' });

const offsetFormatters = new Map();
// Minutes east of UTC in timeZone at instant ms.
function tzOffsetMinutes(timeZone, ms) {
  let fmt = offsetFormatters.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric',
    });
    offsetFormatters.set(timeZone, fmt);
  }
  const parts = Object.fromEntries(fmt.formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute));
  return Math.round((asUtc - Math.floor(ms / 60_000) * 60_000) / 60_000);
}

// The bin `weeks` weeks before t at the same local wall-clock time. Airline
// schedules follow local time, so across a DST change the same UTC bin is an
// hour off and reads as a collapse (it did, every morning after 2026-11-01).
function sameLocalBin(t, weeks, timeZone) {
  const guess = t - weeks * 7 * DAY_MS;
  const shifted = guess + (tzOffsetMinutes(timeZone, t) - tzOffsetMinutes(timeZone, guess)) * 60_000;
  return Math.floor(shifted / BIN_MS) * BIN_MS;
}

const isCount = (v) => Number.isInteger(v) && v >= 0;
const usable = (p, field) => p && p.status === 'ok' && isCount(p[field]);

function median(values) {
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// The same-local-time bin on each prior week.
function baselineBins(t, timeZone = US_TZ) {
  const bins = [];
  for (let w = 1; w <= BASELINE_WEEKS; w += 1) bins.push(sameLocalBin(t, w, timeZone));
  return bins;
}

// Same-local-time median of `field` over the prior weeks, or null when fewer
// than MIN_BASELINE_DAYS weeks have a usable point.
function baselineAt(t, field, getPoint, timeZone) {
  const values = baselineBins(t, timeZone).map(getPoint).filter((p) => usable(p, field)).map((p) => p[field]);
  return values.length >= MIN_BASELINE_DAYS ? median(values) : null;
}

// Largest SIGNAL baseline over the US-local day containing t, the reference
// for the quiet-hours floor.
function peakBaselineFor(t, getPoint) {
  const offset = tzOffsetMinutes(US_TZ, t) * 60_000;
  const localMidnight = Math.floor((t + offset) / DAY_MS) * DAY_MS - offset;
  let peak = 0;
  for (let bin = localMidnight; bin < localMidnight + DAY_MS; bin += BIN_MS) {
    const base = baselineAt(bin, SIGNAL, getPoint, US_TZ);
    if (base !== null && base > peak) peak = base;
  }
  return peak;
}

// One evaluation step. `getPoint(t)` returns the stored OpenSky point for bin t
// (or undefined), `wingbits` is the Wingbits point for the same bin, and
// `peakBaseline` is the largest SIGNAL baseline over the local day. Returns the
// next state and, on a transition, the event to publish.
function evaluateCollapse(state, { t, point, wingbits, getPoint, peakBaseline }) {
  // Re-evaluating the last bin (a restart, a second replica) starts from the
  // state before it, so the bin cannot raise its event twice. Only one level
  // of history is kept.
  const prev = state && state.lastT === t ? state.prior : state;
  const { prior: _older, ...prevFlat } = prev || {};
  const current = prev ? prevFlat : { state: STATES.NORMAL, run: 0, onset: null };
  const next = (verdict, extra = {}) => ({ ...current, ...extra, lastT: t, prior: prev ? prevFlat : null, verdict });

  if (!usable(point, SIGNAL) || !usable(point, 'euAirborne') || !usable(point, 'usSeen')) {
    return { state: next('gap'), event: null };
  }
  const base = baselineAt(t, SIGNAL, getPoint, US_TZ);
  const euBase = baselineAt(t, 'euAirborne', getPoint, EUROPE_TZ);
  const seenBase = baselineAt(t, 'usSeen', getPoint, US_TZ);
  if (base === null || euBase === null || seenBase === null || !(peakBaseline > 0)) {
    return { state: next('insufficient-baseline', { run: 0 }), event: null };
  }
  if (base < QUIET_SHARE * peakBaseline || base === 0) return { state: next('quiet'), event: null };

  const ratio = point[SIGNAL] / base;
  const europe = euBase > 0 ? point.euAirborne / euBase : 0;
  const coverage = usable(wingbits, 'usSeen') && wingbits.usSeen > 0
    ? { ratio: point.usSeen / wingbits.usSeen, min: COVERAGE_MIN_VS_WINGBITS, against: 'wingbits' }
    : { ratio: seenBase > 0 ? point.usSeen / seenBase : 0, min: COVERAGE_MIN_VS_BASELINE, against: 'baseline' };
  const detail = { ratio, europe, coverage: coverage.ratio, coverageAgainst: coverage.against, baseline: base };

  if (current.state === STATES.COLLAPSED) {
    // The feed checks guard entry only. Parked aircraft switch their
    // transponders off, so during a stop the national count falls with the
    // signal; a failing feed can only lower the ratio, never fake a recovery.
    const run = ratio > EXIT_RATIO ? current.run + 1 : 0;
    if (run < CONSECUTIVE) return { state: next('collapsed', { run, ...detail }), event: null };
    return {
      state: next('recovered', { state: STATES.NORMAL, run: 0, ...detail }),
      event: { kind: 'recovery', t, onset: current.onset, ...detail },
    };
  }

  if (europe < EUROPE_MIN) return { state: next('blocked-feed', { run: 0, ratio, europe }), event: null };
  if (coverage.ratio < coverage.min) {
    return { state: next('blocked-coverage', { run: 0, ratio, europe, coverage: coverage.ratio, coverageAgainst: coverage.against }), event: null };
  }

  const run = ratio < ENTER_RATIO ? current.run + 1 : 0;
  const onset = run === 1 ? t : current.onset;
  if (run < CONSECUTIVE) return { state: next('normal', { run, onset: run ? onset : null, ...detail }), event: null };
  return {
    state: next('entered', { state: STATES.COLLAPSED, run: 0, onset, ...detail }),
    event: { kind: 'collapse', t, onset, ...detail },
  };
}

const EVENT_TYPE = 'aviation_traffic_collapse';
// One collapse is one event: a retried publish of the same onset is suppressed
// for longer than any stop lasts.
const DEDUP_TTL_SECONDS = 24 * 60 * 60;
const utcTime = (t) => new Date(t).toISOString().slice(11, 16);

// The notification for a detector event. A collapse is critical, so it reaches
// realtime rules (they take critical only) and quiet hours do not hold it. The
// recovery is high: notification-relay's shouldNotify lets it through to the
// same rules, and quiet hours silence it or hold it, so it wakes no one.
function buildCollapseNotification(event) {
  const percent = Math.round(event.ratio * 100);
  const recovery = event.kind === 'recovery';
  return {
    eventType: EVENT_TYPE,
    severity: recovery ? 'high' : 'critical',
    dedupTtl: DEDUP_TTL_SECONDS,
    payload: {
      title: recovery
        ? `US airline departures back near normal (${percent}% of usual), after a drop that began ${utcTime(event.onset)} UTC`
        : `US airline departures fell to ${percent}% of normal since ${utcTime(event.onset)} UTC`,
      source: 'WorldMonitor air traffic (OpenSky)',
      countryCode: 'US',
      coalesceKey: `${EVENT_TYPE}:${event.kind}:${event.onset}`,
      ratio: Math.round(event.ratio * 1000) / 1000,
      onset: new Date(event.onset).toISOString(),
      kind: event.kind,
    },
  };
}

module.exports = {
  EVENT_TYPE, buildCollapseNotification,
  SIGNAL, ENTER_RATIO, EXIT_RATIO, CONSECUTIVE, QUIET_SHARE, EUROPE_MIN,
  COVERAGE_MIN_VS_WINGBITS, COVERAGE_MIN_VS_BASELINE, BASELINE_WEEKS, MIN_BASELINE_DAYS,
  US_TZ, EUROPE_TZ, STATES,
  tzOffsetMinutes, sameLocalBin, baselineBins, baselineAt, peakBaselineFor, evaluateCollapse,
};
