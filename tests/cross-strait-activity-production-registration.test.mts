import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

import { BOOTSTRAP_CACHE_KEYS, BOOTSTRAP_TIERS } from '../shared/bootstrap-tier-keys.js';

const root = resolve(import.meta.dirname, '..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

describe('cross-Strait activity production registration (#5575)', () => {
  it('registers both publishers as direct government sources rather than independent observers', () => {
    const registry = read('shared/source-provenance.ts');
    assert.match(registry, /'Taiwan Ministry of National Defense': 'gov'/);
    assert.match(registry, /'Japan Joint Staff': 'gov'/);
    assert.match(registry, /'Taiwan Ministry of National Defense': \{[\s\S]*?risk: 'high'/);
    assert.match(registry, /'Japan Joint Staff': \{[\s\S]*?risk: 'high'/);
  });

  it('schedules the bounded seeder and registers bootstrap, China coverage, and health', () => {
    assert.equal(BOOTSTRAP_CACHE_KEYS.crossStraitActivity, 'military:cross-strait-activity-bootstrap:v1');
    assert.equal(BOOTSTRAP_TIERS.crossStraitActivity, 'slow');
    assert.match(read('scripts/seed-bundle-derived-signals.mjs'), /seed-cross-strait-activity\.mjs/);
    assert.match(
      read('scripts/china-coverage-manifest.mjs'),
      /id:\s*'military\.cross-strait-activity'[\s\S]*?ownerIssue:\s*5575[\s\S]*?launchStatus:\s*'launched'/,
    );
    assert.match(
      read('api/health.js'),
      /crossStraitActivity:\s*\{ key: 'seed-meta:military:cross-strait-activity'/,
    );
    assert.match(
      read('api/health.js'),
      /crossStraitActivityBootstrap:\s*\{ key: 'seed-meta:military:cross-strait-activity-bootstrap'/,
    );
    assert.match(read('api/health.js'), /crossStraitActivityTaiwanMnd:\s*'military:cross-strait-activity:v1:source:taiwan-mnd'/);
    assert.match(read('api/health.js'), /crossStraitActivityJapanMod:\s*'military:cross-strait-activity:v1:source:japan-mod'/);
    assert.match(read('api/seed-health.js'), /'military:cross-strait-activity'/);
    assert.match(read('api/seed-health.js'), /'military:cross-strait-activity:complete'/);
    assert.match(
      read('scripts/seed-bundle-derived-signals.mjs'),
      /seedMetaKey:\s*'military:cross-strait-activity:complete'/,
    );
  });

  it('hydrates the existing Force Posture panel without touching flight identity rules', () => {
    const panel = read('src/components/MilitaryCorrelationPanel.ts');
    const renderer = read('src/components/cross-strait-activity-summary.ts');
    const flightSeeder = read('scripts/seed-military-flights.mjs');
    assert.match(panel, /getHydratedData\('crossStraitActivity'\)/);
    assert.match(panel, /tryBuildCrossStraitActivityPanelModel/);
    assert.match(panel, /if \(this\.officialActivity\) this\.requestRender\(\)/);
    assert.match(panel, /View Taiwan Strait/);
    assert.match(renderer, /Publisher claim/);
    assert.match(renderer, /not ADS-B or AIS tracks/);
    assert.doesNotMatch(flightSeeder, /cross-strait-activity|Taiwan Ministry of National Defense|Japan Joint Staff/);
  });
});
