import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createBrowserEnvironment } from './helpers/runtime-config-panel-harness.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

type GlobalSnapshot = {
  exists: boolean;
  value: unknown;
};

function snapshotGlobal(name: string): GlobalSnapshot {
  return {
    exists: Object.prototype.hasOwnProperty.call(globalThis, name),
    value: (globalThis as Record<string, unknown>)[name],
  };
}

function restoreGlobal(name: string, snapshot: GlobalSnapshot): void {
  if (snapshot.exists) {
    Object.defineProperty(globalThis, name, {
      configurable: true,
      writable: true,
      value: snapshot.value,
    });
    return;
  }
  delete (globalThis as Record<string, unknown>)[name];
}

function defineGlobal(name: string, value: unknown): void {
  Object.defineProperty(globalThis, name, {
    configurable: true,
    writable: true,
    value,
  });
}

const globalNames = [
  'document',
  'window',
  'localStorage',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'navigator',
  'location',
  'HTMLElement',
  'HTMLButtonElement',
  'Node',
] as const;
const originalGlobals = Object.fromEntries(
  globalNames.map(name => [name, snapshotGlobal(name)]),
) as Record<(typeof globalNames)[number], GlobalSnapshot>;

let RenewableEnergyPanel: typeof import('../src/components/RenewableEnergyPanel.ts').RenewableEnergyPanel;
let cleanupBundle: (() => void) | null = null;

