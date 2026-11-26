import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { getCountryRisk } from '../server/worldmonitor/intelligence/v1/get-country-risk.ts';
import { TIER1_COUNTRIES } from '../server/worldmonitor/intelligence/v1/_shared.ts';
import { CII_FORMULA_VERSION } from '../server/worldmonitor/intelligence/v1/_risk-config.ts';
import { CII_RISK_SCORE_CACHE_KEYS } from '../server/_shared/cache-keys.ts';
import { loadCiiFixtures, scoreCiiFixture } from '../scripts/lib/cii-fixtures.mts';
import { buildCountryRollup, countryKey, ORBITAL_SITES_KEY } from '../scripts/_orbital-sites.mjs';
import { flagShadowKey } from '../scripts/_orbital-change.mjs';
import {
  IMAGERY_CONTEXT_EXCLUSION,
  imageryChangeSummary,
} from '../src/components/_risk-imagery-context.ts';
import { installRedis } from './helpers/fake-upstash-redis.mts';

const NOW = Date.UTC(2026, 10, 13, 12);
const DAY = 86_400_000;
const originalFetch = globalThis.fetch;
const originalNow = Date.now;
const originalEnv = { ...process.env };

const confirmedFlag = (datetime: string) => ({
  state: 'confirmed',
  updatedAt: NOW - DAY,
  tracks: { 'asc:28': { state: 'confirmed', confirmedBy: { itemId: `S1A_${datetime}`, datetime } } },
});
const raisedFlag = { state: 'raised', updatedAt: NOW - DAY, tracks: { 'asc:28': { state: 'raised', confirmedBy: null } } };

function site(siteId: string, name: string, countryCode: string, flag: unknown, evaluatedAt = NOW - DAY) {
  return {
    siteId, name, countryCode, lat: 0, lon: 0, surface: 'land', origins: [{ list: 'nuclear-facility', id: siteId }],
    revision: `${siteId}@1`, evaluatedAt, lastObservation: null, nextWindows: [], coverage: [], flag,
  };
}

function orbitalKeys(rollups: ReturnType<typeof buildCountryRollup>[]) {
  return {
    [ORBITAL_SITES_KEY]: {
      schema: 1,
      countries: Object.fromEntries(rollups.map((r) => [r.countryCode, { revision: r.revision, asOf: r.asOf, siteCount: r.sites.length }])),
    },
    ...Object.fromEntries(rollups.map((r) => [countryKey(r.countryCode), r])),
  };
}

const IR_RECORDS = [
  site('nuclear-facility:natanz', 'Natanz nuclear facility', 'IR', confirmedFlag('2026-11-10T02:41:00Z')),
  site('nuclear-facility:fordow', 'Fordow enrichment plant', 'IR', raisedFlag),
  site('nuclear-facility:bushehr', 'Bushehr nuclear power plant', 'IR', null),
];
const OUTSIDE = 'DJ';
const DJ_RECORDS = [site('port:djibouti', 'Port of Djibouti', OUTSIDE, confirmedFlag('2026-11-09T15:12:00Z'))];

const BASE_KEYS = {
  [CII_RISK_SCORE_CACHE_KEYS.stale]: {
    ciiScores: [{
      region: 'IR', staticBaseline: 40, dynamicScore: 30, combinedScore: 70, trend: 'TREND_DIRECTION_RISING',
      components: { newsActivity: 1, ciiContribution: 2, geoConvergence: 3, militaryActivity: 4 }, computedAt: NOW - 3_600_000,
      methodologyVersion: CII_FORMULA_VERSION,
    }],
  },
  'intelligence:advisories:v1': { byCountry: { IR: 'do-not-travel' }, byCountryName: {} },
  'sanctions:country-counts:v1': { IR: 40 },
};

const ctx = { request: new Request('https://api.worldmonitor.app/api/intelligence/v1/get-country-risk'), pathParams: {}, headers: {} };

function useRedis(keys: Record<string, unknown>) {
  globalThis.fetch = installRedis(keys).fetchImpl as typeof fetch;
}
const read = (countryCode: string) => getCountryRisk(ctx, { countryCode });

beforeEach(() => {
  delete process.env.LOCAL_API_MODE;
  Date.now = () => NOW;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  Date.now = originalNow;
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
});

describe('imagery change flags stay out of the Country Instability Index', () => {
  it('the scorer never reads a watched-site key, for every committed fixture', () => {
    const flagKeys = orbitalKeys([buildCountryRollup('IR', IR_RECORDS), buildCountryRollup(OUTSIDE, DJ_RECORDS)]);
    for (const fixture of loadCiiFixtures()) {
      const read = new Set<string>();
      const inputs = new Proxy({ ...fixture.inputs, ...flagKeys }, {
        get(target, key, receiver) { if (typeof key === 'string') read.add(key); return Reflect.get(target, key, receiver); },
      });
      assert.deepEqual(scoreCiiFixture({ ...fixture, inputs }), scoreCiiFixture(fixture), fixture.label);
      assert.ok(read.size > 0, `${fixture.label}: the scorer reads its inputs through this object`);
      assert.deepEqual(Object.keys(flagKeys).filter((key) => read.has(key)), [], fixture.label);
    }
  });

  it('the risk response carries the same score with and without flag records', async () => {
    useRedis(BASE_KEYS);
    const without = await read('IR');
    useRedis({ ...BASE_KEYS, ...orbitalKeys([buildCountryRollup('IR', IR_RECORDS)]) });
    const withFlags = await read('IR');
    assert.equal(JSON.stringify(withFlags.cii), JSON.stringify(without.cii));
    assert.equal(withFlags.fetchedAt, without.fetchedAt);
    assert.equal(without.imageryChange, undefined);
  });
});

