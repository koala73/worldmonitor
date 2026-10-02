/**
 * The structured half of GetCountryCoverage (#7526).
 *
 * The country panel reconciles its news coverage against five first-party
 * caches it already holds in the browser. This module reads the same five on
 * the server and shapes them into the same `CountryTimelineIncident` records,
 * so `reconcileCountryTimelineIncidents` can give a structured record precedence
 * over the news reprint that describes it.
 *
 * Every producer reports its own state. A producer that failed, or that this
 * surface cannot reach at all, is never allowed to look like a quiet one — an
 * agent reading `events: []` must be able to tell "nothing happened" from
 * "the protest seeder is down".
 *
 * Containment: the browser tests the loaded country polygon and falls back to a
 * hand-tuned box; the server has no polygon, so it uses the generated
 * shared/country-bboxes.js box for every country. That is reported to the
 * caller in the response's `containment` field rather than hidden. Recognized
 * protest country labels take precedence over this approximate geometry.
 */

import { countryBox, inBox, splitCountryBox, type CountryBox } from '../../../../shared/country-bbox';
import { resolveCountryCode } from '../../../../shared/country-code-resolve';
import { countryMentionTerms, mentionsCountry } from '../../../../shared/country-mention.js';
import type {
  CountryTimelineIncident,
  CountryTimelineSeverity,
} from '../../../../shared/country-timeline-events';
import { readCachedEnvelopeJson } from '../../../_shared/redis';
import { listUnrestEvents } from '../../unrest/v1/list-unrest-events';
import { listEarthquakes } from '../../seismology/v1/list-earthquakes';
import { listAcledEvents } from '../../conflict/v1/list-acled-events';
import { listIranEvents } from '../../conflict/v1/list-iran-events';
import { listMilitaryFlights } from '../../military/v1/list-military-flights';
import type { MilitaryFlight } from '../../../../src/generated/server/worldmonitor/military/v1/service_server';
import type { ServerContext } from '../../../../src/generated/server/worldmonitor/intelligence/v1/service_server';

export type CoverageSourceState =
  | 'ok'
  | 'empty'
  | 'unknown'
  | 'stale'
  | 'failed'
  | 'unavailable';

export interface StructuredSourceResult {
  source: string;
  state: CoverageSourceState;
  detail: string;
  /** Unix ms the producer's snapshot was gathered, or 0 when unknown. */
  fetchedAtMs: number;
  incidents: CountryTimelineIncident[];
}

/**
 * Railway-seeded keys whose envelope carries the `_seed.fetchedAt` stamp.
 *
 * These are also this module's only REACHABILITY signal. The upstream handlers
 * (list-unrest-events, list-earthquakes, list-acled-events) each catch their
 * own failures and return an empty array, so a dead Redis reaches this file as
 * a successful call returning nothing — a `try/catch` here can never see it.
 * Reading the seed key directly is what separates "the seeder published an
 * empty week" from "the seeder is down".
 *
 * ACLED deliberately has no entry: list-acled-events writes per-query keys
 * (`conflict:acled:v1:<country>:<start>:<end>`, a time-varying composite via
 * cachedFetchJson) rather than one seeded snapshot, so there is no key to read
 * and no `_seed` envelope to age against. That is why its producer reports
 * `unknown` rather than `empty` when it returns nothing.
 */
const SEED_KEYS: Record<string, string> = {
  'structured:protests': 'unrest:events:v1',
  'structured:earthquakes': 'seismology:earthquakes:v1',
};

/**
 * Per-producer freshness budget. Exceeding it downgrades the producer to
 * "stale" — it still contributes, exactly as the panel still renders whatever
 * its cache holds, but the caller is told.
 *
 * Only producers with a readable gather time can appear here; a budget on a
 * producer whose age is always unknown would be dead code that reads as a
 * guarantee.
 */
const STALE_AFTER_MS: Record<string, number> = {
  'structured:protests': 24 * 60 * 60 * 1000,
  'structured:earthquakes': 6 * 60 * 60 * 1000,
};

