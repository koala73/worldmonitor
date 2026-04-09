import { build } from 'esbuild';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createBrowserEnvironment } from './runtime-config-panel-harness.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..', '..');
const entry = resolve(root, 'src/components/CountryDeepDivePanel.ts');

function snapshotGlobal(name) {
  return {
    exists: Object.prototype.hasOwnProperty.call(globalThis, name),
    value: globalThis[name],
  };
}

function restoreGlobal(name, snapshot) {
  if (snapshot.exists) {
    Object.defineProperty(globalThis, name, {
      configurable: true,
      writable: true,
      value: snapshot.value,
    });
    return;
  }
  delete globalThis[name];
}

function defineGlobal(name, value) {
  Object.defineProperty(globalThis, name, {
    configurable: true,
    writable: true,
    value,
  });
}

async function loadCountryDeepDivePanel() {
  const tempDir = mkdtempSync(join(tmpdir(), 'wm-country-deep-dive-'));
  const outfile = join(tempDir, 'CountryDeepDivePanel.bundle.mjs');

  const stubModules = new Map([
    ['feeds-stub', `
      export function getSourcePropagandaRisk() {
        return { stateAffiliated: '' };
      }
      export function getSourceTier() {
        return 2;
      }
    `],
    ['country-geometry-stub', `
      export function getCountryCentroid() {
        return null;
      }
      export const ME_STRIKE_BOUNDS = [];
    `],
    ['i18n-stub', `
      export function t(key, params) {
        if (params && typeof params.count === 'number') {
          return key + ':' + params.count;
        }
        return key;
      }
    `],
    ['related-assets-stub', `
      export function getNearbyInfrastructure() {
        return [];
      }
      export function getCountryInfrastructure() {
        return [];
      }
      export function haversineDistanceKm() {
        return 0;
      }
    `],
    ['sanitize-stub', `export function sanitizeUrl(value) { return value ?? ''; }`],
    ['intel-brief-stub', `export function formatIntelBrief(value) { return value; }`],
    ['utils-stub', `export function getCSSColor() { return '#44ff88'; }`],
    ['country-flag-stub', `export function toFlagEmoji(code, fallback = '🌍') { return code ? ':' + code + ':' : fallback; }`],
    ['ports-stub', `export const PORTS = [];`],
    ['runtime-stub', `
      export function toApiUrl(path) { return path; }
      export function isDesktopRuntime() { return false; }
      export function getConfiguredWebApiBaseUrl() { return ''; }
    `],
    ['intelligence-client-stub', `
      export class IntelligenceServiceClient {}
    `],
    ['resilience-widget-stub', `
      const state = globalThis.__wmCountryDeepDiveTestState;
      export class ResilienceWidget {
        constructor(code) {
          this.code = code;
          this.destroyCount = 0;
          this.element = document.createElement('section');
          this.element.className = 'resilience-widget-stub';
          this.element.setAttribute('data-country-code', code);
          this.element.textContent = 'Resilience ' + code;
          state.widgets.push(this);
        }
        getElement() {
          return this.element;
        }
        destroy() {
          this.destroyCount += 1;
        }
      }
    `],
  ]);

  const aliasMap = new Map([
    ['@/config/feeds', 'feeds-stub'],
    ['@/services/country-geometry', 'country-geometry-stub'],
    ['@/services/i18n', 'i18n-stub'],
    ['@/services/related-assets', 'related-assets-stub'],
    ['@/utils/sanitize', 'sanitize-stub'],
    ['@/utils/format-intel-brief', 'intel-brief-stub'],
    ['@/utils', 'utils-stub'],
    ['@/utils/country-flag', 'country-flag-stub'],
    ['@/config/ports', 'ports-stub'],
    ['./ResilienceWidget', 'resilience-widget-stub'],
    ['@/services/runtime', 'runtime-stub'],
    ['@/generated/client/worldmonitor/intelligence/v1/service_client', 'intelligence-client-stub'],
  ]);

  const plugin = {
    name: 'country-deep-dive-test-stubs',
    setup(buildApi) {
      buildApi.onResolve({ filter: /.*/ }, (args) => {
        const target = aliasMap.get(args.path);
        return target ? { path: target, namespace: 'stub' } : null;
      });

      buildApi.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => ({
        contents: stubModules.get(args.path),
        loader: 'js',
      }));
    },
  };

  const result = await build({
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2020',
    write: false,
    plugins: [plugin],
  });

  writeFileSync(outfile, result.outputFiles[0].text, 'utf8');

  const mod = await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
  return {
    CountryDeepDivePanel: mod.CountryDeepDivePanel,
    cleanupBundle() {
      rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

export async function createCountryDeepDivePanelHarness() {
  const originalGlobals = {
    document: snapshotGlobal('document'),
    window: snapshotGlobal('window'),
    localStorage: snapshotGlobal('localStorage'),
    requestAnimationFrame: snapshotGlobal('requestAnimationFrame'),
    cancelAnimationFrame: snapshotGlobal('cancelAnimationFrame'),
    navigator: snapshotGlobal('navigator'),
    HTMLElement: snapshotGlobal('HTMLElement'),
    HTMLButtonElement: snapshotGlobal('HTMLButtonElement'),
  };
  const browserEnvironment = createBrowserEnvironment();
  const state = { widgets: [] };

  defineGlobal('document', browserEnvironment.document);
  defineGlobal('window', browserEnvironment.window);
  defineGlobal('localStorage', browserEnvironment.localStorage);
  defineGlobal('requestAnimationFrame', browserEnvironment.requestAnimationFrame);
  defineGlobal('cancelAnimationFrame', browserEnvironment.cancelAnimationFrame);
  defineGlobal('navigator', browserEnvironment.window.navigator);
  defineGlobal('HTMLElement', browserEnvironment.HTMLElement);
  defineGlobal('HTMLButtonElement', browserEnvironment.HTMLButtonElement);
  globalThis.__wmCountryDeepDiveTestState = state;

  let CountryDeepDivePanel;
  let cleanupBundle;
  try {
    ({ CountryDeepDivePanel, cleanupBundle } = await loadCountryDeepDivePanel());
  } catch (error) {
    delete globalThis.__wmCountryDeepDiveTestState;
    restoreGlobal('document', originalGlobals.document);
    restoreGlobal('window', originalGlobals.window);
    restoreGlobal('localStorage', originalGlobals.localStorage);
    restoreGlobal('requestAnimationFrame', originalGlobals.requestAnimationFrame);
    restoreGlobal('cancelAnimationFrame', originalGlobals.cancelAnimationFrame);
    restoreGlobal('navigator', originalGlobals.navigator);
    restoreGlobal('HTMLElement', originalGlobals.HTMLElement);
    restoreGlobal('HTMLButtonElement', originalGlobals.HTMLButtonElement);
    throw error;
  }

  function createPanel() {
    return new CountryDeepDivePanel(null);
  }

  function getPanelRoot() {
    return browserEnvironment.document.getElementById('country-deep-dive-panel');
  }

  function cleanup() {
    cleanupBundle();
    delete globalThis.__wmCountryDeepDiveTestState;
    restoreGlobal('document', originalGlobals.document);
    restoreGlobal('window', originalGlobals.window);
    restoreGlobal('localStorage', originalGlobals.localStorage);
    restoreGlobal('requestAnimationFrame', originalGlobals.requestAnimationFrame);
    restoreGlobal('cancelAnimationFrame', originalGlobals.cancelAnimationFrame);
    restoreGlobal('navigator', originalGlobals.navigator);
    restoreGlobal('HTMLElement', originalGlobals.HTMLElement);
    restoreGlobal('HTMLButtonElement', originalGlobals.HTMLButtonElement);
  }

  return {
    createPanel,
    document: browserEnvironment.document,
    getPanelRoot,
    getWidgets() {
      return state.widgets;
    },
    cleanup,
  };
}
