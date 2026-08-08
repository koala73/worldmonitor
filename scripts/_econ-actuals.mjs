/**
 * #4922 (b): macro-print actuals — pure helpers.
 *
 * The economic calendar previously shipped every event with
 * actual:'', estimate:'', previous:'' forever — the print itself (the
 * single most market-moving datum) was never captured. FRED publishes
 * the values same-day in series observations; these helpers turn the
 * latest observations into event-ready actual/previous strings.
 *
 * Series/transform map (release calendars use RELEASE ids; values need
 * SERIES ids — they are different namespaces):
 *   - CPI / PCE / Retail Sales: index levels → month-over-month % change
 *   - Nonfarm Payrolls: level in thousands → monthly change in K
 *   - GDP: A191RL1Q225SBEA is already the headline annualized % change
 */

export const EVENT_SERIES = {
  CPI: { series: 'CPIAUCSL', transform: 'pct_mom', freq: 'm' },
  'Nonfarm Payrolls': { series: 'PAYEMS', transform: 'diff_k', freq: 'm' },
  GDP: { series: 'A191RL1Q225SBEA', transform: 'direct', freq: 'q' },
  PCE: { series: 'PCEPI', transform: 'pct_mom', freq: 'm' },
  'Retail Sales': { series: 'RSAFS', transform: 'pct_mom', freq: 'm' },
};

/**
 * #4929 external review (P1): on release day BEFORE the print lands,
 * FRED's latest observation is still the PRIOR period — filling the
 * event with it would present a stale number as today's print. The
 * observation must belong to the period the release reports: monthly
 * releases report the previous calendar month (diff == 1); quarterly
 * GDP estimates report the previous quarter (1..5 months back across
 * advance/second/third estimates).
 */
export function observationMatchesRelease(eventDateISO, obsDateISO, freq) {
  const eventDate = new Date(eventDateISO);
  const obsDate = new Date(obsDateISO);
  if (!Number.isFinite(eventDate.getTime()) || !Number.isFinite(obsDate.getTime())) return false;
  const monthDiff = (eventDate.getUTCFullYear() - obsDate.getUTCFullYear()) * 12
    + (eventDate.getUTCMonth() - obsDate.getUTCMonth());
  if (freq === 'q') return monthDiff >= 1 && monthDiff <= 5;
  return monthDiff === 1;
}

/** FRED marks missing observations with the string '.'. */
function parseObs(observation) {
  const value = Number.parseFloat(observation?.value);
  return Number.isFinite(value) ? { date: observation.date, value } : null;
}

/** Consecutive-period guard: pct_mom/diff_k compare ADJACENT periods; a
 * missing month in between would silently mislabel a 2-month change as
 * month-over-month (review finding). 45 days tolerates publication
 * jitter on monthly series. */
const MAX_ADJACENT_GAP_MS = 45 * 86400_000;
function isAdjacent(newer, older) {
  const gap = new Date(newer.date).getTime() - new Date(older.date).getTime();
  return Number.isFinite(gap) && gap > 0 && gap <= MAX_ADJACENT_GAP_MS;
}

/**
 * @param {Array<{ date: string; value: string }>} observations DESC-sorted
 *   FRED observations (newest first).
 * @param {'pct_mom'|'diff_k'|'direct'} transform
 * @returns {{ actual: string; previous: string; obsDate: string }}
 *   Empty strings when there is not enough usable data.
 */
export function computePrintValues(observations, transform) {
  const empty = { actual: '', previous: '', obsDate: '' };
  const raw = Array.isArray(observations) ? observations : [];
  // The LEADING observation must be parseable — if the newest value is a
  // '.' placeholder, the print is not out yet; do NOT fall back to an
  // older row and present it as current (review finding).
  const lead = parseObs(raw[0]);
  if (!lead) return empty;
  const usable = raw.map(parseObs).filter(Boolean);

  // Values are UNITLESS — event.unit already carries '%'/'K' and the
  // calendar renderer appends it; embedding the unit here double-renders.
  if (transform === 'direct') {
    const prev = usable.length > 1 ? usable[1] : null;
    return {
      actual: lead.value.toFixed(1),
      previous: prev ? prev.value.toFixed(1) : '',
      obsDate: lead.date,
    };
  }
  if (usable.length < 2 || !isAdjacent(usable[0], usable[1])) return empty;
  if (transform === 'diff_k') {
    const actual = usable[0].value - usable[1].value;
    const hasPrev = usable.length > 2 && isAdjacent(usable[1], usable[2]);
    const previous = hasPrev ? usable[1].value - usable[2].value : null;
    return {
      actual: `${actual >= 0 ? '+' : ''}${Math.round(actual)}`,
      previous: previous === null ? '' : `${previous >= 0 ? '+' : ''}${Math.round(previous)}`,
      obsDate: usable[0].date,
    };
  }
  // pct_mom
  if (usable[1].value === 0) return empty;
  const actual = (usable[0].value / usable[1].value - 1) * 100;
  const hasPrev = usable.length > 2 && isAdjacent(usable[1], usable[2]) && usable[2].value !== 0;
  const previous = hasPrev ? (usable[1].value / usable[2].value - 1) * 100 : null;
  return {
    actual: `${actual >= 0 ? '+' : ''}${actual.toFixed(1)}`,
    previous: previous === null ? '' : `${previous >= 0 ? '+' : ''}${previous.toFixed(1)}`,
    obsDate: usable[0].date,
  };
}

/**
 * Fill actual/previous on calendar events whose print is available:
 * an event matches when its `event` name has a series mapping and its
 * date is today or earlier (the calendar window starts at today, so in
 * practice this fills print-day rows on the runs after the release).
 *
 * @returns {number} count of events filled.
 */
export function fillEventActuals(events, printsByEvent, todayISO) {
  let filled = 0;
  for (const event of Array.isArray(events) ? events : []) {
    if (event.actual) continue;
    const print = printsByEvent[event.event];
    if (!print || !print.actual) continue;
    if (typeof event.date !== 'string' || event.date > todayISO) continue;
    // Stale-print guard: the observation must belong to the period THIS
    // release reports — pre-print on release day, the latest obs is the
    // prior period and must not be presented as today's number.
    const freq = EVENT_SERIES[event.event]?.freq ?? 'm';
    if (!observationMatchesRelease(event.date, print.obsDate, freq)) continue;
    event.actual = print.actual;
    if (!event.previous && print.previous) event.previous = print.previous;
    filled++;
  }
  return filled;
}
