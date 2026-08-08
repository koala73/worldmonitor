import { build } from 'esbuild';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createBrowserEnvironment } from './mini-dom.mts';

export { createBrowserEnvironment };

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..', '..');
const entry = resolve(root, 'src/components/RuntimeConfigPanel.ts');

function snapshotGlobal(name) {
  return {
    exists: Object.prototype.hasOwnProperty.call(globalThis, name),
    value: globalThis[name],
  };
}

function restoreGlobal(name, snapshot) {
  if (snapshot.exists) {
    globalThis[name] = snapshot.value;
    return;
  }
  delete globalThis[name];
}

function createRuntimeState() {
  return {
    features: [],
    availableIds: new Set(),
    configuredCount: 0,
    listeners: new Set(),
  };
}

async function loadRuntimeConfigPanel() {
  const tempDir = mkdtempSync(join(tmpdir(), 'wm-runtime-config-panel-'));
  const outfile = join(tempDir, 'RuntimeConfigPanel.bundle.mjs');

  const stubModules = new Map([
    ['runtime-config-stub', `
      const state = globalThis.__wmRuntimeConfigPanelTestState;

      export const RUNTIME_FEATURES = state.features;

      export function getEffectiveSecrets() {
        return [];
      }

      export function getRuntimeConfigSnapshot() {
        const secrets = Object.fromEntries(
          Array.from({ length: state.configuredCount }, (_, index) => [
            'SECRET_' + (index + 1),
            { value: 'set', source: 'vault' },
          ]),
        );
        return { featureToggles: {}, secrets };
      }

      export function getSecretState() {
        return { present: false, valid: false, source: 'missing' };
      }

      export function isFeatureAvailable(featureId) {
        return state.availableIds.has(featureId);
      }

      export function isFeatureEnabled() {
        return true;
      }

      export function setFeatureToggle() {}

      export async function setSecretValue() {}

      export function subscribeRuntimeConfig(listener) {
        state.listeners.add(listener);
        return () => state.listeners.delete(listener);
      }

      export function validateSecret() {
        return { valid: true };
      }

      export async function verifySecretWithApi() {
        return { valid: true };
      }
    `],
    ['runtime-stub', `export function isDesktopRuntime() { return true; }`],
    ['tauri-bridge-stub', `export async function invokeTauri() {}`],
    ['i18n-stub', `export function t(key) { return key; }`],
    ['dom-utils-stub', `
      function append(parent, child) {
        if (child == null || child === false) return;
        if (typeof child === 'string' || typeof child === 'number') {
          parent.appendChild(document.createTextNode(String(child)));
          return;
        }
        parent.appendChild(child);
      }

      export function h(tag, propsOrChild, ...children) {
        const el = document.createElement(tag);
        let allChildren = children;

        if (
          propsOrChild != null &&
          typeof propsOrChild === 'object' &&
          !('tagName' in propsOrChild) &&
          !('textContent' in propsOrChild)
        ) {
          for (const [key, value] of Object.entries(propsOrChild)) {
            if (value == null || value === false) continue;
            if (key === 'className') {
              el.className = value;
            } else if (key === 'style' && typeof value === 'object') {
              Object.assign(el.style, value);
            } else if (key === 'dataset' && typeof value === 'object') {
              Object.assign(el.dataset, value);
            } else if (key.startsWith('on') && typeof value === 'function') {
              el.addEventListener(key.slice(2).toLowerCase(), value);
            } else if (value === true) {
              el.setAttribute(key, '');
            } else {
              el.setAttribute(key, String(value));
            }
          }
        } else {
          allChildren = [propsOrChild, ...children];
        }

        allChildren.forEach((child) => append(el, child));
        return el;
      }

      export function replaceChildren(el, ...children) {
        el.innerHTML = '';
        children.forEach((child) => append(el, child));
      }

      export function trustedHtml(html) {
        return String(html ?? '');
      }

      export function setTrustedHtml(el, html) {
        el.innerHTML = String(html ?? '');
      }

      export function safeHtml() {
        return document.createDocumentFragment();
      }
    `],
    ['analytics-stub', `export function trackPanelResized() {} export function trackFeatureToggle() {}`],
    ['ai-flow-settings-stub', `export function getAiFlowSettings() { return { badgeAnimation: false }; }`],
    ['sanitize-stub', `
      export function escapeHtml(value) { return String(value); }
      export function safeHtmlToString(value) { return String(value ?? ''); }
    `],
    ['ollama-models-stub', `export async function fetchOllamaModels() { return []; }`],
    ['settings-constants-stub', `
      export const SIGNUP_URLS = {};
      export const PLAINTEXT_KEYS = new Set();
      export const MASKED_SENTINEL = '***';
    `],
    ['panel-gating-stub', `
      export const PanelGateReason = { NONE: 'none', ANONYMOUS: 'anonymous', UNVERIFIED: 'unverified', FREE_TIER: 'free_tier' };
      export function getPanelGateReason() { return PanelGateReason.NONE; }
    `],
    ['dodo-checkout-stub', `
      export const DodoPayments = {
        Initialize() {},
        Checkout: {
          open() {},
        },
      };
    `],
    ['dodo-empty-stub', 'export {};'],
  ]);

  const aliasMap = new Map([
    ['@/services/runtime-config', 'runtime-config-stub'],
    ['../services/runtime', 'runtime-stub'],
    ['@/services/runtime', 'runtime-stub'],
    ['../services/tauri-bridge', 'tauri-bridge-stub'],
    ['@/services/tauri-bridge', 'tauri-bridge-stub'],
    ['../services/i18n', 'i18n-stub'],
    ['@/services/i18n', 'i18n-stub'],
    ['../utils/dom-utils', 'dom-utils-stub'],
    ['@/services/analytics', 'analytics-stub'],
    ['@/services/ai-flow-settings', 'ai-flow-settings-stub'],
    ['@/utils/sanitize', 'sanitize-stub'],
    ['@/services/ollama-models', 'ollama-models-stub'],
    ['@/services/settings-constants', 'settings-constants-stub'],
    ['@/services/panel-gating', 'panel-gating-stub'],
    ['dodopayments-checkout', 'dodo-checkout-stub'],
    ['dodopayments', 'dodo-empty-stub'],
    ['@dodopayments/core', 'dodo-empty-stub'],
    ['@dodopayments/convex', 'dodo-empty-stub'],
  ]);

  const plugin = {
    name: 'runtime-config-panel-test-stubs',
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
    RuntimeConfigPanel: mod.RuntimeConfigPanel,
    cleanupBundle() {
      rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

export async function createRuntimeConfigPanelHarness() {
  const originalGlobals = {
    document: snapshotGlobal('document'),
    window: snapshotGlobal('window'),
    localStorage: snapshotGlobal('localStorage'),
    requestAnimationFrame: snapshotGlobal('requestAnimationFrame'),
    cancelAnimationFrame: snapshotGlobal('cancelAnimationFrame'),
  };
  const browserEnvironment = createBrowserEnvironment();
  const runtimeState = createRuntimeState();

  globalThis.document = browserEnvironment.document;
  globalThis.window = browserEnvironment.window;
  globalThis.localStorage = browserEnvironment.localStorage;
  globalThis.requestAnimationFrame = browserEnvironment.requestAnimationFrame;
  globalThis.cancelAnimationFrame = browserEnvironment.cancelAnimationFrame;
  globalThis.__wmRuntimeConfigPanelTestState = runtimeState;

  let RuntimeConfigPanel;
  let cleanupBundle;
  try {
    ({ RuntimeConfigPanel, cleanupBundle } = await loadRuntimeConfigPanel());
  } catch (error) {
    delete globalThis.__wmRuntimeConfigPanelTestState;
    restoreGlobal('document', originalGlobals.document);
    restoreGlobal('window', originalGlobals.window);
    restoreGlobal('localStorage', originalGlobals.localStorage);
    restoreGlobal('requestAnimationFrame', originalGlobals.requestAnimationFrame);
    restoreGlobal('cancelAnimationFrame', originalGlobals.cancelAnimationFrame);
    throw error;
  }
  const activePanels = [];

  function setRuntimeState({
    totalFeatures,
    availableFeatures,
    configuredCount,
  }) {
    runtimeState.features.splice(
      0,
      runtimeState.features.length,
      ...Array.from({ length: totalFeatures }, (_, index) => ({ id: `feature-${index + 1}` })),
    );
    runtimeState.availableIds = new Set(
      runtimeState.features.slice(0, availableFeatures).map((feature) => feature.id),
    );
    runtimeState.configuredCount = configuredCount;
  }

  function createPanel(options = { mode: 'alert' }) {
    const panel = new RuntimeConfigPanel(options);
    activePanels.push(panel);
    return panel;
  }

  function emitRuntimeConfigChange() {
    for (const listener of [...runtimeState.listeners]) {
      listener();
    }
  }

  function isHidden(panel) {
    return panel.getElement().classList.contains('hidden');
  }

  function getAlertState(panel) {
    const match = panel.content.innerHTML.match(/data-alert-state="([^"]+)"/);
    return match?.[1] ?? null;
  }

  function reset() {
    while (activePanels.length > 0) {
      activePanels.pop()?.destroy();
    }
    runtimeState.features.length = 0;
    runtimeState.availableIds = new Set();
    runtimeState.configuredCount = 0;
    runtimeState.listeners.clear();
    browserEnvironment.localStorage.clear();
  }

  function cleanup() {
    reset();
    cleanupBundle();
    delete globalThis.__wmRuntimeConfigPanelTestState;
    restoreGlobal('document', originalGlobals.document);
    restoreGlobal('window', originalGlobals.window);
    restoreGlobal('localStorage', originalGlobals.localStorage);
    restoreGlobal('requestAnimationFrame', originalGlobals.requestAnimationFrame);
    restoreGlobal('cancelAnimationFrame', originalGlobals.cancelAnimationFrame);
  }

  return {
    createPanel,
    emitRuntimeConfigChange,
    getAlertState,
    isHidden,
    reset,
    cleanup,
    setRuntimeState,
  };
}
