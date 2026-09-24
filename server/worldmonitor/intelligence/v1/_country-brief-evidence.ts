// Public-safe World Monitor data points the English country intel brief may
// cite (plan 2026-09-23-001, KTD2/KTD3/KTD5). Each item carries a `factText`
// sentence stating exactly the values a claim citing it may use: the claim
// validator grounds a claim against the fact texts it cites and nothing else,
// so every fact text names the country and the capitalised labels the prompt
// tells the model to use, and formats its numbers one way per kind.
//
// Only data a public page already shows goes in. CII components, the CII 24h
// delta and chokepoint exposure scores are not published, so they never appear.

import { getCachedJson } from '../../../_shared/redis';
import { CII_RISK_SCORE_CACHE_KEYS } from '../../../_shared/cache-keys';
import { displayNameForIso2 } from '../../../_shared/country-normalize';
import { CHOKEPOINT_REGISTRY } from '../../../_shared/chokepoint-registry';
import { sanitizeForPromptLine } from '../../../_shared/llm-sanitize.js';
import { instabilityBand } from '../../../../shared/cii-band.js';
import { CHOKEPOINT_COUNTRY_CODES } from '../../../../shared/chokepoint-countries.js';
import { countryMentionTerms, mentionsCountry } from '../../../../shared/country-mention.js';
import { TIER1_COUNTRIES } from './_shared';
import type { ResolvedEnergyImportDependency } from './_energy-import-dependency';

export type CountryBriefEvidenceKind =
  | 'cii'
  | 'advisory'
  | 'sanctions'
  | 'resilience'
  | 'resilience-dimension'
  | 'energy'
  | 'chokepoint'
  | 'market'
  | 'forecast';

export interface CountryBriefEvidenceItem {
  id: string;
  kind: CountryBriefEvidenceKind;
  label: string;
  value: string;
  factText: string;
  asOf: string;
  url?: string;
}

export interface CountryBriefEvidenceOptions {
  energyImportDependency: ResolvedEnergyImportDependency;
  nowMs?: number;
}

const ADVISORIES_KEY = 'intelligence:advisories:v1';
// Mirrors RESILIENCE_SCORE_CACHE_PREFIX in resilience/v1/_shared.ts. Importing
// it would pull the resilience scoring engine into the intelligence edge
// bundle; tests/resilience-cache-keys-health-sync.test.mts fails this file on
// the next prefix bump instead.
const RESILIENCE_SCORE_CACHE_PREFIX = 'resilience:score:v28:';
const SANCTIONS_COUNTS_KEY = 'sanctions:country-counts:v1';
// The counts map carries no timestamp of its own; the seeder writes this meta
// record beside it in the same publish.
const SANCTIONS_COUNTS_META_KEY = 'seed-meta:sanctions:country-counts';
const MARKETS_COUNTRY_INDEX_KEY = 'prediction:markets-country-index:v1';
// The ~41 KB dashboard projection, not the 188 KB canonical key with dossiers.
const FORECASTS_KEY = 'forecast:predictions-bootstrap:v1';

const SITE_ORIGIN = 'https://www.worldmonitor.app';
export const FORECAST_SCORECARD_URL = `${SITE_ORIGIN}/accuracy/`;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;

// Oldest as-of each kind may carry, roughly twice its writer's cadence: past
// that the writer has missed runs and the value is no longer "current". The
// CII stale key is rewritten on every score compute (hourly cron, 1h TTL);
// advisories run hourly; sanctions every 6h but a full OFAC+SEMA pull can slip
// a cycle; markets every 30 min; forecasts hourly with a 6h TTL; resilience
// statics refresh weekly, and dataVersion is a date, so allow two weeks.
export const EVIDENCE_MAX_AGE_MS = Object.freeze({
  cii: 2 * HOUR_MS,
  advisory: 6 * HOUR_MS,
  sanctions: 36 * HOUR_MS,
  resilience: 14 * DAY_MS,
  market: 6 * HOUR_MS,
  forecast: 48 * HOUR_MS,
});

const MAX_WEAKEST_DIMENSIONS = 3;
const MAX_MARKETS = 5;
const MAX_FORECASTS = 3;
const MAX_TITLE_LENGTH = 160;

