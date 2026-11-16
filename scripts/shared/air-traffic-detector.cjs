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
const { EUROPE_MARKETS } = require('./air-traffic-regions.cjs');

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
// The OpenSky feed is alive: the market's control count, from the other side of
// the Atlantic, is at least this share of its own baseline. A dead feed reads
// near 0; ordinary days never read below 0.39 of Europe's same-local-time
// baseline, and a US stop pulls Europe down too (0.54 by the end of the
// 2026-11-13 stop), so this stays low.
const CONTROL_MIN = 0.3;
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

const marketCount = (code, field) => (p) => p?.markets?.[code]?.[field];

// A market is what the detector watches: a departure signal, the receiver
// coverage behind it, and a control count from the other side of the Atlantic
// that only a dead feed pulls down with it. Baselines use each count's own
// local time.
const US_MARKET = Object.freeze({
  code: 'US', name: 'US', tz: US_TZ,
  enter: ENTER_RATIO, exit: EXIT_RATIO, window: 1, minBaseline: 1, coverageMinVsBaseline: COVERAGE_MIN_VS_BASELINE,
  signal: (p) => p?.[SIGNAL],
  coverage: (p) => p?.usSeen,
  control: Object.freeze({ tz: EUROPE_TZ, read: (p) => p?.euAirborne }),
});
// European markets, from replaying adsb.lol archive days (tests/fixtures/
// air-traffic-archive-series.json.gz). A market has 4 to 17 departures per
// bin, so ratios are summed over a 20-minute window. The UK NATS flight-plan
// failure of 2026-09-08 reads 0.24 at entry (12:10Z); the lowest ordinary
// windows are 0.42 (Spain, Italy) and 0.50 or more elsewhere. Italy's
// 2026-09-30 four-hour ATC strike kept protected flights and read 0.47: a
// partial strike is not a collapse. Entry sits at 0.30: ordinary windows come
// within 0.02 of the US value of 0.40, and the NATS failure clears 0.30 by
// 0.06.
const EUROPE_ENTER_RATIO = 0.3;
const EUROPE_WINDOW_BINS = 4;
// A window summed under 30 departures is quiet hours for the market. The
// Netherlands (AMS, EIN, about 4 departures a bin) never reached it, so it is
// not a market; Italy (about 7) reaches it only around its daily peaks.
const EUROPE_MIN_WINDOW_BASELINE = 30;
// Parked aircraft drop out of the count near the hubs: during the NATS failure
// the UK read 0.62 of its usual aircraft at entry and 0.42 at the lowest, so
// the coverage floor against the market's own baseline is lower than the US one.
const EUROPE_COVERAGE_MIN_VS_BASELINE = 0.4;
const EUROPE_MARKET_NAMES = Object.freeze({ GB: 'UK', FR: 'France', DE: 'Germany', ES: 'Spain', IT: 'Italy' });
const EUROPE_DETECTOR_MARKETS = Object.freeze(EUROPE_MARKETS.map(({ code, tz }) => Object.freeze({
  code, name: EUROPE_MARKET_NAMES[code], tz,
  enter: EUROPE_ENTER_RATIO, exit: EXIT_RATIO, window: EUROPE_WINDOW_BINS, minBaseline: EUROPE_MIN_WINDOW_BASELINE, coverageMinVsBaseline: EUROPE_COVERAGE_MIN_VS_BASELINE,
  signal: marketCount(code, 'dep'),
  coverage: marketCount(code, 'seen'),
  control: Object.freeze({ tz: US_TZ, read: (p) => p?.usAirborne }),
})));
const MARKETS = Object.freeze([US_MARKET, ...EUROPE_DETECTOR_MARKETS]);

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
// `read` takes a point and returns one count from it.
const usable = (p, read) => Boolean(p) && p.status === 'ok' && isCount(read(p));

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