/** Bound on the flights pagination walk, so a misbehaving cursor cannot spin. */
const MAX_FLIGHT_PAGES = 10;

export interface SeedRead {
  /** 'hit' the key exists, 'miss' it does not, 'error' the read itself failed. */
  status: 'hit' | 'miss' | 'error';
  /** Unix ms from the seed envelope, or 0 when the key carries no stamp. */
  fetchedAtMs: number;
}

/**
 * Read a seed key's envelope without disturbing the handler's own read. The
 * STATUS matters as much as the stamp: it is the only way this surface can tell
 * a genuinely quiet producer from an unreachable one.
 */
async function readSeed(key: string): Promise<SeedRead> {
  try {
    const read = await readCachedEnvelopeJson(key, true);
    if (read.status === 'error') return { status: 'error', fetchedAtMs: 0 };
    if (read.status !== 'hit') return { status: 'miss', fetchedAtMs: 0 };
    const envelope = read.value as { _seed?: { fetchedAt?: unknown } } | null;
    const fetchedAt = envelope?._seed?.fetchedAt;
    return {
      status: 'hit',
      fetchedAtMs: typeof fetchedAt === 'number' && Number.isFinite(fetchedAt) ? fetchedAt : 0,
    };
  } catch {
    return { status: 'error', fetchedAtMs: 0 };
  }
}

/**
 * @param healthConfirmed whether this producer proved its upstream was
 *   reachable on THIS call. False means a zero-row result is reported as
 *   `unknown` rather than `empty`, because the producer cannot tell a genuinely
 *   quiet period apart from a dead one.
 */
function settle(
  source: string,
  incidents: CountryTimelineIncident[],
  seed: SeedRead,
  now: number,
  healthConfirmed: boolean,
): StructuredSourceResult {
  const fetchedAtMs = seed.fetchedAtMs;
  // Reachability beats content. The upstream handler swallowed its own error and
  // handed us an empty array; the seed read is what reveals that, so it decides
  // the state before anything is said about how many events matched.
  if (seed.status === 'error') {
    return {
      source,
      state: 'failed',
      detail: 'The backing cache could not be read, so this producer contributed nothing. This is not evidence of a quiet period.',
      fetchedAtMs: 0,
      incidents: [],
    };
  }
  if (seed.status === 'miss') {
    return {
      source,
      state: 'failed',
      detail: 'The backing cache key is absent, so the producer behind it is not publishing. This is not evidence of a quiet period.',
      fetchedAtMs: 0,
      incidents: [],
    };
  }

  const budget = STALE_AFTER_MS[source];
  if (budget && fetchedAtMs > 0 && now - fetchedAtMs > budget) {
    const hours = Math.round((now - fetchedAtMs) / 3_600_000);
    return {
      source,
      state: 'stale',
      detail: `Snapshot is ${hours}h old, past this producer's ${Math.round(budget / 3_600_000)}h budget. Events are still included.`,
      fetchedAtMs,
      incidents,
    };
  }
  if (incidents.length > 0) {
    return { source, state: 'ok', detail: '', fetchedAtMs, incidents };
  }
  // `empty` is a CLAIM that the producer was healthy and simply had nothing.
  // Only make it when the seed read proved the backing cache was there. For a
  // producer with no readable health signal, say `unknown` instead — that is
  // the state a caller is most likely to misread as a quiet week, so it must
  // not be dressed up as one.
  if (!healthConfirmed) {
    return {
      source,
      state: 'unknown',
      detail: 'The producer returned no rows and this surface cannot confirm its upstream was reachable, because the upstream handler reports a failure and a genuinely empty result identically.',
      fetchedAtMs,
      incidents,
    };
  }
  return {
    source,
    state: 'empty',
    detail: 'The producer responded and its backing cache was readable; nothing in it matched this country inside the window.',
    fetchedAtMs,
    incidents,
  };
}

