import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createBrowserEnvironment } from './helpers/runtime-config-panel-harness.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

type Snapshot = { exists: boolean; value: unknown };

function snapshotGlobal(name: string): Snapshot {
  return {
    exists: Object.prototype.hasOwnProperty.call(globalThis, name),
    value: (globalThis as Record<string, unknown>)[name],
  };
}

function restoreGlobal(name: string, snapshot: Snapshot): void {
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

async function flushAsyncWork(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await new Promise(resolve => setTimeout(resolve, 0));
  }
}

async function waitForPanelContentDebounce(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 180));
}

function makeMutationObserverStub() {
  class StubMutationObserver {
    callback: () => void;
    disconnectCount = 0;
    observeArgs: Array<{ target: unknown; options: unknown }> = [];
    constructor(cb: () => void) {
      this.callback = cb;
      instances.push(this);
    }
    observe(target: unknown, options: unknown): void {
      this.observeArgs.push({ target, options });
    }
    disconnect(): void {
      this.disconnectCount += 1;
    }
    takeRecords(): [] {
      return [];
    }
    // Simulate the browser delivering a mutation notification.
    trigger(): void {
      this.callback();
    }
  }
  const instances: StubMutationObserver[] = [];
  return { instances, Ctor: StubMutationObserver };
}

