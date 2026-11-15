import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  ORBITAL_WATCH_ACCESS,
  ORBITAL_WATCH_PLAN_LINES,
  ORBITAL_WATCH_PRICING_PUBLISHED,
  orbitalWatchAccess,
} from '../shared/orbital-watch-pricing.ts';
import tiers from '../pro-test/src/generated/tiers.json' with { type: 'json' };

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

describe('Orbital Watch on the pricing page and in the product facts (#10761)', () => {
  it('stays hidden until launch', () => {
    assert.equal(ORBITAL_WATCH_PRICING_PUBLISHED, false);
    for (const tier of Object.keys(ORBITAL_WATCH_ACCESS)) assert.equal(orbitalWatchAccess(tier), null, tier);
    for (const path of ['public/pricing.md', 'shared/product-facts.generated.json']) {
      assert.doesNotMatch(read(path), /Orbital Watch/, path);
    }
  });

  it('gives every pricing-table tier one access level once published', () => {
    const tierKeys = (tiers as Array<{ localeKey: string }>).map((tier) => tier.localeKey);
    for (const key of tierKeys) assert.ok(orbitalWatchAccess(key, true), key);
    assert.equal(orbitalWatchAccess('free', true), 'lookup');
    assert.equal(orbitalWatchAccess('pro', true), 'alerts-mcp');
    assert.equal(orbitalWatchAccess('api', true), 'alerts-mcp-api');
    assert.equal(orbitalWatchAccess('unknown-tier', true), null);
  });

  it('free copy claims only the browser lookup and the public latest image', () => {
    assert.doesNotMatch(ORBITAL_WATCH_PLAN_LINES.lookup, /alert|MCP|API/i);
    assert.doesNotMatch(ORBITAL_WATCH_PLAN_LINES['alerts-mcp'], /REST API/);
  });

  it('claims no feature that has not shipped', () => {
    for (const line of Object.values(ORBITAL_WATCH_PLAN_LINES)) {
      assert.doesNotMatch(line, /before and after|own sites|team|report|bulk|export/i, line);
    }
  });

  it('the comparison table and the product facts read the same switch', () => {
    assert.match(read('pro-test/src/components/PlanComparisonTable.tsx'), /orbitalWatchAccess\(tier\.localeKey\)/);
    assert.match(read('scripts/generate-public-product-facts.mjs'), /orbitalWatchAccess\(TIER_BY_PLAN_KEY\[planKey\]\)/);
  });
});
