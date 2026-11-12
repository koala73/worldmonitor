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
    ['i18n-stub', `export function getCurrentLanguageTag() { return 'en'; }\nexport function getLocale() { return 'en'; }\nexport function t(key, params) {
      if (key === 'components.populationExposure.estimateWithin') return '~' + params.count + ' people within ' + params.km + ' km';
      if (key === 'components.populationExposure.eventCount') return params.count + ' events';
      if (key === 'components.populationExposure.coverageShown') return 'Shown: ' + params.shown + ' of ' + params.total;
      if (key === 'components.populationExposure.coverageLeftOut') return 'Left out: ' + params.imprecise + '/' + params.noEstimate + '/' + params.otherPlaces;
      return key;
    }`],
    ['scope-filter-stub', `export class PanelScopeFilter { scope = null; constructor() {} hideStrip() {} destroy() {} } export function scopeTagHtml() { return ''; } export function focusedEmptyHtml() { return ''; }`],
    ['conflict-stub', `export async function fetchUcdpEvents() { return { success: false }; }`],
    ['runtime-stub', `export function isDesktopRuntime() { return false; }`],
    ['tauri-bridge-stub', `export function invokeTauri() { return Promise.reject(new Error('not wired in test')); }\nexport function hasTauriInvokeBridge() { return false; }`],
    ['analytics-stub', `export function trackLayoutCustomized() {}`],
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
    ['./panel-scope-filter', 'scope-filter-stub'],
    ['@/services/conflict', 'conflict-stub'],
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

    const event = {
      eventId: 'evt-1',
      eventName: 'R&D <alert>',
      eventType: 'conflict',
      lat: 0,
      lon: 0,
      exposedPopulation: 125_000,
      exposureRadiusKm: 25,
      eventCount: 1,
    };
    panel.setExposures([event, { ...event, eventId: 'evt-2', eventName: 'Nearby event', lat: 0.1, eventCount: 2 }]);

    await new Promise((resolve) => setTimeout(resolve, 180));

    const content = panel.getElement().querySelector('.panel-content');
    assert.ok(content, 'panel content node should exist');
    assert.match(content.innerHTML, /R&amp;D &lt;alert&gt;/);
    assert.doesNotMatch(content.innerHTML, /R&D <alert>/);
    assert.equal(content.innerHTML.match(/~125K people within 25 km/g)?.length, 2);
    assert.doesNotMatch(content.innerHTML, /250K|affected/i);
    assert.deepEqual([...content.innerHTML.matchAll(/\d+ events/g)].map(m => m[0]), ['2 events']);

    assert.doesNotMatch(content.innerHTML, /Shown:/);

    panel.destroy();
  });

  it('shows how many feed events the rows cover and why the rest are left out', async () => {
    const panel = new PopulationExposurePanel();
    const event = {
      eventId: 'kyiv', eventName: 'Kyiv city, Ukraine', eventType: 'state-based', lat: 50.45, lon: 30.52,
      exposedPopulation: 481_000, exposureRadiusKm: 50, eventCount: 2,
    };
    panel.setExposures([event], false, { totalEvents: 2428, withoutPreciseLocation: 1232, withoutEstimate: 662, atOtherPlaces: 504 });

    await new Promise((resolve) => setTimeout(resolve, 180));

    const content = panel.getElement().querySelector('.panel-content');
    assert.ok(content, 'panel content node should exist');
    assert.match(content.innerHTML, /class="popexp-coverage"[\s\S]*Shown: 30 of 2,428[\s\S]*Left out: 1,232\/662\/504/);

    panel.destroy();
  });

  it('labels legacy locations and partial coverage as pending, including an empty unrest feed', async () => {
    const panel = new PopulationExposurePanel();
    const event = {
      eventId: 'legacy', eventName: 'Taiz, Yemen', eventType: 'state-based', lat: 13.58, lon: 44.02,
      exposedPopulation: 125_000, exposureRadiusKm: 50, eventCount: 1, locationPending: true,
    };
    for (const totalEvents of [0, 3]) {
      panel.setExposures([event], false, {
        totalEvents, withoutPreciseLocation: 0, withoutEstimate: 0, atOtherPlaces: 0, ucdpPending: true,
      });
      await new Promise((resolve) => setTimeout(resolve, 180));
      const html = panel.getElement().querySelector('.panel-content')!.innerHTML;
      assert.match(html, /Taiz, Yemen/);
      assert.match(html, /components.populationExposure.locationPending/);
      assert.match(html, /components.populationExposure.unrestCoverage/);
      assert.match(html, /components.populationExposure.ucdpPending/);
      assert.match(html, new RegExp('Shown: ' + totalEvents + ' of ' + totalEvents));
    }
    panel.destroy();
  });
});
