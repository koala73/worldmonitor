import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import type { PanelConfig } from '../src/types/index.ts';
import {
  ALL_PANELS,
  DEFAULT_MAP_LAYERS,
  VARIANT_DEFAULTS,
  getEffectivePanelConfig,
} from '../src/config/panels.ts';
import {
  LAYER_REGISTRY,
  getAllowedLayerKeys,
  type MapVariant,
} from '../src/config/map-layer-definitions.ts';
import {
  MISSION_PRESET_DISMISSED_KEY,
  MISSION_PRESET_STORAGE_KEY,
  MISSION_PRESETS,
  applyMissionPresetToState,
  clearMissionPreset,
  dismissMissionPresetPrompt,
  filterMissionLayersForRenderer,
  getMissionPreset,
  isMissionPresetPromptDismissed,
  loadStoredMissionPreset,
  resetMissionPresetState,
  saveMissionPreset,
} from '../src/services/mission-presets.ts';

class MemoryStorage {
  private store = new Map<string, string>();

  getItem(key: string): string | null {
    return this.store.has(key) ? this.store.get(key)! : null;
  }

  setItem(key: string, value: string): void {
    this.store.set(key, String(value));
  }

  removeItem(key: string): void {
    this.store.delete(key);
  }

  clear(): void {
    this.store.clear();
  }
}

const VARIANTS: MapVariant[] = ['full', 'tech', 'finance', 'commodity', 'energy', 'happy'];

const eventHandlersSource = readFileSync(new URL('../src/app/event-handlers.ts', import.meta.url), 'utf8');
const appSource = readFileSync(new URL('../src/App.ts', import.meta.url), 'utf8');
const panelLayoutSource = readFileSync(new URL('../src/app/panel-layout.ts', import.meta.url), 'utf8');

let originalLocalStorage: PropertyDescriptor | undefined;

function defineLocalStorage(value: unknown): void {
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value,
  });
}

function makePanelSettings(variant: string): Record<string, PanelConfig> {
  const settings: Record<string, PanelConfig> = {};
  for (const key of Object.keys(ALL_PANELS)) {
    settings[key] = {
      ...getEffectivePanelConfig(key, variant),
      enabled: false,
    };
  }
  settings['runtime-config'] = { name: 'Desktop Configuration', enabled: true, priority: 2 };
  settings['cw-market-note'] = { name: 'Market Note', enabled: true, priority: 3 };
  settings['mcp-risk-feed'] = { name: 'Risk Feed', enabled: false, priority: 3 };
  return settings;
}

function enabledPanelKeys(settings: Record<string, PanelConfig>): string[] {
  return Object.entries(settings)
    .filter(([, config]) => config.enabled)
    .map(([key]) => key)
    .sort();
}

function enabledWorkspacePanelKeys(settings: Record<string, PanelConfig>): string[] {
  return enabledPanelKeys(settings).filter(
    (key) => key !== 'map' && key !== 'runtime-config' && !key.startsWith('cw-') && !key.startsWith('mcp-'),
  );
}

function defaultWorkspacePanelKeys(variant: string): string[] {
  const reset = resetMissionPresetState(makePanelSettings(variant), DEFAULT_MAP_LAYERS, variant);
  return enabledWorkspacePanelKeys(reset.panelSettings);
}

beforeEach(() => {
  originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  defineLocalStorage(new MemoryStorage());
});

afterEach(() => {
  if (originalLocalStorage) {
    Object.defineProperty(globalThis, 'localStorage', originalLocalStorage);
  } else {
    delete (globalThis as { localStorage?: unknown }).localStorage;
  }
});

