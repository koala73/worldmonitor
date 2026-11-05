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

it('successful nonempty key setters enable access and notify subscribers', async () => {
  const store = await loadWidgetStore();
  let changes = 0;
  const unsubscribe = store.subscribeWidgetAccess(() => { changes++; });
  try {
    assert.equal(await store.setWidgetKey('widget-fixture'), true);
    assert.equal(store.isWidgetFeatureEnabled(), true);
    assert.equal(changes, 1);
    assert.equal(await store.setProKey('pro-fixture'), true);
    assert.equal(store.isProWidgetEnabled(), true);
    assert.equal(changes, 2);
    assert.equal(await store.setWidgetKey(''), true);
    assert.equal(await store.setProKey(''), true);
    assert.equal(store.isWidgetFeatureEnabled(), false);
    assert.equal(store.isProWidgetEnabled(), false);
    assert.equal(changes, 4);
  } finally {
    unsubscribe();
  }
});

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
    ['auth-state-stub', `
      export function getAuthState() {
        const hooks = globalThis.__wmKeyTest;
        return { user: hooks ? null : { role: 'pro' }, isPending: false };
      }
    `],
    ['entitlements-stub', `
      export function isEntitled() { return !globalThis.__wmKeyTest; }
      export function getEntitlementState() { return { planKey: 'pro' }; }
    `],
    // Tests drive the key-session outcomes through globalThis.__wmKeyTest; the
    // default accepts every submitted key and reports no status.
    ['browser-key-session-stub', `
      export function clearBrowserKeySession() { return Promise.resolve(true); }
      export function migrateLegacyKeysToHttpOnlySession(keys) {
        const hooks = globalThis.__wmKeyTest;
        if (hooks?.exchange) return hooks.exchange(keys);
        const result = { ok: true };
        if (keys.widgetKey) result.widget = 'accepted';
        if (keys.proKey) result.pro = 'accepted';
        return Promise.resolve(result);
      }
      export function readLegacySessionKey(name) { return globalThis.__wmKeyTest?.legacy?.[name] ?? ''; }
      export function readBrowserKeySessionStatus() {
        const hooks = globalThis.__wmKeyTest;
        return hooks?.status ? hooks.status() : Promise.resolve(null);
      }
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
  it('strict loads distinguish empty storage from malformed storage', async () => {
    installLocalStorage();
    const { loadWidgetsStrict } = await loadWidgetStore();
    assert.deepEqual(loadWidgetsStrict(), []);

    localStorage.setItem('wm-custom-widgets', '{not-json');
    assert.throws(() => loadWidgetsStrict(), SyntaxError);
  });

  it('strict loads propagate storage access failures', async () => {
    installLocalStorage();
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem() {
          throw new Error('storage denied');
        },
      },
    });
    const { loadWidgetsStrict } = await loadWidgetStore();
    assert.throws(() => loadWidgetsStrict(), /storage denied/);
  });

  it('strict loads reject a Pro widget that the resilient loader would drop', async () => {
    const spec = makeProWidget({ html: '' });
    installLocalStorage({
      'wm-custom-widgets': JSON.stringify([spec]),
    });
    const { loadWidgets, loadWidgetsStrict } = await loadWidgetStore();

    assert.throws(() => loadWidgetsStrict(), /missing HTML/);
    assert.deepEqual(loadWidgets(), []);
  });

  it('resilient loads normalize a legacy widget with no tier field to basic instead of dropping it', async () => {
    const legacyWidget = {
      id: 'cw-legacy-no-tier',
      title: 'Pre-tier Widget',
      html: '<div>legacy</div>',
      prompt: 'Build a legacy widget',
      accentColor: null,
      conversationHistory: [],
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_001,
      // no `tier` field — widgets saved before `tier` was added to the spec.
    };
    installLocalStorage({
      'wm-custom-widgets': JSON.stringify([legacyWidget]),
    });
    const { loadWidgets, loadWidgetsStrict } = await loadWidgetStore();

    const loaded = loadWidgets();
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0]!.tier, 'basic');
    assert.equal(loaded[0]!.id, 'cw-legacy-no-tier');

    // The strict activation-eligibility loader normalizes the same row to
    // 'basic' as well — a legacy pre-tier widget is not malformed.
    const strictLoaded = loadWidgetsStrict();
    assert.equal(strictLoaded.length, 1);
    assert.equal(strictLoaded[0]!.tier, 'basic');
    assert.equal(strictLoaded[0]!.id, 'cw-legacy-no-tier');
  });

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

type KeyVerdict = 'accepted' | 'rejected' | 'failed';
type ExchangeResult = { ok: boolean; widget?: KeyVerdict; pro?: KeyVerdict };
type KeyHooks = {
  legacy?: Partial<Record<'wm-widget-key' | 'wm-pro-key', string>>;
  exchange?: (keys: { widgetKey?: string; proKey?: string }) => Promise<ExchangeResult>;
  status?: () => Promise<{ widget: boolean; pro: boolean } | null>;
};

function verdictFor(keys: { widgetKey?: string; proKey?: string }, verdict: (key: string) => KeyVerdict): ExchangeResult {
  const result: ExchangeResult = { ok: true };
  if (keys.widgetKey) result.widget = verdict(keys.widgetKey);
  if (keys.proKey) result.pro = verdict(keys.proKey);
  result.ok = [result.widget, result.pro].every(v => v === undefined || v === 'accepted');
  return result;
}

const settle = () => new Promise(resolve => setTimeout(resolve, 0));

describe('widget-store tester-key hints follow the server verdict', () => {
  const windowSnapshot = snapshotGlobal('window');

  async function loadWithKeys(hooks: KeyHooks): Promise<WidgetStore> {
    (globalThis as Record<string, unknown>).__wmKeyTest = hooks;
    Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: globalThis });
    installLocalStorage();
    return loadWidgetStore();
  }

  afterEach(() => {
    delete (globalThis as Record<string, unknown>).__wmKeyTest;
    restoreGlobal('window', windowSnapshot);
  });

  it('a legacy pro key grants Pro only after the server accepts it', async () => {
    let answer!: (r: ExchangeResult) => void;
    const store = await loadWithKeys({
      legacy: { 'wm-pro-key': 'good-pro' },
      exchange: () => new Promise(resolve => { answer = resolve; }),
    });
    let changes = 0;
    store.subscribeWidgetAccess(() => { changes++; });
    assert.equal(store.isProUser(), false, 'no Pro while the exchange is pending');
    await settle();
    assert.equal(store.isProUser(), false, 'still no Pro while the exchange is pending');
    answer({ ok: true, pro: 'accepted' });
    await settle();
    assert.equal(store.isProUser(), true);
    assert.equal(store.isProWidgetEnabled(), true);
    assert.ok(changes >= 1, 'listeners hear about the accepted key');
  });

  it('a legacy pro key the server rejects never grants Pro', async () => {
    let changes = 0;
    const store = await loadWithKeys({
      legacy: { 'wm-pro-key': 'wrong-pro' },
      exchange: async keys => verdictFor(keys, () => 'rejected'),
    });
    store.subscribeWidgetAccess(() => { changes++; });
    assert.equal(store.isProUser(), false);
    await settle();
    assert.equal(store.isProUser(), false);
    assert.equal(changes, 0, 'a rejected key changes nothing listeners can see');
  });

  it('a transport failure leaves Pro off', async () => {
    const store = await loadWithKeys({
      legacy: { 'wm-pro-key': 'maybe-pro' },
      exchange: async keys => verdictFor(keys, () => 'failed'),
    });
    assert.equal(store.isProUser(), false);
    await settle();
    assert.equal(store.isProUser(), false);
  });

  it('widget and pro keys are judged independently', async () => {
    const store = await loadWithKeys({
      legacy: { 'wm-widget-key': 'stale-widget', 'wm-pro-key': 'good-pro' },
      exchange: async keys => verdictFor(keys, key => key === 'good-pro' ? 'accepted' : 'rejected'),
    });
    store.isProUser();
    await settle();
    assert.equal(store.isWidgetFeatureEnabled(), false);
    assert.equal(store.isProWidgetEnabled(), true);
  });

  it('setProKey with a rejected key does not grant Pro', async () => {
    const store = await loadWithKeys({ exchange: async keys => verdictFor(keys, () => 'rejected') });
    let changes = 0;
    store.subscribeWidgetAccess(() => { changes++; });
    assert.equal(await store.setProKey('wrong-pro'), false);
    assert.equal(store.isProWidgetEnabled(), false);
    assert.equal(await store.setWidgetKey('wrong-widget'), false);
    assert.equal(store.isWidgetFeatureEnabled(), false);
    assert.equal(changes, 0);
  });

  it('setProKey with a rejected key keeps an already accepted session', async () => {
    const store = await loadWithKeys({ exchange: async keys => verdictFor(keys, key => key === 'good-pro' ? 'accepted' : 'rejected') });
    assert.equal(await store.setProKey('good-pro'), true);
    assert.equal(await store.setProKey('wrong-pro'), false);
    assert.equal(store.isProWidgetEnabled(), true, 'the server kept the previous cookie, so Pro stays');
  });

  it('after a reload the server status restores Pro without a legacy key', async () => {
    let answer!: (s: { widget: boolean; pro: boolean } | null) => void;
    const exchanged: unknown[] = [];
    const store = await loadWithKeys({
      exchange: async keys => { exchanged.push(keys); return verdictFor(keys, () => 'accepted'); },
      status: () => new Promise(resolve => { answer = resolve; }),
    });
    let changes = 0;
    store.subscribeWidgetAccess(() => { changes++; });
    assert.equal(store.isProUser(), false, 'boot never waits for the status read');
    answer({ widget: false, pro: true });
    await settle();
    assert.equal(store.isProUser(), true);
    assert.equal(store.isWidgetFeatureEnabled(), false);
    assert.equal(changes, 1);
    assert.deepEqual(exchanged, [], 'no exchange without a legacy key');
  });

  it('an unknown status leaves the hints off', async () => {
    const store = await loadWithKeys({ status: async () => null });
    assert.equal(store.isProUser(), false);
    await settle();
    assert.equal(store.isProUser(), false);
  });

  it('a stale status answer does not override a key the user changed meanwhile', async () => {
    let answer!: (s: { widget: boolean; pro: boolean } | null) => void;
    const store = await loadWithKeys({ status: () => new Promise(resolve => { answer = resolve; }) });
    assert.equal(store.isProUser(), false);
    assert.equal(await store.setProKey(''), true);
    answer({ widget: false, pro: true });
    await settle();
    assert.equal(store.isProWidgetEnabled(), false, 'the user cleared the key after the status request left');
  });

  it('the status read reports the session an exchange at boot just established', async () => {
    const store = await loadWithKeys({
      legacy: { 'wm-pro-key': 'good-pro' },
      exchange: async keys => verdictFor(keys, () => 'accepted'),
      status: async () => ({ widget: false, pro: false }),
    });
    store.isProUser();
    await settle();
    assert.equal(store.isProWidgetEnabled(), false, 'the server says the cookie is not usable, so Pro stays off');
  });
});
