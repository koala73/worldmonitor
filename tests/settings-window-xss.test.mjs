import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const entry = resolve(root, 'src/settings-window.ts');

class FakeElement extends EventTarget {
  constructor(id = '') {
    super();
    this.id = id;
    this.dataset = {};
    this.ownerDocument = null;
    this._innerHTML = '';
  }

  get innerHTML() {
    return this._innerHTML;
  }

  set innerHTML(value) {
    this._innerHTML = String(value);
    if (this.id === 'app' && this.ownerDocument) {
      this.ownerDocument.registerElementsFromHtml(this._innerHTML);
    }
  }

  querySelectorAll() {
    return [];
  }
}

class FakeDocument {
  constructor() {
    this.title = '';
    this.elements = new Map();

    const app = new FakeElement('app');
    app.ownerDocument = this;
    this.elements.set('app', app);
  }

  getElementById(id) {
    return this.elements.get(id) ?? null;
  }

  registerElementsFromHtml(html) {
    for (const match of html.matchAll(/id="([^"]+)"/g)) {
      const id = match[1];
      if (this.elements.has(id)) continue;
      const element = new FakeElement(id);
      element.ownerDocument = this;
      this.elements.set(id, element);
    }
  }
}

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

async function loadSettingsWindowModule() {
  const tempDir = mkdtempSync(join(tmpdir(), 'wm-settings-window-'));
  const outfile = join(tempDir, 'settings-window.bundle.mjs');

  const stubModules = new Map([
    ['config-stub', `
      export const DEFAULT_PANELS = {};
      export const STORAGE_KEYS = { panels: 'wm-panels' };
      export const ALL_PANELS = {};
      export const VARIANT_DEFAULTS = { full: [] };
      export const FREE_MAX_PANELS = 40;
      export function getEffectivePanelConfig(key) {
        return { name: key, enabled: false };
      }
      export function isPanelEntitled() {
        return true;
      }
    `],
    ['widget-store-stub', `export function isProUser() { return false; }`],
    ['variant-stub', `export const SITE_VARIANT = 'full';`],
    ['utils-stub', `
      const state = globalThis.__wmSettingsWindowTestState;

      export function loadFromStorage(_key, defaultValue) {
        return JSON.parse(JSON.stringify(state.panelSettings ?? defaultValue));
      }

      export function saveToStorage(_key, value) {
        state.savedValue = value;
      }
    `],
    ['i18n-stub', `
      const translations = {
        'header.settings': 'Settings',
        'header.panelDisplayCaption': 'Choose panels',
      };

      export function t(key) {
        return translations[key] ?? key;
      }
    `],
    ['sanitize-stub', `
      const HTML_ESCAPE_MAP = {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      };

      export function escapeHtml(value) {
        if (!value) return '';
        return String(value).replace(/[&<>"']/g, (char) => HTML_ESCAPE_MAP[char] || char);
      }
    `],
    ['runtime-stub', `export function isDesktopRuntime() { return false; }`],
  ]);

  const aliasMap = new Map([
    ['@/config', 'config-stub'],
    ['@/services/widget-store', 'widget-store-stub'],
    ['@/config/variant', 'variant-stub'],
    ['@/utils', 'utils-stub'],
    ['@/services/i18n', 'i18n-stub'],
    ['@/utils/sanitize', 'sanitize-stub'],
    ['@/services/runtime', 'runtime-stub'],
  ]);

  const plugin = {
    name: 'settings-window-test-stubs',
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
    initSettingsWindow: mod.initSettingsWindow,
    cleanupBundle() {
      rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

describe('settings-window DOM XSS guardrail', () => {
  it('escapes attacker-controlled panel keys and names before assigning panel grid HTML', async () => {
    const globals = {
      document: snapshotGlobal('document'),
      window: snapshotGlobal('window'),
      __wmSettingsWindowTestState: snapshotGlobal('__wmSettingsWindowTestState'),
    };

    const document = new FakeDocument();
    globalThis.document = document;
    globalThis.window = { close() {} };
    globalThis.__wmSettingsWindowTestState = {
      panelSettings: {
        'evil"><img src=x onerror=alert(1)>': {
          enabled: true,
          name: '<script>alert(1)</script>',
        },
      },
    };

    const { initSettingsWindow, cleanupBundle } = await loadSettingsWindowModule();

    try {
      initSettingsWindow();

      const grid = document.getElementById('panelToggles');
      assert.ok(grid, 'expected panel grid to be created');
      assert.match(
        grid.innerHTML,
        /data-panel="evil&quot;&gt;&lt;img src=x onerror=alert\(1\)&gt;"/,
        'panel key should be escaped before entering the data attribute',
      );
      assert.match(
        grid.innerHTML,
        /&lt;script&gt;alert\(1\)&lt;\/script&gt;/,
        'panel label should be escaped before entering innerHTML',
      );
      assert.equal(
        grid.innerHTML.includes('<img src=x onerror=alert(1)>'),
        false,
        'raw attacker HTML must not be injected into the panel grid',
      );
      assert.equal(
        grid.innerHTML.includes('<script>alert(1)</script>'),
        false,
        'raw script tags must not be injected into the panel label',
      );
    } finally {
      cleanupBundle();
      restoreGlobal('document', globals.document);
      restoreGlobal('window', globals.window);
      restoreGlobal('__wmSettingsWindowTestState', globals.__wmSettingsWindowTestState);
    }
  });
});
