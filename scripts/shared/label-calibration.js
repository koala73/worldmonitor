/**
 * Label calibration (#9097): how often each first coverage label held up.
 *
 * Every story the full English digest sees for the first time with a
 * `single-publisher` or `corroborated` label starts a cohort, keyed by the UTC
 * day of that first label. The digest logs two kinds of event:
 *
 *   f  the story's first label (a new story:track row);
 *   s  a later change of its label, including into and out of the states the
 *      public change log does not track (tier-4 only, not enough evidence),
 *      which this module calls `other`.
 *
 * A story's label at a checkpoint is the last label the digest recorded for it
 * at or before first label + 24 hours (or + 7 days). A story that left the
 * digest keeps the last label it had. The outcome is then:
 *
 *   same     the same label as the first one;
 *   changed  the other tracked label (single-publisher <-> corroborated);
 *   other    tier-4 only or not enough evidence.
 *
 * The label describes coverage, not accuracy. `changed` from single-publisher
 * means the story was later carried by two or more publisher families, never
 * that it was confirmed; `changed` from corroborated means it was later
 * carried by only one family, never that it was wrong.
 *
 * The seeder (scripts/seed-label-calibration.mjs) folds a day's events into
 * one immutable day record once every story in it has passed + 7 days, and
 * publishes the monthly table from those records. Everything here reads only
 * the logged events: no topic, person, party or country enters a figure.
 *
 * shared/label-calibration.js and scripts/shared/label-calibration.js are
 * byte-for-byte mirrors (tests/scripts-shared-mirror.test.mjs).
 */

export const CALIBRATION_STATES = ['single-publisher', 'corroborated'];
/** The event state for tier-4 only and not enough evidence. */
export const CALIBRATION_OTHER = 'other';
export const CALIBRATION_HORIZONS = [
  { id: '24h', ms: 24 * 60 * 60 * 1000 },
  { id: '7d', ms: 7 * 24 * 60 * 60 * 1000 },
];
export const CALIBRATION_DEFINITIONS_VERSION = 1;

/** Cells with fewer stories than this are marked low-n and shown without a percentage. */
export const CALIBRATION_LOW_N = 30;
/** Months the published table covers, the current one included. */
export const CALIBRATION_MONTHS = 13;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Raw events, one Redis list per UTC day, read by the seeder. */
export const CALIBRATION_EVENTS_KEY_PREFIX = 'trust:calibration-events:v1:';
/** Long enough for the seeder to finalize a day 8 days later, with two weeks of slack. */
export const CALIBRATION_EVENTS_TTL_S = 21 * 24 * 60 * 60;
/**
 * A day list keeps its first this-many events. A list that reaches it is
 * incomplete, and the seeder excludes every cohort day that depends on it.
 */
export const CALIBRATION_EVENTS_MAX = 60_000;

/** One finalized, immutable record per cohort day. */
export const CALIBRATION_DAY_KEY_PREFIX = 'trust:calibration-day:v1:';
/** 400 days: the 13-month table plus a margin. */
export const CALIBRATION_DAY_TTL_S = 400 * 24 * 60 * 60;
/** A cohort day is finalized this long after its last story passed + 7 days, so in-flight digest writes land first. */
export const CALIBRATION_SETTLE_MS = 60 * 60 * 1000;
/** Oldest cohort day the seeder still finalizes: its events must not have expired. */
export const CALIBRATION_FINALIZE_MAX_AGE_DAYS = 20;

/** The published monthly table. */
export const LABEL_CALIBRATION_KEY = 'trust:label-calibration:v1';

export const FACT_CHECK_STATUS = 'not-measured';
export const FACT_CHECK_NOTE =
  'Not measured. Published fact-checks are looked up only when someone checks a claim on /verify, and those '
  + 'lookups are not linked to stories. Counting this column needs a per-story lookup, which has not been decided.';

const STORY_ID_RE = /^[0-9a-f]{64}$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export function calibrationEventsKey(day) {
  return `${CALIBRATION_EVENTS_KEY_PREFIX}${day}`;
}