function failed(source: string, detail: string): StructuredSourceResult {
  return { source, state: 'failed', detail, fetchedAtMs: 0, incidents: [] };
}

function unavailable(source: string, detail: string): StructuredSourceResult {
  return { source, state: 'unavailable', detail, fetchedAtMs: 0, incidents: [] };
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : 'Upstream read failed.';
}

/** Mirrors the panel's protest severity ternary. */
function unrestSeverity(severity: string): CountryTimelineSeverity {
  if (severity === 'SEVERITY_LEVEL_HIGH') return 'high';
  if (severity === 'SEVERITY_LEVEL_MEDIUM') return 'medium';
  return 'low';
}

/**
 * Mirrors mapEventType in src/services/unrest/index.ts, which the panel's label
 * is built from. Note the default: CIVIL_UNREST *and* UNSPECIFIED both become
 * the literal `civil_unrest`, underscore included — deriving the word from the
 * enum instead would render "civil unrest" and "unspecified", neither of which
 * the panel ever shows.
 */
function unrestEventLabel(eventType: string): string {
  switch (eventType) {
    case 'UNREST_EVENT_TYPE_PROTEST': return 'protest';
    case 'UNREST_EVENT_TYPE_RIOT': return 'riot';
    case 'UNREST_EVENT_TYPE_STRIKE': return 'strike';
    case 'UNREST_EVENT_TYPE_DEMONSTRATION': return 'demonstration';
    default: return 'civil_unrest';
  }
}

/** Mirrors mapProtoEventType in src/services/conflict/index.ts. */
function acledEventType(eventType: string): string {
  const lower = eventType.toLowerCase();
  if (lower.includes('battle')) return 'battle';
  if (lower.includes('explosion')) return 'explosion';
  if (lower.includes('remote violence')) return 'remote_violence';
  if (lower.includes('violence against')) return 'violence_against_civilians';
  return 'battle';
}

export interface StructuredDependencies {
  listUnrestEvents: typeof listUnrestEvents;
  listEarthquakes: typeof listEarthquakes;
  listAcledEvents: typeof listAcledEvents;
  listIranEvents: typeof listIranEvents;
  listMilitaryFlights: typeof listMilitaryFlights;
  readSeed: (key: string) => Promise<SeedRead>;
  strikeTrackingEnabled?: boolean;
}

export const defaultStructuredDependencies: StructuredDependencies = {
  listUnrestEvents,
  listEarthquakes,
  listAcledEvents,
  listIranEvents,
  listMilitaryFlights,
  readSeed,
  strikeTrackingEnabled: (process.env.IRAN_EVENTS_ENABLED ?? 'false').toLowerCase() === 'true',
};

export interface StructuredRequest {
  ctx: ServerContext;
  code: string;
  countryName: string;
  cutoffMs: number;
  now: number;
  deps?: StructuredDependencies;
}

async function collectProtests(req: StructuredRequest, box: CountryBox | null): Promise<StructuredSourceResult> {
  const source = 'structured:protests';
  const deps = req.deps ?? defaultStructuredDependencies;
  try {
    const [response, seed] = await Promise.all([
      // Resolve exact country identities here; the seed only offers substring matching.
      deps.listUnrestEvents(req.ctx, {
        country: '',
        start: 0,
        end: 0,
        pageSize: 0,
        cursor: '',
        minSeverity: 'SEVERITY_LEVEL_UNSPECIFIED',
        neLat: 0,
        neLon: 0,
        swLat: 0,
        swLon: 0,
      }),
      deps.readSeed(SEED_KEYS[source]!),
    ]);
    const countryLower = req.countryName.toLowerCase();
    const incidents: CountryTimelineIncident[] = [];
    for (const event of response.events) {
      const eventCode = resolveCountryCode(event.country);
      const matches = eventCode ? eventCode === req.code.toUpperCase()
        : event.country?.toLowerCase() === countryLower
          || inBox(box, event.location?.latitude, event.location?.longitude);
      if (!matches) continue;
      if (!Number.isFinite(event.occurredAt) || event.occurredAt < req.cutoffMs) continue;
      incidents.push({
        timestamp: event.occurredAt,
        lane: 'protest',
        label: event.title
          || `${unrestEventLabel(event.eventType)} in ${event.city || event.country}`,
        severity: unrestSeverity(event.severity),
      });
    }
    return settle(source, incidents, seed, req.now, true);
  } catch (error) {
    return failed(source, errorDetail(error));
  }
}

