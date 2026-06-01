#!/usr/bin/env -S npx tsx

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import countryNames from '../shared/country-names.json';
import iso2ToIso3Json from '../shared/iso2-to-iso3.json';
import { loadEnvFile } from './_seed-utils.mjs';
import { normalizeCountryToken } from '../server/_shared/country-token.ts';
import { getRawJson } from '../server/_shared/redis.ts';
import {
  RESILIENCE_HISTORY_KEY_PREFIX,
  RESILIENCE_RANKING_CACHE_KEY,
  RESILIENCE_SCORE_CACHE_PREFIX,
  getCurrentCacheFormula,
  scoreCacheKey,
  warmMissingResilienceScores,
} from '../server/worldmonitor/resilience/v1/_shared.ts';
import {
  scoreAllDimensions,
  type ResilienceDimensionId,
  type ResilienceSeedReader,
} from '../server/worldmonitor/resilience/v1/_dimension-scorers.ts';
import {
  compareReferenceResults,
  recomputeReferenceCountry,
  type ReferenceFormula,
  type ReferencePublishedCountry,
  type ResilienceReferenceManifest,
} from './resilience-reference-recompute.mts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const DEFAULT_COUNTRIES = ['NO', 'US', 'TR', 'YE', 'CH', 'AE', 'IN', 'SY', 'NR', 'ER'];
const DEFAULT_DIMENSIONS: ResilienceDimensionId[] = [
  'governanceInstitutional',
  'borderSecurity',
  'fiscalSpace',
  'liquidReserveAdequacy',
  'externalDebtCoverage',
  'sovereignFiscalBuffer',
];
const OUT_DIR = path.join(
  REPO_ROOT,
  'docs',
  'methodology',
  'country-resilience-index',
  'reference-edition',
  '2026',
);
const PUBLISHED_SOURCE = `${RESILIENCE_SCORE_CACHE_PREFIX}{countryCode}`;
const ISO2_TO_ISO3: Record<string, string> = iso2ToIso3Json;

interface CountryReference {
  iso2: string;
  identifiers: Set<string>;
  textAliases: Set<string>;
}

