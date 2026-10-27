/**
 * Source-coverage gate for the unified news catalog (plan U2, R3).
 *
 * Every source the browser can show must be fetched by a digest the server
 * builds, so the dashboard, MCP and every other digest reader see the same
 * news. Today's gap is held in shared/news-catalog-pending-migration.json,
 * which may only shrink.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { INTEL_EDITION } from '../shared/news-catalog-browser';
import { VALID_VARIANTS } from '../server/worldmonitor/news/v1/list-feed-digest';
import { NEWS_LANGUAGES } from '../src/shared/public-rpc-cache';
import {
  browserPlacedNames,
  servedLayout,
  serverPlacedNames,
  uncoveredSources,
  unservedServerPlacements,
  unsupportedLanguages,
  type CoverageFeed,
} from './_lib/news-catalog-coverage.mts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (path: string) => JSON.parse(readFileSync(join(root, path), 'utf8'));

const catalog = readJson('shared/news-catalog.json') as {
  feeds: CoverageFeed[];
  layout: { server: Record<string, string[]> };
};
const pendingNames: string[] = readJson('shared/news-catalog-pending-migration.json').names;
const pending = new Set(pendingNames);

// The categories each digest fetches (buildServerVariantFeeds), plus the intel
// list the full digest also fetches (INTEL_SOURCES).
const SERVED = servedLayout(catalog.layout.server, VALID_VARIANTS, INTEL_EDITION);

// Frozen snapshot of the browser-only sources when the gate landed. The pending
// list may only drop names from it, so a swap (remove one, add another) fails.
// The hash pins the snapshot: changing it is a deliberate, reviewable edit.
const BASELINE_PATH = 'tests/fixtures/news-catalog-pending-baseline.json';
const BASELINE_SHA256 = 'a1b4930b199adda8d4732123fd8298cbd019ac640ca8f0e4ae7ee159bfc686a3';

describe('news catalog source coverage', () => {
  it('every browser source is fetched by a served digest, or pending migration', () => {
    const gaps = uncoveredSources(browserPlacedNames(catalog.feeds), catalog.feeds, SERVED, pending);
    assert.deepEqual(gaps, [], `browser sources no digest fetches: ${gaps.join(', ')}`);
  });

  it('server placements are only in edition/category pairs a digest fetches', () => {
    assert.deepEqual(unservedServerPlacements(catalog.feeds, SERVED), []);
  });

  it('every catalog language is a digest language', () => {
    assert.deepEqual(unsupportedLanguages(catalog.feeds, NEWS_LANGUAGES), []);
  });

  it('the pending list only drops names from the frozen baseline', () => {
    const raw = readFileSync(join(root, BASELINE_PATH), 'utf8');
    assert.equal(
      createHash('sha256').update(raw).digest('hex'),
      BASELINE_SHA256,
      `${BASELINE_PATH} changed; it is frozen and must never gain names`,
    );
    const baseline = new Set<string>(JSON.parse(raw).names);
    const added = pendingNames.filter((name) => !baseline.has(name));
    assert.deepEqual(added, [], 'pending names not in the frozen baseline: place new sources on the server instead');
    assert.equal(new Set(pendingNames).size, pendingNames.length, 'pending list has duplicate names');
  });

  it('every pending name is a real, still-unmigrated browser source', () => {
    const browser = browserPlacedNames(catalog.feeds);
    const served = serverPlacedNames(catalog.feeds, SERVED);
    const unknown = pendingNames.filter((name) => !browser.has(name));
    const migrated = pendingNames.filter((name) => served.has(name));
    assert.deepEqual(unknown, [], 'pending names with no browser placement');
    assert.deepEqual(migrated, [], 'pending names already placed on the server: remove them from the list');
  });
});

describe('coverage rules (fixtures)', () => {
  const feed = (name: string, placements: CoverageFeed['placements'], extra: Partial<CoverageFeed> = {}): CoverageFeed => ({
    name,
    url: `https://${name.toLowerCase()}.example/rss`,
    placements,
    ...extra,
  });
  const served = servedLayout({ full: ['politics'] }, ['full'], 'intel');

  it('names an unknown source referenced by a default list (AE3)', () => {
    const feeds = [feed('Known', [{ edition: 'full', category: 'politics', serverOrder: 0, browserOrder: 0 }])];
    assert.deepEqual(uncoveredSources(['Known', 'Ghost Wire'], feeds, served, new Set()), ['Ghost Wire']);
  });

  it('a browser-only source fails unless pending', () => {
    const feeds = [feed('Browser Only', [{ edition: 'full', category: 'politics', browserOrder: 0 }])];
    const referenced = browserPlacedNames(feeds);
    assert.deepEqual(uncoveredSources(referenced, feeds, served, new Set()), ['Browser Only']);
    assert.deepEqual(uncoveredSources(referenced, feeds, served, new Set(['Browser Only'])), []);
  });

  it('a server placement in an unserved edition does not count as covered', () => {
    const feeds = [feed('Energy Desk', [{ edition: 'energy', category: 'energy', serverOrder: 0, browserOrder: 0 }])];
    assert.deepEqual(uncoveredSources(['Energy Desk'], feeds, served, new Set()), ['Energy Desk']);
    assert.deepEqual(unservedServerPlacements(feeds, served), ['Energy Desk → energy/energy']);
  });

  it('a server placement in a category the edition does not fetch does not count as covered', () => {
    const feeds = [
      feed('Typo Wire', [{ edition: 'full', category: 'politcs', serverOrder: 0, browserOrder: 0 }]),
      feed('Intel Desk', [{ edition: 'intel', category: 'intel', serverOrder: 0 }]),
    ];
    assert.deepEqual(uncoveredSources(['Typo Wire', 'Intel Desk'], feeds, served, new Set()), ['Typo Wire']);
    assert.deepEqual(unservedServerPlacements(feeds, served), ['Typo Wire → full/politcs']);
  });

  it('a language outside the digest languages fails, including per-language URL keys', () => {
    const feeds = [
      feed('Hebrew Daily', [{ edition: 'full', category: 'politics', serverOrder: 0 }], { lang: 'he' }),
      feed('Multi', [{ edition: 'full', category: 'politics', serverOrder: 1 }], { browser: { url: { en: 'https://m.example/en', gr: 'https://m.example/gr' } } }),
    ];
    assert.deepEqual(unsupportedLanguages(feeds, new Set(['en', 'el'])), ['gr (Multi)', 'he (Hebrew Daily)']);
  });
});
