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
 * shared harness lives in tests/_lib/bundle-feeds-module.mts.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, rmSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { bundleFeedsModule } from './_lib/bundle-feeds-module.mts';
import { isAllowedDomain } from '../api/_rss-allowed-domain-match.js';
import { computeCapDisabledSources, selectSourcesUnderCap } from '../src/services/source-cap';
import {
  applyMigrationChain,
  buildMigrations,
  migrateRegionalFeedRolloutDefaultsV5,
  migrateStrategicDefaultsV4,
} from '../src/utils/cloud-prefs-migrations';
import { THEATER_PRESETS } from '../src/config/theater-presets';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');
const tempDir = join(repoRoot, 'tmp-feed-catalog-drift-test');
const serverOutfile = join(tempDir, 'server-feeds-bundle.mjs');

interface FeedEntry {
  name: string;
  lang?: string;
  strategicDefault?: boolean;
  url: string | Record<string, string>;
}

interface FeedsModule {
  DEFAULT_ENABLED_SOURCES: Record<string, string[]>;
  DEFAULT_ENABLED_INTEL: string[];
  FREE_CAP_PROTECTED_SOURCES: readonly string[];
  FRONTLINE_EUROPE_PROTECTED_SOURCES: readonly string[];
  REGIONAL_FEED_ROLLOUT_DEFAULT_SOURCES: readonly string[];
  REGIONAL_FEED_ROLLOUT_OPT_IN_SOURCES: readonly string[];
  INTEL_SOURCES: FeedEntry[];
  SOURCE_TYPES: Record<string, string>;
  SOURCE_PROPAGANDA_RISK: Record<string, { risk: string; stateAffiliated?: string }>;
  FULL_FEEDS?: Record<string, FeedEntry[]>;
  FEEDS: Record<string, FeedEntry[]>;
  getAllDefaultEnabledSources: () => Set<string>;
  getStrategicDefaultSources: () => Set<string>;
  getLocaleBoostedSources: (locale: string) => Set<string>;
  getSourcePanelId: (sourceName: string) => string;
  computeDefaultDisabledSources: (locale?: string) => string[];
  computePreStrategicDefaultDisabledSources: (locale?: string) => string[];
  computeLegacyDefaultDisabledSources: () => string[];
  computePreRegionalFeedRolloutDefaultDisabledSources: (locale?: string) => string[];
  listConfiguredFeedNames: () => string[];
}

interface ServerFeedsModule {
  VARIANT_FEEDS: Record<string, Record<string, FeedEntry[]>>;
  isServerFeedReachableForLanguage: (
    feed: Pick<FeedEntry, 'lang' | 'strategicDefault'>,
    language: string,
  ) => boolean;
}

interface RegionalRolloutModule {
  buildPreStrategicDefaultDisabledStates: (
    cap: number,
    locale?: string,
  ) => Array<ReadonlySet<string>>;
  buildRegionalFeedRolloutMigrationTargets: (
    cap: number,
    locale?: string,
  ) => Array<{
    legacyDisabled: ReadonlySet<string>;
    defaultNames: ReadonlySet<string>;
    optInNames: ReadonlySet<string>;
  }>;
}

/** Sources #5949/#5950 ship as EN-default frontline Europe coverage (cap-protected). */
const FRONTLINE_EUROPE = [
  'Kyiv Independent',
  'TVN24',
  'Rzeczpospolita',
  'Meduza',
  'Moscow Times',
  'NV EN',
  'Ukrainska Pravda EN',
] as const;

const EASTERN_FLANK_EN_DEFAULTS = ['Daily Sabah', 'ERR News'] as const;
const EASTERN_FLANK_FEEDS = {
  Digi24: { url: 'https://www.digi24.ro/rss', lang: 'ro' },
  HotNews: { url: 'https://www.hotnews.ro/rss', lang: 'ro' },
  G4Media: { url: 'https://www.g4media.ro/feed/', lang: 'ro' },
  Dnevnik: { url: 'https://www.dnevnik.bg/rss/', lang: 'bg' },
  'Seznam Zprávy': { url: 'https://www.seznamzpravy.cz/rss', lang: 'cs' },
  'ERR News': { url: 'https://news.err.ee/rss' },
  'LRT English': { url: 'https://www.lrt.lt/en/news-in-english?rss' },
  'LSM English': { url: 'https://eng.lsm.lv/rss/' },
  'Daily Sabah': { url: 'https://www.dailysabah.com/rss/home-page' },
} as const;