// Public labels from the country page (formatAdvisory in
// scripts/crawlable-live-tools.mjs; parity-tested). An unknown token is
// dropped rather than humanized, so the brief never invents a level name.
export const COUNTRY_BRIEF_ADVISORY_LABELS: Readonly<Record<string, string>> = Object.freeze({
  'do-not-travel': 'Do Not Travel',
  reconsider: 'Reconsider Travel',
  caution: 'Exercise Increased Caution',
  normal: 'Exercise Normal Precautions',
});

// Dimension display names from the resilience pages (DIMENSION_LABELS in
// scripts/build-crawlable-corpus.mjs; parity-tested against its source).
export const RESILIENCE_DIMENSION_LABELS: Readonly<Record<string, string>> = Object.freeze({
  macroFiscal: 'Macro-fiscal position',
  currencyExternal: 'Currency and external balance',
  tradePolicy: 'Trade policy resilience',
  financialSystemExposure: 'Financial-system exposure',
  cyberDigital: 'Cyber and digital capacity',
  logisticsSupply: 'Logistics and supply chains',
  infrastructure: 'Core infrastructure',
  energy: 'Energy system resilience',
  governanceInstitutional: 'Governance and institutions',
  socialCohesion: 'Social cohesion',
  borderSecurity: 'Border security',
  informationCognitive: 'Information environment',
  education: 'Education capacity',
  healthPublicService: 'Health and public services',
  foodWater: 'Food and water security',
  fiscalSpace: 'Fiscal space',
  reserveAdequacy: 'Reserve adequacy',
  externalDebtCoverage: 'External-debt coverage',
  importConcentration: 'Import concentration',
  stateContinuity: 'State continuity',
  fuelStockDays: 'Fuel-stock buffer',
  liquidReserveAdequacy: 'Liquid-reserve adequacy',
  sovereignFiscalBuffer: 'Sovereign fiscal buffer',
});

// The corpus hides these (RETIRED_DIMENSION_IDS), so the brief must too.
const RETIRED_DIMENSION_IDS = new Set(['fuelStockDays', 'reserveAdequacy']);

const RESILIENCE_LEVELS = new Set(['high', 'medium', 'low']);

const MARKET_VENUES: Readonly<Record<string, string>> = Object.freeze({
  polymarket: 'Polymarket',
  kalshi: 'Kalshi',
});

type EvidenceDraft = Omit<CountryBriefEvidenceItem, 'id'>;
type Json = Record<string, unknown>;

const SCORE_FORMAT = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });
const COUNT_FORMAT = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const DATE_FORMAT = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  timeZone: 'UTC',
});

// One format per kind (KTD3): scores "28.4 of 100" (the page's one-decimal
// format), percentages whole ("62%"), counts grouped ("1,234").
function formatScore(value: number): string {
  return `${SCORE_FORMAT.format(value)} of 100`;
}

function formatPercent(value: number): string {
  return `${Math.round(value) || 0}%`;
}

function formatDate(ms: number): string {
  return DATE_FORMAT.format(new Date(ms));
}

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function timestampMs(value: unknown): number | null {
  const numeric = finite(value);
  if (numeric !== null) return numeric > 0 ? numeric : null;
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isFresh(asOfMs: number | null, maxAgeMs: number, nowMs: number): asOfMs is number {
  return asOfMs !== null && asOfMs <= nowMs + MAX_FUTURE_SKEW_MS && nowMs - asOfMs <= maxAgeMs;
}

function httpsUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const parsed = new URL(value.trim());
    return parsed.protocol === 'https:' ? parsed.toString() : undefined;
  } catch {
    return undefined;
  }
}

