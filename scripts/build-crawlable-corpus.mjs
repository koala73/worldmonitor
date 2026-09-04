#!/usr/bin/env node
// Build a deterministic, static HTML corpus for crawlable pages that should
// live outside the SPA catch-all. Inputs are committed repo data only: no
// network calls, no env files, and no live secrets.

import { execFileSync } from 'node:child_process';

import {
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { writeResearchSection } from './build-research-reports.mjs';
import {
  COMPARISONS_CONTENT_VERSION,
  COMPARISON_PAGES,
  writeComparisonPages,
} from './build-comparison-pages.mjs';
import {
  USE_CASE_PAGES,
  USE_CASES_CONTENT_VERSION,
  writeUseCasesSection,
} from './build-use-cases.mjs';
import { buildSourceCatalog, renderSourcesIndex } from './crawlable-sources-page.mjs';
import {
  attachCoverageToCatalog,
  FEED_DECLARATION_FILES,
  loadSourceGeography,
  scanNamedFeedDeclarations,
} from './source-catalog-identity.mjs';
import {
  activeSourceAttributionEntries,
  scanUpstreamHosts,
  sourceAttributionStats,
} from './source-attribution.mjs';
import {
  CHANGELOG_PAGINATION_ROBOTS_CONTENT,
  INDEXABLE_ROBOTS_CONTENT,
} from '../shared/seo-robots.mjs';
import { CII_COUNTRY_CODES } from '../shared/cii-weights.ts';
import { getSovereignStatus } from './shared/rankable-universe.mjs';
// Single source with the browser copy: crawlable-live-tools.mjs is what gets
// written verbatim to public/tools/live-tools.js, and importing it here is
// side-effect-free in Node (its only module-scope statement is a
// `typeof document !== 'undefined'` guard). A mirrored copy could not fail.
import {
  chokepointCoverageMetrics,
  chokepointEvidenceNarrative,
  instabilityBand,
  MAX_FUTURE_SKEW_MS,
  MAX_LIVE_SNAPSHOT_AGE_MS,
  parseCiiMovement,
  withheldTransitCountSentence,
} from './crawlable-live-tools.mjs';
import {
  CHOKEPOINT_CONTENT,
  CHOKEPOINT_PAGE_CONTENT_PATH,
  CHOKEPOINT_REGISTRY_OBSERVED_AT,
  EIA_OIL_TRANSIT_BASELINES,
  TRADE_ROUTES_OBSERVED_AT,
} from './chokepoint-page-content.mjs';
import { EIA_OIL_TRANSIT_BASELINES_PATH } from './chokepoint-eia-baselines.mjs';
import { buildMicrostateCoverageStoryContent } from './microstate-coverage-stories.mjs';
import { buildUnrankedCountryInventory } from './unranked-country-inventory.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DEFAULT_ROOT = resolve(__dirname, '..');
const DEFAULT_OUT_DIR = join(DEFAULT_ROOT, 'public');
const DEFAULT_BASE_URL = 'https://www.worldmonitor.app';
const SCHEMA_ORG_CONTEXT_URL = 'https://schema.org';
const RESILIENCE_SNAPSHOT_DIR = 'docs/snapshots';
const RESILIENCE_SNAPSHOT_RE = /^resilience-ranking-(\d{4}-\d{2}-\d{2})\.json$/;
const LIVE_PULSE_SNAPSHOT_RE = /^crawlable-live-pulse-(\d{4}-\d{2}-\d{2})\.json$/;
// A crisis reference period must be a real calendar month/day, never a sentinel.
const OBSERVATION_PERIOD_RE = /^\d{4}-\d{2}(-\d{2})?$/;
// The committed pulse is published as "Current signal". Nothing re-runs the
// freeze automatically except .github/workflows/crawlable-pulse-refresh.yml, so
// bound the age here: a forgotten or failed refresh must red the build rather
// than silently republish stale numbers under a current-state heading.
//
// Sized to clear the WEEKLY refresh cadence with slack: the cron freezes every
// Monday, so this leaves ~3 days to merge a refresh PR before the build reds.
// It was 45 days against a monthly cron, which let pages headed "Approx.
// 24-hour movement" ship on data up to six weeks old — the freshness
// overstatement in #7530. The ceiling and the cron are one contract: relaxing
// either without the other reopens the gap, and a guard in
// tests/crawlable-corpus.test.mjs asserts they still agree.
export const MAX_LIVE_PULSE_SNAPSHOT_AGE_DAYS = 10;
const COUNTRY_NAMES_PATH = 'shared/country-names.json';
const COUNTRY_REGIONS_PATH = 'shared/iso2-to-region.json';
const MICROSTATE_TERRITORIES_PATH = 'server/worldmonitor/resilience/v1/cohorts/microstate-territories.json';
const CHOKEPOINT_REGISTRY_PATH = 'src/config/chokepoint-registry.ts';
const TRADE_ROUTES_PATH = 'src/config/trade-routes.ts';
const GLOSSARY_DATA_PATH = 'blog-site/src/data/glossary.ts';
const CHANGELOG_PATH = 'CHANGELOG.md';
const LIVE_TOOLS_SCRIPT_PATH = 'scripts/crawlable-live-tools.mjs';
const COUNTRY_BBOXES_PATH = 'shared/country-bboxes.js';
const CRISIS_REGISTRY_PATH = 'shared/crawlable-crises.json';
// Resolvable provenance for crisis scope citations: the registry is a repo
// file, so pages link the versioned blob URL instead of the bare repo path.
const CRISIS_REGISTRY_URL = 'https://github.com/koala73/worldmonitor/blob/main/shared/crawlable-crises.json';
const RESEARCH_REPORTS_INDEX_PATH = 'shared/research-reports/index.mjs';
const SOURCE_ATTRIBUTION_MANIFEST_PATH = 'shared/source-attribution-manifest.json';
const SOURCE_PAGE_RENDERER_PATH = 'scripts/crawlable-sources-page.mjs';
const SOURCE_ORIGIN_PATH = 'scripts/source-origin.mjs';
const SHARED_PAGE_TEMPLATE_PATH = 'scripts/build-crawlable-corpus.mjs';
export const SOURCE_CATALOG_LASTMOD_PATHS = Object.freeze([
  'scripts/source-catalog-identity.mjs',
  'shared/source-geography.json',
  'shared/publisher-families.js',
  ...FEED_DECLARATION_FILES,
]);
export const CHOKEPOINT_PAGE_LASTMOD_PATHS = Object.freeze([
  CHOKEPOINT_REGISTRY_PATH,
  TRADE_ROUTES_PATH,
  CHOKEPOINT_PAGE_CONTENT_PATH,
  EIA_OIL_TRANSIT_BASELINES_PATH,
]);
// Last substantive change to the shared HTML template/content language. Data
// families take the later of this version and their own committed source date,
// so template changes are reflected without pretending every deploy is fresh.
export const CORPUS_GENERATOR_CONTENT_VERSION = '2026-09-01';
export const COUNTRY_PAGE_CONTENT_VERSION = '2026-09-03';
export const CII_COUNTRY_PAGE_CONTENT_VERSION = '2026-09-03';
const COUNTRIES_INDEX_CONTENT_VERSION = '2026-09-03';
const CII_RANKING_PAGE_CONTENT_VERSION = '2026-09-03';
// Public ranking / confidence gates. Keep aligned with
// server/worldmonitor/resilience/v1/_shared.ts and
// docs/methodology/country-resilience-index.mdx.
export const HEADLINE_RANKING_MIN_COVERAGE = 0.65;
export const HEADLINE_RANKING_MIN_POPULATION = 200_000;
export const HEADLINE_RANKING_HIGH_COVERAGE = 0.85;
export const LOW_CONFIDENCE_MIN_COVERAGE = 0.55;
export const LOW_CONFIDENCE_MAX_IMPUTATION = 0.40;
export const RANKING_ELIGIBILITY_CLAUSE = `Ranking requires coverage of at least ${Math.round(HEADLINE_RANKING_MIN_COVERAGE * 100)}%, no low-confidence flag, and either a population of at least ${HEADLINE_RANKING_MIN_POPULATION.toLocaleString('en-US')} or coverage of at least ${Math.round(HEADLINE_RANKING_HIGH_COVERAGE * 100)}%. Low confidence means coverage falls below ${Math.round(LOW_CONFIDENCE_MIN_COVERAGE * 100)}% or imputation share exceeds ${Math.round(LOW_CONFIDENCE_MAX_IMPUTATION * 100)}%.`;
const RETIRED_DIMENSION_IDS = new Set(['fuelStockDays', 'reserveAdequacy']);
const UNRANKED_INVENTORY_LIMIT = 12;
const AVAILABLE_EVIDENCE_LIMIT = 6;
// Coverage a dimension needs before a page will call it a supported reading. The
// inventory labels anything with a usable series "observed", so a dimension
// under this floor is observed and absent from the supported readings at once --
// which reads as a contradiction unless the page states the floor (#7609).
// This floor is published on country pages, so keep it aligned with
// docs/methodology/country-resilience-index.mdx#supported-readings-on-unranked-country-pages.
export const SUPPORTED_READING_MIN_COVERAGE = 0.5;
export const CHOKEPOINT_PAGE_CONTENT_VERSION = '2026-09-04';
const SOURCES_PAGE_CONTENT_VERSION = '2026-08-20';
// Dataset schema versions stamp Dataset JSON-LD shape changes, per family. They
// must NOT fold into every family's sitemap/page lastmod — that made ~90% of main
// sitemap entries share one schema-bump date (#7382). A family's stamp advances
// only when a schema change lands in ITS payload, so one shared constant cannot
// serve them: bumping it for a crisis-only change advertises every untouched
// chokepoint dataset as modified. Country pages are absent by design — their
// dateModified is pinned to the snapshot capturedAt as a truthful freshness
// contract (#7391), so their recrawl signal is COUNTRY_PAGE_CONTENT_VERSION.
export const DATASET_SCHEMA_CONTENT_VERSION = {
  chokepoint: '2026-09-03',
  crisis: '2026-09-03',
  tools: '2026-09-03',
};
export const CRISIS_PAGE_CONTENT_VERSION = '2026-09-03';
const TOOLS_PAGE_CONTENT_VERSION = '2026-09-03';
const RESEARCH_PAGE_CONTENT_VERSION = '2026-09-03';
const DATASET_LICENSE = {
  '@type': 'CreativeWork',
  name: 'World Monitor Terms of Service (27 July 2026)',
  url: 'https://www.worldmonitor.app/docs/terms',
};
const CII_INDEX_DATASET_DOWNLOAD = 'cii-ranking.json';
const COUNTRIES_INDEX_DATASET_DOWNLOAD = 'resilience-ranking.json';
const COUNTRY_DATASET_DOWNLOAD = 'resilience.json';
const COUNTRY_CII_DATASET_DOWNLOAD = 'cii.json';
const CHOKEPOINTS_INDEX_DATASET_DOWNLOAD = 'status.json';
const CHOKEPOINT_DATASET_DOWNLOAD = 'reference.json';
const CRISIS_DATASET_DOWNLOAD = 'tracker.json';
const CONVERGENCE_DATASET_DOWNLOAD = 'reference.json';
const DATA_CATALOG_FRAGMENT = '#data-catalog';
// Role filler for Dataset.creator / DataCatalog.publisher. The `@id` folds every
// occurrence into the canonical Organization declared on welcome.html (#7459b),
// but the `@type` + `name` must stay: structured-data parsers resolve `@id` within
// ONE document, and no generated corpus page declares that node. A bare `@id` here
// is an unresolvable stub for exactly the naive extractors #7459b set out to serve.
// This is the same typed-stub-plus-@id shape blog-site/src/layouts/BlogPost.astro
// already uses for the canonical Person.
export const WORLD_MONITOR_ORG = Object.freeze({
  '@id': 'https://www.worldmonitor.app/#organization',
  '@type': 'Organization',
  name: 'World Monitor',
  url: 'https://www.worldmonitor.app/',
});
export const WEBSITE_ID = 'https://www.worldmonitor.app/#website';
const DEFAULT_SPEAKABLE = Object.freeze({
  '@type': 'SpeakableSpecification',
  cssSelector: ['h1', '.lede'],
});
const PAGE_TYPES_WITH_SPEAKABLE = new Set([
  'WebPage',
  'CollectionPage',
  'ItemPage',
  'Article',
  'Report',
  'BlogPosting',
]);
const PAGE_TYPES_WITH_WEBPAGE_ID = new Set([
  'WebPage',
  'CollectionPage',
  'ItemPage',
]);
// Approximate monitoring footprint around each registry centroid (degrees).
// Registry entries are points; GeoShape.box lets crawlers treat the waterway as
// a corridor envelope rather than a zero-area pin.
const CHOKEPOINT_GEO_HALF_SPAN_DEG = 0.75;
const CHANGELOG_PAGE_SIZE = 2;
const MAX_TOOL_LATITUDE_SPAN = 45;
const MAX_TOOL_LONGITUDE_SPAN = 60;
const META_DESCRIPTION_MIN = 155;
const META_DESCRIPTION_MAX = 160;

// Search-friendly common names for ISO2 codes whose source identities use a
// formal long form, truncated token ("Uk", "Korea Rep", "Lao Pdr"), or code.
// Legacy source-name slugs are redirected to the common-name canonical route.
const COUNTRY_DISPLAY_NAMES = {
  AE: 'United Arab Emirates',
  AG: 'Antigua and Barbuda',
  BA: 'Bosnia and Herzegovina',
  CD: 'DR Congo',
  CG: 'Republic of the Congo',
  CI: 'Côte d’Ivoire',
  EH: 'Western Sahara',
  FM: 'Micronesia',
  GB: 'United Kingdom',
  HK: 'Hong Kong',
  KG: 'Kyrgyzstan',
  KN: 'Saint Kitts and Nevis',
  KP: 'North Korea',
  KR: 'South Korea',
  LA: 'Laos',
  LC: 'Saint Lucia',
  MM: 'Myanmar',
  MO: 'Macau',
  NC: 'New Caledonia',
  PR: 'Puerto Rico',
  PS: 'Palestine',
  RS: 'Serbia',
  SK: 'Slovakia',
  ST: 'São Tomé and Príncipe',
  TL: 'Timor-Leste',
  TR: 'Turkey',
  TT: 'Trinidad and Tobago',
  VC: 'Saint Vincent and the Grenadines',
  VE: 'Venezuela',
  XK: 'Kosovo',
};

function displayCountryName(code, fallbackName) {
  return COUNTRY_DISPLAY_NAMES[code] || fallbackName || code;
}

// Exported so a test can hold .gitignore to this list. Every directory here is
// deleted and rewritten on each build, so one missing an ignore rule shows up
// as permanent untracked noise and can be committed by a stray `git add -A`.
export const GENERATED_DIRS = [
  'country-instability-index',
  'countries',
  'chokepoints',
  'compare',
  'crises',
  'tools',
  'reference/changelog',
  'research',
  'sources',
  'use-cases',
];

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

function repoPath(rootDir, relativePath) {
  return join(rootDir, relativePath);
}

function readText(rootDir, relativePath) {
  return readFileSync(repoPath(rootDir, relativePath), 'utf8');
}

function readJson(rootDir, relativePath) {
  return JSON.parse(readText(rootDir, relativePath));
}

export function resolveLatestResilienceSnapshotPath(rootDir = DEFAULT_ROOT) {
  const snapshotDir = repoPath(rootDir, RESILIENCE_SNAPSHOT_DIR);
  const candidates = readdirSync(snapshotDir)
    .map((filename) => ({ filename, match: filename.match(RESILIENCE_SNAPSHOT_RE) }))
    .filter(({ match }) => match)
    .sort((a, b) => b.match[1].localeCompare(a.match[1]));
  if (candidates.length === 0) {
    throw new Error(`No canonical resilience ranking snapshot found in ${RESILIENCE_SNAPSHOT_DIR}`);
  }

  const [{ filename, match }] = candidates;
  const relativePath = join(RESILIENCE_SNAPSHOT_DIR, filename);
  const snapshot = readJson(rootDir, relativePath);
  if (snapshot.capturedAt !== match[1]) {
    throw new Error(
      `${relativePath} filename date ${match[1]} does not match capturedAt ${snapshot.capturedAt}`,
    );
  }
  return relativePath;
}

export function resolveLatestLivePulseSnapshotPath(rootDir = DEFAULT_ROOT) {
  const snapshotDir = repoPath(rootDir, RESILIENCE_SNAPSHOT_DIR);
  const candidates = readdirSync(snapshotDir)
    .map((filename) => ({ filename, match: filename.match(LIVE_PULSE_SNAPSHOT_RE) }))
    .filter(({ match }) => match)
    .sort((a, b) => b.match[1].localeCompare(a.match[1]));
  if (candidates.length === 0) {
    throw new Error(`No crawlable live-pulse snapshot found in ${RESILIENCE_SNAPSHOT_DIR}`);
  }

  const [{ filename, match }] = candidates;
  const relativePath = join(RESILIENCE_SNAPSHOT_DIR, filename);
  const snapshot = readJson(rootDir, relativePath);
  if (snapshot.capturedAt !== match[1]) {
    throw new Error(
      `${relativePath} filename date ${match[1]} does not match capturedAt ${snapshot.capturedAt}`,
    );
  }
  if (!snapshot.countries || !snapshot.chokepoints || !snapshot.crises || !snapshot.signalConvergence) {
    throw new Error(`${relativePath} is missing required live-pulse sections`);
  }
  const capturedAtMs = Date.parse(`${snapshot.capturedAt}T00:00:00Z`);
  const ageDays = Number.isFinite(capturedAtMs)
    ? (Date.now() - capturedAtMs) / 86_400_000
    : Number.POSITIVE_INFINITY;
  if (ageDays > MAX_LIVE_PULSE_SNAPSHOT_AGE_DAYS) {
    throw new Error(
      `${relativePath} is ${Math.round(ageDays)} days old (max ${MAX_LIVE_PULSE_SNAPSHOT_AGE_DAYS}); `
      + 'run `npm run freeze:crawlable-live-pulse` to republish current values',
    );
  }
  return relativePath;
}

function formatStaticDateTime(iso) {
  const timestamp = Date.parse(iso);
  if (!Number.isFinite(timestamp)) return String(iso || '');
  return new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'UTC',
    timeZoneName: 'short',
  }).format(new Date(timestamp));
}