const STRATEGIC_DEFAULTS = [
  'Hurriyet',
  'Polsat News',
  'Kathimerini',
  'Jeune Afrique',
  'Asahi Shimbun',
  'MIIT (China)',
  'MOFCOM (China)',
  'Bangkok Post',
  'VnExpress',
  'Yonhap News',
] as const;
const AFRICA_DEPTH_EN_DEFAULTS = ['Hiiraan Online', 'RFI Afrique'] as const;
const AFRICA_DEPTH_FEEDS = {
  'Radio Tamazuj': { url: 'https://www.radiotamazuj.org/en/feed' },
  'The Reporter Ethiopia': { url: 'https://www.thereporterethiopia.com/feed/' },
  'Ethiopia Insight': { url: 'https://www.ethiopia-insight.com/feed/' },
  'Dabanga Sudan': { url: 'https://www.dabangasudan.org/en/feed' },
  'Hiiraan Online': { url: 'https://news.google.com/rss/search?q=site%3Ahiiraan.com%20when%3A7d&hl=en-US&gl=US&ceid=US:en' },
  'Actualite.cd': { url: 'https://actualite.cd/feed', lang: 'fr' },
  'Radio Okapi': { url: 'https://www.radiookapi.net/rss.xml', lang: 'fr' },
  'MyJoyOnline': { url: 'https://www.myjoyonline.com/feed/' },
  'Citi Newsroom': { url: 'https://news.google.com/rss/search?q=site%3Acitinewsroom.com%20when%3A7d&hl=en-US&gl=US&ceid=US:en' },
  'Le Quotidien': { url: 'https://lequotidien.sn/feed/', lang: 'fr' },
  'RFI Afrique': { url: 'https://www.rfi.fr/en/africa/rss' },
} as const;

const REGIONAL_ROLLOUT_DEFAULTS = [
  'Daily Sabah',
  'ERR News',
  'Civil.ge',
  'OC Media',
  'Eurasianet',
  'The Astana Times',
  'Focus Taiwan',
  'Dawn',
  'Rappler',
  'Hiiraan Online',
  'RFI Afrique',
] as const;

const REGIONAL_ROLLOUT_OPT_INS = [
  'Seznam Zprávy',
  'Digi24',
  'HotNews',
  'G4Media',
  'Dnevnik',
  'LRT English',
  'LSM English',
  'JAMnews',
  'Azertag',
  'Armenpress',
  'Zerkalo',
  'NewsMaker',
  'Ziarul de Gardă',
  'Radio Tamazuj',
  'The Reporter Ethiopia',
  'Actualite.cd',
  'Radio Okapi',
  'MyJoyOnline',
  'Le Quotidien',
  'RFE/RL Central Asia',
  'The Times of Central Asia',
  'Taipei Times',
  'Taiwan News',
  'Geo News',
  'Jakarta Post',
  'The Star (Malaysia)',
  'Irrawaddy',
  'Ethiopia Insight',
  'Dabanga Sudan',
  'Citi Newsroom',
] as const;

const INITIAL_FRONTLINE_DEFAULTS = [
  'Kyiv Independent',
  'TVN24',
  'Rzeczpospolita',
  'Meduza',
  'Moscow Times',
] as const;

const UKRAINE_DEPTH_DEFAULTS = ['Ukrainska Pravda EN', 'NV EN', 'ISW'] as const;
const UKRAINE_DEPTH_OPT_INS = ['Ukrinform', 'Suspilne', 'Hromadske EN'] as const;
const UKRAINE_DEPTH_NAMES = [...UKRAINE_DEPTH_DEFAULTS, ...UKRAINE_DEPTH_OPT_INS] as const;
const RECONCILED_ROLLOUT_DEFAULTS = [
  ...FRONTLINE_EUROPE,
  'ISW',
  ...REGIONAL_ROLLOUT_DEFAULTS,
  ...STRATEGIC_DEFAULTS,
] as const;
const RECONCILED_ROLLOUT_OPT_INS = [
  ...UKRAINE_DEPTH_OPT_INS,
  ...REGIONAL_ROLLOUT_OPT_INS,
] as const;

