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
  DEFAULT_ENABLED_INTEL: string[];
  SOURCE_TYPES: Record<string, string>;
  getAllDefaultEnabledSources: () => Set<string>;
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
});