// Sum of `read` over the `size` bins ending at `end`, or null when any of them
// has no usable point. A window smooths markets with few departures per bin.
function windowSum(read, end, getPoint, size) {
  let sum = 0;
  for (let i = 0; i < size; i += 1) {
    const p = getPoint(end - i * BIN_MS);
    if (!usable(p, read)) return null;
    sum += read(p);
  }
  return sum;
}

// Same-local-time median of the windowed `read` over the prior weeks, or null
// when fewer than MIN_BASELINE_DAYS weeks have a usable window.
function baselineAt(t, read, getPoint, timeZone, size = 1) {
  const values = baselineBins(t, timeZone).map((bin) => windowSum(read, bin, getPoint, size)).filter((v) => v !== null);
  return values.length >= MIN_BASELINE_DAYS ? median(values) : null;
}

// The UTC instant of local midnight starting local day `day` (days since the
// epoch in local time).
function localMidnightUtc(day, timeZone) {
  const wall = day * DAY_MS;
  const guess = wall - tzOffsetMinutes(timeZone, wall) * 60_000;
  return wall - tzOffsetMinutes(timeZone, guess) * 60_000;
}

// Largest signal baseline over the market-local day containing t, the
// reference for the quiet-hours floor.
function peakBaselineFor(t, getPoint, market = US_MARKET) {
  const localDay = Math.floor((t + tzOffsetMinutes(market.tz, t) * 60_000) / DAY_MS);
  let peak = 0;
  // Each midnight takes its own offset, so a DST day spans 23 or 25 hours.
  for (let bin = localMidnightUtc(localDay, market.tz); bin < localMidnightUtc(localDay + 1, market.tz); bin += BIN_MS) {
    const base = baselineAt(bin, market.signal, getPoint, market.tz, market.window);
    if (base !== null && base > peak) peak = base;
  }
  return peak;
}

