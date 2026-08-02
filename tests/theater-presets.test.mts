/**
 * Theater coverage preset guards (#5956).
 *
 * Locks the preset contract:
 * - ≥3 theater presets defined (issue acceptance criterion)
 * - every preset source name resolves in the feed catalog (same dangling-name
 *   class as feed-catalog-drift.test.mts — a preset name with no feed
 *   definition silently no-ops on apply)
 * - catalog opt-in-only state propaganda (TASS/RT/Xinhua/Fars/IRNA/Mehr/
 *   Azertag/Armenpress) never enters a preset — the #5950 rule that state
 *   propaganda stays manual opt-in extends to one-click presets
 * - apply is additive: enabling a preset only ever removes the preset's own
 *   sources from the disabled set; unrelated user choices survive
 *
 * Bundling note: feeds.ts needs esbuild defines for import.meta.env — the
 * shared harness lives in tests/_lib/bundle-feeds-module.mts.
 * theater-presets.ts is dependency-free and imports directly under tsx.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundleFeedsModule } from './_lib/bundle-feeds-module.mts';
import {
  THEATER_PRESETS,
  getTheaterPreset,
  resolveTheaterPresetSources,
  getTheaterPresetEnableList,
  type TheaterPreset,
} from '../src/config/theater-presets';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');
const tempDir = join(repoRoot, 'tmp-theater-presets-test');

interface FeedsModule {
  listConfiguredFeedNames: () => string[];
  SOURCE_PROPAGANDA_RISK: Record<string, { risk: string; stateAffiliated?: string }>;
}

/**
 * State propaganda the catalog keeps as manual opt-in only (#5950 rule).
 * Presets must never one-click-enable these.
 */
const STATE_PROPAGANDA_OPT_IN_ONLY = [
  'TASS',
  'RT',
  'RT Russia',
  'Xinhua',
  'Fars News',
  'IRNA',
  'Mehr News',
  'Azertag',
  'Armenpress',
] as const;

let feeds: FeedsModule;

before(async () => {
  feeds = await bundleFeedsModule<FeedsModule>({ repoRoot, tempDir });
});

