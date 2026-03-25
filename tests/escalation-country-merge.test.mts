/**
 * Regression tests for Escalation Monitor duplicate country rows.
 *
 * Root cause: the escalation adapter collected signals from 3 sources with
 * inconsistent country formats: protests used full names ("Iran") from ACLED,
 * outages used full names from proto, and news clusters used ISO2 codes ("IR")
 * from matchCountryNamesInText(). The correlation engine's clusterByCountry()
 * groups by raw string, so "Iran" !== "IR" produced separate rows.
 *
 * Fix: normalizeToCode() in escalation.ts converts all country values to ISO2
 * before pushing signals. generateTitle() resolves ISO2 back to full names.
 */

import { describe, it, before, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const readSrc = (relPath: string) => readFileSync(resolve(root, relPath), 'utf-8');

// ============================================================
// 1. Static analysis: source structure guarantees
// ============================================================

describe('escalation adapter — country normalization structure', () => {
  const src = readSrc('src/services/correlation-engine/adapters/escalation.ts');

  it('all signals.push() blocks use normalizedCountry, not raw country', () => {
    const pushBlocks = src.split('signals.push({');
    for (let i = 1; i < pushBlocks.length; i++) {
      const block = pushBlocks[i]!.split('}')[0]!;
      assert.match(
        block,
        /country:\s*normalizedCountry/,
        `signals.push() block #${i} must use normalizedCountry, not raw p.country/o.country/country`,
      );
    }
  });

  it('each signal source has a continue guard before push', () => {
    const guardPattern = /if\s*\(\s*!normalizedCountry\s*\)\s*continue/g;
    const matches = src.match(guardPattern);
    assert.ok(matches, 'must have normalizedCountry continue guards');
    assert.ok(
      matches.length >= 3,
      `expected at least 3 continue guards (one per source), found ${matches.length}`,
    );
  });

  it('generateTitle resolves ISO2 via getCountryNameByCode', () => {
    const titleFn = src.slice(src.indexOf('generateTitle'));
    assert.match(
      titleFn,
      /getCountryNameByCode\s*\(/,
      'generateTitle must call getCountryNameByCode to resolve ISO2 to full name',
    );
  });

  it('normalizeToCode is NOT exported', () => {
    assert.doesNotMatch(
      src,
      /export\s+(function|const)\s+normalizeToCode/,
      'normalizeToCode must be a module-private helper, not exported',
    );
    assert.match(
      src,
      /function\s+normalizeToCode/,
      'normalizeToCode function must exist',
    );
  });

  it('nameToCountryCode runs before the 2-char fast path', () => {
    const fnBody = src.slice(src.indexOf('function normalizeToCode'), src.indexOf('const ESCALATION_KEYWORDS'));
    const nameIdx = fnBody.indexOf('nameToCountryCode');
    const twoCharIdx = fnBody.indexOf("trimmed.length === 2");
    assert.ok(nameIdx > 0, 'normalizeToCode must call nameToCountryCode');
    assert.ok(twoCharIdx > 0, 'normalizeToCode must have 2-char fast path');
    assert.ok(nameIdx < twoCharIdx, 'nameToCountryCode must run BEFORE the 2-char fast path to resolve aliases like UK->GB');
  });

  it('imports nameToCountryCode and getCountryNameByCode from country-geometry', () => {
    assert.match(src, /nameToCountryCode/, 'must import nameToCountryCode');
    assert.match(src, /getCountryNameByCode/, 'must import getCountryNameByCode');
    assert.match(src, /iso3ToIso2Code/, 'must import iso3ToIso2Code');
  });
});

// ============================================================
// 2. Behavioral tests: adapter-level with mocked geometry
// ============================================================

const MOCK_GEOJSON = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: {
        name: 'Iran',
        'ISO3166-1-Alpha-2': 'IR',
        'ISO3166-1-Alpha-3': 'IRN',
      },
      geometry: {
        type: 'Polygon',
        coordinates: [[[44, 25], [63, 25], [63, 40], [44, 40], [44, 25]]],
      },
    },
    {
      type: 'Feature',
      properties: {
        name: 'United Kingdom',
        'ISO3166-1-Alpha-2': 'GB',
        'ISO3166-1-Alpha-3': 'GBR',
      },
      geometry: {
        type: 'Polygon',
        coordinates: [[[-8, 49], [2, 49], [2, 61], [-8, 61], [-8, 49]]],
      },
    },
  ],
};

const originalFetch = globalThis.fetch;

