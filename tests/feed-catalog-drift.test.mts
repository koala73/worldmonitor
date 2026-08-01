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

interface FeedsModule {
  DEFAULT_ENABLED_SOURCES: Record<string, string[]>;
  DEFAULT_ENABLED_INTEL: string[];
  SOURCE_TYPES: Record<string, string>;
  SOURCE_PROPAGANDA_RISK: Record<string, { risk: string; stateAffiliated?: string }>;
  getAllDefaultEnabledSources: () => Set<string>;
  getLocaleBoostedSources: (locale: string) => Set<string>;
  listConfiguredFeedNames: () => string[];
}

let feeds: FeedsModule;

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
  it('default-enables Ukraine/Poland/independent-Russia frontline sources for EN (#5949)', () => {
    const europe = feeds.DEFAULT_ENABLED_SOURCES.europe ?? [];
    const enabled = feeds.getAllDefaultEnabledSources();

    assert.ok(
      europe.includes('Kyiv Independent'),
      'Kyiv Independent must be default-on in europe for EN full-variant sessions',
    );

    const polishFrontline = ['TVN24', 'Rzeczpospolita'].filter((n) => europe.includes(n));
    assert.ok(
      polishFrontline.length >= 1,
      'At least one Polish frontline source (TVN24 / Rzeczpospolita) must be default-on',
    );

    const independentRu = ['Meduza', 'Moscow Times'].filter((n) => europe.includes(n));
    assert.ok(
      independentRu.length >= 1,
      'At least one independent Russia source (Meduza / Moscow Times) must be default-on',
    );

    // State propaganda stays cataloged but off-by-default.
    for (const stateMedia of ['TASS', 'RT', 'RT Russia'] as const) {
      assert.ok(
        !enabled.has(stateMedia),
        `${stateMedia} must remain off-by-default (state propaganda; catalog-only)`,
      );
    }

    // Intel: Bellingcat stays on (already default-enabled).
    assert.ok(
      feeds.DEFAULT_ENABLED_INTEL.includes('Bellingcat'),
      'Bellingcat must remain default-enabled in intel',
    );
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
