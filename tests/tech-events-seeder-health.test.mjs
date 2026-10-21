import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { __testing__ } from '../api/health.js';
import { findOperationalProblems } from '../scripts/check-seed-freshness.mjs';

const NAME = 'techEventsSeeder';
const KEY = 'research:tech-events:v1';
const META = 'seed-meta:research:tech-events:seeder';
const NOW = Date.parse('2027-01-01T12:00:00Z');

test('operator health uses the same tech-events staleness limit', () => {
  const source = readFileSync(new URL('../api/seed-health.js', import.meta.url), 'utf8');
  const entry = source.match(/'research:tech-events-seeder':\s*\{\s*key:\s*'([^']+)',\s*intervalMin:\s*(\d+)/);
  assert.ok(entry);
  assert.equal(entry[1], __testing__.SEED_META[NAME].key);
  assert.equal(Number(entry[2]) * 2, __testing__.SEED_META[NAME].maxStaleMin);
});

test('compact health alerts on an overdue tech-events seeder independently of the relay', () => {
  assert.equal(__testing__.STANDALONE_KEYS[NAME], KEY);
  assert.equal(__testing__.SEED_META[NAME].key, META);
  assert.equal(__testing__.SEED_META[NAME].maxStaleMin, 180);
  for (const [age, expected] of [[60, 'OK'], [180, 'OK'], [181, 'STALE_SEED']]) {
    const entry = __testing__.classifyKey(NAME, KEY, { allowOnDemand: false }, {
      keyStrens: new Map([[KEY, 1024]]),
      keyErrors: new Map(),
      keyMetaValues: new Map([
        [META, JSON.stringify({ fetchedAt: NOW - age * 60_000, recordCount: 2 })],
        ['seed-meta:research:tech-events', JSON.stringify({ fetchedAt: NOW, recordCount: 2 })],
      ]),
      keyMetaErrors: new Map(),
      now: NOW,
    });
    assert.equal(entry.status, expected);
    const compact = __testing__.healthResponseBody({
      status: expected === 'OK' ? 'HEALTHY' : 'DEGRADED',
      checkedAt: new Date(NOW).toISOString(),
      checks: { [NAME]: entry },
    }, true);
    const problems = findOperationalProblems(compact, NOW);
    assert.equal(problems.length, expected === 'OK' ? 0 : 1);
    if (expected === 'STALE_SEED') assert.equal(compact.problems[NAME].status, 'STALE_SEED');
  }
});