function isCanonicalIsoInstant(value) {
  if (typeof value !== 'string') return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function pulseDateOnly(asOf, fallback) {
  if (typeof asOf === 'string' && /^\d{4}-\d{2}-\d{2}/.test(asOf)) {
    return asOf.slice(0, 10);
  }
  return fallback;
}

export function buildCiiRankingEntries(countries, livePulse) {
  const countryByCode = new Map(countries.map((country) => [country.code, country]));
  const methodologyVersions = new Set();
  const entries = [];

  for (const [code, pulse] of Object.entries(livePulse?.countries || {})) {
    if (pulse?.partial === true || pulse?.score == null || pulse.score === '') continue;
    const country = countryByCode.get(code);
    if (!country) throw new Error(`CII pulse contains unknown country ${code}`);
    const score = Number(pulse.score);
    const band = instabilityBand(score);
    if (!Number.isFinite(score) || band === null || band !== pulse.band) {
      throw new Error(`CII pulse score or band is invalid for ${code}`);
    }
    const asOf = String(pulse.asOf || '').trim();
    if (!isCanonicalIsoInstant(asOf)) {
      throw new Error(`CII pulse timestamp is invalid for ${code}`);
    }
    const methodologyVersion = String(pulse.methodologyVersion || '').trim();
    if (!methodologyVersion) throw new Error(`CII pulse methodology is unavailable for ${code}`);
    methodologyVersions.add(methodologyVersion);
    entries.push({
      country,
      code,
      score,
      band,
      trend: String(pulse.trend || '').trim(),
      asOf,
      methodologyVersion,
      ...parseCiiMovement(pulse.trend),
    });
  }

  entries.sort((left, right) => right.score - left.score || left.country.name.localeCompare(right.country.name));
  const entryCodes = new Set(entries.map((entry) => entry.code));
  const expectedCodes = new Set(CII_COUNTRY_CODES);
  const missingCodes = CII_COUNTRY_CODES.filter((code) => !entryCodes.has(code));
  const unexpectedCodes = [...entryCodes].filter((code) => !expectedCodes.has(code));
  if (missingCodes.length > 0 || unexpectedCodes.length > 0) {
    throw new Error(
      `CII ranking country set is invalid: missing ${missingCodes.join(', ') || 'none'}; `
      + `unexpected ${unexpectedCodes.join(', ') || 'none'}`,
    );
  }
  if (methodologyVersions.size !== 1) {
    throw new Error('CII ranking mixes methodology versions');
  }
  return {
    entries,
    byCode: new Map(entries.map((entry) => [entry.code, entry])),
    methodologyVersion: entries[0].methodologyVersion,
    updatedAt: entries.reduce(
      (latest, entry) => Date.parse(entry.asOf) > Date.parse(latest) ? entry.asOf : latest,
      entries[0].asOf,
    ),
  };
}

function liveUpdatedMarkup({ asOf, fallbackLabel, prefix = 'Published pulse' }) {
  if (asOf) {
    return `<time data-live-updated datetime="${escapeHtml(asOf)}">${escapeHtml(prefix)} ${escapeHtml(formatStaticDateTime(asOf))}</time>`;
  }
  // Never put loading prose in a <time> without datetime — crawlers treat that
  // as an undated temporal claim.
  return `<span data-live-updated>${escapeHtml(fallbackLabel)}</span>`;
}

export function laterDate(...values) {
  return values
    .filter((value) => /^\d{4}-\d{2}-\d{2}$/.test(value ?? ''))
    .sort()
    .at(-1) ?? null;
}

/** Observation window for chokepoint Dataset temporalCoverage and table stamps.
 *  Git lastmod wins when history is present; committed dates keep Docker
 *  corpus builds (no `.git`) from publishing capturedAt: null. */
export function resolveChokepointObservation({
  registryGitLastmod = null,
  tradeRoutesGitLastmod = null,
} = {}) {
  return {
    capturedAt: laterDate(
      registryGitLastmod,
      tradeRoutesGitLastmod,
      CHOKEPOINT_REGISTRY_OBSERVED_AT,
      TRADE_ROUTES_OBSERVED_AT,
    ),
    volumeObservedAt: laterDate(
      tradeRoutesGitLastmod,
      TRADE_ROUTES_OBSERVED_AT,
    ),
  };
}

export function sourcePageLastmod({
  manifestLastmod,
  rendererLastmod,
  originLastmod,
  catalogInputLastmods = [],
  sharedTemplateLastmod,
  generatorContentVersion = CORPUS_GENERATOR_CONTENT_VERSION,
  pageContentVersion = SOURCES_PAGE_CONTENT_VERSION,
}) {
  return laterDate(
    manifestLastmod,
    rendererLastmod,
    originLastmod,
    ...catalogInputLastmods,
    sharedTemplateLastmod,
    generatorContentVersion,
    pageContentVersion,
  );
}

function normalizeBaseUrl(baseUrl) {
  return String(baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
}

function absoluteUrl(baseUrl, pathname) {
  return `${normalizeBaseUrl(baseUrl)}${pathname}`;
}

// Tag dashboard-bound CTAs so page→dashboard conversion is measurable in the
// analytics UTM report. Deliberately NOT `ref=`: the dashboard captures
// `?ref=` as an affiliate referral code (src/services/referral-capture.ts)
// and forwards it to checkout attribution, so a static-page source tag there
// would pollute purchase attribution.
function withUtmSource(url, utmSource) {
  return `${url}${url.includes('?') ? '&' : '?'}utm_source=${utmSource}`;
}

function dataCatalogId(baseUrl) {
  return `${normalizeBaseUrl(baseUrl)}/${DATA_CATALOG_FRAGMENT}`;
}

export function dataCatalogLd(baseUrl) {
  return {
    '@context': SCHEMA_ORG_CONTEXT_URL,
    '@type': 'DataCatalog',
    '@id': dataCatalogId(baseUrl),
    name: 'World Monitor open data catalog',
    description:
      'Crawlable World Monitor datasets for country instability, country resilience, maritime chokepoint reference, bounded crisis trackers, and research snapshots, with static downloads generated from committed data.',
    url: `${normalizeBaseUrl(baseUrl)}/`,
    publisher: { ...WORLD_MONITOR_ORG },
    creator: { ...WORLD_MONITOR_ORG },
    inLanguage: 'en-US',
    isAccessibleForFree: true,
    license: DATASET_LICENSE,
  };
}

function includedInDataCatalog(baseUrl) {
  return {
    '@type': 'DataCatalog',
    '@id': dataCatalogId(baseUrl),
    name: 'World Monitor open data catalog',
  };
}

function dataDownload(contentUrl, encodingFormat = 'application/json') {
  return {
    '@type': 'DataDownload',
    encodingFormat,
    contentUrl,
  };
}

const OBSERVATION_COVERAGE_RE = /^\d{4}-\d{2}-\d{2}(?:\/\d{4}-\d{2}-\d{2})?$/;

/** Dataset temporalCoverage from a committed observation date or closed interval.
 *  Omit when the artifact has no build-time window. Never pass page lastmod. */
export function datasetTemporalCoverage(observationInterval) {
  if (typeof observationInterval !== 'string') return undefined;
  const trimmed = observationInterval.trim();
  return OBSERVATION_COVERAGE_RE.test(trimmed) ? trimmed : undefined;
}

export function datasetObservationCoverage(observedAtValues) {
  const dates = [...new Set(
    observedAtValues
      .map((observedAt) => pulseDateOnly(observedAt, null))
      .filter(Boolean),
  )].sort();
  if (dates.length === 0) return undefined;
  return datasetTemporalCoverage(dates.length === 1 ? dates[0] : `${dates[0]}/${dates.at(-1)}`);
}

function datasetDownloadHref(pagePath, filename) {
  return `${pagePath}${filename}`;
}

function datasetDownloadFile(pagePath, filename) {
  return datasetDownloadHref(pagePath, filename).replace(/^\/+/, '');
}

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function countryDatasetDownload(country, {
  capturedAt,
  methodologyFormula,
  rankedCount,
  snapshotPath,
  developments = null,
}) {
  const scorePublished = country.headlineEligible !== false;
  return stableJson({
    dataset: 'country-resilience-snapshot',
    countryCode: country.code,
    countryName: country.name,
    slug: country.slug,
    rank: scorePublished ? country.rank : null,
    overallScore: scorePublished ? country.overallScore : null,
    dimensionCoverage: country.dimensionCoverage,
    confidence: country.lowConfidence ? 'low' : 'standard',
    level: scorePublished ? country.level : 'unpublished',
    sourceStatus: country.sourceStatus,
    headlineEligible: country.headlineEligible,
    capturedAt,
    methodologyFormula,
    rankedCount,
    source: snapshotPath,
    license: DATASET_LICENSE.url,
    // Frozen recent developments (#7615): dated, attributed headlines, the
    // intel brief with its grounding sources, and timeline events. Null when the
    // snapshot captured nothing for this country — the post-enrichment input
    // for the residual regional-hub consolidation decision.
    developments: developmentsHasDatedItem(developments) ? developments : null,
  });
}

function countryCiiDatasetDownload(country, ciiEntry, { capturedAt, snapshotPath }) {
  return stableJson({
    dataset: 'country-instability-index',
    countryCode: country.code,
    countryName: country.name,
    methodologyVersion: ciiEntry.methodologyVersion,
    score: ciiEntry.score,
    approximate24HourMovement: ciiEntry.change24h,
    instabilityLevel: ciiEntry.band,
    observedAt: ciiEntry.asOf,
    capturedAt,
    source: snapshotPath,
    license: DATASET_LICENSE.url,
  });
}

function countriesIndexDatasetDownload(countries, { capturedAt, snapshotPath }) {
  return stableJson({
    dataset: 'country-resilience-ranking',
    capturedAt,
    source: snapshotPath,
    license: DATASET_LICENSE.url,
    countries: countries.map((country) => ({
      code: country.code,
      name: country.name,
      rank: country.headlineEligible === false ? null : country.rank,
      overallScore: country.headlineEligible === false ? null : country.overallScore,
      dimensionCoverage: country.dimensionCoverage,
      confidence: country.lowConfidence ? 'low' : 'standard',
      level: country.headlineEligible === false ? 'unpublished' : country.level,
    })),
  });
}

function chokepointDatasetDownload(chokepoint, {
  tradeRoutesById,
  capturedAt = null,
  volumeObservedAt = null,
}) {
  const content = CHOKEPOINT_CONTENT[chokepoint.id] || {};
  const modelledTradeRoutes = chokepoint.routeIds
    .map((id) => tradeRoutesById.get(id))
    .filter(Boolean)
    .map((route) => ({
      id: route.id,
      name: route.name,
      volumeDesc: route.volumeDesc || null,
      category: route.category || null,
    }));
  return stableJson({
    dataset: 'chokepoint-reference',
    id: chokepoint.id,
    displayName: chokepoint.displayName,
    slug: chokepoint.slug,
    lat: Number.isFinite(chokepoint.lat) ? chokepoint.lat : null,
    lon: Number.isFinite(chokepoint.lon) ? chokepoint.lon : null,
    region: content.region || null,
    shockModelSupported: chokepoint.shockModelSupported,
    modelledTradeRoutes,
    capturedAt: capturedAt || null,
    volumeObservedAt: volumeObservedAt || capturedAt || null,
    source: [CHOKEPOINT_REGISTRY_PATH, TRADE_ROUTES_PATH],
    license: DATASET_LICENSE.url,
  });
}

function ciiIndexDatasetDownload(ciiRanking, { capturedAt, snapshotPath }) {
  return stableJson({
    dataset: 'country-instability-index',
    methodologyVersion: ciiRanking.methodologyVersion,
    capturedAt,
    source: snapshotPath,
    license: DATASET_LICENSE.url,
    countries: ciiRanking.entries.map((entry) => ({
      code: entry.code,
      name: entry.country.name,
      score: entry.score,
      approximate24HourMovement: entry.change24h,
      instabilityLevel: entry.band,
      observedAt: entry.asOf,
    })),
  });
}

function chokepointsIndexDatasetDownload(chokepointHubRows, { capturedAt, snapshotPath }) {
  return stableJson({
    dataset: 'maritime-chokepoint-status',
    capturedAt,
    source: snapshotPath,
    license: DATASET_LICENSE.url,
    chokepoints: chokepointHubRows.map((row) => ({
      id: row.chokepoint.id,
      name: row.chokepoint.displayName,
      slug: row.chokepoint.slug,
      region: row.region,
      disruptionScore: row.score,
      status: row.status,
      aisCongestion: row.congestion,
      aisSnapshotAvailable: row.aisSnapshotAvailable,
      observedAt: row.asOf,
    })),
  });
}

function sumRows(rows, key) {
  return rows.reduce((total, row) => total + (Number.isFinite(row?.[key]) ? row[key] : 0), 0);
}

/** Numeric crisis totals for the machine-readable download, or nulls when withheld. */
function pulseTotals(pulse) {
  const rows = Array.isArray(pulse.rows) ? pulse.rows : [];
  if (pulse.eventsTotal === null || rows.length === 0) {
    return { eventsTotal: null, fatalities: null, politicalViolenceEvents: null };
  }
  return {
    eventsTotal: sumRows(rows, 'events'),
    fatalities: sumRows(rows, 'fatalities'),
    politicalViolenceEvents: sumRows(rows, 'political'),
  };
}

function crisisDatasetDownload(crisis, pulse = null, numericTotals = null) {
  return stableJson({
    dataset: 'crisis-tracker',
    slug: crisis.slug,
    title: crisis.title,
    shortTitle: crisis.shortTitle,
    description: crisis.description,
    overview: crisis.overview,
    coverage: crisis.coverage,
    source: CRISIS_REGISTRY_PATH,
    license: DATASET_LICENSE.url,
    ...(pulse ? {
      maintainedPulse: {
        state: pulse.state,
        // The pulse carries Intl-formatted display strings ("9,824"); a Dataset
        // The build loop shares numeric totals with the page schema. The pulse
        // carries Intl-formatted display strings, so these values stay
        // machine-readable; `eventsTotal === null` remains the marker for
        // "reference periods differ, combined total withheld".
        ...numericTotals,
        referencePeriod: pulse.referencePeriod,
        asOf: pulse.asOf,
        missingCountries: pulse.missingCountries,
        rows: pulse.rows,
      },
    } : {}),
  });
}

function geoShapeBox(south, west, north, east) {
  const round = (value) => Math.round(Number(value) * 1000) / 1000;
  return {
    '@type': 'GeoShape',
    box: `${round(south)} ${round(west)} ${round(north)} ${round(east)}`,
  };
}

function chokepointGeoShape(lat, lon, halfSpan = CHOKEPOINT_GEO_HALF_SPAN_DEG) {
  return geoShapeBox(lat - halfSpan, lon - halfSpan, lat + halfSpan, lon + halfSpan);
}

// Google's Dataset parser accepts only Text or a literal Place here — the Country
// subtype is rejected as "Invalid object type for field spatialCoverage".
function countrySpatialCoverage(country, bbox) {
  const place = {
    '@type': 'Place',
    name: country.name,
    identifier: country.code,
  };
  if (Array.isArray(bbox) && bbox.length === 4 && bbox.every((value) => Number.isFinite(Number(value)))) {
    const [south, west, north, east] = bbox.map(Number);
    place.geo = geoShapeBox(south, west, north, east);
  }
  return place;
}

function propertyValue(name, value) {
  return {
    '@type': 'PropertyValue',
    name,
    value,
  };
}

const OG_IMAGE_PATH = '/favico/og-image.png';
const OG_IMAGE_ALT = 'World Monitor — real-time global intelligence dashboard with live markets, geopolitical data, and infrastructure monitoring';

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeJsonScript(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

export function slugify(value) {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .toLowerCase();
}

function uniqueSlug(preferred, code, seen) {
  const base = slugify(preferred || code);
  const fallback = slugify(code);
  let slug = base || fallback;
  if (!seen.has(slug)) {
    seen.add(slug);
    return slug;
  }
  slug = `${base || 'page'}-${String(code).toLowerCase()}`;
  let i = 2;
  while (seen.has(slug)) {
    slug = `${base || 'page'}-${String(code).toLowerCase()}-${i}`;
    i += 1;
  }
  seen.add(slug);
  return slug;
}

function titleCaseName(value) {
  return String(value ?? '')
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function reverseCountryNames(forward) {
  const reverse = new Map();
  for (const [name, code] of Object.entries(forward || {})) {
    const iso2 = String(code || '').toUpperCase();
    if (!/^[A-Z]{2}$/.test(iso2) || reverse.has(iso2)) continue;
    reverse.set(iso2, titleCaseName(name));
  }
  return reverse;
}

function prettyDate(isoDate) {
  const match = String(isoDate || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return String(isoDate || '');
  const [, year, month, day] = match;
  return `${MONTHS[Number(month) - 1]} ${Number(day)}, ${year}`;
}

function timeMarkup(isoDate, label = prettyDate(isoDate)) {
  if (typeof isoDate !== 'string' || !/^\d{4}(-\d{2}(-\d{2})?)?$/.test(isoDate)) {
    return escapeHtml(label);
  }
  return `<time datetime="${escapeHtml(isoDate)}">${escapeHtml(label)}</time>`;
}

function formatPercent(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 'not available';
  return `${Math.round(numeric * 100)}%`;
}

const OBSERVED_EVIDENCE = Object.freeze({ coverage: true });

// A dimension carries an imputationClass ONLY when observedWeight === 0 -- see the
// four-class taxonomy in proto/worldmonitor/resilience/v1/resilience.proto and
// server/worldmonitor/resilience/v1/_shared.ts. So an empty class is the allow-list
// for "observed", exactly as buildMicrostateEvidenceProfile already requires below.
// Enumerating the withheld classes instead would fail OPEN on any fifth class
// (it already omitted 'stable-absence', whose imputed scores run 85-88).
export function hasObservedValue(value, { coverage, evidenceState = '' } = {}) {
  const numericValue = typeof value === 'string' ? value.replace(/,/g, '').trim() : value;
  const numericCoverage = Number(coverage);
  return numericValue !== ''
    && numericValue != null
    && Number.isFinite(Number(numericValue))
    && Number.isFinite(numericCoverage)
    && numericCoverage > 0
    && String(evidenceState || '') === '';
}

function formatObservedNumber(value, evidence, formatter, fallback = '—') {
  if (!hasObservedValue(value, evidence)) return fallback;
  const numeric = Number(typeof value === 'string' ? value.replace(/,/g, '') : value);
  return formatter(numeric);
}

function formatScoreNumber(numeric) {
  return numeric.toFixed(1).replace(/\.0$/, '');
}

function formatScore(value, evidence) {
  return formatObservedNumber(value, evidence, formatScoreNumber);
}

function dimensionScoreEvidence(dimension) {
  return {
    coverage: dimension.coverage,
    evidenceState: dimension.imputationClass,
  };
}

function hasObservedDimensionScore(dimension) {
  return hasObservedValue(dimension.score, dimensionScoreEvidence(dimension));
}

function domainScoreEvidence(domain) {
  return { coverage: domain.dimensions.some(hasObservedDimensionScore) };
}

// Weakest/strongest claims may only rank entries that actually have a reading.
// A withheld pillar or domain is not the weakest one, it is no reading at all --
// ranking it would name it in prose and then print an em dash for its score.
function observedPillarsOf(pillars) {
  return pillars.filter((pillar) => hasObservedValue(pillar.score, { coverage: pillar.coverage }));
}

function observedDomainsOf(domains) {
  return domains.filter((domain) => hasObservedValue(domain.score, domainScoreEvidence(domain)));
}

function dimensionEvidenceState(dimension) {
  const evidenceState = String(dimension.imputationClass || '');
  if (evidenceState) return humanizeId(evidenceState);
  if (!hasObservedDimensionScore(dimension)) return 'Unavailable';
  return humanizeId(dimension.freshness?.staleness || 'observed');
}

function formatCoordinates(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return 'not available';
  const latText = `${Math.abs(lat)}°${lat >= 0 ? 'N' : 'S'}`;
  const lonText = `${Math.abs(lon)}°${lon >= 0 ? 'E' : 'W'}`;
  return `${latText}, ${lonText}`;
}

function longestEligibleMetaDescription(candidates) {
  // Linear scan, first-longest wins — the same pick a stable descending sort
  // by length would make, without copying and sorting the (potentially ~12k)
  // candidate array.
  let best;
  const seen = new Set();
  for (const raw of candidates) {
    const candidate = String(raw ?? '').trim();
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    if (candidate.length > META_DESCRIPTION_MAX) continue;
    if (best === undefined || candidate.length > best.length) best = candidate;
  }
  return best;
}

function formatMetaDescriptionList(items) {
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, and ${items.at(-1)}`;
}

function signalMetaDescriptionCandidates({ subjects, signals }) {
  const candidates = [];
  const subsetCount = 2 ** signals.length;
  // The formatted signal list depends only on the mask, so format each subset
  // once instead of once per subject×verb combination. The triple loop below
  // keeps its original nesting so the candidate order — and therefore which
  // equal-length candidate longestEligibleMetaDescription picks — is unchanged.
  const listByMask = new Array(subsetCount);
  for (let mask = 1; mask < subsetCount; mask += 1) {
    const selectedSignals = signals.filter((_, index) => mask & (2 ** index));
    if (selectedSignals.length < 3) continue;
    listByMask[mask] = formatMetaDescriptionList(selectedSignals);
  }
  for (const subject of subjects) {
    for (const verb of ['tracks', 'monitors', 'covers']) {
      for (let mask = 1; mask < subsetCount; mask += 1) {
        if (listByMask[mask] === undefined) continue;
        candidates.push(`${subject}: ${verb} ${listByMask[mask]}.`);
      }
    }
  }
  return candidates;
}

// `subject` names the page so a failure is actionable. Without it the build
// dies with a bare "No meta description candidate fits 155-160 characters"
// across 250 pages and says nothing about which one or how close it came.
function selectMetaDescription(candidates, fallbackCandidates, subject) {
  const selected = longestEligibleMetaDescription(candidates);
  if (selected?.length >= META_DESCRIPTION_MIN) return selected;

  const fallback = longestEligibleMetaDescription(fallbackCandidates?.() ?? []);
  if (fallback?.length >= META_DESCRIPTION_MIN) return fallback;

  const lengths = [...candidates, ...(fallbackCandidates?.() ?? [])]
    .map((candidate) => candidate.length)
    .sort((left, right) => left - right);
  const near = lengths.length > 0
    ? ` Candidate lengths ranged ${lengths[0]}-${lengths.at(-1)} over ${lengths.length} candidate(s).`
    : ' No candidates were generated.';
  throw new Error(
    `No meta description candidate fits ${META_DESCRIPTION_MIN}-${META_DESCRIPTION_MAX} characters`
    + `${subject ? ` for ${subject}` : ''}.${near}`,
  );
}

export function countryMetaDescription({
  name,
  rank,
  rankedCount,
  lowConfidence = false,
  ciiEntry = null,
}) {
  if (ciiEntry) {
    const movementFact = ciiEntry.change24h == null
      ? 'with 24-hour movement stable or unavailable'
      : `and is ${ciiEntry.movementText}`;
    const subjects = [
      `${name} Country Instability Index`,
      `${name} instability index`,
    ];
    const facts = [
      `is ${formatScore(ciiEntry.score, OBSERVED_EVIDENCE)}/100 (${ciiEntry.band}) ${movementFact}`,
      `scores ${formatScore(ciiEntry.score, OBSERVED_EVIDENCE)}/100 (${ciiEntry.band}) ${movementFact}`,
    ];
    // Graded long-to-short. The window is a narrow 155-160, so a long country
    // name plus a long movement clause can push EVERY candidate over: "United
    // Arab Emirates" made all 24 land in 162-196 and reds the whole build
    // (#7530). The short tail is what keeps a 20-character name in range.
    const contexts = [
      'with World Monitor country-risk, resilience, advisory, and sanctions context.',
      'with World Monitor risk, resilience, advisory, and sanctions context.',
      'alongside World Monitor risk, resilience, advisory, and sanctions context.',
      'with World Monitor country-risk, resilience, and security context.',
      'with World Monitor country-risk and resilience context.',
      'alongside World Monitor country-risk and resilience context.',
      'with World Monitor risk, resilience and sanctions context.',
      'with World Monitor risk and resilience context.',
      'with World Monitor risk context.',
    ];
    const candidates = subjects.flatMap((subject) => facts.flatMap(
      (fact) => contexts.map((context) => `${subject} ${fact}, ${context}`),
    ));
    return selectMetaDescription(candidates, undefined, `${name} (CII country)`);
  }

  const subjects = [
    `${name} country risk and resilience`,
    `${name} country risk`,
    `${name} risk and resilience`,
  ];
  const unpublishedStandings = lowConfidence
    ? [
      `a low-confidence listing in World Monitor's Country Resilience Index`,
      `a low-confidence listing in World Monitor's resilience index`,
      `a low-confidence listing in World Monitor's index`,
      `a low-confidence World Monitor index listing`,
      `a low-confidence index listing`,
    ]
    : [
      `an unpublished listing in World Monitor's Country Resilience Index`,
      `an unpublished listing in World Monitor's resilience index`,
      `an unpublished listing in World Monitor's index`,
      `an unpublished World Monitor index listing`,
      `an unpublished index listing`,
    ];
  const standings = rank == null
    ? unpublishedStandings
    : [
      `ranked #${rank} of ${rankedCount} in World Monitor's Country Resilience Index`,
      `ranked #${rank} of ${rankedCount} in World Monitor's resilience index`,
      `ranked #${rank} of ${rankedCount} in World Monitor's index`,
      `#${rank} of ${rankedCount} in World Monitor's resilience index`,
      `#${rank} of ${rankedCount} in World Monitor's index`,
    ];
  const signals = [
    'with live instability, travel advisories, sanctions and security signals.',
    'with current instability, travel advisories, sanctions and security signals.',
    'with live instability, travel-advisory and sanctions signals.',
    'plus live instability, travel advisories, sanctions and security signals.',
    'with live instability, advisories, sanctions and security signals.',
    'with instability, travel advisories, sanctions and security signals.',
    'with current instability, advisories, sanctions and security signals.',
  ];
  const candidates = subjects.flatMap((subject) => standings.flatMap(
    (standing) => signals.map((signal) => `${subject}: ${standing}, ${signal}`),
  ));
  return selectMetaDescription(candidates, () => signalMetaDescriptionCandidates({
    subjects: [
      `${name} country risk profile`,
      `${name} risk profile`,
      `${name} country risk`,
      `${name} risk`,
    ],
    signals: [
      'live instability',
      'travel advisories',
      'sanctions',
      'security signals',
      'resilience rankings',
      'current conditions',
      'global context',
      'regional context',
      'risk trends',
      'public data',
    ],
  }), `${name} (ranked country)`);
}

export function chokepointMetaDescription(name) {
  const subjects = [
    `${name} chokepoint status`,
    `${name} live chokepoint status`,
    `${name} maritime chokepoint status`,
    `${name} live status`,
  ];
  const signals = [
    'monitor live disruption risk, vessel transits, congestion, AIS warnings and key trade routes through this strategic waterway.',
    'track live disruption risk, vessel transits, congestion, AIS warnings and major trade routes through this strategic waterway.',
    'track disruption risk, vessel transits, congestion, AIS warnings and major trade routes through this strategic waterway.',
    'monitor disruption risk, transits, congestion, AIS warnings and trade routes through this strategic waterway.',
  ];
  const candidates = subjects.flatMap(
    (subject) => signals.map((signal) => `${subject}: ${signal}`),
  );
  return selectMetaDescription(candidates, () => signalMetaDescriptionCandidates({
    subjects: [
      `${name} maritime chokepoint`,
      `${name} chokepoint status`,
      `${name} chokepoint`,
      `${name} status`,
    ],
    signals: [
      'live disruption risk',
      'vessel transits',
      'congestion',
      'AIS warnings',
      'trade routes',
      'maritime security',
      'current conditions',
      'regional context',
      'shipping signals',
      'public data',
    ],
  }), `${name} (chokepoint)`);
}

function metricTile(label, value) {
  return `        <div class="metric"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`;
}

async function importRepoModule(rootDir, relativePath) {
  return import(pathToFileURL(repoPath(rootDir, relativePath)).href);
}

function normalizeGlossaryTerms(terms) {
  return (terms || [])
    .map((term) => ({
      slug: term.slug,
      term: term.term,
      abbr: term.abbr || undefined,
      short: term.short,
    }))
    .filter((term) => term.slug && term.term)
    .sort((a, b) => a.term.localeCompare(b.term));
}

function normalizeChokepoints(entries) {
  return (entries || [])
    .map((entry) => ({
      id: entry.id,
      displayName: entry.displayName,
      baselineId: entry.baselineId,
      shockModelSupported: Boolean(entry.shockModelSupported),
      routeIds: Array.isArray(entry.routeIds) ? [...entry.routeIds] : [],
      lat: Number(entry.lat),
      lon: Number(entry.lon),
      slug: slugify(entry.displayName || entry.id),
    }))
    .filter((entry) => entry.id && entry.displayName)
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
}

function normalizeCountry(item, sourceStatus, seen, reverseNames) {
  const code = String(item.countryCode || '').toUpperCase();
  const identity = item.identity || {};
  const commonName = displayCountryName(
    code,
    identity.commonName || item.countryName || reverseNames.get(code) || code,
  );
  const officialName = identity.officialName || commonName;
  const sameAs = String(identity.sameAs || '');
  if (!/^[A-Z]{2}$/.test(code) || !commonName || !/^https:\/\/www\.wikidata\.org\/wiki\/Q\d+$/.test(sameAs)) {
    throw new Error(`Invalid country identity in resilience snapshot: ${code || 'unknown'}`);
  }
  const slug = uniqueSlug(commonName, code, seen);
  const legacySlugs = [...new Set((identity.legacyNames || [])
    .map((name) => slugify(name))
    .filter((legacySlug) => legacySlug && legacySlug !== slug))];
  return {
    code,
    name: commonName,
    slug,
    legacySlugs,
    identity: {
      commonName,
      officialName,
      alternateNames: [...new Set((identity.alternateNames || []).map((name) => (
        name === 'Macao S A R' ? 'Macao SAR' : name
      )))],
      sameAs,
    },
    rank: sourceStatus === 'ranked' ? Number(item.rank) : null,
    overallScore: item.overallScore,
    baselineScore: item.baselineScore ?? null,
    stressScore: item.stressScore ?? null,
    stressFactor: item.stressFactor ?? null,
    level: item.level || (sourceStatus === 'ranked' ? 'unclassified' : 'unpublished'),
    // Greyed-out rows include covered-ineligible countries. Preserve the
    // snapshot flag so unpublished copy can name the population/85% rule
    // instead of calling every unpublished page low-confidence.
    lowConfidence: Boolean(item.lowConfidence),
    dimensionCoverage: item.dimensionCoverage ?? item.overallCoverage ?? null,
    headlineEligible: item.headlineEligible === true,
    trend: item.trend || 'unknown',
    change30d: item.change30d ?? null,
    imputationShare: item.imputationShare ?? null,
    dataVersion: item.dataVersion || '',
    domains: Array.isArray(item.domains) ? item.domains : [],
    pillars: Array.isArray(item.pillars) ? item.pillars : [],
    sourceStatus,
  };
}

function normalizeCountries(snapshot, reverseNames) {
  const seen = new Set();
  const ranked = (snapshot.items || []).map(
    (item) => normalizeCountry(item, 'ranked', seen, reverseNames),
  );

  const rankedCodes = new Set(ranked.map((country) => country.code));
  const greyedOut = (snapshot.greyedOut || [])
    .filter((item) => !rankedCodes.has(String(item.countryCode || '').toUpperCase()))
    .map((item) => normalizeCountry(
      item,
      item.lowConfidence ? 'low-confidence' : 'unpublished',
      seen,
      reverseNames,
    ));

  return [...ranked, ...greyedOut].sort((a, b) => {
    if (a.rank == null && b.rank == null) return a.name.localeCompare(b.name);
    if (a.rank == null) return 1;
    if (b.rank == null) return -1;
    return a.rank - b.rank;
  });
}

function normalizeCountryBounds(countryBboxes, countries, reverseNames = new Map()) {
  const names = new Map(countries.map((country) => [country.code, country.name]));
  return Object.entries(countryBboxes || {})
    .map(([code, rawBounds]) => {
      if (!/^[A-Z]{2}$/.test(code) || !Array.isArray(rawBounds) || rawBounds.length !== 4) return null;
      const bounds = rawBounds.map(Number);
      const [south, west, north, east] = bounds;
      if (
        bounds.some((value) => !Number.isFinite(value))
        || south < -90
        || north > 90
        || south > north
        || west < -180
        || west > 180
        || east < -180
        || east > 180
      ) {
        return null;
      }
      if (
        north - south > MAX_TOOL_LATITUDE_SPAN
        || (west <= east ? east - west : 360 - (west - east)) > MAX_TOOL_LONGITUDE_SPAN
      ) {
        return null;
      }
      return {
        code,
        // Bare ISO2 codes ("EH", "XK") must never surface as user-facing
        // labels in the tool selects — alias, then reverse-name, then code.
        name: displayCountryName(code, names.get(code) || reverseNames.get(code)),
        bounds,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name));
}

function normalizeCrises(entries) {
  const seen = new Set();
  return (entries || []).map((entry) => {
    const slug = String(entry.slug || '');
    const dashboardPath = String(entry.dashboardPath || '');
    const coverage = Array.isArray(entry.coverage)
      ? entry.coverage.map((country) => ({
          code: String(country.code || '').toUpperCase(),
          name: String(country.name || ''),
        }))
      : [];
    const coverageCodes = new Set(coverage.map((country) => country.code));
    if (
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)
      || seen.has(slug)
      || !entry.title
      || !entry.shortTitle
      || !entry.description
      || !entry.overview
      || !dashboardPath.startsWith('/')
      || dashboardPath.startsWith('//')
      || coverage.length === 0
      || coverageCodes.size !== coverage.length
      || coverage.some((country) => !/^[A-Z]{2}$/.test(country.code) || !country.name)
    ) {
      throw new Error(`Invalid crawlable crisis registry entry: ${slug || '(missing slug)'}`);
    }
    seen.add(slug);
    return {
      slug,
      title: String(entry.title),
      shortTitle: String(entry.shortTitle),
      description: String(entry.description),
      overview: String(entry.overview),
      coverage,
      dashboardPath,
    };
  });
}

const REGION_LABELS = {
  'north-america': 'North America',
  latam: 'Latin America and the Caribbean',
  europe: 'Europe',
  mena: 'the Middle East and North Africa',
  'sub-saharan-africa': 'sub-Saharan Africa',
  'south-asia': 'South Asia',
  'east-asia': 'East Asia and the Pacific',
};

export function compareUnpublishedRankedPeers(left, right, country, regionId, regionsByCode) {
  const regionDifference = Number(regionsByCode[right.code] === regionId)
    - Number(regionsByCode[left.code] === regionId);
  const countryScore = Number(country.overallScore);
  const leftScore = Number(left.overallScore);
  const rightScore = Number(right.overallScore);
  const scoreDistance = Number.isFinite(countryScore)
    && Number.isFinite(leftScore)
    && Number.isFinite(rightScore)
    ? Math.abs(leftScore - countryScore) - Math.abs(rightScore - countryScore)
    : 0;
  return regionDifference
    || scoreDistance
    || left.rank - right.rank
    || left.name.localeCompare(right.name);
}

function addCountryContext(countries, regionsByCode, crises) {
  const ranked = countries.filter((country) => country.rank != null);
  return countries.map((country) => {
    const regionId = regionsByCode[country.code] || 'global';
    const unpublished = country.rank == null;
    const peers = ranked
      .filter((candidate) => candidate.code !== country.code)
      .sort((left, right) => {
        if (unpublished) {
          return compareUnpublishedRankedPeers(left, right, country, regionId, regionsByCode);
        }
        const distanceDifference = Math.abs(left.rank - country.rank)
          - Math.abs(right.rank - country.rank);
        return distanceDifference
          || left.rank - right.rank
          || left.name.localeCompare(right.name);
      })
      .slice(0, 4);
    const regionalPeers = (unpublished ? ranked : countries)
      .filter((candidate) => (
        candidate.code !== country.code
        && regionsByCode[candidate.code] === regionId
        && (unpublished || Number.isFinite(candidate.overallScore))
      ))
      .sort((left, right) => unpublished
        ? compareUnpublishedRankedPeers(left, right, country, regionId, regionsByCode)
        : Math.abs(left.overallScore - country.overallScore)
          - Math.abs(right.overallScore - country.overallScore)
          || left.name.localeCompare(right.name))
      .slice(0, 5);
    const crisisMemberships = crises.filter(
      (crisis) => crisis.coverage.some((coveredCountry) => coveredCountry.code === country.code),
    );
    return {
      ...country,
      regionId,
      regionName: REGION_LABELS[regionId] || 'the global comparison set',
      peers,
      regionalPeers,
      crisisMemberships,
      crisisRegistrySize: crises.length,
    };
  });
}

function stripMarkdownInline(value) {
  return String(value || '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*+/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseChangelog(source) {
  const matches = [...source.matchAll(/^## \[([^\]]+)\](?: - ([0-9-]+))?\s*$/gm)];
  return matches.map((match, index) => {
    const next = matches[index + 1];
    const body = source.slice(match.index + match[0].length, next ? next.index : source.length);
    const bulletItems = [];
    let currentBullet = null;
    for (const line of body.split(/\r?\n/)) {
      const bulletMatch = line.match(/^- (.+)$/);
      if (bulletMatch) {
        if (currentBullet) bulletItems.push(currentBullet.join(' '));
        currentBullet = [bulletMatch[1]];
      } else if (currentBullet && /^\s{2,}\S/.test(line)) {
        currentBullet.push(line.trim());
      } else if (currentBullet && line.trim() === '') {
      } else if (currentBullet) {
        bulletItems.push(currentBullet.join(' '));
        currentBullet = null;
      }
    }
    if (currentBullet) bulletItems.push(currentBullet.join(' '));
    const bullets = bulletItems
      .map((line) => stripMarkdownInline(line))
      .filter(Boolean)
      .slice(0, 8);
    const headings = [...body.matchAll(/^###\s+(.+)$/gm)]
      .map(([, heading]) => stripMarkdownInline(heading))
      .filter(Boolean);
    return {
      label: match[1],
      date: match[2] || null,
      slug: slugify(match[1] === 'Unreleased' ? 'unreleased' : match[1]),
      headings,
      bullets,
    };
  }).filter((release) => release.label && release.bullets.length > 0);
}

function latestDatedChangelogRelease(changelog) {
  const dates = changelog
    .map((release) => release.date)
    .filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date ?? ''))
    .sort();
  return dates[dates.length - 1] || null;
}

// Git's local env vars (GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE, ...) override
// `cwd`, so a build running inside a git hook would silently resolve these
// queries against the hook's repository instead of the rootDir it was given.
// Strip them, and render dates in UTC (see gitFileLastmod).
let gitLocalEnvVars = null;
function gitEnvForRoot() {
  if (gitLocalEnvVars === null) {
    try {
      gitLocalEnvVars = execFileSync('git', ['rev-parse', '--local-env-vars'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim().split('\n');
    } catch {
      gitLocalEnvVars = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY'];
    }
  }
  const env = { ...process.env, TZ: 'UTC' };
  for (const name of gitLocalEnvVars) delete env[name];
  return env;
}

function hasCompleteGitHistory(rootDir) {
  try {
    return execFileSync('git', ['rev-parse', '--is-shallow-repository'], {
      cwd: rootDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      env: gitEnvForRoot(),
    }).trim() === 'false';
  } catch {
    return false;
  }
}

export function gitFileLastmod(rootDir, relativePath) {
  if (!hasCompleteGitHistory(rootDir)) return null;
  try {
    // Committer date rendered in UTC, not the commit's recorded timezone —
    // a +04:00 evening commit would otherwise date as "tomorrow" against a
    // UTC build clock and trip build-sitemap's future-lastmod guard.
    const out = execFileSync(
      'git',
      ['log', '-1', '--date=format-local:%Y-%m-%d', '--format=%cd', '--', relativePath],
      {
        cwd: rootDir,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        env: gitEnvForRoot(),
      },
    ).trim();
    return /^\d{4}-\d{2}-\d{2}$/.test(out) ? out : null;
  } catch {
    return null;
  }
}

export async function loadCorpusData({ rootDir = DEFAULT_ROOT } = {}) {
  const resilienceSnapshotPath = resolveLatestResilienceSnapshotPath(rootDir);
  const livePulseSnapshotPath = resolveLatestLivePulseSnapshotPath(rootDir);
  const resilience = readJson(rootDir, resilienceSnapshotPath);
  const livePulse = readJson(rootDir, livePulseSnapshotPath);
  const microstateTerritoryCodes = new Set(
    (readJson(rootDir, MICROSTATE_TERRITORIES_PATH).iso2 || [])
      .map((code) => String(code || '').toUpperCase())
      .filter((code) => /^[A-Z]{2}$/.test(code)),
  );
  const reverseNames = reverseCountryNames(readJson(rootDir, COUNTRY_NAMES_PATH));
  const regionsByCode = readJson(rootDir, COUNTRY_REGIONS_PATH);
  const [
    { CHOKEPOINT_REGISTRY },
    { TRADE_ROUTES },
    { GLOSSARY_TERMS },
    { default: countryBboxes },
    { RESEARCH_REPORTS },
  ] = await Promise.all([
    importRepoModule(rootDir, CHOKEPOINT_REGISTRY_PATH),
    importRepoModule(rootDir, TRADE_ROUTES_PATH),
    importRepoModule(rootDir, GLOSSARY_DATA_PATH),
    importRepoModule(rootDir, COUNTRY_BBOXES_PATH),
    importRepoModule(rootDir, RESEARCH_REPORTS_INDEX_PATH),
  ]);
  const researchReports = RESEARCH_REPORTS.map((report) => ({
    report,
    snapshot: readJson(rootDir, report.snapshotPath),
  }));
  const countryBboxByCode = new Map(
    Object.entries(countryBboxes || {})
      .map(([code, rawBounds]) => {
        if (!/^[A-Z]{2}$/.test(code) || !Array.isArray(rawBounds) || rawBounds.length !== 4) return null;
        const bounds = rawBounds.map(Number);
        if (bounds.some((value) => !Number.isFinite(value))) return null;
        return [code, bounds];
      })
      .filter(Boolean),
  );
  const crises = normalizeCrises(readJson(rootDir, CRISIS_REGISTRY_PATH));
  const countries = addCountryContext(
    normalizeCountries(resilience, reverseNames),
    regionsByCode,
    crises,
  ).map((country) => ({
    ...country,
    microstateTerritory: microstateTerritoryCodes.has(country.code),
  }));
  const ciiRanking = buildCiiRankingEntries(countries, livePulse);
  const countryBounds = normalizeCountryBounds(countryBboxes, countries, reverseNames);
  const chokepoints = normalizeChokepoints(CHOKEPOINT_REGISTRY);
  const tradeRoutesById = new Map(
    (TRADE_ROUTES || []).map((route) => [route.id, {
      id: route.id,
      name: route.name,
      volumeDesc: route.volumeDesc,
      category: route.category,
    }]),
  );
  const glossaryTerms = normalizeGlossaryTerms(GLOSSARY_TERMS);
  const changelog = parseChangelog(readText(rootDir, CHANGELOG_PATH));
  // Family lastmods are change-dates, not build-dates (#7463). Do not fold
  // CORPUS_GENERATOR_CONTENT_VERSION into any family. All country pages include
  // the pulse date, while CII-targeted pages use a separate content clock.
  const countriesLastmod = laterDate(
    resilience.capturedAt,
    livePulse.capturedAt,
    gitFileLastmod(rootDir, COUNTRY_REGIONS_PATH),
    gitFileLastmod(rootDir, MICROSTATE_TERRITORIES_PATH),
    COUNTRY_PAGE_CONTENT_VERSION,
  );
  const ciiCountriesLastmod = laterDate(
    countriesLastmod,
    CII_COUNTRY_PAGE_CONTENT_VERSION,
  );
  const countriesIndexLastmod = laterDate(
    countriesLastmod,
    COUNTRIES_INDEX_CONTENT_VERSION,
  );
  const countryInstabilityIndexLastmod = laterDate(
    countriesLastmod,
    CII_RANKING_PAGE_CONTENT_VERSION,
  );
  const changelogLastmod = laterDate(
    gitFileLastmod(rootDir, CHANGELOG_PATH),
    latestDatedChangelogRelease(changelog),
  );
  const { capturedAt: chokepointCapturedAt, volumeObservedAt: chokepointVolumeObservedAt } =
    resolveChokepointObservation({
      registryGitLastmod: gitFileLastmod(rootDir, CHOKEPOINT_REGISTRY_PATH),
      tradeRoutesGitLastmod: gitFileLastmod(rootDir, TRADE_ROUTES_PATH),
    });
  const chokepointsLastmod = laterDate(
    ...CHOKEPOINT_PAGE_LASTMOD_PATHS.map((path) => gitFileLastmod(rootDir, path)),
    livePulse.capturedAt,
    CHOKEPOINT_PAGE_CONTENT_VERSION,
  );
  const toolsLastmod = laterDate(
    gitFileLastmod(rootDir, LIVE_TOOLS_SCRIPT_PATH),
    TOOLS_PAGE_CONTENT_VERSION,
  );
  const crisesLastmod = laterDate(
    gitFileLastmod(rootDir, CRISIS_REGISTRY_PATH),
    livePulse.capturedAt,
    CRISIS_PAGE_CONTENT_VERSION,
  );
  const researchLastmod = laterDate(
    ...researchReports.map(({ report }) => report.dateModified),
    RESEARCH_PAGE_CONTENT_VERSION,
  );
  const useCasesLastmod = laterDate(
    USE_CASES_CONTENT_VERSION,
    gitFileLastmod(rootDir, 'scripts/build-use-cases.mjs'),
  );
  const comparisonsLastmod = laterDate(
    COMPARISONS_CONTENT_VERSION,
    gitFileLastmod(rootDir, 'scripts/build-comparison-pages.mjs'),
  );
  const attributionManifest = readJson(rootDir, SOURCE_ATTRIBUTION_MANIFEST_PATH);
  // Production generators share the validated attribution predicate and stats.
  // Tests retain a separate raw-manifest oracle so a mutation here cannot make
  // both the expected and actual provider sets agree with the same bug.
  const sourceInventory = scanUpstreamHosts(rootDir);
  const sourceStats = sourceAttributionStats(sourceInventory, attributionManifest);
  const activeSourceEntries = activeSourceAttributionEntries(attributionManifest);
  const sourceCatalog = attachCoverageToCatalog(
    buildSourceCatalog(activeSourceEntries, {
      logicalProviders: attributionManifest.logicalProviders || [],
    }),
    scanNamedFeedDeclarations(rootDir),
    loadSourceGeography(rootDir),
  );
  if (sourceCatalog.length !== sourceStats.providerCount) {
    throw new Error('Source catalog provider count drifted from the attribution manifest');
  }
  const sourcesLastmod = sourcePageLastmod({
    manifestLastmod: gitFileLastmod(rootDir, SOURCE_ATTRIBUTION_MANIFEST_PATH),
    rendererLastmod: gitFileLastmod(rootDir, SOURCE_PAGE_RENDERER_PATH),
    originLastmod: gitFileLastmod(rootDir, SOURCE_ORIGIN_PATH),
    catalogInputLastmods: SOURCE_CATALOG_LASTMOD_PATHS.map((path) => gitFileLastmod(rootDir, path)),
    sharedTemplateLastmod: gitFileLastmod(rootDir, SHARED_PAGE_TEMPLATE_PATH),
  });

  return {
    generatorContentVersion: CORPUS_GENERATOR_CONTENT_VERSION,
    sources: {
      resilienceSnapshot: resilienceSnapshotPath,
      livePulseSnapshot: livePulseSnapshotPath,
      microstateTerritories: MICROSTATE_TERRITORIES_PATH,
      countryNames: COUNTRY_NAMES_PATH,
      countryRegions: COUNTRY_REGIONS_PATH,
      chokepointRegistry: CHOKEPOINT_REGISTRY_PATH,
      glossaryData: GLOSSARY_DATA_PATH,
      changelog: CHANGELOG_PATH,
      tradeRoutes: TRADE_ROUTES_PATH,
      liveToolsScript: LIVE_TOOLS_SCRIPT_PATH,
      countryBboxes: COUNTRY_BBOXES_PATH,
      crisisRegistry: CRISIS_REGISTRY_PATH,
      researchReports: RESEARCH_REPORTS_INDEX_PATH,
      useCases: 'scripts/build-use-cases.mjs',
      comparisons: 'scripts/build-comparison-pages.mjs',
      sourceAttributionManifest: SOURCE_ATTRIBUTION_MANIFEST_PATH,
      sourcePageRenderer: SOURCE_PAGE_RENDERER_PATH,
      sourceOrigin: SOURCE_ORIGIN_PATH,
      sourceCatalogInputs: [...SOURCE_CATALOG_LASTMOD_PATHS],
      sharedPageTemplate: SHARED_PAGE_TEMPLATE_PATH,
    },
    livePulse,
    lastmod: {
      countryInstabilityIndex: countryInstabilityIndexLastmod,
      countriesIndex: countriesIndexLastmod,
      countries: countriesLastmod,
      ciiCountries: ciiCountriesLastmod,
      changelog: changelogLastmod,
      chokepoints: chokepointsLastmod,
      tools: toolsLastmod,
      crises: crisesLastmod,
      research: researchLastmod,
      useCases: useCasesLastmod,
      comparisons: comparisonsLastmod,
      sources: sourcesLastmod,
    },
    sourceStats,
    sourceCatalog,
    resilience,
    ciiRanking,
    countries,
    countryBounds,
    countryBboxByCode,
    crises,
    chokepoints,
    chokepointObservation: {
      capturedAt: chokepointCapturedAt,
      volumeObservedAt: chokepointVolumeObservedAt,
    },
    tradeRoutesById,
    glossaryTerms,
    changelog,
    researchReports,
  };
}

function breadcrumbLd(baseUrl, items) {
  const currentPath = items[items.length - 1]?.path;
  return {
    '@context': SCHEMA_ORG_CONTEXT_URL,
    '@type': 'BreadcrumbList',
    ...(currentPath ? { '@id': `${absoluteUrl(baseUrl, currentPath)}#breadcrumb` } : {}),
    itemListElement: items.map((item, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      name: item.name,
      item: absoluteUrl(baseUrl, item.path),
    })),
  };
}

function faqPageLd(faqs) {
  return {
    '@context': SCHEMA_ORG_CONTEXT_URL,
    '@type': 'FAQPage',
    mainEntity: faqs.map((faq) => ({
      '@type': 'Question',
      name: faq.question,
      acceptedAnswer: { '@type': 'Answer', text: faq.answer },
    })),
  };
}

function jsonLdTypes(entry) {
  const type = entry?.['@type'];
  return Array.isArray(type) ? type : type ? [type] : [];
}

function withSpeakableAndGraph(entry, { canonical, breadcrumbId }) {
  if (!entry || typeof entry !== 'object') return entry;
  const types = jsonLdTypes(entry);
  if (!types.some((type) => PAGE_TYPES_WITH_SPEAKABLE.has(type))) return entry;
  const next = { ...entry };
  if (!next.speakable) next.speakable = { ...DEFAULT_SPEAKABLE };
  if (types.some((type) => PAGE_TYPES_WITH_WEBPAGE_ID.has(type))) {
    if (!next['@id']) next['@id'] = `${canonical}#webpage`;
    if (!next.isPartOf) next.isPartOf = { '@id': WEBSITE_ID };
    if (!next.breadcrumb && breadcrumbId) next.breadcrumb = { '@id': breadcrumbId };
    if (!next.publisher) next.publisher = { ...WORLD_MONITOR_ORG };
  }
  return next;
}

function imageObjectLd(baseUrl, ogImage, ogImageAlt) {
  return {
    '@type': 'ImageObject',
    contentUrl: absoluteUrl(baseUrl, ogImage),
    url: absoluteUrl(baseUrl, ogImage),
    width: 1200,
    height: 630,
    caption: ogImageAlt,
    name: ogImageAlt,
  };
}

const PAGE_TYPES_WITH_PRIMARY_IMAGE = new Set([
  'WebPage',
  'CollectionPage',
  'ItemPage',
]);

function withPrimaryImage(entry, image) {
  if (!entry || typeof entry !== 'object') return entry;
  const type = entry['@type'];
  const types = Array.isArray(type) ? type : [type];
  if (!types.some((value) => PAGE_TYPES_WITH_PRIMARY_IMAGE.has(value))) {
    return entry;
  }
  if (entry.primaryImageOfPage || entry.image) return entry;
  return {
    ...entry,
    primaryImageOfPage: image,
    image,
  };
}

// Every top-level JSON-LD block binds its own vocabulary. A root node without
// `@context` is not a lenient block — it has no vocabulary at all, so `@type`
// resolves to nothing and schema.org consumers discard it silently rather than
// erroring. Stamping here rather than at each call site is deliberate: #7491
// shipped 62 unparseable blocks across the 31 CII-covered country pages (found
// in #7502) because two hand-written sibling Datasets were promoted out of a
// `@context`'d parent and nobody re-declared it. A builder that forgets can no
// longer produce one.
// Nested nodes inherit the root context and are left untouched.
export function withSchemaContext(entry) {
  if (!entry || typeof entry !== 'object') return entry;
  // A deliberate `@context` is preserved; a missing OR empty one is replaced.
  // Destructure the dead key out rather than spreading `entry` over the stamp,
  // or `'@context': null` would be re-applied on top of it and the "cannot
  // forget" invariant above would hold only for the absent case.
  if (entry['@context']) return entry;
  const { '@context': unusable, ...rest } = entry;
  return { '@context': SCHEMA_ORG_CONTEXT_URL, ...rest };
}

function pageDocument({
  baseUrl,
  path,
  title,
  description,
  lastmod,
  paginationLinks = [],
  jsonLd,
  breadcrumbs,
  body,
  scriptSrcs = [],
  inlineScript = '',
  bodyClass = '',
  headerNav = '',
  footerBody = '',
  extraStyles = '',
  ogType = 'article',
  ogImage = OG_IMAGE_PATH,
  ogImageAlt = OG_IMAGE_ALT,
  robots = INDEXABLE_ROBOTS_CONTENT,
}) {
  const canonical = absoluteUrl(baseUrl, path);
  const pageImage = imageObjectLd(baseUrl, ogImage, ogImageAlt);
  // Allow a single JSON-LD object or an array of sibling graphs (e.g. WebPage
  // + FAQPage + ItemList for AI-extractable use-case workflows — #7381).
  // Attach ImageObject to page-shaped graphs so multimodal crawlers see a
  // primary image even when the HTML body is mostly text (#7382).
  const breadcrumbId = breadcrumbs?.['@id'] || null;
  const ld = [
    ...(Array.isArray(jsonLd) ? jsonLd : jsonLd ? [jsonLd] : []),
    breadcrumbs,
  ]
    .filter(Boolean)
    .map((entry) => withPrimaryImage(entry, pageImage))
    .map((entry) => withSpeakableAndGraph(entry, { canonical, breadcrumbId }))
    .map((entry) => withSchemaContext(entry));
  const renderedNav = headerNav || `        <a href="/">World Monitor</a>
        <a href="/sources/">Sources</a>
        <a href="/compare/">Compare</a>
        <a href="/countries/">Countries</a>
        <a href="/chokepoints/">Chokepoints</a>
        <a href="/crises/">Crises</a>
        <a href="/tools/">Live tools</a>
        <a href="/research/">Research</a>
        <a href="/use-cases/">Use cases</a>
        <a href="/reference/changelog/">Changelog</a>
        <a href="/blog/glossary/">Glossary</a>`;
  const renderedFooter = footerBody || 'World Monitor reference corpus. Crawlable pages use committed snapshots; live API results are labelled separately.';
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(title)}</title>
    <meta name="description" content="${escapeHtml(description)}">
    <meta name="robots" content="${escapeHtml(robots)}">
    <link rel="canonical" href="${escapeHtml(canonical)}">
    <link rel="alternate" hreflang="x-default" href="${escapeHtml(canonical)}">
    <link rel="alternate" hreflang="en" href="${escapeHtml(canonical)}">
    ${lastmod ? `<meta name="lastmod" content="${escapeHtml(lastmod)}">` : []}
    ${paginationLinks.map((link) => `<link rel="${escapeHtml(link.rel)}" href="${escapeHtml(absoluteUrl(baseUrl, link.path))}">`).join(String.fromCharCode(10) + "    ")}
    <meta property="og:type" content="${escapeHtml(ogType)}">
    <meta property="og:title" content="${escapeHtml(title)}">
    <meta property="og:description" content="${escapeHtml(description)}">
    <meta property="og:url" content="${escapeHtml(canonical)}">
    <meta property="og:site_name" content="World Monitor">
    <meta property="og:image" content="${escapeHtml(absoluteUrl(baseUrl, ogImage))}">
    <meta property="og:image:width" content="1200">
    <meta property="og:image:height" content="630">
    <meta property="og:image:alt" content="${escapeHtml(ogImageAlt)}">
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:title" content="${escapeHtml(title)}">
    <meta name="twitter:description" content="${escapeHtml(description)}">
    <meta name="twitter:image" content="${escapeHtml(absoluteUrl(baseUrl, ogImage))}">
    <meta name="twitter:image:alt" content="${escapeHtml(ogImageAlt)}">
    <meta name="twitter:site" content="@worldmonitorai">
    ${ld.map((entry) => `<script type="application/ld+json">${escapeJsonScript(entry)}</script>`).join('\n    ')}
    <style>
      :root { color-scheme: dark; --bg: #050807; --panel: #0c1210; --text: #eef8f0; --muted: #a8b8ad; --line: #1b2b22; --accent: #4ade80; }
      * { box-sizing: border-box; }
      body { margin: 0; background: var(--bg); color: var(--text); font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; line-height: 1.55; }
      a { color: var(--accent); text-decoration: none; }
      a:hover { text-decoration: underline; }
      header, main, footer { max-width: 960px; margin: 0 auto; padding: 0 20px; }
      header { padding-top: 24px; padding-bottom: 18px; border-bottom: 1px solid var(--line); }
      .brand-mark { margin: 0 0 14px; }
      .brand-mark img { display: block; width: 120px; height: 63px; border-radius: 6px; border: 1px solid var(--line); background: var(--panel); object-fit: cover; }
      nav { display: flex; gap: 4px 14px; flex-wrap: wrap; font-size: 14px; }
      nav a { display: inline-flex; align-items: center; min-height: 44px; }
      main { padding-top: 36px; padding-bottom: 52px; }
      h1 { font-size: clamp(32px, 5vw, 54px); line-height: 1; margin: 0 0 16px; letter-spacing: 0; }
      h2 { margin-top: 36px; font-size: 22px; }
      p { color: var(--muted); }
      .lede { font-size: 18px; max-width: 760px; }
      .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 14px; margin-top: 24px; }
      .card, .metric { border: 1px solid var(--line); border-radius: 8px; padding: 16px; background: var(--panel); }
      .metric strong { display: block; font-size: 28px; color: var(--text); }
      .metric small { display: block; color: var(--accent); font-size: 12px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; }
      .eyebrow { color: var(--accent); text-transform: uppercase; letter-spacing: 0.08em; font-size: 12px; font-weight: 700; }
      .cta { display: inline-flex; align-items: center; gap: 8px; margin-top: 22px; padding: 13px 18px; border-radius: 8px; background: var(--accent); color: #04170c; font-weight: 700; font-size: 15px; }
      .cta:hover { text-decoration: none; filter: brightness(1.08); }
      .live-tool { margin-top: 28px; padding: 20px; border: 1px solid #28543a; border-radius: 12px; background: linear-gradient(145deg, #0e1712, #09100c); }
      .live-tool h2 { margin: 3px 0 0; }
      .live-tool .grid { margin-top: 18px; }
      .tool-head, .tool-meta { display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
      .tool-note { max-width: 760px; margin-bottom: 0; }
      .tool-meta { margin-top: 16px; color: var(--muted); font-size: 13px; }
      .live-status { padding: 5px 9px; border: 1px solid var(--line); border-radius: 999px; color: var(--muted); font-size: 12px; font-weight: 700; }
      .live-tool[data-state="ready"] .live-status { border-color: #28543a; color: var(--accent); }
      .live-tool[data-state="partial"] .live-status { border-color: #7c6322; color: #fde68a; }
      .live-tool[data-state="error"] .live-status { border-color: #6f3b3b; color: #fca5a5; }
      .refresh { border: 1px solid var(--line); border-radius: 7px; padding: 12px 14px; background: #121d16; color: var(--text); cursor: pointer; font: inherit; }
      .refresh:hover:not(:disabled) { border-color: var(--accent); }
      .refresh:disabled { cursor: wait; opacity: 0.55; }
      .tool-controls { display: flex; align-items: end; gap: 12px; flex-wrap: wrap; margin-top: 18px; }
      .tool-controls label { display: grid; gap: 6px; color: var(--muted); font-size: 13px; }
      .tool-controls select { min-width: 240px; border: 1px solid var(--line); border-radius: 7px; padding: 12px 34px 12px 12px; background: #121d16; color: var(--text); font: inherit; }
      .result-list { list-style: none; padding: 0; margin: 16px 0 0; display: grid; gap: 8px; }
      .result-list li { border-left: 2px solid var(--line); padding: 8px 12px; color: var(--muted); font-size: 14px; }
      .split { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 14px; margin-top: 18px; }
      .split > section { border: 1px solid var(--line); border-radius: 8px; padding: 16px; background: var(--panel); }
      .split h3 { margin: 0; font-size: 18px; }
      .split .grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .split .metric strong { font-size: 22px; }
      .routes { list-style: none; padding: 0; margin: 20px 0 0; display: grid; gap: 8px; }
      .routes li { border: 1px solid var(--line); border-radius: 8px; padding: 11px 14px; background: var(--panel); color: var(--text); font-size: 14px; }
      .routes .vol { color: var(--muted); }
      .domains { grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); }
      .card.domain p { margin: 8px 0 12px; font-size: 14px; }
      .card.domain .providers { display: flex; flex-wrap: wrap; gap: 6px; }
      .card.domain .providers span { border: 1px solid var(--line); border-radius: 999px; padding: 3px 9px; color: var(--muted); font-size: 12px; }
      .card.domain:hover { border-color: var(--accent); text-decoration: none; }
      .related { list-style: none; padding: 0; margin: 12px 0 0; display: flex; flex-wrap: wrap; gap: 0 20px; }
      .related a { display: inline-flex; align-items: center; min-height: 44px; }
      .source { margin-top: 34px; font-size: 13px; color: var(--muted); }
      table { border-collapse: collapse; width: 100%; margin-top: 16px; font-size: 14px; }
      .table-scroll { max-width: 100%; overflow-x: auto; }
      .table-scroll table { min-width: 680px; }
      caption { caption-side: top; text-align: left; color: var(--muted); font-size: 13px; padding-bottom: 8px; }
      th, td { border: 1px solid var(--line); padding: 8px 12px; text-align: left; }
      th { color: var(--muted); font-weight: 600; background: var(--panel); }
      td data { color: var(--text); }
      figure { margin: 20px 0 0; padding: 16px; border: 1px solid var(--line); border-radius: 8px; background: var(--panel); }
      figcaption { margin-top: 10px; color: var(--muted); font-size: 13px; }
      blockquote { margin: 16px 0 0; padding: 12px 16px; border-left: 2px solid var(--accent); background: var(--panel); border-radius: 0 8px 8px 0; }
      blockquote p { margin: 0; color: var(--text); font-size: 14px; }
      footer { border-top: 1px solid var(--line); padding-top: 20px; padding-bottom: 28px; color: var(--muted); font-size: 13px; }
${extraStyles}
    </style>
  </head>
  <body${bodyClass ? ` class="${escapeHtml(bodyClass)}"` : ''}>
    <header>
      <p class="brand-mark">
        <img src="${escapeHtml(absoluteUrl(baseUrl, ogImage))}" alt="${escapeHtml(ogImageAlt)}" width="120" height="63" decoding="async" fetchpriority="low">
      </p>
      <nav aria-label="Primary">
${renderedNav}
      </nav>
    </header>
    <main>
${body}
    </main>
    <footer>${renderedFooter}</footer>
    ${scriptSrcs.map((src) => `<script type="module" nonce="wm-static-bootstrap" src="${escapeHtml(src)}"></script>`).join('\n    ')}
    ${inlineScript ? `<script nonce="wm-static-bootstrap">${inlineScript}</script>` : ''}
  </body>
</html>
`;
}

function ciiMovementProperties(change24h) {
  return change24h == null ? [] : [{
    '@type': 'PropertyValue',
    name: 'Approximate 24-hour movement',
    value: change24h,
    unitText: 'index points',
  }];
}

function renderCountryInstabilityIndexPage({
  ciiRanking,
  baseUrl,
  capturedAt,
  lastmod,
  snapshotPath,
}) {
  const path = '/country-instability-index/';
  const description = `See World Monitor's live Country Instability Index rankings, with current scores, available 24-hour movement, severity levels, and update times for ${ciiRanking.entries.length} Tier-1 countries.`;
  const datasetId = `${absoluteUrl(baseUrl, path)}#dataset`;
  const rankingId = `${absoluteUrl(baseUrl, path)}#ranking`;
  const versionLabel = `CII ${ciiRanking.methodologyVersion}`;
  const rankingFaq = {
    question: 'Which countries are most unstable right now?',
    answer: `As of ${formatStaticDateTime(ciiRanking.updatedAt)}, the highest Country Instability Index scores are ${formatProseList(ciiRanking.entries.slice(0, 3).map((entry) => entry.country.name))}. World Monitor derives this ranking from the committed ${versionLabel} pulse for ${ciiRanking.entries.length} monitored countries. The published table can refresh from the current API after the page loads.`,
  };
  const itemList = ciiRanking.entries.map((entry, index) => {
    const url = absoluteUrl(baseUrl, `/countries/${entry.country.slug}/`);
    return {
      '@type': 'ListItem',
      position: index + 1,
      name: entry.country.name,
      url,
      item: {
        '@type': 'Country',
        name: entry.country.name,
        url,
        additionalProperty: [
          { '@type': 'PropertyValue', name: 'Country Instability Index score', value: entry.score, minValue: 0, maxValue: 100 },
          ...ciiMovementProperties(entry.change24h),
          { '@type': 'PropertyValue', name: 'Instability level', value: entry.band },
        ],
      },
    };
  });
  const body = `      <p class="eyebrow">Current country stress</p>
      <h1>Country Instability Index</h1>
      <p class="lede">The World Monitor Country Instability Index (CII) measures current country-level stress on a 0-100 scale using conflict, unrest, security and information signals. ${escapeHtml(versionLabel)} currently monitors ${ciiRanking.entries.length} countries and reports approximate 24-hour movement when available.</p>
      <h2>${escapeHtml(rankingFaq.question)}</h2>
      <p>${escapeHtml(rankingFaq.answer)}</p>
      <section class="live-tool" data-live-cii-ranking data-cii-methodology-version="${escapeHtml(ciiRanking.methodologyVersion)}" data-state="ready" data-published-pulse>
        <div class="tool-head">
          <div>
            <p class="eyebrow">Live rankings</p>
            <h2>Current CII scores</h2>
          </div>
          <span class="live-status" data-live-status role="status" aria-live="polite">Published rankings</span>
        </div>
        <div class="table-scroll" data-live-grid aria-busy="false"><table data-cii-ranking>
          <caption>Published ${escapeHtml(formatStaticDateTime(ciiRanking.updatedAt))} from the committed crawlable pulse. The table refreshes from the current API after load.</caption>
          <thead><tr><th scope="col">Country</th><th scope="col">CII</th><th scope="col">24h</th><th scope="col">Level</th><th scope="col">Updated</th></tr></thead>
          <tbody data-cii-ranking-body>
${ciiRanking.entries.map((entry) => `            <tr data-cii-country="${escapeHtml(entry.code)}"><td><a href="/countries/${entry.country.slug}/">${escapeHtml(entry.country.name)}</a></td><td><data data-cii-score value="${escapeHtml(entry.score)}">${escapeHtml(formatScore(entry.score, OBSERVED_EVIDENCE))}</data></td><td data-cii-trend>${escapeHtml(entry.change24h == null ? 'Stable or unavailable' : entry.trend)}</td><td data-cii-band>${escapeHtml(entry.band)}</td><td><time data-cii-updated datetime="${escapeHtml(entry.asOf)}">${escapeHtml(formatStaticDateTime(entry.asOf))}</time></td></tr>`).join('\n')}
          </tbody>
        </table></div>
        <div class="tool-meta">
          <time data-cii-ranking-updated datetime="${escapeHtml(ciiRanking.updatedAt)}">Latest published score ${escapeHtml(formatStaticDateTime(ciiRanking.updatedAt))}</time>
          <button class="refresh" type="button" data-live-refresh disabled>Refresh live scores</button>
        </div>
        <noscript><p>The published rankings remain available without JavaScript. Enable JavaScript to request the current API result.</p></noscript>
      </section>
      <h2>What the CII measures</h2>
      <p>CII combines a 40% structural baseline with 60% live event pressure. The event score weights conflict at 30%, unrest at 25%, information at 25%, and security at 20%. It also applies bounded boosts and conflict or advisory floors. Read the <a href="/docs/methodology/cii-risk-scores">CII ${escapeHtml(ciiRanking.methodologyVersion)} methodology</a> before using a score in an analysis.</p>
      <p>CII measures short-term stress. The separate <a href="/countries/">Country Resilience Index</a> measures longer-term structural capacity across 196 countries. Do not combine the scores.</p>
      <a class="cta" href="${escapeHtml(withUtmSource(absoluteUrl(baseUrl, '/dashboard'), 'seo-cii'))}">Open the live CII panel in World Monitor →</a>
      <p class="source">Source: ${escapeHtml(snapshotPath)}. Published ${escapeHtml(prettyDate(capturedAt))}. Current results: <code>/api/intelligence/v1/get-risk-scores</code>.</p>`;
  return pageDocument({
    baseUrl,
    path,
    title: 'Country Instability Index: Live Rankings | World Monitor',
    description,
    lastmod,
    jsonLd: [
      {
        '@context': SCHEMA_ORG_CONTEXT_URL,
        '@type': 'CollectionPage',
        name: 'Country Instability Index',
        description,
        url: absoluteUrl(baseUrl, path),
        inLanguage: 'en-US',
        mainEntity: { '@id': datasetId },
      },
      faqPageLd([rankingFaq]),
      {
        '@context': SCHEMA_ORG_CONTEXT_URL,
        '@type': 'Dataset',
        '@id': datasetId,
        name: `World Monitor Country Instability Index (CII) ${ciiRanking.methodologyVersion}`,
        description: `Current 0-100 instability scores, available approximate 24-hour movement, and instability levels for ${ciiRanking.entries.length} monitored countries.`,
        url: absoluteUrl(baseUrl, path),
        identifier: `world-monitor-cii-${ciiRanking.methodologyVersion}`,
        keywords: ['country instability', 'country risk', 'instability index', 'geopolitical risk'],
        creator: { ...WORLD_MONITOR_ORG },
        license: DATASET_LICENSE,
        datePublished: capturedAt,
        dateModified: ciiRanking.updatedAt,
        temporalCoverage: datasetObservationCoverage(ciiRanking.entries.map((entry) => entry.asOf)),
        spatialCoverage: 'Worldwide',
        isAccessibleForFree: true,
        includedInDataCatalog: includedInDataCatalog(baseUrl),
        measurementTechnique: `World Monitor CII ${ciiRanking.methodologyVersion}`,
        variableMeasured: [
          { '@type': 'PropertyValue', name: 'Instability score', minValue: 0, maxValue: 100, unitText: 'index points' },
          { '@type': 'PropertyValue', name: 'Approximate 24-hour movement', unitText: 'index points' },
          { '@type': 'PropertyValue', name: 'Instability level' },
        ],
        distribution: [dataDownload(absoluteUrl(baseUrl, datasetDownloadHref(path, CII_INDEX_DATASET_DOWNLOAD)))],
        mainEntity: { '@id': rankingId },
      },
      {
        '@context': SCHEMA_ORG_CONTEXT_URL,
        '@type': 'ItemList',
        '@id': rankingId,
        name: 'Country Instability Index ranking',
        numberOfItems: ciiRanking.entries.length,
        itemListOrder: 'https://schema.org/ItemListOrderDescending',
        itemListElement: itemList,
      },
      dataCatalogLd(baseUrl),
    ],
    breadcrumbs: breadcrumbLd(baseUrl, [
      { name: 'Home', path: '/' },
      { name: 'Country Instability Index', path },
    ]),
    body,
    scriptSrcs: ['/tools/live-tools.js'],
  });
}

function renderCountriesIndex({ countries, ciiRanking, baseUrl, capturedAt, lastmod, snapshotPath }) {
  const path = '/countries/';
  const description = `Browse World Monitor country risk pages with structural resilience across ${countries.length} countries and high-frequency instability scores for ${ciiRanking.entries.length} Tier-1 countries.`;
  const datasetId = `${absoluteUrl(baseUrl, path)}#dataset`;
  const rankedCountries = countries
    .filter((country) => Number.isInteger(country.rank))
    .sort((a, b) => a.rank - b.rank);
  const topRankedNames = rankedCountries.slice(0, 3).map((country) => country.name);
  const rankingYear = capturedAt.slice(0, 4);
  const hubFaqs = [
    {
      question: `Which countries are most resilient in ${rankingYear}?`,
      answer: `The ${prettyDate(capturedAt)} Country Resilience Index snapshot ranks ${rankedCountries.length} of ${countries.length} countries. Its top three are ${topRankedNames.join(', ')}, with ${topRankedNames[0]} at rank 1. The index measures capacity to absorb shocks and recover; high scores reflect fiscal room, institutions, infrastructure, and supplies, while countries below the headline cutoff remain unranked instead of being guessed.`,
    },
    {
      question: 'How is the Country Resilience Index calculated?',
      answer:
        'Seventy-two published indicators are rescaled to 0-100, blended into 21 dimensions, grouped into six domains, then three pillars. Those pillars combine at 0.40/0.35/0.25, then a min-pillar penalty drags the total toward the weakest link. Coverage ships with every score; thin evidence is flagged low-confidence and held out of the ranking.',
    },
  ];
  const itemList = countries.map((country, index) => {
    const scorePublished = country.headlineEligible !== false;
    const url = absoluteUrl(baseUrl, `/countries/${country.slug}/`);
    return {
      '@type': 'ListItem',
      position: index + 1,
      name: country.name,
      url,
      item: {
        '@type': 'Country',
        name: country.name,
        url,
        ...(scorePublished
          ? {
            additionalProperty: {
              '@type': 'PropertyValue',
              name: 'Country Resilience Index score',
              value: country.overallScore,
              minValue: 0,
              maxValue: 100,
            },
          }
          : {}),
      },
    };
  });
  const body = `      <p class="eyebrow">Country corpus</p>
      <h1>Country risk, instability and resilience by country</h1>
      <p class="lede">${escapeHtml(description)}</p>
      <p><a href="/country-instability-index/">Live Country Instability Index rankings</a> · <a href="#country-resilience-ranking">Country Resilience Index ranking</a></p>
      <p>For the evergreen monitoring procedure that uses these pages as evidence, see <a href="/use-cases/monitor-country-risk/">Monitor country risk</a>.</p>
${hubFaqs.map((faq) => `      <h2>${escapeHtml(faq.question)}</h2>
      <p>${escapeHtml(faq.answer)}</p>`).join('\n')}
      <div class="table-scroll" id="country-resilience-ranking"><table data-country-ranking>
        <caption>${escapeHtml(prettyDate(capturedAt))} Country Resilience Index snapshot</caption>
        <thead><tr><th scope="col">Rank</th><th scope="col">Country</th><th scope="col">Score</th><th scope="col">Coverage</th><th scope="col">Confidence</th></tr></thead>
        <tbody>
${countries.map((country) => {
    const scorePublished = country.headlineEligible !== false;
    const scoreCell = scorePublished
      ? `<data value="${escapeHtml(country.overallScore)}">${escapeHtml(formatScore(country.overallScore, { coverage: scorePublished }))}</data>`
      : '—';
    return `          <tr><td>${country.rank == null ? 'Outside headline ranking' : `#${country.rank}`}</td><td><a href="/countries/${country.slug}/">${escapeHtml(country.name)}</a> <small>${escapeHtml(country.code)}</small></td><td>${scoreCell}</td><td>${escapeHtml(formatPercent(country.dimensionCoverage))}</td><td>${country.lowConfidence ? 'Low' : 'Standard'}</td></tr>`;
  }).join('\n')}
        </tbody>
      </table></div>
      <p class="source">Source: ${escapeHtml(snapshotPath)} (${escapeHtml(prettyDate(capturedAt))}). Methodology: <a href="/docs/methodology/country-resilience-index">Country Resilience Index</a>.</p>`;
  return pageDocument({
    baseUrl,
    path,
    title: 'Country Risk by Country: Instability & Resilience | World Monitor',
    description,
    lastmod,
    jsonLd: [
      {
        '@context': 'https://schema.org',
        '@type': 'CollectionPage',
        name: 'Country risk, instability and resilience by country',
        description,
        url: absoluteUrl(baseUrl, path),
        inLanguage: 'en-US',
        mainEntity: { '@id': datasetId },
      },
      faqPageLd(hubFaqs),
      {
        '@context': 'https://schema.org',
        '@type': 'ItemList',
        name: 'Country Resilience Index ranking',
        numberOfItems: countries.length,
        itemListOrder: 'https://schema.org/ItemListOrderAscending',
        itemListElement: itemList,
      },
      {
        '@context': 'https://schema.org',
        '@type': 'Dataset',
        '@id': datasetId,
        name: `World Monitor Country Resilience Index snapshot for ${capturedAt}`,
        description,
        url: absoluteUrl(baseUrl, path),
        identifier: 'country-resilience-ranking',
        keywords: ['country resilience', 'country risk', 'resilience index', 'global indicators'],
        creator: { ...WORLD_MONITOR_ORG },
        license: DATASET_LICENSE,
        datePublished: capturedAt,
        dateModified: capturedAt,
        temporalCoverage: datasetTemporalCoverage(capturedAt),
        spatialCoverage: 'Worldwide',
        isAccessibleForFree: true,
        includedInDataCatalog: includedInDataCatalog(baseUrl),
        variableMeasured: {
          '@type': 'PropertyValue',
          name: 'Country resilience score',
          minValue: 0,
          maxValue: 100,
          unitText: 'index points',
        },
        distribution: dataDownload(absoluteUrl(baseUrl, datasetDownloadHref(path, COUNTRIES_INDEX_DATASET_DOWNLOAD))),
      },
      dataCatalogLd(baseUrl),
    ],
    breadcrumbs: breadcrumbLd(baseUrl, [
      { name: 'Home', path: '/' },
      { name: 'Countries', path },
    ]),
    body,
  });
}

const PILLAR_LABELS = {
  'structural-readiness': 'Structural readiness',
  'live-shock-exposure': 'Live shock exposure',
  'recovery-capacity': 'Recovery capacity',
};

const DOMAIN_LABELS = {
  economic: 'Economic capacity',
  infrastructure: 'Infrastructure',
  energy: 'Energy security',
  'social-governance': 'Social and governance',
  'health-food': 'Health, food and water',
  recovery: 'Recovery capacity',
};

const DIMENSION_LABELS = {
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
};

const DIMENSION_PRIMARY_SOURCES = Object.freeze({
  macroFiscal: ['IMF'],
  currencyExternal: ['IMF', 'World Bank'],
  tradePolicy: ['WTO', 'World Bank'],
  financialSystemExposure: ['BIS', 'World Bank IDS', 'FATF'],
  cyberDigital: ['cyber and outage monitors'],
  logisticsSupply: ['World Bank'],
  infrastructure: ['World Bank'],
  energy: ['World Bank', 'IEA', 'OWID'],
  governanceInstitutional: ['World Bank WGI'],
  socialCohesion: ['IEP', 'UNHCR', 'UCDP'],
  borderSecurity: ['UCDP', 'UNHCR'],
  informationCognitive: ['Reporters Without Borders'],
  education: ['World Bank'],
  healthPublicService: ['WHO'],
  foodWater: ['FAO IPC', 'World Bank'],
  fiscalSpace: ['IMF'],
  liquidReserveAdequacy: ['World Bank'],
  externalDebtCoverage: ['World Bank'],
  importConcentration: ['UN Comtrade'],
  stateContinuity: ['World Bank WGI', 'UCDP', 'UNHCR'],
  sovereignFiscalBuffer: ['sovereign-wealth records'],
});

function humanizeId(value) {
  return String(value || '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/-/g, ' ')
    .replace(/^./, (letter) => letter.toUpperCase());
}

function formatProseList(items) {
  const values = [...new Set(items.map((item) => String(item || '').trim()).filter(Boolean))];
  if (values.length === 0) return '';
  if (values.length === 1) return values[0];
  if (values.length === 2) return `${values[0]} and ${values[1]}`;
  return `${values.slice(0, -1).join(', ')}, and ${values.at(-1)}`;
}

function dimensionLabel(dimension) {
  return DIMENSION_LABELS[dimension.id] || humanizeId(dimension.id);
}

function activeCountryDimensions(country) {
  return (country.domains || []).flatMap((domain) => (
    (domain.dimensions || [])
      .filter((dimension) => !RETIRED_DIMENSION_IDS.has(dimension.id))
      .map((dimension) => ({
        ...dimension,
        domainId: domain.id,
      }))
  ));
}

function isCoverageGap(dimension) {
  const imputationClass = String(dimension.imputationClass || '');
  if (imputationClass === 'not-applicable') return false;
  if (imputationClass === 'source-failure' || imputationClass === 'unmonitored') return true;
  return Number(dimension.coverage) === 0;
}

function compareDimensionsByCoverageAsc(left, right) {
  return Number(left.coverage) - Number(right.coverage) || left.id.localeCompare(right.id);
}

function compareDimensionsByCoverageDesc(left, right) {
  return Number(right.coverage) - Number(left.coverage) || left.id.localeCompare(right.id);
}

function dimensionSources(dimension) {
  return DIMENSION_PRIMARY_SOURCES[dimension.id] || [];
}

export function describeHeadlineIneligibilityReason(country) {
  const coverage = Number(country.dimensionCoverage);
  const imputation = Number(country.imputationShare);
  const coverageText = formatPercent(country.dimensionCoverage);
  const imputationText = formatPercent(country.imputationShare);
  if (country.lowConfidence) {
    const coverageMiss = Number.isFinite(coverage) && coverage < LOW_CONFIDENCE_MIN_COVERAGE;
    const imputationMiss = Number.isFinite(imputation) && imputation > LOW_CONFIDENCE_MAX_IMPUTATION;
    if (coverageMiss && imputationMiss) {
      return `${country.name}'s coverage is ${coverageText} and imputation share is ${imputationText}, so the snapshot is low-confidence.`;
    }
    if (coverageMiss) {
      return `${country.name}'s coverage is ${coverageText}, below the ${Math.round(LOW_CONFIDENCE_MIN_COVERAGE * 100)}% confidence gate and the ${Math.round(HEADLINE_RANKING_MIN_COVERAGE * 100)}% ranking floor.`;
    }
    if (imputationMiss) {
      return `${country.name}'s imputation share is ${imputationText}, above the ${Math.round(LOW_CONFIDENCE_MAX_IMPUTATION * 100)}% confidence limit.`;
    }
    return `${country.name}'s snapshot is flagged low-confidence, so no rank is published.`;
  }
  if (Number.isFinite(coverage) && coverage < HEADLINE_RANKING_MIN_COVERAGE) {
    return `${country.name}'s coverage is ${coverageText}, below the ${Math.round(HEADLINE_RANKING_MIN_COVERAGE * 100)}% ranking floor.`;
  }
  const strongest = activeCountryDimensions(country)
    .filter((dimension) => (
      Number(dimension.coverage) > 0
      && String(dimension.imputationClass || '') !== 'not-applicable'
    ))
    .sort(compareDimensionsByCoverageDesc)
    .slice(0, 3)
    .map((dimension) => `${dimensionLabel(dimension)} at ${formatPercent(dimension.coverage)}`);
  const strongestClause = strongest.length > 0
    ? ` Strongest observed coverage is ${formatProseList(strongest)}.`
    : '';
  return `${country.name}'s coverage is ${coverageText}, which meets the ${Math.round(HEADLINE_RANKING_MIN_COVERAGE * 100)}% floor, but a published rank also needs a recorded population of at least ${HEADLINE_RANKING_MIN_POPULATION.toLocaleString('en-US')} or coverage of at least ${Math.round(HEADLINE_RANKING_HIGH_COVERAGE * 100)}%.${strongestClause}`;
}

export function describeHeadlineIneligibility(country) {
  return `World Monitor does not publish a resilience score or rank for ${country.name} because it does not meet the published ranking eligibility criteria.`;
}

export function describeCoverageGaps(country) {
  const dimensions = activeCountryDimensions(country);
  const gaps = dimensions.filter(isCoverageGap).sort(compareDimensionsByCoverageAsc);
  if (gaps.length === 0) {
    const strongest = dimensions
      .filter((dimension) => Number(dimension.coverage) > 0)
      .sort(compareDimensionsByCoverageDesc)
      .slice(0, 3)
      .map((dimension) => `${dimensionLabel(dimension)} at ${formatPercent(dimension.coverage)}`);
    const strongestClause = strongest.length > 0
      ? `, including ${formatProseList(strongest)}`
      : '';
    return `The active dimensions are mostly observed${strongestClause}. The unpublished rank is an eligibility-rule outcome, not a hole in the source inventory.`;
  }
  const labels = formatProseList(gaps.map(dimensionLabel));
  const uniqueSources = [...new Set(gaps.flatMap(dimensionSources))];
  const verb = gaps.length === 1 ? 'has' : 'have';
  const sourceClause = uniqueSources.length > 0
    ? ` Those slots depend on ${formatProseList(uniqueSources)}, which ${uniqueSources.length === 1 ? 'does' : 'do'} not contribute observed series for those dimensions.`
    : '';
  const failures = gaps.filter((dimension) => dimension.imputationClass === 'source-failure');
  const unmonitored = gaps.filter((dimension) => dimension.imputationClass === 'unmonitored');
  const failureClause = failures.length > 0
    ? ` ${formatProseList(failures.map(dimensionLabel))} ${failures.length === 1 ? 'is' : 'are'} marked source unavailable in this snapshot.`
    : '';
  const unmonitoredClause = unmonitored.length > 0
    ? ` ${formatProseList(unmonitored.map(dimensionLabel))} ${unmonitored.length === 1 ? 'is' : 'are'} tagged unmonitored because the source does not cover ${country.name}.`
    : '';
  return `${labels} ${verb} no usable observed series.${sourceClause}${failureClause}${unmonitoredClause}`;
}

function observedEvidenceDimensions(country) {
  return activeCountryDimensions(country).filter((dimension) => (
    !isCoverageGap(dimension)
    && Number(dimension.coverage) >= SUPPORTED_READING_MIN_COVERAGE
  ));
}

export function describeAvailableEvidence(country) {
  const observed = observedEvidenceDimensions(country)
    .sort(compareDimensionsByCoverageDesc)
    .slice(0, AVAILABLE_EVIDENCE_LIMIT);
  if (observed.length === 0) {
    return `The snapshot still records coverage and evidence state for ${country.name}, even though no dimension clears a usable observed threshold. Input coverage is ${formatPercent(country.dimensionCoverage)} and imputation share is ${formatPercent(country.imputationShare)}.`;
  }
  return `Observed evidence is present for ${formatProseList(observed.map((dimension) => `${dimensionLabel(dimension)} (${formatPercent(dimension.coverage)})`))}. Input coverage is ${formatPercent(country.dimensionCoverage)} and imputation share is ${formatPercent(country.imputationShare)}.`;
}

function buildMicrostateEvidenceProfile(country) {
  const dimensions = activeCountryDimensions(country);
  const supportedDimensions = dimensions
    .filter((dimension) => (
      !isCoverageGap(dimension)
      && String(dimension.imputationClass || '') === ''
      && Number(dimension.coverage) >= SUPPORTED_READING_MIN_COVERAGE
      && typeof dimension.score === 'number'
      && Number.isFinite(dimension.score)
    ));
  const gaps = dimensions.filter(isCoverageGap).sort(compareDimensionsByCoverageAsc);
  const supportedSourceFamilies = [...new Set(supportedDimensions.flatMap(dimensionSources))];
  const gapSourceFamilies = [...new Set(gaps.flatMap(dimensionSources))];
  return {
    supportedDimensions,
    supportedSourceFamilies,
    gapOnlySourceFamilies: gapSourceFamilies.filter((source) => !supportedSourceFamilies.includes(source)),
    overlappingSourceFamilies: gapSourceFamilies.filter((source) => supportedSourceFamilies.includes(source)),
  };
}

function formatMicrostateReadings(profile) {
  return profile.supportedDimensions
    .map((dimension) => `${dimensionLabel(dimension)} ${formatScore(dimension.score, dimensionScoreEvidence(dimension))} (${formatPercent(dimension.coverage)})`);
}

function highlightMicrostateDimensions(profile) {
  return profile.supportedDimensions
    .slice(-3)
    .map(dimensionLabel);
}

function selectMicrostateSourceExamples(sources) {
  const preferred = ['World Bank', 'UCDP'].filter((source) => sources.includes(source));
  return [...new Set([
    ...sources.slice(0, 3),
    ...preferred,
    sources.at(-1),
  ])].filter(Boolean).slice(0, 6);
}

export function describeMicrostateEvidence(country) {
  if (country.microstateTerritory !== true) return '';
  const profile = buildMicrostateEvidenceProfile(country);
  if (profile.supportedDimensions.length === 0) {
    return `${country.name} is in the microstate and territory cohort, but this snapshot has no observed dimension reading that can support a country-specific evidence interpretation. No overall resilience score or country rank is published.`;
  }
  const readings = formatMicrostateReadings(profile);
  const readingClause = `${country.name} has ${readings.length} supported dimension readings with observed inputs: ${readings.join('; ')}. Scores use a 0-100 scale; percentages show coverage.`;
  const sourceExamples = selectMicrostateSourceExamples(profile.supportedSourceFamilies);
  const supportedSourceClause = sourceExamples.length > 0
    ? ` Possible dimension inputs for ${country.name}: ${formatProseList(sourceExamples)}.`
    : '';
  const gapOnlyClause = profile.gapOnlySourceFamilies.length > 0
    ? ` Inputs tied only to missing or unmonitored dimensions in ${country.name}: ${formatProseList(profile.gapOnlySourceFamilies)}.`
    : '';
  const overlapClause = profile.overlappingSourceFamilies.length > 0
    ? ` For ${country.name}, some feed families span supported and missing dimensions: ${formatProseList(profile.overlappingSourceFamilies)}.`
    : '';
  return `This is a partial evidence snapshot. ${readingClause}${supportedSourceClause}${gapOnlyClause}${overlapClause} These readings are partial evidence, not a published overall score or a country rank.`;
}

export function describeMicrostateEvidenceSummary(country) {
  const profile = buildMicrostateEvidenceProfile(country);
  if (profile.supportedDimensions.length === 0) {
    return `${country.name} has no observed dimension reading that can support a country-specific evidence interpretation. No overall resilience score or country rank is published.`;
  }
  const highlightedDimensions = highlightMicrostateDimensions(profile);
  const sourceExamples = profile.supportedSourceFamilies.slice(-3);
  const feedClause = sourceExamples.length > 0
    ? ` Possible inputs for ${country.name} include ${formatProseList(sourceExamples)}.`
    : '';
  return `${country.name} has ${profile.supportedDimensions.length} supported dimension readings with observed inputs, including ${formatProseList(highlightedDimensions)}.${feedClause} These readings are partial evidence, not a published overall score or a country rank.`;
}

function microstateCoverageStoryFacts(country) {
  const profile = buildMicrostateEvidenceProfile(country);
  const coveragePercent = Math.round(Number(country.dimensionCoverage) * 100);
  const coverageFloor = Math.round(HEADLINE_RANKING_MIN_COVERAGE * 100);
  const readings = formatMicrostateReadings(profile);
  const highlightedDimensions = highlightMicrostateDimensions(profile);
  const shortfallPoints = coverageFloor - coveragePercent;
  const gaps = activeCountryDimensions(country)
    .filter(isCoverageGap)
    .map((dimension) => ({
      id: dimension.id,
      imputationClass: String(dimension.imputationClass || ''),
      sources: dimensionSources(dimension),
    }));
  return {
    code: country.code,
    coverage: formatPercent(country.dimensionCoverage),
    coverageFloor,
    coveragePercent,
    crisisRegistrySize: country.crisisRegistrySize,
    gapCount: gaps.length,
    gaps,
    imputationShare: formatPercent(country.imputationShare),
    readingCount: readings.length,
    readings: readings.join('; '),
    highlightedDimensions: formatProseList(highlightedDimensions),
    sourceExamples: formatProseList(selectMicrostateSourceExamples(profile.supportedSourceFamilies)),
    supportedDimensionIds: profile.supportedDimensions.map((dimension) => dimension.id),
    shortfall: `${shortfallPoints} ${shortfallPoints === 1 ? 'point' : 'points'}`,
  };
}

export function buildMicrostateCoverageStory({
  country,
  capturedAt,
  methodologyFormula,
}) {
  if (country.microstateTerritory !== true) return null;
  const story = buildMicrostateCoverageStoryContent({
    ...microstateCoverageStoryFacts(country),
    capturedDate: prettyDate(capturedAt),
    methodologyFormula,
  });
  if (!story) return null;
  return {
    ...story,
    crisis: formatCrisisContext(country, { noMembershipText: story.crisis }),
  };
}

export function dimensionInventoryNote(country, dimension) {
  const sources = dimensionSources(dimension);
  const sourceLabel = formatProseList(sources);
  const imputationClass = String(dimension.imputationClass || '');
  if (imputationClass === 'not-applicable') return 'not applicable';
  if (imputationClass === 'stable-absence') return 'stable absence in the source feed';
  if (imputationClass === 'source-failure') {
    return sourceLabel
      ? `${sourceLabel} did not deliver a usable series in this snapshot`
      : 'source unavailable in this snapshot';
  }
  if (imputationClass === 'unmonitored' || Number(dimension.coverage) === 0) {
    return sourceLabel
      ? `${sourceLabel} ${sources.length === 1 ? 'does' : 'do'} not contribute observed series for ${country.name}`
      : `no observed series for ${country.name}`;
  }
  return 'observed';
}

// Dimensions the page can call supported readings. The microstate branch
// enumerates this set exhaustively and counts it out loud; the generic branch
// prints only the strongest AVAILABLE_EVIDENCE_LIMIT of it and makes no claim to
// be complete, so the display cap is not part of the set either way.
function supportedReadingDimensions(country) {
  return country.microstateTerritory === true
    ? buildMicrostateEvidenceProfile(country).supportedDimensions
    : observedEvidenceDimensions(country);
}

function buildCountryUnrankedInventory(country) {
  const supported = new Set(supportedReadingDimensions(country).map((dimension) => dimension.id));
  const dimensions = activeCountryDimensions(country).map((dimension) => ({
    id: dimension.id,
    label: dimensionLabel(dimension),
    coverage: dimension.coverage,
    isCoverageGap: isCoverageGap(dimension),
    isNotApplicable: String(dimension.imputationClass || '') === 'not-applicable',
    inventoryNote: dimensionInventoryNote(country, dimension),
    supported: supported.has(dimension.id),
    value: dimension,
  }));
  return buildUnrankedCountryInventory({
    countryCode: country.code,
    dimensions,
    inventoryLimit: UNRANKED_INVENTORY_LIMIT,
    supportFloor: SUPPORTED_READING_MIN_COVERAGE,
  });
}

export function describeInventoryScope(country) {
  return buildCountryUnrankedInventory(country).inventoryScope;
}

export function describeSupportThreshold(country) {
  return buildCountryUnrankedInventory(country).supportThreshold;
}

export function assertUnrankedInventoryIntegrity(country, rendered = {}) {
  buildCountryUnrankedInventory(country).assertIntegrity(rendered);
}

function formatSignedScore(value, evidence) {
  return formatObservedNumber(value, evidence, (numeric) => (
    `${numeric > 0 ? '+' : ''}${formatScoreNumber(numeric)}`
  ), 'not available');
}

function countryFaqs(country, capturedAt, rankedCount, ciiEntry = null) {
  const ciiFaq = ciiEntry
    ? [{
      question: `What is ${country.name}'s Country Instability Index?`,
      answer: `${country.name}'s Country Instability Index is ${formatScore(ciiEntry.score, OBSERVED_EVIDENCE)}/100 (${ciiEntry.band}), ${ciiEntry.movementText}, as of ${formatStaticDateTime(ciiEntry.asOf)}.`,
    }]
    : [];
  const scorePublished = country.headlineEligible !== false;
  if (!scorePublished) {
    return [
      ...ciiFaq,
      {
        question: `What is ${country.name}'s resilience score?`,
        answer: `No resilience score or rank is published for ${country.name}. ${country.name}'s published rank would require coverage of at least ${Math.round(HEADLINE_RANKING_MIN_COVERAGE * 100)}%, no low-confidence flag, and either a population of at least ${HEADLINE_RANKING_MIN_POPULATION.toLocaleString('en-US')} or coverage of at least ${Math.round(HEADLINE_RANKING_HIGH_COVERAGE * 100)}%. Low confidence for ${country.name} means coverage falls below ${Math.round(LOW_CONFIDENCE_MIN_COVERAGE * 100)}% or imputation share exceeds ${Math.round(LOW_CONFIDENCE_MAX_IMPUTATION * 100)}%.`,
      },
      {
        question: `What evidence is available for ${country.name}?`,
        answer: describeCountryAvailableEvidenceFaq(country),
      },
      {
        question: `How should readers use ${country.name}'s page?`,
        answer: `Use the evidence inventory and nearest ranked comparators with the live monitor. A missing score does not mean risk is absent.`,
      },
    ];
  }
  const pillars = observedPillarsOf([...country.pillars].sort((left, right) => left.score - right.score));
  const weakest = pillars[0];
  const second = pillars[1];
  const weakestPillarsAnswer = weakest && second
    ? `${PILLAR_LABELS[weakest.id] || humanizeId(weakest.id)} is lowest at ${formatScore(weakest.score, { coverage: weakest.coverage })}, followed by ${PILLAR_LABELS[second.id] || humanizeId(second.id)} at ${formatScore(second.score, { coverage: second.coverage })}. Their evidence coverage is ${formatPercent(weakest.coverage)} and ${formatPercent(second.coverage)}.`
    : weakest
      ? `${PILLAR_LABELS[weakest.id] || humanizeId(weakest.id)} is the only pillar with an observed reading, at ${formatScore(weakest.score, { coverage: weakest.coverage })} with ${formatPercent(weakest.coverage)} evidence coverage. The other pillars are withheld because this snapshot has no observed evidence for them.`
      : `No pillar has an observed reading in this snapshot, so no pillar can be ranked weakest.`;
  const rankText = country.rank == null
    ? 'outside the headline ranking because the snapshot labels its evidence low-confidence'
    : `#${country.rank} of ${rankedCount} ranked countries`;
  return [
    ...ciiFaq,
    {
      question: `What is ${country.name}'s resilience score?`,
      answer: `${country.name} scores ${formatScore(country.overallScore, { coverage: scorePublished })} out of 100 in the ${prettyDate(capturedAt)} structural snapshot and sits ${rankText}. This is a comparative index, not a crisis probability.`,
    },
    {
      question: `Which resilience pillars are weakest for ${country.name}?`,
      answer: weakestPillarsAnswer,
    },
    {
      question: `Is ${country.name}'s resilience score rising or falling?`,
      answer: `The 30-day reading is ${country.trend || 'unknown'}, with a change of ${formatSignedScore(country.change30d, { coverage: scorePublished })} points. It is structural and separate from the live instability monitor.`,
    },
  ];
}

function describeCountryAvailableEvidence(country) {
  return country.microstateTerritory === true
    ? describeMicrostateEvidence(country)
    : describeAvailableEvidence(country);
}

function describeCountryAvailableEvidenceFaq(country) {
  return country.microstateTerritory === true
    ? describeMicrostateEvidenceSummary(country)
    : describeAvailableEvidence(country);
}

function formatCrisisContext(country, { links = false, noMembershipText = null } = {}) {
  const countryName = links ? escapeHtml(country.name) : country.name;
  if (country.crisisMemberships.length > 0) {
    const memberships = country.crisisMemberships
      .map((crisis) => links
        ? `<a href="/crises/${escapeHtml(crisis.slug)}/">${escapeHtml(crisis.shortTitle)}</a>`
        : crisis.shortTitle)
      .join(', ');
    return `The crisis registry links ${countryName} to ${memberships}. Tracker scopes are fixed and do not cover every crisis.`;
  }
  if (noMembershipText != null) return links ? escapeHtml(noMembershipText) : noMembershipText;
  return `${countryName} is outside the fixed coverage of the ${country.crisisRegistrySize} crawlable crisis trackers. This marks a registry boundary, not an absence of risk.`;
}

export function renderCountryAnalysis({ country, capturedAt, methodologyFormula, rankedCount, ciiEntry = null }) {
  const scorePublished = country.headlineEligible !== false;
  if ((country.pillars?.length ?? 0) < 3 || (country.domains?.length ?? 0) < 6) {
    throw new Error(`${country.code} is missing country-analysis pillar or domain details`);
  }
  // A peer whose own page publishes no headline score gets no parenthetical at all.
  // Rendering an empty "(—)" would advertise a withheld value instead of omitting it.
  const peerLink = (peer) => {
    const score = scorePublished
      ? formatScore(peer.overallScore, { coverage: peer.headlineEligible !== false })
      : '—';
    const suffix = score === '—' ? '' : ` (${escapeHtml(score)})`;
    return `<a href="/countries/${peer.slug}/">${escapeHtml(peer.name)}${suffix}</a>`;
  };
  const peerLinks = country.peers.map(peerLink).join(', ');
  const regionalLinks = country.regionalPeers.map(peerLink).join(', ');
  const coverageStory = !scorePublished
    ? buildMicrostateCoverageStory({ country, capturedAt, methodologyFormula })
    : null;
  const crisisText = formatCrisisContext(country, {
    links: true,
    noMembershipText: coverageStory?.crisis ?? null,
  });
  const faqs = coverageStory?.faqs || countryFaqs(country, capturedAt, rankedCount, ciiEntry);
  if (!scorePublished) {
    const unrankedInventory = buildCountryUnrankedInventory(country);
    const inventory = unrankedInventory.shown;
    const inventoryItems = inventory.length > 0
      ? inventory.map((dimension) => `          <li><strong>${escapeHtml(dimensionLabel(dimension))}</strong>: ${escapeHtml(formatPercent(dimension.coverage))} coverage; ${escapeHtml(dimensionInventoryNote(country, dimension))}.</li>`).join('\n')
      : `          <li>${escapeHtml(country.name)} has no active dimension inventory after retired slots are removed.</li>`;
    const { inventoryScope, supportThreshold } = unrankedInventory;
    unrankedInventory.assertIntegrity({ inventoryScope, supportThreshold });
    const inventoryPreamble = [
      inventoryScope
        ? `        <p class="source" data-inventory-scope>${escapeHtml(inventoryScope)}</p>\n`
        : '',
      supportThreshold
        ? `        <p class="source" data-inventory-support-threshold>${escapeHtml(supportThreshold)}</p>\n`
        : '',
    ].join('');
    if (coverageStory) {
      const comparatorLinks = coverageStory.useRegionalComparators ? regionalLinks : peerLinks;
      const html = `      <article data-country-analysis>
        <h2>${escapeHtml(country.name)} resilience evidence</h2>
        <p>${escapeHtml(coverageStory.introduction)}</p>
        <section data-country-coverage-story>
          <h3>Source inventory gaps</h3>
          <p>${escapeHtml(coverageStory.gap)}</p>
        </section>
        <h3>What the snapshot does cover</h3>
        <p>${escapeHtml(coverageStory.evidence)}</p>
        <h3>Dimension evidence inventory</h3>
${inventoryPreamble}        <ul class="routes">
${inventoryItems}
        </ul>
        <h3>Nearest ranked comparators</h3>
        <p>${escapeHtml(coverageStory.comparatorLead)} Nearest ranked comparators: ${comparatorLinks}. ${escapeHtml(coverageStory.comparatorTail)}</p>
        <h3>Tracked crisis context</h3>
        <p>${crisisText}</p>
        <h3>Reading limits</h3>
        <p>${escapeHtml(coverageStory.limits)}</p>
        <h3>Questions about ${escapeHtml(country.name)}</h3>
${faqs.map((faq) => `        <details data-country-faq><summary>${escapeHtml(faq.question)}</summary><p>${escapeHtml(faq.answer)}</p></details>`).join('\n')}
      </article>`;
      // readingGuide and suppressScoreDisclosure make renderCountryPage swap the
      // shared "How to read this page" block, its snapshot note and the
      // score-disclosure paragraph for the country-specific reading guide (#7527).
      return {
        html,
        faqs,
        readingGuide: coverageStory.readingGuide,
        suppressScoreDisclosure: true,
      };
    }
    const officialName = country.identity?.officialName;
    const officialBit = officialName && officialName !== country.name
      ? ` Officially ${officialName}.`
      : '';
    const status = getSovereignStatus(country.code);
    // The internal sar bucket also includes Taiwan; describe membership only.
    const statusBit = status === 'sar'
      ? ` ${country.name} is included separately in the rankable universe.`
      : status === 'un-member'
        ? ` ${country.name} is in the rankable universe as a UN member.`
        : '';
    const availableEvidence = describeCountryAvailableEvidence(country);
    const html = `      <article data-country-analysis>
        <h2>${escapeHtml(country.name)} resilience analysis</h2>
        <p>${escapeHtml(describeHeadlineIneligibility(country))}${escapeHtml(officialBit)}${escapeHtml(statusBit)} Ranked comparisons use ${escapeHtml(country.regionName)} peers rather than other unpublished pages. The snapshot records ${escapeHtml(country.name)} as ${escapeHtml(country.code)}.</p>
        <h3>Why ${escapeHtml(country.name)} is unpublished</h3>
        <p>${escapeHtml(describeHeadlineIneligibilityReason(country))}</p>
        <h3>Source inventory gaps</h3>
        <p>${escapeHtml(describeCoverageGaps(country))}</p>
        <h3>What the snapshot does cover</h3>
        <p>${escapeHtml(availableEvidence)}</p>
        <h3>Dimension evidence inventory</h3>
${inventoryPreamble}        <ul class="routes">
${inventoryItems}
        </ul>
        <h3>Nearest ranked comparators</h3>
        <p>Nearest ranked comparators: ${peerLinks}. Ranked comparisons in ${escapeHtml(country.regionName)}: ${regionalLinks}. Links do not use unpublished scores.</p>
        <h3>Tracked crisis context</h3>
        <p>${crisisText}</p>
        <h3>Reading limits</h3>
        <p>${escapeHtml(prettyDate(capturedAt))}; method ${escapeHtml(methodologyFormula)}. ${escapeHtml(country.name)} coverage is ${escapeHtml(formatPercent(country.dimensionCoverage))} with imputation share ${escapeHtml(formatPercent(country.imputationShare))}. No score is published.</p>
        <h3>Questions about ${escapeHtml(country.name)}</h3>
${faqs.map((faq) => `        <details data-country-faq><summary>${escapeHtml(faq.question)}</summary><p>${escapeHtml(faq.answer)}</p></details>`).join('\n')}
      </article>`;
    return { html, faqs };
  }
  const pillars = [...country.pillars].sort((left, right) => left.score - right.score);
  const domains = [...country.domains].sort((left, right) => left.score - right.score);
  const observedPillars = observedPillarsOf(pillars);
  const observedDomains = observedDomainsOf(domains);
  const [weakestPillar, secondPillar] = pillars;
  const strongestPillar = pillars.at(-1);
  const [weakestDomain] = domains;
  const trendSentence = hasObservedValue(country.change30d, { coverage: scorePublished })
    ? `Across the recorded 30-day window, the index is ${country.trend} at ${formatSignedScore(country.change30d, { coverage: scorePublished })} points.`
    : 'The committed snapshot does not contain a comparable 30-day change.';
  const weakestPillarLabel = PILLAR_LABELS[weakestPillar.id] || humanizeId(weakestPillar.id);
  const secondPillarLabel = PILLAR_LABELS[secondPillar.id] || humanizeId(secondPillar.id);
  const strongestPillarLabel = PILLAR_LABELS[strongestPillar.id] || humanizeId(strongestPillar.id);
  const weakestDomainLabel = DOMAIN_LABELS[weakestDomain.id] || humanizeId(weakestDomain.id);
  // Every pillar and domain observed is the normal case and keeps the published
  // wording exactly. Otherwise the claim is rebuilt from observed entries only,
  // so prose never names a withheld pillar or domain as weakest or strongest.
  const pillarDomainClause = observedPillars.length === pillars.length
    && observedDomains.length === domains.length
    ? `${weakestPillarLabel} is the weakest pillar at ${formatScore(weakestPillar.score, { coverage: weakestPillar.coverage })}, with ${secondPillarLabel.toLowerCase()} next at ${formatScore(secondPillar.score, { coverage: secondPillar.coverage })}. ${strongestPillarLabel} is strongest at ${formatScore(strongestPillar.score, { coverage: strongestPillar.coverage })}, while ${weakestDomainLabel} is the lowest of the six underlying domains at ${formatScore(weakestDomain.score, domainScoreEvidence(weakestDomain))}.`
    : [
      observedPillars.length > 0
        ? `Pillars with an observed reading, weakest first: ${observedPillars.map((pillar) => `${PILLAR_LABELS[pillar.id] || humanizeId(pillar.id)} ${formatScore(pillar.score, { coverage: pillar.coverage })}`).join('; ')}. ${pillars.length - observedPillars.length} of ${pillars.length} pillars are withheld for lack of observed evidence.`
        : `No pillar has an observed reading in this snapshot.`,
      observedDomains.length > 0
        ? `${DOMAIN_LABELS[observedDomains[0].id] || humanizeId(observedDomains[0].id)} is the lowest of the ${observedDomains.length} domains with an observed reading, at ${formatScore(observedDomains[0].score, domainScoreEvidence(observedDomains[0]))}.`
        : `No domain has an observed reading in this snapshot.`,
    ].join(' ');
  const topObservedDomain = observedDomains.at(-1);
  const topDomainSentence = topObservedDomain
    ? `Top domain: ${DOMAIN_LABELS[topObservedDomain.id] || humanizeId(topObservedDomain.id)}, ${formatScore(topObservedDomain.score, domainScoreEvidence(topObservedDomain))}.`
    : 'No domain has an observed reading to report as the top domain.';
  const summary = `${country.name} ranks #${country.rank} of ${rankedCount} countries with an overall resilience score of ${formatScore(country.overallScore, { coverage: scorePublished })} out of 100. ${pillarDomainClause} ${trendSentence} Dimension coverage is ${formatPercent(country.dimensionCoverage)}, and the page labels confidence as ${country.lowConfidence ? 'low' : 'standard'}.`;
  const allDimensionRows = domains.flatMap((domain) => domain.dimensions.map((dimension) => ({
    ...dimension,
    domainId: domain.id,
  })));
  const observedDimensionRows = allDimensionRows
    .filter(hasObservedDimensionScore)
    .sort((left, right) => left.score - right.score || left.id.localeCompare(right.id));
  const withheldDimensionRows = allDimensionRows
    .filter((dimension) => !hasObservedDimensionScore(dimension))
    .sort((left, right) => left.domainId.localeCompare(right.domainId) || left.id.localeCompare(right.id));
  const dimensionRows = [...observedDimensionRows, ...withheldDimensionRows];
  const html = `      <article data-country-analysis>
        <h2>${escapeHtml(country.name)} resilience analysis</h2>
        <p>${escapeHtml(summary)}</p>
        <h3>Pillar profile</h3>
        <ul class="routes">
${pillars.map((pillar) => `          <li><strong>${escapeHtml(PILLAR_LABELS[pillar.id] || humanizeId(pillar.id))}: ${escapeHtml(formatScore(pillar.score, { coverage: pillar.coverage }))}</strong>; coverage ${escapeHtml(formatPercent(pillar.coverage))}; domains ${pillar.domainIds.map((id) => escapeHtml(DOMAIN_LABELS[id] || humanizeId(id))).join(', ')}.</li>`).join('\n')}
        </ul>
        <h3>Six-domain profile</h3>
        <ul class="routes">
${domains.map((domain) => {
    const dimensions = domain.dimensions
      .filter(hasObservedDimensionScore)
      .sort((left, right) => left.score - right.score);
    const weakest = dimensions[0];
    const strongest = dimensions.at(-1);
    const dimensionSummary = dimensions.length === 0
      ? 'no observed dimension score'
      : dimensions.length === 1
        ? `${DIMENSION_LABELS[weakest.id] || humanizeId(weakest.id)} ${formatScore(weakest.score, dimensionScoreEvidence(weakest))}`
        : `low ${DIMENSION_LABELS[weakest.id] || humanizeId(weakest.id)} ${formatScore(weakest.score, dimensionScoreEvidence(weakest))}; high ${DIMENSION_LABELS[strongest.id] || humanizeId(strongest.id)} ${formatScore(strongest.score, dimensionScoreEvidence(strongest))}`;
    return `          <li><strong>${escapeHtml(DOMAIN_LABELS[domain.id] || humanizeId(domain.id))}: ${escapeHtml(formatScore(domain.score, domainScoreEvidence(domain)))}</strong>; weight ${escapeHtml(formatPercent(domain.weight))}; ${escapeHtml(dimensionSummary)}.</li>`;
  }).join('\n')}
        </ul>
        <h3>Dimension evidence, observed scores weakest first</h3>
        <div class="table-scroll"><table>
          <thead><tr><th scope="col">Dimension</th><th scope="col">Domain</th><th scope="col">Score</th><th scope="col">Coverage</th><th scope="col">Evidence state</th></tr></thead>
          <tbody>
${dimensionRows.map((dimension) => `            <tr><td>${escapeHtml(DIMENSION_LABELS[dimension.id] || humanizeId(dimension.id))}</td><td>${escapeHtml(DOMAIN_LABELS[dimension.domainId] || humanizeId(dimension.domainId))}</td><td>${escapeHtml(formatScore(dimension.score, dimensionScoreEvidence(dimension)))}</td><td>${escapeHtml(formatPercent(dimension.coverage))}</td><td>${escapeHtml(dimensionEvidenceState(dimension))}</td></tr>`).join('\n')}
          </tbody>
        </table></div>
        <h3>Comparison set</h3>
        <p>Nearest ranked peers: ${peerLinks}. Comparisons in ${escapeHtml(country.regionName)}: ${regionalLinks}. Similar scores do not mean equal conditions.</p>
        <h3>Tracked crisis context</h3>
        <p>${crisisText}</p>
        <h3>Reading limits</h3>
        <p>${escapeHtml(prettyDate(capturedAt))}; method ${escapeHtml(methodologyFormula)}. ${escapeHtml(topDomainSentence)} Weak pillars reduce the result; compare with coverage and imputation visible.</p>
        <h3>Questions about ${escapeHtml(country.name)}</h3>
${faqs.map((faq) => `        <details data-country-faq><summary>${escapeHtml(faq.question)}</summary><p>${escapeHtml(faq.answer)}</p></details>`).join('\n')}
      </article>`;
  return { html, faqs };
}

// "Recent developments in {Country}" (#7615). Every rendered item is a dated,
// sourced, country-specific frozen row — headline (linked title, outlet,
// publication time), intel brief (generated text with its cited sources), or
// timeline event. Rows are validated on the way in: render throws rather than
// publishing an unattributable item, so a malformed frozen row reds the build
// instead of reaching a crawler.
//
// The movement sentence states co-occurrence, never causation: the frozen
// numbers moved in the same window the reporting was captured. Asserting that
// a headline *drove* a score move would be fabrication — only an analyst (or
// the brief, which cites its sources) may draw that link.
export function renderCountryDevelopments({ countryName, developments, ciiEntry = null, pulse = null }) {
  const name = String(countryName || '').trim();
  if (!name) throw new Error('renderCountryDevelopments requires a country name');
  const rows = developments && typeof developments === 'object' ? developments : null;
  const headlines = Array.isArray(rows?.headlines) ? rows.headlines : [];
  const brief = rows?.brief && typeof rows.brief === 'object' ? rows.brief : null;
  const timeline = Array.isArray(rows?.timeline) ? rows.timeline : [];

  for (const headline of headlines) assertDevelopmentsHeadline(headline);
  if (brief) assertDevelopmentsBrief(brief);
  for (const event of timeline) assertDevelopmentsTimelineEvent(event);

  const movementSentence = describeDevelopmentsMovement({ countryName: name, ciiEntry, pulse });
  const briefExtraSources = brief
    ? (Array.isArray(brief.sources) ? brief.sources : [])
      .filter((source) => source && typeof source.url === 'string'
        && !headlines.some((headline) => headline.url === source.url))
    : [];
  for (const source of briefExtraSources) assertDevelopmentsHeadline(source);
  const itemCount = headlines.length + briefExtraSources.length + timeline.length + (brief ? 1 : 0);

  // Zero items render nothing at all — not an absence note. A "no items"
  // paragraph would stamp ~140 pages with the same boilerplate sentence and
  // push the template share the enrichment is meant to reduce (#7615). The
  // gap stays visible where it belongs: developments:null in resilience.json,
  // the post-enrichment input to residual hub consolidation.
  if (itemCount === 0) return '';

  const parts = [];
  if (movementSentence) parts.push(`        <p>${movementSentence}</p>`);
  if (headlines.length > 0 || briefExtraSources.length > 0) {
    const items = [...headlines, ...briefExtraSources]
      .map((headline) => `          <li><a href="${escapeHtml(headline.url)}">${escapeHtml(headline.title)}</a> <small>${escapeHtml(headline.source)} · <time datetime="${escapeHtml(headline.publishedAt)}">${escapeHtml(formatStaticDateTime(headline.publishedAt))}</time></small></li>`)
      .join('\n');
    parts.push(`        <ul>\n${items}\n        </ul>`);
  }
  if (brief) {
    const briefHtml = escapeHtml(brief.text).replace(/\n/g, '<br>');
    const generatedLine = `Brief generated <time datetime="${escapeHtml(brief.generatedAt)}">${escapeHtml(formatStaticDateTime(brief.generatedAt))}</time>`;
    parts.push(`        <div data-intel-brief>\n          <h3>Country brief</h3>\n          <p>${briefHtml}</p>\n          <p class="source">${generatedLine}${brief.model ? ` by ${escapeHtml(brief.model)}` : ''} from ${brief.sources.length} grounding sources.</p>\n        </div>`);
  }
  if (timeline.length > 0) {
    const events = timeline
      .map((event) => {
        const sourceBit = ` <a href="${escapeHtml(event.sourceUrl)}">source</a>`;
        const summaryBit = event.summary ? ` — ${escapeHtml(event.summary)}` : '';
        const domainBit = event.domain ? ` <small>${escapeHtml(event.domain)}</small>` : '';
        return `          <li><strong>${escapeHtml(event.title)}</strong>${summaryBit} <small><time datetime="${escapeHtml(event.occurredAt)}">${escapeHtml(formatStaticDateTime(event.occurredAt))}</time></small>${domainBit}${sourceBit}</li>`;
      })
      .join('\n');
    parts.push(`        <ol data-intel-timeline>\n${events}\n        </ol>`);
  }
  const inner = parts.join('\n');
  return `      <section data-country-developments aria-label="Recent developments in ${escapeHtml(name)}">\n        <h2>Recent developments in ${escapeHtml(name)}</h2>\n${inner}\n      </section>`;
}

function isValidHttpsUrl(value) {
  if (typeof value !== 'string') return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' && Boolean(parsed.hostname);
  } catch {
    return false;
  }
}

function assertDevelopmentsHeadline(headline) {
  const valid = headline && typeof headline === 'object'
    && typeof headline.title === 'string' && headline.title.trim()
    && typeof headline.source === 'string' && headline.source.trim()
    && isValidHttpsUrl(headline.url)
    && typeof headline.publishedAt === 'string' && isCanonicalIsoInstant(headline.publishedAt);
  if (!valid) throw new Error('country developments headline is missing title, source, https URL, or ISO publication time');
}

function assertDevelopmentsBrief(brief) {
  if (typeof brief.text !== 'string' || !brief.text.trim()) {
    throw new Error('country developments brief carries no text');
  }
  if (typeof brief.generatedAt !== 'string' || !isCanonicalIsoInstant(brief.generatedAt)) {
    throw new Error('country developments brief is missing a canonical ISO generation time');
  }
  if (!Array.isArray(brief.sources) || brief.sources.length === 0) {
    throw new Error('country developments brief carries no grounding sources');
  }
  for (const source of brief.sources) assertDevelopmentsHeadline(source);
  const citations = [...brief.text.matchAll(/\[(\d+)\]/g)]
    .map((match) => Number(match[1]));
  if (citations.length === 0) {
    throw new Error('country developments brief carries no source citation');
  }
  if (citations.some((citation) => citation < 1 || citation > brief.sources.length)) {
    throw new Error('country developments brief carries an out-of-range source citation');
  }
}

function assertDevelopmentsTimelineEvent(event) {
  const valid = event && typeof event === 'object'
    && typeof event.title === 'string' && event.title.trim()
    && typeof event.occurredAt === 'string' && isCanonicalIsoInstant(event.occurredAt)
    && isValidHttpsUrl(event.sourceUrl);
  if (!valid) throw new Error('country developments timeline event is missing title, ISO occurrence time, or a valid source URL');
}

function describeDevelopmentsMovement({ countryName, ciiEntry, pulse }) {
  const name = escapeHtml(countryName);
  if (ciiEntry && hasObservedValue(ciiEntry.score, OBSERVED_EVIDENCE)
    && typeof ciiEntry.asOf === 'string' && isCanonicalIsoInstant(ciiEntry.asOf)) {
    return `${name}'s Country Instability Index is <strong>${escapeHtml(formatScore(ciiEntry.score, OBSERVED_EVIDENCE))}/100 · ${escapeHtml(ciiEntry.band)}</strong>, ${escapeHtml(ciiEntry.movementText)}, as of <time datetime="${escapeHtml(ciiEntry.asOf)}">${escapeHtml(formatStaticDateTime(ciiEntry.asOf))}</time>. Reporting captured in the same window is listed below.`;
  }
  if (pulse && pulse.partial !== true && hasObservedValue(pulse.score, { coverage: true })) {
    const asOf = typeof pulse.asOf === 'string' && isCanonicalIsoInstant(pulse.asOf) ? pulse.asOf : null;
    return `${name}'s frozen instability pulse records ${escapeHtml(formatScore(pulse.score, { coverage: true }))} (${escapeHtml(pulse.band || 'unbanded')}), trend ${escapeHtml(pulse.trend || 'unavailable')}${asOf ? `, as of <time datetime="${escapeHtml(asOf)}">${escapeHtml(formatStaticDateTime(asOf))}</time>` : ''}. Reporting captured in the same window is listed below.`;
  }
  return '';
}

// Newest frozen developments instant for WebPage dateModified (#7615:
// recency machine-readable per country). Null when the country captured no
// dated items. Never falls back to the harvest clock: an absent date has no
// page representation, same rule as the pulse asOf contract.
export function newestDevelopmentsInstant(developments) {
  const instants = [];
  if (developments && typeof developments === 'object') {
    for (const headline of developments.headlines || []) {
      if (typeof headline?.publishedAt === 'string' && isCanonicalIsoInstant(headline.publishedAt)) {
        instants.push(headline.publishedAt);
      }
    }
    if (typeof developments.brief?.generatedAt === 'string' && isCanonicalIsoInstant(developments.brief.generatedAt)) {
      instants.push(developments.brief.generatedAt);
    }
    for (const event of developments.timeline || []) {
      if (typeof event?.occurredAt === 'string' && isCanonicalIsoInstant(event.occurredAt)) {
        instants.push(event.occurredAt);
      }
    }
  }
  instants.sort();
  return instants.length > 0 ? instants.at(-1) : null;
}

// True when the frozen developments carry at least one dated,
// sourced, country-specific item: a headline, a brief with text, or a
// timeline event. The dated-absence note (data-developments-empty) does not
// count — it is a marker, not an item.
export function developmentsHasDatedItem(developments) {
  if (!developments || typeof developments !== 'object') return false;
  if (Array.isArray(developments.headlines) && developments.headlines.length > 0) return true;
  if (developments.brief && typeof developments.brief.text === 'string' && developments.brief.text.trim()) return true;
  return Array.isArray(developments.timeline) && developments.timeline.length > 0;
}

// Durable guard (#7615): the enrichment must be permanent, not a one-off
// content pass. After rendering, every frozen developments row for this
// country must be present in the page HTML — a silent drop (wrong slug, lost
// prop, over-eager filter) fails the build instead of shipping a page whose
// snapshot claims items the crawler cannot see.
export function assertCountryDevelopmentsRendered({ pagePath, html, developments }) {
  const rows = developments && typeof developments === 'object' ? developments : null;
  if (!rows || !developmentsHasDatedItem(rows)) return;
  if (!html.includes('data-country-developments')) {
    throw new Error(`${pagePath} is missing its recent-developments section`);
  }
  for (const headline of rows.headlines || []) {
    // Anchor-scoped: a bare URL substring passes when the URL merely appears
    // in prose or another link. The headline must render as a link.
    if (!html.includes(`href="${escapeHtml(headline.url)}"`)) {
      throw new Error(`${pagePath} dropped frozen headline ${headline.url}`);
    }
  }
  if (rows.brief && typeof rows.brief.text === 'string' && rows.brief.text.trim()) {
    // Anchor on the first AND last non-empty lines: every generated brief
    // opens with the same boilerplate header, so the first line alone cannot
    // catch a cross-country brief swap. The renderer escapes newlines to
    // <br>, so raw multi-line slices never appear verbatim.
    const nonEmpty = rows.brief.text.trim().split('\n').map((line) => line.trim()).filter(Boolean);
    const anchors = [nonEmpty[0], nonEmpty.at(-1)]
      .filter((line, index, all) => line && all.indexOf(line) === index)
      .map((line) => escapeHtml(line.slice(0, 120)));
    for (const anchor of anchors) {
      if (!html.includes(anchor)) {
        throw new Error(`${pagePath} dropped its frozen intel brief`);
      }
    }
  }
  const briefSources = Array.isArray(rows.brief?.sources) ? rows.brief.sources : [];
  for (const source of briefSources) {
    if (typeof source?.url === 'string' && !html.includes(`href="${escapeHtml(source.url)}"`)) {
      throw new Error(`${pagePath} dropped frozen brief source ${source.url}`);
    }
  }
  for (const event of rows.timeline || []) {
    if (!html.includes(escapeHtml(event.title))) {
      throw new Error(`${pagePath} dropped frozen timeline event ${event.title}`);
    }
    if (typeof event.occurredAt === 'string' && !html.includes(`datetime="${escapeHtml(event.occurredAt)}"`)) {
      throw new Error(`${pagePath} dropped the date of frozen timeline event ${event.title}`);
    }
  }
}

// Pipeline tripwire decision (#7615), exported for tests: the per-page guard
// proves frozen items render; this proves every indexed country captured one.
export function assertDevelopmentsCoverage({
  carriesDevelopments,
  developmentsPageCount,
  indexedCountryPageCount,
}) {
  if (carriesDevelopments && developmentsPageCount !== indexedCountryPageCount) {
    throw new Error(
      `crawlable corpus captured dated country developments for ${developmentsPageCount} `
      + `of ${indexedCountryPageCount} indexed country pages; refusing to publish incomplete coverage`,
    );
  }
}

export function renderCountryPage({
  country,
  baseUrl,
  capturedAt,
  lastmod,
  methodologyFormula,
  rankedCount,
  snapshotNote,
  snapshotPath,
  bbox = null,
  livePulse = null,
  ciiEntry = null,
}) {
  const path = `/countries/${country.slug}/`;
  const description = countryMetaDescription({
    name: country.name,
    rank: country.rank,
    rankedCount,
    lowConfidence: country.lowConfidence === true,
    ciiEntry,
  });
  const mapUrl = withUtmSource(
    absoluteUrl(baseUrl, `/?country=${encodeURIComponent(country.code)}&expanded=1`),
    'seo-country',
  );
  const analysis = renderCountryAnalysis({
    country,
    capturedAt,
    methodologyFormula,
    rankedCount,
    ciiEntry,
  });
  const officialNameNote = country.identity.officialName !== country.identity.commonName
    ? `      <p><strong>Official name:</strong> ${escapeHtml(country.identity.officialName)}. <a href="${escapeHtml(country.identity.sameAs)}">Wikidata identity record</a>.</p>\n`
    : '';
  const scorePublished = country.headlineEligible !== false;
  const scoreDisclosure = scorePublished || analysis.suppressScoreDisclosure
    ? ''
    : `\n      <p>World Monitor does not publish a resilience score for ${escapeHtml(country.name)} because it does not meet the published ranking eligibility criteria.</p>`;
  const datasetDescription = scorePublished
    ? `A dated World Monitor Country Resilience Index snapshot for ${country.name}, with the overall score, rank, dimension coverage, confidence classification, and scoring methodology used for this page.`
    : `A dated World Monitor Country Resilience Index snapshot for ${country.name}, with dimension coverage, confidence classification, and scoring methodology. No overall score or rank is published because the country does not meet the published ranking eligibility criteria. ${RANKING_ELIGIBILITY_CLAUSE}`;
  const pulse = livePulse?.countries?.[country.code] || null;
  const hasPulse = pulse != null && (
    pulse.partial === true
    || hasObservedValue(pulse.score, { coverage: pulse.partial !== true })
  );
  const developments = pulse && typeof pulse.developments === 'object' ? pulse.developments : null;
  const liveState = hasPulse ? (pulse.partial ? 'partial' : 'ready') : 'loading';
  const liveStatus = hasPulse
    ? (pulse.partial ? 'Published partial pulse' : 'Published pulse')
    : 'Waiting for live enhancement';
  const liveGrid = hasPulse
    ? `        <div class="grid" data-live-grid aria-label="Current country instability metrics" aria-busy="false">
          <div class="metric"><span>Instability score</span><strong><span data-live-score>${escapeHtml(formatScore(pulse.score, { coverage: pulse.partial !== true }))}</span><small data-live-band>${pulse.partial ? 'No current score' : escapeHtml(pulse.band)}</small></strong></div>
          <div class="metric"><span>Approx. 24-hour movement</span><strong data-live-trend>${escapeHtml(pulse.partial ? 'Unavailable' : ciiEntry?.change24h === null ? 'Stable or unavailable' : pulse.trend)}</strong></div>
          <div class="metric"><span>Travel advisory input</span><strong data-live-advisory>${escapeHtml(pulse.advisory)}</strong></div>
          <div class="metric"><span>OFAC designations in feed</span><strong data-live-sanctions>${escapeHtml(pulse.sanctions)}</strong></div>
        </div>`
    : `        <p class="tool-note" data-live-fallback>Current instability metrics load after page enhancement. The structural resilience snapshot below remains the dated crawlable reference.</p>
        <div class="grid" data-live-grid hidden aria-label="Current country instability metrics" aria-busy="true">
          <div class="metric"><span>Instability score</span><strong><span data-live-score></span><small data-live-band></small></strong></div>
          <div class="metric"><span>Approx. 24-hour movement</span><strong data-live-trend></strong></div>
          <div class="metric"><span>Travel advisory input</span><strong data-live-advisory></strong></div>
          <div class="metric"><span>OFAC designations in feed</span><strong data-live-sanctions></strong></div>
        </div>`;
  const ciiAnswer = ciiEntry
    ? `${escapeHtml(country.name)}'s Country Instability Index is <strong>${escapeHtml(formatScore(ciiEntry.score, OBSERVED_EVIDENCE))}/100 &middot; ${escapeHtml(ciiEntry.band)}</strong>, ${escapeHtml(ciiEntry.movementText)}, as of <time datetime="${escapeHtml(ciiEntry.asOf)}">${escapeHtml(formatStaticDateTime(ciiEntry.asOf))}</time>.`
    : null;
  const body = `      <p class="eyebrow">Country &middot; ${escapeHtml(country.code)}</p>
      <h1>${escapeHtml(country.name)} ${ciiEntry ? 'Country Instability Index' : 'country risk and resilience'}</h1>
      <p class="lede">${ciiAnswer || `${escapeHtml(description)} The structural snapshot is dated and source-labelled; the live monitor loads separately.`}</p>
${ciiEntry ? `      <p>CII measures current stress. World Monitor's separate Country Resilience Index measures ${escapeHtml(country.name)}'s longer-term structural capacity.</p>\n` : ''}
${officialNameNote}      <section class="live-tool" data-live-country-risk data-country-code="${escapeHtml(country.code)}" data-country-name="${escapeHtml(country.name)}" data-state="${liveState}"${hasPulse ? ' data-published-pulse' : ''}>
        <div class="tool-head">
          <div>
            <p class="eyebrow">Current signal</p>
            <h2>${escapeHtml(country.name)} instability monitor</h2>
          </div>
          <span class="live-status" data-live-status role="status" aria-live="polite">${escapeHtml(liveStatus)}</span>
        </div>
        <p class="tool-note">Instability combines current information, unrest, conflict and security-mobility signals. It is separate from structural resilience; do not combine the scores.</p>
${liveGrid}
        <div class="tool-meta">
          ${liveUpdatedMarkup({
            asOf: pulse?.asOf || null,
            fallbackLabel: 'Live enhancement pending',
            // Always "Published pulse": the stamp is when the pulse was frozen,
            // not when a reader retrieved it. Matches the hydrate-side wording.
            prefix: 'Published pulse',
          })}
          <button class="refresh" type="button" data-live-refresh disabled>Refresh live data</button>
        </div>
        <noscript><p>Enable JavaScript to refresh the current API result. ${hasPulse ? 'The published pulse above remains available without JavaScript.' : 'The structural resilience snapshot remains available below.'}</p></noscript>
      </section>
      <a class="cta" href="${escapeHtml(mapUrl)}">Open ${escapeHtml(country.name)} on the live map →</a>
${renderCountryDevelopments({ countryName: country.name, developments, ciiEntry, pulse })}
      <h2>Structural resilience snapshot</h2>
      <section class="grid" aria-label="Country resilience metrics">
        <div class="metric"><span>Rank</span><strong>${escapeHtml(country.rank == null ? 'Not ranked' : `#${country.rank}`)}</strong></div>
        <div class="metric"><span>Overall score</span><strong>${escapeHtml(formatScore(country.overallScore, { coverage: scorePublished }))}</strong></div>
        <div class="metric"><span>Dimension coverage</span><strong>${escapeHtml(formatPercent(country.dimensionCoverage))}</strong></div>
        <div class="metric"><span>Confidence</span><strong>${country.lowConfidence ? 'Low' : 'Standard'}</strong></div>
      </section>${scoreDisclosure}
${analysis.html}
${analysis.readingGuide ? `      <h2>How to use this evidence</h2>
      <p>${escapeHtml(analysis.readingGuide)} <a href="/docs/methodology/country-resilience-index">Full CRI method</a> · <a href="/docs/corrections">revision log</a>.</p>` : `      <h2>How to read this page</h2>
      <p>The 0-100 index records the ${escapeHtml(prettyDate(capturedAt))} snapshot under ${escapeHtml(methodologyFormula)}. See the <a href="/docs/methodology/country-resilience-index">Country Resilience Index methodology</a> for dimensions, sources and confidence rules. Published revisions that affect ${escapeHtml(country.name)} are in the <a href="/docs/corrections">corrections log</a>.</p>
      <p class="snapshot-note">${escapeHtml(snapshotNote)}</p>
      <p>Use this dated reference with the live map for active alerts, conflict, market and energy signals.</p>`}
      <p class="source">Download: <a href="${escapeHtml(datasetDownloadHref(path, COUNTRY_DATASET_DOWNLOAD))}">${COUNTRY_DATASET_DOWNLOAD}</a>. Source: ${escapeHtml(snapshotPath)}. Captured ${escapeHtml(capturedAt)}. Methodology: <a href="/docs/methodology/country-resilience-index">Country Resilience Index</a>.</p>`;
  const coreTitle = ciiEntry
    ? `${country.name} Instability Index & Country Risk`
    : `${country.name} Country Risk and Resilience`;
  const resilienceDatasetId = `${absoluteUrl(baseUrl, path)}#resilience-dataset`;
  const ciiDatasetId = `${absoluteUrl(baseUrl, path)}#cii-dataset`;
  const resilienceDownload = absoluteUrl(baseUrl, datasetDownloadHref(path, COUNTRY_DATASET_DOWNLOAD));
  // WebPage dateModified tracks the newest frozen developments item (#7615:
  // per-country recency, machine-readable). The resilience Dataset node stays
  // pinned to the snapshot capturedAt per #7391 — a different claim (snapshot
  // freshness) from this one (newest rendered news item).
  const developmentsModified = newestDevelopmentsInstant(developments);
  const spatialCoverage = {
    ...countrySpatialCoverage(country, bbox),
    name: country.identity.commonName,
    alternateName: country.identity.alternateNames,
    sameAs: country.identity.sameAs,
  };
  const variableMeasured = [
    { '@type': 'PropertyValue', name: 'Dimension coverage', value: country.dimensionCoverage, minValue: 0, maxValue: 1 },
    ...(scorePublished ? [
      { '@type': 'PropertyValue', name: 'Overall resilience score', value: country.overallScore, minValue: 0, maxValue: 100 },
      { '@type': 'PropertyValue', name: 'Rank', value: country.rank },
      // Structured data is the surface answer engines cite, so it obeys the same
      // observed-value rule as the visible page: a withheld value is OMITTED here,
      // never emitted raw next to an em dash in the HTML.
      ...(hasObservedValue(country.change30d, { coverage: scorePublished })
        ? [{ '@type': 'PropertyValue', name: '30-day score change', value: country.change30d, unitText: 'index points' }]
        : []),
      ...country.pillars
        .filter((pillar) => hasObservedValue(pillar.score, { coverage: pillar.coverage }))
        .map((pillar) => ({
          '@type': 'PropertyValue',
          name: `${PILLAR_LABELS[pillar.id] || humanizeId(pillar.id)} score`,
          value: pillar.score,
          minValue: 0,
          maxValue: 100,
        })),
    ] : []),
  ];
  const resilienceDataset = {
    '@type': 'Dataset',
    '@id': resilienceDatasetId,
    name: `World Monitor Country Resilience snapshot for ${country.name}`,
    description: datasetDescription,
    url: absoluteUrl(baseUrl, path),
    identifier: country.code,
    keywords: ['country resilience', country.name, 'resilience index', 'country risk'],
    creator: { ...WORLD_MONITOR_ORG },
    license: DATASET_LICENSE,
    datePublished: capturedAt,
    dateModified: capturedAt,
    temporalCoverage: datasetTemporalCoverage(capturedAt),
    spatialCoverage,
    isAccessibleForFree: true,
    includedInDataCatalog: includedInDataCatalog(baseUrl),
    distribution: [dataDownload(resilienceDownload)],
    measurementTechnique: methodologyFormula,
    variableMeasured,
  };
  const ciiDataset = ciiEntry ? {
    '@type': 'Dataset',
    '@id': ciiDatasetId,
    name: `World Monitor Country Instability Index: ${country.name}`,
    description: `The current World Monitor Country Instability Index score, available approximate 24-hour movement, instability level, and methodology version for ${country.name}.`,
    url: absoluteUrl(baseUrl, path),
    identifier: `${country.code}-cii-${ciiEntry.methodologyVersion}`,
    keywords: ['country instability', country.name, 'instability index', 'country risk'],
    creator: { ...WORLD_MONITOR_ORG },
    license: DATASET_LICENSE,
    datePublished: pulseDateOnly(ciiEntry.asOf, capturedAt),
    dateModified: ciiEntry.asOf,
    temporalCoverage: datasetTemporalCoverage(pulseDateOnly(ciiEntry.asOf, capturedAt)),
    spatialCoverage,
    isAccessibleForFree: true,
    includedInDataCatalog: includedInDataCatalog(baseUrl),
    distribution: [dataDownload(absoluteUrl(baseUrl, datasetDownloadHref(path, COUNTRY_CII_DATASET_DOWNLOAD)))],
    measurementTechnique: `World Monitor CII ${ciiEntry.methodologyVersion}`,
    variableMeasured: [
      { '@type': 'PropertyValue', name: 'Instability score', value: ciiEntry.score, minValue: 0, maxValue: 100 },
      ...ciiMovementProperties(ciiEntry.change24h),
      { '@type': 'PropertyValue', name: 'Instability level', value: ciiEntry.band },
    ],
  } : null;
  const html = pageDocument({
    baseUrl,
    path,
    // Keep SERP titles near the ~60-char display budget: drop the brand
    // suffix for long country names rather than letting Google truncate
    // mid-brand.
    title: coreTitle.length > 44 ? coreTitle : `${coreTitle} | World Monitor`,
    description,
    lastmod,
    jsonLd: [
      {
        '@context': 'https://schema.org',
        '@type': 'WebPage',
        name: ciiEntry
          ? `${country.name} Country Instability Index and Country Risk`
          : `${country.name} country risk and resilience`,
        description,
        url: absoluteUrl(baseUrl, path),
        inLanguage: 'en-US',
        ...(developmentsModified ? { dateModified: developmentsModified } : {}),
        about: {
          '@type': 'Country',
          name: country.identity.commonName,
          alternateName: country.identity.alternateNames,
          identifier: country.code,
          sameAs: country.identity.sameAs,
        },
        mainEntity: ciiEntry ? { '@id': ciiDatasetId } : resilienceDataset,
      },
      ...(ciiEntry ? [ciiDataset, resilienceDataset] : []),
      faqPageLd(analysis.faqs),
      dataCatalogLd(baseUrl),
    ],
    breadcrumbs: breadcrumbLd(baseUrl, [
      { name: 'Home', path: '/' },
      { name: 'Countries', path: '/countries/' },
      { name: country.name, path },
    ]),
    body,
    scriptSrcs: ['/tools/live-tools.js'],
  });
  assertCountryDevelopmentsRendered({ pagePath: path, html, developments });
  return html;
}

const CHOKEPOINT_HUB_STATUS_LABELS = new Set(['Green', 'Yellow', 'Red']);
const CHOKEPOINT_HUB_CONGESTION_LABELS = new Set([
  'Low',
  'Normal',
  'Elevated',
  'High',
  'Not reported',
]);

function publishedPulseLabel(value, allowed) {
  if (typeof value !== 'string') return '';
  const label = value.trim();
  return allowed.has(label) ? label : '';
}

function chokepointHubStatusForScore(score) {
  if (score < 20) return 'Green';
  if (score < 50) return 'Yellow';
  return 'Red';
}

export function buildChokepointHubRows(chokepoints, livePulse) {
  const registryIds = chokepoints.map((chokepoint) => chokepoint.id);
  const registryIdSet = new Set(registryIds);
  const pulseIds = Object.keys(livePulse?.chokepoints || {});
  const pulseIdSet = new Set(pulseIds);
  const missingIds = registryIds.filter((id) => !pulseIdSet.has(id));
  const unexpectedIds = pulseIds.filter((id) => !registryIdSet.has(id));
  if (missingIds.length > 0 || unexpectedIds.length > 0) {
    throw new Error(
      `Chokepoint hub pulse set is invalid: missing ${missingIds.join(', ') || 'none'}; `
      + `unexpected ${unexpectedIds.join(', ') || 'none'}`,
    );
  }
  return chokepoints.map((chokepoint) => {
    const pulse = livePulse?.chokepoints?.[chokepoint.id];
    const rawScore = pulse?.disruptionScore;
    let score = Number.NaN;
    if (typeof rawScore === 'number') {
      score = rawScore;
    } else if (typeof rawScore === 'string' && /^\d+(?:\.\d+)?$/.test(rawScore)) {
      score = Number(rawScore);
    }
    const status = publishedPulseLabel(pulse?.status, CHOKEPOINT_HUB_STATUS_LABELS);
    const aisSnapshotAvailable = pulse?.aisSnapshotAvailable === true;
    const congestion = aisSnapshotAvailable
      ? publishedPulseLabel(pulse?.congestion, CHOKEPOINT_HUB_CONGESTION_LABELS)
      : 'Not reported';
    const asOf = String(pulse?.asOf || '').trim();
    const asOfMs = Date.parse(asOf);
    const capturedAtMs = livePulse?.capturedAtMs;
    if (
      !pulse
      || !Number.isFinite(score)
      || score < 0
      || score > 100
      || !status
      || !congestion
      || status !== chokepointHubStatusForScore(score)
      || !isCanonicalIsoInstant(asOf)
      || !Number.isFinite(capturedAtMs)
      || asOfMs < capturedAtMs - MAX_LIVE_SNAPSHOT_AGE_MS
      || asOfMs > capturedAtMs + MAX_FUTURE_SKEW_MS
    ) {
      throw new Error(`Chokepoint hub pulse is invalid for ${chokepoint.id}`);
    }
    return {
      chokepoint,
      region: CHOKEPOINT_CONTENT[chokepoint.id]?.region || 'Strategic maritime waterway',
      score,
      status,
      congestion,
      aisSnapshotAvailable,
      asOf,
    };
  });
}

function renderChokepointsIndex({ chokepoints, chokepointHubRows, livePulse, baseUrl, lastmod, snapshotPath }) {
  const path = '/chokepoints/';
  const description = `Track current disruption scores, status, AIS congestion, and update times for the ${chokepoints.length} maritime chokepoints in the World Monitor public status snapshot.`;
  const updatedAt = chokepointHubRows
    .map((row) => row.asOf)
    .sort((left, right) => Date.parse(left) - Date.parse(right))
    .at(-1);
  const highestScore = Math.max(...chokepointHubRows.map((row) => row.score));
  const mostDisruptedNames = chokepointHubRows
    .filter((row) => row.score === highestScore)
    .map((row) => row.chokepoint.displayName);
  // State the coverage this snapshot actually has. The answer used to assert
  // four scoring inputs flatly while the detail pages withheld three of them,
  // so the hub contradicted the pages it indexes (#7530).
  const congestionPublished = chokepointHubRows.filter((row) => row.aisSnapshotAvailable).length;
  const congestionCoverageClause = congestionPublished === chokepointHubRows.length
    ? `in this snapshot all ${chokepointHubRows.length} waterways publish an AIS congestion reading`
    : congestionPublished === 0
      ? `in this snapshot the AIS snapshot is unavailable, so none of the ${chokepointHubRows.length} waterways publish an AIS congestion reading`
      : `in this snapshot ${congestionPublished} of ${chokepointHubRows.length} waterways publish an AIS congestion reading`;
  // The committed EIA series covers 7 of the 13 tracked waterways. Publish the
  // EIA row name alongside ours wherever the registry maps them differently
  // (Dover Strait draws on the Danish Straits row), so the substitution is
  // visible rather than implied.
  const oilTransitRows = chokepointHubRows
    .map((row) => ({ row, eia: EIA_OIL_TRANSIT_BASELINES.byRegistryId[row.chokepoint.id] }))
    .filter(({ eia }) => eia)
    .sort((left, right) => right.eia.mbd - left.eia.mbd);
  const hubFaqs = [
    {
      question: 'Which maritime chokepoints are most disrupted?',
      answer: `The published ${formatStaticDateTime(updatedAt)} snapshot gives the highest disruption score to ${formatProseList(mostDisruptedNames)}, each at ${formatScore(highestScore, OBSERVED_EVIDENCE)}/100. The table covers all ${chokepointHubRows.length} tracked waterways and shows each source timestamp. A higher score means more current pressure, but the badge is a risk signal and does not declare unrestricted passage or operational closure.`,
    },
    {
      question: 'How does World Monitor score chokepoint status?',
      answer: `World Monitor scores each waterway 0-100 from a configured geopolitical baseline, NGA navigational warnings, maximum AIS severity, and a qualifying traffic anomaly. AIS event counts, relay transit counts, and PortWatch movement are context rather than score inputs. Each source controls only its own values, so unavailable evidence is withheld rather than published as a measured zero or a calm reading — ${congestionCoverageClause}. The methodology documents the inputs and score bands.`,
    },
    {
      question: 'Why do some chokepoint pages show fewer metrics than others?',
      answer: 'A metric appears only when the source behind it reported for that snapshot. Navigational warnings, AIS disruptions and AIS congestion each depend on their own feed. The daily transit count and PortWatch week-over-week movement each depend on their own source availability, so either can appear without the other. Unavailable values can appear as an em dash or be hidden, depending on the metric, so a sparse page means missing evidence, not a calm waterway. Published revisions to these rules are in the corrections log.',
    },
  ];
  const datasetId = `${absoluteUrl(baseUrl, path)}#status-dataset`;
  const itemListId = `${absoluteUrl(baseUrl, path)}#status-list`;
  const itemListElement = chokepointHubRows.map((row, index) => {
    const url = absoluteUrl(baseUrl, `/chokepoints/${row.chokepoint.slug}/`);
    return {
      '@type': 'ListItem',
      position: index + 1,
      name: row.chokepoint.displayName,
      url,
      item: {
        '@type': 'Place',
        name: row.chokepoint.displayName,
        url,
        additionalProperty: [
          { '@type': 'PropertyValue', name: 'Disruption score', value: row.score, minValue: 0, maxValue: 100 },
          { '@type': 'PropertyValue', name: 'Status', value: row.status },
          ...(row.aisSnapshotAvailable
            ? [{ '@type': 'PropertyValue', name: 'AIS congestion', value: row.congestion }]
            : []),
        ],
      },
    };
  });
  const body = `      <p class="eyebrow">Maritime corpus</p>
      <h1>Chokepoints and waterways</h1>
      <p class="lede">${escapeHtml(description)}</p>
${hubFaqs.map((faq) => `      <h2 data-chokepoint-hub-faq>${escapeHtml(faq.question)}</h2>
      <p>${escapeHtml(faq.answer)}</p>`).join('\n')}
      <div class="table-scroll"><table data-chokepoint-status>
        <caption>Published chokepoint status snapshot updated ${escapeHtml(formatStaticDateTime(updatedAt))}</caption>
        <thead><tr><th scope="col">Chokepoint</th><th scope="col">Region</th><th scope="col">Disruption score</th><th scope="col">Status</th><th scope="col">AIS congestion</th><th scope="col">Updated</th></tr></thead>
        <tbody>
${chokepointHubRows.map((row) => `          <tr><td><a href="/chokepoints/${row.chokepoint.slug}/">${escapeHtml(row.chokepoint.displayName)}</a></td><td data-hub-region>${escapeHtml(row.region)}</td><td><data data-hub-score value="${escapeHtml(row.score)}">${escapeHtml(formatScore(row.score, OBSERVED_EVIDENCE))}</data></td><td data-hub-status>${escapeHtml(row.status)}</td><td data-hub-congestion>${escapeHtml(row.congestion)}</td><td><time data-hub-updated datetime="${escapeHtml(row.asOf)}">${escapeHtml(formatStaticDateTime(row.asOf))}</time></td></tr>`).join('\n')}
        </tbody>
      </table></div>
      <h2>How much oil moves through each waterway</h2>
      <p>Disruption scores describe current pressure, not importance. The committed ${escapeHtml(String(EIA_OIL_TRANSIT_BASELINES.referenceYear))} ${escapeHtml(EIA_OIL_TRANSIT_BASELINES.source)} series gives a volume baseline for ${oilTransitRows.length} of the ${chokepointHubRows.length} tracked waterways, which is what separates a high score on a marginal strait from a high score on a corridor that moves a fifth of seaborne oil. Where our name and the EIA row differ, both are shown — the Dover Strait page draws on the EIA Danish Straits row.</p>
      <div class="table-scroll"><table data-chokepoint-oil-transit>
        <caption>Crude oil and petroleum liquids transiting each waterway, ${escapeHtml(EIA_OIL_TRANSIT_BASELINES.source)}, ${escapeHtml(String(EIA_OIL_TRANSIT_BASELINES.referenceYear))}</caption>
        <thead><tr><th scope="col">Chokepoint</th><th scope="col">EIA series row</th><th scope="col">Million barrels per day</th></tr></thead>
        <tbody>
${oilTransitRows.map(({ row, eia }) => `          <tr><td><a href="/chokepoints/${row.chokepoint.slug}/">${escapeHtml(row.chokepoint.displayName)}</a></td><td data-oil-eia-name>${escapeHtml(eia.eiaName)}</td><td><data data-oil-mbd value="${escapeHtml(String(eia.mbd))}">${escapeHtml(String(eia.mbd))}</data></td></tr>`).join('\n')}
        </tbody>
      </table></div>
      <p class="source">Baseline source: ${escapeHtml(EIA_OIL_TRANSIT_BASELINES_PATH)}. The remaining ${chokepointHubRows.length - oilTransitRows.length} tracked waterways have no row in that series; their pages say so rather than estimating one.</p>
      <h2>Why each waterway is tracked</h2>
      <dl data-chokepoint-context>
${chokepointHubRows.map((row) => {
    const blurb = CHOKEPOINT_CONTENT[row.chokepoint.id]?.blurb || '';
    const opening = blurb.match(/^[\s\S]*?\.(?=\s|$)/)?.[0]?.trim() || '';
    return `        <dt><a href="/chokepoints/${row.chokepoint.slug}/">${escapeHtml(row.chokepoint.displayName)}</a></dt>
        <dd>${escapeHtml(opening || `${row.chokepoint.displayName} is a tracked maritime chokepoint in the ${row.region} corridor.`)}</dd>`;
  }).join('\n')}
      </dl>
      <h2>How this list is scoped</h2>
      <p>The ${chokepointHubRows.length} waterways come from a committed registry, not from whatever is in the news. Each has a detail page carrying the same four-source status block, the modelled corridors that route through it, and its alternatives when it is unavailable. A waterway enters the registry because traffic there has no cheap substitute — the test is substitutability, not incident count — so the list changes rarely and changes are recorded in the corrections log.</p>
      <h2>What these pages are not</h2>
      <p>They are not a navigation product and not an open/closed declaration. A score is a triage signal built from the sources named above; it does not authorise or discourage a transit, and it carries no view on the legality or safety of any particular voyage. Transit counts are a relay observation of vessels seen, not a port authority figure, and the oil volumes above are a ${escapeHtml(String(EIA_OIL_TRANSIT_BASELINES.referenceYear))} annual-average baseline rather than current throughput.</p>
      <p class="source">Sources: ${escapeHtml(snapshotPath)} and ${CHOKEPOINT_REGISTRY_PATH}. Published ${escapeHtml(prettyDate(livePulse.capturedAt))}. Methodology: <a href="/docs/methodology/chokepoints">chokepoint disruption scoring</a>. Published revisions: <a href="/docs/corrections">corrections log</a>.</p>`;
  return pageDocument({
    baseUrl,
    path,
    title: 'Maritime Chokepoints | World Monitor',
    description,
    lastmod,
    jsonLd: [
      {
        '@context': 'https://schema.org',
        '@type': 'CollectionPage',
        name: 'Maritime chokepoints and waterways',
        description,
        url: absoluteUrl(baseUrl, path),
        inLanguage: 'en-US',
        mainEntity: { '@id': datasetId },
      },
      faqPageLd(hubFaqs),
      {
        '@context': SCHEMA_ORG_CONTEXT_URL,
        '@type': 'Dataset',
        '@id': datasetId,
        name: `World Monitor maritime chokepoint status snapshot for ${livePulse.capturedAt}`,
        description,
        url: absoluteUrl(baseUrl, path),
        identifier: 'world-monitor-chokepoint-status',
        keywords: ['maritime chokepoints', 'shipping disruption', 'AIS congestion', 'maritime risk'],
        creator: { ...WORLD_MONITOR_ORG },
        license: DATASET_LICENSE,
        datePublished: livePulse.capturedAt,
        dateModified: updatedAt,
        temporalCoverage: datasetObservationCoverage(chokepointHubRows.map((row) => row.asOf)),
        spatialCoverage: 'Worldwide',
        isAccessibleForFree: true,
        includedInDataCatalog: includedInDataCatalog(baseUrl),
        measurementTechnique: 'World Monitor chokepoint disruption scoring methodology',
        variableMeasured: [
          { '@type': 'PropertyValue', name: 'Disruption score', minValue: 0, maxValue: 100, unitText: 'index points' },
          { '@type': 'PropertyValue', name: 'Status' },
          { '@type': 'PropertyValue', name: 'AIS congestion' },
        ],
        distribution: dataDownload(absoluteUrl(baseUrl, datasetDownloadHref(path, CHOKEPOINTS_INDEX_DATASET_DOWNLOAD))),
        mainEntity: { '@id': itemListId },
      },
      {
        '@context': SCHEMA_ORG_CONTEXT_URL,
        '@type': 'ItemList',
        '@id': itemListId,
        name: 'Maritime chokepoint status snapshot',
        numberOfItems: chokepointHubRows.length,
        itemListOrder: 'https://schema.org/ItemListUnordered',
        itemListElement,
      },
      dataCatalogLd(baseUrl),
    ],
    breadcrumbs: breadcrumbLd(baseUrl, [
      { name: 'Home', path: '/' },
      { name: 'Chokepoints', path },
    ]),
    body,
  });
}

function chokepointFaqs(chokepoint, { content, routes, capturedAt, volumeObservedAt }) {
  const authored = Array.isArray(content.faqs) ? content.faqs.slice(0, 2) : [];
  const datedVolume = volumeObservedAt ? prettyDate(volumeObservedAt) : 'the committed trade-route table';
  const datedCapture = capturedAt ? prettyDate(capturedAt) : 'the committed registry snapshot';
  const generated = routes.length
    ? {
      question: `Which modelled trade routes use ${chokepoint.displayName}?`,
      answer: `${chokepoint.displayName} is a waypoint on ${routes.map((route) => `${route.name} (${route.volumeDesc})`).join('; ')}. Those corridor volumes are World Monitor modelled figures dated ${datedVolume} in ${TRADE_ROUTES_PATH}.`,
    }
    : {
      question: `How should readers use the ${chokepoint.displayName} reference snapshot?`,
      answer: `Read the ${datedCapture} registry copy with the live disruption pulse. ${chokepoint.displayName} is tracked as a strategic waterway reference; modelled corridor rows are absent until TRADE_ROUTES gains a waypoint, which is not a claim that traffic is zero.`,
    };
  return [...authored, generated].slice(0, 3);
}

function chokepointRouteTable({ chokepoint, routes, capturedAt, volumeObservedAt }) {
  const datedStamp = volumeObservedAt || capturedAt;
  const datedVolume = datedStamp ? timeMarkup(datedStamp) : 'the committed trade-route table';
  if (!routes.length) {
    return `<p>${escapeHtml(chokepoint.displayName)} is tracked as a strategic waterway reference. It is not currently mapped to one of World Monitor's modelled trade-route corridors, but its vessel traffic and disruption signals are still monitored on the live map.</p>
      <div class="table-scroll"><table data-chokepoint-routes>
        <caption>No modelled corridor is currently mapped through ${escapeHtml(chokepoint.displayName)}. Waterway reference dated ${datedVolume}.</caption>
        <thead><tr><th scope="col">Route</th><th scope="col">Category</th><th scope="col">Modelled volume</th><th scope="col">As of</th></tr></thead>
        <tbody>
          <tr><td colspan="4">Strategic waterway reference — corridor book unmapped, as of ${datedVolume}</td></tr>
        </tbody>
      </table></div>`;
  }
  return `<div class="table-scroll"><table data-chokepoint-routes>
        <caption>Modelled trade-route corridors through ${escapeHtml(chokepoint.displayName)}. Volumes are World Monitor corridor figures as of ${datedVolume}.</caption>
        <thead><tr><th scope="col">Route</th><th scope="col">Category</th><th scope="col">Modelled volume</th><th scope="col">As of</th></tr></thead>
        <tbody>
${routes.map((route) => {
    const category = route.category
      ? route.category.charAt(0).toUpperCase() + route.category.slice(1)
      : '—';
    const asOf = volumeObservedAt ? timeMarkup(volumeObservedAt) : '—';
    return `          <tr><td>${escapeHtml(route.name)}</td><td>${escapeHtml(category)}</td><td><data value="${escapeHtml(route.volumeDesc)}">${escapeHtml(route.volumeDesc)}</data></td><td>${asOf}</td></tr>`;
  }).join('\n')}
        </tbody>
      </table></div>`;
}

function renderChokepointAnalysis({
  chokepoint,
  content,
  routes,
  capturedAt,
  volumeObservedAt,
}) {
  const faqs = chokepointFaqs(chokepoint, { content, routes, capturedAt, volumeObservedAt });
  const whyHeading = content.whyHeading
    || `Why does ${chokepoint.displayName} matter for shipping?`;
  const analysisParagraphs = Array.isArray(content.analysis) ? content.analysis : [];
  const coords = formatCoordinates(chokepoint.lat, chokepoint.lon);
  const region = content.region || 'its connected waters';
  const datedCapture = capturedAt ? timeMarkup(capturedAt) : 'the committed registry snapshot';
  const shockClause = chokepoint.shockModelSupported
    ? 'World Monitor enables the energy shock model on this waterway.'
    : 'World Monitor does not enable the energy shock model on this waterway.';
  const routeClause = routes.length
    ? `The ${datedCapture} reference maps ${routes.length} modelled trade-route corridor${routes.length === 1 ? '' : 's'} onto this waypoint.`
    : `The ${datedCapture} reference maps no modelled trade-route corridor onto this waypoint.`;
  const eia = EIA_OIL_TRANSIT_BASELINES.byRegistryId[chokepoint.id];
  const eiaYear = String(EIA_OIL_TRANSIT_BASELINES.referenceYear);
  const eiaParagraph = eia
    ? `<p>The ${timeMarkup(eiaYear, eiaYear)} ${escapeHtml(EIA_OIL_TRANSIT_BASELINES.source)} series records ${escapeHtml(String(eia.mbd))} million barrels a day on the ${escapeHtml(eia.eiaName)} row. ${escapeHtml(shockClause)}</p>`
    : `<p>${escapeHtml(shockClause)} This waterway has no row in the committed ${escapeHtml(String(EIA_OIL_TRANSIT_BASELINES.referenceYear))} ${escapeHtml(EIA_OIL_TRANSIT_BASELINES.source)} series.</p>`;
  const html = `      <article data-chokepoint-analysis>
        <h2>${escapeHtml(whyHeading)}</h2>
        <p>${escapeHtml(chokepoint.displayName)} sits at ${escapeHtml(coords)} and connects ${escapeHtml(region)}. ${routeClause}</p>
${analysisParagraphs.map((paragraph) => `        <p>${escapeHtml(paragraph)}</p>`).join('\n')}
        ${eiaParagraph}
        ${content.alternative ? `<p>${escapeHtml(content.alternative)}</p>` : ''}
        <h3>Major trade routes through ${escapeHtml(chokepoint.displayName)}</h3>
        ${chokepointRouteTable({ chokepoint, routes, capturedAt, volumeObservedAt })}
        <h3>How to read this page</h3>
        <p>The crawlable Dataset is the ${datedCapture} registry-and-route snapshot under the <a href="/docs/methodology/chokepoints">chokepoint disruption methodology</a>. Live pulse tiles are a separately frozen observation and are not copied into this Dataset. Modelled corridor volumes are dated ${volumeObservedAt ? timeMarkup(volumeObservedAt) : 'with the committed trade-route table'}.</p>
        <p class="snapshot-note">Template revision ${escapeHtml(CHOKEPOINT_PAGE_CONTENT_VERSION)}. Reference observation ${capturedAt ? timeMarkup(capturedAt) : 'unspecified'}. This note is a methodology-revision stamp, not a live AIS clock. Published revisions that affect this page are in the <a href="/docs/corrections">corrections log</a>.</p>
        <h3>Questions about ${escapeHtml(chokepoint.displayName)}</h3>
${faqs.map((faq) => `        <details data-chokepoint-faq><summary>${escapeHtml(faq.question)}</summary><p>${escapeHtml(faq.answer)}</p></details>`).join('\n')}
      </article>`;
  return { html, faqs };
}

// The upstream status note is optional. A snapshot without one must publish no
// paragraph at all — until #7530 an absent note froze as "No additional status
// note was supplied." and rendered as real body prose in <main> on 7 of the 13
// chokepoint pages, where it was frequently the only sentence the live section
// contributed.
// Snapshots frozen before that change still carry the sentence verbatim, so
// treat it as the absence it always described rather than waiting for a
// refresh to age it out.
export const LEGACY_ABSENT_STATUS_NOTE = 'No additional status note was supplied.';

function chokepointDescriptionParagraph(description) {
  const raw = typeof description === 'string' ? description.trim() : '';
  const text = raw === LEGACY_ABSENT_STATUS_NOTE ? '' : raw;
  return text
    ? `        <p data-chokepoint-description>${escapeHtml(text)}</p>`
    : '        <p data-chokepoint-description hidden></p>';
}

function optionalChokepointMetric(label, attribute, value, available) {
  return `          <div class="metric"${available ? '' : ' hidden'}><span>${escapeHtml(label)}</span><strong ${attribute}>${available ? escapeHtml(value) : ''}</strong></div>`;
}

function renderChokepointPage({
  chokepoint,
  baseUrl,
  lastmod,
  tradeRoutesById,
  researchReports = [],
  livePulse = null,
  capturedAt = null,
  volumeObservedAt = null,
}) {
  const path = `/chokepoints/${chokepoint.slug}/`;
  const content = CHOKEPOINT_CONTENT[chokepoint.id] || {};
  const blurb = content.blurb
    || `${chokepoint.displayName} is one of the 13 canonical maritime chokepoints tracked by World Monitor.`;
  const description = chokepointMetaDescription(chokepoint.displayName);
  const mapUrl = withUtmSource(
    absoluteUrl(baseUrl, `/?chokepoint=${encodeURIComponent(chokepoint.id)}`),
    'seo-chokepoint',
  );

  const routes = chokepoint.routeIds
    .map((id) => tradeRoutesById.get(id))
    .filter(Boolean);
  const analysis = renderChokepointAnalysis({
    chokepoint,
    content,
    routes,
    capturedAt,
    volumeObservedAt,
  });

  const tiles = [
    content.region ? metricTile('Connects', content.region) : null,
    metricTile('Position', formatCoordinates(chokepoint.lat, chokepoint.lon)),
    metricTile('Energy shock model', chokepoint.shockModelSupported ? 'Yes' : 'No'),
  ].filter(Boolean).join('\n');

  const relatedItems = [];
  for (const { report } of researchReports) {
    if (report.focusChokepointId === chokepoint.id) {
      relatedItems.push(`<a href="/research/${report.slug}/">${escapeHtml(report.title)}</a>`);
    }
  }
  if (content.glossarySlug) {
    relatedItems.push(`<a href="/blog/glossary/${content.glossarySlug}/">${escapeHtml(chokepoint.displayName)} in the glossary</a>`);
  }
  relatedItems.push('<a href="/blog/glossary/maritime-chokepoint/">What is a maritime chokepoint?</a>');

  const pulse = livePulse?.chokepoints?.[chokepoint.id] || null;
  const hasPulse = hasObservedValue(pulse?.disruptionScore, { coverage: pulse != null });
  const coverageMetrics = chokepointCoverageMetrics({
    todayTransits: pulse?.todayTransits,
    todayCountsAvailable: pulse?.todayCountsAvailable,
    navigationalWarnings: pulse?.navigationalWarnings,
    navigationalWarningsAvailable: pulse?.navigationalWarningsAvailable === true,
    aisDisruptions: pulse?.aisDisruptions,
    aisSnapshotAvailable: pulse?.aisSnapshotAvailable === true,
    congestionLevel: pulse?.congestion,
    weekMovement: pulse?.weekMovement ?? null,
  });
  const transitsLabel = coverageMetrics.todayTransits;
  const transitsWithheld = hasPulse && transitsLabel == null;
  const pulsePartial = pulse?.partial === true
    || transitsWithheld
    || coverageMetrics.navigationalWarnings === null
    || coverageMetrics.aisDisruptions === null;
  const liveState = hasPulse ? (pulsePartial ? 'partial' : 'ready') : 'loading';
  const liveStatus = hasPulse
    ? (pulsePartial ? 'Published partial pulse' : 'Published pulse')
    : 'Waiting for live enhancement';
  const transitsNote = transitsWithheld
    ? `        <p data-chokepoint-transits-note>${escapeHtml(withheldTransitCountSentence(chokepoint.displayName))}</p>`
    : '        <p data-chokepoint-transits-note hidden></p>';
  const narrative = hasPulse
    ? chokepointEvidenceNarrative({
      displayName: chokepoint.displayName,
      score: pulse.disruptionScore,
      bandLabel: pulse.status,
      description: pulse.description,
      asOfText: formatStaticDateTime(pulse.asOf),
      partial: pulsePartial,
      warningsLabel: coverageMetrics.navigationalWarnings,
      congestionLabel: coverageMetrics.congestion,
      aisEventCountLabel: coverageMetrics.aisDisruptions,
      todayTransits: transitsLabel,
    })
    : null;
  const openStatusHtml = narrative !== null
    ? escapeHtml(narrative.passage)
    : `World Monitor has not published current passage evidence for ${escapeHtml(chokepoint.displayName)} yet.`;
  const openStatusSection = `        <h2>Is ${escapeHtml(chokepoint.displayName)} open right now?</h2>
        <p data-chokepoint-open-status>${openStatusHtml}</p>
${narrative !== null
    ? `        <p data-chokepoint-score-driver>${escapeHtml(narrative.scoreDriver)}</p>`
    : '        <p data-chokepoint-score-driver hidden></p>'}`;
  const liveGrid = hasPulse
    ? `        <div class="grid" data-live-grid aria-label="Current chokepoint status" aria-busy="false">
          <div class="metric"><span>Disruption score</span><strong><span data-chokepoint-score>${escapeHtml(formatScore(pulse.disruptionScore, { coverage: hasPulse }))}</span><small data-chokepoint-band>${escapeHtml(pulse.status)}</small></strong></div>
${optionalChokepointMetric('Navigational warnings', 'data-chokepoint-warnings', coverageMetrics.navigationalWarnings, coverageMetrics.navigationalWarnings !== null)}
${optionalChokepointMetric('AIS disruptions', 'data-chokepoint-ais-disruptions', coverageMetrics.aisDisruptions, coverageMetrics.aisDisruptions !== null)}
${optionalChokepointMetric('AIS congestion', 'data-chokepoint-congestion', coverageMetrics.congestion, coverageMetrics.congestion !== null)}
          <div class="metric"><span>Today's transits</span><strong data-chokepoint-transits>${escapeHtml(transitsLabel ?? '—')}</strong></div>
          <div class="metric"><span>Week-over-week movement</span><strong data-chokepoint-movement>${escapeHtml(coverageMetrics.weekMovement ?? (transitsWithheld ? '—' : 'Unavailable'))}</strong></div>
        </div>
${chokepointDescriptionParagraph(pulse.description)}
${transitsNote}`
    : `        <p class="tool-note" data-live-fallback>Current disruption metrics load after page enhancement. The static waterway and route context below remains the dated crawlable reference.</p>
        <div class="grid" data-live-grid hidden aria-label="Current chokepoint status" aria-busy="true">
          <div class="metric"><span>Disruption score</span><strong><span data-chokepoint-score></span><small data-chokepoint-band></small></strong></div>
${optionalChokepointMetric('Navigational warnings', 'data-chokepoint-warnings', '', false)}
${optionalChokepointMetric('AIS disruptions', 'data-chokepoint-ais-disruptions', '', false)}
${optionalChokepointMetric('AIS congestion', 'data-chokepoint-congestion', '', false)}
          <div class="metric"><span>Today's transits</span><strong data-chokepoint-transits></strong></div>
          <div class="metric"><span>Week-over-week movement</span><strong data-chokepoint-movement></strong></div>
        </div>
        <p data-chokepoint-description hidden></p>
        <p data-chokepoint-transits-note hidden></p>`;

  const body = `      <p class="eyebrow">Chokepoint</p>
      <h1>${escapeHtml(chokepoint.displayName)}</h1>
      <p class="lede">${escapeHtml(blurb)}</p>
      <section class="live-tool" data-live-chokepoint data-chokepoint-id="${escapeHtml(chokepoint.id)}" data-chokepoint-name="${escapeHtml(chokepoint.displayName)}" data-state="${liveState}"${hasPulse ? ' data-published-pulse' : ''}>
${openStatusSection}
        <div class="tool-head">
          <div>
            <p class="eyebrow">Current status</p>
            <h2>${escapeHtml(chokepoint.displayName)} disruption pulse</h2>
          </div>
          <span class="live-status" data-live-status role="status" aria-live="polite">${escapeHtml(liveStatus)}</span>
        </div>
        <p class="tool-note">Transit metrics appear only when the current vessel snapshot has coverage.</p>
${liveGrid}
        <div class="tool-meta">
          ${liveUpdatedMarkup({
            asOf: pulse?.asOf || null,
            fallbackLabel: 'Live enhancement pending',
            prefix: 'Published pulse',
          })}
          <button class="refresh" type="button" data-live-refresh disabled>Refresh live data</button>
        </div>
        <noscript><p>Enable JavaScript to refresh the current API result. ${hasPulse ? 'The published pulse above remains available without JavaScript.' : 'The static waterway and route context remains available below.'}</p></noscript>
      </section>
      <a class="cta" href="${escapeHtml(mapUrl)}">Open ${escapeHtml(chokepoint.displayName)} on the live map →</a>
      <section class="grid" aria-label="Chokepoint overview">
${tiles}
      </section>
${analysis.html}
      <h2>Related</h2>
      <ul class="related">
${relatedItems.map((item) => `        <li>${item}</li>`).join('\n')}
      </ul>
      <p class="source">Download: <a href="${escapeHtml(datasetDownloadHref(path, CHOKEPOINT_DATASET_DOWNLOAD))}">${CHOKEPOINT_DATASET_DOWNLOAD}</a>. Source: ${CHOKEPOINT_REGISTRY_PATH} and ${TRADE_ROUTES_PATH}. Captured ${capturedAt ? escapeHtml(capturedAt) : 'unspecified'}. Methodology: <a href="/docs/methodology/chokepoints">how chokepoint disruption is scored</a>.</p>`;
  const hasCoordinates = Number.isFinite(chokepoint.lat) && Number.isFinite(chokepoint.lon);
  const geoCoordinates = hasCoordinates
    ? {
        '@type': 'GeoCoordinates',
        latitude: chokepoint.lat,
        longitude: chokepoint.lon,
      }
    : undefined;
  const geoShape = hasCoordinates ? chokepointGeoShape(chokepoint.lat, chokepoint.lon) : undefined;
  const additionalProperty = [
    content.region ? propertyValue('Connects', content.region) : null,
    routes.length
      ? propertyValue(
        'Modelled trade routes',
        routes.map((route) => route.name).join('; '),
      )
      : null,
  ].filter(Boolean);
  const referenceDownload = absoluteUrl(baseUrl, datasetDownloadHref(path, CHOKEPOINT_DATASET_DOWNLOAD));
  const datasetId = `${absoluteUrl(baseUrl, path)}#chokepoint-dataset`;
  const coordinatesValue = formatCoordinates(chokepoint.lat, chokepoint.lon);
  const variableMeasured = [
    { '@type': 'PropertyValue', name: 'Geographic coordinates', value: coordinatesValue },
    ...(content.region
      ? [{ '@type': 'PropertyValue', name: 'Connected waters', value: content.region }]
      : []),
    { '@type': 'PropertyValue', name: 'Energy shock model support', value: chokepoint.shockModelSupported ? 'Yes' : 'No' },
    { '@type': 'PropertyValue', name: 'Modelled trade routes', value: routes.length },
  ];
  const dataset = {
    '@type': 'Dataset',
    '@id': datasetId,
    name: `World Monitor chokepoint reference for ${chokepoint.displayName}`,
    description: `A World Monitor maritime reference dataset for ${chokepoint.displayName}, with its position, connected waters, energy shock model support, and modelled trade-route corridors.`,
    url: absoluteUrl(baseUrl, path),
    identifier: chokepoint.id,
    keywords: ['maritime chokepoint', chokepoint.displayName, 'shipping route', 'trade corridor'],
    creator: { ...WORLD_MONITOR_ORG },
    license: DATASET_LICENSE,
    datePublished: capturedAt || undefined,
    dateModified: laterDate(lastmod, DATASET_SCHEMA_CONTENT_VERSION.chokepoint),
    temporalCoverage: datasetTemporalCoverage(capturedAt),
    isAccessibleForFree: true,
    includedInDataCatalog: includedInDataCatalog(baseUrl),
    variableMeasured,
    spatialCoverage: {
      '@type': 'Place',
      name: chokepoint.displayName,
      identifier: chokepoint.id,
      geo: [geoCoordinates, geoShape].filter(Boolean),
    },
    distribution: [
      dataDownload(referenceDownload),
    ],
  };
  return pageDocument({
    baseUrl,
    path,
    title: `${chokepoint.displayName} Chokepoint Status | World Monitor`,
    description,
    lastmod,
    extraStyles: `
      details[data-chokepoint-faq] { margin-top: 10px; border: 1px solid var(--line); border-radius: 8px; padding: 10px 14px; background: var(--panel); }
      details[data-chokepoint-faq] summary { cursor: pointer; color: var(--text); font-weight: 600; }
      details[data-chokepoint-faq] p { margin: 8px 0 0; }
`,
    jsonLd: [
      {
        '@context': 'https://schema.org',
        '@type': 'WebPage',
        name: `${chokepoint.displayName} chokepoint`,
        description,
        url: absoluteUrl(baseUrl, path),
        inLanguage: 'en-US',
        about: {
          '@type': 'Place',
          name: chokepoint.displayName,
          identifier: chokepoint.id,
          geo: [geoCoordinates, geoShape].filter(Boolean),
          additionalProperty: additionalProperty.length ? additionalProperty : undefined,
        },
        mainEntity: dataset,
      },
      faqPageLd(analysis.faqs),
      dataCatalogLd(baseUrl),
    ],
    breadcrumbs: breadcrumbLd(baseUrl, [
      { name: 'Home', path: '/' },
      { name: 'Chokepoints', path: '/chokepoints/' },
      { name: chokepoint.displayName, path },
    ]),
    body,
    scriptSrcs: ['/tools/live-tools.js'],
  });
}

function countrySelectOptions(countryBounds, { includeWorldwide = false, defaultCode = '' } = {}) {
  const worldwide = includeWorldwide
    ? '          <option value="">Worldwide</option>\n'
    : '';
  return worldwide + countryBounds.map((country) => {
    const selected = country.code === defaultCode ? ' selected' : '';
    return `          <option value="${escapeHtml(country.code)}" data-bounds="${escapeHtml(country.bounds.join(','))}"${selected}>${escapeHtml(country.name)}</option>`;
  }).join('\n');
}

function renderCrisesIndex({ crises, baseUrl, lastmod }) {
  const path = '/crises/';
  const description = 'Curated, bounded crisis trackers that combine stable coverage definitions with World Monitor’s maintained country-level humanitarian summaries.';
  const body = `      <p class="eyebrow">Bounded trackers</p>
      <h1>Current crisis trackers</h1>
      <p class="lede">${escapeHtml(description)}</p>
      <p>Each tracker has a fixed, reviewable geographic boundary. The static page explains that boundary and ships a dated maintained-month pulse; JavaScript can refresh newer values and fails closed when a country summary is unavailable.</p>
      <div class="grid">
${crises.map((crisis) => `        <a class="card" href="/crises/${escapeHtml(crisis.slug)}/"><strong>${escapeHtml(crisis.shortTitle)}</strong><br><span>${escapeHtml(crisis.coverage.map((country) => country.name).join(', '))}</span></a>`).join('\n')}
      </div>
      <h2>How these trackers are scoped</h2>
      <p>Every tracker names its covered countries up front and never silently widens. Metrics are monthly country-level conflict summaries — recorded events, political-violence events, fatalities, and demonstrations — from the UN OCHA <a href="https://data.humdata.org/hapi">Humanitarian API (HDX HAPI)</a>. A combined total is shown only when every covered country reports the same reference month; otherwise per-country figures stand alone.</p>
      <h2>What they are not</h2>
      <p>These are bounded pulses, not battlefield maps, casualty ledgers, or forecasts. Missing countries are reported as unavailable rather than zero, and event-level context lives in the <a href="/?utm_source=seo-crisis">live dashboard</a> with its map layers and independent signals.</p>
      <p class="source">Scope source: <a href="${CRISIS_REGISTRY_URL}">${CRISIS_REGISTRY_PATH}</a>. Live metrics: HAPI/HDX humanitarian conflict summaries through the World Monitor API.</p>`;
  return pageDocument({
    baseUrl,
    path,
    title: 'Current Crisis Trackers | World Monitor',
    description,
    lastmod,
    jsonLd: [
      {
        '@context': 'https://schema.org',
        '@type': 'CollectionPage',
        name: 'Current crisis trackers',
        description,
        url: absoluteUrl(baseUrl, path),
        inLanguage: 'en-US',
      },
      dataCatalogLd(baseUrl),
    ],
    breadcrumbs: breadcrumbLd(baseUrl, [
      { name: 'Home', path: '/' },
      { name: 'Crises', path },
    ]),
    body,
  });
}

function renderCrisisPage({
  crisis,
  baseUrl,
  lastmod,
  livePulse = null,
  livePulseSnapshotPath = null,
  publishedTotals,
}) {
  const path = `/crises/${crisis.slug}/`;
  const dashboardUrl = withUtmSource(absoluteUrl(baseUrl, crisis.dashboardPath), 'seo-crisis');
  const pulse = livePulse?.crises?.[crisis.slug] || null;
  // Require a real observation window. crisisTrackerViewModel substitutes the
  // sentinel 'Mixed reference periods' when covered countries report different
  // HAPI months; publishing that as a period would put it in the page prose and
  // the Dataset description while temporalCoverage silently drops to undefined.
  const hasPulse = pulse != null && OBSERVATION_PERIOD_RE.test(String(pulse.referencePeriod ?? ''));
  const publishedPeriod = hasPulse ? datasetTemporalCoverage(pulse.referencePeriod) : undefined;
  const publishedDate = hasPulse ? pulseDateOnly(livePulse.capturedAt, undefined) : undefined;
  const liveState = hasPulse ? pulse.state : 'loading';
  const liveStatus = hasPulse
    ? (pulse.state === 'partial' ? 'Published partial pulse' : 'Published pulse')
    : 'Waiting for live enhancement';
  const rowByCode = new Map((pulse?.rows || []).map((row) => [row.code, row]));
  const countFormatter = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
  const formatCount = (value, evidence, fallback = '—') => formatObservedNumber(
    value,
    evidence,
    (numeric) => countFormatter.format(numeric),
    fallback,
  );
  const countryRows = crisis.coverage.map((country) => {
    const row = rowByCode.get(country.code);
    const value = row
      ? `${formatCount(row.events, OBSERVED_EVIDENCE)} events · ${formatCount(row.fatalities, OBSERVED_EVIDENCE)} fatalities · ${row.referencePeriod}`
      : (hasPulse ? 'Unavailable' : 'Waiting for published pulse');
    return `          <li data-crisis-country data-country-code="${escapeHtml(country.code)}" data-country-name="${escapeHtml(country.name)}"><strong>${escapeHtml(country.name)}</strong><br><span data-crisis-country-value>${escapeHtml(value)}</span></li>`;
  }).join('\n');
  const liveGrid = hasPulse
    ? `        <div class="grid" data-live-grid aria-label="Current crisis metrics" aria-busy="false">
          <div class="metric"><span>Recorded events</span><strong data-crisis-events>${escapeHtml(formatCount(pulse.eventsTotal, { coverage: hasPulse }, 'See countries'))}</strong></div>
          <div class="metric"><span>Recorded fatalities</span><strong data-crisis-fatalities>${escapeHtml(formatCount(pulse.fatalities, { coverage: hasPulse }, 'See countries'))}</strong></div>
          <div class="metric"><span>Political violence events</span><strong data-crisis-political>${escapeHtml(formatCount(pulse.politicalViolenceEvents, { coverage: hasPulse }, 'See countries'))}</strong></div>
          <div class="metric"><span>Reference period</span><strong data-crisis-period>${escapeHtml(pulse.referencePeriod)}</strong></div>
        </div>`
    : `        <p class="tool-note" data-live-fallback>Current monthly conflict metrics load after page enhancement. The tracker scope below remains the dated crawlable reference.</p>
        <div class="grid" data-live-grid hidden aria-label="Current crisis metrics" aria-busy="true">
          <div class="metric"><span>Recorded events</span><strong data-crisis-events></strong></div>
          <div class="metric"><span>Recorded fatalities</span><strong data-crisis-fatalities></strong></div>
          <div class="metric"><span>Political violence events</span><strong data-crisis-political></strong></div>
          <div class="metric"><span>Reference period</span><strong data-crisis-period></strong></div>
        </div>`;
  const coverageLabel = hasPulse
    ? (pulse.missingCountries?.length
      ? `Unavailable: ${pulse.missingCountries.join(', ')}`
      : `${pulse.rows.length} ${pulse.rows.length === 1 ? 'country' : 'countries'} available`)
    : `${crisis.coverage.length} ${crisis.coverage.length === 1 ? 'country' : 'countries'} requested`;
  const snapshotSection = hasPulse
    ? `      <h2>Maintained month snapshot</h2>
      <p>This page records the committed ${escapeHtml(pulse.referencePeriod)} HAPI/HDX country summaries published ${escapeHtml(prettyDate(livePulse.capturedAt))}. JavaScript can refresh newer values; the numbers above remain available without it.</p>
      <p class="snapshot-note">Source: ${escapeHtml(livePulseSnapshotPath || 'docs/snapshots/crawlable-live-pulse-*.json')}. Combined totals are withheld when covered countries report different reference months.</p>`
    : '';
  const body = `      <p class="eyebrow">Bounded crisis tracker</p>
      <h1>${escapeHtml(crisis.title)}</h1>
      <p class="lede">${escapeHtml(crisis.description)}</p>
      <p>${escapeHtml(crisis.overview)}</p>
      <section class="live-tool" data-live-crisis data-state="${escapeHtml(liveState)}"${hasPulse ? ' data-published-pulse' : ''}>
        <div class="tool-head">
          <div>
            <p class="eyebrow">Latest maintained month</p>
            <h2>Country conflict pulse</h2>
          </div>
          <span class="live-status" data-live-status role="status" aria-live="polite">${escapeHtml(liveStatus)}</span>
        </div>
        <p class="tool-note">Metrics are country-level records for the latest available HAPI/HDX reference month. Missing countries are unavailable, not zero. A combined total is withheld when reference periods differ.</p>
${liveGrid}
        <ul class="result-list" aria-label="Country coverage">
${countryRows}
        </ul>
        <div class="tool-meta">
          <span data-crisis-coverage>${escapeHtml(coverageLabel)}</span>
          ${liveUpdatedMarkup({
            asOf: pulse?.asOf || null,
            fallbackLabel: 'Live enhancement pending',
            prefix: 'Published pulse',
          })}
          <button class="refresh" type="button" data-live-refresh disabled>Refresh live data</button>
        </div>
        <noscript><p>Enable JavaScript to refresh current monthly summaries. ${hasPulse ? 'The published pulse above remains available without JavaScript.' : 'The tracker scope and methodology remain available on this page.'}</p></noscript>
      </section>
      <a class="cta" href="${escapeHtml(dashboardUrl)}">Investigate this crisis in World Monitor →</a>
${snapshotSection}
      <h2>Coverage boundary</h2>
      <p>${escapeHtml(crisis.coverage.map((country) => `${country.name} (${country.code})`).join(', '))}. Events outside this list are not included in the live totals on this page.</p>
      <h2>How to read this tracker</h2>
      <p>Use these monthly country summaries as a bounded pulse, then inspect the dashboard for event-level context, map layers, and other independent signals. The figures are not forecasts and should not be interpreted as a complete casualty or incident ledger.</p>
      <p class="source">Download: <a href="${escapeHtml(datasetDownloadHref(path, CRISIS_DATASET_DOWNLOAD))}">${CRISIS_DATASET_DOWNLOAD}</a>. Scope source: <a href="${CRISIS_REGISTRY_URL}">${CRISIS_REGISTRY_PATH}</a>. Maintained metrics: HAPI/HDX humanitarian conflict summaries from the UN OCHA <a href="https://data.humdata.org/hapi">Humanitarian API</a>.</p>`;
  const coveragePlaces = crisis.coverage.map((country) => ({
    '@type': 'Country',
    name: country.name,
    identifier: country.code,
  }));
  // Dataset.spatialCoverage must stay a literal Place for Google; WebPage.about keeps Country.
  const coverageSpatial = coveragePlaces.map((place) => ({ ...place, '@type': 'Place' }));
  const distribution = [
    dataDownload(absoluteUrl(baseUrl, datasetDownloadHref(path, CRISIS_DATASET_DOWNLOAD))),
  ];
  const variableMeasured = [
    {
      '@type': 'PropertyValue',
      name: 'Tracker scope',
      value: crisis.shortTitle || crisis.title,
    },
    {
      '@type': 'PropertyValue',
      name: 'Covered countries',
      value: crisis.coverage.length,
      unitText: 'countries',
    },
    ...(hasPulse ? [
      {
        '@type': 'PropertyValue',
        name: 'Recorded conflict events',
        value: publishedTotals.eventsTotal ?? 'Unavailable',
        unitText: 'events',
      },
      {
        '@type': 'PropertyValue',
        name: 'Recorded fatalities',
        value: publishedTotals.fatalities ?? 'Unavailable',
        unitText: 'fatalities',
      },
      {
        '@type': 'PropertyValue',
        name: 'Political violence events',
        value: publishedTotals.politicalViolenceEvents ?? 'Unavailable',
        unitText: 'events',
      },
      {
        '@type': 'PropertyValue',
        name: 'Humanitarian reference period',
        value: pulse.referencePeriod,
      },
    ] : []),
  ];
  const datasetDescription = hasPulse
    ? `A bounded World Monitor crisis tracker for ${crisis.title}, with the maintained ${pulse.referencePeriod} HAPI/HDX country summaries across ${crisis.coverage.map((country) => country.name).join(', ')}.`
    : `A bounded World Monitor crisis tracker reference for ${crisis.title}, defining the maintained geographic scope across ${crisis.coverage.map((country) => country.name).join(', ')}.`;
  return pageDocument({
    baseUrl,
    path,
    title: `${crisis.title} | World Monitor`,
    description: crisis.description,
    lastmod,
    jsonLd: [
      {
        '@context': 'https://schema.org',
        '@type': 'WebPage',
        name: crisis.title,
        description: crisis.description,
        url: absoluteUrl(baseUrl, path),
        inLanguage: 'en-US',
        about: coveragePlaces,
        mainEntity: {
          '@type': 'Dataset',
          '@id': `${absoluteUrl(baseUrl, path)}#crisis-dataset`,
          name: `World Monitor crisis tracker reference: ${crisis.shortTitle || crisis.title}`,
          description: datasetDescription,
          url: absoluteUrl(baseUrl, path),
          identifier: `crisis-tracker-${crisis.slug}`,
          keywords: ['crisis tracker', crisis.shortTitle || crisis.title, 'humanitarian conflict', ...crisis.coverage.map((country) => country.name)],
          creator: { ...WORLD_MONITOR_ORG },
          license: DATASET_LICENSE,
          datePublished: publishedDate,
          dateModified: laterDate(
            hasPulse ? pulseDateOnly(pulse.asOf, lastmod) : lastmod,
            DATASET_SCHEMA_CONTENT_VERSION.crisis,
          ),
          temporalCoverage: publishedPeriod,
          isAccessibleForFree: true,
          includedInDataCatalog: includedInDataCatalog(baseUrl),
          variableMeasured,
          measurementTechnique: 'Monthly country-level HAPI/HDX humanitarian conflict summaries; combined totals are published only when covered countries share a reference period.',
          spatialCoverage: coverageSpatial.length === 1 ? coverageSpatial[0] : coverageSpatial,
          distribution,
        },
      },
      dataCatalogLd(baseUrl),
    ],
    breadcrumbs: breadcrumbLd(baseUrl, [
      { name: 'Home', path: '/' },
      { name: 'Crises', path: '/crises/' },
      { name: crisis.shortTitle, path },
    ]),
    body,
    scriptSrcs: ['/tools/live-tools.js'],
  });
}

function renderToolsIndex({ baseUrl, lastmod }) {
  const path = '/tools/';
  const description = 'Focused World Monitor tools for current natural hazards, country-level airspace disruption, and geographic signal convergence, backed by maintained first-party data contracts.';
  const body = `      <p class="eyebrow">Live intelligence tools</p>
      <h1>Check a current operational signal</h1>
      <p class="lede">${escapeHtml(description)}</p>
      <div class="grid">
        <a class="card" href="/tools/natural-hazard-pulse/"><strong>Natural-hazard pulse</strong><br><span>Worldwide or approximate country filter</span></a>
        <a class="card" href="/tools/airspace-disruption-checker/"><strong>Airspace-disruption checker</strong><br><span>Commercial airport disruption and observed military flights</span></a>
        <a class="card" href="/tools/signal-convergence/"><strong>Geographic signal convergence</strong><br><span>Named multi-domain correlation score</span></a>
        <a class="card" href="/chokepoints/"><strong>Maritime chokepoint status</strong><br><span>13 canonical waterways</span></a>
        <a class="card" href="/crises/"><strong>Bounded crisis trackers</strong><br><span>Four curated geographic scopes</span></a>
      </div>
      <h2>How these tools work</h2>
      <p>Each tool asks one narrow operational question — what natural hazards are open right now, is a country's monitored airspace disrupted, where independent streams converge — and answers it from a maintained World Monitor contract. Results are labelled with their source and retrieval time, unavailable data is reported as unavailable rather than zero, and independent signals are never combined into a single opaque threat score unless the tool names that combination explicitly.</p>
      <h2>When to use them</h2>
      <p>Use these pages for a fast, shareable check before a trip, a shipment, or a market open; use the <a href="/?utm_source=seo-tool">live dashboard</a> when you need the full picture — map layers, alerts, news, and country briefs side by side. Hazard coverage is documented in <a href="/docs/natural-disasters">natural disaster tracking</a>; chokepoint scoring in the <a href="/docs/methodology/chokepoints">chokepoint methodology</a>; convergence scoring in <a href="/docs/geographic-convergence">geographic convergence</a>.</p>
      <p class="source">Live results load from maintained World Monitor API contracts. Static route descriptions remain available if a current source cannot be reached.</p>`;
  return pageDocument({
    baseUrl,
    path,
    title: 'Live Intelligence Tools | World Monitor',
    description,
    lastmod,
    jsonLd: {
      '@context': 'https://schema.org',
      '@type': 'CollectionPage',
      name: 'Live intelligence tools',
      description,
      url: absoluteUrl(baseUrl, path),
      inLanguage: 'en-US',
    },
    breadcrumbs: breadcrumbLd(baseUrl, [
      { name: 'Home', path: '/' },
      { name: 'Live tools', path },
    ]),
    body,
  });
}

function renderSignalConvergencePage({ signalConvergence, baseUrl, lastmod, snapshotPath }) {
  const path = '/tools/signal-convergence/';
  const metricName = signalConvergence.metricName || 'Geographic Convergence Score';
  const description = `World Monitor's ${metricName} (0-100) names when protests, military flights, naval vessels, and earthquakes co-occur in the same 1° cell.`;
  const downloadHref = datasetDownloadHref(path, CONVERGENCE_DATASET_DOWNLOAD);
  const datasetUrl = absoluteUrl(baseUrl, path);
  const datasetId = `${datasetUrl}#signal-convergence-dataset`;
  const examples = (signalConvergence.referenceExamples || []).map((example) => (
    `        <article class="card">
          <p class="eyebrow">${escapeHtml(example.kind === 'methodology-example' ? 'Methodology example' : 'Reference')}</p>
          <h3>${escapeHtml(example.label)}</h3>
          <p>Cell ${escapeHtml(example.cell)}. Domains: ${escapeHtml(example.types.join(', '))}. Events: ${escapeHtml(String(example.totalEvents))}.</p>
          <div class="grid">
            <div class="metric"><span>${escapeHtml(metricName)}</span><strong>${escapeHtml(formatScore(example.score, OBSERVED_EVIDENCE))}</strong></div>
            <div class="metric"><span>Priority</span><strong>${escapeHtml(example.priority)}</strong></div>
          </div>
          <p class="source">Cited from ${escapeHtml(example.source)}. Score = min(100, ${escapeHtml(String(example.typeCount))}×25 + min(25, ${escapeHtml(String(example.totalEvents))}×2)).</p>
        </article>`
  )).join('\n');
  const thresholds = (signalConvergence.thresholds || []).map((row) => (
    `          <tr><td>${escapeHtml(String(row.types))}</td><td>${escapeHtml(row.scoreRange)}</td><td>${escapeHtml(row.priority)}</td></tr>`
  )).join('\n');
  const body = `      <p class="eyebrow">Correlation metric</p>
      <h1>${escapeHtml(metricName)}</h1>
      <p class="lede">${escapeHtml(description)}</p>
      <p>The named metric is crawlable here. Live cell alerts remain available to agents through the MCP tool <code>get_signal_convergence</code>; this page publishes the score definition, thresholds, and cited reference examples so current-state answers can attribute a World Monitor number.</p>
      <section class="grid" aria-label="${escapeHtml(metricName)} definition">
        <div class="metric"><span>Scale</span><strong>0–100</strong></div>
        <div class="metric"><span>Default min domains</span><strong>${escapeHtml(String(signalConvergence.defaultMinDomains ?? 3))}</strong></div>
        <div class="metric"><span>Grid</span><strong>1° × 1°</strong></div>
        <div class="metric"><span>Window</span><strong>24 hours</strong></div>
      </section>
      <h2>How the score is computed</h2>
      <p><code>type_score = event_types × 25</code>. <code>count_boost = min(25, total_events × 2)</code>. <code>convergence_score = min(100, type_score + count_boost)</code>.</p>
      <div class="table-scroll"><table>
        <caption>Alert priority thresholds</caption>
        <thead><tr><th scope="col">Types</th><th scope="col">Score range</th><th scope="col">Priority</th></tr></thead>
        <tbody>
${thresholds}
        </tbody>
      </table></div>
      <h2>Cited reference examples</h2>
      <div class="split">
${examples}
      </div>
      <h2>Where to go next</h2>
      <p>Open the <a href="/?utm_source=seo-tool">live dashboard</a> for map layers, or read the full methodology in <a href="/docs/geographic-convergence">geographic convergence</a>. Country pages expose related instability scores; this page is the citable correlation definition.</p>
      <p class="source">Download: <a href="${escapeHtml(downloadHref)}">${CONVERGENCE_DATASET_DOWNLOAD}</a>. Snapshot: ${escapeHtml(snapshotPath)}. Methodology reference, last reviewed ${escapeHtml(prettyDate(lastmod))}. Methodology: <a href="/docs/geographic-convergence">Geographic Convergence Detection</a>.</p>`;
  return pageDocument({
    baseUrl,
    path,
    title: `${metricName} | World Monitor`,
    description,
    lastmod,
    jsonLd: [
      {
        '@context': 'https://schema.org',
        '@type': 'WebPage',
        name: metricName,
        description,
        url: absoluteUrl(baseUrl, path),
        inLanguage: 'en-US',
        mainEntity: {
          '@type': 'Dataset',
          '@id': datasetId,
          name: `World Monitor ${metricName} reference`,
          description,
          url: datasetUrl,
          identifier: 'signal-convergence-reference',
          keywords: ['signal convergence', 'geographic convergence', 'event correlation', 'geopolitical signals'],
          creator: { ...WORLD_MONITOR_ORG },
          license: DATASET_LICENSE,
          // This reference is a formula plus documentation-derived examples. It
          // has no observation window, so it carries no temporalCoverage; when
          // available, datePublished identifies the source snapshot. The family
          // schema stamp rides alongside so a Dataset-shape change signals
          // recrawl without dragging the page lastmod with it (#7382).
          datePublished: datasetTemporalCoverage(signalConvergence.capturedAt),
          dateModified: laterDate(lastmod, DATASET_SCHEMA_CONTENT_VERSION.tools),
          spatialCoverage: 'Worldwide',
          isAccessibleForFree: true,
          includedInDataCatalog: includedInDataCatalog(baseUrl),
          variableMeasured: [
            { '@type': 'PropertyValue', name: metricName, minValue: 0, maxValue: 100, unitText: 'score points' },
            { '@type': 'PropertyValue', name: 'Default minimum domains', value: signalConvergence.defaultMinDomains ?? 3, minValue: 1 },
            { '@type': 'PropertyValue', name: 'Alert priority thresholds', value: signalConvergence.thresholds?.length ?? 0, unitText: 'thresholds' },
          ],
          measurementTechnique: 'type_score = event_types × 25; count_boost = min(25, total_events × 2); convergence_score = min(100, type_score + count_boost)',
          citation: absoluteUrl(baseUrl, '/docs/geographic-convergence'),
          distribution: [dataDownload(absoluteUrl(baseUrl, downloadHref))],
        },
      },
      dataCatalogLd(baseUrl),
    ],
    breadcrumbs: breadcrumbLd(baseUrl, [
      { name: 'Home', path: '/' },
      { name: 'Live tools', path: '/tools/' },
      { name: metricName, path },
    ]),
    body,
  });
}

function signalConvergenceDatasetDownload(signalConvergence, snapshotPath) {
  return stableJson({
    dataset: 'signal-convergence-reference',
    metricName: signalConvergence.metricName,
    methodologyPath: signalConvergence.methodologyPath,
    scale: signalConvergence.scale,
    formula: signalConvergence.formula,
    defaultMinDomains: signalConvergence.defaultMinDomains,
    thresholds: signalConvergence.thresholds,
    referenceExamples: signalConvergence.referenceExamples,
    capturedAt: signalConvergence.capturedAt,
    source: snapshotPath,
    license: DATASET_LICENSE.url,
  });
}

function renderHazardPage({ countryBounds, baseUrl, lastmod }) {
  const path = '/tools/natural-hazard-pulse/';
  const description = 'See which natural hazards are active right now — earthquakes, storms, wildfires and floods from EONET, GDACS, NHC and HKO feeds — worldwide or filtered to one country.';
  const body = `      <p class="eyebrow">Natural-hazard pulse</p>
      <h1>What natural hazards are active now?</h1>
      <p class="lede">${escapeHtml(description)}</p>
      <p>The country selector is an approximate geographic filter, not a territorial polygon. Coastal and border events can overlap neighbouring countries. Countries with oversized or discontinuous envelopes are omitted so every country query remains bounded. Agency observations and wind averaging periods remain distinct.</p>
      <section class="live-tool" data-natural-hazard-tool data-state="loading">
        <div class="tool-head">
          <div>
            <p class="eyebrow">Current source snapshot</p>
            <h2>Open event pulse</h2>
          </div>
          <span class="live-status" data-live-status role="status" aria-live="polite">Connecting…</span>
        </div>
        <div class="tool-controls">
          <label>Geographic filter
            <select data-country-select>
${countrySelectOptions(countryBounds, { includeWorldwide: true })}
            </select>
          </label>
          <button class="refresh" type="button" data-live-refresh disabled>Refresh live data</button>
        </div>
        <div class="grid" data-live-grid aria-label="Current natural hazard metrics" aria-busy="true">
          <div class="metric"><span>Open matches</span><strong data-hazard-total>—</strong></div>
          <div class="metric"><span>Categories</span><strong data-hazard-categories>Loading</strong></div>
          <div class="metric"><span>Strongest reported magnitude</span><strong data-hazard-strongest>—</strong></div>
          <div class="metric"><span>Most recent event</span><strong data-hazard-latest>—</strong></div>
        </div>
        <ul class="result-list" data-hazard-list aria-label="Recent matching natural events"><li>Loading current events…</li></ul>
        <div class="tool-meta"><time data-live-updated>Requesting the latest available snapshot…</time></div>
        <noscript><p>Enable JavaScript to load and filter the current event snapshot. This page still documents the tool’s coverage and sources.</p></noscript>
      </section>
      <a class="cta" data-dashboard-link href="${escapeHtml(withUtmSource(absoluteUrl(baseUrl, '/'), 'seo-tool'))}">Open the selected area in World Monitor →</a>
      <h2>Sources and limits</h2>
      <p>World Monitor reads its seeded natural-event snapshot from maintained <a href="https://eonet.gsfc.nasa.gov/">NASA EONET</a>, <a href="https://www.gdacs.org/">GDACS</a>, <a href="https://www.nhc.noaa.gov/">NHC</a>, and <a href="https://www.hko.gov.hk/">HKO</a> ingestion paths. Source names are retained on individual events. A zero is shown only when a source snapshot is explicitly available; unavailable snapshots fail closed. Coverage and update cadence are documented in <a href="/docs/natural-disasters">natural disaster tracking</a>.</p>
      <p class="source">Geographic filters: ${COUNTRY_BBOXES_PATH}. Live metrics: <code>/api/natural/v1/list-natural-events</code>.</p>`;
  return pageDocument({
    baseUrl,
    path,
    title: 'Live Natural Hazard Tracker | World Monitor',
    description,
    lastmod,
    jsonLd: {
      '@context': 'https://schema.org',
      '@type': 'WebApplication',
      name: 'World Monitor natural-hazard pulse',
      description,
      url: absoluteUrl(baseUrl, path),
      applicationCategory: 'DataApplication',
      operatingSystem: 'Any',
    },
    breadcrumbs: breadcrumbLd(baseUrl, [
      { name: 'Home', path: '/' },
      { name: 'Live tools', path: '/tools/' },
      { name: 'Natural-hazard pulse', path },
    ]),
    body,
    scriptSrcs: ['/tools/live-tools.js'],
  });
}

function renderAirspacePage({ countryBounds, baseUrl, lastmod }) {
  const path = '/tools/airspace-disruption-checker/';
  const description = 'Check monitored commercial-airport disruption and bounded observed military-flight activity for one country without combining the signals into a threat score.';
  const body = `      <p class="eyebrow">Airspace-disruption checker</p>
      <h1>Check a country’s airspace signals</h1>
      <p class="lede">${escapeHtml(description)}</p>
      <p>Commercial disruption and observed military aircraft are independent evidence domains. Aircraft presence does not establish mission, intent, or danger. Airport coverage is limited to monitored hubs.</p>
      <section class="live-tool" data-airspace-tool data-state="loading">
        <div class="tool-head">
          <div>
            <p class="eyebrow">Country bounding-box check</p>
            <h2>Commercial and observed activity</h2>
          </div>
          <span class="live-status" data-live-status role="status" aria-live="polite">Connecting…</span>
        </div>
        <div class="tool-controls">
          <label>Country
            <select data-country-select>
${countrySelectOptions(countryBounds, { defaultCode: 'JP' })}
            </select>
          </label>
          <button class="refresh" type="button" data-live-refresh disabled>Refresh live data</button>
        </div>
        <div class="split" data-live-grid aria-busy="true">
          <section>
            <p class="eyebrow">Commercial operations</p>
            <h3>Monitored airports</h3>
            <p data-airport-state>Loading source coverage…</p>
            <div class="grid">
              <div class="metric"><span>Monitored in box</span><strong data-airport-monitored>—</strong></div>
              <div class="metric"><span>Disrupted</span><strong data-airport-disrupted>—</strong></div>
              <div class="metric"><span>Normal coverage</span><strong data-airport-normal>—</strong></div>
              <div class="metric"><span>Unknown coverage</span><strong data-airport-unknown>—</strong></div>
            </div>
            <ul class="result-list" data-airport-list aria-label="Current airport disruptions"><li>Loading airport coverage…</li></ul>
            <time data-airport-updated>Requesting monitored-airport data…</time>
          </section>
          <section>
            <p class="eyebrow">Observed activity</p>
            <h3>Military-flight returns</h3>
            <p data-military-state>Loading bounded observations…</p>
            <div class="grid">
              <div class="metric"><span>Returned aircraft</span><strong data-military-returned>—</strong></div>
              <div class="metric"><span>Flagged interesting</span><strong data-military-interesting>—</strong></div>
            </div>
            <ul class="result-list" data-military-list aria-label="Recent returned military flights"><li>Loading returned observations…</li></ul>
            <time data-military-updated>Requesting bounded flight observations…</time>
          </section>
        </div>
        <p class="tool-note">Military results are capped at 100 returned observations for the selected box. Countries with oversized or discontinuous envelopes are omitted so the tool never issues a continent-scale observation query. An empty or failed military response is unavailable, not confirmed zero activity.</p>
        <noscript><p>Enable JavaScript to check the selected country. The independent-source methodology and limitations remain available on this page.</p></noscript>
      </section>
      <a class="cta" data-dashboard-link href="${escapeHtml(withUtmSource(absoluteUrl(baseUrl, '/?country=JP&expanded=1'), 'seo-tool'))}">Investigate the selected country in World Monitor →</a>
      <h2>How to read the result</h2>
      <p>“Normal” applies only to monitored airports with current source coverage. “Unknown” means telemetry was not available and is not counted as normal. Military-flight results are bounded observations from OpenSky/Wingbits-compatible ingestion and are not exhaustive.</p>
      <p class="source">Geographic filters: ${COUNTRY_BBOXES_PATH}. Live metrics: <code>/api/aviation/v1/list-airport-delays</code> and <code>/api/military/v1/list-military-flights</code>.</p>`;
  return pageDocument({
    baseUrl,
    path,
    title: 'Airspace-Disruption Checker | World Monitor',
    description,
    lastmod,
    jsonLd: {
      '@context': 'https://schema.org',
      '@type': 'WebApplication',
      name: 'World Monitor airspace-disruption checker',
      description,
      url: absoluteUrl(baseUrl, path),
      applicationCategory: 'DataApplication',
      operatingSystem: 'Any',
    },
    breadcrumbs: breadcrumbLd(baseUrl, [
      { name: 'Home', path: '/' },
      { name: 'Live tools', path: '/tools/' },
      { name: 'Airspace-disruption checker', path },
    ]),
    body,
    scriptSrcs: ['/tools/live-tools.js'],
  });
}

function chunk(values, size) {
  const chunks = [];
  for (let i = 0; i < values.length; i += size) chunks.push(values.slice(i, i + size));
  return chunks;
}

function changelogPagePath(index) {
  return index === 0 ? '/reference/changelog/' : `/reference/changelog/page/${index + 1}/`;
}

function renderChangelogPage({ releases, pageIndex, totalPages, baseUrl, lastmod }) {
  const path = changelogPagePath(pageIndex);
  const paginationLinks = [
    pageIndex > 0 ? { rel: 'prev', path: changelogPagePath(pageIndex - 1) } : null,
    pageIndex + 1 < totalPages ? { rel: 'next', path: changelogPagePath(pageIndex + 1) } : null,
  ].filter(Boolean);
  const title = pageIndex === 0
    ? 'World Monitor Changelog | World Monitor'
    : `World Monitor Changelog Page ${pageIndex + 1} | World Monitor`;
  const description = 'Paginated release notes for World Monitor — new panels, data sources, API changes and fixes — built from the committed CHANGELOG.md so every release is crawlable.';
  const body = `      <p class="eyebrow">Release notes</p>
      <h1>World Monitor changelog</h1>
      <p class="lede">${escapeHtml(description)}</p>
${releases.map((release) => `      <article class="card">
        <h2>${escapeHtml(release.label)}${release.date ? ` <small>${escapeHtml(release.date)}</small>` : ''}</h2>
        ${release.headings.length ? `<p>${escapeHtml(release.headings.join(' / '))}</p>` : ''}
        <ul>
${release.bullets.map((bullet) => `          <li>${escapeHtml(bullet)}</li>`).join('\n')}
        </ul>
      </article>`).join('\n')}
      <nav class="grid" aria-label="Changelog pagination">
        ${pageIndex > 0 ? `<a class="card" href="${changelogPagePath(pageIndex - 1)}">Previous page</a>` : ''}
        ${pageIndex + 1 < totalPages ? `<a class="card" href="${changelogPagePath(pageIndex + 1)}">Next page</a>` : ''}
      </nav>
      <p class="source">Source: ${CHANGELOG_PATH}. Page ${pageIndex + 1} of ${totalPages}.</p>`;
  return pageDocument({
    baseUrl,
    path,
    title,
    description,
    lastmod,
    paginationLinks,
    // Pagination beyond the changelog index is crawlable for humans but
    // intentionally noindex + omitted from the root sitemap (#7380).
    robots: pageIndex === 0 ? INDEXABLE_ROBOTS_CONTENT : CHANGELOG_PAGINATION_ROBOTS_CONTENT,
    jsonLd: {
      '@context': 'https://schema.org',
      '@type': 'CollectionPage',
      name: 'World Monitor changelog',
      description,
      url: absoluteUrl(baseUrl, path),
      inLanguage: 'en-US',
      isPartOf: {
        '@type': 'CreativeWorkSeries',
        name: 'World Monitor release notes',
      },
    },
    breadcrumbs: breadcrumbLd(baseUrl, [
      { name: 'Home', path: '/' },
      { name: 'Changelog', path: '/reference/changelog/' },
    ]),
    body,
  });
}

function writeGeneratedFile(outDir, relativePath, content) {
  const target = join(outDir, relativePath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}

function routeFile(pathname) {
  const withoutLeading = pathname.replace(/^\/+/, '');
  return join(withoutLeading, 'index.html');
}

function buildManifest({ data, baseUrl, changelogPageCount }) {
  const countryRoutes = data.countries.map((country) => `/countries/${country.slug}/`);
  const chokepointRoutes = data.chokepoints.map((chokepoint) => `/chokepoints/${chokepoint.slug}/`);
  const crisisRoutes = data.crises.map((crisis) => `/crises/${crisis.slug}/`);
  const toolRoutes = [
    '/tools/natural-hazard-pulse/',
    '/tools/airspace-disruption-checker/',
    '/tools/signal-convergence/',
  ];
  const changelogRoutes = Array.from({ length: changelogPageCount }, (_, index) => changelogPagePath(index));
  const glossaryRoutes = data.glossaryTerms.map((term) => `/blog/glossary/${term.slug}/`);
  const researchRoutes = data.researchReports.map(({ report }) => `/research/${report.slug}/`);
  return {
    schemaVersion: 1,
    baseUrl: normalizeBaseUrl(baseUrl),
    generatorContentVersion: data.generatorContentVersion,
    sources: data.sources,
    sections: {
      countryInstabilityIndex: {
        count: 1,
        index: '/country-instability-index/',
        routes: [],
        sourceCapturedAt: data.livePulse.capturedAt,
      },
      countries: {
        count: countryRoutes.length,
        index: '/countries/',
        routes: countryRoutes,
        sourceCapturedAt: data.resilience.capturedAt,
      },
      chokepoints: {
        count: chokepointRoutes.length,
        index: '/chokepoints/',
        routes: chokepointRoutes,
      },
      crises: {
        count: crisisRoutes.length,
        index: '/crises/',
        routes: crisisRoutes,
        sourceCapturedAt: data.livePulse.capturedAt,
      },
      tools: {
        count: toolRoutes.length,
        index: '/tools/',
        routes: toolRoutes,
      },
      changelog: {
        // count remains total generated pages (index + pagination).
        // routes is the sitemap inventory only — page/2+ stay noindex and
        // are omitted from the root sitemap (#7380).
        count: changelogRoutes.length,
        index: '/reference/changelog/',
        routes: [changelogRoutes[0]],
        paginationRoutes: changelogRoutes.slice(1),
        sourceLastmod: data.lastmod.changelog,
      },
      research: {
        count: researchRoutes.length,
        index: '/research/',
        routes: researchRoutes,
      },
      useCases: {
        count: USE_CASE_PAGES.length,
        index: '/use-cases/',
        routes: USE_CASE_PAGES.map((page) => page.path),
      },
      comparisons: {
        count: COMPARISON_PAGES.length + 1,
        index: '/compare/',
        routes: COMPARISON_PAGES.map((page) => page.path),
      },
      sources: {
        count: 1,
        index: '/sources/',
        routes: [],
      },
      glossary: {
        count: glossaryRoutes.length,
        index: '/blog/glossary/',
        routes: glossaryRoutes,
        generatedBy: 'blog-site Astro build',
      },
    },
  };
}

export async function buildCorpus({
  rootDir = DEFAULT_ROOT,
  outDir = DEFAULT_OUT_DIR,
  baseUrl = DEFAULT_BASE_URL,
  clean = true,
} = {}) {
  const data = await loadCorpusData({ rootDir });
  if (clean) {
    for (const dir of GENERATED_DIRS) {
      rmSync(join(outDir, dir), { recursive: true, force: true });
    }
  }

  // Flagship downloadable datasets for the /sources/ DataCatalog node: every
  // entry resolves to a generated download the corpus writes, so the catalog
  // never advertises a dataset without a distribution.
  const convergenceMetricName = data.livePulse.signalConvergence.metricName || 'Geographic Convergence Score';
  const sourcesCatalogDatasets = [
    ...data.crises.map((crisis) => {
      const pagePath = `/crises/${crisis.slug}/`;
      return {
        '@type': 'Dataset',
        name: crisis.title,
        description: crisis.description,
        url: absoluteUrl(baseUrl, pagePath),
        keywords: ['crisis tracker', 'armed conflict', 'humanitarian response'],
        creator: { ...WORLD_MONITOR_ORG },
        license: DATASET_LICENSE,
        distribution: [
          dataDownload(absoluteUrl(baseUrl, datasetDownloadHref(pagePath, CRISIS_DATASET_DOWNLOAD))),
        ],
      };
    }),
    {
      '@type': 'Dataset',
      name: `${convergenceMetricName} reference`,
      description: `World Monitor's ${convergenceMetricName} (0-100) names when protests, military flights, naval vessels, and earthquakes co-occur in the same 1° cell.`,
      url: absoluteUrl(baseUrl, '/tools/signal-convergence/'),
      keywords: ['signal convergence', 'geographic correlation', 'early warning'],
      creator: { ...WORLD_MONITOR_ORG },
      license: DATASET_LICENSE,
      distribution: [
        dataDownload(absoluteUrl(baseUrl, datasetDownloadHref('/tools/signal-convergence/', CONVERGENCE_DATASET_DOWNLOAD))),
      ],
    },
  ];

  writeGeneratedFile(
    outDir,
    'sources/index.html',
    renderSourcesIndex({
      sourceStats: data.sourceStats,
      sourceCatalog: data.sourceCatalog,
      catalogDatasets: sourcesCatalogDatasets,
      baseUrl,
      lastmod: data.lastmod.sources,
      helpers: {
        absoluteUrl,
        breadcrumbLd,
        dataCatalogLd,
        escapeHtml,
        pageDocument,
        withUtmSource,
      },
    }),
  );

  writeGeneratedFile(
    outDir,
    'country-instability-index/index.html',
    renderCountryInstabilityIndexPage({
      ciiRanking: data.ciiRanking,
      baseUrl,
      capturedAt: data.livePulse.capturedAt,
      lastmod: data.lastmod.countryInstabilityIndex,
      snapshotPath: data.sources.livePulseSnapshot,
    }),
  );
  writeGeneratedFile(
    outDir,
    datasetDownloadFile('/country-instability-index/', CII_INDEX_DATASET_DOWNLOAD),
    ciiIndexDatasetDownload(data.ciiRanking, {
      capturedAt: data.livePulse.capturedAt,
      snapshotPath: data.sources.livePulseSnapshot,
    }),
  );

  writeGeneratedFile(
    outDir,
    'countries/index.html',
    renderCountriesIndex({
      countries: data.countries,
      ciiRanking: data.ciiRanking,
      baseUrl,
      capturedAt: data.resilience.capturedAt,
      lastmod: data.lastmod.countriesIndex,
      snapshotPath: data.sources.resilienceSnapshot,
    }),
  );
  writeGeneratedFile(
    outDir,
    datasetDownloadFile('/countries/', COUNTRIES_INDEX_DATASET_DOWNLOAD),
    countriesIndexDatasetDownload(data.countries, {
      capturedAt: data.resilience.capturedAt,
      snapshotPath: data.sources.resilienceSnapshot,
    }),
  );
  const rankedCount = data.countries.filter((country) => country.rank != null).length;
  let developmentsPageCount = 0;
  for (const country of data.countries) {
    const pagePath = `/countries/${country.slug}/`;
    const ciiEntry = data.ciiRanking.byCode.get(country.code) || null;
    const pulseDevelopments = data.livePulse?.countries?.[country.code]?.developments || null;
    if (developmentsHasDatedItem(pulseDevelopments)) developmentsPageCount += 1;
    writeGeneratedFile(
      outDir,
      routeFile(pagePath),
      renderCountryPage({
        country,
        baseUrl,
        capturedAt: data.resilience.capturedAt,
        lastmod: ciiEntry
          ? data.lastmod.ciiCountries
          : data.lastmod.countries,
        methodologyFormula: data.resilience.methodologyFormula || 'unknown',
        rankedCount,
        snapshotNote: data.resilience.snapshotNote,
        snapshotPath: data.sources.resilienceSnapshot,
        bbox: data.countryBboxByCode.get(country.code) || null,
        livePulse: data.livePulse,
        ciiEntry,
      }),
    );
    if (ciiEntry) {
      writeGeneratedFile(
        outDir,
        datasetDownloadFile(pagePath, COUNTRY_CII_DATASET_DOWNLOAD),
        countryCiiDatasetDownload(country, ciiEntry, {
          capturedAt: data.livePulse.capturedAt,
          snapshotPath: data.sources.livePulseSnapshot,
        }),
      );
    }
    writeGeneratedFile(
      outDir,
      datasetDownloadFile(pagePath, COUNTRY_DATASET_DOWNLOAD),
      countryDatasetDownload(country, {
        capturedAt: data.resilience.capturedAt,
        methodologyFormula: data.resilience.methodologyFormula || 'unknown',
        rankedCount,
        snapshotPath: data.sources.resilienceSnapshot,
        developments: pulseDevelopments,
      }),
    );
  }
  // Pipeline tripwire (#7615): the per-page guard proves frozen items render;
  // this proves the freeze captured at least one dated, sourced item for every
  // indexed country page.
  // Snapshots frozen before developments existed carry no `developments` key
  // at all; the tripwire applies only once the snapshot has the shape, so
  // older committed snapshots (and the tests pinned to them) keep building.
  const snapshotCarriesDevelopments = Object.values(data.livePulse?.countries || {})
    .some((row) => row && typeof row === 'object' && 'developments' in row);
  assertDevelopmentsCoverage({
    carriesDevelopments: snapshotCarriesDevelopments,
    developmentsPageCount,
    indexedCountryPageCount: data.countries.length,
  });

  const chokepointHubRows = buildChokepointHubRows(data.chokepoints, data.livePulse);
  writeGeneratedFile(
    outDir,
    'chokepoints/index.html',
    renderChokepointsIndex({
      chokepoints: data.chokepoints,
      chokepointHubRows,
      livePulse: data.livePulse,
      baseUrl,
      lastmod: data.lastmod.chokepoints,
      snapshotPath: data.sources.livePulseSnapshot,
    }),
  );
  writeGeneratedFile(
    outDir,
    datasetDownloadFile('/chokepoints/', CHOKEPOINTS_INDEX_DATASET_DOWNLOAD),
    chokepointsIndexDatasetDownload(
      chokepointHubRows,
      {
        capturedAt: data.livePulse.capturedAt,
        snapshotPath: data.sources.livePulseSnapshot,
      },
    ),
  );
  for (const chokepoint of data.chokepoints) {
    const pagePath = `/chokepoints/${chokepoint.slug}/`;
    writeGeneratedFile(
      outDir,
      routeFile(pagePath),
      renderChokepointPage({
        chokepoint,
        baseUrl,
        lastmod: data.lastmod.chokepoints,
        tradeRoutesById: data.tradeRoutesById,
        researchReports: data.researchReports,
        livePulse: data.livePulse,
        capturedAt: data.chokepointObservation?.capturedAt || null,
        volumeObservedAt: data.chokepointObservation?.volumeObservedAt || null,
      }),
    );
    writeGeneratedFile(
      outDir,
      datasetDownloadFile(pagePath, CHOKEPOINT_DATASET_DOWNLOAD),
      chokepointDatasetDownload(chokepoint, {
        tradeRoutesById: data.tradeRoutesById,
        capturedAt: data.chokepointObservation?.capturedAt || null,
        volumeObservedAt: data.chokepointObservation?.volumeObservedAt || null,
      }),
    );
  }

  writeResearchSection({
    data,
    outDir,
    baseUrl,
    tpl: { escapeHtml, absoluteUrl, breadcrumbLd, withUtmSource, pageDocument },
    dataCatalog: dataCatalogLd(baseUrl),
    includedInDataCatalog: includedInDataCatalog(baseUrl),
  });

  writeUseCasesSection({
    outDir,
    baseUrl,
    lastmod: data.lastmod.useCases,
    tpl: { escapeHtml, absoluteUrl, breadcrumbLd, withUtmSource, pageDocument },
  });

  writeComparisonPages({
    outDir,
    baseUrl,
    lastmod: data.lastmod.comparisons,
    tpl: { escapeHtml, absoluteUrl, breadcrumbLd, withUtmSource, pageDocument },
  });

  writeGeneratedFile(
    outDir,
    'tools/live-tools.js',
    readText(rootDir, LIVE_TOOLS_SCRIPT_PATH),
  );
  writeGeneratedFile(
    outDir,
    'tools/index.html',
    renderToolsIndex({
      baseUrl,
      lastmod: data.lastmod.tools,
    }),
  );
  writeGeneratedFile(
    outDir,
    'tools/natural-hazard-pulse/index.html',
    renderHazardPage({
      countryBounds: data.countryBounds,
      baseUrl,
      lastmod: data.lastmod.tools,
    }),
  );
  writeGeneratedFile(
    outDir,
    'tools/airspace-disruption-checker/index.html',
    renderAirspacePage({
      countryBounds: data.countryBounds,
      baseUrl,
      lastmod: data.lastmod.tools,
    }),
  );
  writeGeneratedFile(
    outDir,
    'tools/signal-convergence/index.html',
    renderSignalConvergencePage({
      signalConvergence: data.livePulse.signalConvergence,
      baseUrl,
      lastmod: data.lastmod.tools,
      snapshotPath: data.sources.livePulseSnapshot,
    }),
  );
  writeGeneratedFile(
    outDir,
    datasetDownloadFile('/tools/signal-convergence/', CONVERGENCE_DATASET_DOWNLOAD),
    signalConvergenceDatasetDownload(
      data.livePulse.signalConvergence,
      data.sources.livePulseSnapshot,
    ),
  );

  writeGeneratedFile(
    outDir,
    'crises/index.html',
    renderCrisesIndex({
      crises: data.crises,
      baseUrl,
      lastmod: data.lastmod.crises,
    }),
  );
  for (const crisis of data.crises) {
    const pagePath = `/crises/${crisis.slug}/`;
    const crisisPulse = data.livePulse.crises?.[crisis.slug] || null;
    const crisisPulseTotals = crisisPulse ? pulseTotals(crisisPulse) : null;
    writeGeneratedFile(
      outDir,
      routeFile(pagePath),
      renderCrisisPage({
        crisis,
        baseUrl,
        lastmod: data.lastmod.crises,
        livePulse: data.livePulse,
        livePulseSnapshotPath: data.sources.livePulseSnapshot,
        publishedTotals: crisisPulseTotals,
      }),
    );
    writeGeneratedFile(
      outDir,
      datasetDownloadFile(pagePath, CRISIS_DATASET_DOWNLOAD),
      crisisDatasetDownload(crisis, crisisPulse, crisisPulseTotals),
    );
  }

  const changelogPages = chunk(data.changelog, CHANGELOG_PAGE_SIZE);
  changelogPages.forEach((releases, pageIndex) => {
    writeGeneratedFile(
      outDir,
      routeFile(changelogPagePath(pageIndex)),
      renderChangelogPage({
        releases,
        pageIndex,
        totalPages: changelogPages.length,
        baseUrl,
        lastmod: data.lastmod.changelog,
      }),
    );
  });

  const manifest = buildManifest({
    data,
    baseUrl,
    changelogPageCount: changelogPages.length,
  });
  writeGeneratedFile(outDir, 'crawlable-corpus.json', `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

function parseArgs(argv) {
  const options = {
    rootDir: DEFAULT_ROOT,
    outDir: DEFAULT_OUT_DIR,
    baseUrl: DEFAULT_BASE_URL,
    clean: true,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--no-clean') {
      options.clean = false;
    } else if (arg === '--out-dir') {
      options.outDir = resolve(argv[++i]);
    } else if (arg.startsWith('--out-dir=')) {
      options.outDir = resolve(arg.slice('--out-dir='.length));
    } else if (arg === '--root-dir') {
      options.rootDir = resolve(argv[++i]);
    } else if (arg.startsWith('--root-dir=')) {
      options.rootDir = resolve(arg.slice('--root-dir='.length));
    } else if (arg === '--base-url') {
      options.baseUrl = argv[++i];
    } else if (arg.startsWith('--base-url=')) {
      options.baseUrl = arg.slice('--base-url='.length);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const manifest = await buildCorpus(options);
  process.stdout.write(
    `Wrote crawlable corpus: ${manifest.sections.countries.count} countries, `
    + `${manifest.sections.countryInstabilityIndex.count} CII ranking page, `
    + `${manifest.sections.chokepoints.count} chokepoints, `
    + `${manifest.sections.crises.count} crisis trackers, `
    + `${manifest.sections.tools.count} live tools, `
    + `${manifest.sections.research.count} research reports, `
    + `${manifest.sections.changelog.count} changelog pages, `
    + `${manifest.sections.comparisons.count} comparison pages, `
    + `${manifest.sections.sources.count} source catalog page. `
    + `Glossary manifest references ${manifest.sections.glossary.count} existing blog pages.\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    process.stderr.write(`${err.stack || err.message}\n`);
    process.exit(1);
  });
}