describe('mission preset definitions', () => {
  it('defines the five v1 role presets with stable ids', () => {
    assert.deepEqual(
      MISSION_PRESETS.map((preset) => preset.id),
      ['crisis-desk', 'supply-chain-risk', 'energy-security', 'osint-newsroom', 'macro-market-watch'],
    );
  });

  it('uses known panel and layer keys without duplicate ids', () => {
    const ids = new Set<string>();
    for (const preset of MISSION_PRESETS) {
      assert.equal(ids.has(preset.id), false, `${preset.id} is duplicated`);
      ids.add(preset.id);
      assert.ok(preset.label.length > 0, `${preset.id} needs a label`);
      assert.ok(preset.description.length > 0, `${preset.id} needs a description`);
      assert.ok(preset.panels.includes('map'), `${preset.id} must include the map panel`);
      assert.ok(preset.panels.length > 3, `${preset.id} should enable a useful panel set`);
      assert.ok(preset.layers.length > 0, `${preset.id} should enable map layers`);
      assert.equal(new Set(preset.panels).size, preset.panels.length, `${preset.id} repeats panel ids`);
      assert.equal(new Set(preset.layers).size, preset.layers.length, `${preset.id} repeats layer ids`);

      for (const panelId of preset.panels) {
        assert.ok(ALL_PANELS[panelId], `${preset.id} references unknown panel ${panelId}`);
      }
      for (const layerId of preset.layers) {
        assert.ok(LAYER_REGISTRY[layerId], `${preset.id} references unknown layer ${String(layerId)}`);
      }
    }
  });

  it('returns null for unknown preset ids', () => {
    assert.equal(getMissionPreset('missing'), null);
    assert.equal(getMissionPreset(null), null);
  });
});

describe('applyMissionPresetToState', () => {
  it('applies a coherent full-variant preset while preserving dynamic panels', () => {
    const current = makePanelSettings('full');
    const applied = applyMissionPresetToState('crisis-desk', current, DEFAULT_MAP_LAYERS, 'full');

    assert.equal(applied.preset.id, 'crisis-desk');
    assert.equal(applied.panelSettings.map?.enabled, true);
    assert.equal(applied.panelSettings['live-news']?.enabled, true);
    assert.equal(applied.panelSettings['strategic-risk']?.enabled, true);
    assert.equal(applied.panelSettings.markets?.enabled, false);
    assert.equal(applied.panelSettings['cw-market-note']?.enabled, true);
    assert.equal(applied.panelSettings['mcp-risk-feed']?.enabled, false);
    assert.deepEqual(applied.panelOrder.slice(0, 5), [
      'live-news',
      'insights',
      'strategic-posture',
      'cii',
      'strategic-risk',
    ]);
    assert.equal(applied.mapLayers.conflicts, true);
    assert.equal(applied.mapLayers.ciiChoropleth, true);
  });

  it('filters enabled panels to the active variant instead of creating mini-variants', () => {
    for (const variant of VARIANTS) {
      const allowedPanels = new Set(VARIANT_DEFAULTS[variant] ?? []);
      for (const preset of MISSION_PRESETS) {
        const applied = applyMissionPresetToState(
          preset.id,
          makePanelSettings(variant),
          DEFAULT_MAP_LAYERS,
          variant,
        );
        for (const panelId of enabledPanelKeys(applied.panelSettings)) {
          if (panelId === 'map' || panelId === 'runtime-config' || panelId.startsWith('cw-') || panelId.startsWith('mcp-')) {
            continue;
          }
          assert.ok(
            allowedPanels.has(panelId),
            `${preset.id} enabled ${panelId} outside ${variant} variant defaults`,
          );
        }
      }
    }
  });

  it('falls back to variant defaults when a preset has too few matching panels', () => {
    for (const preset of MISSION_PRESETS) {
      const applied = applyMissionPresetToState(
        preset.id,
        makePanelSettings('happy'),
        DEFAULT_MAP_LAYERS,
        'happy',
      );
      assert.deepEqual(
        enabledWorkspacePanelKeys(applied.panelSettings),
        defaultWorkspacePanelKeys('happy'),
        `happy/${preset.id} should fall back to happy defaults`,
      );
    }

    for (const [variant, presetId] of [
      ['tech', 'energy-security'],
      ['commodity', 'osint-newsroom'],
      ['energy', 'osint-newsroom'],
    ] as const) {
      const applied = applyMissionPresetToState(
        presetId,
        makePanelSettings(variant),
        DEFAULT_MAP_LAYERS,
        variant,
      );
      assert.deepEqual(
        enabledWorkspacePanelKeys(applied.panelSettings),
        defaultWorkspacePanelKeys(variant),
        `${variant}/${presetId} should fall back to ${variant} defaults`,
      );
    }
  });

  it('never applies a preset as an empty or single-panel workspace across variants', () => {
    for (const variant of VARIANTS) {
      for (const preset of MISSION_PRESETS) {
        const applied = applyMissionPresetToState(
          preset.id,
          makePanelSettings(variant),
          DEFAULT_MAP_LAYERS,
          variant,
        );
        assert.ok(
          enabledWorkspacePanelKeys(applied.panelSettings).length >= 2,
          `${variant}/${preset.id} should keep a useful workspace`,
        );
      }
    }
  });

  it('sanitizes preset layers through each variant allowlist', () => {
    for (const variant of VARIANTS) {
      const allowedLayers = getAllowedLayerKeys(variant);
      for (const preset of MISSION_PRESETS) {
        const applied = applyMissionPresetToState(
          preset.id,
          makePanelSettings(variant),
          DEFAULT_MAP_LAYERS,
          variant,
        );
        for (const [layerId, enabled] of Object.entries(applied.mapLayers)) {
          if (!enabled) continue;
          assert.ok(
            allowedLayers.has(layerId as keyof typeof LAYER_REGISTRY),
            `${preset.id} enabled layer ${layerId} outside ${variant} allowlist`,
          );
        }
      }
    }
  });
});

