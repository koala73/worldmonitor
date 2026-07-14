/**
 * Dashboard-sized projection of the UCDP conflict-event feed (#5300).
 *
 * `conflict:ucdp-events:v1` carries 2,000 events (662 KB) and rides in the
 * bootstrap slow tier that EVERY client downloads on EVERY boot. Nothing renders
 * 2,000 events. Three consumers read it, and each wants something small:
 *
 *   1. CII  — `deriveUcdpClassifications` folds all 2,000 events into a per-country
 *             conflict status. 42 countries. Derived, not displayed.
 *   2. panel — `UcdpEventsPanel` renders `filtered.slice(0, 50)` per violence-type
 *             tab (150 rows max), but computes its tab counts and total-deaths
 *             figures over the FULL set. So a naive truncation would silently
 *             corrupt the numbers on screen — the counts must be precomputed.
 *   3. map   — draws every event, but the `ucdpEvents` layer is OFF by default in
 *             all 12 variant configs. Clients that switch it on re-fetch the full
 *             set from the RPC; they do not need it in everyone's boot payload.
 *
 * So the projection ships: the rows we render + the aggregates we compute +
 * the classifications we derive. ~662 KB -> ~55 KB, with every number on screen
 * identical to today.
 *
 * ── The duplication, and why it is guarded ──────────────────────────────────
 * `classifyUcdpEvents` below is a byte-for-byte mirror of `deriveUcdpClassifications`
 * in src/services/conflict/index.ts. It CANNOT import it: Railway builds the
 * seeders from a scripts-only Nixpacks root, and a `../src/` import crashes the
 * container at startup (#5268 took the wildfire feed down for ~6h exactly this
 * way). Duplicated scoring logic is how silent data drift happens, so
 * `tests/ucdp-dashboard-projection.test.mts` runs BOTH implementations over the
 * same fixture and asserts identical output. Change one without the other and CI
 * fails.
 */

export const UCDP_PANEL_ROWS_PER_TAB = 50;

export const UCDP_VIOLENCE_TYPES = [
  'UCDP_VIOLENCE_TYPE_STATE_BASED',
  'UCDP_VIOLENCE_TYPE_NON_STATE',
  'UCDP_VIOLENCE_TYPE_ONE_SIDED',
];

const TWO_YEARS_MS = 2 * 365 * 24 * 60 * 60 * 1000;

function isRecentUcdpClassificationDate(dateStart, now, windowMs) {
  const eventMs = Number(dateStart);
  return Number.isFinite(eventMs)
    && Number.isFinite(now)
    && eventMs <= now
    && now - eventMs < windowMs;
}

/**
 * MIRROR of deriveUcdpClassifications (src/services/conflict/index.ts).
 * Pinned by tests/ucdp-dashboard-projection.test.mts — do not edit one alone.
 */
export function classifyUcdpEvents(events, nowMs = Date.now()) {
  const byCountry = new Map();
  for (const e of events) {
    const country = e.country;
    if (!byCountry.has(country)) byCountry.set(country, []);
    byCountry.get(country).push(e);
  }

  const result = {};

  for (const [country, countryEvents] of byCountry) {
    const recentEvents = countryEvents.filter(e => isRecentUcdpClassificationDate(e.dateStart, nowMs, TWO_YEARS_MS));
    const totalDeaths = recentEvents.reduce((sum, e) => sum + e.deathsBest, 0);
    const eventCount = recentEvents.length;

    let intensity;
    if (totalDeaths > 1000 || eventCount > 100) {
      intensity = 'war';
    } else if (eventCount > 10) {
      intensity = 'minor';
    } else {
      intensity = 'none';
    }

    let maxDeathEvent;
    for (const e of recentEvents) {
      if (!maxDeathEvent || e.deathsBest > maxDeathEvent.deathsBest) maxDeathEvent = e;
    }

    const mostRecentEvent = recentEvents.reduce(
      (latest, e) => (!latest || e.dateStart > latest.dateStart) ? e : latest,
      undefined,
    );
    const year = mostRecentEvent ? new Date(mostRecentEvent.dateStart).getFullYear() : new Date(nowMs).getFullYear();

    result[country] = {
      location: country,
      intensity,
      year,
      sideA: maxDeathEvent?.sideA,
      sideB: maxDeathEvent?.sideB,
    };
  }

  return result;
}

/**
 * The panel's tab counts and total-deaths figures are computed over every event,
 * not the 50 it shows. Precompute them so the capped array cannot change a number
 * on screen.
 */
export function summarizeUcdpEvents(events) {
  const byType = {};
  for (const type of UCDP_VIOLENCE_TYPES) {
    byType[type] = { count: 0, totalDeaths: 0 };
  }
  for (const e of events) {
    const bucket = byType[e.violenceType];
    if (!bucket) continue; // unknown/unspecified violence type — not a panel tab
    bucket.count += 1;
    bucket.totalDeaths += Number(e.deathsBest) || 0;
  }
  return byType;
}

/**
 * Keep the newest `rowsPerTab` events of each violence type. `mapped` is already
 * sorted newest-first by the seeder, and the panel renders in that same order, so
 * this is the exact prefix the UI would have displayed.
 */
export function selectUcdpPanelRows(events, rowsPerTab = UCDP_PANEL_ROWS_PER_TAB) {
  const kept = [];
  const takenPerType = {};
  for (const e of events) {
    const type = e.violenceType;
    const taken = takenPerType[type] ?? 0;
    if (taken >= rowsPerTab) continue;
    takenPerType[type] = taken + 1;
    kept.push(e);
  }
  return kept;
}

/**
 * Compact attributes needed to replay the existing client-side ACLED de-duplication
 * against the full UCDP set. The panel only renders 150 rows, but its tab totals
 * are calculated after that dynamic de-duplication; carrying this small numeric
 * index keeps the precomputed totals faithful without restoring every raw field.
 */
export function buildUcdpDedupeIndex(events) {
  return events.map((event) => [
    UCDP_VIOLENCE_TYPES.indexOf(event.violenceType),
    Number(event.dateStart),
    Number(event.location?.latitude),
    Number(event.location?.longitude),
    Number(event.deathsBest) || 0,
  ]);
}

export function compactUcdpDashboardPayload(payload, nowMs = Date.now(), rowsPerTab = UCDP_PANEL_ROWS_PER_TAB) {
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.events)) return payload;

  const events = payload.events;
  return {
    ...payload,
    events: selectUcdpPanelRows(events, rowsPerTab),
    // Everything the UI derives from the full set, precomputed so the capped
    // array cannot change what the user sees.
    classifications: classifyUcdpEvents(events, nowMs),
    aggregates: summarizeUcdpEvents(events),
    dedupeIndex: buildUcdpDedupeIndex(events),
    totalEvents: events.length,
  };
}