describe('imagery change context beside country risk', () => {
  it('a country with a confirmed flag names it out of the watched sites whose change is scored', async () => {
    const port = { ...site('port:bandar-abbas', 'Port of Bandar Abbas', 'IR', null), surface: 'maritime' };
    useRedis({ ...BASE_KEYS, ...orbitalKeys([buildCountryRollup('IR', [...IR_RECORDS, port])]) });
    const response = await read('IR');
    assert.deepEqual(response.imageryChange, {
      // Natanz and Fordow are scored; Bushehr (unscored) and the port (never scored) are not counted.
      watchedSiteCount: 2,
      confirmedSites: [{ siteId: 'nuclear-facility:natanz', name: 'Natanz nuclear facility', confirmedAt: Date.parse('2026-11-10T02:41:00Z') }],
    });
  });

  it('a country outside the scored set still returns the context and no score', async () => {
    assert.ok(!(OUTSIDE in TIER1_COUNTRIES));
    useRedis({ ...BASE_KEYS, ...orbitalKeys([buildCountryRollup(OUTSIDE, DJ_RECORDS)]) });
    const response = await read(OUTSIDE);
    assert.equal(response.cii, undefined);
    assert.equal(response.upstreamUnavailable, false);
    assert.equal(response.imageryChange?.confirmedSites[0]?.siteId, 'port:djibouti');
  });

  it('a confirmed flag held only in the shadow key is not surfaced', async () => {
    const shadowed = IR_RECORDS.map((record) => ({ ...record, flag: null }));
    useRedis({
      ...BASE_KEYS,
      ...orbitalKeys([buildCountryRollup('IR', shadowed)]),
      [flagShadowKey('nuclear-facility:natanz')]: { siteId: 'nuclear-facility:natanz', ...confirmedFlag('2026-11-10T02:41:00Z') },
    });
    assert.equal((await read('IR')).imageryChange, undefined, 'no count is served while scoring is shadowed');
  });

  it('a stale or superseded site summary contributes nothing', async () => {
    const stale = buildCountryRollup('IR', IR_RECORDS.map((record) => ({ ...record, evaluatedAt: NOW - 4 * DAY })));
    useRedis({ ...BASE_KEYS, ...orbitalKeys([stale]) });
    assert.equal((await read('IR')).imageryChange, undefined);

    const current = buildCountryRollup('IR', IR_RECORDS);
    useRedis({ ...BASE_KEYS, ...orbitalKeys([current]), [ORBITAL_SITES_KEY]: { schema: 1, countries: { IR: { revision: 'older' } } } });
    assert.equal((await read('IR')).imageryChange, undefined);
  });
});

describe('published exclusion', () => {
  it('the risk display pairs the named flag with the exclusion text', () => {
    const summary = imageryChangeSummary({
      watchedSiteCount: 3,
      confirmedSites: [{ siteId: 'nuclear-facility:natanz', name: 'Natanz nuclear facility', confirmedAt: Date.parse('2026-11-10T02:41:00Z') }],
    });
    assert.equal(summary, 'Imagery statistics changed at 1 of 3 watched sites: Natanz nuclear facility (confirmed 2026-11-10).');
    assert.match(IMAGERY_CONTEXT_EXCLUSION, /not part of the instability score/);
    const panel = readFileSync(new URL('../src/components/CountryDeepDivePanel.ts', import.meta.url), 'utf8');
    assert.match(panel, /IMAGERY_CONTEXT_EXCLUSION/);
    assert.equal(imageryChangeSummary({ watchedSiteCount: 3, confirmedSites: [] }), null);
    assert.equal(imageryChangeSummary(undefined), null);
  });

  it('the input register gives the imagery change signal the context verdict', () => {
    const register = readFileSync(new URL('../docs/methodology/cii-input-register.md', import.meta.url), 'utf8');
    const row = register.split('\n').find((line) => line.includes('`orbital:country:v1:<code>`'));
    assert.ok(row, 'imagery change row present');
    assert.match(row, /\| \*\*context\*\* \|$/);
    const methodology = readFileSync(new URL('../docs/methodology/cii-risk-scores.mdx', import.meta.url), 'utf8');
    assert.ok(methodology.includes(IMAGERY_CONTEXT_EXCLUSION), 'published page carries the displayed exclusion');
  });
});