export function calibrationDayKey(day) {
  return `${CALIBRATION_DAY_KEY_PREFIX}${day}`;
}

/** UTC day of an epoch-ms time, as YYYY-MM-DD. */
export function utcDay(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

export function dayStartMs(day) {
  return Date.parse(`${day}T00:00:00.000Z`);
}

export function addDays(day, count) {
  return utcDay(dayStartMs(day) + count * DAY_MS);
}

function isEventState(state) {
  return state === CALIBRATION_OTHER || CALIBRATION_STATES.includes(state);
}

/** `f|<storyId>|<state>|<at>` or `s|<storyId>|<state>|<at>`; null for anything else. */
export function encodeCalibrationEvent(event) {
  if (!event || (event.kind !== 'f' && event.kind !== 's')) return null;
  if (!STORY_ID_RE.test(String(event.storyId))) return null;
  if (event.kind === 'f' ? !CALIBRATION_STATES.includes(event.state) : !isEventState(event.state)) return null;
  if (!Number.isSafeInteger(event.at) || event.at <= 0) return null;
  return `${event.kind}|${event.storyId}|${event.state}|${event.at}`;
}

export function parseCalibrationEvent(raw) {
  if (typeof raw !== 'string') return null;
  const [kind, storyId, state, at, extra] = raw.split('|');
  if (extra !== undefined) return null;
  const event = { kind, storyId, state, at: Number(at) };
  return encodeCalibrationEvent(event) === raw ? event : null;
}

/**
 * The calibration state a stored story label encodes: a tracked state,
 * `other` for the untracked marker, or null when nothing was recorded.
 */
export function calibrationStateOf(rawLabel, untrackedMarker) {
  if (typeof rawLabel !== 'string' || rawLabel === '') return null;
  if (rawLabel === untrackedMarker) return CALIBRATION_OTHER;
  const state = rawLabel.split('|')[0];
  return CALIBRATION_STATES.includes(state) ? state : null;
}

function emptyOutcome() {
  return { same: 0, changed: 0, other: 0 };
}

function emptyCohort() {
  return { n: 0, '24h': emptyOutcome(), '7d': emptyOutcome() };
}

/**
 * Fold logged events into the record for one cohort day.
 *
 * `events` are parsed events from the day's list and every later list the
 * checkpoints reach (and, when available, the day before, so a story whose
 * first label was logged twice counts in the earlier cohort only). A story
 * belongs to `day` when its earliest `f` event falls in it. Later events are
 * replayed in time order; for equal times, in the order given.
 */
export function buildCohortDay(day, events, { incomplete = false } = {}) {
  const record = { day, version: CALIBRATION_DEFINITIONS_VERSION, incomplete: Boolean(incomplete), cohorts: {} };
  for (const state of CALIBRATION_STATES) record.cohorts[state] = emptyCohort();
  if (record.incomplete) return record;

  const first = new Map();
  const changes = new Map();
  const addChange = (event, index) => {
    const list = changes.get(event.storyId) ?? [];
    list.push({ at: event.at, state: event.state, index });
    changes.set(event.storyId, list);
  };
  events.forEach((event, index) => {
    if (!event) return;
    if (event.kind !== 'f') {
      addChange(event, index);
      return;
    }
    // The earliest first label starts the cohort. A later one (logged again
    // when the story's track row was not written) is the story's label at
    // that time, so it is replayed as a change, never dropped.
    const seen = first.get(event.storyId);
    if (!seen) {
      first.set(event.storyId, { event, index });
    } else if (event.at < seen.event.at) {
      addChange(seen.event, seen.index);
      first.set(event.storyId, { event, index });
    } else {
      addChange(event, index);
    }
  });

  const start = dayStartMs(day);
  const end = start + DAY_MS;
  for (const [storyId, { event: firstEvent }] of first) {
    if (firstEvent.at < start || firstEvent.at >= end) continue;
    const cohort = record.cohorts[firstEvent.state];
    cohort.n += 1;
    const later = (changes.get(storyId) ?? [])
      .filter((change) => change.at > firstEvent.at)
      .sort((a, b) => a.at - b.at || a.index - b.index);
    for (const horizon of CALIBRATION_HORIZONS) {
      const checkpoint = firstEvent.at + horizon.ms;
      let state = firstEvent.state;
      for (const change of later) {
        if (change.at > checkpoint) break;
        state = change.state;
      }
      const outcome = state === firstEvent.state ? 'same' : state === CALIBRATION_OTHER ? 'other' : 'changed';
      cohort[horizon.id][outcome] += 1;
    }
  }
  return record;
}

function isCount(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

/** A stored day record, or null when it is malformed or its outcomes do not add up to n. */
export function parseCohortDay(raw) {
  let value = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== 'object') return null;
  if (typeof value.day !== 'string' || !DAY_RE.test(value.day) || !Number.isFinite(dayStartMs(value.day))) return null;
  if (value.version !== CALIBRATION_DEFINITIONS_VERSION || typeof value.incomplete !== 'boolean') return null;
  if (!value.cohorts || typeof value.cohorts !== 'object') return null;
  const cohorts = {};
  for (const state of CALIBRATION_STATES) {
    const cohort = value.cohorts[state];
    if (!cohort || !isCount(cohort.n)) return null;
    cohorts[state] = { n: cohort.n };
    for (const { id } of CALIBRATION_HORIZONS) {
      const outcome = cohort[id];
      if (!outcome || !isCount(outcome.same) || !isCount(outcome.changed) || !isCount(outcome.other)) return null;
      if (outcome.same + outcome.changed + outcome.other !== cohort.n) return null;
      cohorts[state][id] = { same: outcome.same, changed: outcome.changed, other: outcome.other };
    }
  }
  return { day: value.day, version: value.version, incomplete: value.incomplete, cohorts };
}

/**
 * Cohort days the seeder may finalize at `nowMs`: every story first labelled
 * on the day has passed + 7 days (plus the settle margin), and the day's
 * events have not yet expired. Oldest first.
 */
export function finalizableDays(nowMs) {
  const days = [];
  const today = utcDay(nowMs);
  const lastHorizonMs = CALIBRATION_HORIZONS.at(-1).ms;
  for (let back = CALIBRATION_FINALIZE_MAX_AGE_DAYS; back >= 1; back -= 1) {
    const day = addDays(today, -back);
    if (dayStartMs(day) + DAY_MS + lastHorizonMs + CALIBRATION_SETTLE_MS <= nowMs) days.push(day);
  }
  return days;
}

/** The event lists a cohort day reads: the day before, the day, and each day its checkpoints reach. */
export function eventDaysFor(day) {
  const lastHorizonDays = Math.ceil(CALIBRATION_HORIZONS.at(-1).ms / DAY_MS);
  const days = [];
  for (let offset = -1; offset <= lastHorizonDays; offset += 1) days.push(addDays(day, offset));
  return days;
}

/** The last CALIBRATION_MONTHS UTC months, the current one first, as YYYY-MM. */
export function calibrationMonths(nowMs) {
  const now = new Date(nowMs);
  const months = [];
  for (let back = 0; back < CALIBRATION_MONTHS; back += 1) {
    const at = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1));
    months.push(at.toISOString().slice(0, 7));
  }
  return months;
}

