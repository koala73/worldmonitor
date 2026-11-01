// Science panel (2026-10-17 audit of /verify against Google News World:
// science stories it carried reached no WorldMonitor feed). The panel is
// opt-in on the full dashboard; its sources are EN default-on, so the panel
// has content when enabled and /verify searches them either way.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VARIANT_FEEDS } from '../server/worldmonitor/news/v1/_feeds';
import { publisherFamilyFor } from '../shared/publisher-families.js';
import { selectSourcesUnderCap } from '../src/services/source-cap';
import { bundleFeedsModule } from './_lib/bundle-feeds-module.mts';

interface FeedEntry { name: string; url: string | Record<string, string>; lang?: string }
interface FeedsModule {
  FULL_FEEDS: Record<string, FeedEntry[]>;
  FEEDS: Record<string, FeedEntry[]>;
  INTEL_SOURCES: FeedEntry[];
  FREE_CAP_PROTECTED_SOURCES: readonly string[];
  SCIENCE_DEFAULT_SOURCES: readonly string[];
  SOURCE_REGION_MAP: Record<string, { feedKeys: string[] }>;
  REGIONAL_FEED_ROLLOUT_STAGES: ReadonlyArray<{ introducedNames: readonly string[] }>;
  computeDefaultDisabledSources: (locale?: string) => string[];
}

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const tempDir = join(repoRoot, 'tmp-science-panel-feeds-test');
const gn = (q: string) => `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`;
const EXPECTED = [
  { name: 'Reuters Science', url: gn('site:reuters.com science when:2d') },
  { name: 'Nature News', url: 'https://www.nature.com/nature.rss' },
  { name: 'BBC Science', url: 'https://feeds.bbci.co.uk/news/science_and_environment/rss.xml' },
  { name: 'Guardian Science', url: 'https://www.theguardian.com/science/rss' },
  { name: 'ScienceDaily', url: 'https://www.sciencedaily.com/rss/all.xml' },
];
const NAMES = EXPECTED.map((feed) => feed.name);
const read = (path: string) => readFileSync(join(repoRoot, path), 'utf8');

let feeds: FeedsModule;
before(async () => { feeds = await bundleFeedsModule<FeedsModule>({ repoRoot, tempDir }); });
after(() => rmSync(tempDir, { recursive: true, force: true }));

describe('science panel feeds', () => {
  it('carries the same five feeds in the server and client full catalogs', () => {
    assert.deepEqual(VARIANT_FEEDS.full!.science, EXPECTED);
    assert.deepEqual(feeds.FULL_FEEDS.science!.map(({ name, url }) => ({ name, url })), EXPECTED);
  });

  it('is the last category of both catalogs, so the free cap reaches it last', () => {
    assert.equal(Object.keys(VARIANT_FEEDS.full!).at(-1), 'science');
    assert.equal(Object.keys(feeds.FULL_FEEDS).at(-1), 'science');
  });

  it('enables its sources by default in English, in their own last rollout stage', () => {
    assert.deepEqual([...feeds.SCIENCE_DEFAULT_SOURCES], NAMES);
    const disabled = new Set(feeds.computeDefaultDisabledSources('en'));
    for (const name of NAMES) assert.equal(disabled.has(name), false, `${name} is enabled by default`);
    assert.deepEqual([...feeds.REGIONAL_FEED_ROLLOUT_STAGES.at(-1)!.introducedNames], NAMES);
  });

  it('costs a default free profile exactly Layoffs News and Foreign Affairs', () => {
    const disabled = new Set(feeds.computeDefaultDisabledSources('en'));
    const protectedNames = new Set(feeds.FREE_CAP_PROTECTED_SOURCES);
    const before = selectSourcesUnderCap(feeds.FEEDS, feeds.INTEL_SOURCES, new Set([...disabled, ...NAMES]), 80, protectedNames).keep;
    const now = selectSourcesUnderCap(feeds.FEEDS, feeds.INTEL_SOURCES, disabled, 80, protectedNames).keep;
    assert.deepEqual([...before].filter((name) => !now.has(name)).sort(), ['Foreign Affairs', 'Layoffs News']);
    assert.deepEqual([...now].filter((name) => NAMES.includes(name)).sort(), ['Nature News', 'Reuters Science']);
    for (const name of feeds.FREE_CAP_PROTECTED_SOURCES) {
      if (before.has(name)) assert.ok(now.has(name), `protected ${name} stays`);
    }
  });

  it('lists the science sources under the topical source group', () => {
    assert.ok(feeds.SOURCE_REGION_MAP.topical!.feedKeys.includes('science'));
  });

  it('folds the wire and broadcaster desks into their publisher families', () => {
    assert.equal(publisherFamilyFor('Reuters Science'), publisherFamilyFor('Reuters World'));
    assert.equal(publisherFamilyFor('BBC Science'), publisherFamilyFor('BBC World'));
    assert.equal(publisherFamilyFor('Guardian Science'), publisherFamilyFor('Guardian World'));
  });

  it('registers an opt-in panel with a label in every locale', () => {
    assert.match(read('src/config/panels.ts'), /\n  science: \{ name: 'Science', enabled: false, priority: 2 \},\n/);
    assert.match(read('src/app/panel-layout.ts'), /this\.createNewsPanel\('science', 'panels\.science'\);/);
    assert.match(read('src/config/commands.ts'), /id: 'panel:science'/);
    for (const locale of ['ar', 'bg', 'cs', 'de', 'el', 'en', 'es', 'fa', 'fr', 'hi', 'hr', 'hu', 'it', 'ja', 'ko', 'nl',
      'pl', 'pt', 'ro', 'ru', 'sv', 'sw', 'th', 'tr', 'uk', 'vi', 'zh', 'zh-TW']) {
      const label = JSON.parse(read(`src/locales/${locale}.json`)).panels?.science;
      assert.ok(typeof label === 'string' && label.length > 0, `${locale} has panels.science`);
    }
  });
});
