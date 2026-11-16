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
import { CHANGE_SHADOW } from '../scripts/_orbital-change.mjs';

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

describe('Orbital Watch on the pricing page and in the product facts (#10761)', () => {
  it('is published at launch (#10768) on every pricing surface', () => {
    assert.equal(ORBITAL_WATCH_PRICING_PUBLISHED, true);
    for (const tier of Object.keys(ORBITAL_WATCH_ACCESS)) assert.equal(orbitalWatchAccess(tier), ORBITAL_WATCH_ACCESS[tier], tier);
    for (const path of ['public/pricing.md', 'docs/pricing.mdx', 'docs/zh/pricing.mdx']) {
      assert.match(read(path), /Orbital Watch/, path);
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

  it('claims no site-change alert while change scoring is in shadow', () => {
    // The relay drops orbital_site_change while CHANGE_SHADOW is true (scripts/lib/orbital-site-alerts.cjs).
    if (!CHANGE_SHADOW) return;
    const generator = read('scripts/generate-public-product-facts.mjs');
    const docsCopy = generator.slice(generator.indexOf('const ORBITAL_WATCH_DOCS_COPY'), generator.indexOf('function withOrbitalWatchDocs'));
    for (const text of [...Object.values(ORBITAL_WATCH_PLAN_LINES), docsCopy]) {
      assert.doesNotMatch(text, /change alert|site-change|站点变化/i, text);
    }
  });

  it('the comparison table and the product facts read the same switch', () => {
    assert.match(read('pro-test/src/components/PlanComparisonTable.tsx'), /orbitalWatchAccess\(tier\.localeKey\)/);
    const generator = read('scripts/generate-public-product-facts.mjs');
    assert.match(generator, /orbitalWatchAccess\(TIER_BY_PLAN_KEY\[planKey\]\)/);
    assert.match(generator, /orbitalWatchAccess\('free'\) \?/);
    for (const doc of ['docs/pricing.mdx', 'docs/zh/pricing.mdx']) {
      assert.match(read(doc), /\{\/\* orbital-watch-pricing:start \*\/\}\n[^]*Orbital Watch[^]*\{\/\* orbital-watch-pricing:end \*\/\}/, doc);
    }
  });
});
