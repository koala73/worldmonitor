/**
 * Feed-catalog drift guards (follow-up to PR #5405).
 *
 * Regression this locks: "Breaking Defense" sat in DEFAULT_ENABLED_INTEL,
 * SOURCE_TYPES and source-tiers.json for months with NO entry in either feed
 * catalog, so it was enabled-by-default and permanently unfetchable. The only
 * thing that noticed was a `console.error` inside `if (import.meta.env.DEV)`
 * in src/config/feeds.ts — a branch that never executes under CI, because the
 * test harness bundles feeds.ts with `DEV: false`. The guard existed and was
 * structurally incapable of failing a build.
 *
 * This promotes that dead DEV-only check into an executable assertion, and
 * covers the same dangling-name class for the two sibling registries that are
 * keyed independently of the catalogs (source tiers and source types).
 *
 * Loading note: src/config/feeds.ts pulls `rssProxyUrl` → `import.meta.env.DEV`,
 * and Node/tsx has no Vite env object, so we esbuild-bundle with defines — the
 * same pattern as tests/source-provenance.test.mts and tests/mission-presets.test.mts.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');
const tempDir = join(repoRoot, 'tmp-feed-catalog-drift-test');
const outfile = join(tempDir, 'feeds-bundle.mjs');
const serverOutfile = join(tempDir, 'server-feeds-bundle.mjs');

interface FeedEntry {
  name: string;
  lang?: string;
  url: string | Record<string, string>;
}

interface FeedsModule {
  DEFAULT_ENABLED_SOURCES: Record<string, string[]>;
  DEFAULT_ENABLED_INTEL: string[];
  SOURCE_TYPES: Record<string, string>;
  SOURCE_PROPAGANDA_RISK: Record<string, { risk: string; stateAffiliated?: string }>;
  FULL_FEEDS?: Record<string, FeedEntry[]>;
  FEEDS: Record<string, FeedEntry[]>;
  getAllDefaultEnabledSources: () => Set<string>;
  getLocaleBoostedSources: (locale: string) => Set<string>;
  computeDefaultDisabledSources: (locale?: string) => string[];
  listConfiguredFeedNames: () => string[];
}

interface ServerFeedsModule {
  VARIANT_FEEDS: Record<string, Record<string, FeedEntry[]>>;
}

/** Sources #5949 ships as EN-default frontline Europe coverage. */
const FRONTLINE_EUROPE = [
  'Kyiv Independent',
  'TVN24',
  'Rzeczpospolita',
  'Meduza',
  'Moscow Times',
] as const;

let feeds: FeedsModule;
let serverFeeds: ServerFeedsModule;

