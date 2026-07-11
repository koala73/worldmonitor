import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { CustomWidgetSpec } from '../src/services/widget-store.ts';

type WidgetStore = typeof import('../src/services/widget-store.ts');

type GlobalSnapshot = { exists: boolean; value: unknown };

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

const localStorageSnapshot = snapshotGlobal('localStorage');

afterEach(() => {
  restoreGlobal('localStorage', localStorageSnapshot);
});

async function loadWidgetStore(): Promise<WidgetStore> {
  const tempDir = mkdtempSync(join(tmpdir(), 'wm-widget-store-'));
  const outfile = join(tempDir, 'widget-store.bundle.mjs');
  const entry = resolve(process.cwd(), 'src/services/widget-store.ts');

  const stubModules = new Map([
    ['utils-stub', `
      export function loadFromStorage(key, fallback) {
        try {
          const raw = localStorage.getItem(key);
          return raw == null ? fallback : JSON.parse(raw);
        } catch {
          return fallback;
        }
      }
      export function saveToStorage(key, value) {
        localStorage.setItem(key, JSON.stringify(value));
      }
    `],
    ['panel-storage-stub', `
      export function clearPanelSpanEntry(id) {
        globalThis.__clearedPanelSpans = globalThis.__clearedPanelSpans || [];
        globalThis.__clearedPanelSpans.push(id);
      }
      export function clearPanelColSpanEntry(id) {
        globalThis.__clearedPanelColSpans = globalThis.__clearedPanelColSpans || [];
        globalThis.__clearedPanelColSpans.push(id);
      }
    `],
    ['widget-sanitizer-stub', `export function sanitizeWidgetHtml(html) { return 'sanitized:' + String(html); }`],
    ['auth-state-stub', `export function getAuthState() { return { user: { role: 'pro' } }; }`],
    ['entitlements-stub', `export function isEntitled() { return true; }`],
    ['browser-key-session-stub', `
      export function clearLegacyKeyStorage() {}
      export function migrateLegacyKeysToHttpOnlySession() { return Promise.resolve(); }
      export function readLegacySessionKey() { return ''; }
    `],
  ]);

  const aliasMap = new Map([
    ['@/utils', 'utils-stub'],
    ['@/utils/panel-storage', 'panel-storage-stub'],
    ['@/utils/widget-sanitizer', 'widget-sanitizer-stub'],
    ['@/services/auth-state', 'auth-state-stub'],
    ['@/services/entitlements', 'entitlements-stub'],
    ['@/services/browser-key-session', 'browser-key-session-stub'],
  ]);

  const result = await build({
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2020',
    write: false,
    plugins: [{
      name: 'widget-store-test-stubs',
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
    }],
  });

  writeFileSync(outfile, result.outputFiles[0].text, 'utf8');
  const mod = await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
  rmSync(tempDir, { recursive: true, force: true });
  return mod as WidgetStore;
}

function installLocalStorage(initial: Record<string, string> = {}): Map<string, string> {
  const values = new Map(Object.entries(initial));
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    writable: true,
    value: {
      getItem(key: string) {
        return values.get(key) ?? null;
      },
      setItem(key: string, value: string) {
        values.set(key, String(value));
      },
      removeItem(key: string) {
        values.delete(key);
      },
    },
  });
  return values;
}

function proHtmlKey(id: string): string {
  return `wm-pro-html-${id}`;
}

function makeProWidget(overrides: Partial<CustomWidgetSpec> = {}): CustomWidgetSpec {
  return {
    id: 'cw-pro-reload',
    title: 'Reloadable Pro Widget',
    html: '<div class="reload-marker">survives reload</div>',
    prompt: 'Build a reloadable widget',
    tier: 'pro',
    accentColor: null,
    conversationHistory: [
      { role: 'user', content: 'Build a reloadable widget' },
      { role: 'assistant', content: 'Generated Reloadable Pro Widget' },
    ],
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_001,
    ...overrides,
  };
}

describe('widget-store PRO persistence', () => {
  it('saveWidget persists PRO generated HTML in the canonical widget entry', async () => {
    const storage = installLocalStorage();
    const { saveWidget } = await loadWidgetStore();

    const save = saveWidget(makeProWidget());
    assert.ok(save instanceof Promise, 'saving a widget should defer optional sanitizer loading');
    await save;

    const stored = JSON.parse(localStorage.getItem('wm-custom-widgets') ?? '[]') as Array<{ html?: string }>;
    assert.equal(stored.length, 1);
    assert.match(stored[0]?.html ?? '', /reload-marker/);
    assert.equal(storage.has(proHtmlKey('cw-pro-reload')), false);
  });

  it('loads the sanitizer only when persisting a basic widget', async () => {
    installLocalStorage();
    const { saveWidget } = await loadWidgetStore();
    const basic = makeProWidget({ id: 'cw-basic', tier: 'basic', html: '<div>basic</div>' });

    await saveWidget(basic);

    const stored = JSON.parse(localStorage.getItem('wm-custom-widgets') ?? '[]') as Array<{ html?: string }>;
    assert.equal(stored[0]?.html, 'sanitized:<div>basic</div>');
  });

  it('loadWidgets restores PRO HTML from the canonical entry when the side key is absent', async () => {
    const spec = makeProWidget();
    installLocalStorage({
      'wm-custom-widgets': JSON.stringify([spec]),
    });
    const { loadWidgets } = await loadWidgetStore();

    const widgets = loadWidgets();

    assert.equal(widgets.length, 1);
    assert.equal(widgets[0]?.id, spec.id);
    assert.match(widgets[0]?.html ?? '', /reload-marker/);
  });

  it('loadWidgets restores legacy PRO HTML from the side key when canonical HTML is absent', async () => {
    const spec = makeProWidget({ html: '' });
    installLocalStorage({
      'wm-custom-widgets': JSON.stringify([spec]),
      [proHtmlKey(spec.id)]: '<div class="legacy-side-key">legacy widget</div>',
    });
    const { loadWidgets } = await loadWidgetStore();

    const widgets = loadWidgets();

    assert.equal(widgets.length, 1);
    assert.equal(widgets[0]?.id, spec.id);
    assert.match(widgets[0]?.html ?? '', /legacy-side-key/);
  });

  it('loadWidgets prefers canonical PRO HTML over a stale side key', async () => {
    const spec = makeProWidget({
      html: '<div class="canonical-html">current widget</div>',
    });
    installLocalStorage({
      'wm-custom-widgets': JSON.stringify([spec]),
      [proHtmlKey(spec.id)]: '<div class="stale-side-key">old widget</div>',
    });
    const { loadWidgets } = await loadWidgetStore();

    const widgets = loadWidgets();

    assert.equal(widgets.length, 1);
    assert.match(widgets[0]?.html ?? '', /canonical-html/);
    assert.doesNotMatch(widgets[0]?.html ?? '', /stale-side-key/);
  });

  it('loadWidgets drops PRO widgets when no persisted HTML remains', async () => {
    const spec = makeProWidget({ html: '' });
    installLocalStorage({
      'wm-custom-widgets': JSON.stringify([spec]),
    });
    const { loadWidgets } = await loadWidgetStore();

    const widgets = loadWidgets();

    assert.equal(widgets.length, 0);
  });
});
