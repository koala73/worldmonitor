import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build, type PluginBuild } from 'esbuild';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function source(path: string): string {
  return readFileSync(resolve(root, path), 'utf8');
}

function extractMethodBody(contents: string, signature: string): string {
  const signatureIndex = contents.indexOf(signature);
  assert.notEqual(signatureIndex, -1, `${signature} not found`);
  const bodyStart = contents.indexOf('{', signatureIndex);
  assert.notEqual(bodyStart, -1, `${signature} has no body`);

  let depth = 0;
  for (let index = bodyStart; index < contents.length; index += 1) {
    if (contents[index] === '{') depth += 1;
    if (contents[index] === '}') depth -= 1;
    if (depth === 0) return contents.slice(bodyStart + 1, index);
  }

  assert.fail(`${signature} has an unclosed body`);
}

function restoreGlobal(name: 'document' | 'localStorage' | 'requestAnimationFrame' | 'setTimeout' | 'window', value: unknown): void {
  if (value === undefined) Reflect.deleteProperty(globalThis, name);
  else Object.defineProperty(globalThis, name, { configurable: true, value, writable: true });
}

type PreferenceChangeHandler = (
  target: HTMLInputElement,
  container: HTMLElement,
  host: { isDesktopApp: boolean },
) => boolean | Promise<boolean>;

interface PreferencesModule {
  handlePreferenceChange: PreferenceChangeHandler;
  renderPreferences: (host: {
    isDesktopApp: boolean;
    onSettingSaved?: () => void;
  }) => {
    attach: (container: HTMLElement) => () => void;
  };
}

type ChangeLanguage = (value: string) => Promise<boolean>;

interface BundledModuleOptions {
  entryPoint: string;
  stubs: Map<string, string>;
  namespace: string;
  sourceFilter: RegExp;
  transformSource: (contents: string) => string;
}