before(async () => {
  mkdirSync(tempDir, { recursive: true });
  // Stub the @/utils barrel so we don't drag proxy → i18n → import.meta.glob.
  // feeds.ts only needs rssProxyUrl, and identity is fine for name registries.
  const stubUtilsPlugin = {
    name: 'stub-utils-barrel',
    setup(buildApi: { onResolve: Function; onLoad: Function }) {
      buildApi.onResolve({ filter: /^@\/utils$/ }, () => ({
        path: 'stub-utils',
        namespace: 'stub',
      }));
      buildApi.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
        contents: 'export function rssProxyUrl(url) { return url; }\n',
        loader: 'js',
      }));
    },
  };
  const result = await build({
    entryPoints: [join(repoRoot, 'src/config/feeds.ts')],
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: 'es2022',
    write: false,
    absWorkingDir: repoRoot,
    alias: { '@': join(repoRoot, 'src') },
    plugins: [stubUtilsPlugin as never],
    define: {
      'import.meta.env': JSON.stringify({
        DEV: false,
        PROD: true,
        SSR: false,
        MODE: 'test',
        BASE_URL: '/',
        VITE_VARIANT: 'full',
        VITE_RSS_DIRECT_TO_RELAY: 'false',
      }),
    },
  });
  writeFileSync(outfile, result.outputFiles[0].text, 'utf8');
  feeds = await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`) as FeedsModule;

  const serverResult = await build({
    entryPoints: [join(repoRoot, 'server/worldmonitor/news/v1/_feeds.ts')],
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: 'es2022',
    write: false,
    absWorkingDir: repoRoot,
  });
  writeFileSync(serverOutfile, serverResult.outputFiles[0].text, 'utf8');
  serverFeeds = await import(`${pathToFileURL(serverOutfile).href}?t=${Date.now()}`) as ServerFeedsModule;
});

after(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('feed catalog drift', () => {
  it('every default-enabled source resolves to a configured feed', () => {
    const configured = new Set(feeds.listConfiguredFeedNames());
    const dangling = [...feeds.getAllDefaultEnabledSources()]
      .filter((name) => !configured.has(name))
      .sort();

    assert.deepEqual(
      dangling,
      [],
      `DEFAULT_ENABLED_* names with no entry in FULL_FEEDS or INTEL_SOURCES: ${dangling.join(', ')}. ` +
        'A default-enabled source without a feed definition is silently unfetchable — ' +
        'add it to the catalog or remove it from the default-enabled list.',
    );
  });

  it('DEFAULT_ENABLED_INTEL names all exist in the intel catalog', () => {
    const configured = new Set(feeds.listConfiguredFeedNames());
    const dangling = feeds.DEFAULT_ENABLED_INTEL
      .filter((name) => !configured.has(name))
      .sort();

    assert.deepEqual(dangling, [], `DEFAULT_ENABLED_INTEL dangling names: ${dangling.join(', ')}`);
  });

  // NOTE: deliberately NOT asserting the reverse direction (every source-tiers.json
  // key resolves to a configured feed). ~41 tier entries on main name feeds that no
  // longer exist, and an orphaned tier entry is inert — getSourceTier() simply never
  // looks it up. Grandfathering 41 names would add noise without protecting anything.
  // The dangerous direction is the one asserted above: enabled-by-default with no feed.

  it('keeps the two source-tiers mirrors byte-identical', () => {
    const shared = readFileSync(join(repoRoot, 'shared/source-tiers.json'), 'utf8');
    const scripts = readFileSync(join(repoRoot, 'scripts/shared/source-tiers.json'), 'utf8');
    assert.equal(scripts, shared, 'scripts/shared/source-tiers.json drifted from shared/source-tiers.json');
  });

  // Issue #5949 — EN full-variant defaults under-cover the Ukraine war.
  // Kyiv Independent, PL frontline, and independent RU were cataloged but
  // off-by-default, so users only saw Western wire/EU framing.
  it('default-enables exact Ukraine/Poland/independent-Russia frontline set for EN (#5949)', () => {
    const europe = feeds.DEFAULT_ENABLED_SOURCES.europe ?? [];
    const enabled = feeds.getAllDefaultEnabledSources();
    const disabledEn = new Set(feeds.computeDefaultDisabledSources('en'));

    for (const name of FRONTLINE_EUROPE) {
      assert.ok(europe.includes(name), `${name} must be listed in DEFAULT_ENABLED_SOURCES.europe`);
      assert.ok(enabled.has(name), `${name} must be in getAllDefaultEnabledSources()`);
      assert.ok(
        !disabledEn.has(name),
        `${name} must not appear in computeDefaultDisabledSources('en')`,
      );
    }

    // State propaganda stays cataloged but off-by-default.
    for (const stateMedia of ['TASS', 'RT', 'RT Russia'] as const) {
      assert.ok(
        !enabled.has(stateMedia),
        `${stateMedia} must remain off-by-default (state propaganda; catalog-only)`,
      );
      assert.ok(disabledEn.has(stateMedia), `${stateMedia} must be in EN disabled defaults`);
    }

    // Intel: Bellingcat stays on (already default-enabled).
    assert.ok(
      feeds.DEFAULT_ENABLED_INTEL.includes('Bellingcat'),
      'Bellingcat must remain default-enabled in intel',
    );
  });

  it('frontline Europe sources are EN-reachable (no exclusive non-en lang) (#5949)', () => {
    // buildDigest filters `!f.lang || f.lang === lang`. A default-on source
    // with only lang:'pl'/'ru' never contributes to EN digests.
    const byName = new Map<string, FeedEntry>();
    for (const feed of feeds.FEEDS.europe ?? []) byName.set(feed.name, feed);

    for (const name of FRONTLINE_EUROPE) {
      const feed = byName.get(name);
      assert.ok(feed, `${name} must exist in FEEDS.europe catalog`);
      assert.ok(
        !feed.lang || feed.lang === 'en',
        `${name} must not be gated to a non-en lang (got lang=${feed.lang ?? 'none'}); ` +
          'use multi-URL without lang, or an English-only URL, so EN digests include it',
      );
      // Multi-URL sources must expose an `en` key for EN fetch resolution.
      if (typeof feed.url === 'object' && feed.url !== null) {
        assert.ok(
          typeof feed.url.en === 'string' && feed.url.en.length > 0,
          `${name} multi-URL entry must include a non-empty en URL`,
        );
      }
    }

    const expectedEnUrls: Record<string, string> = {
      TVN24: 'https://tvn24.pl/swiat.xml',
      Rzeczpospolita: 'https://www.rp.pl/rss_main',
    };
    for (const [name, url] of Object.entries(expectedEnUrls)) {
      const feed = byName.get(name);
      assert.equal(
        typeof feed?.url === 'object' ? feed.url.en : undefined,
        url,
        `${name} EN must use the verified native RSS fallback`,
      );
    }
  });

  it('server VARIANT_FEEDS.full.europe catalogs the same frontline names (#5949)', () => {
    // Digest path is the product path for full/EN europe. Import the server
    // catalog so this assertion exercises the executable data structure rather
    // than passing because a source name appears in a comment or string.
    const europe = serverFeeds.VARIANT_FEEDS.full?.europe ?? [];
    const byName = new Map(europe.map((feed) => [feed.name, feed]));
    const expectedUrls: Record<string, string> = {
      'Kyiv Independent': 'https://news.google.com/rss/search?q=site%3Akyivindependent.com%20when%3A3d&hl=en-US&gl=US&ceid=US:en',
      TVN24: 'https://tvn24.pl/swiat.xml',
      Rzeczpospolita: 'https://www.rp.pl/rss_main',
      Meduza: 'https://meduza.io/rss/en/all',
      'Moscow Times': 'https://www.themoscowtimes.com/rss/news',
    };
    for (const name of FRONTLINE_EUROPE) {
      const feed = byName.get(name);
      assert.ok(feed, `server VARIANT_FEEDS.full.europe must include "${name}" for EN digests`);
      assert.equal(feed?.url, expectedUrls[name], `server EN URL drifted for "${name}"`);
      assert.ok(!feed?.lang, `server entry for "${name}" must not set a non-en lang`);
    }
  });

  it('does not default-enable Hungary/Greece locale packs for EN (#5949)', () => {
    const enabled = feeds.getAllDefaultEnabledSources();
    // These stay locale-boosted (lang: hu / el), not EN default-on.
    for (const localeOnly of ['Telex', 'Index.hu', 'Kathimerini', 'Naftemporiki'] as const) {
      assert.ok(
        !enabled.has(localeOnly),
        `${localeOnly} must stay locale-boosted, not EN default-on`,
      );
    }
    // Sanity: hu/el locale boost still works so the packs are not dead.
    assert.ok(feeds.getLocaleBoostedSources('hu').has('Telex'));
    assert.ok(feeds.getLocaleBoostedSources('el').has('Kathimerini'));
  });

  it('SOURCE_PROPAGANDA_RISK still high-labels Russian state media (#5949)', () => {
    for (const name of ['TASS', 'RT', 'RT Russia'] as const) {
      const profile = feeds.SOURCE_PROPAGANDA_RISK[name];
      assert.ok(profile, `${name} must remain in SOURCE_PROPAGANDA_RISK`);
      assert.equal(profile.risk, 'high', `${name} must remain high-risk`);
      assert.equal(profile.stateAffiliated, 'Russia');
    }
  });
});
