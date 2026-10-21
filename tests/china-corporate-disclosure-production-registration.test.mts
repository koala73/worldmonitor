import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

import { BOOTSTRAP_CACHE_KEYS, BOOTSTRAP_TIERS } from '../shared/bootstrap-tier-keys.js';
import {
  DECISION_SIGNAL_PROVENANCE_FAMILY_REGISTRATIONS,
} from '../shared/decision-signal-provenance';
import {
  CHINA_CORPORATE_DISCLOSURE_MAX_STALE_MIN,
} from '../scripts/seed-china-corporate-disclosures.mjs';
import {
  CHINA_COVERAGE_ENTRIES,
} from '../scripts/china-coverage-manifest.mjs';
import {
  evaluateChinaCoverage,
} from '../scripts/china-coverage-health.mjs';
import { __testing__ as healthTesting } from '../api/health.js';

const root = resolve(import.meta.dirname, '..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

describe('China corporate disclosure production registration (#5577)', () => {
  it('launches the shared exchange-disclosure provenance family', () => {
    assert.equal(
      DECISION_SIGNAL_PROVENANCE_FAMILY_REGISTRATIONS.exchange_disclosure.launchStatus,
      'launched',
    );
  });

  it('registers SSE and SZSE as reviewed official-exchange publishers', () => {
    const registry = read('shared/source-provenance.ts');
    assert.match(registry, /'Shanghai Stock Exchange': 'market'/);
    assert.match(registry, /'Shenzhen Stock Exchange': 'market'/);
    assert.match(registry, /'Shanghai Stock Exchange': \{[\s\S]*?risk: 'high'/);
    assert.match(registry, /'Shenzhen Stock Exchange': \{[\s\S]*?risk: 'high'/);
  });

  it('schedules the bounded seeder and registers bootstrap plus health', () => {
    assert.equal(
      BOOTSTRAP_CACHE_KEYS.chinaCorporateDisclosures,
      'market:china:corporate-disclosures:v1',
    );
    assert.equal(BOOTSTRAP_TIERS.chinaCorporateDisclosures, 'slow');
    const bundle = read('scripts/seed-bundle-market-backup.mjs');
    // The China Corporate Disclosures member no longer requires RELAY_SHARED_SECRET
    // since the edge hop was retired. The bundle-level requiredEnv below reflects
    // the surviving PROXY_URL dependency.
    const member = /\{[^}]*'China-Corporate-Disclosures'[^}]*\}/u.exec(bundle)?.[0] ?? '';
    assert.doesNotMatch(member, /requiredEnv/u, 'the China disclosure member must not declare a requiredEnv after edge egress retirement');
    const railwayServices = JSON.parse(
      read('scripts/railway-services.json'),
    ) as Array<{ service: string; requiredEnv?: (string | string[])[] }>;
    assert.deepEqual(
      railwayServices.find((entry) => entry.service === 'seed-bundle-market-backup')?.requiredEnv,
      // PROXY_URL stays declared and MANDATORY: seed-gulf-quotes and
      // seed-etf-flows reach it bare through _yahoo-fetch -> resolveProxy ->
      // _proxy-utils (`process.env.PROXY_URL` only), with no source-specific
      // alternative, so dropping it would remove the only alerting path for a
      // variable those members still require.
      //
      // RELAY_SHARED_SECRET was retired with the edge hop (#6200). The bundle
      // now requires PROXY_URL only; SZSE_PROXY_URL remains undeclared since
      // the adapter falls back to PROXY_URL.
      //
      // SZSE_PROXY_URL is deliberately NOT declared. The adapter resolves
      // `SZSE_PROXY_URL || PROXY_URL`, so requiring it would make the audit
      // stricter than the runtime it guards: a production environment carrying
      // only the shared exit routes SZSE fine, but would report drift and throw
      // out of buildRailwayServiceConfigPatch -- vetoing reconciliation for
      // every other service in the same run.
      ['PROXY_URL'],
    );
    assert.match(
      read('scripts/china-corporate-disclosures/adapters.mjs'),
      /proxyUrl = process\.env\.SZSE_PROXY_URL \|\| process\.env\.PROXY_URL \|\| ''/,
    );
    const seed = read('scripts/seed-china-corporate-disclosures.mjs');
    assert.match(
      seed,
      /readSnapshot\(CHINA_CORPORATE_DISCLOSURE_SZSE_FAILURE_META_KEY, \{ strict: true \}\)/,
      'the next run must read a durable SZSE failure that could not enter the last-good snapshot',
    );
    assert.match(
      seed,
      /afterValidationSkip:\s*async \(snapshot\) =>\s*recordSzseTransportFailure\(snapshot\)/,
      'every validation rejection must record the SZSE failure independently of last-good preservation',
    );
    assert.match(
      read('scripts/china-coverage-manifest.mjs'),
      /id:\s*'market\.china-corporate-disclosures'[\s\S]*?ownerIssue:\s*5577[\s\S]*?launchStatus:\s*'launched'/,
    );
    assert.match(
      read('api/health.js'),
      /chinaCorporateDisclosures:\s*\{ key: 'seed-meta:market:china-corporate-disclosures'/,
    );
    assert.equal(
      healthTesting.ZERO_RECORD_DATA_OK_KEYS.has('chinaCorporateDisclosures'),
      true,
      'a present zero-event disclosure snapshot is a valid quiet window',
    );
    assert.match(
      read('api/health.js'),
      /chinaCorporateDisclosures:\s*\{[^}]*maxStaleMin:\s*180/,
    );
    assert.match(
      read('api/seed-health.js'),
      /'market:china-corporate-disclosures':\s*\{[^}]*intervalMin:\s*90/,
      'seed-health uses intervalMin * 2, so its 180-minute alarm must match /api/health',
    );
    assert.equal(
      CHINA_CORPORATE_DISCLOSURE_MAX_STALE_MIN,
      180,
      'the canonical envelope must publish the same 180-minute freshness budget',
    );
  });

  it('hydrates the MarketPanel without adding final API or MCP composition', () => {
    const loader = read('src/app/data-loader.ts');
    const panel = read('src/components/MarketPanel.ts');
    assert.match(loader, /getHydratedData\('chinaCorporateDisclosures'\)/);
    assert.match(
      loader,
      /if \(hydratedDisclosures !== undefined\) \{[\s\S]*?renderDisclosures\(hydratedDisclosures\)/,
      'consume-once bootstrap misses must preserve the last rendered disclosure snapshot',
    );
    assert.match(panel, /renderDisclosures/);
    assert.match(panel, /renderChinaCorporateDisclosureSignals/);
  });

  it('shares the document-host policy across the producer and renderer', () => {
    const policy = read('shared/china-corporate-disclosure-policy.js');
    const adapters = read('scripts/china-corporate-disclosures/adapters.mjs');
    const renderer = read('src/components/market-disclosures.ts');
    assert.match(policy, /CHINA_DISCLOSURE_DOCUMENT_HOSTS/);
    assert.match(adapters, /china-corporate-disclosure-policy\.js/);
    assert.match(renderer, /china-corporate-disclosure-policy\.js/);
    assert.doesNotMatch(renderer, /const DOCUMENT_HOSTS/);
  });

  it('treats a healthy zero-event query window as current China coverage', () => {
    const entry = CHINA_COVERAGE_ENTRIES.find(
      (candidate) => candidate.id === 'market.china-corporate-disclosures',
    );
    assert.ok(entry);
    const now = Date.parse('2026-07-25T12:00:00.000Z');
    const evaluated = evaluateChinaCoverage({
      entries: [entry],
      now,
      data: {
        'market:china:corporate-disclosures:v1': {
          status: 'healthy',
          coverageThrough: '2026-07-25',
          sources: [{ id: 'sse' }, { id: 'szse' }, { id: 'hkex' }],
          events: [],
        },
      },
      meta: {
        'seed-meta:market:china-corporate-disclosures': {
          fetchedAt: now,
          status: 'ok',
        },
      },
    });
    assert.equal(evaluated.entries[0].status, 'healthy');
  });
});