/** Every day of the months the table covers, up to today, oldest first. */
export function calibrationTableDays(nowMs) {
  const months = calibrationMonths(nowMs);
  const today = utcDay(nowMs);
  const days = [];
  for (let day = `${months.at(-1)}-01`; day <= today; day = addDays(day, 1)) days.push(day);
  return days;
}

/**
 * The published table: per month, per first label and checkpoint, the stories
 * counted and how many kept, changed or left their label. Months with no
 * finalized day are omitted. Newest month first.
 */
export function buildCalibrationTable(records, { generatedAt }) {
  const keep = new Set(calibrationMonths(generatedAt));
  const byMonth = new Map();
  for (const record of records) {
    if (!record) continue;
    const month = record.day.slice(0, 7);
    if (!keep.has(month)) continue;
    let entry = byMonth.get(month);
    if (!entry) {
      entry = { month, cohortDays: 0, excludedDays: 0, firstDay: '', lastDay: '', totals: {} };
      for (const state of CALIBRATION_STATES) entry.totals[state] = emptyCohort();
      byMonth.set(month, entry);
    }
    if (record.incomplete) {
      entry.excludedDays += 1;
      continue;
    }
    entry.cohortDays += 1;
    if (!entry.firstDay || record.day < entry.firstDay) entry.firstDay = record.day;
    if (!entry.lastDay || record.day > entry.lastDay) entry.lastDay = record.day;
    for (const state of CALIBRATION_STATES) {
      const total = entry.totals[state];
      const cohort = record.cohorts[state];
      total.n += cohort.n;
      for (const { id } of CALIBRATION_HORIZONS) {
        total[id].same += cohort[id].same;
        total[id].changed += cohort[id].changed;
        total[id].other += cohort[id].other;
      }
    }
  }
  const months = [...byMonth.values()]
    .sort((a, b) => b.month.localeCompare(a.month))
    .map((entry) => ({
      month: entry.month,
      cohortDays: entry.cohortDays,
      excludedDays: entry.excludedDays,
      firstDay: entry.firstDay,
      lastDay: entry.lastDay,
      rows: CALIBRATION_STATES.flatMap((state) => CALIBRATION_HORIZONS.map(({ id }) => ({
        state,
        horizon: id,
        n: entry.totals[state].n,
        same: entry.totals[state][id].same,
        changed: entry.totals[state][id].changed,
        other: entry.totals[state][id].other,
      }))),
    }));
  return {
    generatedAt,
    definitionsVersion: CALIBRATION_DEFINITIONS_VERSION,
    lowNThreshold: CALIBRATION_LOW_N,
    factCheckStatus: FACT_CHECK_STATUS,
    factCheckNote: FACT_CHECK_NOTE,
    months,
  };
}

