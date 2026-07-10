import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_MAP_MODE, STORAGE_KEYS } from '../src/config/variants/base';
import {
  getStoredMapModePreference,
  normalizeMapModePreference,
} from '../src/services/map-mode-preference';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const readSrc = (relPath: string) => readFileSync(resolve(root, relPath), 'utf-8');

describe('default map mode', () => {
  it('defaults fresh sessions to the new 2D map preference at runtime', () => {
    const seen: Array<{ key: string; fallback: string }> = [];
    const load = <T>(key: string, fallback: T): T => {
      seen.push({ key, fallback: String(fallback) });
      return fallback;
    };

    assert.equal(DEFAULT_MAP_MODE, 'flat');
    assert.equal(getStoredMapModePreference(load), 'flat');
    assert.deepEqual(seen, [{ key: STORAGE_KEYS.mapMode, fallback: 'flat' }]);
  });

  it('preserves an explicit globe preference but normalizes unknown values to the new 2D map', () => {
    const loadValue = (value: string) => <T>(_key: string, _fallback: T): T => value as T;

    assert.equal(normalizeMapModePreference('flat'), 'flat');
    assert.equal(normalizeMapModePreference('globe'), 'globe');
    assert.equal(normalizeMapModePreference('legacy-2d'), 'flat');
    assert.equal(getStoredMapModePreference(loadValue('flat')), 'flat');
    assert.equal(getStoredMapModePreference(loadValue('globe')), 'globe');
  });

  it('routes App and PanelLayout through the shared preference helper', () => {
    const panelLayout = readSrc('src/app/panel-layout.ts');
    const app = readSrc('src/App.ts');

    assert.match(panelLayout, /getStoredMapModePreference\(\) === 'globe'/);
    assert.match(app, /const mode = getStoredMapModePreference\(\)/);

    assert.doesNotMatch(
      `${panelLayout}\n${app}`,
      /loadFromStorage<string>\(\s*STORAGE_KEYS\.mapMode\s*,\s*['"]globe['"]\s*\)/,
      'map mode callers must not reintroduce the 3D globe fallback',
    );
  });

  it('routes the default desktop flat preference to DeckGL when supported, not the SVG fallback', () => {
    const mapContainer = readSrc('src/components/MapContainer.ts');

    assert.match(
      mapContainer,
      /this\.useDeckGL\s*=\s*!this\.useGlobe\s*&&\s*this\.shouldUseDeckGL\(\)/,
      'flat mode should select DeckGL when the capability gate passes',
    );
    assert.match(
      mapContainer,
      /createDeckGLMap\(token: number\)[\s\S]*Initializing deck\.gl map \(desktop mode\)[\s\S]*await loadMapLibreCss\(\)[\s\S]*await import\('\.\/DeckGLMap'\)/,
      'DeckGL should be the primary non-globe desktop renderer and load its runtime on demand',
    );
    assert.match(
      mapContainer,
      /else if \(this\.useDeckGL\)\s*{\s*const shouldLoadDeck = await this\.waitForDeckRendererDemand\(token\);\s*if \(!shouldLoadDeck \|\| !this\.isCurrentRendererInit\(token\)\) return;\s*await this\.createDeckGLMap\(token\);/m,
      'flat desktop mode should route through the demand-gated deferred DeckGL initializer',
    );
    assert.match(
      mapContainer,
      /DeckGL initialization failed[\s\S]*Initializing SVG map \(DeckGL fallback mode\)/,
      'SVG should stay a DeckGL failure fallback, not the default 2D renderer',
    );
  });

  it('does not require the stricter deck.gl WebGL2 gate before selecting globe mode', () => {
    const mapContainer = readSrc('src/components/MapContainer.ts');

    assert.match(
      mapContainer,
      /this\.useGlobe\s*=\s*preferGlobe\s*&&\s*this\.hasGlobeSupport\(\)/,
      'globe mode should use its own capability check',
    );
    assert.match(
      mapContainer,
      /hasGlobeSupport\(\)[\s\S]*canvas\.getContext\('webgl2'\)[\s\S]*canvas\.getContext\('webgl'\)[\s\S]*canvas\.getContext\('experimental-webgl'\)/,
      'globe support should accept WebGL1-capable browsers used by screenshot automation',
    );
    assert.match(
      mapContainer,
      /shouldUseDeckGL\(\)[\s\S]*this\.hasWebGLSupport\(\)/,
      'deck.gl should keep the stricter WebGL2 capability gate',
    );
  });

  it('falls back to SVG if asynchronous GlobeMap initialization fails', () => {
    const mapContainer = readSrc('src/components/MapContainer.ts');
    const globeMap = readSrc('src/components/GlobeMap.ts');

    assert.match(
      globeMap,
      /onInitError\?: \(error: unknown\) => void/,
      'GlobeMap should expose async initialization failures to its owner',
    );
    assert.match(
      globeMap,
      /options\.onInitError\?\.\(err\)/,
      'GlobeMap init catch must notify MapContainer',
    );
    assert.match(
      mapContainer,
      /handleGlobeInitFailure\(token: number, error: unknown\)[\s\S]*globe fallback mode[\s\S]*this\.rehydrateActiveMap\(\)/,
      'MapContainer should recover failed globe startup with SVG fallback and replay cached data',
    );
    assert.match(
      mapContainer,
      /token !== this\.globeInitToken \|\| !this\.useGlobe/,
      'stale globe init failures must not replace a newer map mode',
    );
  });
});
