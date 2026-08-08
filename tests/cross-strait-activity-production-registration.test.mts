import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

import { BOOTSTRAP_CACHE_KEYS, BOOTSTRAP_TIERS } from '../shared/bootstrap-tier-keys.js';
import { CROSS_STRAIT_BLOCKED_SOURCE_REASONS as PRODUCER_BLOCKED_REASONS } from '../scripts/cross-strait-activity/adapters.mjs';
import { CROSS_STRAIT_BLOCKED_SOURCE_REASONS as CLIENT_BLOCKED_REASONS } from '../src/types/cross-strait-activity';

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

  it('keeps the client blocked-reason mirror identical to the producer list', () => {
    // The client copy cannot import the producer (Railway's nixpacks service
    // copies only scripts/), and a missing reason is NOT a type error: the
    // runtime source-health guard would reject the whole snapshot and the panel
    // would render nothing. Compare the executable values, not their source
    // text, so an added-but-unmirrored reason fails here instead of in prod.
    assert.deepEqual([...CLIENT_BLOCKED_REASONS], [...PRODUCER_BLOCKED_REASONS]);
    assert.ok(PRODUCER_BLOCKED_REASONS.includes('PROXY_TARGET_FORBIDDEN'));
  });

  it('schedules the bounded seeder and registers bootstrap, China coverage, and health', () => {
    assert.equal(BOOTSTRAP_CACHE_KEYS.crossStraitActivity, 'military:cross-strait-activity-bootstrap:v1');
    assert.equal(BOOTSTRAP_TIERS.crossStraitActivity, 'slow');
    assert.match(
      read('scripts/seed-bundle-derived-signals.mjs'),
      // any-of group: the adapter resolves JAPAN_MOD_PROXY_URL || PROXY_URL, so
      // the bundle gate must accept either. Gating on the source-specific name
      // alone hard-failed the section in an environment carrying only the
      // shared exit, even though the seeder would have run undegraded.
      /label:\s*'Cross-Strait-Activity'[\s\S]*?seed-cross-strait-activity\.mjs[\s\S]*?requiredEnv:\s*\[\['JAPAN_MOD_PROXY_URL',\s*'PROXY_URL'\]\]/,
    );
    const railwayServices = JSON.parse(
      read('scripts/railway-services.json'),
    ) as Array<{ service: string; requiredEnv?: (string | string[])[] }>;
    assert.deepEqual(
      railwayServices.find((entry) => entry.service === 'seed-bundle-derived-signals')?.requiredEnv,
      // Any-of, matching the bundle gate above and the adapter's
      // `JAPAN_MOD_PROXY_URL || PROXY_URL`. Unlike market-backup and
      // conflict-intel, NO member of this bundle reaches a bare
      // resolveProxy/PROXY_URL, so neither variable is mandatory on its own --
      // the service just needs one routable exit. Declared flat as
      // ['JAPAN_MOD_PROXY_URL'] the audit failed a production environment
      // carrying only the shared exit, which the seeder runs on undegraded.
      [['JAPAN_MOD_PROXY_URL', 'PROXY_URL']],
    );
    assert.match(
      read('scripts/cross-strait-activity/adapters.mjs'),
      /proxyUrl = process\.env\.JAPAN_MOD_PROXY_URL \|\| process\.env\.PROXY_URL \|\| ''/,
    );
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

  it('pins the resilient Japan MOD source-version marker used by publication health', () => {
    assert.match(
      read('scripts/seed-cross-strait-activity.mjs'),
      /sourceVersion:\s*'taiwan-mnd-html\+japan-joint-staff-homepage-v3'/,
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
