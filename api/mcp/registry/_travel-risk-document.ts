/**
 * Pure assembly for `prepare_travel_risk_assessment` (#10451).
 *
 * Validated trip input plus already-read source snapshots in; a sourced
 * Markdown draft and its structured twin out. No I/O, no clock, no logging:
 * the trip plan never leaves this function except in the returned document.
 *
 * Every finding names its source and the date the source gives for it. A
 * source that could not be read renders as unavailable with the reason, and a
 * readable source with nothing to report says so and names the window, so an
 * absence of data can never read as an absence of risk.
 */

import { CII_COUNTRY_CODES } from '../../../shared/cii-weights';
import { countryBox, inBox } from '../../../shared/country-bbox';
import { resolveCountryCode } from '../../../shared/country-code-resolve';
import { normalizeAdvisoryRegisterLevels, normalizeAdvisorySnapshot } from '../../../shared/intelligence-snapshots.js';
import { countries, hazards, windows, generatedAt } from '../../../shared/seasonal-hazard-calendar.json';

export const TRAVEL_RISK_TOOL = 'prepare_travel_risk_assessment';

/** Days of security history each country section reports. */
export const SECURITY_WINDOW_DAYS = 30;
const DAY_MS = 86_400_000;
/** Findings listed per block before the rest are counted as "more". */
export const DEFAULT_FINDINGS_PER_BLOCK = 5;
const MAX_TEXT_CHARS = 220;

export type FeedId = 'advisories' | 'ucdp' | 'unrest' | 'earthquakes' | 'natural' | 'weather' | 'outbreaks' | 'aviation' | 'outages';

export interface TravelRiskFeed {
  id: FeedId;
  key: string;
  metaKey: string;
  maxStaleMin: number;
  honorContentAge?: true;
  name: string;
}

// Freshness budgets match api/health.js SEED_META for the same keys.
export const TRAVEL_RISK_FEEDS: readonly TravelRiskFeed[] = [
  { id: 'advisories', key: 'intelligence:advisories:v1', metaKey: 'seed-meta:intelligence:advisories', maxStaleMin: 120, name: 'Government travel advisories (US State Dept, UK FCDO, Australia DFAT Smartraveller, CDC travel notices, US embassy alerts)' },
  { id: 'ucdp', key: 'conflict:ucdp-events:v1', metaKey: 'seed-meta:conflict:ucdp-events', maxStaleMin: 420, honorContentAge: true, name: 'UCDP Georeferenced Event Dataset, candidate events' },
  { id: 'unrest', key: 'unrest:events:v1', metaKey: 'seed-meta:unrest:events', maxStaleMin: 120, name: 'World Monitor unrest feed (unverified media signals)' },
  { id: 'earthquakes', key: 'seismology:earthquakes:v1', metaKey: 'seed-meta:seismology:earthquakes', maxStaleMin: 30, name: 'USGS earthquakes of magnitude 4.5 and above over the past 7 days, plus Natural Resources Canada' },
  { id: 'natural', key: 'natural:events:v1', metaKey: 'seed-meta:natural:events', maxStaleMin: 120, name: 'Natural events (GDACS, NASA EONET, NOAA NHC)' },
  { id: 'weather', key: 'weather:alerts:v1', metaKey: 'seed-meta:weather:alerts', maxStaleMin: 45, name: 'Weather alerts (US NWS, Environment Canada, WMO SWIC)' },
  { id: 'outbreaks', key: 'health:disease-outbreaks:v1', metaKey: 'seed-meta:health:disease-outbreaks', maxStaleMin: 2880, name: 'Disease outbreak reports (WHO, CDC, ECDC, CIDRAP and others)' },
  { id: 'aviation', key: 'aviation:delays-bootstrap:v2', metaKey: 'seed-meta:aviation:delays-bootstrap', maxStaleMin: 90, name: 'Monitored airport status (AviationStack, FAA, airport NOTAMs)' },
  { id: 'outages', key: 'infra:outages:v1', metaKey: 'seed-meta:infra:outages', maxStaleMin: 30, name: 'Cloudflare Radar internet outage annotations' },
];

/** Countries the Country Instability Index scores; others get no index read. */
export const CII_SCORED_CODES: ReadonlySet<string> = new Set(CII_COUNTRY_CODES);

export const CII_SOURCE_NAME = 'World Monitor Country Instability Index, daily history';
export const HOTSPOT_SOURCE_NAME = 'World Monitor hotspot escalation model';

/** Topics no feed behind this draft covers. Each renders as an empty heading for the analyst. */
export const ANALYST_SECTIONS: readonly string[] = [
  'Street crime',
  'Medical facilities',
  'Local laws and customs',
  'Emergency contacts',
  'Venue-specific risks',
];

export interface TripCountry {
  countryCode: string;
  countryName: string;
  cities: string[];
  arrive: string | null;
  depart: string | null;
}

export interface TripInput {
  countries: TripCountry[];
  dateFrom: string | null;
  dateTo: string | null;
  taskLabel: string | null;
}

/** One source as read: its payload, or the reason it could not be used. */
export interface SourceSnapshot {
  status: 'ok' | 'unavailable';
  value: unknown;
  reason: string | null;
  /** When the producer last fetched it, as ISO 8601; null when unknown. */
  updatedAt: string | null;
  /** True when `updatedAt` is older than the source's refresh budget or unknown. */
  stale: boolean;
  /** Providers the producer reported as failed at its last refresh; their slice is carried over or missing. */
  failedProviders?: string[];
}

export interface TravelRiskSources {
  feeds: Record<FeedId, SourceSnapshot>;
  /** Keyed by country code, present only for countries the index scores. */
  cii: Record<string, SourceSnapshot>;
  hotspots: SourceSnapshot;
}

export type BlockStatus = 'reported' | 'none' | 'unavailable' | 'not_covered';

export interface Finding {
  text: string;
  source: string;
  /** Date the source gives for this item (YYYY-MM-DD); null when it gives none. */
  observed: string | null;
  url: string | null;
}

export interface Block {
  topic: string;
  status: BlockStatus;
  /** One sentence naming the source and its date, or the reason data is missing. */
  statement: string;
  /** Short source name for the summary. */
  source: string;
  /** Date of the data behind the block (YYYY-MM-DD); null when unknown or not applicable. */
  asOf: string | null;
  /** Items the source reports, newest first; null when the topic is not countable. */
  count: number | null;
  findings: Finding[];
  /** Findings beyond the per-block cap, counted but not listed. */
  omitted: number;
}

export interface CountryBlocks {
  countryCode: string;
  countryName: string;
  blocks: Block[];
}

export interface CountryRating {
  /** 1 to 4 on the shared US and Australian scale; null when unrated. */
  level: number | null;
  statement: string;
}

export interface CountrySummary {
  countryCode: string;
  countryName: string;
  rating: CountryRating;
  paragraph: string;
}

export interface SourceRow {
  source: string;
  updatedAt: string | null;
  status: 'current' | 'out_of_date' | 'unavailable' | 'not_used';
  note: string | null;
}

export interface TravelRiskDocument {
  title: string;
  taskLabel: string | null;
  retrievedAt: string;
  trip: { dateFrom: string | null; dateTo: string | null; countries: TripCountry[] };
  summary: { overallRating: CountryRating; countries: CountrySummary[] };
  advice: CountryBlocks[];
  security: CountryBlocks[];
  hazards: CountryBlocks[];
  health: CountryBlocks[];
  access: CountryBlocks[];
  communications: CountryBlocks[];
  notCovered: Array<{ heading: string; status: 'analyst_to_complete' }>;
  sources: SourceRow[];
  method: string[];
}