/** A published table, or null when it is malformed or any row's outcomes do not add up to n. */
export function parseCalibrationTable(value) {
  if (!value || typeof value !== 'object') return null;
  if (!Number.isSafeInteger(value.generatedAt) || value.generatedAt <= 0) return null;
  if (value.definitionsVersion !== CALIBRATION_DEFINITIONS_VERSION || !isCount(value.lowNThreshold)) return null;
  if (typeof value.factCheckStatus !== 'string' || typeof value.factCheckNote !== 'string') return null;
  if (!Array.isArray(value.months)) return null;
  const months = [];
  for (const month of value.months) {
    if (!month || typeof month.month !== 'string' || !/^\d{4}-\d{2}$/.test(month.month)) return null;
    if (!isCount(month.cohortDays) || !isCount(month.excludedDays)) return null;
    if (typeof month.firstDay !== 'string' || typeof month.lastDay !== 'string' || !Array.isArray(month.rows)) return null;
    const rows = [];
    for (const row of month.rows) {
      if (!row || !CALIBRATION_STATES.includes(row.state)) return null;
      if (!CALIBRATION_HORIZONS.some(({ id }) => id === row.horizon)) return null;
      if (![row.n, row.same, row.changed, row.other].every(isCount)) return null;
      if (row.same + row.changed + row.other !== row.n) return null;
      rows.push({ state: row.state, horizon: row.horizon, n: row.n, same: row.same, changed: row.changed, other: row.other });
    }
    months.push({
      month: month.month,
      cohortDays: month.cohortDays,
      excludedDays: month.excludedDays,
      firstDay: month.firstDay,
      lastDay: month.lastDay,
      rows,
    });
  }
  return {
    generatedAt: value.generatedAt,
    definitionsVersion: value.definitionsVersion,
    lowNThreshold: value.lowNThreshold,
    factCheckStatus: value.factCheckStatus,
    factCheckNote: value.factCheckNote,
    months,
  };
}
