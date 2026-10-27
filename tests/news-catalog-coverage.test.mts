/**
 * Source-coverage gate for the unified news catalog (plan U2, R3).
 *
 * Every source the browser can show must be fetched by a digest the server
 * builds, so the dashboard, MCP and every other digest reader see the same
 * news. Today's gap is held in shared/news-catalog-pending-migration.json,
 * which may only shrink.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { INTEL_EDITION } from '../shared/news-catalog-browser';
import { VALID_VARIANTS } from '../server/worldmonitor/news/v1/list-feed-digest';
import { NEWS_LANGUAGES } from '../src/shared/public-rpc-cache';
import {
  browserPlacedNames,
  serverPlacedNames,
  uncoveredSources,
  unservedServerPlacements,
  unsupportedLanguages,
  type CoverageFeed,
} from './_lib/news-catalog-coverage.mts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (path: string) => JSON.parse(readFileSync(join(root, path), 'utf8'));

const catalog = readJson('shared/news-catalog.json') as { feeds: CoverageFeed[] };
const pendingNames: string[] = readJson('shared/news-catalog-pending-migration.json').names;
const pending = new Set(pendingNames);

// The full digest also fetches the intel list (list-feed-digest, INTEL_SOURCES).
const SERVED_EDITIONS: ReadonlySet<string> = new Set([...VALID_VARIANTS, INTEL_EDITION]);

// Lower this in the same change that removes migrated names. Raising it means
// a new browser-only source, which the catalog no longer allows.
const PENDING_CEILING = 221;

describe('news catalog source coverage', () => {
  it('every browser source is fetched by a served digest, or pending migration', () => {
    const gaps = uncoveredSources(browserPlacedNames(catalog.feeds), catalog.feeds, SERVED_EDITIONS, pending);
    assert.deepEqual(gaps, [], `browser sources no digest fetches: ${gaps.join(', ')}`);
  });

  it('server placements are only in editions a digest serves', () => {
    assert.deepEqual(unservedServerPlacements(catalog.feeds, SERVED_EDITIONS), []);
  });

  it('every catalog language is a digest language', () => {
    assert.deepEqual(unsupportedLanguages(catalog.feeds, NEWS_LANGUAGES), []);
  });

  it('the pending list only shrinks', () => {
    assert.equal(new Set(pendingNames).size, pendingNames.length, 'pending list has duplicates');
    assert.ok(
      pendingNames.length <= PENDING_CEILING,
      `pending list grew to ${pendingNames.length} (ceiling ${PENDING_CEILING}); place new sources on the server instead`,
    );
    assert.equal(
      pendingNames.length,
      PENDING_CEILING,
      `pending list shrank to ${pendingNames.length}; lower PENDING_CEILING to match`,
    );
  });

  it('every pending name is a real, still-unmigrated browser source', () => {
    const browser = browserPlacedNames(catalog.feeds);
    const served = serverPlacedNames(catalog.feeds, SERVED_EDITIONS);
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
  const served = new Set(['full', 'intel']);

  it('names an unknown source referenced by a default list (AE3)', () => {
    const feeds = [feed('Known', [{ edition: 'full', serverOrder: 0, browserOrder: 0 }])];
    assert.deepEqual(uncoveredSources(['Known', 'Ghost Wire'], feeds, served, new Set()), ['Ghost Wire']);
  });

  it('a browser-only source fails unless pending', () => {
    const feeds = [feed('Browser Only', [{ edition: 'full', browserOrder: 0 }])];
    const referenced = browserPlacedNames(feeds);
    assert.deepEqual(uncoveredSources(referenced, feeds, served, new Set()), ['Browser Only']);
    assert.deepEqual(uncoveredSources(referenced, feeds, served, new Set(['Browser Only'])), []);
  });

  it('a server placement in an unserved edition does not count as covered', () => {
    const feeds = [feed('Energy Desk', [{ edition: 'energy', serverOrder: 0, browserOrder: 0 }])];
    assert.deepEqual(uncoveredSources(['Energy Desk'], feeds, served, new Set()), ['Energy Desk']);
    assert.deepEqual(unservedServerPlacements(feeds, served), ['Energy Desk → energy']);
  });

  it('a language outside the digest languages fails, including per-language URL keys', () => {
    const feeds = [
      feed('Hebrew Daily', [{ edition: 'full', serverOrder: 0 }], { lang: 'he' }),
      feed('Multi', [{ edition: 'full', serverOrder: 1 }], { browser: { url: { en: 'https://m.example/en', gr: 'https://m.example/gr' } } }),
    ];
    assert.deepEqual(unsupportedLanguages(feeds, new Set(['en', 'el'])), ['gr (Multi)', 'he (Hebrew Daily)']);
  });
});
