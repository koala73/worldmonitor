import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const readSrc = (relPath) => readFileSync(resolve(root, relPath), 'utf-8');

describe('default map mode', () => {
  it('defaults fresh sessions to the globe renderer', () => {
    const baseConfig = readSrc('src/config/variants/base.ts');

    assert.match(
      baseConfig,
      /export const DEFAULT_MAP_MODE:\s*MapModePreference\s*=\s*'globe';/,
      'missing map-mode preferences should resolve to the globe renderer',
    );
  });

  it('uses the shared default for initial render and storage sync fallbacks', () => {
    const panelLayout = readSrc('src/app/panel-layout.ts');
    const app = readSrc('src/App.ts');

    assert.match(panelLayout, /loadFromStorage<string>\(STORAGE_KEYS\.mapMode,\s*DEFAULT_MAP_MODE\)/);
    assert.match(app, /loadFromStorage<string>\(STORAGE_KEYS\.mapMode,\s*DEFAULT_MAP_MODE\)/);

    assert.doesNotMatch(
      `${panelLayout}\n${app}`,
      /loadFromStorage<string>\(STORAGE_KEYS\.mapMode,\s*'flat'\)/,
      'map mode callers must not reintroduce the old flat-map fallback',
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
});
