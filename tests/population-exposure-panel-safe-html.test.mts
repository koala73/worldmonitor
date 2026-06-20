import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { after, describe, it } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createBrowserEnvironment } from './helpers/runtime-config-panel-harness.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tempDir = mkdtempSync(join(tmpdir(), 'wm-population-exposure-panel-'));
const outfile = join(tempDir, 'PopulationExposurePanel.bundle.mjs');

async function loadPopulationExposurePanel() {
  const stubModules = new Map<string, string>([
    ['i18n-stub', `export function t(key, params) {
      if (key === 'components.populationExposure.affectedCount') return params.count + ' affected';
      if (key === 'components.populationExposure.radiusKm') return params.km + ' km radius';
      return key;
    }`],
    ['runtime-stub', `export function isDesktopRuntime() { return false; }`],
    ['tauri-bridge-stub', `export function invokeTauri() { return Promise.reject(new Error('not wired in test')); }`],
    ['analytics-stub', `export function trackPanelResized() {}`],
    ['ai-flow-settings-stub', `export function getAiFlowSettings() { return { badgeAnimation: false }; }`],
    ['runtime-config-stub', `export function getSecretState() { return { present: true }; }`],
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
    ['panel-gating-stub', `
      export const PanelGateReason = Object.freeze({
        NONE: 'none',
        ANONYMOUS: 'anonymous',
        FREE_TIER: 'free_tier',
      });
    `],
    ['checkout-stub', `export function startCheckout() {}`],
    ['products-stub', `export const DEFAULT_UPGRADE_PRODUCT = 'pro';`],
  ]);

  const aliasMap = new Map<string, string>([
    ['@/services/i18n', 'i18n-stub'],
    ['../services/i18n', 'i18n-stub'],
    ['@/services/runtime', 'runtime-stub'],
    ['../services/runtime', 'runtime-stub'],
    ['@/services/tauri-bridge', 'tauri-bridge-stub'],
    ['../services/tauri-bridge', 'tauri-bridge-stub'],
    ['@/services/analytics', 'analytics-stub'],
    ['@/services/ai-flow-settings', 'ai-flow-settings-stub'],
    ['@/services/runtime-config', 'runtime-config-stub'],
    ['../utils/dom-utils', 'dom-utils-stub'],
    ['@/utils/dom-utils', 'dom-utils-stub'],
    ['@/services/panel-gating', 'panel-gating-stub'],
    ['@/services/checkout', 'checkout-stub'],
    ['@/config/products', 'products-stub'],
  ]);

  const plugin = {
    name: 'population-exposure-panel-test-stubs',
    setup(buildApi: import('esbuild').PluginBuild) {
      buildApi.onResolve({ filter: /.*/ }, (args) => {
        const target = aliasMap.get(args.path);
        return target ? { path: target, namespace: 'stub' } : null;
      });

      buildApi.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => ({
        contents: stubModules.get(args.path),
        loader: 'ts' as const,
        resolveDir: repoRoot,
      }));
    },
  };

  const result = await build({
    entryPoints: [resolve(repoRoot, 'src/components/PopulationExposurePanel.ts')],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2020',
    write: false,
    plugins: [plugin],
  });

  writeFileSync(outfile, result.outputFiles[0].text, 'utf8');
  return import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
}

function snapshotGlobal(name: string) {
  return {
    exists: Object.prototype.hasOwnProperty.call(globalThis, name),
    value: (globalThis as Record<string, unknown>)[name],
  };
}

function restoreGlobal(name: string, snapshot: { exists: boolean; value: unknown }) {
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

function defineGlobal(name: string, value: unknown) {
  Object.defineProperty(globalThis, name, {
    configurable: true,
    writable: true,
    value,
  });
}

const originalGlobals = {
  document: snapshotGlobal('document'),
  window: snapshotGlobal('window'),
  localStorage: snapshotGlobal('localStorage'),
  requestAnimationFrame: snapshotGlobal('requestAnimationFrame'),
  cancelAnimationFrame: snapshotGlobal('cancelAnimationFrame'),
  location: snapshotGlobal('location'),
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
defineGlobal('location', {
  ...browserEnvironment.window.location,
  hostname: 'worldmonitor.test',
});
defineGlobal('navigator', browserEnvironment.window.navigator);
defineGlobal('HTMLElement', browserEnvironment.HTMLElement);
defineGlobal('HTMLButtonElement', browserEnvironment.HTMLButtonElement);
defineGlobal('Node', MiniNode);

const { PopulationExposurePanel } = await loadPopulationExposurePanel();

after(() => {
  rmSync(tempDir, { recursive: true, force: true });
  restoreGlobal('document', originalGlobals.document);
  restoreGlobal('window', originalGlobals.window);
  restoreGlobal('localStorage', originalGlobals.localStorage);
  restoreGlobal('requestAnimationFrame', originalGlobals.requestAnimationFrame);
  restoreGlobal('cancelAnimationFrame', originalGlobals.cancelAnimationFrame);
  restoreGlobal('location', originalGlobals.location);
  restoreGlobal('navigator', originalGlobals.navigator);
  restoreGlobal('HTMLElement', originalGlobals.HTMLElement);
  restoreGlobal('HTMLButtonElement', originalGlobals.HTMLButtonElement);
  restoreGlobal('Node', originalGlobals.Node);
});

describe('PopulationExposurePanel safe HTML rendering', () => {
  it('escapes event names when rendering safeHtml template content', async () => {
    const panel = new PopulationExposurePanel();

    panel.setExposures([{
      eventId: 'evt-1',
      eventName: 'R&D <alert>',
      eventType: 'conflict',
      lat: 0,
      lon: 0,
      exposedPopulation: 125_000,
      exposureRadiusKm: 25,
    }]);

    await new Promise((resolve) => setTimeout(resolve, 180));

    const content = panel.getElement().querySelector('.panel-content');
    assert.ok(content, 'panel content node should exist');
    assert.match(content.innerHTML, /R&amp;D &lt;alert&gt;/);
    assert.doesNotMatch(content.innerHTML, /R&D <alert>/);

    panel.destroy();
  });
});
