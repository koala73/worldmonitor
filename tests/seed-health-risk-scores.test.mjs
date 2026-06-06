import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const repoRoot = resolve(import.meta.dirname, '..');

function readRepoFile(path) {
  return readFileSync(resolve(repoRoot, path), 'utf8');
}

function extractObjectEntry(source, entryName) {
  const pattern = new RegExp(`${entryName}:\\s*\\{\\s*key:\\s*'([^']+)',\\s*(?:maxStaleMin|intervalMin):\\s*([0-9_]+)`);
  const match = source.match(pattern);
  assert.ok(match, `missing ${entryName} freshness entry`);
  return { key: match[1], minutes: Number(match[2].replaceAll('_', '')) };
}

test('seed-health CII risk score freshness mirrors api/health riskScores', () => {
  const seedHealth = readRepoFile('api/seed-health.js');
  const health = readRepoFile('api/health.js');

  const healthRiskScores = extractObjectEntry(health, 'riskScores');
  const seedHealthMatch = seedHealth.match(
    /'intelligence:risk-scores':\s*\{\s*key:\s*'([^']+)',\s*intervalMin:\s*([0-9_]+)/,
  );

  assert.ok(seedHealthMatch, 'api/seed-health.js must register intelligence:risk-scores');
  assert.equal(seedHealthMatch[1], 'seed-meta:intelligence:risk-scores');
  assert.equal(healthRiskScores.key, seedHealthMatch[1]);
  assert.equal(
    Number(seedHealthMatch[2].replaceAll('_', '')) * 2,
    healthRiskScores.minutes,
    'seed-health intervalMin*2 must match api/health.js riskScores maxStaleMin',
  );
  assert.ok(
    seedHealth.includes('api/health.js riskScores'),
    'seed-health CII comment should keep the alignment target explicit',
  );
  assert.doesNotMatch(
    seedHealth,
    /seed-meta:risk:scores:sebuf/,
    'seed-health must not drift back to the retired risk:scores:sebuf seed-meta key',
  );
  assert.doesNotMatch(
    seedHealth,
    /'risk:scores:sebuf':/,
    'seed-health must not publish the retired risk:scores:sebuf seed domain',
  );
});