async function loadBundledModule<T>(options: BundledModuleOptions): Promise<T> {
  const plugin = {
    name: `${options.namespace}-bundle`,
    setup(buildApi: PluginBuild) {
      buildApi.onResolve({ filter: /.*/ }, (args) => (
        options.stubs.has(args.path) ? { path: args.path, namespace: options.namespace } : null
      ));
      buildApi.onLoad({ filter: /.*/, namespace: options.namespace }, (args) => ({
        contents: options.stubs.get(args.path) ?? '',
        loader: 'js' as const,
      }));
      buildApi.onLoad({ filter: options.sourceFilter }, (args) => ({
        contents: options.transformSource(readFileSync(args.path, 'utf8')),
        loader: 'ts' as const,
      }));
    },
  };
  const result = await build({
    bundle: true,
    entryPoints: [options.entryPoint],
    format: 'esm',
    platform: 'browser',
    plugins: [plugin],
    target: 'es2022',
    write: false,
  });
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`;
  return await import(moduleUrl) as T;
}

async function loadRealChangeLanguage(): Promise<ChangeLanguage> {
  const stubs = new Map<string, string>([
    ['i18next', `
      const i18next = {
        language: 'en',
        isInitialized: false,
        hasResourceBundle(){ return false; },
        addResourceBundle(language){ globalThis.__settingsAddedBundles.push(language); },
        async changeLanguage(language){
          globalThis.__settingsChangedLanguages.push(language);
          i18next.language = language;
        },
        use(){ return i18next; },
        async init(){},
        t(key){ return key; },
      };
      export default i18next;
    `],
    ['i18next-browser-languagedetector', 'export default class LanguageDetector { addDetector(){} }'],
    ['@/bootstrap/sentry-defer', 'export function enqueueSentryCall(){}'],
    ['@/shared/language-tags', 'export function resolveLanguageTag(value){ return value; }'],
    ['@/utils/i18n-url', 'export function readQueryLanguage(){} export function stripQueryLanguage(value){ return value; }'],
  ]);
  const module = await loadBundledModule<{ changeLanguage: ChangeLanguage }>({
    entryPoint: resolve(root, 'src/services/i18n.ts'),
    stubs,
    namespace: 'language-change-stub',
    sourceFilter: /i18n\.ts$/,
    transformSource: (contents) => {
      const transformed = contents.replace(
        /const localeModules = import\.meta\.glob<TranslationDictionary>\([\s\S]*?\n\);/,
        'const localeModules = globalThis.__settingsLocaleModules;',
      );
      assert.notEqual(transformed, contents, 'locale module replacement failed');
      return transformed;
    },
  });
  return module.changeLanguage;
}

async function loadPreferencesModule(): Promise<PreferencesModule> {
  const stubs = new Map<string, string>([
    ['@/services/i18n', 'export const LANGUAGES = []; export function getCurrentLanguageTag(){ return "en"; } export function changeLanguage(value){ return globalThis.__settingsChangeLanguage?.(value) ?? Promise.resolve(true); } export function t(key){ return key; }'],
    ['@/services/ai-flow-settings', 'export const STREAM_QUALITY_OPTIONS = []; export function getAiFlowSettings(){ return { cloudLlm: false, browserModel: false, mapNewsFlash: false, headlineMemory: false, badgeAnimation: false }; } export function getStreamQuality(){ return "auto"; } export function setStreamQuality(value){ globalThis.__settingsSavedQuality = value; } export function setAiFlowSetting(){}'],
    ['@/config/basemap', 'export const MAP_PROVIDER_OPTIONS = []; export const MAP_THEME_OPTIONS = { carto: [] }; export function getMapProvider(){ return "carto"; } export function setMapProvider(){} export function getMapTheme(){ return "dark"; } export function setMapTheme(){}'],
    ['@/services/live-stream-settings', 'export function getLiveStreamsAlwaysOn(){ return false; } export function setLiveStreamsAlwaysOn(){}'],
    ['@/services/globe-render-settings', 'export const GLOBE_VISUAL_PRESET_OPTIONS = []; export function getGlobeVisualPreset(){ return "default"; } export function setGlobeVisualPreset(){}'],
    ['@/utils/theme-manager', 'export function getThemePreference(){ return "auto"; } export function setThemePreference(){}'],
    ['@/services/font-settings', 'export function getFontFamily(){ return "mono"; } export function setFontFamily(){}'],
    ['@/services/font-scale-settings', 'export const FONT_SCALE_CHANGED_EVENT = "font-scale-changed"; export const FONT_SCALE_STEPS = []; export function fontScaleLabel(value){ return String(value); } export function getFontScale(){ return 1; } export function parseFontScale(value){ const parsed = Number(value); return Number.isFinite(parsed) ? parsed : undefined; } export function setFontScale(){}'],
    ['@/utils/sanitize', 'export function escapeHtml(value){ return String(value); }'],
    ['@/services/analytics', 'export function trackLanguageChange(){}'],
    ['@/utils/settings-persistence', 'export function exportSettings(){} export async function importSettings(){ return { keysImported: 0 }; }'],
    ['@/utils/cloud-prefs-sync', 'export function getSyncState(){ return "synced"; } export function getLastSyncAt(){ return null; } export async function syncNow(){} export function isCloudSyncEnabled(){ return false; }'],
    ['@/services/analysis-framework-store', 'export function loadFrameworkLibrary(){ return []; } export function saveImportedFramework(){} export function deleteImportedFramework(){} export function renameImportedFramework(){} export function getActiveFrameworkForPanel(){ return null; }'],
    ['@/utils/dom-utils', 'export function setTrustedHtml(){} export function trustedHtml(value){ return value; }'],
  ]);
  return loadBundledModule<PreferencesModule>({
    entryPoint: resolve(root, 'src/services/preferences-content.ts'),
    stubs,
    namespace: 'settings-stub',
    sourceFilter: /preferences-content\.ts$/,
    transformSource: (contents) => `${contents}\nexport { handlePreferenceChange };`,
  });
}

describe('settings save feedback', () => {
  it('persists recognized preference controls and rejects unrelated changes', async () => {
    const runtime = globalThis as typeof globalThis & { __settingsSavedQuality?: string };
    try {
      const { handlePreferenceChange } = await loadPreferencesModule();
      const host = { isDesktopApp: false };
      const container = {} as HTMLElement;

      assert.equal(handlePreferenceChange({ id: 'us-stream-quality', value: 'hd720' } as HTMLInputElement, container, host), true);
      assert.equal(runtime.__settingsSavedQuality, 'hd720');
      assert.equal(handlePreferenceChange({ id: 'us-font-scale', value: 'invalid' } as HTMLInputElement, container, host), false);
      assert.equal(handlePreferenceChange({ id: 'unrelated-control' } as HTMLInputElement, container, host), false);
    } finally {
      delete runtime.__settingsSavedQuality;
    }
  });

  it('announces a language save only after persistence succeeds', async () => {
    const runtime = globalThis as typeof globalThis & {
      __settingsChangeLanguage?: (value: string) => Promise<boolean>;
    };
    const originalWindow = globalThis.window;
    let changeListener: ((event: Event) => void) | undefined;
    let resolveLanguage: ((saved: boolean) => void) | undefined;
    let savedCalls = 0;

    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        addEventListener: () => undefined,
        dispatchEvent: () => true,
        location: { reload: () => undefined },
      },
      writable: true,
    });

    const container = {
      addEventListener: (type: string, listener: EventListenerOrEventListenerObject) => {
        if (type === 'change' && typeof listener === 'function') changeListener = listener;
      },
      querySelector: () => null,
    } as unknown as HTMLElement;

    try {
      const pendingLanguage = new Promise<boolean>((resolvePending) => {
        resolveLanguage = resolvePending;
      });
      runtime.__settingsChangeLanguage = () => pendingLanguage;

      const { renderPreferences } = await loadPreferencesModule();
      const detach = renderPreferences({
        isDesktopApp: false,
        onSettingSaved: () => { savedCalls += 1; },
      }).attach(container);

      assert.ok(changeListener);
      changeListener({ target: { id: 'us-language', value: 'fr' } } as unknown as Event);
      assert.equal(savedCalls, 0);

      resolveLanguage?.(true);
      await pendingLanguage;
      await Promise.resolve();
      assert.equal(savedCalls, 1);

      changeListener({ target: { id: 'us-font-scale', value: 'invalid' } } as unknown as Event);
      assert.equal(savedCalls, 1);

      runtime.__settingsChangeLanguage = async () => false;
      changeListener({ target: { id: 'us-language', value: 'es' } } as unknown as Event);
      await Promise.resolve();
      await Promise.resolve();
      assert.equal(savedCalls, 1);

      runtime.__settingsChangeLanguage = async () => { throw new Error('language load failed'); };
      changeListener({ target: { id: 'us-language', value: 'de' } } as unknown as Event);
      await Promise.resolve();
      await Promise.resolve();
      assert.equal(savedCalls, 1);

      detach();
    } finally {
      delete runtime.__settingsChangeLanguage;
      restoreGlobal('window', originalWindow);
    }
  });

  it('lets only the latest language request persist and reload', async () => {
    const runtime = globalThis as typeof globalThis & {
      __settingsLocaleModules?: Record<string, () => Promise<Record<string, unknown>>>;
      __settingsAddedBundles?: string[];
      __settingsChangedLanguages?: string[];
    };
    const originalDocument = globalThis.document;
    const originalLocalStorage = globalThis.localStorage;
    const originalWindow = globalThis.window;
    const persisted: string[] = [];
    let reloads = 0;
    let resolveFrench: ((value: Record<string, unknown>) => void) | undefined;
    let resolveGerman: ((value: Record<string, unknown>) => void) | undefined;

    runtime.__settingsLocaleModules = {
      '../locales/fr.json': () => new Promise((resolveLocale) => { resolveFrench = resolveLocale; }),
      '../locales/de.json': () => new Promise((resolveLocale) => { resolveGerman = resolveLocale; }),
    };
    runtime.__settingsAddedBundles = [];
    runtime.__settingsChangedLanguages = [];
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: { documentElement: { setAttribute: () => undefined, removeAttribute: () => undefined } },
      writable: true,
    });
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: { setItem: (_key: string, value: string) => { persisted.push(value); } },
      writable: true,
    });
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        history: { replaceState: () => undefined, state: null },
        location: { href: 'https://www.worldmonitor.app/dashboard', reload: () => { reloads += 1; } },
      },
      writable: true,
    });

    try {
      const changeLanguage = await loadRealChangeLanguage();
      const frenchChange = changeLanguage('fr');
      const germanChange = changeLanguage('de');

      resolveGerman?.({ greeting: 'Hallo' });
      assert.equal(await germanChange, true);
      assert.deepEqual(persisted, ['de']);
      assert.deepEqual(runtime.__settingsChangedLanguages, ['de']);
      assert.equal(reloads, 1);

      resolveFrench?.({ greeting: 'Bonjour' });
      assert.equal(await frenchChange, false);
      assert.deepEqual(persisted, ['de']);
      assert.deepEqual(runtime.__settingsChangedLanguages, ['de']);
      assert.equal(reloads, 1);
    } finally {
      delete runtime.__settingsLocaleModules;
      delete runtime.__settingsAddedBundles;
      delete runtime.__settingsChangedLanguages;
      restoreGlobal('document', originalDocument);
      restoreGlobal('localStorage', originalLocalStorage);
      restoreGlobal('window', originalWindow);
    }
  });

  it('uses the accessible shared toast while preserving default and explicit durations', async () => {
    const originalDocument = globalThis.document;
    const originalAnimationFrame = globalThis.requestAnimationFrame;
    const originalSetTimeout = globalThis.setTimeout;
    const scheduled: Array<{ callback: () => void; delay: number }> = [];
    const attributes = new Map<string, string>();
    const classes = new Set<string>();
    let replacedExistingToast = false;
    let appended = false;

    const toast = {
      classList: {
        add: (name: string) => classes.add(name),
        remove: (name: string) => classes.delete(name),
      },
      className: '',
      remove: () => undefined,
      setAttribute: (name: string, value: string) => attributes.set(name, value),
      textContent: '',
    };

    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: {
        body: { appendChild: () => { appended = true; } },
        createElement: () => toast,
        querySelector: () => ({ remove: () => { replacedExistingToast = true; } }),
      },
      writable: true,
    });
    Object.defineProperty(globalThis, 'requestAnimationFrame', {
      configurable: true,
      value: (callback: FrameRequestCallback) => { callback(0); return 1; },
      writable: true,
    });
    Object.defineProperty(globalThis, 'setTimeout', {
      configurable: true,
      value: (callback: () => void, delay = 0) => {
        scheduled.push({ callback, delay });
        return scheduled.length;
      },
      writable: true,
    });

    try {
      const { showToast } = await import('../src/utils/toast.ts');
      showToast('Saved');
      assert.equal(replacedExistingToast, true);
      assert.equal(appended, true);
      assert.equal(toast.textContent, 'Saved');
      assert.equal(attributes.get('role'), 'status');
      assert.equal(classes.has('visible'), true);
      assert.equal(scheduled[0]?.delay, 4000);

      scheduled.length = 0;
      showToast('Short warning', 3000);
      assert.equal(scheduled[0]?.delay, 3000);
      scheduled[0]?.callback();
      assert.equal(classes.has('visible'), false);
      assert.equal(scheduled[1]?.delay, 300);
    } finally {
      restoreGlobal('document', originalDocument);
      restoreGlobal('requestAnimationFrame', originalAnimationFrame);
      restoreGlobal('setTimeout', originalSetTimeout);
    }
  });

  it('wires Preferences only and keeps Panels on its existing inline status', () => {
    const settings = source('src/components/UnifiedSettings.ts');
    const eventHandlers = source('src/app/event-handlers.ts');
    const countryIntel = source('src/app/country-intel.ts');

    assert.match(settings, /onSettingSaved:\s*\(\)\s*=>\s*showToast\(t\('modals\.settingsWindow\.saved'\)\)/);
    assert.doesNotMatch(extractMethodBody(settings, 'private savePanelChanges()'), /showToast\(/);
    assert.doesNotMatch(settings, /function showToast\(/);
    assert.doesNotMatch(eventHandlers, /\n\s{2}showToast\(msg: string\): void/);
    assert.equal(
      eventHandlers.match(/showToast\(t\('modals\.settingsWindow\.freeSourceLimit',[\s\S]*?\), 3000\);/g)?.length,
      2,
    );
    assert.match(
      extractMethodBody(countryIntel, 'showToast(msg: string): void'),
      /^\s*showGlobalToast\(msg, 3000\);\s*$/,
    );
    assert.doesNotMatch(countryIntel, /document\.querySelector\('\.toast-notification'\)/);
  });
});
