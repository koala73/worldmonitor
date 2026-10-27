/**
 * Closed-world gate for shared/outlet-profile.json: every outlet in the RSS
 * catalogs, Telegram and X registries carries a reviewed home country,
 * audience, language and ownership class, and nothing else is listed.
 */
import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadOutletCatalog, validateOutletProfiles } from '../scripts/lib/outlet-catalog.mjs';
import { publisherFamilyFor } from '../shared/publisher-families.js';
import { isStateAffiliatedSource } from '../shared/source-provenance.ts';
import { getOutletProfile } from '../server/_shared/outlet-profile.ts';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const profiles = JSON.parse(readFileSync(join(repoRoot, 'shared/outlet-profile.json'), 'utf8'));
const iso2 = Object.keys(JSON.parse(readFileSync(join(repoRoot, 'shared/iso2-to-region.json'), 'utf8')));
const validCountries = new Set([...iso2, 'INTL', 'EU']);

const fixtureCatalog = (entries: Record<string, string[]>) =>
  new Map(Object.entries(entries).map(([name, langs]) => [name, { langs: new Set(langs) }]));
const ok = { country: 'IR', audience: 'domestic', language: 'fa', ownershipClass: 'state' };
const check = (overrides: Partial<Parameters<typeof validateOutletProfiles>[0]>) => validateOutletProfiles({
  profiles: {},
  catalog: new Map(),
  validCountries,
  familyFor: (name: string) => name,
  isStateAffiliated: () => false,
  ...overrides,
});

describe('outlet profile registry', () => {
  let catalog: Awaited<ReturnType<typeof loadOutletCatalog>>;
  before(async () => { catalog = await loadOutletCatalog(repoRoot); });

  it('profiles every catalog outlet and nothing else', () => {
    const problems = validateOutletProfiles({
      profiles,
      catalog,
      validCountries,
      familyFor: publisherFamilyFor,
      isStateAffiliated: isStateAffiliatedSource,
    });
    assert.deepEqual(problems, []);
  });

  it('stays out of browser and shared code', () => {
    // shared/ is bundled into the browser through src/config/feeds.ts.
    const importers: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(join(repoRoot, dir), { withFileTypes: true })) {
        const path = `${dir}/${entry.name}`;
        if (entry.isDirectory()) walk(path);
        else if (/\.(ts|tsx|js|mjs|cjs)$/.test(entry.name) && /outlet-profile/.test(readFileSync(join(repoRoot, path), 'utf8'))) {
          importers.push(path);
        }
      }
    };
    walk('src');
    walk('shared');
    assert.deepEqual(importers, []);
  });

  it('serves the reviewed entry through the server loader', () => {
    const [name, entry] = Object.entries(profiles).find(([key]) => !key.startsWith('_'))!;
    assert.deepEqual(getOutletProfile(name), entry);
    assert.equal(getOutletProfile('No Such Outlet'), null);
  });
});

describe('validateOutletProfiles', () => {
  it('passes a complete, consistent registry', () => {
    assert.deepEqual(check({ profiles: { IRNA: ok }, catalog: fixtureCatalog({ IRNA: ['fa'] }) }), []);
  });

  it('names a catalog outlet with no profile', () => {
    assert.deepEqual(check({ catalog: fixtureCatalog({ Okaz: ['ar'] }) }), ['missing profile: Okaz']);
  });

  it('rejects a profile for an outlet in no catalog', () => {
    assert.deepEqual(check({ profiles: { Gone: ok } }), ['stale profile (not in any catalog): Gone']);
  });

  it('rejects invalid enums, codes and unknown fields', () => {
    const problems = check({
      profiles: { X: { country: 'ZZ', audience: 'global', language: 'Persian', ownershipClass: 'independent', bias: 'left' } },
      catalog: fixtureCatalog({ X: [] }),
    });
    assert.deepEqual(problems, [
      'X: unknown field bias',
      'X: invalid country ZZ',
      'X: invalid audience global',
      'X: invalid language Persian',
      'X: invalid ownershipClass independent',
    ]);
  });

  it('never lets a state-affiliated outlet stay unreviewed', () => {
    const problems = check({
      profiles: { 'Press TV': { ...ok, audience: 'international', language: 'en', ownershipClass: 'unreviewed' } },
      catalog: fixtureCatalog({ 'Press TV': [] }),
      isStateAffiliated: (name: string) => name === 'Press TV',
    });
    assert.deepEqual(problems, ['Press TV: state-affiliated outlet must have a reviewed ownershipClass']);
  });

  it('lets a publisher family vary audience but not home country', () => {
    const catalog = fixtureCatalog({ 'BBC UK': [], 'BBC Persian': ['fa'], 'BBC Fake': [] });
    const familyFor = () => 'bbc';
    const base = { country: 'GB', language: 'en', ownershipClass: 'public-service' };
    assert.deepEqual(check({
      catalog: fixtureCatalog({ 'BBC UK': [], 'BBC Persian': ['fa'] }),
      familyFor,
      profiles: {
        'BBC UK': { ...base, audience: 'domestic' },
        'BBC Persian': { ...base, audience: 'diaspora', language: 'fa' },
      },
    }), []);
    assert.deepEqual(check({
      catalog,
      familyFor,
      profiles: {
        'BBC UK': { ...base, audience: 'domestic' },
        'BBC Persian': { ...base, audience: 'diaspora', language: 'fa' },
        'BBC Fake': { ...base, country: 'US', audience: 'domestic' },
      },
    }), ['publisher family bbc: BBC UK is GB but BBC Fake is US']);
  });

  it('keeps keyword-search feeds multi-publisher and out of family country checks', () => {
    const search = 'https://news.google.com/rss/search?q=%22All-In+podcast%22+when:7d&hl=en-US';
    const site = 'https://news.google.com/rss/search?q=site:reuters.com+crypto+when:1d&hl=en-US';
    const catalog = new Map<string, unknown>([
      ['Reuters', { urls: new Set(['https://www.reuters.com/rss']) }],
      ['Reuters Crypto', { urls: new Set([search]) }],
      ['Reuters Site', { urls: new Set([site]) }],
    ]);
    const base = { audience: 'international', language: 'en' };
    const familyFor = () => 'reuters';
    assert.deepEqual(check({
      catalog,
      familyFor,
      profiles: {
        Reuters: { ...base, country: 'GB', ownershipClass: 'private' },
        'Reuters Crypto': { ...base, country: 'INTL', ownershipClass: 'unreviewed' },
        'Reuters Site': { ...base, country: 'GB', ownershipClass: 'private' },
      },
    }), []);
    assert.deepEqual(check({
      catalog,
      familyFor,
      profiles: {
        Reuters: { ...base, country: 'GB', ownershipClass: 'private' },
        'Reuters Crypto': { ...base, country: 'GB', ownershipClass: 'private' },
        'Reuters Site': { ...base, country: 'GB', ownershipClass: 'private' },
      },
    }), ['Reuters Crypto: keyword-search feed (no site:) must be INTL and unreviewed']);
  });
});