async function collectEarthquakes(req: StructuredRequest, box: CountryBox | null): Promise<StructuredSourceResult> {
  const source = 'structured:earthquakes';
  const deps = req.deps ?? defaultStructuredDependencies;
  try {
    const [response, seed] = await Promise.all([
      deps.listEarthquakes(req.ctx, { start: 0, end: 0, pageSize: 0, cursor: '', minMagnitude: 0 }),
      deps.readSeed(SEED_KEYS[source]!),
    ]);
    // Word-boundary matching via the shared country-mention matcher: a
    // substring test attributes foreign quakes to the wrong country (Nigeria
    // to Niger, Somalia to Mali, Romania to Oman, Indiana to India, South
    // Sudan to Sudan). The shared matcher also scrubs known superstring
    // exclusions (South Sudan vs Sudan, Guinea variants) before matching.
    //
    // Demonyms are dropped for this call site. The shared matcher is tuned for
    // NEWS PROSE, where "Dutch" or "Spanish" is a strong country signal; a USGS
    // `place` is a geographic label, where it is not — "Dutch Harbor, Alaska"
    // would ground the Netherlands, "Spanish Fork, Utah" Spain, and
    // "Philippine Sea" / "Norwegian Sea" their respective countries. Place
    // strings name the country or state outright, so the demonym arm only adds
    // false positives here.
    //
    // NOT closed by this: an EXACT collision between a country name and a US
    // state, i.e. "Georgia". Word boundaries cannot separate those two — the
    // token is identical — and shared/country-mention.js has no GE exclusion
    // (it likewise omits the "Georgian" demonym for the same ambiguity). A
    // quake in Atlanta still matches GE on the name arm; only the bbox test
    // distinguishes them.
    const mentionTerms = { ...countryMentionTerms(req.code), demonyms: [] };
    const incidents: CountryTimelineIncident[] = [];
    for (const quake of response.earthquakes) {
      const matches = inBox(box, quake.location?.latitude, quake.location?.longitude)
        || (typeof quake.place === 'string' && mentionsCountry(quake.place, mentionTerms));
      if (!matches) continue;
      if (!Number.isFinite(quake.occurredAt) || quake.occurredAt < req.cutoffMs) continue;
      incidents.push({
        timestamp: quake.occurredAt,
        lane: 'natural',
        label: `M${quake.magnitude.toFixed(1)} ${quake.place}`,
        severity: quake.magnitude >= 6
          ? 'critical'
          : quake.magnitude >= 5 ? 'high' : quake.magnitude >= 4 ? 'medium' : 'low',
      });
    }
    return settle(source, incidents, seed, req.now, true);
  } catch (error) {
    return failed(source, errorDetail(error));
  }
}