function commitSha(): string {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

function parseListArg(name: string, fallback: string[]): string[] {
  const prefix = `--${name}=`;
  const arg = process.argv.find((item) => item.startsWith(prefix));
  if (!arg) return fallback;
  return arg.slice(prefix.length).split(',').map((item) => item.trim().toUpperCase()).filter(Boolean);
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number`);
  }
  return value;
}

function buildCountryReferences(countries: string[]): CountryReference[] {
  return countries.map((countryCode) => {
    const iso2 = countryCode.trim().toUpperCase();
    const identifiers = new Set<string>([normalizeCountryToken(iso2)]);
    const textAliases = new Set<string>();
    const iso3 = ISO2_TO_ISO3[iso2];
    if (iso3) identifiers.add(normalizeCountryToken(iso3));

    for (const [name, code] of Object.entries(countryNames as Record<string, string>)) {
      if (String(code || '').toUpperCase() !== iso2) continue;
      const alias = normalizeCountryToken(name);
      if (!alias) continue;
      identifiers.add(alias);
      textAliases.add(alias);
    }

    return { iso2, identifiers, textAliases };
  });
}

function matchesCountryIdentifier(value: unknown, countries: CountryReference[]): boolean {
  const normalized = normalizeCountryToken(value);
  return Boolean(normalized) && countries.some((country) => country.identifiers.has(normalized));
}

function matchesCountryText(value: unknown, countries: CountryReference[]): boolean {
  const normalized = normalizeCountryToken(value);
  if (!normalized) return false;
  const padded = ` ${normalized} `;
  return countries.some((country) =>
    [...country.textAliases].some((alias) => padded.includes(` ${alias} `))
  );
}

function matchesRecordCountry(
  value: unknown,
  countries: CountryReference[],
  identifierFields: string[],
  textFields: string[] = [],
): boolean {
  const obj = asObject(value);
  return identifierFields.some((field) => matchesCountryIdentifier(obj[field], countries))
    || textFields.some((field) => matchesCountryText(obj[field], countries));
}

function filterCountryMap(map: unknown, countries: CountryReference[]): Record<string, unknown> {
  if (!isRecord(map)) return {};
  return Object.fromEntries(
    Object.entries(map).filter(([key]) => matchesCountryIdentifier(key, countries)),
  );
}

function withReferenceSlice<T extends Record<string, unknown>>(
  value: T,
  countryRefs: CountryReference[],
  sourceRecordCount: number | undefined,
  sampleRecordCount: number | undefined,
): T & { referenceSlice: { countryCodes: string[]; sourceRecordCount?: number; sampleRecordCount?: number } } {
  return {
    ...value,
    referenceSlice: {
      countryCodes: countryRefs.map((country) => country.iso2),
      ...(sourceRecordCount != null && { sourceRecordCount }),
      ...(sampleRecordCount != null && { sampleRecordCount }),
    },
  };
}

function pruneRedisValue(key: string, value: unknown, countryRefs: CountryReference[]): unknown {
  if (!isRecord(value)) return value ?? null;

  if (key === 'conflict:ucdp-events:v1' && Array.isArray(value.events)) {
    const events = value.events.filter((event) =>
      matchesRecordCountry(event, countryRefs, ['country'], ['country'])
    );
    return withReferenceSlice({ ...value, events, filteredCount: events.length }, countryRefs, value.events.length, events.length);
  }

  if (key === 'cyber:threats:v2' && Array.isArray(value.threats)) {
    const threats = value.threats.filter((threat) =>
      matchesRecordCountry(threat, countryRefs, ['country'])
    );
    return withReferenceSlice({ ...value, threats }, countryRefs, value.threats.length, threats.length);
  }

  if (key === 'intelligence:gpsjam:v2' && Array.isArray(value.hexes)) {
    const hexes = value.hexes.filter((hex) =>
      matchesRecordCountry(hex, countryRefs, ['country', 'countryCode'], ['region'])
    );
    return withReferenceSlice({ ...value, hexes }, countryRefs, value.hexes.length, hexes.length);
  }

  if (key === 'intelligence:social:reddit:v1' && Array.isArray(value.posts)) {
    const posts = value.posts.filter((post) => matchesRecordCountry(post, countryRefs, [], ['title']));
    return withReferenceSlice({ ...value, posts }, countryRefs, value.posts.length, posts.length);
  }

  if (key === 'unrest:events:v1' && Array.isArray(value.events)) {
    const events = value.events.filter((event) =>
      matchesRecordCountry(event, countryRefs, ['country'], ['country', 'title', 'summary'])
    );
    const clusters = Array.isArray(value.clusters)
      ? value.clusters.filter((cluster) => matchesRecordCountry(cluster, countryRefs, ['country'], ['country', 'title', 'summary']))
      : value.clusters;
    return withReferenceSlice({ ...value, events, clusters }, countryRefs, value.events.length, events.length);
  }

  if (key === 'displacement:summary:v1:2026' && isRecord(value.summary)) {
    const summary = value.summary;
    const sourceCountries = Array.isArray(summary.countries) ? summary.countries : [];
    const countries = sourceCountries.filter((country) =>
      matchesRecordCountry(country, countryRefs, ['code'], ['name'])
    );
    const sourceTopFlows = Array.isArray(summary.topFlows) ? summary.topFlows : [];
    const topFlows = sourceTopFlows.filter((flow) =>
      matchesRecordCountry(flow, countryRefs, ['originCode', 'asylumCode'], ['originName', 'asylumName'])
    );
    return withReferenceSlice({
      ...value,
      summary: {
        ...summary,
        countries,
        topFlows,
      },
    }, countryRefs, sourceCountries.length, countries.length);
  }

  if (key === 'news:threat:summary:v1' && isRecord(value.byCountry)) {
    const byCountry = filterCountryMap(value.byCountry, countryRefs);
    return withReferenceSlice({ ...value, byCountry }, countryRefs, Object.keys(value.byCountry).length, Object.keys(byCountry).length);
  }

  if (key === 'trade:barriers:v1:tariff-gap:50' && Array.isArray(value.barriers)) {
    const barriers = value.barriers.filter((barrier) =>
      matchesRecordCountry(barrier, countryRefs, ['notifyingCountry'])
    );
    return withReferenceSlice({ ...value, barriers }, countryRefs, value.barriers.length, barriers.length);
  }

  if (key === 'trade:restrictions:v1' && Array.isArray(value.restrictions)) {
    const restrictions = value.restrictions.filter((restriction) =>
      matchesRecordCountry(restriction, countryRefs, ['reportingCountry', 'affectedCountry'])
    );
    return withReferenceSlice({ ...value, restrictions }, countryRefs, value.restrictions.length, restrictions.length);
  }

  if (isRecord(value.countries)) {
    console.warn(`[freeze] generic country-slice fallthrough for key=${key} via top-level "countries" (no explicit prune branch) — confirm this is an intended global feed`);
    const countries = filterCountryMap(value.countries, countryRefs);
    return withReferenceSlice({ ...value, countries }, countryRefs, Object.keys(value.countries).length, Object.keys(countries).length);
  }

  if (isRecord(value.byCountry)) {
    console.warn(`[freeze] generic country-slice fallthrough for key=${key} via top-level "byCountry" (no explicit prune branch) — confirm this is an intended global feed`);
    const byCountry = filterCountryMap(value.byCountry, countryRefs);
    return withReferenceSlice({ ...value, byCountry }, countryRefs, Object.keys(value.byCountry).length, Object.keys(byCountry).length);
  }

  return value;
}

function primaryRecordCount(value: unknown): number | undefined {
  const obj = asObject(value);
  for (const field of ['events', 'threats', 'hexes', 'posts', 'outages', 'restrictions', 'barriers']) {
    if (Array.isArray(obj[field])) return obj[field].length;
  }
  if (isRecord(obj.summary) && Array.isArray(obj.summary.countries)) return obj.summary.countries.length;
  if (isRecord(obj.byCountry)) return Object.keys(obj.byCountry).length;
  if (isRecord(obj.countries)) return Object.keys(obj.countries).length;
  return undefined;
}

function flattenDimensions(scorePayload: Record<string, unknown>) {
  const dimensions: Record<string, unknown> = {};
  const domains = Array.isArray(scorePayload.domains) ? scorePayload.domains : [];
  for (const domain of domains) {
    const domainDimensions = Array.isArray(asObject(domain).dimensions) ? asObject(domain).dimensions as unknown[] : [];
    for (const dimension of domainDimensions) {
      const obj = asObject(dimension);
      if (typeof obj.id === 'string') {
        dimensions[obj.id] = {
          score: obj.score,
          coverage: obj.coverage,
          observedWeight: obj.observedWeight,
          imputedWeight: obj.imputedWeight,
          imputationClass: obj.imputationClass,
        };
      }
    }
  }
  return dimensions;
}

function flattenAggregates(items: unknown): Record<string, unknown> {
  const aggregates: Record<string, unknown> = {};
  if (!Array.isArray(items)) return aggregates;
  for (const item of items) {
    const obj = asObject(item);
    if (typeof obj.id === 'string') {
      aggregates[obj.id] = {
        score: obj.score,
        weight: obj.weight,
      };
    }
  }
  return aggregates;
}

function serializeComputedCountry(country: Awaited<ReturnType<typeof recomputeReferenceCountry>>, formula: ReferenceFormula) {
  return {
    countryCode: country.countryCode,
    overallScore: country.overallScore,
    formula,
    dimensions: Object.fromEntries(country.dimensions.map((dimension) => [dimension.id, {
      score: dimension.score,
      coverage: dimension.coverage,
      observedWeight: dimension.observedWeight,
      imputedWeight: dimension.imputedWeight,
      imputationClass: dimension.imputationClass,
    }])),
    domains: Object.fromEntries(country.domains.map((domain) => [domain.id, {
      score: domain.score,
      weight: domain.weight,
    }])),
    pillars: Object.fromEntries(country.pillars.map((pillar) => [pillar.id, {
      score: pillar.score,
      weight: pillar.weight,
    }])),
  };
}

function serializeScoreCacheCountry(
  rawScore: unknown,
  countryCode: string,
  formula: ReferenceFormula,
): ReferencePublishedCountry {
  const score = asObject(rawScore);
  if (score._formula !== formula) {
    throw new Error(`${scoreCacheKey(countryCode)} has formula=${String(score._formula)}; expected ${formula}`);
  }

  const dimensions = flattenDimensions(score) as ReferencePublishedCountry['dimensions'];
  const domains = flattenAggregates(score.domains) as ReferencePublishedCountry['domains'];
  const pillars = flattenAggregates(score.pillars) as ReferencePublishedCountry['pillars'];
  if (Object.keys(dimensions).length === 0) throw new Error(`${scoreCacheKey(countryCode)} has no dimensions`);
  if (Object.keys(domains).length === 0) throw new Error(`${scoreCacheKey(countryCode)} has no domains`);
  if (Object.keys(pillars).length === 0) throw new Error(`${scoreCacheKey(countryCode)} has no pillars`);

  return {
    countryCode,
    overallScore: finiteNumber(score.overallScore, `${countryCode}.overallScore`),
    formula,
    ...(typeof score.dataVersion === 'string' && { dataVersion: score.dataVersion }),
    dimensions,
    domains,
    pillars,
  };
}

function sha256Json(value: unknown): { text: string; sha256: string; byteLength: number } {
  const text = JSON.stringify(value ?? null);
  return {
    text,
    sha256: createHash('sha256').update(text).digest('hex'),
    byteLength: Buffer.byteLength(text),
  };
}

async function main(): Promise<void> {
  loadEnvFile(import.meta.url);
  process.env.RESILIENCE_PILLAR_COMBINE_ENABLED = 'true';

  // Captured once at startup so the committed timestamp reflects when the
  // Redis snapshot was taken, not when post-capture recompute finished.
  const capturedAt = new Date().toISOString();
  const countries = parseListArg('countries', DEFAULT_COUNTRIES);
  const dimensions = parseListArg('dimensions', DEFAULT_DIMENSIONS) as ResilienceDimensionId[];
  const countryRefs = buildCountryReferences(countries);
  const capturedValues = new Map<string, unknown>();

  if (hasFlag('refresh-score-cache')) {
    const warmed = await warmMissingResilienceScores(countries);
    if (warmed.size !== countries.length) {
      throw new Error(`refreshed ${warmed.size}/${countries.length} sampled score-cache entries`);
    }
  }

  const reader: ResilienceSeedReader = async (key) => {
    if (!capturedValues.has(key)) capturedValues.set(key, await getRawJson(key));
    return capturedValues.get(key) ?? null;
  };

  for (const countryCode of countries) {
    await scoreAllDimensions(countryCode, reader);
  }

  const sortedKeys = [...capturedValues.keys()].sort();
  const values: Record<string, unknown> = {};
  const keys = [];
  let prunedKeyCount = 0;
  for (const key of sortedKeys) {
    const sourceValue = capturedValues.get(key) ?? null;
    const sourceDigest = sha256Json(sourceValue);
    const value = pruneRedisValue(key, sourceValue, countryRefs);
    const digest = sha256Json(value);
    const pruned = digest.sha256 !== sourceDigest.sha256;
    if (pruned) prunedKeyCount += 1;
    values[key] = value;
    keys.push({
      key,
      byteLength: digest.byteLength,
      sha256: digest.sha256,
      ...(pruned && {
        sourceByteLength: sourceDigest.byteLength,
        sourceSha256: sourceDigest.sha256,
        sourceRecordCount: primaryRecordCount(sourceValue),
        sampleRecordCount: primaryRecordCount(value),
        pruned: true,
      }),
    });
  }

  const formula = getCurrentCacheFormula();
  const publishedCountries: Record<string, ReferencePublishedCountry> = {};
  for (const countryCode of countries) {
    publishedCountries[countryCode] = serializeScoreCacheCountry(
      await getRawJson(scoreCacheKey(countryCode)),
      countryCode,
      formula,
    );
  }

  const manifestForRecompute: ResilienceReferenceManifest = {
    schemaVersion: 1,
    referenceEdition: '2026',
    capturedAt,
    formula,
    sample: { countries, dimensions },
    tolerances: {
      overallScore: 0.02,
      dimensionScore: 0.02,
      domainScore: 0.02,
      pillarScore: 0.02,
    },
    published: {
      source: PUBLISHED_SOURCE,
      countries: publishedCountries,
    },
    redis: {
      slice: {
        mode: 'sample-country-slice',
        countryCodes: countries,
        prunedKeys: prunedKeyCount,
      },
      keys,
      values,
    },
  };

  const recomputedCountries: Record<string, Awaited<ReturnType<typeof recomputeReferenceCountry>>> = {};
  for (const countryCode of countries) {
    recomputedCountries[countryCode] = await recomputeReferenceCountry(manifestForRecompute, countryCode);
  }
  const mismatches = compareReferenceResults(manifestForRecompute, recomputedCountries);
  if (mismatches.length > 0) {
    throw new Error(`reference recompute mismatch: ${JSON.stringify(mismatches.slice(0, 10))}`);
  }

  const recomputeAtCapture: Record<string, unknown> = {};
  for (const countryCode of countries) {
    recomputeAtCapture[countryCode] = serializeComputedCountry(recomputedCountries[countryCode]!, formula);
  }

  const manifest = {
    schemaVersion: 1,
    referenceEdition: '2026',
    capturedAt,
    captureSource: 'production Upstash Redis snapshot',
    formula,
    sourceControl: {
      commitSha: commitSha(),
    },
    scorer: {
      schemaVersion: '2.0',
      scoreCachePrefix: RESILIENCE_SCORE_CACHE_PREFIX,
      rankingCacheKey: RESILIENCE_RANKING_CACHE_KEY,
      historyKeyPrefix: RESILIENCE_HISTORY_KEY_PREFIX,
      envFlags: {
        RESILIENCE_SCHEMA_V2_ENABLED: true,
        RESILIENCE_PILLAR_COMBINE_ENABLED: true,
      },
    },
    sample: {
      countries,
      dimensions,
    },
    tolerances: {
      overallScore: 0.02,
      dimensionScore: 0.02,
      domainScore: 0.02,
      pillarScore: 0.02,
    },
    published: {
      source: PUBLISHED_SOURCE,
      countries: publishedCountries,
    },
    productionScoreCacheAtCapture: {
      source: PUBLISHED_SOURCE,
      countries: publishedCountries,
    },
    recomputeAtCapture: {
      source: 'country-sliced Redis input snapshot recompute',
      countries: recomputeAtCapture,
    },
    redis: {
      keyCount: keys.length,
      slice: {
        mode: 'sample-country-slice',
        countryCodes: countries,
        prunedKeys: prunedKeyCount,
      },
      keys,
      values,
    },
  };

  await mkdir(OUT_DIR, { recursive: true });
  const outPath = path.join(OUT_DIR, 'manifest.json');
  await writeFile(outPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  console.log(`[freeze-resilience-reference-edition] wrote ${path.relative(REPO_ROOT, outPath)}`);
  console.log(`[freeze-resilience-reference-edition] countries=${countries.length} keys=${keys.length} formula=${manifest.formula}`);
}

await main().catch((err) => {
  console.error('[freeze-resilience-reference-edition] failed:', err);
  process.exit(1);
});