async function loadNationalDebtPanel() {
  const tempDir = mkdtempSync(join(tmpdir(), 'wm-national-debt-panel-'));
  const outfile = join(tempDir, 'NationalDebtPanel.bundle.mjs');
  const panelPath = resolve(root, 'src/components/NationalDebtPanel.ts').replace(/\\/g, '/');
  const virtualEntrySource = `
    import { NationalDebtPanel } from '${panelPath}';
    export { NationalDebtPanel };
  `;

  const stubModules = new Map([
    ['virtual-entry', virtualEntrySource],
    ['economic-stub', `
      export async function getNationalDebtData() {
        const resp = await globalThis.fetch('/api/bootstrap?keys=nationalDebt');
        const payload = await resp.json();
        return payload.data.nationalDebt;
      }
    `],
    ['i18n-stub', `
      export function t(key, options = {}) {
        return typeof options.defaultValue === 'string' ? options.defaultValue : key;
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
    ['dom-utils-stub', `
      function append(parent, child) {
        if (child == null || child === false) return;
        if (Array.isArray(child)) {
          for (const item of child) append(parent, item);
          return;
        }
        parent.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
      }
      export function h(tag, propsOrChild, ...children) {
        const el = document.createElement(tag);
        let allChildren = children;
        if (propsOrChild && typeof propsOrChild === 'object' && !(propsOrChild instanceof Node)) {
          for (const [key, value] of Object.entries(propsOrChild)) {
            if (value == null || value === false) continue;
            if (key === 'className') el.className = String(value);
            else if (key === 'dataset') Object.assign(el.dataset, value);
            else if (key === 'style' && typeof value === 'object') Object.assign(el.style, value);
            else if (key === 'style') el.setAttribute('style', String(value));
            else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
            else if (value === true) el.setAttribute(key, '');
            else el.setAttribute(key, String(value));
          }
        } else {
          allChildren = [propsOrChild, ...children];
        }
        for (const child of allChildren) append(el, child);
        return el;
      }
      export function replaceChildren(el, ...children) {
        while (el.lastChild) el.removeChild(el.lastChild);
        for (const child of children) append(el, child);
      }
      export function trustedHtml(html, reason) {
        if (!String(reason || '').trim()) throw new Error('trustedHtml() requires an audit reason');
        return String(html);
      }
      export function setTrustedHtml(el, html) { el.innerHTML = String(html); }
      export function safeHtml(html) {
        const span = document.createElement('span');
        span.textContent = String(html);
        return span;
      }
    `],
  ]);

  const aliasMap = new Map([
    ['virtual:national-debt-entry', 'virtual-entry'],
    ['@/services/economic', 'economic-stub'],
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
    ['@/utils/dom-utils', 'dom-utils-stub'],
    ['../utils/dom-utils', 'dom-utils-stub'],
  ]);

  const plugin = {
    name: 'national-debt-panel-test-stubs',
    setup(buildApi: import('esbuild').PluginBuild) {
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
    entryPoints: [{ in: 'virtual:national-debt-entry', out: 'NationalDebtPanel.bundle' }],
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
    NationalDebtPanel: mod.NationalDebtPanel as typeof import('../src/components/NationalDebtPanel').NationalDebtPanel,
    cleanupBundle() {
      rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

describe('NationalDebtPanel detached refresh', () => {
  const originalGlobals: Record<string, Snapshot> = {};
  let cleanupBundle: (() => void) | null = null;
  let rafQueue: FrameRequestCallback[] = [];
  let fetchCount = 0;

  beforeEach(() => {
    for (const name of [
      'document',
      'window',
      'localStorage',
      'requestAnimationFrame',
      'cancelAnimationFrame',
      'navigator',
      'HTMLElement',
      'HTMLButtonElement',
      'Node',
      'fetch',
      'MutationObserver',
    ]) {
      originalGlobals[name] = snapshotGlobal(name);
    }

    const browserEnvironment = createBrowserEnvironment();
    const MiniNode = Object.getPrototypeOf(browserEnvironment.HTMLElement.prototype).constructor;
    rafQueue = [];
    fetchCount = 0;

    defineGlobal('document', browserEnvironment.document);
    defineGlobal('window', browserEnvironment.window);
    defineGlobal('localStorage', browserEnvironment.localStorage);
    defineGlobal('navigator', browserEnvironment.window.navigator);
    defineGlobal('HTMLElement', browserEnvironment.HTMLElement);
    defineGlobal('HTMLButtonElement', browserEnvironment.HTMLButtonElement);
    defineGlobal('Node', MiniNode);
    defineGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      rafQueue.push(cb);
      return rafQueue.length;
    });
    defineGlobal('cancelAnimationFrame', () => {});
    defineGlobal('fetch', async (url: string) => {
      if (String(url).includes('/api/bootstrap?keys=nationalDebt')) {
        fetchCount += 1;
      }
      return new Response(JSON.stringify({
        data: {
          nationalDebt: {
            entries: [{
              iso3: 'USA',
              debtUsd: 34_000_000_000_000,
              perSecondRate: 1,
              baselineTs: Date.now(),
              debtToGdp: 120,
              annualGrowth: 3,
              source: 'test',
            }],
            seededAt: new Date().toISOString(),
          },
        },
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
  });

  afterEach(() => {
    cleanupBundle?.();
    cleanupBundle = null;
    for (const [name, snapshot] of Object.entries(originalGlobals)) {
      restoreGlobal(name, snapshot);
      delete originalGlobals[name];
    }
  });

  it('retries on a bounded number of frames while detached without ever fetching', async () => {
    const loaded = await loadNationalDebtPanel();
    cleanupBundle = loaded.cleanupBundle;
    const panel = new loaded.NationalDebtPanel();

    assert.equal(panel.getElement().isConnected, false, 'precondition: panel starts detached');
    await panel.refresh();

    // Drain well past the retry cap; the element never connects.
    let framesRun = 0;
    for (let i = 0; i < 20; i++) {
      const callbacks = rafQueue.splice(0);
      for (const cb of callbacks) {
        framesRun += 1;
        cb(performance.now());
      }
      await Promise.resolve();
    }

    assert.equal(fetchCount, 0, 'a detached refresh must never hit the network');
    assert.ok(framesRun > 1, 'fallback should retry across frames, not give up after a single frame');
    assert.equal(rafQueue.length, 0, 'bounded retry must stop scheduling once the cap is reached (no infinite loop)');

    panel.destroy();
  });

  it('loads once after the lazy panel element connects', async () => {
    const loaded = await loadNationalDebtPanel();
    cleanupBundle = loaded.cleanupBundle;
    const panel = new loaded.NationalDebtPanel();

    try {
      await panel.refresh();
      assert.equal(fetchCount, 0, 'detached refresh should not fetch before insertion');

      document.body.appendChild(panel.getElement());
      const callbacks = rafQueue.splice(0);
      for (const cb of callbacks) {
        cb(performance.now());
      }
      await flushAsyncWork();
      await waitForPanelContentDebounce();

      assert.equal(fetchCount, 1, 'connected retry should issue exactly one nationalDebt bootstrap request');
      const content = panel.getElement().querySelector('.panel-content');
      assert.ok(content, 'panel content node should exist');
      assert.match(
        content.innerHTML,
        /World Debt/,
        'connected retry should render the populated debt panel',
      );
    } finally {
      panel.destroy();
    }
  });

  it('refreshes once via MutationObserver when the element connects, then disconnects', async () => {
    const { instances, Ctor } = makeMutationObserverStub();
    defineGlobal('MutationObserver', Ctor);

    const loaded = await loadNationalDebtPanel();
    cleanupBundle = loaded.cleanupBundle;
    const panel = new loaded.NationalDebtPanel();

    await panel.refresh();
    assert.equal(instances.length, 1, 'a connection observer is registered while detached');
    assert.equal(instances[0].observeArgs.length, 1, 'observer begins observing for the connection');
    assert.equal(fetchCount, 0, 'no fetch while the element is detached');

    document.body.appendChild(panel.getElement());
    instances[0].trigger();
    await flushAsyncWork();
    await waitForPanelContentDebounce();

    assert.equal(fetchCount, 1, 'connecting triggers exactly one nationalDebt fetch via the observer');
    assert.equal(instances[0].disconnectCount, 1, 'observer disconnects itself after the element connects');

    instances[0].trigger();
    await flushAsyncWork();
    assert.equal(fetchCount, 1, 'a later mutation does not refetch (freshness guard holds)');

    panel.destroy();
  });

  it('disconnects the connection observer on destroy() while still detached', async () => {
    const { instances, Ctor } = makeMutationObserverStub();
    defineGlobal('MutationObserver', Ctor);

    const loaded = await loadNationalDebtPanel();
    cleanupBundle = loaded.cleanupBundle;
    const panel = new loaded.NationalDebtPanel();

    await panel.refresh();
    assert.equal(instances.length, 1, 'observer registered while detached');
    assert.equal(instances[0].disconnectCount, 0, 'observer stays active until connect or destroy');

    panel.destroy();
    assert.equal(instances[0].disconnectCount, 1, 'destroy() disconnects the active connection observer');
    assert.equal(fetchCount, 0, 'destroying a detached panel never fetches');
  });
});