async function loadRenewableEnergyPanel() {
  const tempDir = mkdtempSync(join(tmpdir(), 'wm-renewable-panel-'));
  const outfile = join(tempDir, 'RenewableEnergyPanel.bundle.mjs');
  const panelPath = resolve(root, 'src/components/RenewableEnergyPanel.ts').replace(/\\/g, '/');
  const virtualEntrySource = `
    import { RenewableEnergyPanel } from '${panelPath}';
    export { RenewableEnergyPanel };
  `;

  const stubModules = new Map([
    ['virtual-entry', virtualEntrySource],
    ['i18n-stub', `
      const labels = {
        'common.live': 'Live',
        'common.cached': 'Cached',
        'common.unavailable': 'Unavailable',
        'components.renewable.infoTooltip': '',
      };
      export function t(key, options = {}) {
        return labels[key] ?? (typeof options.defaultValue === 'string' ? options.defaultValue : key);
      }
    `],
    ['runtime-stub', `export function isDesktopRuntime() { return false; }`],
    ['tauri-bridge-stub', `export function invokeTauri() { return Promise.reject(new Error('not wired in test')); }`],
    ['analytics-stub', `export function trackPanelResized() {}`],
    ['ai-flow-settings-stub', `export function getAiFlowSettings() { return { badgeAnimation: false }; }`],
    ['runtime-config-stub', `export function getSecretState() { return { present: true }; }`],
    ['panel-gating-stub', `
      export const PanelGateReason = Object.freeze({
        NONE: 'none',
        ANONYMOUS: 'anonymous',
        FREE_TIER: 'free_tier',
      });
    `],
    ['checkout-stub', `export function startCheckout() {}`],
    ['products-stub', `export const DEFAULT_UPGRADE_PRODUCT = 'pro';`],
    ['theme-colors-stub', `export function getCSSColor() { return '#000'; }`],
    ['persistent-cache-stub', `
      export function describeFreshness(updatedAt) {
        const hours = Math.floor(Math.max(0, Date.now() - updatedAt) / 3_600_000);
        return hours < 1 ? 'just now' : hours + 'h ago';
      }
    `],
  ]);

  const aliasMap = new Map([
    ['@/services/i18n', 'i18n-stub'],
    ['../services/i18n', 'i18n-stub'],
    ['@/services/runtime', 'runtime-stub'],
    ['../services/runtime', 'runtime-stub'],
    ['@/services/tauri-bridge', 'tauri-bridge-stub'],
    ['../services/tauri-bridge', 'tauri-bridge-stub'],
    ['@/services/analytics', 'analytics-stub'],
    ['@/services/ai-flow-settings', 'ai-flow-settings-stub'],
    ['@/services/runtime-config', 'runtime-config-stub'],
    ['@/services/panel-gating', 'panel-gating-stub'],
    ['@/services/checkout', 'checkout-stub'],
    ['@/services/persistent-cache', 'persistent-cache-stub'],
    ['@/config/products', 'products-stub'],
    ['@/utils', 'theme-colors-stub'],
    ['@/utils/theme-colors', 'theme-colors-stub'],
    ['virtual:renewable-entry', 'virtual-entry'],
  ]);

  const plugin = {
    name: 'renewable-panel-test-stubs',
    setup(buildApi: import('esbuild').PluginBuild) {
      buildApi.onResolve({ filter: /.*/ }, args => {
        const target = aliasMap.get(args.path);
        return target ? { path: target, namespace: 'stub' } : null;
      });
      buildApi.onLoad({ filter: /.*/, namespace: 'stub' }, args => ({
        contents: stubModules.get(args.path),
        loader: 'ts',
        resolveDir: root,
      }));
    },
  };

  const result = await build({
    entryPoints: [{ in: 'virtual:renewable-entry', out: 'RenewableEnergyPanel.bundle' }],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2020',
    write: false,
    plugins: [plugin],
  });

  writeFileSync(outfile, result.outputFiles[0].text, 'utf8');
  const module = await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
  return {
    RenewableEnergyPanel: module.RenewableEnergyPanel,
    cleanup() {
      rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

before(async () => {
  const browser = createBrowserEnvironment();
  const MiniNode = Object.getPrototypeOf(browser.HTMLElement.prototype).constructor;

  defineGlobal('document', browser.document);
  defineGlobal('window', browser.window);
  defineGlobal('localStorage', browser.localStorage);
  defineGlobal('requestAnimationFrame', browser.requestAnimationFrame);
  defineGlobal('cancelAnimationFrame', browser.cancelAnimationFrame);
  defineGlobal('navigator', browser.window.navigator);
  defineGlobal('location', {
    ...browser.window.location,
    hostname: 'worldmonitor.test',
    host: 'worldmonitor.test',
    protocol: 'https:',
  });
  defineGlobal('HTMLElement', browser.HTMLElement);
  defineGlobal('HTMLButtonElement', browser.HTMLButtonElement);
  defineGlobal('Node', MiniNode);

  const loaded = await loadRenewableEnergyPanel();
  RenewableEnergyPanel = loaded.RenewableEnergyPanel;
  cleanupBundle = loaded.cleanup;
});

after(() => {
  cleanupBundle?.();
  for (const name of globalNames) {
    restoreGlobal(name, originalGlobals[name]);
  }
});

describe('RenewableEnergyPanel data-state disclosure (#5497)', () => {
  it('shows unavailable and renders no chart when no last-known-good data exists', () => {
    const panel = new RenewableEnergyPanel();

    panel.setData({
      data: null,
      state: 'unavailable',
      cachedAt: null,
    });

    const element = panel.getElement();
    const badge = element.querySelector('.panel-data-badge');
    assert.ok(badge?.classList.contains('unavailable'));
    assert.equal(badge?.style.display, 'inline-flex');
    assert.equal(
      element.querySelector('.renewable-empty')?.textContent,
      'No renewable energy data available',
    );
    assert.equal(element.querySelector('.renewable-container'), null);
  });

  it('shows cache age when rendering last-known-good data', () => {
    const panel = new RenewableEnergyPanel();
    const cachedAt = Date.now() - (2 * 60 * 60 * 1000);

    panel.setData({
      data: {
        globalPercentage: 42,
        globalYear: 2024,
        historicalData: [
          { year: 2022, value: 38 },
          { year: 2023, value: 40 },
          { year: 2024, value: 42 },
        ],
        regions: [
          { code: 'EUU', name: 'European Union', percentage: 50, year: 2024 },
        ],
      },
      state: 'cached',
      cachedAt,
    });

    const element = panel.getElement();
    const badge = element.querySelector('.panel-data-badge');
    assert.ok(badge?.classList.contains('cached'));
    assert.match(badge?.textContent ?? '', /2h ago/);
    assert.ok(element.querySelector('.renewable-container'));
    assert.equal(element.querySelector('.renewable-empty'), null);
    assert.equal(element.querySelector('.gauge-value')?.textContent, '42.0%');
  });
});