async function collectConflicts(req: StructuredRequest): Promise<StructuredSourceResult> {
  const source = 'structured:conflicts';
  const deps = req.deps ?? defaultStructuredDependencies;
  try {
    // No seed read: ACLED has no single seeded snapshot key (see SEED_KEYS),
    // so this producer reports `unknown` rather than `empty` on zero rows.
    const response = await deps.listAcledEvents(
      req.ctx,
      { country: '', start: 0, end: 0, pageSize: 0, cursor: '' },
    );
    const incidents: CountryTimelineIncident[] = [];
    for (const event of response.events) {
      // The panel groups ACLED rows with the CII name->code map. This surface
      // uses the canonical server resolver, so a name ACLED spells differently
      // still lands on the right country.
      if (resolveCountryCode(event.country) !== req.code) continue;
      if (!Number.isFinite(event.occurredAt) || event.occurredAt < req.cutoffMs) continue;
      incidents.push({
        timestamp: event.occurredAt,
        lane: 'conflict',
        // Mirrors the panel's `${eventType}: ${location || country}` — the
        // client adapter always sets `location` to '', so this is the country.
        label: `${acledEventType(event.eventType)}: ${event.country}`,
        severity: event.fatalities > 0 ? 'critical' : 'high',
      });
    }
    // This lane IS queried globally (country: ''), so rows coming back prove the
    // upstream answered even when none of them are this country's — that is a
    // confirmed-quiet `empty`. Only a globally empty result is unverifiable,
    // because list-acled-events returns exactly that on failure too.
    const healthConfirmed = response.events.length > 0;
    return settle(source, incidents, { status: 'hit', fetchedAtMs: 0 }, req.now, healthConfirmed);
  } catch (error) {
    return failed(source, errorDetail(error));
  }
}

async function collectMilitaryFlights(
  req: StructuredRequest,
  box: CountryBox | null,
): Promise<StructuredSourceResult> {
  const source = 'structured:military-flights';
  const deps = req.deps ?? defaultStructuredDependencies;
  const queryBoxes = box ? splitCountryBox(box) : [];
  if (!queryBoxes.length) {
    return unavailable(source, `No usable flight bounding box for ${req.code}; military flights are matched geographically only.`);
  }
  try {
    // The server bounds every flights response to a page, and the browser
    // follows next_cursor to reassemble the region (military-flights.ts
    // fetchViaProto). Reading only page one would drop military-lane incidents
    // for exactly the busy countries where the lane matters most.
    const flights = new Map<string, MilitaryFlight>();
    for (const bounds of queryBoxes) {
      let cursor = '';
      for (let page = 0; page < MAX_FLIGHT_PAGES; page++) {
        const response = await deps.listMilitaryFlights(req.ctx, {
          pageSize: 0,
          cursor,
          neLat: bounds.north,
          neLon: bounds.east,
          swLat: bounds.south,
          swLon: bounds.west,
          operator: 'MILITARY_OPERATOR_UNSPECIFIED',
          aircraftType: 'MILITARY_AIRCRAFT_TYPE_UNSPECIFIED',
        });
        for (const flight of response.flights) {
          if (inBox(box, flight.location?.latitude, flight.location?.longitude)) flights.set(flight.id, flight);
        }
        const next = response.pagination?.nextCursor ?? '';
        if (!next) break;
        if (next === cursor || page === MAX_FLIGHT_PAGES - 1) {
          return failed(source, 'Military flight pagination was incomplete; this is not evidence of a quiet period.');
        }
        cursor = next;
      }
    }
    const incidents: CountryTimelineIncident[] = [];
    for (const flight of flights.values()) {
      if (!Number.isFinite(flight.lastSeenAt) || flight.lastSeenAt < req.cutoffMs) continue;
      incidents.push({
        timestamp: flight.lastSeenAt,
        lane: 'military',
        label: `${flight.callsign} (${flight.aircraftModel || flight.aircraftType})`,
        severity: flight.isInteresting ? 'high' : 'low',
      });
    }
    // The flights RPC serves a live snapshot and reports no gather time, so
    // there is no fetchedAt to claim. Reporting the newest position instead
    // would read as "gathered then", which is a different fact.
    // Rows in the bbox prove the flights path answered. An empty bbox cannot:
    // a quiet country and a dead upstream look identical through this query.
    const settled = settle(source, incidents, { status: 'hit', fetchedAtMs: 0 }, req.now, flights.size > 0);
    // One bounded, one-directional divergence from the panel, stated rather
    // than hidden: the browser enriches flights with Wingbits aircraft details
    // after the RPC (military-flights.ts enrichFlightsWithWingbits), and a
    // confirmed military branch flips isInteresting false -> true, lifting
    // severity low -> high. That branch is derived from browser-only config, so
    // this surface reads the unenriched value. Severity here can therefore be
    // LOWER than the panel's for the same aircraft, never higher.
    return {
      ...settled,
      detail: settled.detail
        ? `${settled.detail} Severity is un-enriched: the panel may rate the same flight higher.`
        : 'Severity is un-enriched: the panel applies Wingbits aircraft details that can raise a flight from low to high, so this lane can under-rate but never over-rate.',
    };
  } catch (error) {
    return failed(source, errorDetail(error));
  }
}

