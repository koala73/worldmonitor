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

function restoreGlobal(name: 'document' | 'requestAnimationFrame' | 'setTimeout', value: unknown): void {
  if (value === undefined) Reflect.deleteProperty(globalThis, name);
  else Object.defineProperty(globalThis, name, { configurable: true, value, writable: true });
}

type PreferenceChangeHandler = (
  target: HTMLInputElement,
  container: HTMLElement,
  host: { isDesktopApp: boolean },
) => boolean;

async function loadPreferenceChangeHandler(): Promise<PreferenceChangeHandler> {
  const stubs = new Map<string, string>([
    ['@/services/i18n', 'export const LANGUAGES = []; export function getCurrentLanguageTag(){ return "en"; } export async function changeLanguage(){} export function t(key){ return key; }'],
    ['@/services/ai-flow-settings', 'export const STREAM_QUALITY_OPTIONS = []; export function getAiFlowSettings(){ return { cloudLlm: false, browserModel: false, mapNewsFlash: false, headlineMemory: false, badgeAnimation: false }; } export function getStreamQuality(){ return "auto"; } export function setStreamQuality(value){ globalThis.__settingsSavedQuality = value; } export function setAiFlowSetting(){}'],
    ['@/config/basemap', 'export const MAP_PROVIDER_OPTIONS = []; export const MAP_THEME_OPTIONS = {}; export function getMapProvider(){ return "carto"; } export function setMapProvider(){} export function getMapTheme(){ return "dark"; } export function setMapTheme(){}'],
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
  const plugin = {
    name: 'settings-save-feedback-stubs',
    setup(buildApi: PluginBuild) {
      buildApi.onResolve({ filter: /.*/ }, (args) => (
        stubs.has(args.path) ? { path: args.path, namespace: 'settings-stub' } : null
      ));
      buildApi.onLoad({ filter: /.*/, namespace: 'settings-stub' }, (args) => ({
        contents: stubs.get(args.path) ?? '',
        loader: 'js' as const,
      }));
      buildApi.onLoad({ filter: /preferences-content\.ts$/ }, (args) => ({
        contents: `${readFileSync(args.path, 'utf8')}\nexport { handlePreferenceChange };`,
        loader: 'ts' as const,
      }));
    },
  };
  const result = await build({
    bundle: true,
    entryPoints: [resolve(root, 'src/services/preferences-content.ts')],
    format: 'esm',
    platform: 'browser',
    plugins: [plugin],
    target: 'es2022',
    write: false,
  });
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`;
  const module = await import(moduleUrl) as { handlePreferenceChange: PreferenceChangeHandler };
  return module.handlePreferenceChange;
}

describe('settings save feedback', () => {
  it('persists recognized preference controls and rejects unrelated changes', async () => {
    const runtime = globalThis as typeof globalThis & { __settingsSavedQuality?: string };
    try {
      const handlePreferenceChange = await loadPreferenceChangeHandler();
      const host = { isDesktopApp: false };
      const container = {} as HTMLElement;

      assert.equal(handlePreferenceChange({ id: 'us-stream-quality', value: 'hd720' } as HTMLInputElement, container, host), true);
      assert.equal(runtime.__settingsSavedQuality, 'hd720');
      assert.equal(handlePreferenceChange({ id: 'unrelated-control' } as HTMLInputElement, container, host), false);
    } finally {
      delete runtime.__settingsSavedQuality;
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
    const preferences = source('src/services/preferences-content.ts');
    const eventHandlers = source('src/app/event-handlers.ts');
    const countryIntel = source('src/app/country-intel.ts');

    assert.match(settings, /onSettingSaved:\s*\(\)\s*=>\s*showToast\(t\('modals\.settingsWindow\.saved'\)\)/);
    assert.match(preferences, /if \(handlePreferenceChange\(target, container, host\)\) host\.onSettingSaved\?\.\(\);/);
    assert.doesNotMatch(extractMethodBody(settings, 'private savePanelChanges()'), /showToast\(/);
    assert.doesNotMatch(settings, /function showToast\(/);
    assert.doesNotMatch(eventHandlers, /\n\s{2}showToast\(msg: string\): void/);
    assert.doesNotMatch(countryIntel, /\n\s{2}showToast\(msg: string\): void/);
  });
});
