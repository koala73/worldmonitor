#!/usr/bin/env -S npx tsx

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type {
  ResilienceDimension,
  ResilienceDomain,
  ResiliencePillar,
} from '../src/generated/server/worldmonitor/resilience/v1/service_server.ts';
import { round } from '../server/_shared/resilience-stats.ts';
import {
  buildDimensionList,
  buildDomainList,
  penalizedPillarScore,
} from '../server/worldmonitor/resilience/v1/_shared.ts';
import { buildPillarList } from '../server/worldmonitor/resilience/v1/_pillar-membership.ts';
import {
  scoreAllDimensions,
  type ResilienceDimensionId,
  type ResilienceSeedReader,
} from '../server/worldmonitor/resilience/v1/_dimension-scorers.ts';

export type ReferenceFormula = 'd6' | 'pc';

export interface ReferencePublishedDimension {
  score: number;
  coverage: number;
  observedWeight?: number;
  imputedWeight?: number;
  imputationClass?: string;
}

export interface ReferencePublishedAggregate {
  score: number;
  weight?: number;
}

export interface ReferencePublishedCountry {
  countryCode: string;
  overallScore: number;
  formula: ReferenceFormula;
  dataVersion?: string;
  dimensions: Record<string, ReferencePublishedDimension>;
  domains: Record<string, ReferencePublishedAggregate>;
  pillars: Record<string, ReferencePublishedAggregate>;
}

export interface ResilienceReferenceManifest {
  schemaVersion: 1;
  referenceEdition: string;
  capturedAt: string;
  formula: ReferenceFormula;
  sample: {
    countries: string[];
    dimensions: ResilienceDimensionId[];
  };
  tolerances: {
    overallScore: number;
    dimensionScore: number;
    domainScore: number;
    pillarScore: number;
  };
  redis: {
    slice?: {
      mode: string;
      countryCodes: string[];
      prunedKeys: number;
    };
    keys?: Array<{
      key: string;
      byteLength: number;
      sha256: string;
      sourceByteLength?: number;
      sourceSha256?: string;
      sourceRecordCount?: number;
      sampleRecordCount?: number;
      pruned?: boolean;
    }>;
    values: Record<string, unknown>;
  };
  published: {
    source: string;
    countries: Record<string, ReferencePublishedCountry>;
  };
}

export interface ReferenceComputedCountry {
  countryCode: string;
  overallScore: number;
  dimensions: ResilienceDimension[];
  domains: ResilienceDomain[];
  pillars: ResiliencePillar[];
}

export interface ReferenceMismatch {
  countryCode: string;
  field: string;
  expected: number;
  actual: number;
  tolerance: number;
}

