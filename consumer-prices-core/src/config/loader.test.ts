/**
 * Real-config parse gate (#6358 review).
 *
 * Every other test that touches the config layer mocks loadAllRetailerConfigs,
 * so before this file nothing in CI parsed the actual configs/retailers/*.yaml
 * directory through the zod schema. scrape.ts and publish.ts call the real
 * loader with no try/catch around it — a config that fails to parse would pass
 * CI green and then crash the whole scrape/publish job for all markets in
 * production. This suite pins only structural loadability; every ops-tunable
 * value (numResults, delays, queryTemplate, searchType, enabled) stays free.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadAllBasketConfigs, loadAllRetailerConfigs } from './loader.js';

const RETAILERS_DIR = join(import.meta.dirname, '..', '..', 'configs', 'retailers');

describe('retailer config directory', () => {
  it('parses every configs/retailers/*.yaml through the schema without throwing', () => {
    const configs = loadAllRetailerConfigs();
    const yamlFiles = readdirSync(RETAILERS_DIR).filter((f) => f.endsWith('.yaml'));
    expect(configs.length).toBe(yamlFiles.length);
  });

  it('gives every config a slug matching its filename', () => {
    for (const config of loadAllRetailerConfigs()) {
      // panda_sa.yaml must declare slug panda_sa — a copy-paste slug points
      // pins, coverage rows, and scrape-run attribution at the wrong retailer.
      expect(`${config.slug}.yaml`).toBe(
        readdirSync(RETAILERS_DIR).find((f) => f === `${config.slug}.yaml`),
      );
    }
  });

  it('has no duplicate slugs', () => {
    const slugs = loadAllRetailerConfigs().map((c) => c.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it('parses every basket config and keeps each market non-empty for enabled retailers', () => {
    const baskets = loadAllBasketConfigs();
    expect(baskets.length).toBeGreaterThan(0);
    // Every market with at least one ENABLED retailer must have a basket to
    // scrape — an enabled retailer with no basket silently yields 0 targets.
    const basketMarkets = new Set(baskets.map((b) => b.marketCode));
    for (const config of loadAllRetailerConfigs().filter((c) => c.enabled)) {
      expect(basketMarkets, `enabled retailer ${config.slug} has no basket for market ${config.marketCode}`).toContain(
        config.marketCode,
      );
    }
  });
});
