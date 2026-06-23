// Bundles a tiny `extends Panel` subclass with no constructor-only-UI
// override, so tests can prove the BASE-CLASS unlock-restore behavior
// without depending on any specific premium panel's implementation.
//
// Mirrors the structure of chat-analyst-panel-harness.mjs (same stubs,
// same browser-environment shim) but the esbuild entry is a virtual
// in-memory file rather than a real source file.

import { build } from 'esbuild';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createBrowserEnvironment } from './runtime-config-panel-harness.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..', '..');

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

async function loadMinimalPanel() {
  const tempDir = mkdtempSync(join(tmpdir(), 'wm-minimal-panel-'));
  const outfile = join(tempDir, 'MinimalPanel.bundle.mjs');

  // Virtual entry source — defines a minimal `extends Panel` subclass that
  // builds its UI ONCE in the constructor (the exact shape that triggers
  // the unlock-wipe bug). Imports the REAL Panel base class so the test
  // exercises the actual unlock/restore code path.
  const panelImportPath = resolve(root, 'src/components/Panel.ts').replace(/\\/g, '/');
  const domUtilsPath = resolve(root, 'src/utils/dom-utils.ts').replace(/\\/g, '/');
  const dataFreshnessPath = resolve(root, 'src/services/data-freshness.ts').replace(/\\/g, '/');
  const virtualEntrySource = `
    import { Panel } from '${panelImportPath}';
    import { h, replaceChildren } from '${domUtilsPath}';
    import { dataFreshness } from '${dataFreshnessPath}';

    export { dataFreshness };

    // Module-level counter so a test can prove the ctor (and thus the
    // initial DOM build) runs ONLY ONCE per panel instance — the whole
    // point of base-class restore is to avoid rebuilding.
    export let constructorRunCount = 0;
    export function resetConstructorRunCount() { constructorRunCount = 0; }

    export class MinimalConstructorOnlyPanel extends Panel {
      static MARKER_CLASS = 'minimal-test-wrapper';
      static INPUT_CLASS = 'minimal-test-input';

      constructor(options = {}) {
        super({
          id: options.id ?? 'minimal-test',
          title: options.title ?? 'Minimal Test',
          collapsible: options.collapsible,
          defaultRowSpan: options.defaultRowSpan,
          className: options.className,
        });
        constructorRunCount += 1;
        // Build UI ONCE — no buildUI() method, no override of unlockPanel.
        // This mirrors DeductionPanel's shape (src/components/DeductionPanel.ts:30-77).
        const input = h('textarea', { className: MinimalConstructorOnlyPanel.INPUT_CLASS });
        const wrapper = h('div', { className: MinimalConstructorOnlyPanel.MARKER_CLASS }, input);
        replaceChildren(this.content, wrapper);
      }
    }

    export class FreshnessMappedPanel extends Panel {
      constructor() {
        super({ id: 'polymarket', title: 'Mapped Freshness', showCount: true, closable: true, collapsible: true });
      }

      publicDataBadge(state, detail) {
        this.setDataBadge(state, detail);
      }
    }
  `;

  const stubModules = new Map([
    ['i18n-stub', `
      function interpolate(value, options = {}) {
        return String(value).replace(/\\{\\{\\s*([\\w.]+)\\s*\\}\\}/g, (_, key) => String(options[key] ?? ''));
      }
      export function t(key, options = {}) {
        if (typeof options.defaultValue === 'string') return interpolate(options.defaultValue, options);
        return key;
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
    ['virtual-entry', virtualEntrySource],
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
    ['@/config/products', 'products-stub'],
    ['@/utils/theme-colors', 'theme-colors-stub'],
    ['virtual:minimal-entry', 'virtual-entry'],
  ]);

  const plugin = {
    name: 'minimal-panel-test-stubs',
    setup(buildApi) {
      buildApi.onResolve({ filter: /.*/ }, (args) => {
        const target = aliasMap.get(args.path);
        return target ? { path: target, namespace: 'stub' } : null;
      });

      buildApi.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => ({
        contents: stubModules.get(args.path),
        loader: 'ts',
        resolveDir: root,
      }));
    },
  };

  const result = await build({
    entryPoints: [{ in: 'virtual:minimal-entry', out: 'MinimalPanel.bundle' }],
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
    MinimalConstructorOnlyPanel: mod.MinimalConstructorOnlyPanel,
    FreshnessMappedPanel: mod.FreshnessMappedPanel,
    dataFreshness: mod.dataFreshness,
    getConstructorRunCount: () => mod.constructorRunCount,
    resetConstructorRunCount: mod.resetConstructorRunCount,
    cleanupBundle() {
      rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

export async function createMinimalPanelHarness() {
  const originalGlobals = {
    document: snapshotGlobal('document'),
    window: snapshotGlobal('window'),
    localStorage: snapshotGlobal('localStorage'),
    requestAnimationFrame: snapshotGlobal('requestAnimationFrame'),
    cancelAnimationFrame: snapshotGlobal('cancelAnimationFrame'),
    navigator: snapshotGlobal('navigator'),
    HTMLElement: snapshotGlobal('HTMLElement'),
    HTMLButtonElement: snapshotGlobal('HTMLButtonElement'),
    Node: snapshotGlobal('Node'),
  };
  const browserEnvironment = createBrowserEnvironment();
  const MiniNode = Object.getPrototypeOf(browserEnvironment.HTMLElement.prototype).constructor;

  defineGlobal('document', browserEnvironment.document);
  defineGlobal('window', browserEnvironment.window);
  defineGlobal('localStorage', browserEnvironment.localStorage);
  defineGlobal('requestAnimationFrame', browserEnvironment.requestAnimationFrame);
  defineGlobal('cancelAnimationFrame', browserEnvironment.cancelAnimationFrame);
  defineGlobal('navigator', browserEnvironment.window.navigator);
  defineGlobal('HTMLElement', browserEnvironment.HTMLElement);
  defineGlobal('HTMLButtonElement', browserEnvironment.HTMLButtonElement);
  defineGlobal('Node', MiniNode);

  let MinimalConstructorOnlyPanel;
  let FreshnessMappedPanel;
  let dataFreshness;
  let getConstructorRunCount;
  let resetConstructorRunCount;
  let cleanupBundle;
  try {
    ({
      MinimalConstructorOnlyPanel,
      FreshnessMappedPanel,
      dataFreshness,
      getConstructorRunCount,
      resetConstructorRunCount,
      cleanupBundle,
    } = await loadMinimalPanel());
  } catch (error) {
    restoreGlobal('document', originalGlobals.document);
    restoreGlobal('window', originalGlobals.window);
    restoreGlobal('localStorage', originalGlobals.localStorage);
    restoreGlobal('requestAnimationFrame', originalGlobals.requestAnimationFrame);
    restoreGlobal('cancelAnimationFrame', originalGlobals.cancelAnimationFrame);
    restoreGlobal('navigator', originalGlobals.navigator);
    restoreGlobal('HTMLElement', originalGlobals.HTMLElement);
    restoreGlobal('HTMLButtonElement', originalGlobals.HTMLButtonElement);
    restoreGlobal('Node', originalGlobals.Node);
    throw error;
  }

  return {
    document: browserEnvironment.document,
    window: browserEnvironment.window,
    localStorage: browserEnvironment.localStorage,
    createPanel: (options) => new MinimalConstructorOnlyPanel(options),
    createFreshnessPanel: () => new FreshnessMappedPanel(),
    dataFreshness,
    getConstructorRunCount,
    resetConstructorRunCount,
    cleanup() {
      cleanupBundle();
      restoreGlobal('document', originalGlobals.document);
      restoreGlobal('window', originalGlobals.window);
      restoreGlobal('localStorage', originalGlobals.localStorage);
      restoreGlobal('requestAnimationFrame', originalGlobals.requestAnimationFrame);
      restoreGlobal('cancelAnimationFrame', originalGlobals.cancelAnimationFrame);
      restoreGlobal('navigator', originalGlobals.navigator);
      restoreGlobal('HTMLElement', originalGlobals.HTMLElement);
      restoreGlobal('HTMLButtonElement', originalGlobals.HTMLButtonElement);
      restoreGlobal('Node', originalGlobals.Node);
    },
  };
}