function hasOwn(obj: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function mapDimensions(dimensions: ResilienceDimension[]): Record<string, ResilienceDimension> {
  return Object.fromEntries(dimensions.map((dimension) => [dimension.id, dimension]));
}

function mapAggregates<T extends { id: string }>(items: T[]): Record<string, T> {
  return Object.fromEntries(items.map((item) => [item.id, item]));
}

export function makeManifestSeedReader(manifest: ResilienceReferenceManifest): ResilienceSeedReader {
  return async (key: string) => {
    if (!hasOwn(manifest.redis.values, key)) {
      throw new Error(`reference manifest is missing Redis key: ${key}`);
    }
    return manifest.redis.values[key] ?? null;
  };
}

export async function recomputeReferenceCountry(
  manifest: ResilienceReferenceManifest,
  countryCode: string,
): Promise<ReferenceComputedCountry> {
  const normalizedCountryCode = countryCode.trim().toUpperCase();
  const scoreMap = await scoreAllDimensions(normalizedCountryCode, makeManifestSeedReader(manifest));
  const dimensions = buildDimensionList(scoreMap);
  const domains = buildDomainList(dimensions);
  const pillars = buildPillarList(domains, true);
  const domainAggregate = round(domains.reduce((sum, domain) => sum + domain.score * domain.weight, 0));
  const overallScore = manifest.formula === 'pc'
    ? round(penalizedPillarScore(pillars.map((pillar) => ({ score: pillar.score, weight: pillar.weight }))))
    : domainAggregate;

  return {
    countryCode: normalizedCountryCode,
    overallScore,
    dimensions,
    domains,
    pillars,
  };
}

export async function recomputeReferenceManifest(
  manifest: ResilienceReferenceManifest,
): Promise<Record<string, ReferenceComputedCountry>> {
  const entries = await Promise.all(
    manifest.sample.countries.map(async (countryCode) => [
      countryCode,
      await recomputeReferenceCountry(manifest, countryCode),
    ] as const),
  );
  return Object.fromEntries(entries);
}

function compareNumber(
  mismatches: ReferenceMismatch[],
  countryCode: string,
  field: string,
  expected: number,
  actual: number | undefined,
  tolerance: number,
): void {
  if (typeof actual !== 'number' || !Number.isFinite(actual) || Math.abs(actual - expected) > tolerance) {
    mismatches.push({
      countryCode,
      field,
      expected,
      actual: typeof actual === 'number' ? actual : Number.NaN,
      tolerance,
    });
  }
}

export function compareReferenceResults(
  manifest: ResilienceReferenceManifest,
  computed: Record<string, ReferenceComputedCountry>,
): ReferenceMismatch[] {
  const mismatches: ReferenceMismatch[] = [];

  for (const countryCode of manifest.sample.countries) {
    const published = manifest.published.countries[countryCode];
    const actual = computed[countryCode];
    if (!published || !actual) {
      throw new Error(`reference manifest missing country payload: ${countryCode}`);
    }

    compareNumber(
      mismatches,
      countryCode,
      'overallScore',
      published.overallScore,
      actual.overallScore,
      manifest.tolerances.overallScore,
    );

    const dimensions = mapDimensions(actual.dimensions);
    for (const dimensionId of manifest.sample.dimensions) {
      const expected = published.dimensions[dimensionId]?.score;
      if (typeof expected !== 'number') {
        throw new Error(`reference manifest missing published dimension ${countryCode}.${dimensionId}`);
      }
      compareNumber(
        mismatches,
        countryCode,
        `dimensions.${dimensionId}.score`,
        expected,
        dimensions[dimensionId]?.score,
        manifest.tolerances.dimensionScore,
      );
    }

    const domains = mapAggregates(actual.domains);
    for (const [domainId, expected] of Object.entries(published.domains)) {
      compareNumber(
        mismatches,
        countryCode,
        `domains.${domainId}.score`,
        expected.score,
        domains[domainId]?.score,
        manifest.tolerances.domainScore,
      );
    }

    const pillars = mapAggregates(actual.pillars);
    for (const [pillarId, expected] of Object.entries(published.pillars)) {
      compareNumber(
        mismatches,
        countryCode,
        `pillars.${pillarId}.score`,
        expected.score,
        pillars[pillarId]?.score,
        manifest.tolerances.pillarScore,
      );
    }
  }

  return mismatches;
}

export async function loadReferenceManifest(manifestPath: string): Promise<ResilienceReferenceManifest> {
  return JSON.parse(await readFile(manifestPath, 'utf8')) as ResilienceReferenceManifest;
}

async function main(): Promise<void> {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const manifestPath = process.argv[2]
    ? path.resolve(process.argv[2])
    : path.join(
      __dirname,
      '..',
      'docs',
      'methodology',
      'country-resilience-index',
      'reference-edition',
      '2026',
      'manifest.json',
    );

  const manifest = await loadReferenceManifest(manifestPath);
  const computed = await recomputeReferenceManifest(manifest);
  const mismatches = compareReferenceResults(manifest, computed);
  const summary = {
    manifest: path.relative(path.join(__dirname, '..'), manifestPath),
    formula: manifest.formula,
    countries: manifest.sample.countries.length,
    dimensions: manifest.sample.dimensions.length,
    mismatches,
  };
  console.log(JSON.stringify(summary, null, 2));
  if (mismatches.length > 0) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
