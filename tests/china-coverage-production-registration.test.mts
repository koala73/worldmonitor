import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const bundle = readFileSync(resolve(root, 'scripts/seed-bundle-health.mjs'), 'utf8');
const climateBundle = readFileSync(resolve(root, 'scripts/seed-bundle-climate.mjs'), 'utf8');
const runbook = readFileSync(resolve(root, 'docs/railway-seed-consolidation-runbook.md'), 'utf8');
const cacheKeys = readFileSync(resolve(root, 'server/_shared/cache-keys.ts'), 'utf8');
const seedHealth = readFileSync(resolve(root, 'api/seed-health.js'), 'utf8');
const naturalSeed = readFileSync(resolve(root, 'scripts/seed-natural-events.mjs'), 'utf8');
const insightsSeed = readFileSync(resolve(root, 'scripts/seed-insights.mjs'), 'utf8');
const dataSources = readFileSync(resolve(root, 'docs/data-sources.mdx'), 'utf8');
const healthDocs = readFileSync(resolve(root, 'docs/health-endpoints.mdx'), 'utf8');

describe('China coverage production registration', () => {
  it('runs the compact evaluator in the hourly Railway health bundle', () => {
    assert.match(bundle, /script:\s*'seed-china-coverage-health\.mjs'/);
    assert.match(bundle, /seedMetaKey:\s*'health:china-coverage'/);
    assert.match(runbook, /China Coverage \(hourly\)/);
  });

  it('registers the compact summary key in shared and Edge health inventories', () => {
    assert.match(cacheKeys, /CHINA_COVERAGE_HEALTH_KEY\s*=\s*'health:china-coverage:v1'/);
    assert.match(seedHealth, /'health:china-coverage'.*seed-meta:health:china-coverage/);
    assert.match(seedHealth, /seed-activated:health:china-coverage/);
  });

  it('runs western-Pacific hazards in the Railway climate bundle with their real health keys', () => {
    assert.match(climateBundle, /script:\s*'seed-natural-events\.mjs'/);
    assert.match(climateBundle, /seedMetaKey:\s*'natural:events'/);
    assert.match(seedHealth, /'weather:hko-warnings'.*seed-meta:weather:hko-warnings/);
    assert.match(naturalSeed, /'natural:western-pacific-cyclones:v1'/);
    assert.match(naturalSeed, /'weather:hko-warnings:v1'/);
  });

  it('keeps the audit read-only unless the dedicated seeder is invoked', () => {
    const audit = readFileSync(resolve(root, 'scripts/audit-china-coverage.mjs'), 'utf8');
    assert.doesNotMatch(audit, /runSeed|writeExtraKey|\['SET'/);
    assert.match(audit, /--json/);
  });

  it('persists China feed availability beside the global insights ranking', () => {
    assert.match(insightsSeed, /const CHINA_COVERAGE_KEY = 'news:insights:v1:CN'/);
    assert.match(insightsSeed, /buildChinaNewsCoverage\(\{/);
    assert.match(insightsSeed, /CHINA_NEWS_DIGEST_LANGUAGE = 'zh'/);
    assert.match(insightsSeed, /readChinaNewsDigest\(\)/);
    assert.match(insightsSeed, /\[CHINA_NEWS_DIGEST_LANGUAGE\]: await readChinaNewsDigest\(\)/);
    assert.match(insightsSeed, /digest coverage check failed/);
    assert.match(insightsSeed, /preserveKeys: \[CHINA_COVERAGE_KEY\]/);
    assert.match(insightsSeed, /return preserveChinaNewsCoverageInLkg\(existing, chinaNewsCoverage\)/);
    assert.match(insightsSeed, /writeExtraKey\(CHINA_COVERAGE_KEY, data\.chinaNewsCoverage, CACHE_TTL\)/);
  });

  it('documents the public China source contract and its operator health projection', () => {
    assert.match(dataSources, /### China Coverage, Attribution, and Freshness/);
    assert.match(dataSources, /BIS, IMF, JODI, UN Comtrade, CCFI, AviationStack, NBS\/PBoC, JMA, and HKO/);
    assert.match(dataSources, /detailed bilateral trade data remains\s+Pro-only/i);
    assert.match(healthDocs, /### China Coverage Projection/);
    assert.match(healthDocs, /CHINA_DEGRADED/);
    assert.match(healthDocs, /CHINA_UNAVAILABLE/);
    assert.match(healthDocs, /read-only audit/i);
  });
});
