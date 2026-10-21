import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

import {
  sanitizeLockedLayers,
  shouldSanitizeLockedLayers,
} from '../src/config/map-layer-definitions';
import { normalizeExclusiveChoropleths } from '../src/components/resilience-choropleth-utils';
import type { MapLayers } from '../src/types';

const panelLayoutSrc = readFileSync(new URL('../src/app/panel-layout.ts', import.meta.url), 'utf8');
const appSrc = readFileSync(new URL('../src/App.ts', import.meta.url), 'utf8');
const tier = { premium: false, resolved: true, fallback: false };
let gateOwnershipReads = 0;
const savedPreference = {
  resilienceScore: true,
  ciiChoropleth: false,
  conflicts: false,
} as unknown as MapLayers;
const restoreProbe: { persisted: MapLayers; writes: number } = {
  persisted: { ...savedPreference },
  writes: 0,
};

function extractApplyInitialUrlState(): new () => {
  ctx: any;
  callbacks: any;
  applyInitialUrlState(): void;
} {
  const signature = 'private applyInitialUrlState(): void {';
  const start = panelLayoutSrc.indexOf(signature);
  assert.ok(start >= 0, 'PanelLayoutManager.applyInitialUrlState must remain in the source');
  const braceStart = panelLayoutSrc.indexOf('{', start);
  let depth = 0;
  let end = -1;
  for (let i = braceStart; i < panelLayoutSrc.length; i++) {
    if (panelLayoutSrc[i] === '{') depth++;
    else if (panelLayoutSrc[i] === '}' && --depth === 0) {
      end = i + 1;
      break;
    }
  }
  assert.ok(end > braceStart, 'PanelLayoutManager.applyInitialUrlState must have balanced braces');
  const method = panelLayoutSrc.slice(start, end).replace(/^private\s+/, '');
  const js = ts.transpileModule(
    `const document = { getElementById: () => null }; class PanelLayoutHarness { ${method} }`,
    { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.None } },
  ).outputText;
  return new Function(
    'normalizeExclusiveChoropleths',
    'shouldSanitizeLockedLayers',
    'sanitizeLockedLayers',
    'hasPremiumAccess',
    'getAuthState',
    'isProTierResolved',
    'STORAGE_KEYS',
    'saveToStorage',
    `${js}\nreturn PanelLayoutHarness;`,
  )(
    normalizeExclusiveChoropleths,
    shouldSanitizeLockedLayers,
    sanitizeLockedLayers,
    () => tier.premium,
    () => ({}),
    () => tier.resolved,
    { mapLayers: 'mapLayers' },
    (_key: string, layers: MapLayers) => {
      restoreProbe.persisted = { ...layers };
      restoreProbe.writes += 1;
    },
  ) as new () => {
    ctx: any;
    callbacks: any;
    applyInitialUrlState(): void;
  };
}

const PanelLayoutHarness = extractApplyInitialUrlState();

function extractSanitizeMapLayersForTier(): new () => {
  freeTierGate: { authSettleDeadlineExceeded: boolean };
  sanitizeMapLayersForTier(
    layers: MapLayers,
    fallbackActive?: boolean,
    options?: { ephemeralSnapshot?: boolean },
  ): MapLayers;
} {
  const signature = 'private sanitizeMapLayersForTier(';
  const start = appSrc.indexOf(signature);
  assert.ok(start >= 0, 'App.sanitizeMapLayersForTier must remain in the source');
  const bodyMarker = appSrc.indexOf('): MapLayers {', start);
  assert.ok(bodyMarker > start, 'App.sanitizeMapLayersForTier must keep its return type');
  const braceStart = appSrc.indexOf('{', bodyMarker);
  let depth = 0;
  let end = -1;
  for (let i = braceStart; i < appSrc.length; i++) {
    if (appSrc[i] === '{') depth++;
    else if (appSrc[i] === '}' && --depth === 0) {
      end = i + 1;
      break;
    }
  }
  assert.ok(end > braceStart, 'App.sanitizeMapLayersForTier must have balanced braces');
  const method = appSrc.slice(start, end).replace(/^private\s+/, '');
  const js = ts.transpileModule(
    `class AppHarness { ${method} }`,
    { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.None } },
  ).outputText;
  return new Function(
    'hasPremiumAccess',
    'loadFromStorage',
    `${js}\nreturn AppHarness;`,
  )(
    () => true,
    () => {
      gateOwnershipReads += 1;
      return ['resilienceScore'];
    },
  ) as new () => {
    freeTierGate: { authSettleDeadlineExceeded: boolean };
    sanitizeMapLayersForTier(
      layers: MapLayers,
      fallbackActive?: boolean,
      options?: { ephemeralSnapshot?: boolean },
    ): MapLayers;
  };
}