describe('escalation adapter — behavioral country normalization', () => {
  before(async () => {
    mock.method(globalThis, 'fetch', (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
      if (urlStr.includes('countries.geojson')) {
        return Promise.resolve(new Response(JSON.stringify(MOCK_GEOJSON), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }));
      }
      if (urlStr.includes('country-boundary-overrides')) {
        return Promise.resolve(new Response(JSON.stringify({ type: 'FeatureCollection', features: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }));
      }
      return originalFetch(url, init);
    });

    const { preloadCountryGeometry } = await import('@/services/country-geometry');
    await preloadCountryGeometry();
  });

  it('collectSignals normalizes "Iran" protest to ISO2 "IR"', async () => {
    const { escalationAdapter } = await import('@/services/correlation-engine/adapters/escalation');
    const now = new Date();
    const ctx = {
      intelligenceCache: {
        protests: {
          events: [{
            country: 'Iran',
            severity: 'high',
            lat: 35.7,
            lon: 51.4,
            time: now,
            eventType: 'protest',
            title: 'Test protest in Tehran',
          }],
        },
        outages: [],
      },
      latestClusters: [],
    } as any;

    const signals = escalationAdapter.collectSignals(ctx);
    const conflictSignals = signals.filter(s => s.type === 'conflict_event');
    assert.ok(conflictSignals.length > 0, 'should produce at least one conflict signal');
    for (const s of conflictSignals) {
      assert.equal(s.country, 'IR', `conflict signal country should be "IR", got "${s.country}"`);
    }
  });

  it('generateTitle shows full name "Iran" not code "IR"', async () => {
    const { escalationAdapter } = await import('@/services/correlation-engine/adapters/escalation');
    const title = escalationAdapter.generateTitle([
      { type: 'conflict_event', country: 'IR', source: 'signal-aggregator', severity: 80, timestamp: Date.now(), label: 'test' },
      { type: 'news_severity', country: 'IR', source: 'analysis-core', severity: 65, timestamp: Date.now(), label: 'test' },
    ] as any);
    assert.ok(title.includes('Iran'), `title should contain "Iran", got "${title}"`);
    assert.ok(title.includes('conflict'), `title should contain "conflict", got "${title}"`);
    assert.ok(title.includes('news escalation'), `title should contain "news escalation", got "${title}"`);
  });

  it('protest "Iran" and news "IR" normalize to same code for clustering', async () => {
    const { escalationAdapter } = await import('@/services/correlation-engine/adapters/escalation');
    const now = new Date();
    const ctx = {
      intelligenceCache: {
        protests: {
          events: [{
            country: 'Iran',
            severity: 'high',
            lat: 35.7,
            lon: 51.4,
            time: now,
            eventType: 'armed clash',
            title: 'Armed clash in Iran',
          }],
        },
        outages: [],
      },
      latestClusters: [{
        primaryTitle: 'Military escalation in Iran threatens region',
        threat: { level: 'high' },
        lastUpdated: now,
        lat: 35.7,
        lon: 51.4,
      }],
    } as any;

    const signals = escalationAdapter.collectSignals(ctx);
    const iranSignals = signals.filter(s => s.country === 'IR');
    const nonIrSignals = signals.filter(s => s.country && s.country !== 'IR');
    assert.ok(iranSignals.length >= 2, `expected at least 2 signals with country "IR", got ${iranSignals.length}`);
    assert.equal(nonIrSignals.length, 0, `no signals should have country other than "IR", found: ${nonIrSignals.map(s => s.country)}`);
  });

  it('two-letter alias "UK" normalizes to canonical "GB" via nameToCountryCode', async () => {
    const { escalationAdapter } = await import('@/services/correlation-engine/adapters/escalation');
    const now = new Date();
    const ctx = {
      intelligenceCache: {
        protests: {
          events: [{
            country: 'UK',
            severity: 'medium',
            lat: 51.5,
            lon: -0.1,
            time: now,
            eventType: 'protest',
            title: 'Protest in London',
          }],
        },
        outages: [],
      },
      latestClusters: [],
    } as any;

    const signals = escalationAdapter.collectSignals(ctx);
    const ukSignals = signals.filter(s => s.type === 'conflict_event');
    assert.ok(ukSignals.length > 0, 'should produce at least one conflict signal');
    for (const s of ukSignals) {
      assert.equal(s.country, 'GB', `"UK" alias should normalize to "GB", got "${s.country}"`);
    }
  });
});
