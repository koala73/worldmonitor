// An on-demand bootstrap key is served from a caller-invariant public URL
// (`?keys=<name>&public=1`) sitting behind a shared CDN. That CDN shield has no
// idea how often the key's seeder publishes: api/bootstrap.js falls every
// unprofiled on-demand key back to the SLOW tier, whose shield is s-maxage=7200
// (2 hours).
//
// When that shield outlives the key's own freshness budget, the failure is
// silent and it is the worst shape available: the client gets a payload the
// health endpoint would already call STALE_SEED, `dataFreshness.recordUpdate`
// stamps it as a fresh read, and the freshness panel goes green over data
// nobody re-fetched. Nothing pages, because health probes Redis directly and
// never sees the cached copy the browser got.
//
// So: for every on-demand key whose seeder declares a freshness budget in
// api/health.js SEED_META, the CDN shield must not exceed that budget. #6763
// found bcOpen511 already violating it (90-minute budget, 120-minute shield)
// and would have added canadaRoads and albertaRoads (45-minute budget) to the
// list by moving them off the fast tier.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { __testing__ } from '../api/bootstrap.js';
import { bootstrapTierKeyNames } from '../shared/bootstrap-tier-keys.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const healthSrc = readFileSync(join(root, 'api/health.js'), 'utf8');

/**
 * SEED_META writes budgets as digits (`45`), underscore-separated digits
 * (`2_160`) and expressions (`60 * 24 * 14`). Reading only `\d+` off any of the
 * last two silently yields 2 and 60 — small enough to look like a violation, so
 * a naive parser here manufactures alarms rather than missing them.
 */
function evalNumberExpression(expression: string): number {
  const cleaned = expression.replace(/_/g, '').trim();
  assert.match(cleaned, /^[0-9\s()+*/.-]+$/, `unsafe numeric expression: ${expression}`);
  const value = Function(`"use strict"; return (${cleaned});`)();
  assert.ok(Number.isFinite(value), `not a finite number: ${expression}`);
  return value as number;
}

/**
 * The `SEED_META.<key>` object source. Brace-matched rather than regex-bounded:
 * entries nest a `cutover: { ... }` block, so `[^}]*` stops early and
 * `[\s\S]*?` runs on into the NEXT key's fields for any entry that declares no
 * maxStaleMin — attributing a sibling's budget to this key.
 */
function seedMetaBlock(key: string): string | null {
  const start = new RegExp(`\\n  ${key}:\\s*\\{`).exec(healthSrc);
  if (!start) return null;
  let depth = 0;
  const from = healthSrc.indexOf('{', start.index);
  for (let i = from; i < healthSrc.length; i++) {
    if (healthSrc[i] === '{') depth += 1;
    else if (healthSrc[i] === '}') {
      depth -= 1;
      if (depth === 0) return healthSrc.slice(from, i + 1);
    }
  }
  return null;
}

/**
 * The seeder freshness budget api/health.js declares for a bootstrap key, in
 * minutes, or null when health does not probe it or declares no budget.
 * Read from SEED_META so the budget and the CDN shield cannot drift apart.
 */
function healthMaxStaleMin(key: string): number | null {
  const block = seedMetaBlock(key);
  if (!block) return null;
  const match = /maxStaleMin:\s*([^,\n}]+)/.exec(block);
  return match ? evalNumberExpression(match[1]) : null;
}

/** `s-maxage` the shared CDN would apply to `?keys=<key>&public=1`, in seconds. */
function cdnMaxAgeSeconds(key: string): number {
  const headers = __testing__.successCacheHeaders(null, 'public-on-demand', {}, key);
  const cdn = headers['CDN-Cache-Control'];
  assert.ok(cdn, `on-demand key ${key} must emit a CDN-Cache-Control header`);
  const match = /s-maxage=(\d+)/.exec(cdn);
  assert.ok(match, `on-demand key ${key} must declare s-maxage (got: ${cdn})`);
  return Number(match[1]);
}

test('SEED_META budgets are actually readable, or this whole suite is vacuous', () => {
  // Without this, a rename in api/health.js would turn every budget into null
  // and the guard below would pass by having nothing to check.
  assert.equal(healthMaxStaleMin('bcOpen511'), 90, 'plain digits');
  // A nested cutover block sits between the key and its closing brace.
  assert.equal(healthMaxStaleMin('torontoRoads'), 360, 'budget declared before a nested cutover');
  // The three shapes that defeat a `\d+` read. Each of these was reported as a
  // violation by the first version of this guard: 2_160 read as 2, and
  // 60 * 24 * 14 read as 60.
  assert.equal(healthMaxStaleMin('chinaPolicyEvents'), 2160, 'underscore-separated digits');
  assert.equal(healthMaxStaleMin('portwatchChokepointsRef'), 20160, 'multiplied expression');
  assert.equal(healthMaxStaleMin('energyDisruptions'), 20160, 'underscore-separated, five digits');
  assert.equal(healthMaxStaleMin('__not_a_key__'), null, 'an unprobed key must read as null, not 0');
});

test('an unprofiled on-demand key still inherits a 2h CDN shield', () => {
  // Pins the hazard this suite exists to bound. If the fallback ever tightens,
  // the assertions below stop proving anything and this fails first.
  assert.equal(cdnMaxAgeSeconds('__unprofiled_key__'), 7200);
});

test('no on-demand key is cached at the edge past its freshness budget', () => {
  const violations: string[] = [];
  let checked = 0;

  for (const key of bootstrapTierKeyNames('on-demand')) {
    const budgetMin = healthMaxStaleMin(key);
    if (budgetMin === null) continue; // health does not probe it; nothing to compare against
    checked += 1;
    const shieldSec = cdnMaxAgeSeconds(key);
    if (shieldSec > budgetMin * 60) {
      violations.push(
        `${key}: CDN s-maxage=${shieldSec}s (${shieldSec / 60}min) exceeds the `
        + `${budgetMin}min freshness budget api/health.js declares — add an `
        + 'ON_DEMAND_CACHE_PROFILES entry sized to the publisher interval',
      );
    }
  }

  assert.ok(checked >= 4, `expected several probed on-demand keys, checked ${checked}`);
  assert.deepEqual(violations, []);
});
