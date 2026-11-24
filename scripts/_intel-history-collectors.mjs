/**
 * Intel-history projections for the collectors added in #11245: UCDP GED
 * conflict events, unrest, cyber C2 infrastructure, PortWatch port
 * disruptions, earthquakes, natural hazards and international aviation
 * disruptions.
 *
 * One module rather than one builder per seeder because two of the writers
 * cannot host their own builder: `seed-earthquakes.mjs` calls runSeed at module
 * load (so a test cannot import it), and UCDP is published by both the relay
 * (`ais-relay.cjs`, the usual writer) and the `seed-ucdp-events.mjs` backup,
 * which must project identical rows under the same ingest-health key.
 *
 * Every builder obeys the contract pinned in tests/seed-history-wiring.test.mjs:
 *
 *   - `dedupeKey` is `${domain}:${resource}:${stable upstream identity}` and is
 *     a pure function of the upstream item. A tombstone (#5743) suppresses an
 *     identity, so a key that moved between runs would let a retracted row
 *     come straight back under a new key.
 *   - `occurredAt` must be a positive epoch. Several feeds publish `0` for a
 *     missing date and zero is finite, so the shared normalizer would accept
 *     it as 1970.
 *   - `country` is ISO 3166-1 alpha-2 or absent; the read side matches only
 *     `^[A-Z]{2}$`, so a country name would be stored and never found.
 *   - `title`/`summary` are clipped here because normalizeHistoryRecords drops
 *     an over-long record rather than altering it.
 *
 * Each builder also applies a significance bar. normalizeHistoryRecords keeps
 * only the newest HISTORY_MAX_RECORDS_PER_RUN rows per run and every run
 * re-offers the same rows, so a feed whose per-interval inflow exceeds the cap
 * loses its tail permanently. The bars below keep each collector's measured
 * production inflow under the cap (counts in the PR for #11245).
 *
 * Boundary: scripts/** ships to Railway with root_dir=scripts, and this file is
 * also COPY'd into Dockerfile.relay, so it may import only from scripts/.
 */

import { createHash } from 'node:crypto';
import { makeSeedHistoryAfterPublish } from './_seed-history.mjs';
import { resolveIso2 } from './_country-resolver.mjs';

const TITLE_MAX = 480;
const SUMMARY_MAX = 1900;
const DEDUPE_KEY_MAX = 256;