// Third-party titles enter a prompt, so they are sanitized, forced onto one
// line, and clipped. Double quotes become single so the fact text's own
// quoting stays unambiguous.
function thirdPartyTitle(value: unknown): string {
  const line = sanitizeForPromptLine(value).replace(/"/g, "'");
  return line.length > MAX_TITLE_LENGTH ? `${line.slice(0, MAX_TITLE_LENGTH - 1).trimEnd()}…` : line;
}

// Same slug rule as the corpus page generator (slugify in
// scripts/build-crawlable-corpus.mjs; parity-tested).
export function chokepointTrackerSlug(displayName: string): string {
  return displayName
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .toLowerCase();
}

// Matches the handler's `countryName`, so the proper-noun check sees the same
// spelling in the fact texts that the prompt uses.
function countryDisplayName(code: string): string {
  return TIER1_COUNTRIES[code] || displayNameForIso2(code) || code;
}

function ciiEvidence(raw: unknown, code: string, name: string, nowMs: number): EvidenceDraft[] {
  if (!isObject(raw) || !Array.isArray(raw.ciiScores)) return [];
  const score = raw.ciiScores.find((entry): entry is Json => isObject(entry) && entry.region === code);
  const combined = finite(score?.combinedScore);
  const band = instabilityBand(combined);
  const computedAt = timestampMs(score?.computedAt);
  if (combined === null || band === null || !isFresh(computedAt, EVIDENCE_MAX_AGE_MS.cii, nowMs)) return [];
  const value = formatScore(combined);
  return [{
    kind: 'cii',
    label: 'Country Instability Index',
    value: `${value} (${band})`,
    factText: `${name} has a Country Instability Index score of ${value}, in the ${band} band, as of ${formatDate(computedAt)}.`,
    asOf: new Date(computedAt).toISOString(),
  }];
}

function advisoryEvidence(raw: unknown, code: string, name: string, nowMs: number): EvidenceDraft[] {
  if (!isObject(raw) || !isObject(raw.byCountry)) return [];
  const token = String(raw.byCountry[code] ?? '').trim().toLowerCase();
  const label = COUNTRY_BRIEF_ADVISORY_LABELS[token];
  const fetchedAt = timestampMs(raw.fetchedAt);
  if (!label || !isFresh(fetchedAt, EVIDENCE_MAX_AGE_MS.advisory, nowMs)) return [];
  return [{
    kind: 'advisory',
    label: 'Travel advisory',
    value: label,
    // byCountry keeps the most severe level across the government feeds.
    factText: `The most severe government travel advisory World Monitor tracks for ${name} is ${label}, as of ${formatDate(fetchedAt)}.`,
    asOf: new Date(fetchedAt).toISOString(),
  }];
}

function sanctionsEvidence(raw: unknown, meta: unknown, code: string, name: string, nowMs: number): EvidenceDraft[] {
  if (!isObject(raw) || !isObject(meta)) return [];
  const count = finite(raw[code]);
  const fetchedAt = timestampMs(meta.fetchedAt);
  // Zero is left out: absence from the map is not the same claim as a
  // verified "no designations", and the brief has nothing to say about it.
  if (count === null || !Number.isInteger(count) || count <= 0) return [];
  if (!isFresh(fetchedAt, EVIDENCE_MAX_AGE_MS.sanctions, nowMs)) return [];
  const value = COUNT_FORMAT.format(count);
  return [{
    kind: 'sanctions',
    // The count merges US OFAC (SDN + consolidated) and Canada SEMA entries
    // (scripts/seed-sanctions-pressure.mjs), so the label names both.
    label: 'US OFAC and Canada SEMA designations',
    value,
    factText: `${name} is linked to ${value} US OFAC and Canada SEMA sanctions designations, as of ${formatDate(fetchedAt)}.`,
    asOf: new Date(fetchedAt).toISOString(),
  }];
}

// Mirrors the corpus's hasObservedValue: an empty imputationClass is the
// allow-list for "observed", so a new withheld class fails closed.
function isObservedDimension(dimension: Json): boolean {
  const coverage = finite(dimension.coverage);
  return typeof dimension.id === 'string'
    && !RETIRED_DIMENSION_IDS.has(dimension.id)
    && finite(dimension.score) !== null
    && coverage !== null
    && coverage > 0
    && String(dimension.imputationClass ?? '') === '';
}

function resilienceEvidence(raw: unknown, name: string, nowMs: number): EvidenceDraft[] {
  if (!isObject(raw)) return [];
  const dataVersion = typeof raw.dataVersion === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.dataVersion)
    ? Date.parse(`${raw.dataVersion}T00:00:00Z`)
    : null;
  if (!isFresh(dataVersion, EVIDENCE_MAX_AGE_MS.resilience, nowMs)) return [];
  const asOf = new Date(dataVersion).toISOString();
  const date = formatDate(dataVersion);
  const items: EvidenceDraft[] = [];

  const overall = finite(raw.overallScore);
  const level = typeof raw.level === 'string' ? raw.level : '';
  // An unpublished headline (headlineEligible false) is shown as
  // "unpublished" on the page, so the brief cannot cite its score.
  if (overall !== null && overall >= 0 && overall <= 100 && RESILIENCE_LEVELS.has(level) && raw.headlineEligible !== false) {
    const value = formatScore(overall);
    items.push({
      kind: 'resilience',
      label: 'Country Resilience Index',
      value: `${value} (${level})`,
      factText: `${name} has a Country Resilience Index score of ${value}, a ${level} resilience level, as of ${date}.`,
      asOf,
    });
  }

  const dimensions = (Array.isArray(raw.domains) ? raw.domains : [])
    .flatMap((domain) => (isObject(domain) && Array.isArray(domain.dimensions) ? domain.dimensions : []))
    .filter((dimension): dimension is Json => isObject(dimension) && isObservedDimension(dimension))
    .filter((dimension) => RESILIENCE_DIMENSION_LABELS[dimension.id as string] !== undefined)
    .sort((left, right) => (left.score as number) - (right.score as number) || String(left.id).localeCompare(String(right.id)))
    .slice(0, MAX_WEAKEST_DIMENSIONS);
  for (const dimension of dimensions) {
    const label = RESILIENCE_DIMENSION_LABELS[dimension.id as string]!;
    const value = formatScore(dimension.score as number);
    items.push({
      kind: 'resilience-dimension',
      label,
      value,
      factText: `${label} is one of ${name}'s weakest observed Country Resilience Index dimensions, at ${value} as of ${date}.`,
      asOf,
    });
  }
  return items;
}

