/**
 * Executable regression coverage for the CMD+K premium-layer gate (#6045).
 *
 * These tests call the production command policy rather than scanning source
 * text. The policy must preserve a stale free-user off-ramp while denying new
 * activation, and it must continue to honor renderer/DeckGL constraints.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import {
  LAYER_REGISTRY,
  isLayerCommandAllowed,
  isLayerEntitled,
  isLayerExecutable,
  shouldSanitizeLockedLayers,
  sanitizeLockedLayers,
} from '../src/config/map-layer-definitions.ts';
import type { MapLayers } from '../src/types/index.ts';

const searchManagerSrc = readFileSync(new URL('../src/app/search-manager.ts', import.meta.url), 'utf8');
const searchSelectionSrc = readFileSync(
  new URL('../src/app/search-selection-dispatcher.ts', import.meta.url),
  'utf8',
);
const commandTier = { premium: false };

function extractSelectionDispatcher(): new (bindings: any) => {
  handleCommand(command: { id: string }): boolean | Promise<boolean>;
} {
  const sourceFile = ts.createSourceFile(
    'search-selection-dispatcher.ts',
    searchSelectionSrc,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const dispatcher = sourceFile.statements.find((statement): statement is ts.ClassDeclaration => (
    ts.isClassDeclaration(statement) && statement.name?.text === 'SearchSelectionDispatcher'
  ));
  assert.ok(dispatcher, 'SearchSelectionDispatcher must remain in the source');
  const js = ts.transpileModule(dispatcher.getText(sourceFile).replace(/^export\s+/, ''), {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.None },
  }).outputText;
  return new Function(
    'STORAGE_KEYS',
    'getAllowedLayerKeys',
    'isLayerExecutable',
    'isLayerEntitled',
    'isLayerCommandAllowed',
    'LAYER_PRESETS',
    'LAYER_KEY_MAP',
    'TIER1_COUNTRIES',
    'CURATED_COUNTRIES',
    'getCountryBbox',
    `${js}\nreturn SearchSelectionDispatcher;`,
  )(
    { mapLayers: 'mapLayers' },
    () => new Set(['resilienceScore', 'conflicts']),
    isLayerExecutable,
    isLayerEntitled,
    isLayerCommandAllowed,
    { all: ['conflicts'] },
    {},
    {},
    {},
    () => null,
  ) as new (bindings: any) => {
    handleCommand(command: { id: string }): boolean | Promise<boolean>;
  };
}

const SearchSelectionHarness = extractSelectionDispatcher();

function extractLayerExecutableCallback(): (context: { ctx: any }, layerKey: string) => boolean {
  const marker = 'this.ctx.searchModal.setLayerExecutableFn((layerKey) => {';
  const start = searchManagerSrc.indexOf(marker);
  assert.ok(start >= 0, 'SearchManager must wire a layer executable callback');
  const arrowStart = searchManagerSrc.indexOf('(layerKey) => {', start);
  const braceStart = searchManagerSrc.indexOf('{', arrowStart);
  let depth = 0;
  let end = -1;
  for (let i = braceStart; i < searchManagerSrc.length; i++) {
    if (searchManagerSrc[i] === '{') depth++;
    else if (searchManagerSrc[i] === '}' && --depth === 0) {
      end = i + 1;
      break;
    }
  }
  assert.ok(end > braceStart, 'SearchManager layer executable callback must have balanced braces');
  const js = ts.transpileModule(
    `function createCallback() { return ${searchManagerSrc.slice(arrowStart, end)}; }`,
    { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.None } },
  ).outputText;
  return new Function(
    'SITE_VARIANT',
    'LAYER_KEY_MAP',
    'getAllowedLayerKeys',
    'isLayerCommandAllowed',
    'hasPremiumAccess',
    'getAuthState',
    `${js}\nreturn createCallback;`,
  )(
    'full',
    {},
    () => new Set(['resilienceScore']),
    isLayerCommandAllowed,
    () => commandTier.premium,
    () => ({}),
  ) as () => (layerKey: string) => boolean;
}

const layerExecutableCallbackFactory = extractLayerExecutableCallback();

function makeCommandHarness({
  premium = false,
  resilienceScore = false,
}: { premium?: boolean; resilienceScore?: boolean } = {}) {
  const calls = { enabled: [] as string[], setLayers: 0 };
  commandTier.premium = premium;
  const ctx = {
    mapLayers: { resilienceScore, conflicts: false } as unknown as MapLayers,
    map: {
      isGlobeMode: () => false,
      isDeckGLActive: () => true,
      enableLayer: (key: string) => { calls.enabled.push(key); },
      setLayers: () => { calls.setLayers++; },
    },
  };
  const dispatcher = new SearchSelectionHarness({
    ctx,
    getVariant: () => 'full',
    hasPremiumAccess: () => commandTier.premium,
    openCountryBriefByCode: () => true,
    enablePanel: () => true,
    trackSearchResultSelected: () => {},
    trackCountrySelected: () => {},
    runWithAgentAnalyticsSuppressed: (callback: () => unknown) => callback(),
    suppressNextAgentPanelView: () => {},
    resolveExecutableNewsPanel: () => null,
    saveToStorage: () => {},
    setTheme: () => {},
    setTimeout,
    clearTimeout,
  });
  const command = (id: string) => dispatcher.handleCommand({ id });
  return { ctx, calls, command };
}

describe('CMD+K premium layer gate (#6045)', () => {
  it('free users cannot activate the locked resilience layer', () => {
    assert.equal(LAYER_REGISTRY.resilienceScore.premium, 'locked');
    assert.equal(isLayerCommandAllowed('resilienceScore', false, 'deck', false), false);
  });

  it('free users can clear a stale checked locked layer', () => {
    assert.equal(isLayerCommandAllowed('resilienceScore', true, 'deck', false), true);
    const stale = { resilienceScore: true } as unknown as MapLayers;
    assert.equal(sanitizeLockedLayers(stale, false).resilienceScore, false);
  });

  it('premium users and enhanced layers retain activation access', () => {
    assert.equal(isLayerCommandAllowed('resilienceScore', false, 'deck', true), true);
    // ciiChoropleth is enhanced (free-toggleable) and renders on deck.
    assert.equal(isLayerCommandAllowed('ciiChoropleth', false, 'deck', false), true);
  });

  it('does not treat an unresolved tier as settled-free', () => {
    assert.equal(shouldSanitizeLockedLayers(false, false, false), false);
    assert.equal(isLayerCommandAllowed('resilienceScore', false, 'deck', false), false,
      'activation stays fail-closed while entitlement is unavailable');
  });

  it('still blocks commands that cannot render in the active map context', () => {
    // resilience renders only on deck; globe is blocked even for premium.
    assert.equal(isLayerCommandAllowed('resilienceScore', false, 'globe', true), false);
    // storageFacilities is deck-only; the SVG fallback cannot run it.
    assert.equal(isLayerCommandAllowed('storageFacilities', false, 'svg', true), false);
    // ciiChoropleth renders on deck/globe but not the SVG fallback.
    assert.equal(isLayerCommandAllowed('ciiChoropleth', false, 'svg', false), false);
  });

  it('wires the production command handler for direct layer and resilience commands', () => {
    const free = makeCommandHarness();
    free.command('layer:resilienceScore');
    assert.equal(free.ctx.mapLayers.resilienceScore, false,
      'free users must not activate resilience through layer:<key>');
    assert.deepEqual(free.calls.enabled, []);

    free.ctx.mapLayers.resilienceScore = true;
    free.command('layer:resilienceScore');
    assert.equal(free.ctx.mapLayers.resilienceScore, false,
      'a stale locked layer must remain recoverable through layer:<key>');
    assert.equal(free.calls.setLayers, 1);

    const premium = makeCommandHarness({ premium: true });
    premium.command('view:resilience');
    assert.equal(premium.ctx.mapLayers.resilienceScore, true,
      'premium users must be able to activate the resilience shortcut');
    assert.deepEqual(premium.calls.enabled, ['resilienceScore']);
  });

  it('wires the production palette filter with stale-off and free-activation gates', () => {
    const ctx = {
      mapLayers: { resilienceScore: false },
      map: {
        isGlobeMode: () => false,
        isDeckGLActive: () => true,
      },
    };
    commandTier.premium = false;
    assert.equal(layerExecutableCallbackFactory.call({ ctx })('resilienceScore'), false);
    ctx.mapLayers.resilienceScore = true;
    assert.equal(layerExecutableCallbackFactory.call({ ctx })('resilienceScore'), true);
    commandTier.premium = true;
    ctx.mapLayers.resilienceScore = false;
    assert.equal(layerExecutableCallbackFactory.call({ ctx })('resilienceScore'), true);
  });

  it('keeps locked layers out of the production all-layers preset for free users', () => {
    const free = makeCommandHarness();
    free.command('layers:all');
    assert.equal(free.ctx.mapLayers.resilienceScore, false);
    assert.equal(free.ctx.mapLayers.conflicts, true);
    assert.equal(free.calls.setLayers, 1);
  });
});