const AppSanitizeHarness = extractSanitizeMapLayersForTier();

function runInitialUrlRestore({
  premium = false,
  resolved = true,
  fallback = false,
}: { premium?: boolean; resolved?: boolean; fallback?: boolean } = {}) {
  tier.premium = premium;
  tier.resolved = resolved;
  tier.fallback = fallback;
  restoreProbe.persisted = { ...savedPreference };
  restoreProbe.writes = 0;
  const sourceLayers = { resilienceScore: true, ciiChoropleth: false, conflicts: true } as unknown as MapLayers;
  let rendered: MapLayers | null = null;
  const initialUrlState = { layers: sourceLayers };
  const ctx = {
    initialUrlState,
    mapLayers: { ...sourceLayers },
    map: {
      isDeckGLActive: () => true,
      setLayers: (layers: MapLayers) => { rendered = { ...layers }; },
      getState: () => ({ view: 'global' }),
    },
  };
  const Harness = new PanelLayoutHarness();
  Harness.ctx = ctx;
  Harness.callbacks = { isFreeTierFallbackActive: () => tier.fallback };

  Harness.applyInitialUrlState();

  return {
    ctx,
    rendered,
    persisted: restoreProbe.persisted,
    persistenceWrites: restoreProbe.writes,
  };
}

describe('initial URL map-layer entitlement healing (#6045)', () => {
  it('sanitizes the rendered URL snapshot without changing saved preferences', () => {
    const result = runInitialUrlRestore({ premium: false, resolved: true });
    assert.equal(result.ctx.mapLayers.resilienceScore, false);
    assert.equal(result.ctx.initialUrlState.layers.resilienceScore, false);
    assert.equal(result.rendered?.resilienceScore, false);
    assert.equal(result.persistenceWrites, 0, 'URL application must not persist map layers');
    assert.deepEqual(result.persisted, savedPreference, 'saved preferences remain untouched');
  });

  it('does not clamp a pending tier before the bounded fallback', () => {
    const result = runInitialUrlRestore({ premium: false, resolved: false });
    assert.equal(result.ctx.mapLayers.resilienceScore, true);
    assert.equal(result.ctx.initialUrlState.layers.resilienceScore, true);
  });

  it('clamps a still-pending tier once the bounded fallback is active', () => {
    const result = runInitialUrlRestore({ premium: false, resolved: false, fallback: true });
    assert.equal(result.ctx.mapLayers.resilienceScore, false);
    assert.equal(result.ctx.initialUrlState.layers.resilienceScore, false);
  });

  it('keeps a premium URL snapshot exact without consuming durable gate ownership', () => {
    gateOwnershipReads = 0;
    const sourceLayers = {
      conflicts: true,
      resilienceScore: false,
    } as unknown as MapLayers;
    const Harness = new AppSanitizeHarness();
    Harness.freeTierGate = { authSettleDeadlineExceeded: false };

    const result = Harness.sanitizeMapLayersForTier(
      sourceLayers,
      false,
      { ephemeralSnapshot: true },
    );

    assert.equal(result, sourceLayers, 'the exact URL-derived snapshot is preserved');
    assert.equal(result.conflicts, true);
    assert.equal(result.resilienceScore, false, 'durable ownership must not enable an omitted layer');
    assert.equal(gateOwnershipReads, 0, 'ephemeral Pro views must not consume ownership metadata');
  });
});
