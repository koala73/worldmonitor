// The browser and server catalogs that ship are thin views over
// shared/news-catalog.json. These checks read the shipped exports themselves
// (not the builders) and compare them in order, so an edit to either wrapper
// or a stale generated browser slice fails here.
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';

import {
  buildBrowserCategoryFeeds,
  buildBrowserIntelSources,
  buildServerIntelSources,
  buildServerVariantFeeds,
} from '../shared/news-catalog.ts';
import { INTEL_SOURCES as SERVER_INTEL, VARIANT_FEEDS } from '../server/worldmonitor/news/v1/_feeds.ts';
import { bundleFeedsModule } from './_lib/bundle-feeds-module.mts';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const tempDir = join(repoRoot, 'tmp-news-catalog-shipped-views-test');

interface FeedsModule {
  FULL_FEEDS: Record<string, unknown[]>;
  INTEL_SOURCES: unknown[];
}

let feeds: FeedsModule;

before(async () => {
  feeds = await bundleFeedsModule<FeedsModule>({ repoRoot, tempDir });
});

after(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

// JSON round-trip drops undefined-valued keys so optional fields compare by presence.
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));

describe('shipped news catalog views match the catalog in order', () => {
  it('server VARIANT_FEEDS equals the catalog server view', () => {
    assert.deepEqual(plain(VARIANT_FEEDS), plain(buildServerVariantFeeds()));
  });

  it('server INTEL_SOURCES equals the catalog server intel view', () => {
    assert.deepEqual(plain(SERVER_INTEL), plain(buildServerIntelSources()));
  });

  it('browser FULL_FEEDS equals the catalog browser view, category by category', () => {
    const expected = plain(buildBrowserCategoryFeeds('full'));
    const shipped = plain(feeds.FULL_FEEDS);
    assert.deepEqual(Object.keys(shipped), Object.keys(expected), 'category order');
    for (const category of Object.keys(expected)) {
      assert.deepEqual(shipped[category], expected[category], `full/${category}`);
    }
  });

  it('browser INTEL_SOURCES equals the catalog browser intel view', () => {
    assert.deepEqual(plain(feeds.INTEL_SOURCES), plain(buildBrowserIntelSources()));
  });
});