export interface TravelRiskResult {
  markdown: string;
  document: TravelRiskDocument;
}

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function list(value: unknown, field: string): unknown[] | null {
  const container = record(value);
  return container && Array.isArray(container[field]) ? container[field] as unknown[] : null;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * Characters that render as nothing or reorder text: direction and zero-width
 * controls, the Unicode tag block and variation selectors (both can carry
 * hidden text to a model reading the draft), soft hyphen and joiner fillers.
 */
const INVISIBLE_CHARS = /[\u061c\u00ad\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff\u{e0000}-\u{e007f}]|[\u034f\ufe00-\ufe0f\u{e0100}-\u{e01ef}]/gu;

/**
 * Feed text is untrusted: one line, no direction or invisible format controls,
 * no table breaks, no live Markdown links, images, emphasis, code spans or
 * HTML, bounded. Straight double quotes become single quotes, because the draft
 * wraps publisher titles in double quotes and a quote inside one could end the
 * quotation and add prose that reads as the draft's own.
 */
export function cleanText(value: unknown, max = MAX_TEXT_CHARS): string {
  const flat = str(value)
    .replace(INVISIBLE_CHARS, '')
    .replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const bounded = [...flat].length > max ? `${[...flat].slice(0, max - 1).join('').trimEnd()}…` : flat;
  return neutraliseAttribution(bounded).replace(/\|/g, '/').replace(/"/g, "'").replace(/[\\[\]<>`*_~]/g, '\\$&');
}

/**
 * The draft appends its own "Source: <name>, <date>." to every finding, so feed
 * text must not carry one. Covers the look-alike colons a feed could use.
 */
function neutraliseAttribution(value: string): string {
  return value.replace(/\b(sources?)\s*[:\uFF1A\uA789\uFE55\u2236]/gi, '$1 -');
}

/**
 * A source name is a label, not prose: it may list outlets, but it must not be
 * able to close the attribution the draft wraps around it and add a clause of
 * its own such as "Source: X, 2026-11-09.".
 */
function sourceLabel(value: string): string {
  return value
    .replace(/\bsources?\s*[:\uFF1A\uA789\uFE55\u2236]/gi, 'source -')
    .replace(/,\s*\d{4}-\d{2}-\d{2}\s*\.?/g, ',')
    .replace(/\s+/g, ' ')
    .replace(/[,\s]+$/, '');
}

function httpsUrl(value: unknown): string | null {
  const url = str(value).trim();
  // A link is shown to the analyst as well as followed: direction and invisible
  // controls could make the shown address differ from the real one.
  const controls = /[\u0000-\u001f\u007f-\u009f]/;
  return /^https:\/\/[^\s<>"]+$/.test(url) && url.length <= 500 && !controls.test(url) && url === url.replace(INVISIBLE_CHARS, '') ? url : null;
}

/** Epoch milliseconds from a number or a parseable string; null otherwise. */
function toMs(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : null;
  if (typeof value === 'string' && value.trim()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric > 0) return numeric;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function isoDate(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString().slice(0, 10);
}

export function formatTimestamp(iso: string | null): string {
  if (!iso) return 'time unknown';
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC` : 'time unknown';
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

function sameCountry(name: unknown, code: string): boolean {
  return typeof name === 'string' && resolveCountryCode(name) === code;
}

function normalizedCity(value: string): string {
  return value.normalize('NFKD').replace(/\p{Diacritic}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function inListedCity(city: unknown, cities: string[]): boolean {
  const target = normalizedCity(str(city));
  return target.length > 0 && cities.some((listed) => normalizedCity(listed) === target);
}

/** "data updated <time>", plus an out-of-date flag the reader cannot miss. */
function updatedPhrase(source: SourceSnapshot): string {
  const when = `data updated ${formatTimestamp(source.updatedAt)}`;
  return source.stale ? `${when}, past its refresh window, so it may be out of date` : when;
}

function unavailableBlock(topic: string, sourceName: string, reason: string): Block {
  return {
    topic,
    status: 'unavailable',
    statement: `Unavailable: ${reason} (${sourceName}). This is not a finding of no risk.`,
    source: sourceName,
    asOf: null,
    count: null,
    findings: [],
    omitted: 0,
  };
}

function notCoveredBlock(topic: string, statement: string): Block {
  return { topic, status: 'not_covered', statement: `Not covered: ${statement}`, source: '', asOf: null, count: null, findings: [], omitted: 0 };
}

interface Dated { ms: number | null; finding: Finding }

function listBlock(
  topic: string,
  items: Dated[],
  cap: number,
  statements: { reported: string; none: string },
): Block {
  const sorted = [...items].sort((a, b) => (b.ms ?? 0) - (a.ms ?? 0));
  const shown = sorted.slice(0, Math.max(0, cap)).map((item) => item.finding);
  return {
    topic,
    status: items.length === 0 ? 'none' : 'reported',
    statement: items.length === 0 ? statements.none : statements.reported,
    source: '',
    asOf: null,
    count: items.length,
    findings: shown,
    omitted: sorted.length - shown.length,
  };
}

/**
 * Builds one block, turning an unexpected payload shape into an unavailable
 * block for that topic alone. The thrown error is discarded on purpose: its
 * message can quote feed text, and nothing here may reach a log.
 */
function isolated(topic: string, sourceName: string, build: () => Block): Block {
  try {
    return build();
  } catch {
    return unavailableBlock(topic, sourceName, 'the source data could not be read in the expected shape');
  }
}

/** Names the source and data date a listed block's summary clause cites. */
function withOrigin(block: Block, source: string, snapshot: SourceSnapshot): Block {
  if (block.status !== 'reported' && block.status !== 'none') return block;
  return { ...block, source: block.source || source, asOf: block.asOf ?? isoDate(toMs(snapshot.updatedAt)) };
}

interface Window { fromMs: number; toMs: number; from: string; to: string }

function securityWindow(nowMs: number): Window {
  const fromMs = nowMs - SECURITY_WINDOW_DAYS * DAY_MS;
  return { fromMs, toMs: nowMs, from: isoDate(fromMs)!, to: isoDate(nowMs)! };
}

// ---------------------------------------------------------------------------
// Government advice
// ---------------------------------------------------------------------------

const REGISTER_SOURCES = {
  us: 'US State Dept',
  uk: 'UK FCDO',
  au: 'Australia DFAT Smartraveller',
  cdc: 'CDC Travel Notices',
} as const;

const SHARED_SCALE_LEVEL: Record<string, number> = { normal: 1, caution: 2, reconsider: 3, 'do-not-travel': 4 };

const UK_WARNING_TEXT: Record<string, string> = {
  'all-whole': 'advises against all travel to the whole country',
  'essential-whole': 'advises against all but essential travel to the whole country',
  'all-parts': 'advises against all travel to parts of the country',
  'essential-parts': 'advises against all but essential travel to parts of the country',
};

interface RegisterRow { country: string; title: string; source: string; level: string; pubDate: string; link: string }

interface AdviceRead {
  ok: true;
  registers: RegisterRow[];
  advisories: Array<{ title: string; link: string; pubDate: string; source: string; country?: string }>;
}

function readAdvice(source: SourceSnapshot): AdviceRead | { ok: false; reason: string } {
  if (source.status !== 'ok') return { ok: false, reason: source.reason ?? 'the advisory snapshot could not be read' };
  const snapshot = normalizeAdvisorySnapshot(source.value);
  if (!snapshot) return { ok: false, reason: 'the advisory snapshot is incomplete or marked as failed' };
  return { ok: true, registers: normalizeAdvisoryRegisterLevels(source.value) as RegisterRow[], advisories: snapshot.advisories };
}

function latestRow(rows: RegisterRow[]): RegisterRow | null {
  return [...rows].sort((a, b) => (toMs(b.pubDate) ?? 0) - (toMs(a.pubDate) ?? 0))[0] ?? null;
}

function ukWarning(level: string): string {
  if (level === 'none') return 'no FCDO advice against travel';
  return level.split('+').map((part) => UK_WARNING_TEXT[part] ?? part).join('; it also ');
}

function registerLevelText(row: RegisterRow): string {
  if (row.source === REGISTER_SOURCES.uk) return `UK FCDO ${ukWarning(row.level)}`;
  if (row.source === REGISTER_SOURCES.cdc) return `CDC travel health notice level ${row.level.replace('cdc-', '')} of 4`;
  const level = SHARED_SCALE_LEVEL[row.level];
  return level ? `Level ${level} of 4` : `level "${cleanText(row.level, 40)}"`;
}

function registerBlock(advice: AdviceRead, code: string, name: string, source: string): Block {
  const row = latestRow(advice.registers.filter((entry) => entry.country === code && entry.source === source));
  if (!row) {
    return unavailableBlock(source, source, `the ${source} register as read holds no entry for ${name}`);
  }
  const finding: Finding = {
    text: `${registerLevelText(row)}. Published title: "${cleanText(row.title)}".`,
    source,
    observed: isoDate(toMs(row.pubDate)),
    url: httpsUrl(row.link),
  };
  return {
    topic: source,
    status: 'reported',
    statement: `${source} entry for ${name}.`,
    source,
    asOf: finding.observed,
    count: 1,
    findings: [finding],
    omitted: 0,
  };
}

function embassyBlock(advice: AdviceRead, code: string, name: string, cap: number, updated: string): Block {
  const alerts = advice.advisories
    .filter((item) => item.country === code && /\bembassy\b/i.test(item.source))
    .map((item): Dated => {
      const ms = toMs(item.pubDate);
      return { ms, finding: { text: `"${cleanText(item.title)}"`, source: sourceLabel(cleanText(item.source, 80)), observed: isoDate(ms), url: httpsUrl(item.link) } };
    });
  return listBlock('US embassy alerts', alerts, cap, {
    reported: `${plural(alerts.length, 'US embassy alert', 'US embassy alerts')} for ${name} in the advisory snapshot, which keeps the latest alerts each embassy feed publishes (${updated}).`,
    none: `No US embassy alert for ${name} in the advisory snapshot, which keeps the latest alerts of a fixed set of US embassy feeds (${updated}).`,
  });
}

function adviceBlocks(sources: TravelRiskSources, trip: TripCountry, cap: number): Block[] {
  const feed = sources.feeds.advisories;
  const advice = readAdvice(feed);
  const feedName = 'government travel advisories';
  if (!advice.ok) return [unavailableBlock('Government travel advice', feedName, advice.reason)];
  const updated = updatedPhrase(feed);
  return [
    isolated(REGISTER_SOURCES.us, REGISTER_SOURCES.us, () => registerBlock(advice, trip.countryCode, trip.countryName, REGISTER_SOURCES.us)),
    isolated(REGISTER_SOURCES.uk, REGISTER_SOURCES.uk, () => registerBlock(advice, trip.countryCode, trip.countryName, REGISTER_SOURCES.uk)),
    isolated(REGISTER_SOURCES.au, REGISTER_SOURCES.au, () => registerBlock(advice, trip.countryCode, trip.countryName, REGISTER_SOURCES.au)),
    withOrigin(isolated('US embassy alerts', feedName, () => embassyBlock(advice, trip.countryCode, trip.countryName, cap, updated)), 'US embassy feeds', feed),
  ];
}

/**
 * The higher of the US and Australian levels, which share a four-level scale.
 * The UK and CDC scales are reported beside it, never converted onto it.
 */
export function rateCountry(sources: TravelRiskSources, trip: TripCountry): CountryRating {
  const advice = readAdvice(sources.feeds.advisories);
  if (!advice.ok) return { level: null, statement: `Unrated: the advisory register is unavailable (${advice.reason}).` };
  const rated = [REGISTER_SOURCES.us, REGISTER_SOURCES.au].flatMap((source) => {
    const row = latestRow(advice.registers.filter((entry) => entry.country === trip.countryCode && entry.source === source));
    const level = row ? SHARED_SCALE_LEVEL[row.level] : undefined;
    return row && level ? [{ source, level, date: isoDate(toMs(row.pubDate)) }] : [];
  });
  const uk = latestRow(advice.registers.filter((entry) => entry.country === trip.countryCode && entry.source === REGISTER_SOURCES.uk));
  const ukText = uk
    ? ` UK FCDO, on its own scale: ${ukWarning(uk.level)} (${isoDate(toMs(uk.pubDate)) ?? 'date not given by the source'}).`
    : '';
  const cdc = latestRow(advice.registers.filter((entry) => entry.country === trip.countryCode && entry.source === REGISTER_SOURCES.cdc));
  const cdcText = cdc
    ? ` CDC travel health notice, on its own scale: level ${cleanText(cdc.level.replace('cdc-', ''), 10)} of 4 (${isoDate(toMs(cdc.pubDate)) ?? 'date not given by the source'}).`
    : '';
  if (rated.length === 0) {
    return { level: null, statement: `Unrated: no US State Dept or Australia DFAT Smartraveller level for ${trip.countryName} is on record.${ukText}${cdcText}` };
  }
  const level = Math.max(...rated.map((entry) => entry.level));
  const setBy = rated.filter((entry) => entry.level === level)
    .map((entry) => `${entry.source}, ${entry.date ?? 'date not given by the source'}`).join('; ');
  return { level, statement: `Level ${level} of 4, the higher of the US State Dept and Australia DFAT Smartraveller levels (set by ${setBy}).${ukText}${cdcText}` };
}

// ---------------------------------------------------------------------------
// Security
// ---------------------------------------------------------------------------

const VIOLENCE_TYPES: Record<string, string> = {
  UCDP_VIOLENCE_TYPE_STATE_BASED: 'State-based armed conflict',
  UCDP_VIOLENCE_TYPE_NON_STATE: 'Non-state armed conflict',
  UCDP_VIOLENCE_TYPE_ONE_SIDED: 'One-sided violence',
};

function ucdpBlock(source: SourceSnapshot, trip: TripCountry, window: Window, cap: number): Block {
  const topic = 'Armed conflict events';
  const name = 'UCDP';
  if (source.status !== 'ok') return unavailableBlock(topic, name, source.reason ?? 'the event feed could not be read');
  const events = list(source.value, 'events');
  if (!events) return unavailableBlock(topic, name, 'the event feed did not have the expected shape');
  const matched = events.flatMap((raw): Dated[] => {
    const event = record(raw);
    if (!event || !sameCountry(event.country, trip.countryCode)) return [];
    const ms = toMs(event.dateStart);
    if (ms === null || ms < window.fromMs || ms > window.toMs) return [];
    const deaths = typeof event.deathsBest === 'number' && Number.isFinite(event.deathsBest) ? event.deathsBest : null;
    const sides = [cleanText(event.sideA, 80), cleanText(event.sideB, 80)].filter(Boolean).join(' vs ');
    const place = cleanText(event.locationName, 80);
    const text = [
      VIOLENCE_TYPES[str(event.violenceType)] ?? 'Armed violence',
      sides ? `: ${sides}` : '',
      place ? `, ${place}` : '',
      deaths === null ? '.' : `. Best estimate ${plural(deaths, 'death', 'deaths')}.`,
    ].join('');
    return [{ ms, finding: { text, source: 'UCDP GED', observed: isoDate(ms), url: null } }];
  });
  const updated = updatedPhrase(source);
  return listBlock(topic, matched, cap, {
    reported: `${plural(matched.length, 'UCDP armed conflict event', 'UCDP armed conflict events')} in ${trip.countryName} dated ${window.from} to ${window.to} (UCDP GED, ${updated}).`,
    none: `No UCDP armed conflict event in ${trip.countryName} dated ${window.from} to ${window.to} (UCDP GED, ${updated}). UCDP publishes candidate events with a lag, so the latest weeks can be incomplete.`,
  });
}

function unrestBlock(source: SourceSnapshot, trip: TripCountry, window: Window, cap: number): Block {
  const topic = 'Unrest signals';
  const name = 'World Monitor unrest feed';
  if (source.status !== 'ok') return unavailableBlock(topic, name, source.reason ?? 'the unrest feed could not be read');
  const events = list(source.value, 'events');
  if (!events) return unavailableBlock(topic, name, 'the unrest feed did not have the expected shape');
  const matched = events.flatMap((raw): Dated[] => {
    const event = record(raw);
    if (!event || !sameCountry(event.country, trip.countryCode)) return [];
    const ms = toMs(event.occurredAt);
    if (ms === null || ms < window.fromMs || ms > window.toMs) return [];
    const city = cleanText(event.city, 80);
    const marker = inListedCity(event.city, trip.cities) ? ' In a listed city.' : '';
    const outlets = Array.isArray(event.sources) ? event.sources.map((item) => sourceLabel(cleanText(item, 60))).filter(Boolean).slice(0, 2) : [];
    const urls = Array.isArray(event.sourceUrls) ? event.sourceUrls : [];
    return [{
      ms,
      finding: {
        text: `Unverified media signal: "${cleanText(event.title)}"${city ? `, ${city}` : ''}.${marker}`,
        source: outlets.length ? `World Monitor unrest feed, reported by ${outlets.join(', ')}` : 'World Monitor unrest feed',
        observed: isoDate(ms),
        url: httpsUrl(urls[0]),
      },
    }];
  });
  const updated = updatedPhrase(source);
  return listBlock(topic, matched, cap, {
    reported: `${plural(matched.length, 'unverified media signal', 'unverified media signals')} of unrest in ${trip.countryName} dated ${window.from} to ${window.to} (World Monitor unrest feed, ${updated}). These are media reports, not verified incidents.`,
    none: `No unverified media signal of unrest in ${trip.countryName} dated ${window.from} to ${window.to} (World Monitor unrest feed, ${updated}).`,
  });
}

function hotspotBlock(source: SourceSnapshot, trip: TripCountry, cap: number): Block {
  const topic = 'Curated hotspots';
  const box = countryBox(trip.countryCode);
  if (!box) return notCoveredBlock(topic, `World Monitor has no bounding box for ${trip.countryName}, so hotspots cannot be placed in it.`);
  if (source.status !== 'ok') return unavailableBlock(topic, HOTSPOT_SOURCE_NAME, source.reason ?? 'the hotspot model could not be run');
  const hotspots = list(record(source.value)?.data, 'hotspots');
  if (!hotspots) return unavailableBlock(topic, HOTSPOT_SOURCE_NAME, 'the hotspot model returned no hotspot list');
  const observed = isoDate(toMs(source.updatedAt));
  const matched = hotspots.flatMap((raw): Dated[] => {
    const hotspot = record(raw);
    if (!hotspot || !inBox(box, Number(hotspot.lat), Number(hotspot.lon))) return [];
    const score = typeof hotspot.combinedScore === 'number' ? hotspot.combinedScore : null;
    const trend = cleanText(hotspot.trend, 30);
    return [{
      ms: score === null ? 0 : score,
      finding: {
        text: `${cleanText(hotspot.name, 80)}: escalation ${score === null ? 'not scored' : `${score.toFixed(1)} on a 1 to 5 scale`}${trend ? `, trend ${trend}` : ''}.`,
        source: HOTSPOT_SOURCE_NAME,
        observed,
        url: null,
      },
    }];
  });
  const updated = updatedPhrase(source);
  return listBlock(topic, matched, cap, {
    reported: `${plural(matched.length, 'curated hotspot lies', 'curated hotspots lie')} inside ${trip.countryName}'s bounding box (${HOTSPOT_SOURCE_NAME}, ${updated}).`,
    none: `None of the curated hotspots lies inside ${trip.countryName}'s bounding box (${HOTSPOT_SOURCE_NAME}, ${updated}).`,
  });
}

function ciiBlock(sources: TravelRiskSources, trip: TripCountry): Block {
  const topic = 'Instability index';
  if (!CII_SCORED_CODES.has(trip.countryCode)) {
    return notCoveredBlock(topic, `the Country Instability Index scores ${CII_SCORED_CODES.size} countries and ${trip.countryName} is not one of them.`);
  }
  const source = sources.cii[trip.countryCode];
  if (!source || source.status !== 'ok') return unavailableBlock(topic, CII_SOURCE_NAME, source?.reason ?? 'the daily score history could not be read');
  const history = record(record(source.value)?.history);
  const points = Array.isArray(history?.points) ? history.points.map(record).filter((point) => point !== null) : [];
  const last = points[points.length - 1];
  if (!history || !last || typeof last.combinedScore !== 'number' || typeof last.date !== 'string') {
    return unavailableBlock(topic, CII_SOURCE_NAME, `no current-method daily score in the last ${SECURITY_WINDOW_DAYS} days`);
  }
  const version = cleanText(history.methodologyVersion, 20);
  const change = record(history.change);
  const delta = change && typeof change.delta === 'number' ? change.delta : null;
  const direction = delta === null
    ? 'Only one daily score is in the window, so no direction is given.'
    : delta === 0
      ? `Unchanged since ${cleanText(change!.fromDate, 10)}.`
      : `${delta > 0 ? 'Up' : 'Down'} ${Math.abs(delta).toFixed(1)} points since ${cleanText(change!.fromDate, 10)}.`;
  const stale = history.stale === true ? ' The latest score is older than the index refresh window, so it may be out of date.' : '';
  return {
    topic,
    status: 'reported',
    statement: `Daily score history for the last ${SECURITY_WINDOW_DAYS} days (${CII_SOURCE_NAME}${version ? `, methodology ${version}` : ''}).${stale}`,
    source: 'Country Instability Index',
    asOf: cleanText(last.date, 10),
    count: null,
    findings: [{
      text: `Instability score ${last.combinedScore.toFixed(1)} of 100. ${direction}`,
      source: CII_SOURCE_NAME,
      observed: cleanText(last.date, 10),
      url: null,
    }],
    omitted: 0,
  };
}

function securityBlocks(sources: TravelRiskSources, trip: TripCountry, window: Window, cap: number): Block[] {
  return [
    withOrigin(isolated('Armed conflict events', 'UCDP', () => ucdpBlock(sources.feeds.ucdp, trip, window, cap)), 'UCDP GED', sources.feeds.ucdp),
    withOrigin(isolated('Unrest signals', 'World Monitor unrest feed', () => unrestBlock(sources.feeds.unrest, trip, window, cap)), 'World Monitor unrest feed', sources.feeds.unrest),
    withOrigin(isolated('Curated hotspots', HOTSPOT_SOURCE_NAME, () => hotspotBlock(sources.hotspots, trip, cap)), 'hotspot model', sources.hotspots),
    isolated('Instability index', CII_SOURCE_NAME, () => ciiBlock(sources, trip)),
  ];
}

// ---------------------------------------------------------------------------
// Natural hazards
// ---------------------------------------------------------------------------

const NATURAL_TOPIC = 'Natural events and tropical cyclones';

const WEATHER_SOURCE_NAMES: Record<string, string> = { nws: 'US NWS', eccc: 'Environment Canada', swic: 'WMO SWIC' };

function weatherBlock(source: SourceSnapshot, trip: TripCountry, cap: number, nowMs: number): Block {
  const topic = 'Weather alerts';
  const name = 'weather alert feed';
  if (source.status !== 'ok') return unavailableBlock(topic, name, source.reason ?? 'the alert feed could not be read');
  const alerts = list(source.value, 'alerts');
  if (!alerts) return unavailableBlock(topic, name, 'the alert feed did not have the expected shape');
  const provider = trip.countryCode === 'US' ? 'nws' : trip.countryCode === 'CA' ? 'eccc' : 'swic';
  const providerFailed = source.failedProviders?.includes(provider) === true;
  const providerNote = providerFailed ? `${WEATHER_SOURCE_NAMES[provider]} did not refresh at the last update, so its alerts may be missing or carried from an earlier refresh` : '';
  const matched = alerts.flatMap((raw): Dated[] => {
    const alert = record(raw);
    if (!alert || str(alert.countryCode).toUpperCase() !== trip.countryCode) return [];
    // An alert can lapse between cache refreshes; the set is "current" at retrieval.
    const expiresMs = toMs(alert.expires);
    if (expiresMs !== null && expiresMs <= nowMs) return [];
    const onset = toMs(alert.onset);
    const expires = isoDate(expiresMs);
    const area = cleanText(alert.areaDesc, 120);
    return [{
      ms: onset,
      finding: {
        text: `${cleanText(alert.event, 60) || 'Alert'}: "${cleanText(alert.headline)}"${area ? `, ${area}` : ''}.${expires ? ` Expires ${expires}.` : ''}`,
        source: WEATHER_SOURCE_NAMES[str(alert.source)] ?? 'Weather alert feed',
        observed: isoDate(onset),
        url: null,
      },
    }];
  });
  if (providerFailed && matched.length === 0) return unavailableBlock(topic, name, providerNote);
  const updated = updatedPhrase(source);
  return listBlock(topic, matched, cap, {
    reported: `${plural(matched.length, 'weather alert', 'weather alerts')} for ${trip.countryName} in the current alert set (US NWS, Environment Canada, WMO SWIC, ${updated}).${providerNote ? ` Note: ${providerNote}.` : ''}`,
    none: `No weather alert for ${trip.countryName} in the current alert set (US NWS, Environment Canada, WMO SWIC, ${updated}). The set keeps at most 50 alerts worldwide, ranked by severity, so an alert in force can be missing from it.`,
  });
}

function earthquakeBlock(source: SourceSnapshot, trip: TripCountry, cap: number): Block {
  const topic = 'Earthquakes';
  const name = 'earthquake feed';
  const box = countryBox(trip.countryCode);
  if (!box) return notCoveredBlock(topic, `World Monitor has no bounding box for ${trip.countryName}, so earthquakes cannot be placed in it.`);
  if (source.status !== 'ok') return unavailableBlock(topic, name, source.reason ?? 'the earthquake feed could not be read');
  const quakes = list(source.value, 'earthquakes');
  if (!quakes) return unavailableBlock(topic, name, 'the earthquake feed did not have the expected shape');
  const matched = quakes.flatMap((raw): Dated[] => {
    const quake = record(raw);
    const location = record(quake?.location);
    if (!quake || !location || !inBox(box, Number(location.latitude), Number(location.longitude))) return [];
    const ms = toMs(quake.occurredAt);
    const magnitude = typeof quake.magnitude === 'number' ? `M${quake.magnitude.toFixed(1)}` : 'Magnitude not given';
    return [{
      ms,
      finding: {
        text: `${magnitude}, ${cleanText(quake.place, 120) || 'place not given'}.`,
        source: sourceLabel(cleanText(quake.source, 40)) || 'USGS',
        observed: isoDate(ms),
        url: httpsUrl(quake.sourceUrl),
      },
    }];
  });
  const updated = updatedPhrase(source);
  return listBlock(topic, matched, cap, {
    reported: `${plural(matched.length, 'earthquake', 'earthquakes')} of magnitude 4.5 or more inside ${trip.countryName}'s bounding box in the past 7 days (USGS and Natural Resources Canada, ${updated}).`,
    none: `No earthquake of magnitude 4.5 or more inside ${trip.countryName}'s bounding box in the past 7 days (USGS and Natural Resources Canada, ${updated}).`,
  });
}

function naturalEventBlock(source: SourceSnapshot, trip: TripCountry, cap: number): Block {
  const topic = NATURAL_TOPIC;
  const name = 'natural event feed';
  const box = countryBox(trip.countryCode);
  if (!box) return notCoveredBlock(topic, `World Monitor has no bounding box for ${trip.countryName}, so natural events cannot be placed in it.`);
  if (source.status !== 'ok') return unavailableBlock(topic, name, source.reason ?? 'the natural event feed could not be read');
  const events = list(source.value, 'events');
  if (!events) return unavailableBlock(topic, name, 'the natural event feed did not have the expected shape');
  const matched = events.flatMap((raw): Dated[] => {
    const event = record(raw);
    if (!event || event.closed === true || !inBox(box, Number(event.lat), Number(event.lon))) return [];
    const ms = toMs(event.date);
    const alert = cleanText(event.alertLevel, 20);
    return [{
      ms,
      finding: {
        text: `${cleanText(event.categoryTitle, 60) || 'Natural event'}: "${cleanText(event.title)}"${alert ? `, GDACS alert ${alert}` : ''}.`,
        source: sourceLabel(cleanText(event.sourceName, 40)) || 'NASA EONET',
        observed: isoDate(ms),
        url: httpsUrl(event.sourceUrl),
      },
    }];
  });
  const updated = updatedPhrase(source);
  return listBlock(topic, matched, cap, {
    reported: `${plural(matched.length, 'open natural event', 'open natural events')} inside ${trip.countryName}'s bounding box (GDACS, NASA EONET, NOAA NHC, ${updated}).`,
    none: `No open natural event inside ${trip.countryName}'s bounding box in the current snapshot (GDACS, NASA EONET, NOAA NHC, ${updated}). The snapshot keeps a bounded list worldwide.`,
  });
}

const SEASONAL_TOPIC = 'Seasonal hazards';
const SEASONAL_SOURCE = 'GDACS event archive';
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A hazard is in season for a month when GDACS recorded it in at least this many years and this share of the window. */
export const SEASON_MIN_YEARS = 3;
export const SEASON_MIN_SHARE = 0.2;

export interface SeasonalCalendar {
  hazards: Record<string, string>;
  windows: Record<string, { fromYear: number; toYear: number }>;
  generatedAt: string;
  /** Country code, then hazard code, then 12 counts: years in the window with an event starting that month. */
  countries: Record<string, Record<string, number[]>>;
}

// Named JSON imports keep build-time source/method metadata out of the Edge bundle.
const SEASONAL_CALENDAR: SeasonalCalendar = { countries, hazards, windows, generatedAt };

/** Calendar months (1 to 12) a trip touches, from its first and last date; null when no usable date is given. */
function tripMonths(from: string | null, to: string | null): number[] | null {
  const parse = (value: string | null) => {
    const match = value ? /^(\d{4})-(\d{2})-\d{2}/.exec(value) : null;
    return match ? { year: Number(match[1]), month: Number(match[2]) } : null;
  };
  const start = parse(from) ?? parse(to);
  const end = parse(to) ?? start;
  if (!start || !end || start.month < 1 || start.month > 12 || end.month < 1 || end.month > 12) return null;
  const span = (end.year - start.year) * 12 + (end.month - start.month);
  if (span < 0) return [start.month];
  const months = new Set<number>();
  for (let step = 0; step <= Math.min(span, 11); step++) months.add(((start.month - 1 + step) % 12) + 1);
  return [...months];
}

export function seasonalBlock(trip: TripCountry, input: TripInput, calendar: SeasonalCalendar = SEASONAL_CALENDAR): Block {
  const from = trip.arrive ?? input.dateFrom;
  const to = trip.depart ?? input.dateTo;
  const months = tripMonths(from, to);
  if (!months) return unavailableBlock(SEASONAL_TOPIC, SEASONAL_SOURCE, 'the trip has no dates, so a season cannot be matched to it');
  const hazards = Object.prototype.hasOwnProperty.call(calendar.countries, trip.countryCode) ? calendar.countries[trip.countryCode] : undefined;
  if (!hazards) {
    return unavailableBlock(SEASONAL_TOPIC, SEASONAL_SOURCE, `the archive records no tropical cyclone or flood event affecting ${trip.countryName}, so no season can be derived`);
  }
  const dates = ` for ${from ?? 'an open start'} to ${to ?? 'an open end'}`;
  const findings: Finding[] = [];
  for (const [code, label] of Object.entries(calendar.hazards)) {
    const counts = hazards[code];
    const window = calendar.windows[code];
    if (!counts || !window) continue;
    const years = window.toYear - window.fromYear + 1;
    const inSeason = months.filter((month) => {
      const count = counts[month - 1] ?? 0;
      return count >= SEASON_MIN_YEARS && count / years >= SEASON_MIN_SHARE;
    });
    if (inSeason.length === 0) continue;
    const detail = inSeason.map((month) => `${MONTH_NAMES[month - 1]} in ${counts[month - 1]} of ${years} years`).join(', ');
    findings.push({
      text: `${label}: GDACS recorded events affecting ${trip.countryName} that began in ${detail} (${window.fromYear} to ${window.toYear}). Recorded history, not a forecast.`,
      source: SEASONAL_SOURCE,
      observed: null,
      url: 'https://www.gdacs.org/',
    });
  }
  const covered = Object.entries(calendar.hazards).map(([code, label]) => {
    const window = calendar.windows[code];
    return window ? `${label.toLowerCase()} events ${window.fromYear} to ${window.toYear}` : label.toLowerCase();
  }).join(', ');
  const limits = `This is a record of GDACS alerts (${covered}; calendar built ${calendar.generatedAt}), not a forecast, and it does not cover wildfire, extreme heat, drought or monsoon rainfall.`;
  return {
    topic: SEASONAL_TOPIC,
    status: findings.length === 0 ? 'none' : 'reported',
    statement: findings.length === 0
      ? `No tropical cyclone or flood season recorded for ${trip.countryName}${dates} (${SEASONAL_SOURCE}). ${limits}`
      : `${plural(findings.length, 'hazard', 'hazards')} recorded in season for ${trip.countryName}${dates} (${SEASONAL_SOURCE}). ${limits}`,
    source: SEASONAL_SOURCE,
    asOf: calendar.generatedAt,
    count: findings.length,
    findings,
    omitted: 0,
  };
}

function hazardBlocks(sources: TravelRiskSources, trip: TripCountry, input: TripInput, cap: number, nowMs: number): Block[] {
  return [
    withOrigin(isolated('Weather alerts', 'weather alert feed', () => weatherBlock(sources.feeds.weather, trip, cap, nowMs)), 'US NWS, Environment Canada, WMO SWIC', sources.feeds.weather),
    withOrigin(isolated('Earthquakes', 'earthquake feed', () => earthquakeBlock(sources.feeds.earthquakes, trip, cap)), 'USGS and NRCan', sources.feeds.earthquakes),
    withOrigin(isolated(NATURAL_TOPIC, 'natural event feed', () => naturalEventBlock(sources.feeds.natural, trip, cap)), 'GDACS, NASA EONET, NOAA NHC', sources.feeds.natural),
    seasonalBlock(trip, input),
  ];
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

function outbreakBlock(source: SourceSnapshot, trip: TripCountry, cap: number): Block {
  const topic = 'Disease outbreak reports';
  const name = 'disease outbreak feed';
  if (source.status !== 'ok') return unavailableBlock(topic, name, source.reason ?? 'the outbreak feed could not be read');
  const outbreaks = list(source.value, 'outbreaks');
  if (!outbreaks) return unavailableBlock(topic, name, 'the outbreak feed did not have the expected shape');
  const matched = outbreaks.flatMap((raw): Dated[] => {
    const outbreak = record(raw);
    if (!outbreak || str(outbreak.countryCode).toUpperCase() !== trip.countryCode) return [];
    // The producer stamps an undated report with its fetch time and marks the id.
    const ms = str(outbreak.id).endsWith('-undated') ? null : toMs(outbreak.publishedAt);
    const location = cleanText(outbreak.location, 80);
    const level = cleanText(outbreak.alertLevel, 20);
    return [{
      ms,
      finding: {
        text: `${cleanText(outbreak.disease, 60) || 'Disease report'}${location ? `, ${location}` : ''}${level ? `. Alert level ${level}` : ''}.`,
        source: sourceLabel(cleanText(outbreak.sourceName, 40)) || 'Disease outbreak feed',
        observed: isoDate(ms),
        url: httpsUrl(outbreak.sourceUrl),
      },
    }];
  });
  const updated = updatedPhrase(source);
  return listBlock(topic, matched, cap, {
    reported: `${plural(matched.length, 'outbreak report names', 'outbreak reports name')} ${trip.countryName} in the current snapshot (WHO, CDC, ECDC, CIDRAP and others, ${updated}).`,
    none: `No outbreak report names ${trip.countryName} in the current snapshot (WHO, CDC, ECDC, CIDRAP and others, ${updated}). The snapshot keeps a bounded list of recent reports worldwide.`,
  });
}

function cdcBlock(sources: TravelRiskSources, trip: TripCountry, cap: number): Block {
  const topic = 'CDC travel health notices';
  const feed = sources.feeds.advisories;
  const advice = readAdvice(feed);
  if (!advice.ok) return unavailableBlock(topic, 'government travel advisories', advice.reason);
  const rows = advice.registers
    .filter((row) => row.country === trip.countryCode && row.source === REGISTER_SOURCES.cdc)
    .map((row): Dated => {
      const ms = toMs(row.pubDate);
      return { ms, finding: { text: `${registerLevelText(row)}: "${cleanText(row.title)}".`, source: 'CDC', observed: isoDate(ms), url: httpsUrl(row.link) } };
    });
  const updated = updatedPhrase(feed);
  return listBlock(topic, rows, cap, {
    reported: `${plural(rows.length, 'CDC travel health notice names', 'CDC travel health notices name')} ${trip.countryName} (CDC, ${updated}).`,
    none: `No CDC travel health notice names ${trip.countryName} (CDC, ${updated}).`,
  });
}

function healthBlocks(sources: TravelRiskSources, trip: TripCountry, cap: number): Block[] {
  return [
    withOrigin(isolated('Disease outbreak reports', 'disease outbreak feed', () => outbreakBlock(sources.feeds.outbreaks, trip, cap)), 'outbreak feeds', sources.feeds.outbreaks),
    withOrigin(isolated('CDC travel health notices', 'government travel advisories', () => cdcBlock(sources, trip, cap)), 'CDC', sources.feeds.advisories),
  ];
}

// ---------------------------------------------------------------------------
// Getting in and out
// ---------------------------------------------------------------------------

const AIRPORT_SEVERITY: Record<string, string> = {
  FLIGHT_DELAY_SEVERITY_NORMAL: 'normal',
  FLIGHT_DELAY_SEVERITY_MINOR: 'minor',
  FLIGHT_DELAY_SEVERITY_MODERATE: 'moderate',
  FLIGHT_DELAY_SEVERITY_MAJOR: 'major',
  FLIGHT_DELAY_SEVERITY_SEVERE: 'severe',
  FLIGHT_DELAY_SEVERITY_UNKNOWN: 'unknown',
};

const AIRPORT_SOURCE: Record<string, string> = {
  FLIGHT_DELAY_SOURCE_FAA: 'FAA',
  FLIGHT_DELAY_SOURCE_AVIATIONSTACK: 'AviationStack',
  FLIGHT_DELAY_SOURCE_NOTAM: 'Airport NOTAM',
};

function airportBlock(source: SourceSnapshot, trip: TripCountry, cap: number): Block {
  const topic = 'Monitored airports';
  const name = 'airport status feed';
  if (source.status !== 'ok') return unavailableBlock(topic, name, source.reason ?? 'the airport status feed could not be read');
  const alerts = list(source.value, 'alerts');
  if (!alerts) return unavailableBlock(topic, name, 'the airport status feed did not have the expected shape');
  let disrupted = 0;
  const matched = alerts.flatMap((raw): Dated[] => {
    const alert = record(raw);
    if (!alert || !sameCountry(alert.country, trip.countryCode)) return [];
    const ms = toMs(alert.updatedAt);
    const severity = AIRPORT_SEVERITY[str(alert.severity)] ?? 'unknown';
    if (severity !== 'normal' && severity !== 'unknown') disrupted += 1;
    const marker = inListedCity(alert.city, trip.cities) ? ' Serves a listed city.' : '';
    const iata = cleanText(alert.iata, 4);
    return [{
      // Disrupted airports first, then by recency.
      ms: (severity !== 'normal' && severity !== 'unknown' ? 1e15 : 0) + (ms ?? 0),
      finding: {
        text: `${cleanText(alert.name, 80)}${iata ? ` (${iata})` : ''}: ${cleanText(alert.reason, 120) || 'no status text'}. Severity ${severity}.${marker}`,
        source: AIRPORT_SOURCE[str(alert.source)] ?? 'World Monitor airport status',
        observed: isoDate(ms),
        url: null,
      },
    }];
  });
  if (matched.length === 0) {
    return notCoveredBlock(topic, `World Monitor monitors no airport in ${trip.countryName}.`);
  }
  const block = listBlock(topic, matched, cap, {
    reported: `${plural(matched.length, 'monitored airport', 'monitored airports')} in ${trip.countryName}, ${disrupted} reporting delays, closures or restrictions (${updatedPhrase(source)}).`,
    none: '',
  });
  return block;
}

function airspaceBlock(trip: TripCountry): Block {
  return notCoveredBlock(
    'Airspace',
    `this draft reads airspace restrictions for ${trip.countryName} only from the airport NOTAM rows above. National airspace closures and overflight warnings are not assessed.`,
  );
}

function accessBlocks(sources: TravelRiskSources, trip: TripCountry, cap: number): Block[] {
  return [
    withOrigin(isolated('Monitored airports', 'airport status feed', () => airportBlock(sources.feeds.aviation, trip, cap)), 'airport status feed', sources.feeds.aviation),
    airspaceBlock(trip),
  ];
}

// ---------------------------------------------------------------------------
// Communications and infrastructure
// ---------------------------------------------------------------------------

function outageBlock(source: SourceSnapshot, trip: TripCountry, cap: number): Block {
  const topic = 'Internet outages';
  const name = 'Cloudflare Radar';
  if (source.status !== 'ok') return unavailableBlock(topic, name, source.reason ?? 'the outage feed could not be read');
  const outages = list(source.value, 'outages');
  if (!outages) return unavailableBlock(topic, name, 'the outage feed did not have the expected shape');
  const matched = outages.flatMap((raw): Dated[] => {
    const outage = record(raw);
    if (!outage || !sameCountry(outage.country, trip.countryCode)) return [];
    const ms = toMs(outage.detectedAt);
    const ended = toMs(outage.endedAt);
    const cause = cleanText(str(outage.cause).replace(/_/g, ' '), 60);
    return [{
      ms,
      finding: {
        text: `"${cleanText(outage.title)}".${cause ? ` Cause: ${cause}.` : ''} ${ended === null ? 'No end time reported.' : `Ended ${isoDate(ended)}.`}`,
        source: 'Cloudflare Radar',
        observed: isoDate(ms),
        url: httpsUrl(outage.link),
      },
    }];
  });
  const updated = updatedPhrase(source);
  return listBlock(topic, matched, cap, {
    reported: `${plural(matched.length, 'internet outage annotation', 'internet outage annotations')} for ${trip.countryName} in the past 28 days (Cloudflare Radar, ${updated}).`,
    none: `No internet outage annotation for ${trip.countryName} in the past 28 days (Cloudflare Radar, ${updated}). The feed keeps at most 50 annotations worldwide.`,
  });
}

function communicationsBlocks(sources: TravelRiskSources, trip: TripCountry, cap: number): Block[] {
  return [
    withOrigin(isolated('Internet outages', 'Cloudflare Radar', () => outageBlock(sources.feeds.outages, trip, cap)), 'Cloudflare Radar', sources.feeds.outages),
  ];
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

function clause(block: Block): string {
  if (block.status === 'unavailable') return `${block.topic}: unavailable`;
  if (block.status === 'not_covered') return `${block.topic}: not covered`;
  const origin = `${block.source}, ${block.asOf ?? 'update time unknown'}`;
  if (block.count !== null) return `${block.topic}: ${block.count} (${origin})`;
  const first = block.findings[0];
  return first ? `${block.topic}: ${first.text.replace(/\.$/, '')} (${origin})` : `${block.topic}: reported (${origin})`;
}

function summaryParagraph(trip: TripCountry, rating: CountryRating, blocks: Record<string, Block[]>, window: Window): string {
  const part = (label: string, entries: Block[]) => `${label}: ${entries.map(clause).join('; ')}.`;
  return [
    `Rating: ${rating.statement}`,
    part(`Security, ${window.from} to ${window.to}`, blocks.security!),
    part('Natural hazards', blocks.hazards!),
    part('Health', blocks.health!),
    part('Getting in and out', blocks.access!),
    part('Communications', blocks.communications!),
    `Sections 2 to 7 list the findings behind each count for ${trip.countryName}.`,
  ].join(' ');
}

function overallRating(countries: Array<{ trip: TripCountry; rating: CountryRating }>): CountryRating {
  const rated = countries.filter((entry) => entry.rating.level !== null);
  const unrated = countries.filter((entry) => entry.rating.level === null).map((entry) => entry.trip.countryName);
  const unratedText = unrated.length ? ` Unrated: ${unrated.join(', ')}.` : '';
  if (rated.length === 0) {
    return { level: null, statement: 'Unrated: no country on the itinerary has a US State Dept or Australia DFAT Smartraveller level on record.' };
  }
  const level = Math.max(...rated.map((entry) => entry.rating.level!));
  const at = rated.filter((entry) => entry.rating.level === level).map((entry) => entry.trip.countryName).join(', ');
  return { level, statement: `Level ${level} of 4, the strictest country rating on the itinerary (${at}).${unratedText}` };
}

// ---------------------------------------------------------------------------
// Sources table and method
// ---------------------------------------------------------------------------

/** The list each feed's blocks read; a payload without it is unusable, whatever its age. */
const FEED_LIST_FIELD: Record<string, string> = {
  ucdp: 'events', unrest: 'events', earthquakes: 'earthquakes', natural: 'events',
  weather: 'alerts', outbreaks: 'outbreaks', aviation: 'alerts', outages: 'outages',
};

/** Why the payload cannot be used, or null. Keeps the sources table in step with the blocks that read it. */
function payloadProblem(id: string, source: SourceSnapshot): string | null {
  if (source.status !== 'ok') return null;
  if (id === 'advisories') {
    const advice = readAdvice(source);
    return advice.ok ? null : advice.reason;
  }
  const field = FEED_LIST_FIELD[id];
  return field && !list(source.value, field) ? 'the snapshot did not have the expected shape' : null;
}

function sourceRow(name: string, source: SourceSnapshot, problem: string | null = null): SourceRow {
  if (source.status !== 'ok') return { source: name, updatedAt: source.updatedAt, status: 'unavailable', note: source.reason };
  if (problem) return { source: name, updatedAt: source.updatedAt, status: 'unavailable', note: problem };
  return { source: name, updatedAt: source.updatedAt, status: source.stale ? 'out_of_date' : 'current', note: null };
}

function sourceRows(sources: TravelRiskSources, trip: TripInput): SourceRow[] {
  const rows = TRAVEL_RISK_FEEDS.map((feed) => sourceRow(feed.name, sources.feeds[feed.id], payloadProblem(feed.id, sources.feeds[feed.id])));
  rows.push(sourceRow(HOTSPOT_SOURCE_NAME, sources.hotspots,
    sources.hotspots.status === 'ok' && !list(record(sources.hotspots.value)?.data, 'hotspots') ? 'the hotspot model returned no hotspot list' : null));
  const scored = trip.countries.filter((country) => CII_SCORED_CODES.has(country.countryCode));
  if (scored.length === 0) {
    rows.push({ source: CII_SOURCE_NAME, updatedAt: null, status: 'not_used', note: 'no listed country is scored by the index' });
  } else {
    for (const country of scored) {
      const source = sources.cii[country.countryCode];
      const row = source
        ? sourceRow(`${CII_SOURCE_NAME}, ${country.countryName}`, source)
        : { source: `${CII_SOURCE_NAME}, ${country.countryName}`, updatedAt: null, status: 'unavailable' as const, note: 'not read' };
      rows.push(row);
    }
  }
  rows.push({
    source: `${SEASONAL_SOURCE}, seasonal calendar`,
    updatedAt: `${SEASONAL_CALENDAR.generatedAt}T00:00:00.000Z`,
    status: 'current',
    note: 'recorded history built on this date, not a forecast',
  });
  return rows;
}

const METHOD_NOTES: readonly string[] = [
  'The rating is the higher of the US State Dept and Australia DFAT Smartraveller levels, which share a four-level scale. The UK FCDO and CDC use their own scales and are reported beside the rating, not converted onto it. Other sections give context and do not change the rating.',
  `Security counts cover the ${SECURITY_WINDOW_DAYS} days up to the retrieval time. Other sections report what each feed holds at retrieval, with the window each feed covers.`,
  'Earthquakes, natural events and hotspots are matched by the country\'s bounding box, which can include parts of neighbouring countries and sea.',
  'Conflict, unrest, airport and outage records are matched by the country name each feed gives. Listed cities are shown for the analyst and mark matching unrest signals and airports; they do not narrow the feeds.',
  'Quoted titles are feed text as published, shortened to one line, with straight double quotes shown as single quotes and direction and invisible characters removed. Unrest items are unverified media signals.',
  'An unavailable source is not a quiet one: its section says why it could not be read.',
];

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

export function assembleTravelRiskDocument(
  input: TripInput,
  sources: TravelRiskSources,
  nowMs: number,
  findingsPerBlock = DEFAULT_FINDINGS_PER_BLOCK,
): TravelRiskDocument {
  const window = securityWindow(nowMs);
  const cap = findingsPerBlock;
  const perCountry = input.countries.map((trip) => {
    const blocks = {
      advice: adviceBlocks(sources, trip, cap),
      security: securityBlocks(sources, trip, window, cap),
      hazards: hazardBlocks(sources, trip, input, cap, nowMs),
      health: healthBlocks(sources, trip, cap),
      access: accessBlocks(sources, trip, cap),
      communications: communicationsBlocks(sources, trip, cap),
    };
    const rating = rateCountry(sources, trip);
    return { trip, blocks, rating };
  });
  const section = (key: keyof (typeof perCountry)[number]['blocks']): CountryBlocks[] => perCountry.map(({ trip, blocks }) => ({
    countryCode: trip.countryCode,
    countryName: trip.countryName,
    blocks: blocks[key],
  }));
  return {
    title: 'Travel risk assessment draft',
    taskLabel: input.taskLabel,
    retrievedAt: new Date(nowMs).toISOString(),
    trip: { dateFrom: input.dateFrom, dateTo: input.dateTo, countries: input.countries },
    summary: {
      overallRating: overallRating(perCountry),
      countries: perCountry.map(({ trip, rating, blocks }) => ({
        countryCode: trip.countryCode,
        countryName: trip.countryName,
        rating,
        paragraph: summaryParagraph(trip, rating, blocks, window),
      })),
    },
    advice: section('advice'),
    security: section('security'),
    hazards: section('hazards'),
    health: section('health'),
    access: section('access'),
    communications: section('communications'),
    notCovered: ANALYST_SECTIONS.map((heading) => ({ heading, status: 'analyst_to_complete' as const })),
    sources: sourceRows(sources, input),
    method: [...METHOD_NOTES],
  };
}

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------

function renderFinding(finding: Finding): string {
  const date = finding.observed ?? 'date not given by the source';
  return `- ${finding.text} Source: ${finding.source}, ${date}.${finding.url ? ` <${finding.url}>` : ''}`;
}

function renderBlock(block: Block): string[] {
  const lines = [`**${block.topic}.** ${block.statement}`];
  if (block.findings.length) {
    lines.push('', ...block.findings.map(renderFinding));
  }
  if (block.omitted > 0) lines.push(`- ${block.omitted} more not listed.`);
  lines.push('');
  return lines;
}

function renderCountrySections(entries: CountryBlocks[]): string[] {
  return entries.flatMap((entry) => [
    `### ${entry.countryName} (${entry.countryCode})`,
    '',
    ...entry.blocks.flatMap(renderBlock),
  ]);
}

function renderTrip(trip: TripCountry, index: number): string {
  const parts = [`${index + 1}. ${trip.countryName} (${trip.countryCode})`];
  if (trip.cities.length) parts.push(`Cities: ${trip.cities.map((city) => cleanText(city, 80)).join(', ')}`);
  if (trip.arrive) parts.push(`arrive ${trip.arrive}`);
  if (trip.depart) parts.push(`depart ${trip.depart}`);
  return `${parts.join('. ')}.`;
}

const SOURCE_STATUS_TEXT: Record<SourceRow['status'], string> = {
  current: 'current',
  out_of_date: 'out of date',
  unavailable: 'unavailable',
  not_used: 'not used',
};

export function renderTravelRiskMarkdown(doc: TravelRiskDocument): string {
  const lines: string[] = [`# ${doc.title}`, ''];
  if (doc.taskLabel) lines.push(`Task: ${cleanText(doc.taskLabel, 120)}`, '');
  lines.push(
    `Retrieved by World Monitor at ${formatTimestamp(doc.retrievedAt)}. Each finding names its source and the date that source gives for it. This draft reports what the feeds hold; it gives no advice and needs analyst review.`,
    '',
    'Itinerary, in travel order:',
    '',
    ...doc.trip.countries.map(renderTrip),
    '',
  );
  if (doc.trip.dateFrom || doc.trip.dateTo) {
    lines.push(`Trip window: ${doc.trip.dateFrom ?? 'open start'} to ${doc.trip.dateTo ?? 'open end'}.`, '');
  }

  lines.push('## 1. Summary', '', `**Overall rating.** ${doc.summary.overallRating.statement}`, '');
  for (const country of doc.summary.countries) {
    lines.push(`### ${country.countryName} (${country.countryCode})`, '', country.paragraph, '');
  }

  const sections: Array<[string, CountryBlocks[]]> = [
    ['## 2. Government travel advice', doc.advice],
    ['## 3. Security', doc.security],
    ['## 4. Natural hazards', doc.hazards],
    ['## 5. Health', doc.health],
    ['## 6. Getting in and out', doc.access],
    ['## 7. Communications and infrastructure', doc.communications],
  ];
  for (const [heading, entries] of sections) {
    lines.push(heading, '', ...renderCountrySections(entries));
  }

  lines.push('## 8. What this draft does not cover', '', 'No feed behind this draft covers these topics. Each needs an analyst.', '');
  for (const item of doc.notCovered) lines.push(`### ${item.heading}`, '', 'Analyst to complete.', '');

  lines.push(
    '## 9. Sources and capture time',
    '',
    `Retrieved: ${formatTimestamp(doc.retrievedAt)}. "Data updated" is when each producer last fetched its source, which can be earlier than retrieval.`,
    '',
    '| Source | Data updated | Status |',
    '| --- | --- | --- |',
    ...doc.sources.map((row) => `| ${cleanText(row.source, 200)} | ${row.updatedAt ? formatTimestamp(row.updatedAt) : 'unknown'} | ${SOURCE_STATUS_TEXT[row.status]}${row.note ? `: ${cleanText(row.note, 160)}` : ''} |`),
    '',
    'Method:',
    '',
    ...doc.method.map((note) => `- ${note}`),
    '',
  );
  return lines.join('\n');
}

export function buildTravelRiskResult(
  input: TripInput,
  sources: TravelRiskSources,
  nowMs: number,
  findingsPerBlock = DEFAULT_FINDINGS_PER_BLOCK,
): TravelRiskResult {
  const document = assembleTravelRiskDocument(input, sources, nowMs, findingsPerBlock);
  return { markdown: renderTravelRiskMarkdown(document), document };
}
