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

function extractSourceRange(source, startNeedle, endNeedle) {
  const start = source.indexOf(startNeedle);
  assert.notEqual(start, -1, `missing ${startNeedle}`);
  const end = source.indexOf(endNeedle, start);
  assert.notEqual(end, -1, `missing ${endNeedle}`);
  return source.slice(start, end);
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
  assert.match(
    health,
    /riskScores:\s*\{\s*key:\s*'seed-meta:intelligence:risk-scores',\s*maxStaleMin:\s*30,\s*minRecordCount:\s*3\s*\}/,
    'api/health.js riskScores must degrade partial realtime signal-density coverage via minRecordCount=3',
  );
  assert.match(
    health,
    /signal-density coverage/i,
    'api/health.js riskScores comment must document that recordCount is not raw feed availability',
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

test('relay CII warm-ping delegates risk-score health count to the RPC handler', () => {
  const relay = readRepoFile('scripts/ais-relay.cjs');
  const handler = readRepoFile('server/worldmonitor/intelligence/v1/get-risk-scores.ts');
  const warmPing = extractSourceRange(
    relay,
    'async function seedCiiWarmPing()',
    'function startCiiWarmPingLoop()',
  );

  assert.doesNotMatch(
    warmPing,
    /upstashSet\(\s*['"]seed-meta:intelligence:risk-scores/,
    'relay warm-ping must not overwrite the handler signal-coverage count with the structural CII row count',
  );
  assert.doesNotMatch(
    warmPing,
    /recordCount:\s*(?:count|data\?\.ciiScores\?\.length)/,
    'relay warm-ping must not derive seed-meta recordCount from ciiScores.length',
  );
  assert.match(
    warmPing,
    /fetch\(ciiWarmPingUrl\(\)/,
    'relay warm-ping must bypass CDN cache so the handler can refresh its own seed-meta on fresh fetches',
  );
  assert.match(
    relay,
    /_wm_warm_ping=/,
    'CII warm-ping URL must carry a private cache-busting query parameter',
  );
  assert.match(
    handler,
    /countCiiRealtimeSignalDensityCoverage\(acled,\s*aux,\s*nowMs\)/,
    'get-risk-scores handler must derive riskScores recordCount from real-time CII signal-density coverage using the request clock',
  );
  assert.match(
    handler,
    /not a raw feed heartbeat/i,
    'get-risk-scores handler must document that signal-density health can differ from feed availability',
  );
});