const REPAIRED_REGIONAL_FEEDS = {
  'Civil.ge': { url: 'https://civil.ge/feed/' },
  'OC Media': { url: 'https://oc-media.org/feed/' },
  JAMnews: { url: 'https://jam-news.net/feed/' },
  NewsMaker: { url: 'https://newsmaker.md/feed', lang: 'ru' },
  'Ziarul de Gardă': { url: 'https://www.zdg.md/feed/', lang: 'ro' },
  Eurasianet: { url: 'https://eurasianet.org/rss' },
  'The Astana Times': { url: 'https://astanatimes.com/feed/' },
  'The Times of Central Asia': { url: 'https://timesca.com/feed/' },
  'Focus Taiwan': { url: 'https://news.google.com/rss/search?q=site%3Afocustaiwan.tw%20when%3A3d&hl=en-US&gl=US&ceid=US:en' },
  'Taipei Times': { url: 'https://news.google.com/rss/search?q=site%3Ataipeitimes.com%20when%3A3d&hl=en-US&gl=US&ceid=US:en' },
  'Taiwan News': { url: 'https://news.google.com/rss/search?q=site%3Ataiwannews.com.tw%20when%3A3d&hl=en-US&gl=US&ceid=US:en' },
  'Jakarta Post': { url: 'https://news.google.com/rss/search?q=site%3Athejakartapost.com%20when%3A3d&hl=en-US&gl=US&ceid=US:en' },
  'The Star (Malaysia)': { url: 'https://news.google.com/rss/search?q=site%3Athestar.com.my%20when%3A3d&hl=en-US&gl=US&ceid=US:en' },
} as const;

const UNUSED_REGIONAL_PUBLISHER_HOSTS = [
  'focustaiwan.tw',
  'www.taipeitimes.com',
  'www.taiwannews.com.tw',
  'www.geo.tv',
  'www.thejakartapost.com',
  'www.thestar.com.my',
] as const;

let feeds: FeedsModule;
let serverFeeds: ServerFeedsModule;
let regionalRollout: RegionalRolloutModule;