function clip(value, max) {
  if (typeof value !== 'string') return '';
  const trimmed = value.replace(/\s+/g, ' ').trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1).trimEnd()}…` : trimmed;
}

function positiveEpoch(value) {
  return Number.isFinite(value) && value > 0 ? value : null;
}

function isoDay(epochMs) {
  return new Date(epochMs).toISOString().slice(0, 10);
}

// UCDP names carry historical parentheticals ('DR Congo (Zaire)', 'Myanmar
// (Burma)') that resolveIso2 has no entry for, so retry without them. No bare
// two-letter passthrough: USGS ends California places with ', CA'. A row keeps
// the country it was first stored with, so a wrong match here is permanent.
function iso2FromName(name) {
  const direct = resolveIso2({ name });
  if (direct) return direct;
  const stripped = String(name ?? '').replace(/\s*\([^)]*\)\s*$/, '');
  return stripped !== name ? resolveIso2({ name: stripped }) ?? undefined : undefined;
}

function iso2OrUndefined(value) {
  const upper = String(value || '').trim().toUpperCase();
  return /^[A-Z]{2}$/.test(upper) ? upper : undefined;
}

/**
 * Bound a key built from an upstream identity. Ids that would overflow the
 * relay's 256-char limit are hashed rather than truncated: truncation could
 * collapse two distinct indicators onto one row, a hash cannot in practice.
 */
function boundedKey(prefix, identity) {
  const key = `${prefix}:${identity}`;
  if (key.length <= DEDUPE_KEY_MAX) return key;
  return `${prefix}:sha256:${createHash('sha256').update(String(identity)).digest('hex')}`;
}

function enumLabel(value, prefix) {
  return String(value || '')
    .replace(prefix, '')
    .toLowerCase()
    .replace(/_/g, '-');
}

/**
 * Run a seeder's existing afterPublish, then the history hook, and return the
 * existing hook's result untouched. runSeed reads `completionState` and
 * `freshnessMetaPatch` from that result, so history must never replace it. The
 * history hook is fail-open by construction (makeSeedHistoryAfterPublish), so
 * it cannot turn a successful publish into a thrown one.
 */
export function withHistoryAfterPublish(primary, history) {
  return async function afterPublishWithHistory(data, meta) {
    const result = await primary(data, meta);
    await history(data, meta);
    return result;
  };
}

// ── conflict / ucdp-events ───────────────────────────────────────────────────

// The relay's `conflict_escalation` notification uses the same bar
// (ais-relay.cjs seedUcdpEvents). Measured 2026-11-24: 129 of 2,417 events in
// the trailing 180 days meet it, against 2,052 with at least one death.
export const UCDP_HISTORY_MIN_DEATHS = 10;

const UCDP_VIOLENCE_LABELS = {
  UCDP_VIOLENCE_TYPE_STATE_BASED: 'State-based conflict',
  UCDP_VIOLENCE_TYPE_NON_STATE: 'Non-state conflict',
  UCDP_VIOLENCE_TYPE_ONE_SIDED: 'One-sided violence',
};

export function buildUcdpHistoryRecords(data) {
  return (data?.events ?? []).map((event) => {
    const id = String(event?.id ?? '').trim();
    const occurredAt = positiveEpoch(event?.dateStart);
    if (!id || !occurredAt) return null;
    if (!(Number(event.deathsBest) >= UCDP_HISTORY_MIN_DEATHS)) return null;

    const label = UCDP_VIOLENCE_LABELS[event.violenceType] ?? 'Organized violence';
    const parties = [event.sideA, event.sideB].filter(Boolean).join(' vs ');
    const place = event.locationName || event.country || 'unknown location';
    const summary = [
      `UCDP GED event ${id}`,
      `deaths best ${event.deathsBest} (low ${event.deathsLow ?? 0}, high ${event.deathsHigh ?? 0})`,
      event.sourceOriginal ? `source: ${event.sourceOriginal}` : '',
    ].filter(Boolean).join('; ');

    return {
      dedupeKey: `conflict:ucdp-events:${id}`,
      country: iso2FromName(event.country),
      category: enumLabel(event.violenceType, 'UCDP_VIOLENCE_TYPE_') || undefined,
      title: clip(`${label}: ${parties || 'unknown parties'} — ${event.deathsBest} deaths in ${place}`, TITLE_MAX),
      summary: clip(summary, SUMMARY_MAX),
      occurredAt,
    };
  }).filter(Boolean);
}

export const ucdpHistoryAfterPublish = makeSeedHistoryAfterPublish({
  domain: 'conflict',
  resource: 'ucdp-events',
  buildRecords: buildUcdpHistoryRecords,
});

// ── unrest / events ──────────────────────────────────────────────────────────

// Production unrest is GDELT-only: unverified location mentions, one row per
// bucket. Measured 2026-11-24: 120 rows, 65 of them with at least 10 reports.
// Smaller buckets are a single outlet's coverage, not a signal worth keeping.
export const UNREST_GDELT_MIN_REPORTS = 10;

const GDELT_REPORT_COUNT = /\((\d+) reports?\)\s*$/;

function unrestGdeltRecord(event, occurredAt) {
  const lat = Number(event.location?.latitude);
  const lon = Number(event.location?.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const reports = Number(GDELT_REPORT_COUNT.exec(event.title || '')?.[1]);
  if (!(reports >= UNREST_GDELT_MIN_REPORTS)) return null;

  // The upstream id embeds the bucket's moving latest-article time and the
  // title embeds a moving report count, so neither is an identity. A bucket is
  // a place; one row per place per UTC day is the stable unit. The materializer
  // buckets at 0.1° and keeps the first location's coordinates, which can
  // differ at 0.01° run to run, so the key uses the bucket, not the point.
  const day = isoDay(occurredAt);
  const place = String(event.title).replace(GDELT_REPORT_COUNT, '').trim() || event.country || 'unknown location';
  // No sourceUrl: the bucket's first article is whichever keyword match GDELT
  // listed first, not evidence of unrest (one sampled bucket led with a
  // firearms review). An agent would cite it as the source.
  return {
    dedupeKey: `unrest:events:gdelt:${lat.toFixed(1)}:${lon.toFixed(1)}:${day}`,
    country: iso2FromName(event.country),
    category: 'media-signal',
    title: clip(`Unrest media signal: ${place} (${day})`, TITLE_MAX),
    summary: clip(`${reports} reports. ${event.summary || ''}`, SUMMARY_MAX),
    occurredAt,
  };
}

export function buildUnrestHistoryRecords(data) {
  return (data?.events ?? []).map((event) => {
    if (!event) return null;
    const occurredAt = positiveEpoch(event.occurredAt);
    if (!occurredAt) return null;
    if (event.sourceType === 'UNREST_SOURCE_TYPE_GDELT') return unrestGdeltRecord(event, occurredAt);

    // ACLED rows carry the upstream event_id_cnty, which is stable.
    const id = String(event.id ?? '').trim();
    if (!id || !event.title) return null;
    return {
      dedupeKey: boundedKey('unrest:events', id),
      country: iso2FromName(event.country),
      category: enumLabel(event.eventType, 'UNREST_EVENT_TYPE_') || undefined,
      title: clip(event.title, TITLE_MAX),
      summary: clip(event.summary, SUMMARY_MAX) || undefined,
      sourceUrl: (event.sourceUrls ?? [])[0],
      occurredAt,
    };
  }).filter(Boolean);
}

export const unrestHistoryAfterPublish = makeSeedHistoryAfterPublish({
  domain: 'unrest',
  resource: 'events',
  buildRecords: buildUnrestHistoryRecords,
});

// ── cyber / threats ──────────────────────────────────────────────────────────

// Command-and-control servers only. The rest of the feed is IP-reputation and
// malware-URL indicators (715 of 923 rows, 655 first seen within a day on
// 2026-11-24): they would flood the per-run cap and say nothing a precedent
// search can use. C2 infrastructure carries a malware family and arrives at a
// few rows a day (26 in the last week).
export function buildCyberHistoryRecords(data) {
  return (data?.threats ?? []).map((threat) => {
    if (threat?.type !== 'CYBER_THREAT_TYPE_C2_SERVER') return null;
    const id = String(threat.id ?? '').trim();
    const occurredAt = positiveEpoch(threat.firstSeenAt);
    if (!id || !occurredAt || !threat.indicator) return null;

    const family = threat.malwareFamily || 'Unattributed';
    const country = iso2OrUndefined(threat.country);
    const source = enumLabel(threat.source, 'CYBER_THREAT_SOURCE_');
    const summary = [
      `${enumLabel(threat.indicatorType, 'CYBER_THREAT_INDICATOR_TYPE_')} indicator`,
      source ? `source: ${source}` : '',
      `severity: ${enumLabel(threat.severity, 'CRITICALITY_LEVEL_')}`,
      threat.tags?.length ? `tags: ${threat.tags.join(', ')}` : '',
    ].filter(Boolean).join('; ');

    return {
      dedupeKey: boundedKey('cyber:threats', id),
      country,
      category: 'c2-server',
      title: clip(`${family} C2 server ${threat.indicator}${country ? ` (${country})` : ''}`, TITLE_MAX),
      summary: clip(summary, SUMMARY_MAX),
      occurredAt,
    };
  }).filter(Boolean);
}

export const cyberHistoryAfterPublish = makeSeedHistoryAfterPublish({
  domain: 'cyber',
  resource: 'threats',
  buildRecords: buildCyberHistoryRecords,
});

// ── maritime / portwatch-disruptions ─────────────────────────────────────────

const PORTWATCH_EVENT_TYPES = {
  TC: 'tropical cyclone',
  EQ: 'earthquake',
  FL: 'flood',
  VO: 'volcano',
  WF: 'wildfire',
  DR: 'drought',
  OT: 'other disruption',
};

export function buildPortwatchHistoryRecords(data) {
  return (data?.events ?? []).map((event) => {
    if (!Number.isSafeInteger(event?.eventId)) return null;
    const occurredAt = positiveEpoch(Date.parse(event.fromDate));
    if (!occurredAt || !event.eventName) return null;

    const kind = PORTWATCH_EVENT_TYPES[event.eventType] ?? 'disruption';
    const ports = (event.affectedPorts ?? []).join(', ');
    const summary = [
      `IMF PortWatch ${kind}`,
      event.alertLevel ? `alert ${event.alertLevel}` : '',
      `from ${event.fromDate}${event.toDate ? ` to ${event.toDate}` : ' (ongoing)'}`,
      ports ? `affected: ${ports}` : '',
    ].filter(Boolean).join('; ');

    return {
      dedupeKey: `maritime:portwatch-disruptions:${event.eventId}`,
      country: iso2FromName(event.country),
      category: kind.replace(/ /g, '-'),
      title: clip(`Port disruption: ${event.eventName}${event.alertLevel ? ` (${event.alertLevel})` : ''}`, TITLE_MAX),
      summary: clip(summary, SUMMARY_MAX),
      occurredAt,
    };
  }).filter(Boolean);
}

export const portwatchHistoryAfterPublish = makeSeedHistoryAfterPublish({
  domain: 'maritime',
  resource: 'portwatch-disruptions',
  buildRecords: buildPortwatchHistoryRecords,
});

// ── natural / earthquakes ────────────────────────────────────────────────────

// M5+ is where shaking is reported as damaging. Measured 2026-11-24: 41 of the
// feed's 101 events over the trailing week.
export const EARTHQUAKE_HISTORY_MIN_MAGNITUDE = 5;

export function buildEarthquakeHistoryRecords(data) {
  return (data?.earthquakes ?? []).map((quake) => {
    const id = String(quake?.id ?? '').trim();
    const occurredAt = positiveEpoch(quake?.occurredAt);
    if (!id || !occurredAt) return null;
    if (!(Number(quake.magnitude) >= EARTHQUAKE_HISTORY_MIN_MAGNITUDE)) return null;
    // An NRCan row is published under its own id only until USGS reports the
    // same quake, then under the USGS id. USGS's M4.5+ feed covers every M5+,
    // so keeping USGS ids alone avoids a second row for one Canadian quake.
    if (quake.source !== 'usgs') return null;

    const place = String(quake.place || '').trim() || 'unknown location';
    const region = place.split(',').at(-1)?.trim();
    const summary = [
      `magnitude ${quake.magnitude}`,
      Number.isFinite(quake.depthKm) ? `depth ${quake.depthKm} km` : '',
      quake.source ? `source: ${quake.source}` : '',
    ].filter(Boolean).join('; ');

    return {
      dedupeKey: boundedKey('natural:earthquakes', id),
      country: region ? iso2FromName(region) : undefined,
      category: 'earthquake',
      title: clip(`M${Number(quake.magnitude).toFixed(1)} earthquake — ${place}`, TITLE_MAX),
      summary,
      sourceUrl: quake.sourceUrl || undefined,
      occurredAt,
    };
  }).filter(Boolean);
}

export const earthquakeHistoryAfterPublish = makeSeedHistoryAfterPublish({
  domain: 'natural',
  resource: 'earthquakes',
  buildRecords: buildEarthquakeHistoryRecords,
});

// ── natural / events ─────────────────────────────────────────────────────────

// EONET, GDACS and NHC ids are upstream event identities (storm id, GDACS
// eventtype+eventid, EONET id); an advisory update keeps the id, so the first
// observation of a hazard is what history keeps. 17 rows on 2026-11-24.
export function buildNaturalEventHistoryRecords(data) {
  return (data?.events ?? []).map((event) => {
    const id = String(event?.id ?? '').trim();
    const occurredAt = positiveEpoch(event?.date);
    // GDACS prefixes its alert colour as an emoji (🟠 Drought in ...).
    const title = clip(String(event?.title ?? '').replace(/^[^\p{L}\p{N}]+/u, ''), TITLE_MAX);
    if (!id || !occurredAt || !title) return null;
    // GDACS earthquakes are already kept, with a country, under
    // natural/earthquakes. HKO warning ids are the signal code (WTCSGNL), not a
    // storm, so every later storm's signal would collide with the first; the
    // storm itself arrives as its own cyclone row.
    if (event.category === 'earthquakes' || id.startsWith('hko-warning:')) return null;
    return {
      dedupeKey: boundedKey('natural:events', id),
      category: event.category || undefined,
      title,
      summary: clip(event.description, SUMMARY_MAX) || undefined,
      sourceUrl: event.sourceUrl || undefined,
      occurredAt,
    };
  }).filter(Boolean);
}

export const naturalEventHistoryAfterPublish = makeSeedHistoryAfterPublish({
  domain: 'natural',
  resource: 'events',
  buildRecords: buildNaturalEventHistoryRecords,
});

// ── aviation / intl ──────────────────────────────────────────────────────────

const AVIATION_HISTORY_SEVERITIES = new Set([
  'FLIGHT_DELAY_SEVERITY_MAJOR',
  'FLIGHT_DELAY_SEVERITY_SEVERE',
]);
const AVIATION_HISTORY_DELAY_TYPES = new Set([
  'FLIGHT_DELAY_TYPE_CLOSURE',
  'FLIGHT_DELAY_TYPE_GROUND_STOP',
]);
const AVIATION_DISRUPTION_LABELS = {
  FLIGHT_DELAY_TYPE_CLOSURE: 'closure',
  FLIGHT_DELAY_TYPE_GROUND_STOP: 'ground stop',
  FLIGHT_DELAY_TYPE_GROUND_DELAY: 'ground delay',
  FLIGHT_DELAY_TYPE_DEPARTURE_DELAY: 'departure delays',
  FLIGHT_DELAY_TYPE_ARRIVAL_DELAY: 'arrival delays',
};

/**
 * Major and severe disruptions, plus any closure or ground stop (9 of 52 alerts
 * on 2026-11-24). An alert is a per-airport state with a permanent id
 * (`avstack-DXB`) and a `updatedAt` stamped by the seeder's clock, so neither
 * is an event identity. The unit is airport + severity + UTC day: a closure
 * that persists for three days is three rows, and a retraction suppresses that
 * airport's disruption at that severity on that day only.
 */
export function buildAviationHistoryRecords(data) {
  return (data?.alerts ?? []).map((alert) => {
    if (!alert?.iata) return null;
    if (!AVIATION_HISTORY_SEVERITIES.has(alert.severity) && !AVIATION_HISTORY_DELAY_TYPES.has(alert.delayType)) {
      return null;
    }
    const occurredAt = positiveEpoch(alert.updatedAt);
    if (!occurredAt) return null;

    const severity = enumLabel(alert.severity, 'FLIGHT_DELAY_SEVERITY_');
    const delayType = enumLabel(alert.delayType, 'FLIGHT_DELAY_TYPE_');
    const airport = `${alert.name || alert.iata} (${alert.iata})`;
    const disruption = AVIATION_DISRUPTION_LABELS[alert.delayType] ?? 'delays';
    const summary = [
      alert.reason,
      `${alert.cancelledFlights ?? 0} of ${alert.totalFlights ?? 0} sampled departures cancelled`,
      alert.city ? `${alert.city}, ${alert.country}` : alert.country,
    ].filter(Boolean).join('; ');

    return {
      dedupeKey: `aviation:intl:${String(alert.iata).toUpperCase()}:${severity}:${isoDay(occurredAt)}`,
      country: iso2FromName(alert.country),
      category: delayType || undefined,
      title: clip(`${airport}: ${severity} ${disruption}`, TITLE_MAX),
      summary: clip(summary, SUMMARY_MAX),
      occurredAt,
    };
  }).filter(Boolean);
}

export const aviationHistoryAfterPublish = makeSeedHistoryAfterPublish({
  domain: 'aviation',
  resource: 'intl',
  buildRecords: buildAviationHistoryRecords,
});