// One evaluation step for one market. `getPoint(t)` returns the stored OpenSky
// point for bin t (or undefined), `wingbits` is the Wingbits point for the same
// bin, and `peakBaseline` is the largest signal baseline over the market's
// local day. Returns the next state and, on a transition, the event to publish.
function evaluateCollapse(state, { t, point, wingbits, getPoint, peakBaseline, market = US_MARKET }) {
  // Re-evaluating the last bin (a restart, a second replica) starts from the
  // state before it, so the bin cannot raise its event twice. Only one level
  // of history is kept.
  const prev = state && state.lastT === t ? state.prior : state;
  const { prior: _older, ...prevFlat } = prev || {};
  const current = prev ? prevFlat : { state: STATES.NORMAL, run: 0, onset: null };
  const next = (verdict, extra = {}) => ({ ...current, ...extra, lastT: t, prior: prev ? prevFlat : null, verdict });

  const { signal, coverage: seen, control, window: size } = market;
  const at = (bin) => (bin === t ? point : getPoint(bin));
  const signalNow = windowSum(signal, t, at, size);
  const seenNow = windowSum(seen, t, at, size);
  if (signalNow === null || seenNow === null || !usable(point, control.read)) {
    return { state: next('gap', { covered: 0 }), event: null };
  }
  const base = baselineAt(t, signal, getPoint, market.tz, size);
  const controlBase = baselineAt(t, control.read, getPoint, control.tz);
  const seenBase = baselineAt(t, seen, getPoint, market.tz, size);
  if (base === null || controlBase === null || seenBase === null || !(peakBaseline > 0)) {
    return { state: next('insufficient-baseline', { run: 0, covered: 0 }), event: null };
  }
  const ratio = signalNow / base;
  const controlRatio = controlBase > 0 ? control.read(point) / controlBase : 0;
  // Against Wingbits, one bin: both networks lose a stopped country's aircraft
  // together, so the ratio holds through the event.
  const coverage = usable(wingbits, seen) && seen(wingbits) > 0
    ? { ratio: seen(point) / seen(wingbits), min: COVERAGE_MIN_VS_WINGBITS, against: 'wingbits' }
    : { ratio: seenBase > 0 ? seenNow / seenBase : 0, min: market.coverageMinVsBaseline, against: 'baseline' };
  const detail = { ratio, control: controlRatio, coverage: coverage.ratio, coverageAgainst: coverage.against, baseline: base };
  // The window sums bins whose checks ran on earlier ticks. Entry waits until
  // every bin in it passed them, so a bin recorded during a feed or receiver
  // outage cannot read as a collapse once coverage returns. Quiet bins are
  // checked too: they skip only the ratio.
  const checked = controlRatio >= CONTROL_MIN && coverage.ratio >= coverage.min;
  const covered = checked ? Math.min((current.covered || 0) + 1, size) : 0;

  if (base < QUIET_SHARE * peakBaseline || base < market.minBaseline || base === 0) return { state: next('quiet', { covered }), event: null };

  if (current.state === STATES.COLLAPSED) {
    // The feed checks guard entry only. Parked aircraft switch their
    // transponders off, so during a stop the national count falls with the
    // signal; a failing feed can only lower the ratio, never fake a recovery.
    const run = ratio > market.exit ? current.run + 1 : 0;
    if (run < CONSECUTIVE) return { state: next('collapsed', { run, ...detail }), event: null };
    return {
      state: next('recovered', { state: STATES.NORMAL, run: 0, covered: 0, ...detail }),
      event: { kind: 'recovery', market: market.code, t, onset: current.onset, ...detail },
    };
  }

  if (controlRatio < CONTROL_MIN) return { state: next('blocked-feed', { run: 0, covered: 0, ratio, control: controlRatio }), event: null };
  if (coverage.ratio < coverage.min) {
    return { state: next('blocked-coverage', { run: 0, covered: 0, ratio, control: controlRatio, coverage: coverage.ratio, coverageAgainst: coverage.against }), event: null };
  }
  if (covered < size) {
    return { state: next('blocked-coverage', { run: 0, covered, ...detail }), event: null };
  }

  const run = ratio < market.enter ? current.run + 1 : 0;
  const onset = run === 1 ? t : current.onset;
  if (run < CONSECUTIVE) return { state: next('normal', { run, covered, onset: run ? onset : null, ...detail }), event: null };
  return {
    state: next('entered', { state: STATES.COLLAPSED, run: 0, covered: 0, onset, ...detail }),
    event: { kind: 'collapse', market: market.code, t, onset, ...detail },
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
  const market = MARKETS.find((m) => m.code === event.market);
  if (!market) throw new TypeError(`unknown air traffic market ${event.market}`);
  return {
    eventType: EVENT_TYPE,
    severity: recovery ? 'high' : 'critical',
    dedupTtl: DEDUP_TTL_SECONDS,
    payload: {
      title: recovery
        ? `${market.name} airline departures back near normal (${percent}% of usual), after a drop that began ${utcTime(event.onset)} UTC`
        : `${market.name} airline departures fell to ${percent}% of normal since ${utcTime(event.onset)} UTC`,
      source: 'WorldMonitor air traffic (OpenSky)',
      countryCode: market.code,
      coalesceKey: `${EVENT_TYPE}:${market.code}:${event.kind}:${event.onset}`,
      ratio: Math.round(event.ratio * 1000) / 1000,
      onset: new Date(event.onset).toISOString(),
      kind: event.kind,
    },
  };
}

module.exports = {
  EVENT_TYPE, buildCollapseNotification,
  SIGNAL, ENTER_RATIO, EXIT_RATIO, CONSECUTIVE, QUIET_SHARE, CONTROL_MIN,
  COVERAGE_MIN_VS_WINGBITS, COVERAGE_MIN_VS_BASELINE, BASELINE_WEEKS, MIN_BASELINE_DAYS,
  US_TZ, EUROPE_TZ, STATES, US_MARKET, MARKETS,
  tzOffsetMinutes, sameLocalBin, baselineBins, baselineAt, peakBaselineFor, evaluateCollapse,
};