before(async () => {
  feeds = await bundleFeedsModule<FeedsModule>({ repoRoot, tempDir });

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

  regionalRollout = await bundleFeedsModule<RegionalRolloutModule>({
    repoRoot,
    tempDir,
    outfileName: 'regional-rollout-bundle.mjs',
    entryPoint: join(repoRoot, 'src/services/regional-feed-rollout.ts'),
  });
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

  it('strategic defaults are canonical, EN-enabled, cap-protected, and server-mirrored', () => {
    const expected = new Set(STRATEGIC_DEFAULTS);
    assert.deepEqual(
      [...feeds.getStrategicDefaultSources()].sort(),
      [...expected].sort(),
      'strategic default declarations must match the closed-world source list',
    );

    const clientByName = new Map(
      Object.values(feeds.FEEDS ?? {}).flat().map((feed) => [feed.name, feed]),
    );
    const serverByName = new Map(
      Object.values(serverFeeds.VARIANT_FEEDS.full ?? {}).flat().map((feed) => [feed.name, feed]),
    );
    const enabled = feeds.getAllDefaultEnabledSources();
    const disabledEn = new Set(feeds.computeDefaultDisabledSources('en'));

    for (const name of STRATEGIC_DEFAULTS) {
      const client = clientByName.get(name);
      const server = serverByName.get(name);
      assert.ok(client?.strategicDefault, `${name} must be strategic on the client`);
      assert.ok(server?.strategicDefault, `${name} must be strategic on the server`);
      assert.ok(enabled.has(name), `${name} must be in the canonical default-enabled set`);
      assert.ok(!disabledEn.has(name), `${name} must not be disabled for EN first boot`);
      assert.equal(server?.lang, client?.lang, `${name} server/client language tags must match`);
    }
  });

  it('reconstructs the exact pre-strategic default fingerprint', () => {
    const legacyDisabled = new Set(feeds.computePreStrategicDefaultDisabledSources('en'));

    assert.equal(
      legacyDisabled.has('Jeune Afrique'),
      false,
      'a source that was already an explicit default before #6000 must remain enabled',
    );
    for (const name of STRATEGIC_DEFAULTS) {
      if (name === 'Jeune Afrique') continue;
      assert.ok(
        legacyDisabled.has(name),
        `${name} must be disabled in the untouched EN fingerprint from before #6000`,
      );
    }
  });

  it('migrates exact non-English pre-strategic default and cap states', () => {
    const plStates = regionalRollout.buildPreStrategicDefaultDisabledStates(80, 'pl');
    assert.ok(plStates.length > 0);
    for (const state of plStates) {
      assert.equal(state.has('Polsat News'), false, 'Polsat was already enabled by the PL locale');
    }

    const blob = {
      'worldmonitor-disabled-feeds': JSON.stringify([...plStates[0]!]),
    };
    const migrated = migrateStrategicDefaultsV4(
      blob,
      new Set(),
      feeds.getStrategicDefaultSources(),
      new Set(),
      plStates,
    );
    const disabled = new Set(
      JSON.parse(migrated['worldmonitor-disabled-feeds'] as string) as string[],
    );
    for (const name of STRATEGIC_DEFAULTS) {
      assert.equal(disabled.has(name), false, `${name} must be enabled for the migrated PL profile`);
    }

    const ruStates = regionalRollout.buildPreStrategicDefaultDisabledStates(80, 'ru');
    assert.ok(
      ruStates.every((state) => state.has('NewsMaker')),
      'NewsMaker must not be backdated into the pre-repair RU locale fingerprint',
    );
  });

  it('keeps strategic reachability separate from English locale boosting', () => {
    assert.deepEqual([...feeds.getLocaleBoostedSources('en')], []);
    assert.equal(
      serverFeeds.isServerFeedReachableForLanguage(
        { lang: 'ja', strategicDefault: true },
        'en',
      ),
      true,
    );
    assert.equal(
      serverFeeds.isServerFeedReachableForLanguage({ lang: 'ja' }, 'en'),
      false,
    );
  });

  it('keeps strategic defaults under the free-tier source cap', () => {
    const disabledEn = new Set(feeds.computeDefaultDisabledSources('en'));
    const protectedNames = new Set([
      ...feeds.FREE_CAP_PROTECTED_SOURCES,
      ...feeds.getStrategicDefaultSources(),
    ]);
    const { keep, autoDisabled } = selectSourcesUnderCap(
      feeds.FEEDS,
      feeds.INTEL_SOURCES,
      disabledEn,
      80,
      protectedNames,
    );

    for (const name of STRATEGIC_DEFAULTS) {
      assert.ok(keep.has(name), `${name} must survive the free-tier source cap`);
      assert.ok(!autoDisabled.has(name), `${name} must not be auto-disabled by the cap`);
    }
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
      'Ukrainska Pravda EN': 'https://news.google.com/rss/search?q=site%3Aeuromaidanpress.com%20when%3A2d&hl=en-US&gl=US&ceid=US:en',
      'NV EN': 'https://news.google.com/rss/search?q=site%3Aenglish.nv.ua%20when%3A2d&hl=en-US&gl=US&ceid=US:en',
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

  it('server full digest catalogs every theater preset source in its client panel (#5956)', () => {
    const missing: string[] = [];
    for (const preset of THEATER_PRESETS) {
      for (const sourceName of preset.sourceNames) {
        const category = feeds.getSourcePanelId(sourceName);
        const serverCategory = serverFeeds.VARIANT_FEEDS.full?.[category] ?? [];
        if (!serverCategory.some((feed) => feed.name === sourceName)) {
          missing.push(`${preset.id}/${category}: ${sourceName}`);
        }
      }
    }

    assert.deepEqual(
      missing,
      [],
      'every theater preset source must be served by the matching full-variant digest category: ' +
        missing.join(', '),
    );
  });

  it('does not default-enable Hungary/Greece locale packs for EN (#5949)', () => {
    const enabled = feeds.getAllDefaultEnabledSources();
    // These stay locale-boosted (lang: hu / el), not EN default-on.
    // Kathimerini is now a strategic default (#6000), so it is intentionally
    // excluded from this locale-only control set.
    for (const localeOnly of ['Telex', 'Index.hu', 'Naftemporiki'] as const) {
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

  // Issue #5950 — catalog must not drift back to Russia-heavy EN defaults.
  // Balance rule (documented in feeds.ts Russia & Ukraine block + DEFAULT_ENABLED europe):
  //   ≥1 dedicated UA primary + ≥1 independent RU; TASS/RT never default-on;
  //   propaganda tags required for TASS/RT/Kyiv Independent (and default-on independent RU).
  const UA_PRIMARY_DEFAULTS = ['Kyiv Independent'] as const;
  const INDEPENDENT_RU_DEFAULTS = ['Meduza', 'Moscow Times'] as const;
  const RU_STATE_PROPAGANDA = ['TASS', 'RT', 'RT Russia'] as const;

  it('EN defaults satisfy UA/RU balance rule (≥1 UA primary + ≥1 independent RU) (#5950)', () => {
    const enabled = feeds.getAllDefaultEnabledSources();
    const disabledEn = new Set(feeds.computeDefaultDisabledSources('en'));

    const uaOn = UA_PRIMARY_DEFAULTS.filter((n) => enabled.has(n) && !disabledEn.has(n));
    assert.ok(
      uaOn.length >= 1,
      `EN defaults need ≥1 dedicated UA primary among [${UA_PRIMARY_DEFAULTS.join(', ')}]; got none`,
    );

    const ruIndOn = INDEPENDENT_RU_DEFAULTS.filter((n) => enabled.has(n) && !disabledEn.has(n));
    assert.ok(
      ruIndOn.length >= 1,
      `EN defaults need ≥1 independent RU among [${INDEPENDENT_RU_DEFAULTS.join(', ')}]; got none`,
    );

    for (const stateMedia of RU_STATE_PROPAGANDA) {
      assert.ok(!enabled.has(stateMedia), `${stateMedia} must never be EN default-on (#5950)`);
    }
  });

  it('FRONTLINE_EUROPE_PROTECTED_SOURCES matches the default-on frontline set (#5950)', () => {
    // Free-tier cap protection and DEFAULT_ENABLED must not drift apart.
    assert.deepEqual(
      [...feeds.FRONTLINE_EUROPE_PROTECTED_SOURCES].sort(),
      [...FRONTLINE_EUROPE].sort(),
    );
    const europe = feeds.DEFAULT_ENABLED_SOURCES.europe ?? [];
    for (const name of feeds.FRONTLINE_EUROPE_PROTECTED_SOURCES) {
      assert.ok(europe.includes(name), `${name} must be DEFAULT_ENABLED europe (cap-protected set)`);
    }
  });

  it('locks Eastern-flank URL/lang parity and EN/locale selection (#5952)', () => {
    const clientByName = new Map((feeds.FEEDS.europe ?? []).map((feed) => [feed.name, feed]));
    const serverByName = new Map(
      (serverFeeds.VARIANT_FEEDS.full?.europe ?? []).map((feed) => [feed.name, feed]),
    );
    const enabled = feeds.getAllDefaultEnabledSources();

    for (const [name, expected] of Object.entries(EASTERN_FLANK_FEEDS)) {
      const client = clientByName.get(name);
      const server = serverByName.get(name);
      assert.ok(client, `${name} must exist in the client Europe catalog`);
      assert.ok(server, `${name} must exist in the server full/Europe catalog`);
      assert.equal(client.url, expected.url, `${name} client URL drifted`);
      assert.equal(server.url, expected.url, `${name} server URL drifted`);
      assert.equal(client.lang, 'lang' in expected ? expected.lang : undefined, `${name} client lang drifted`);
      assert.equal(server.lang, 'lang' in expected ? expected.lang : undefined, `${name} server lang drifted`);
    }

    for (const name of EASTERN_FLANK_EN_DEFAULTS) {
      assert.ok(enabled.has(name), `${name} must remain default-on for EN`);
    }
    for (const localeOnly of ['Digi24', 'HotNews', 'G4Media', 'Dnevnik', 'Seznam Zprávy'] as const) {
      assert.ok(!enabled.has(localeOnly), `${localeOnly} must remain locale-boosted, not EN default-on`);
    }

    const roBoosted = feeds.getLocaleBoostedSources('ro');
    for (const name of ['Digi24', 'HotNews', 'G4Media'] as const) {
      assert.ok(roBoosted.has(name), `${name} must be boosted for ro`);
    }
    assert.ok(feeds.getLocaleBoostedSources('bg').has('Dnevnik'), 'Dnevnik must be boosted for bg');
    assert.ok(
      feeds.getLocaleBoostedSources('cs').has('Seznam Zprávy'),
      'Seznam Zprávy must be boosted for cs',
    );
  });

  it('allows every Eastern-flank publisher through the RSS proxy host policy (#5952)', () => {
    for (const [name, { url }] of Object.entries(EASTERN_FLANK_FEEDS)) {
      const hostname = new URL(url).hostname;
      assert.ok(isAllowedDomain(hostname), `${name} host ${hostname} must be RSS-allowlisted`);
    }
  });

  it('keeps both Eastern-flank EN defaults under the production free cap (#5952)', () => {
    assert.deepEqual(
      [...feeds.FREE_CAP_PROTECTED_SOURCES].sort(),
      [...FRONTLINE_EUROPE, ...REGIONAL_ROLLOUT_DEFAULTS].sort(),
      'free-cap protected defaults must match the editorially protected sets',
    );

    const disabledEn = new Set(feeds.computeDefaultDisabledSources('en'));
    const { keep, autoDisabled } = selectSourcesUnderCap(
      feeds.FEEDS,
      feeds.INTEL_SOURCES,
      disabledEn,
      80,
      new Set(feeds.FREE_CAP_PROTECTED_SOURCES),
    );

    for (const name of EASTERN_FLANK_EN_DEFAULTS) {
      assert.ok(keep.has(name), `${name} must survive the free source cap`);
      assert.ok(!autoDisabled.has(name), `${name} must not be auto-disabled by the free source cap`);
    }
  });

  it('locks additive Africa-depth URL/lang parity and EN defaults (#5955)', () => {
    const clientByName = new Map((feeds.FEEDS.africa ?? []).map((feed) => [feed.name, feed]));
    const serverByName = new Map(
      (serverFeeds.VARIANT_FEEDS.full?.africa ?? []).map((feed) => [feed.name, feed]),
    );
    const africaDefaults = feeds.DEFAULT_ENABLED_SOURCES.africa ?? [];

    for (const [name, expected] of Object.entries(AFRICA_DEPTH_FEEDS)) {
      const client = clientByName.get(name);
      const server = serverByName.get(name);
      assert.ok(client, `${name} must remain in the client Africa catalog`);
      assert.ok(server, `${name} must remain in the server full/Africa catalog`);
      assert.equal(client.url, expected.url, `${name} client URL drifted`);
      assert.equal(server.url, expected.url, `${name} server URL drifted`);
      assert.equal(client.lang, 'lang' in expected ? expected.lang : undefined, `${name} client lang drifted`);
      assert.equal(server.lang, 'lang' in expected ? expected.lang : undefined, `${name} server lang drifted`);
    }

    for (const name of AFRICA_DEPTH_EN_DEFAULTS) {
      assert.ok(africaDefaults.includes(name), `${name} must remain an Africa EN default`);
    }
  });

  it('allows every Africa-depth feed through the RSS proxy host policy (#5955)', () => {
    for (const [name, { url }] of Object.entries(AFRICA_DEPTH_FEEDS)) {
      const hostname = new URL(url).hostname;
      assert.ok(isAllowedDomain(hostname), `${name} host ${hostname} must be RSS-allowlisted`);
    }
  });

  it('keeps both Africa-depth EN defaults under the production free cap (#5955)', () => {
    const disabledEn = new Set(feeds.computeDefaultDisabledSources('en'));
    const { keep, autoDisabled } = selectSourcesUnderCap(
      feeds.FEEDS,
      feeds.INTEL_SOURCES,
      disabledEn,
      80,
      new Set(feeds.FREE_CAP_PROTECTED_SOURCES),
    );

    for (const name of AFRICA_DEPTH_EN_DEFAULTS) {
      assert.ok(keep.has(name), `${name} must survive the free source cap`);
      assert.ok(!autoDisabled.has(name), `${name} must not be auto-disabled by the free source cap`);
    }
  });

  it('locks the repaired #5953/#5954 URLs and language reachability across client and digest catalogs', () => {
    const clientByName = new Map(
      [...(feeds.FEEDS.europe ?? []), ...(feeds.FEEDS.asia ?? [])]
        .map((feed) => [feed.name, feed]),
    );
    const serverByName = new Map(
      [
        ...(serverFeeds.VARIANT_FEEDS.full?.europe ?? []),
        ...(serverFeeds.VARIANT_FEEDS.full?.asia ?? []),
      ].map((feed) => [feed.name, feed]),
    );

    for (const [name, expected] of Object.entries(REPAIRED_REGIONAL_FEEDS)) {
      const client = clientByName.get(name);
      const server = serverByName.get(name);
      assert.ok(client, `${name} must remain in the client regional catalog`);
      assert.ok(server, `${name} must remain in the server regional catalog`);
      assert.equal(client.url, expected.url, `${name} client URL drifted`);
      assert.equal(server.url, expected.url, `${name} server URL drifted`);
      assert.equal(client.lang, 'lang' in expected ? expected.lang : undefined, `${name} client lang drifted`);
      assert.equal(server.lang, 'lang' in expected ? expected.lang : undefined, `${name} server lang drifted`);
    }
  });

  it('keeps regional rollout defaults and opt-ins disjoint and truthful for fresh profiles', () => {
    assert.deepEqual(
      [...feeds.REGIONAL_FEED_ROLLOUT_DEFAULT_SOURCES].sort(),
      [...REGIONAL_ROLLOUT_DEFAULTS].sort(),
    );
    assert.deepEqual(
      [...feeds.REGIONAL_FEED_ROLLOUT_OPT_IN_SOURCES].sort(),
      [...REGIONAL_ROLLOUT_OPT_INS].sort(),
    );

    const defaults = feeds.getAllDefaultEnabledSources();
    const disabled = new Set(feeds.computeDefaultDisabledSources('en'));
    for (const name of REGIONAL_ROLLOUT_DEFAULTS) {
      assert.ok(defaults.has(name), `${name} must remain an explicit EN default`);
      assert.ok(!disabled.has(name), `${name} must not be disabled for a fresh EN profile`);
    }
    for (const name of REGIONAL_ROLLOUT_OPT_INS) {
      assert.ok(!defaults.has(name), `${name} must remain opt-in for EN`);
      assert.ok(disabled.has(name), `${name} must start disabled for a fresh EN profile`);
    }
  });

  it('reconstructs unique exact EN preference states across skipped/intermediate releases', () => {
    const targets = regionalRollout.buildRegionalFeedRolloutMigrationTargets(80, 'en');
    const states = targets.map((target) => target.legacyDisabled);
    const canonical = states.map((state) => JSON.stringify([...state].sort()));
    const preRolloutDefault = JSON.stringify(
      [...feeds.computePreRegionalFeedRolloutDefaultDisabledSources('en')].sort(),
    );

    assert.ok(states.length > 1, 'default-only and at least one cap path must be recognized');
    assert.equal(new Set(canonical).size, states.length, 'equivalent release paths must be deduplicated');
    assert.ok(canonical.includes(preRolloutDefault), 'the untouched pre-#5976 default state must be recognized');
    for (const target of targets) {
      assert.deepEqual([...target.defaultNames].sort(), [...RECONCILED_ROLLOUT_DEFAULTS].sort());
      assert.deepEqual([...target.optInNames].sort(), [...RECONCILED_ROLLOUT_OPT_INS].sort());
    }
  });

  it('migrates dormant schema-1/2 EN rows from before #5949 through schema 5', () => {
    const preFrontlineDefault = new Set(
      feeds.computePreRegionalFeedRolloutDefaultDisabledSources('en'),
    );
    for (const name of UKRAINE_DEPTH_NAMES) preFrontlineDefault.delete(name);
    for (const name of INITIAL_FRONTLINE_DEFAULTS) preFrontlineDefault.add(name);

    const targets = regionalRollout.buildRegionalFeedRolloutMigrationTargets(80, 'en');
    assert.ok(
      targets.some((target) => (
        target.legacyDisabled.size === preFrontlineDefault.size
        && [...preFrontlineDefault].every((name) => target.legacyDisabled.has(name))
      )),
      'the frozen pre-frontline fingerprint must not drift with later catalog additions',
    );

    const legacyPreStrategicDefault = new Set(
      feeds.computePreStrategicDefaultDisabledSources(),
    );
    const legacyPreStrategicCap = computeCapDisabledSources(
      feeds.FEEDS,
      feeds.INTEL_SOURCES,
      legacyPreStrategicDefault,
      80,
    );
    const migrations = buildMigrations(feeds.FEEDS, {
      frontline: {
        legacyDefaultDisabled: new Set(feeds.computeLegacyDefaultDisabledSources()),
        names: new Set(feeds.FRONTLINE_EUROPE_PROTECTED_SOURCES),
        legacyCapDisabled: legacyPreStrategicCap,
      },
      strategic: {
        names: feeds.getStrategicDefaultSources(),
        legacyDisabledStates: regionalRollout.buildPreStrategicDefaultDisabledStates(80),
      },
      regionalRollout: { targets },
    });
    for (const fromVersion of [1, 2]) {
      const blob = {
        'worldmonitor-disabled-feeds': JSON.stringify([...preFrontlineDefault]),
      };
      const migrated = applyMigrationChain(blob, fromVersion, 5, migrations);
      const disabled = new Set(
        JSON.parse(migrated['worldmonitor-disabled-feeds'] as string) as string[],
      );

      for (const name of RECONCILED_ROLLOUT_DEFAULTS) {
        assert.equal(
          disabled.has(name),
          false,
          `schema ${fromVersion}: ${name} must be enabled after the full chain`,
        );
      }
      for (const name of RECONCILED_ROLLOUT_OPT_INS) {
        assert.ok(
          disabled.has(name),
          `schema ${fromVersion}: ${name} must be disabled after the full chain`,
        );
      }
    }
  });

  it('promotes locale-matched rollout sources without changing unrelated opt-ins', () => {
    const ruTargets = regionalRollout.buildRegionalFeedRolloutMigrationTargets(80, 'ru');
    assert.ok(ruTargets.length > 0, 'the RU migration must reconstruct at least one exact state');
    for (const target of ruTargets) {
      assert.ok(target.defaultNames.has('NewsMaker'), 'NewsMaker is a RU locale default');
      assert.equal(target.optInNames.has('NewsMaker'), false, 'NewsMaker cannot also be an RU opt-in');
      assert.ok(target.optInNames.has('JAMnews'), 'unrelated regional sources remain opt-in');
    }
  });

  it('fails closed for locale-less cloud fingerprints with conflicting policies', () => {
    const targets = regionalRollout.buildRegionalFeedRolloutMigrationTargets(80);
    const targetsByLegacyState = new Map<string, typeof targets>();

    for (const target of targets) {
      const legacyKey = JSON.stringify([...target.legacyDisabled].sort());
      const matching = targetsByLegacyState.get(legacyKey) ?? [];
      matching.push(target);
      targetsByLegacyState.set(legacyKey, matching);
    }

    let ambiguousFingerprints = 0;
    for (const matching of targetsByLegacyState.values()) {
      const policies = new Set(matching.map((target) => JSON.stringify({
        defaults: [...target.defaultNames].sort(),
        optIns: [...target.optInNames].sort(),
      })));
      if (policies.size < 2) continue;
      ambiguousFingerprints += 1;
      const blob = {
        'worldmonitor-disabled-feeds': JSON.stringify([...matching[0]!.legacyDisabled]),
      };
      assert.equal(
        migrateRegionalFeedRolloutDefaultsV5(blob, targets),
        blob,
        'a cloud row without locale metadata must remain untouched when policies disagree',
      );
    }

    assert.ok(ambiguousFingerprints > 0, 'the production targets must exercise the ambiguity guard');
    assert.ok(
      targets.some((target) => target.defaultNames.has('NewsMaker')),
      'all-locale cloud reconstruction must include the RU NewsMaker policy',
    );
  });

  it('keeps every regional rollout default under the production free cap', () => {
    const disabledEn = new Set(feeds.computeDefaultDisabledSources('en'));
    const protectedNames = new Set(feeds.FREE_CAP_PROTECTED_SOURCES);
    const { keep, autoDisabled } = selectSourcesUnderCap(
      feeds.FEEDS,
      feeds.INTEL_SOURCES,
      disabledEn,
      80,
      protectedNames,
    );

    for (const name of REGIONAL_ROLLOUT_DEFAULTS) {
      assert.ok(protectedNames.has(name), `${name} must be explicitly protected from the free cap`);
      assert.ok(keep.has(name), `${name} must survive the free source cap`);
      assert.ok(!autoDisabled.has(name), `${name} must not be auto-disabled by the free source cap`);
    }
  });

  it('allowlists only direct regional feed hosts, not publisher names inside Google News queries', () => {
    for (const [name, expected] of Object.entries(REPAIRED_REGIONAL_FEEDS)) {
      const hostname = new URL(expected.url).hostname;
      assert.ok(isAllowedDomain(hostname), `${name} direct host ${hostname} must be RSS-allowlisted`);
    }
    for (const hostname of UNUSED_REGIONAL_PUBLISHER_HOSTS) {
      assert.equal(
        isAllowedDomain(hostname),
        false,
        `${hostname} is not fetched directly and must not expand the RSS proxy allowlist`,
      );
    }
  });

  it('propaganda risk tags present for TASS/RT/Kyiv Independent and default-on independent RU (#5950)', () => {
    for (const name of RU_STATE_PROPAGANDA) {
      const profile = feeds.SOURCE_PROPAGANDA_RISK[name];
      assert.ok(profile, `${name} must have a SOURCE_PROPAGANDA_RISK entry`);
      assert.equal(profile.risk, 'high');
      assert.equal(profile.stateAffiliated, 'Russia');
    }

    const kyiv = feeds.SOURCE_PROPAGANDA_RISK['Kyiv Independent'];
    assert.ok(kyiv, 'Kyiv Independent must have a SOURCE_PROPAGANDA_RISK entry');
    assert.notEqual(kyiv.risk, 'unknown', 'Kyiv Independent must be reviewed (not unknown)');
    // UA primary is perspective-bearing, not state-media high.
    assert.ok(
      kyiv.risk === 'medium' || kyiv.risk === 'low',
      `Kyiv Independent risk should be medium|low, got ${kyiv.risk}`,
    );

    for (const name of INDEPENDENT_RU_DEFAULTS) {
      const profile = feeds.SOURCE_PROPAGANDA_RISK[name];
      assert.ok(profile, `${name} (default-on independent RU) must have SOURCE_PROPAGANDA_RISK entry`);
      assert.notEqual(profile.risk, 'unknown', `${name} must be reviewed`);
      assert.notEqual(
        profile.stateAffiliated,
        'Russia',
        `${name} is independent/exile — must not be tagged stateAffiliated:Russia`,
      );
      assert.ok(
        profile.risk === 'low' || profile.risk === 'medium',
        `${name} risk should be low|medium (not state-media high), got ${profile.risk}`,
      );
    }
  });
});