// Reuses the handler's own resolveEnergyImportDependency read, so the brief
// and its cache key agree on the energy year.
function energyEvidence(energy: ResolvedEnergyImportDependency, name: string): EvidenceDraft[] {
  if (!energy?.available || finite(energy.value) === null || !Number.isInteger(energy.year) || energy.year <= 0) return [];
  const value = formatPercent(energy.value);
  const provenance = [energy.source?.trim(), String(energy.year)].filter(Boolean).join(', ');
  const exporterClause = Math.round(energy.value) < 0
    ? `; a negative value means ${name} is a net energy exporter`
    : '';
  return [{
    kind: 'energy',
    label: 'Net energy import dependency',
    value,
    factText: `${name} has a net energy import dependency of ${value} (${provenance})${exporterClause}.`,
    // An annual observation: date it to the end of its reference year.
    asOf: new Date(Date.UTC(energy.year, 11, 31)).toISOString(),
  }];
}

// Names and tracker links only; exposure scores are Pro data.
function chokepointEvidence(code: string, name: string, nowMs: number): EvidenceDraft[] {
  const items: EvidenceDraft[] = [];
  for (const [id, codes] of Object.entries(CHOKEPOINT_COUNTRY_CODES)) {
    if (!codes.includes(code)) continue;
    const entry = CHOKEPOINT_REGISTRY.find((candidate) => candidate.id === id);
    if (!entry) continue;
    items.push({
      kind: 'chokepoint',
      label: 'Chokepoint tracker',
      value: entry.displayName,
      factText: `${entry.displayName} is a shipping chokepoint World Monitor tracks for ${name}.`,
      // An editorial relation, not a measurement: dated to when it was read.
      asOf: new Date(nowMs).toISOString(),
      url: `${SITE_ORIGIN}/chokepoints/${chokepointTrackerSlug(entry.displayName)}/`,
    });
  }
  return items;
}

function marketEvidence(raw: unknown, code: string, name: string, nowMs: number): EvidenceDraft[] {
  if (!isObject(raw) || !isObject(raw.countries)) return [];
  const fetchedAt = timestampMs(raw.fetchedAt);
  const markets = raw.countries[code];
  if (!Array.isArray(markets) || !isFresh(fetchedAt, EVIDENCE_MAX_AGE_MS.market, nowMs)) return [];
  const items: EvidenceDraft[] = [];
  for (const market of markets) {
    if (items.length >= MAX_MARKETS) break;
    if (!isObject(market)) continue;
    const venue = MARKET_VENUES[String(market.source ?? '')];
    const price = finite(market.yesPrice);
    const closesAt = timestampMs(market.endDate);
    const title = thirdPartyTitle(market.title);
    // A market without a close date cannot be stated as a dated forecast.
    if (!venue || price === null || price < 0 || price > 100 || closesAt === null || closesAt < nowMs || !title) continue;
    const value = formatPercent(price);
    const url = httpsUrl(market.url);
    items.push({
      kind: 'market',
      label: `${venue} prediction market`,
      value,
      factText: `A ${venue} market related to ${name}, "${title}", priced Yes at ${value} on ${formatDate(fetchedAt)}; it closes ${formatDate(closesAt)}.`,
      asOf: new Date(fetchedAt).toISOString(),
      ...(url ? { url } : {}),
    });
  }
  return items;
}