describe('resetMissionPresetState', () => {
  it('restores active variant defaults and preserves dynamic panels', () => {
    const current = makePanelSettings('full');
    current['live-news']!.enabled = false;
    current.markets!.enabled = true;
    current['cw-market-note']!.enabled = true;

    const reset = resetMissionPresetState(current, DEFAULT_MAP_LAYERS, 'full');

    assert.deepEqual(reset.panelOrder, VARIANT_DEFAULTS.full.filter((key) => key !== 'map'));
    assert.equal(reset.panelSettings.map?.enabled, true);
    assert.equal(reset.panelSettings['live-news']?.enabled, getEffectivePanelConfig('live-news', 'full').enabled);
    assert.equal(reset.panelSettings['energy-risk-overview']?.enabled, false);
    assert.equal(reset.panelSettings['cw-market-note']?.enabled, true);
    assert.deepEqual(reset.mapLayers, DEFAULT_MAP_LAYERS);
  });
});

describe('mission preset renderer filtering', () => {
  it('removes DeckGL-only energy layers on the mobile/SVG fallback path', () => {
    const applied = applyMissionPresetToState(
      'energy-security',
      makePanelSettings('energy'),
      DEFAULT_MAP_LAYERS,
      'energy',
    );

    assert.equal(applied.mapLayers.storageFacilities, true);
    assert.equal(applied.mapLayers.fuelShortages, true);
    assert.equal(applied.mapLayers.liveTankers, true);

    const filtered = filterMissionLayersForRenderer(applied.mapLayers, 'flat', false, DEFAULT_MAP_LAYERS);

    assert.equal(filtered.storageFacilities, false);
    assert.equal(filtered.fuelShortages, false);
    assert.equal(filtered.liveTankers, false);
    assert.ok(Object.values(filtered).some(Boolean), 'renderer filtering should keep executable context layers');
  });

  it('also filters fallback layers when every preset layer is renderer-incompatible', () => {
    const presetLayers = { ...DEFAULT_MAP_LAYERS };
    for (const key of Object.keys(presetLayers) as Array<keyof typeof presetLayers>) {
      presetLayers[key] = false;
    }
    presetLayers.storageFacilities = true;

    const fallbackLayers = { ...DEFAULT_MAP_LAYERS, storageFacilities: true };
    const filtered = filterMissionLayersForRenderer(presetLayers, 'flat', false, fallbackLayers);

    assert.equal(filtered.storageFacilities, false);
    assert.ok(Object.values(filtered).some(Boolean), 'filtered fallback should keep executable default layers');
  });
});