after(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('theater coverage presets (#5956)', () => {
  it('defines at least 3 presets with unique ids', () => {
    assert.ok(
      THEATER_PRESETS.length >= 3,
      `expected >=3 theater presets, got ${THEATER_PRESETS.length}`,
    );
    const ids = THEATER_PRESETS.map((preset) => preset.id);
    assert.equal(new Set(ids).size, ids.length, `duplicate preset ids: ${ids.join(', ')}`);
  });

  it('every preset source name resolves in the feed catalog', () => {
    const configured = new Set(feeds.listConfiguredFeedNames());
    for (const preset of THEATER_PRESETS) {
      const dangling = preset.sourceNames.filter((name) => !configured.has(name));
      assert.deepEqual(
        dangling,
        [],
        `preset "${preset.id}" names with no feed definition: ${dangling.join(', ')}. ` +
          'A preset source without a catalog entry silently no-ops on apply — ' +
          'add it to feeds.ts/INTEL_SOURCES or remove it from the preset.',
      );
    }
  });

  it('no duplicate source names within a preset', () => {
    for (const preset of THEATER_PRESETS) {
      assert.equal(
        new Set(preset.sourceNames).size,
        preset.sourceNames.length,
        `preset "${preset.id}" has duplicate source names`,
      );
    }
  });

  it('never includes catalog opt-in-only state propaganda', () => {
    for (const preset of THEATER_PRESETS) {
      for (const name of STATE_PROPAGANDA_OPT_IN_ONLY) {
        assert.ok(
          !preset.sourceNames.includes(name),
          `${name} must stay manual opt-in only — remove it from preset "${preset.id}" (#5950 rule)`,
        );
      }
    }
  });

  it('keeps every preset name non-state-propaganda per the provenance registry', () => {
    // Defense in depth beyond the explicit blocklist: a newly added preset
    // source that is later tagged high-risk state-affiliated must be reviewed
    // (Ukrinform/Suspilne are the deliberate theater-pack exceptions —
    // national institutions, risk-tagged in the UI).
    //
    // Guard against a vacuous pass first: if the registry export is renamed
    // or emptied, the optional-chained lookup below would silently skip every
    // check. Pin that the registry is a non-empty object and that two known
    // high-risk entries resolve before trusting the loop.
    const registry = feeds.SOURCE_PROPAGANDA_RISK;
    assert.ok(
      registry && typeof registry === 'object' && Object.keys(registry).length > 0,
      'SOURCE_PROPAGANDA_RISK must be a non-empty registry — a missing/emptied export must not vacuously pass',
    );
    for (const name of ['TASS', 'RT'] as const) {
      assert.equal(
        registry[name]?.risk,
        'high',
        `${name} must be present in SOURCE_PROPAGANDA_RISK with risk 'high' (registry sanity anchor)`,
      );
    }

    const allowedHighRiskState = new Set(['Ukrinform', 'Suspilne']);
    for (const preset of THEATER_PRESETS) {
      for (const name of preset.sourceNames) {
        const profile = registry[name];
        if (profile?.risk === 'high' && profile.stateAffiliated) {
          assert.ok(
            allowedHighRiskState.has(name),
            `${name} in preset "${preset.id}" is high-risk state-affiliated (${profile.stateAffiliated}) — ` +
              'state propaganda must stay manual opt-in; add it to the allow-list only with an editorial note',
          );
        }
      }
    }
  });

  it('label and description i18n keys exist in en.json', () => {
    const en = JSON.parse(readFileSync(join(repoRoot, 'src/locales/en.json'), 'utf8'));
    const lookup = (path: string) => path.split('.').reduce<unknown>((node, key) => {
      if (node && typeof node === 'object') return (node as Record<string, unknown>)[key];
      return undefined;
    }, en);
    for (const preset of THEATER_PRESETS) {
      assert.equal(typeof lookup(preset.labelKey), 'string', `${preset.labelKey} missing in en.json`);
      assert.equal(typeof lookup(preset.descriptionKey), 'string', `${preset.descriptionKey} missing in en.json`);
    }
  });

  it('resolveTheaterPresetSources drops names the runtime does not load', () => {
    const preset = getTheaterPreset('ukraine-war');
    assert.ok(preset, 'ukraine-war preset must exist');
    const known = new Set(['Kyiv Independent', 'ISW']);
    assert.deepEqual(
      resolveTheaterPresetSources(preset, known),
      ['Kyiv Independent', 'ISW'],
      'unresolvable names must be filtered so catalog/variant drift is a silent no-op, not an error',
    );
  });

  it('apply is additive: only the preset\'s own disabled sources are enabled', () => {
    const preset: TheaterPreset = {
      id: 'test-preset',
      labelKey: 'test.label',
      descriptionKey: 'test.description',
      sourceNames: ['Alpha', 'Beta'],
    };
    const known = new Set(['Alpha', 'Beta', 'Gamma', 'Delta']);
    // User state: Alpha + Gamma disabled, Beta + Delta enabled.
    const disabled = new Set(['Alpha', 'Gamma']);

    const enableList = getTheaterPresetEnableList(preset, disabled, known);
    assert.deepEqual(enableList, ['Alpha'], 'only preset sources that are disabled should be enabled');

    // Simulate the additive apply (setSourcesEnabled semantics).
    const afterApply = new Set(disabled);
    for (const name of enableList) afterApply.delete(name);
    assert.ok(!afterApply.has('Alpha'), 'preset source enabled');
    assert.ok(afterApply.has('Gamma'), 'unrelated user-disabled source must survive (additive apply)');
    assert.equal(afterApply.size, 1, 'no other state may change');
  });

  it('reports an empty enable list when the preset is already fully applied', () => {
    const preset = getTheaterPreset('sahel-west-africa');
    assert.ok(preset, 'sahel-west-africa preset must exist');
    const known = new Set(preset.sourceNames);
    const disabled = new Set<string>();
    assert.deepEqual(
      getTheaterPresetEnableList(preset, disabled, known),
      [],
      'an already-applied preset must produce no work (UI shows "already applied")',
    );
  });
});
