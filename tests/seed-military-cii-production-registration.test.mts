import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');

interface RailwayServiceEntry {
  entry: string;
  deployMode: 'nixpacks-root-scripts' | 'dockerfile';
  dockerfile?: string;
  service: string;
  documentedAt: string;
}

const registry = JSON.parse(
  readFileSync(resolve(repoRoot, 'scripts/railway-services.json'), 'utf8'),
) as RailwayServiceEntry[];

const seedSrc = readFileSync(resolve(repoRoot, 'scripts/seed-military-cii.mjs'), 'utf8');
const healthSrc = readFileSync(resolve(repoRoot, 'api/health.js'), 'utf8');

function extractConstNumber(src: string, name: string): number {
  const match = new RegExp(`const\\s+${name}\\s*=\\s*(\\d+)\\s*;`).exec(src);
  assert.ok(match, `could not find numeric const ${name}`);
  return Number(match[1]);
}

function extractConstString(src: string, name: string): string {
  const match = new RegExp(`const\\s+${name}\\s*=\\s*'([^']+)'\\s*;`).exec(src);
  assert.ok(match, `could not find string const ${name}`);
  return match[1]!;
}

function extractHealthMilitaryCiiSeedMeta(): { key: string; maxStaleMin: number } {
  const match = /militaryCii:\s*\{\s*key:\s*'([^']+)'\s*,\s*maxStaleMin:\s*(\d+)\s*\}/.exec(healthSrc);
  assert.ok(match, 'api/health.js must define SEED_META.militaryCii');
  return { key: match[1]!, maxStaleMin: Number(match[2]) };
}

function extractHealthMilitaryCiiDataKey(): string {
  const match = /militaryCii:\s*'([^']+)'/.exec(healthSrc);
  assert.ok(match, 'api/health.js must define STANDALONE_KEYS.militaryCii');
  return match[1]!;
}

function extractCronSchedule(): string {
  const match = /Cron schedule:\s*"([^"]+)"/.exec(seedSrc);
  assert.ok(match, 'scripts/seed-military-cii.mjs must document its Railway cron schedule');
  return match[1]!;
}

function cronIntervalMin(schedule: string): number {
  const match = /^\*\/(\d+) \* \* \* \*$/.exec(schedule);
  assert.ok(match, `unsupported seed-military-cii cron schedule shape: ${schedule}`);
  return Number(match[1]);
}

describe('seed-military-cii production registration', () => {
  it('is registered as a standalone Railway nixpacks service', () => {
    const entries = registry.filter((entry) => entry.entry === 'scripts/seed-military-cii.mjs');
    assert.equal(entries.length, 1, 'scripts/seed-military-cii.mjs must have exactly one Railway registry entry');

    const entry = entries[0]!;
    assert.equal(entry.deployMode, 'nixpacks-root-scripts');
    assert.equal(entry.service, 'seed-military-cii');
    assert.match(entry.documentedAt, /scripts\/seed-military-cii\.mjs/);
  });

  it('documents the Railway cron config that matches the health freshness budget', () => {
    assert.match(seedSrc, /Service name:\s*seed-military-cii/);
    assert.match(seedSrc, /rootDirectory:\s*scripts/);
    assert.match(seedSrc, /startCommand:\s*node seed-military-cii\.mjs/);

    const intervalMin = cronIntervalMin(extractCronSchedule());
    const { maxStaleMin } = extractHealthMilitaryCiiSeedMeta();

    assert.equal(intervalMin, 10, 'seed-military-cii Railway cron must stay at the documented 10min cadence');
    assert.equal(maxStaleMin, 45, 'api/health.js militaryCii maxStaleMin is the production alarm budget');
    assert.ok(
      maxStaleMin >= intervalMin * 3,
      `militaryCii maxStaleMin (${maxStaleMin}) must tolerate at least 3 cron intervals (${intervalMin * 3})`,
    );
    assert.ok(
      maxStaleMin <= intervalMin * 5,
      `militaryCii maxStaleMin (${maxStaleMin}) must still alert within about 5 missed cron intervals`,
    );
  });

  it('keeps the seeder output key and freshness metadata aligned with api/health.js', () => {
    const liveKey = extractConstString(seedSrc, 'LIVE_KEY');
    const liveTtlSec = extractConstNumber(seedSrc, 'LIVE_TTL');
    const seedMeta = extractHealthMilitaryCiiSeedMeta();

    assert.equal(liveKey, 'intelligence:military-cii:v1');
    assert.equal(extractHealthMilitaryCiiDataKey(), liveKey);
    assert.equal(seedMeta.key, 'seed-meta:intelligence:military-cii');
    assert.ok(
      liveTtlSec / 60 >= seedMeta.maxStaleMin,
      `LIVE_TTL (${liveTtlSec}s) must keep ${liveKey} alive until the health alarm budget (${seedMeta.maxStaleMin}min)`,
    );
    assert.match(
      seedSrc,
      /writeFreshnessMetadata\(\s*'intelligence'\s*,\s*'military-cii'[\s\S]*?'seed-military-cii'\s*,\s*LIVE_TTL\s*\)/,
      'seed-military-cii must write seed-meta:intelligence:military-cii with the seed-military-cii source label',
    );
  });
});