describe('mission preset persistence', () => {
  it('saves, loads, clears, and dismisses mission state', () => {
    assert.equal(loadStoredMissionPreset(), null);
    assert.equal(isMissionPresetPromptDismissed(), false);

    saveMissionPreset('crisis-desk');

    assert.equal(localStorage.getItem(MISSION_PRESET_STORAGE_KEY), 'crisis-desk');
    assert.equal(localStorage.getItem(MISSION_PRESET_DISMISSED_KEY), '1');
    assert.equal(loadStoredMissionPreset()?.id, 'crisis-desk');
    assert.equal(isMissionPresetPromptDismissed(), true);

    clearMissionPreset();

    assert.equal(loadStoredMissionPreset(), null);
    assert.equal(localStorage.getItem(MISSION_PRESET_STORAGE_KEY), null);
    assert.equal(isMissionPresetPromptDismissed(), true);
  });

  it('treats unknown stored ids as absent', () => {
    localStorage.setItem(MISSION_PRESET_STORAGE_KEY, 'stale');

    assert.equal(loadStoredMissionPreset(), null);
  });

  it('does not throw when storage is unavailable', () => {
    defineLocalStorage({
      getItem() { throw new Error('blocked'); },
      setItem() { throw new Error('blocked'); },
      removeItem() { throw new Error('blocked'); },
    });

    assert.doesNotThrow(() => saveMissionPreset('crisis-desk'));
    assert.doesNotThrow(() => clearMissionPreset());
    assert.doesNotThrow(() => dismissMissionPresetPrompt());
    assert.equal(loadStoredMissionPreset(), null);
    assert.equal(isMissionPresetPromptDismissed(), true);
  });
});

describe('mission preset shell integration', () => {
  it('routes mission layer diffs through the normal AIS/load/stop side effects', () => {
    assert.match(
      eventHandlersSource,
      /private runMapLayerSideEffects\(layer: keyof MapLayers, enabled: boolean\): void \{[\s\S]*if \(layer === 'ais'\)[\s\S]*initAisStream\(\);[\s\S]*disconnectAisStream\(\);[\s\S]*this\.callbacks\.loadDataForLayer\(layer\);[\s\S]*this\.callbacks\.stopLayerActivity\?\.\(layer as keyof MapLayers\);/,
    );
    assert.match(
      eventHandlersSource,
      /private applyMissionMapLayerTransitions\(previousLayers: MapLayers, nextLayers: MapLayers\): void \{[\s\S]*trackMapLayerToggle\(layer, enabled, 'programmatic'\);[\s\S]*this\.runMapLayerSideEffects\(layer, enabled\);/,
    );
    assert.equal(
      eventHandlersSource.match(/this\.applyMissionMapLayerTransitions\(previousMapLayers, mapLayers\);/g)?.length,
      2,
      'apply and reset should both run layer transition side effects',
    );
  });

  it('applies mission panel order through an in-memory path when storage is unavailable', () => {
    assert.match(eventHandlersSource, /saveToStorage\(this\.ctx\.PANEL_ORDER_KEY, panelOrder\);/);
    assert.match(eventHandlersSource, /this\.callbacks\.applySavedPanelOrder\?\.\(applied\.panelOrder\);/);
    assert.match(eventHandlersSource, /this\.callbacks\.applySavedPanelOrder\?\.\(reset\.panelOrder\);/);
    assert.match(
      appSource,
      /applySavedPanelOrder: \(panelOrder\?: string\[\]\) => this\.panelLayout\.applySavedPanelOrder\(panelOrder\),/,
    );
    assert.match(
      panelLayoutSource,
      /public applySavedPanelOrder\(panelOrder\?: string\[\]\): void \{[\s\S]*const savedOrder = \(panelOrder \?\? this\.getSavedPanelOrder\(\)\)\.filter/,
    );
    assert.match(
      panelLayoutSource,
      /this\.bottomSetMemory = panelOrder \? new Set<string>\(\) : this\.getSavedBottomSet\(\);/,
    );
  });

  it('clamps desktop mission popover positioning to the viewport', () => {
    assert.match(eventHandlersSource, /const height = Math\.min\(popover\.offsetHeight \|\| 620/);
    assert.match(eventHandlersSource, /window\.innerHeight - height - 12/);
    assert.match(eventHandlersSource, /popover\.style\.top = `\$\{top\}px`;/);
  });

  it('supports keyboard dismissal and focus for the mission dialog', () => {
    assert.match(eventHandlersSource, /private boundMissionKeydownHandler: \(\(e: KeyboardEvent\) => void\) \| null = null;/);
    assert.match(eventHandlersSource, /popover\.tabIndex = -1;/);
    assert.match(eventHandlersSource, /if \(e\.key !== 'Escape'\) return;/);
    assert.match(eventHandlersSource, /this\.closeMissionPresetPopover\(\);/);
    assert.match(eventHandlersSource, /popover\.focus\(\{ preventScroll: true \}\);/);
    assert.match(eventHandlersSource, /removeEventListener\('keydown', this\.boundMissionKeydownHandler\)/);
  });
});
