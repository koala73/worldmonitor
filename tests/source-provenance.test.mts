/**
 * Source provenance fail-closed defaults (#5390).
 *
 * Regression: unlisted feeds used to default to propaganda risk `low`
 * ("Independent journalism with editorial standards") and source type
 * `other`, which NewsPanel rendered for Tier 1/2 as "Verified News Outlet"
 * (and Tier 1 as a "Wire" label). Official ministry feeds such as
 * official Chinese policy sources therefore looked like independent wire services.
 *
 * Contract:
 * - Missing registry entries → risk `unknown`, type `unknown` (never low/other)
 * - Explicit low only when reviewed in SOURCE_PROPAGANDA_RISK
 * - All six China policy agencies are government sources with high state-affiliated risk
 * - Badge helpers never claim "Verified News Outlet" for unreviewed types
 * - Every configured feed has a definite provenance state via the public API
 *
 * Loading note: `src/config/feeds.ts` pulls `rssProxyUrl` → `import.meta.env.DEV`.
 * Node/tsx has no Vite env object, so we esbuild-bundle with defines (same
 * pattern as tests/mission-presets.test.mts).
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { CONFIGURED_SOURCE_PROVENANCE_DECLARATIONS } from '../shared/source-provenance-declarations';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');
const tempDir = join(repoRoot, 'tmp-source-provenance-test');
const outfile = join(tempDir, 'feeds-bundle.mjs');
const rendererOutfile = join(tempDir, 'renderer-bundle.mjs');

interface FeedsModule {
  SOURCE_PROPAGANDA_RISK: Record<string, { risk: string; stateAffiliated?: string; note?: string }>;
  SOURCE_TYPES: Record<string, string>;
  UNREVIEWED_SOURCE_RISK: { risk: string; note?: string };
  describePropagandaBadge: (
    profile: { risk: string; note?: string; stateAffiliated?: string },
    sourceType?: string,
  ) => {
    risk: string;
    label: string;
    shortLabel: string;
    title: string;
  } | null;
  getFeedProvenanceState: (name: string) => {
    risk: string;
    type: string;
    riskDeclared: boolean;
    typeDeclared: boolean;
    riskReviewed: boolean;
    typeReviewed: boolean;
  };
  getSourcePropagandaRisk: (name: string) => { risk: string; stateAffiliated?: string; note?: string };
  getSourceTier: (name: string) => number;
  getSourceTierBadgeTitle: (type: string) => string;
  getSourceType: (name: string) => string;
  hasDeclaredPropagandaRisk: (name: string) => boolean;
  hasDeclaredSourceType: (name: string) => boolean;
  hasReviewedPropagandaRisk: (name: string) => boolean;
  hasReviewedSourceType: (name: string) => boolean;
  listConfiguredFeedNames: () => string[];
}

let feeds: FeedsModule;
let renderer: {
  renderPrimarySourceProvenance: (sourceName: string) => {
    riskBadge: string;
    tierBadge: string;
  };
  renderCorroboratingSourceRisk: (sourceName: string) => string;
};

before(async () => {
  mkdirSync(tempDir, { recursive: true });
  // Stub the @/utils barrel so we don't drag proxy → i18n → import.meta.glob.
  // feeds.ts only needs rssProxyUrl (identity is fine for name-based registries).
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
    alias: {
      '@': join(repoRoot, 'src'),
    },
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

  const rendererResult = await build({
    entryPoints: [join(repoRoot, 'src/components/news/source-provenance.ts')],
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: 'es2022',
    write: false,
    absWorkingDir: repoRoot,
    alias: {
      '@': join(repoRoot, 'src'),
    },
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
  writeFileSync(rendererOutfile, rendererResult.outputFiles[0].text, 'utf8');
  renderer = await import(`${pathToFileURL(rendererOutfile).href}?t=${Date.now()}`) as typeof renderer;
});

describe('source provenance defaults (#5390)', () => {
  it('does not map missing risk profiles to independent (low)', () => {
    const profile = feeds.getSourcePropagandaRisk('Completely Unlisted Outlet XYZ');
    assert.equal(profile.risk, 'unknown');
    assert.equal(profile.note, feeds.UNREVIEWED_SOURCE_RISK.note);
    assert.equal(feeds.hasDeclaredPropagandaRisk('Completely Unlisted Outlet XYZ'), false);
    assert.equal(feeds.hasReviewedPropagandaRisk('Completely Unlisted Outlet XYZ'), false);
  });

  it('does not map missing source types to other', () => {
    assert.equal(feeds.getSourceType('Completely Unlisted Outlet XYZ'), 'unknown');
    assert.equal(feeds.hasDeclaredSourceType('Completely Unlisted Outlet XYZ'), false);
    assert.equal(feeds.hasReviewedSourceType('Completely Unlisted Outlet XYZ'), false);
  });

  it('keeps explicit low only for reviewed independent sources', () => {
    assert.equal(feeds.getSourcePropagandaRisk('Reuters').risk, 'low');
    assert.equal(feeds.hasReviewedPropagandaRisk('Reuters'), true);
    assert.equal(feeds.describePropagandaBadge(feeds.getSourcePropagandaRisk('Reuters')), null);
  });

  it('classifies all six China policy agencies as official Chinese government sources', () => {
    for (const name of [
      'CAC (China)',
      'SAMR (China)',
      'MIIT (China)',
      'MOFCOM (China)',
      'NDRC (China)',
      'PBoC (China)',
    ] as const) {
      assert.equal(feeds.getSourceType(name), 'gov', `${name} type`);
      assert.equal(feeds.SOURCE_TYPES[name], 'gov');
      const risk = feeds.getSourcePropagandaRisk(name);
      assert.equal(risk.risk, 'high', `${name} risk`);
      assert.equal(risk.stateAffiliated, 'China');
      assert.equal(feeds.getSourceTier(name), 1, `${name} tier`);
      const badge = feeds.describePropagandaBadge(risk, feeds.getSourceType(name));
      assert.ok(badge);
      assert.equal(badge!.risk, 'high');
      assert.equal(badge!.label, 'Official Government Source');
      assert.doesNotMatch(badge!.label, /State Media/);
      assert.equal(feeds.getSourceTierBadgeTitle(feeds.getSourceType(name)), 'Official Government Source');
      assert.notEqual(feeds.getSourceType(name), 'wire');
    }
  });

  it('never presents unreviewed types as Verified News Outlet', () => {
    assert.equal(feeds.getSourceTierBadgeTitle('unknown'), 'Source type not yet reviewed');
    assert.doesNotMatch(feeds.getSourceTierBadgeTitle('unknown'), /Verified/i);
    assert.equal(feeds.getSourceTierBadgeTitle('wire'), 'Wire Service - Highest reliability');
    assert.equal(feeds.getSourceTierBadgeTitle('gov'), 'Official Government Source');
    assert.doesNotMatch(feeds.getSourceTierBadgeTitle('mainstream'), /Verified News Outlet/);
  });

  it('surfaces unknown provenance in badge descriptors', () => {
    const badge = feeds.describePropagandaBadge(feeds.getSourcePropagandaRisk('Fars News'));
    assert.ok(badge);
    assert.equal(badge!.risk, 'unknown');
    assert.match(badge!.label, /Unreviewed/);
    assert.match(badge!.title, /not yet reviewed/i);
  });

  it('requires an explicit reviewed-or-unknown declaration for every configured feed', () => {
    const names = feeds.listConfiguredFeedNames();
    assert.ok(names.length > 100, `expected many feeds, got ${names.length}`);
    assert.ok(names.includes('MIIT (China)'));
    assert.ok(names.includes('MOFCOM (China)'));
    const declaredNames = Object.keys(CONFIGURED_SOURCE_PROVENANCE_DECLARATIONS);
    assert.deepEqual(
      [...declaredNames].sort((a, b) => a.localeCompare(b)),
      [...names].sort((a, b) => a.localeCompare(b)),
      'configured feed names and provenance declarations must match exactly; regenerate after additions or aliases change',
    );

    const falselyIndependent: string[] = [];
    let explicitUnknownDimensions = 0;

    for (const name of names) {
      const state = feeds.getFeedProvenanceState(name);
      const declaration = CONFIGURED_SOURCE_PROVENANCE_DECLARATIONS[name];
      assert.ok(declaration, `${name} missing explicit provenance declaration`);
      assert.ok(state.risk, `${name} missing risk`);
      assert.ok(state.type, `${name} missing type`);
      assert.equal(state.riskDeclared, true, `${name} risk declaration`);
      assert.equal(state.typeDeclared, true, `${name} type declaration`);
      assert.equal(
        declaration.risk,
        state.riskReviewed ? 'reviewed' : 'unknown',
        `${name} risk declaration drift`,
      );
      assert.equal(
        declaration.type,
        state.typeReviewed ? 'reviewed' : 'unknown',
        `${name} type declaration drift`,
      );
      if (declaration.risk === 'unknown') explicitUnknownDimensions += 1;
      if (declaration.type === 'unknown') explicitUnknownDimensions += 1;

      if (state.risk === 'low' && !state.riskReviewed) {
        falselyIndependent.push(name);
      }
      if (!state.riskReviewed) {
        assert.equal(state.risk, 'unknown', `${name} unreviewed risk`);
      }
      if (!state.typeReviewed) {
        assert.equal(state.type, 'unknown', `${name} unreviewed type`);
      }
    }

    assert.deepEqual(falselyIndependent, [], 'unreviewed feeds must not claim low risk');
    assert.ok(explicitUnknownDimensions > 0, 'unreviewed dimensions must be explicitly declared unknown');
  });

  it('SOURCE_PROPAGANDA_RISK entries never use the unknown default sentinel by accident', () => {
    for (const [name, profile] of Object.entries(feeds.SOURCE_PROPAGANDA_RISK)) {
      assert.ok(
        profile.risk === 'low' || profile.risk === 'medium' || profile.risk === 'high',
        `${name} should be an explicit reviewed risk, got ${profile.risk}`,
      );
    }
  });

  it('renders NewsPanel provenance output for unreviewed, government, and reviewed wire sources', () => {
    const unreviewed = renderer.renderPrimarySourceProvenance('Reuters US');
    assert.match(unreviewed.riskBadge, /\? Unreviewed/);
    assert.match(unreviewed.riskBadge, /not yet reviewed/i);
    assert.match(unreviewed.tierBadge, /Source type not yet reviewed/);
    assert.doesNotMatch(unreviewed.tierBadge, />[^<]*Wire/);

    const government = renderer.renderPrimarySourceProvenance('MIIT (China)');
    assert.match(government.riskBadge, /Official Government Source/);
    assert.doesNotMatch(government.riskBadge, /State Media/);
    assert.match(government.tierBadge, /Official Government Source/);
    assert.doesNotMatch(government.tierBadge, />[^<]*Wire/);

    const reviewedWire = renderer.renderPrimarySourceProvenance('Reuters');
    assert.equal(reviewedWire.riskBadge, '');
    assert.match(reviewedWire.tierBadge, /Wire Service - Highest reliability/);
    assert.match(reviewedWire.tierBadge, />★ Wire</);

    assert.match(renderer.renderCorroboratingSourceRisk('Fars News'), />\?</);
  });
});

// Best-effort cleanup; ignore errors if concurrent tests hold the dir
process.on('exit', () => {
  try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
});