async function collectStrikes(req: StructuredRequest, box: CountryBox | null): Promise<StructuredSourceResult> {
  const source = 'structured:strikes';
  const deps = req.deps ?? defaultStructuredDependencies;
  try {
    const response = await deps.listIranEvents(req.ctx, {});
    // Both sides of this lane sit behind a default-off flag after the 2026-07
    // sunset: VITE_ENABLE_IRAN_ATTACKS in the browser, IRAN_EVENTS_ENABLED
    // here. The zero sentinel also represents a missing or unreadable cache,
    // so the enabled flag must distinguish an outage from retirement.
    if (response.scrapedAt === '0') {
      if (deps.strikeTrackingEnabled) {
        return failed(source, 'Strike tracking is enabled but its backing cache is missing or unreadable.');
      }
      return unavailable(source, 'Middle East strike tracking is retired (IRAN_EVENTS_ENABLED off).');
    }
    // Unlike ACLED and the flights lane, this handler reports a real gather
    // time when it is enabled, so a zero-row result here is a confirmed quiet
    // period rather than an unverifiable one.
    const scrapedAtMs = Number(response.scrapedAt);
    const fetchedAtMs = Number.isFinite(scrapedAtMs) && scrapedAtMs > 0 ? scrapedAtMs : 0;
    const seen = new Set<string>();
    const incidents: CountryTimelineIncident[] = [];
    for (const event of response.events) {
      if (seen.has(event.id)) continue;
      seen.add(event.id);
      if (!inBox(box, event.latitude, event.longitude)) continue;
      // The panel normalizes a seconds-precision stamp to milliseconds.
      const raw = Number(event.timestamp) || 0;
      const timestamp = raw < 1e12 ? raw * 1000 : raw;
      if (timestamp < req.cutoffMs) continue;
      incidents.push({
        timestamp,
        lane: 'conflict',
        label: event.title || `Strike: ${event.locationName}`,
        severity: (event.severity.toLowerCase() === 'high' || event.severity.toLowerCase() === 'critical')
          ? 'critical'
          : 'high',
      });
    }
    return settle(source, incidents, { status: 'hit', fetchedAtMs }, req.now, true);
  } catch (error) {
    return failed(source, errorDetail(error));
  }
}

/**
 * The browser builds this lane from a live AIS WebSocket it holds open for the
 * session (src/services/military-vessels.ts keeps `trackedVessels` in memory).
 * No server surface holds that stream, and the maritime vessel snapshot RPC
 * serves density zones rather than per-vessel positions, so there is nothing
 * equivalent to read. Declared explicitly so the gap is visible in the response
 * instead of showing up as a silently shorter military lane.
 */
function militaryVesselsUnavailable(): StructuredSourceResult {
  return unavailable(
    'structured:military-vessels',
    'The vessel lane comes from a browser-held live AIS stream that has no server-side equivalent.',
  );
}

export async function collectStructuredIncidents(
  req: StructuredRequest,
): Promise<StructuredSourceResult[]> {
  const box = countryBox(req.code);
  const [protests, earthquakes, conflicts, flights, strikes] = await Promise.all([
    collectProtests(req, box),
    collectEarthquakes(req, box),
    collectConflicts(req),
    collectMilitaryFlights(req, box),
    collectStrikes(req, box),
  ]);
  return [protests, earthquakes, conflicts, flights, militaryVesselsUnavailable(), strikes];
}