function forecastEvidence(raw: unknown, code: string, name: string, nowMs: number): EvidenceDraft[] {
  if (!isObject(raw) || !Array.isArray(raw.predictions)) return [];
  const generatedAt = timestampMs(raw.generatedAt);
  if (!isFresh(generatedAt, EVIDENCE_MAX_AGE_MS.forecast, nowMs)) return [];
  // Title only: the free-text `region` tags the US-Iran ceasefire "Americas".
  const terms = countryMentionTerms(code);
  const items: EvidenceDraft[] = [];
  for (const forecast of raw.predictions) {
    if (items.length >= MAX_FORECASTS) break;
    if (!isObject(forecast) || typeof forecast.title !== 'string') continue;
    if (!mentionsCountry(forecast.title, terms)) continue;
    const probability = finite(forecast.probability);
    const deadline = isObject(forecast.resolution) ? finite(forecast.resolution.deadline) : null;
    const title = thirdPartyTitle(forecast.title);
    if (probability === null || probability < 0 || probability > 1 || deadline === null || deadline < nowMs || !title) continue;
    const value = formatPercent(probability * 100);
    items.push({
      kind: 'forecast',
      label: 'World Monitor forecast',
      value,
      factText: `A World Monitor forecast related to ${name}, "${title}", gives a ${value} probability by ${formatDate(deadline)}, as of ${formatDate(generatedAt)}.`,
      asOf: new Date(generatedAt).toISOString(),
      url: FORECAST_SCORECARD_URL,
    });
  }
  return items;
}

async function readKey(key: string): Promise<unknown> {
  return getCachedJson(key, true);
}

/**
 * Dated, public-safe evidence for one country, in a stable kind order with
 * ids E1..En. Every source fails soft: a missing, malformed, stale or
 * unreadable key drops that source's items, never the pack.
 */
export async function buildCountryBriefEvidence(
  countryCode: string,
  opts: CountryBriefEvidenceOptions,
): Promise<CountryBriefEvidenceItem[]> {
  const code = String(countryCode ?? '').trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) return [];
  const nowMs = opts.nowMs ?? Date.now();
  const name = countryDisplayName(code);

  const reads = await Promise.allSettled([
    readKey(CII_RISK_SCORE_CACHE_KEYS.stale),
    readKey(ADVISORIES_KEY),
    readKey(SANCTIONS_COUNTS_KEY),
    readKey(SANCTIONS_COUNTS_META_KEY),
    readKey(`${RESILIENCE_SCORE_CACHE_PREFIX}${code}`),
    readKey(MARKETS_COUNTRY_INDEX_KEY),
    readKey(FORECASTS_KEY),
  ]);
  const [cii, advisories, sanctions, sanctionsMeta, resilience, markets, forecasts] = reads
    .map((read) => (read.status === 'fulfilled' ? read.value : null));

  // Each builder is isolated too: one source's unexpected shape must not
  // take the others down with a throw.
  const sections: Array<() => EvidenceDraft[]> = [
    () => ciiEvidence(cii, code, name, nowMs),
    () => advisoryEvidence(advisories, code, name, nowMs),
    () => sanctionsEvidence(sanctions, sanctionsMeta, code, name, nowMs),
    () => resilienceEvidence(resilience, name, nowMs),
    () => energyEvidence(opts.energyImportDependency, name),
    () => chokepointEvidence(code, name, nowMs),
    () => marketEvidence(markets, code, name, nowMs),
    () => forecastEvidence(forecasts, code, name, nowMs),
  ];
  const drafts = sections.flatMap((section) => {
    try {
      return section();
    } catch {
      return [];
    }
  });
  return drafts.map((draft, index) => ({ id: `E${index + 1}`, ...draft }));
}
