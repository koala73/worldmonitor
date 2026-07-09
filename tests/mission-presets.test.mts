import { describe, it, before, beforeEach, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { MapLayers, PanelConfig } from '../src/types/index.ts';
import {
  ALL_PANELS,
  DEFAULT_MAP_LAYERS,
  VARIANT_DEFAULTS,
  getEffectivePanelConfig,
} from '../src/config/panels.ts';
import {
  LAYER_REGISTRY,
  getAllowedLayerKeys,
  type MapVariant,
} from '../src/config/map-layer-definitions.ts';
import {
  MISSION_PRESET_DISMISSED_KEY,
  MISSION_PRESET_STORAGE_KEY,
  MISSION_PRESETS,
  applyMissionPresetToState,
  clearMissionPreset,
  dismissMissionPresetPrompt,
  filterMissionLayersForRenderer,
  getMissionPreset,
  isMissionPresetPromptDismissed,
  loadStoredMissionPreset,
  resetMissionPresetState,
  saveMissionPreset,
} from '../src/services/mission-presets.ts';

class MemoryStorage {
  private store = new Map<string, string>();
  throwOnGet = false;
  throwOnSet = false;
  throwOnRemove = false;

  getItem(key: string): string | null {
    if (this.throwOnGet) throw new Error('blocked');
    return this.store.has(key) ? this.store.get(key)! : null;
  }

  setItem(key: string, value: string): void {
    if (this.throwOnSet) throw new Error('blocked');
    this.store.set(key, String(value));
  }

  removeItem(key: string): void {
    if (this.throwOnRemove) throw new Error('blocked');
    this.store.delete(key);
  }

  clear(): void {
    this.store.clear();
  }
}

const VARIANTS: MapVariant[] = ['full', 'tech', 'finance', 'commodity', 'energy', 'happy'];

let originalLocalStorage: PropertyDescriptor | undefined;
let originalWindow: PropertyDescriptor | undefined;
let originalDocument: PropertyDescriptor | undefined;
let originalHistory: PropertyDescriptor | undefined;
let originalRequestAnimationFrame: PropertyDescriptor | undefined;
let originalCancelAnimationFrame: PropertyDescriptor | undefined;

type EventHandlerManagerCtor = new (ctx: unknown, callbacks: unknown) => {
  destroy(): void;
  syncUrlState(): void;
};

let EventHandlerManager: EventHandlerManagerCtor;
let cleanupEventHandlerBundle: (() => void) | null = null;

function defineLocalStorage(value: unknown): void {
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value,
  });
}

class MiniElement extends EventTarget {
  id = '';
  className = '';
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  textContent = '';
  children: MiniElement[] = [];
  parentElement: MiniElement | null = null;
  classList = {
    add: (...classes: string[]) => {
      const current = new Set(this.className.split(/\s+/).filter(Boolean));
      classes.forEach((name) => current.add(name));
      this.className = Array.from(current).join(' ');
    },
    remove: (...classes: string[]) => {
      const remove = new Set(classes);
      this.className = this.className
        .split(/\s+/)
        .filter((name) => name && !remove.has(name))
        .join(' ');
    },
    contains: (name: string) => this.className.split(/\s+/).includes(name),
    toggle: (name: string, force?: boolean) => {
      const has = this.classList.contains(name);
      const shouldAdd = force ?? !has;
      if (shouldAdd) this.classList.add(name);
      else this.classList.remove(name);
      return shouldAdd;
    },
  };
  private attributes = new Map<string, string>();
  private _innerHTML = '';

  constructor(
    readonly tagName: string,
    private readonly owner: MiniDocument,
  ) {
    super();
  }

  set innerHTML(value: string) {
    this._innerHTML = String(value);
    this.owner.unregisterDescendants(this);
    this.children = [];

    const buttonId = this._innerHTML.match(/id="([^"]+)"/)?.[1];
    if (buttonId) {
      const button = this.owner.createElement('button') as MiniElement;
      button.id = buttonId;
      button.className = this._innerHTML.match(/class="([^"]+)"/)?.[1] ?? '';
      button.textContent = this._innerHTML.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      this.appendChild(button);
    }
  }

  get innerHTML(): string {
    return this._innerHTML;
  }

  appendChild(child: MiniElement): MiniElement {
    child.parentElement = this;
    this.children.push(child);
    this.owner.register(child);
    return child;
  }

  remove(): void {
    this.parentElement?.removeChild(this);
  }

  removeChild(child: MiniElement): MiniElement {
    this.children = this.children.filter((candidate) => candidate !== child);
    this.owner.unregister(child);
    child.parentElement = null;
    return child;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, String(value));
    if (name === 'id') {
      if (this.id) this.owner.unregisterId(this.id);
      this.id = String(value);
      this.owner.register(this);
      return;
    }
    if (name === 'class') {
      this.className = String(value);
      return;
    }
    if (name.startsWith('data-')) {
      const key = name
        .slice(5)
        .replace(/-([a-z])/g, (_match, char: string) => char.toUpperCase());
      this.dataset[key] = String(value);
    }
  }

  getAttribute(name: string): string | null {
    if (name === 'id') return this.id || null;
    if (name === 'class') return this.className || null;
    return this.attributes.get(name) ?? null;
  }

  querySelector(selector: string): MiniElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  querySelectorAll(selector: string): MiniElement[] {
    const matches: MiniElement[] = [];
    const visit = (node: MiniElement) => {
      for (const child of node.children) {
        if (matchesSelector(child, selector)) matches.push(child);
        visit(child);
      }
    };
    visit(this);
    return matches;
  }

  focus(): void {
    this.owner.activeElement = this;
  }

  getBoundingClientRect(): { left: number; bottom: number } {
    return { left: 24, bottom: 48 };
  }

  get offsetHeight(): number {
    return 240;
  }
}

class MiniDocument extends EventTarget {
  body: MiniElement;
  activeElement: MiniElement | null = null;
  hidden = false;
  private byId = new Map<string, MiniElement>();

  constructor() {
    super();
    this.body = new MiniElement('body', this);
  }

  createElement(tagName: string): MiniElement {
    return new MiniElement(tagName.toUpperCase(), this);
  }

  getElementById(id: string): MiniElement | null {
    return this.byId.get(id) ?? null;
  }

  querySelector(selector: string): MiniElement | null {
    if (matchesSelector(this.body, selector)) return this.body;
    return this.body.querySelector(selector);
  }

  register(el: MiniElement): void {
    if (el.id) this.byId.set(el.id, el);
    el.children.forEach((child) => this.register(child));
  }

  unregister(el: MiniElement): void {
    if (el.id && this.byId.get(el.id) === el) this.byId.delete(el.id);
    el.children.forEach((child) => this.unregister(child));
  }

  unregisterId(id: string): void {
    this.byId.delete(id);
  }

  unregisterDescendants(el: MiniElement): void {
    el.children.forEach((child) => this.unregister(child));
  }
}

function matchesSelector(el: MiniElement, selector: string): boolean {
  if (selector.startsWith('#')) return el.id === selector.slice(1);
  if (selector.startsWith('.')) return el.className.split(/\s+/).includes(selector.slice(1));
  if (selector.startsWith('[') && selector.endsWith(']')) {
    const attr = selector.slice(1, -1);
    if (attr.startsWith('data-')) {
      const key = attr
        .slice(5)
        .replace(/-([a-z])/g, (_match, char: string) => char.toUpperCase());
      return Object.hasOwn(el.dataset, key);
    }
  }
  return el.tagName.toLowerCase() === selector.toLowerCase();
}

function defineBrowserGlobals(): MiniDocument {
  const document = new MiniDocument();
  const windowTarget = new EventTarget() as EventTarget & {
    document: MiniDocument;
    location: { origin: string; pathname: string; search: string; href: string; hostname: string };
    innerWidth: number;
    innerHeight: number;
    setTimeout: typeof setTimeout;
    clearTimeout: typeof clearTimeout;
    requestAnimationFrame: (cb: FrameRequestCallback) => number;
  };
  windowTarget.document = document;
  windowTarget.location = {
    origin: 'https://worldmonitor.test',
    pathname: '/',
    search: '',
    href: 'https://worldmonitor.test/',
    hostname: 'worldmonitor.test',
  };
  windowTarget.innerWidth = 1440;
  windowTarget.innerHeight = 900;
  windowTarget.setTimeout = setTimeout;
  windowTarget.clearTimeout = clearTimeout;
  windowTarget.requestAnimationFrame = (cb: FrameRequestCallback) => {
    cb(0);
    return 0;
  };

  Object.defineProperty(globalThis, 'window', { configurable: true, value: windowTarget });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: document });
  Object.defineProperty(globalThis, 'history', {
    configurable: true,
    value: {
      latestUrl: '',
      replaceState(_state: unknown, _unused: string, url?: string | URL | null) {
        this.latestUrl = url == null ? '' : String(url);
      },
    },
  });
  Object.defineProperty(globalThis, 'requestAnimationFrame', {
    configurable: true,
    value: windowTarget.requestAnimationFrame,
  });
  Object.defineProperty(globalThis, 'cancelAnimationFrame', {
    configurable: true,
    value: () => undefined,
  });
  return document;
}

async function loadEventHandlerManager(): Promise<EventHandlerManagerCtor> {
  const tempDir = mkdtempSync(join(tmpdir(), 'mission-handler-test-'));
  const outfile = join(tempDir, 'event-handlers.mjs');
  const stubs = new Map<string, string>([
    ['@/utils', `
      export function buildMapUrl(baseUrl, state) {
        const url = new URL(baseUrl);
        if (state.center) {
          url.searchParams.set('lat', state.center.lat.toFixed(4));
          url.searchParams.set('lon', state.center.lon.toFixed(4));
        }
        url.searchParams.set('zoom', state.zoom.toFixed(2));
        url.searchParams.set('view', state.view);
        url.searchParams.set('timeRange', state.timeRange);
        const layers = Object.keys(state.layers).filter((key) => state.layers[key]);
        url.searchParams.set('layers', layers.length ? layers.join(',') : 'none');
        if (state.chokepoint) url.searchParams.set('chokepoint', state.chokepoint);
        return url.toString();
      }
      export function debounce(fn, delay) {
        let timer = null;
        const wrapped = () => {
          if (timer) clearTimeout(timer);
          timer = setTimeout(fn, delay);
        };
        wrapped.cancel = () => {
          if (timer) clearTimeout(timer);
          timer = null;
        };
        return wrapped;
      }
      export function saveToStorage(key, value) {
        try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
      }
      export function loadFromStorage(key, fallback) {
        try {
          const raw = localStorage.getItem(key);
          return raw == null ? fallback : JSON.parse(raw);
        } catch {
          return fallback;
        }
      }
      export function rssProxyUrl(url) { return url; }
      export function getCSSColor(_name, fallback) { return fallback || '#000000'; }
      export class ExportPanel {}
      export function getCurrentTheme() { return 'dark'; }
      export function setTheme() {}
      export function showToast(message) {
        globalThis.__missionToastMessages = globalThis.__missionToastMessages || [];
        globalThis.__missionToastMessages.push(message);
      }
    `],
    ['@/utils/after-paint', `
      export function scheduleAfterFirstPaint(task) {
        globalThis.__missionAfterPaintTasks = globalThis.__missionAfterPaintTasks || [];
        globalThis.__missionAfterPaintTasks.push(task);
      }
    `],
    ['@/utils/dom-utils', `
      export function h(tagName, props, ...children) {
        const el = document.createElement(tagName);
        if (props && typeof props === 'object') {
          for (const [key, value] of Object.entries(props)) {
            if (key === 'className') el.className = String(value);
            else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
            else if (value !== false && value != null) el.setAttribute(key, String(value));
          }
        }
        for (const child of children.flat()) {
          if (child == null) continue;
          if (typeof child === 'string') {
            const text = document.createElement('span');
            text.textContent = child;
            el.appendChild(text);
          } else {
            el.appendChild(child);
          }
        }
        return el;
      }
      export function replaceChildren(el, ...children) {
        el.innerHTML = '';
        for (const child of children.flat()) {
          if (child == null) continue;
          if (typeof child === 'string') {
            const text = document.createElement('span');
            text.textContent = child;
            el.appendChild(text);
          } else {
            el.appendChild(child);
          }
        }
      }
      export function trustedHtml(html) { return String(html); }
      export function setTrustedHtml(el, html) { el.innerHTML = String(html); }
    `],
    ['@/utils/sanitize', 'export function escapeHtml(value) { return String(value); } export function safeHtmlToString(value) { return String(value); }'],
    ['@/services/analytics', `
      const push = (name, args) => {
        globalThis.__missionAnalytics = globalThis.__missionAnalytics || [];
        globalThis.__missionAnalytics.push({ name, args });
      };
      export function track(...args) { push('track', args); }
      export function trackPanelView(...args) { push('trackPanelView', args); }
      export function trackVariantSwitch(...args) { push('trackVariantSwitch', args); }
      export function trackThemeChanged(...args) { push('trackThemeChanged', args); }
      export function trackMapViewChange(...args) { push('trackMapViewChange', args); }
      export function trackMapLayerToggle(...args) { push('trackMapLayerToggle', args); }
      export function trackPanelToggled(...args) { push('trackPanelToggled', args); }
      export function trackDownloadClicked(...args) { push('trackDownloadClicked', args); }
      export function trackGateHit(...args) { push('trackGateHit', args); }
      export function trackPanelResized(...args) { push('trackPanelResized', args); }
    `],
    ['@/services', `
      export async function saveSnapshot() {}
      export function isAisConfigured() {
        return globalThis.__missionAisConfigured !== false;
      }
      export function initAisStream() {
        globalThis.__missionAis = globalThis.__missionAis || [];
        globalThis.__missionAis.push('init');
      }
      export function disconnectAisStream() {
        globalThis.__missionAis = globalThis.__missionAis || [];
        globalThis.__missionAis.push('disconnect');
      }
    `],
    ['@/services/data-freshness', `
      export const dataFreshness = {
        setEnabled(source, enabled) {
          globalThis.__missionFreshness = globalThis.__missionFreshness || [];
          globalThis.__missionFreshness.push([source, enabled]);
        },
      };
    `],
    ['@/services/i18n', 'export function t(key) { return key; }'],
    ['@/services/widget-store', 'export function deleteWidget(){} export function getWidget(){ return null; } export function saveWidget(){} export function isProUser(){ return true; }'],
    ['@/services/mcp-store', 'export function deleteMcpPanel(){} export function getMcpPanel(){ return null; } export function saveMcpPanel(){}'],
    ['@/services/runtime', 'export function isDesktopRuntime(){ return false; }'],
    ['@/services/tauri-bridge', 'export async function invokeTauri(){ return null; }'],
    ['@/services/gps-interference', 'export function getCachedGpsInterference(){ return null; }'],
    ['@/services/ml-worker', 'export const mlWorker = {};'],
    ['@/services/auth-state', 'export function getAuthState(){ return { user: { role: "pro" } }; } export function subscribeAuthState(){ return () => {}; }'],
    ['@/services/tv-mode', 'export class TvModeController { constructor(){} toggle(){} updatePanelKeys(){} get active(){ return false; } }'],
    ['@/components', `
      export class PlaybackControl { onSnapshot(){} getElement(){ return document.createElement('div'); } }
      export class StatusPanel {}
      export class PizzIntIndicator {}
      export class LlmStatusIndicator {}
      export class PredictionPanel { renderPredictions(){} }
    `],
    ['@/components/PlaybackControl', 'export class PlaybackControl { onSnapshot(){} getElement(){ return document.createElement("div"); } }'],
    ['@/components/StatusPanel', 'export class StatusPanel {}'],
    ['@/components/PizzIntIndicator', 'export class PizzIntIndicator { getElement(){ return document.createElement("div"); } update(){} }'],
    ['@/components/LlmStatusIndicator', 'export class LlmStatusIndicator { getElement(){ return document.createElement("div"); } update(){} }'],
    ['@/components/CustomWidgetPanel', 'export class CustomWidgetPanel { constructor(spec){ this.spec = spec; } getElement(){ return document.createElement("div"); } }'],
    ['@/components/WidgetChatModal', 'export function openWidgetChatModal(){}'],
    ['@/components/McpDataPanel', 'export class McpDataPanel { constructor(spec){ this.spec = spec; } getElement(){ return document.createElement("div"); } }'],
    ['@/components/McpConnectModal', 'export function openMcpConnectModal(){}'],
    ['@/components/DownloadBanner', 'export function detectPlatform(){ return "web"; } export const allButtons = []; export function buttonsForPlatform(){ return []; }'],
    ['@/components/UnifiedSettings', 'export class UnifiedSettings { refreshPanelToggles(){} open(){} }'],
    ['@/components/AuthLauncher', 'export class AuthLauncher { open(){} close(){} destroy(){} }'],
    ['@/components/AuthHeaderWidget', 'export class AuthHeaderWidget { constructor(){} getElement(){ return document.createElement("div"); } }'],
  ]);
  const plugin = {
    name: 'mission-event-handler-stubs',
    setup(buildApi: import('esbuild').PluginBuild) {
      buildApi.onResolve({ filter: /.*/ }, (args) => {
        const target = stubs.get(args.path);
        return target ? { path: args.path, namespace: 'mission-stub' } : null;
      });
      buildApi.onLoad({ filter: /.*/, namespace: 'mission-stub' }, (args) => ({
        contents: stubs.get(args.path) ?? '',
        loader: 'js' as const,
      }));
      buildApi.onLoad({ filter: /\.css$/ }, () => ({ contents: '', loader: 'css' as const }));
    },
  };

  const result = await build({
    entryPoints: [new URL('../src/app/event-handlers.ts', import.meta.url).pathname],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    write: false,
    plugins: [plugin],
    define: {
      'import.meta.env.VITE_VARIANT': '"full"',
      'import.meta.env.DEV': 'false',
    },
  });
  writeFileSync(outfile, result.outputFiles[0].text, 'utf8');
  cleanupEventHandlerBundle = () => rmSync(tempDir, { recursive: true, force: true });
  const mod = await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
  return mod.EventHandlerManager as EventHandlerManagerCtor;
}

function makePanelSettings(variant: string): Record<string, PanelConfig> {
  const settings: Record<string, PanelConfig> = {};
  for (const key of Object.keys(ALL_PANELS)) {
    settings[key] = {
      ...getEffectivePanelConfig(key, variant),
      enabled: false,
    };
  }
  settings['runtime-config'] = { name: 'Desktop Configuration', enabled: true, priority: 2 };
  settings['cw-market-note'] = { name: 'Market Note', enabled: true, priority: 3 };
  settings['mcp-risk-feed'] = { name: 'Risk Feed', enabled: false, priority: 3 };
  return settings;
}

function enabledPanelKeys(settings: Record<string, PanelConfig>): string[] {
  return Object.entries(settings)
    .filter(([, config]) => config.enabled)
    .map(([key]) => key)
    .sort();
}

function enabledWorkspacePanelKeys(settings: Record<string, PanelConfig>): string[] {
  return enabledPanelKeys(settings).filter(
    (key) => key !== 'map' && key !== 'runtime-config' && !key.startsWith('cw-') && !key.startsWith('mcp-'),
  );
}

function defaultWorkspacePanelKeys(variant: string): string[] {
  const reset = resetMissionPresetState(makePanelSettings(variant), DEFAULT_MAP_LAYERS, variant);
  return enabledWorkspacePanelKeys(reset.panelSettings);
}

before(async () => {
  EventHandlerManager = await loadEventHandlerManager();
});

after(() => {
  cleanupEventHandlerBundle?.();
});

function resetMissionGlobals(): void {
  delete (globalThis as { __missionAnalytics?: unknown }).__missionAnalytics;
  delete (globalThis as { __missionAis?: unknown }).__missionAis;
  delete (globalThis as { __missionAisConfigured?: unknown }).__missionAisConfigured;
  delete (globalThis as { __missionFreshness?: unknown }).__missionFreshness;
  delete (globalThis as { __missionToastMessages?: unknown }).__missionToastMessages;
  delete (globalThis as { __missionAfterPaintTasks?: unknown }).__missionAfterPaintTasks;
}

beforeEach(() => {
  originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  originalHistory = Object.getOwnPropertyDescriptor(globalThis, 'history');
  originalRequestAnimationFrame = Object.getOwnPropertyDescriptor(globalThis, 'requestAnimationFrame');
  originalCancelAnimationFrame = Object.getOwnPropertyDescriptor(globalThis, 'cancelAnimationFrame');
  defineLocalStorage(new MemoryStorage());
  defineBrowserGlobals();
  resetMissionGlobals();
});

afterEach(() => {
  if (originalLocalStorage) {
    Object.defineProperty(globalThis, 'localStorage', originalLocalStorage);
  } else {
    delete (globalThis as { localStorage?: unknown }).localStorage;
  }
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else delete (globalThis as { window?: unknown }).window;
  if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
  else delete (globalThis as { document?: unknown }).document;
  if (originalHistory) Object.defineProperty(globalThis, 'history', originalHistory);
  else delete (globalThis as { history?: unknown }).history;
  if (originalRequestAnimationFrame) Object.defineProperty(globalThis, 'requestAnimationFrame', originalRequestAnimationFrame);
  else delete (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame;
  if (originalCancelAnimationFrame) Object.defineProperty(globalThis, 'cancelAnimationFrame', originalCancelAnimationFrame);
  else delete (globalThis as { cancelAnimationFrame?: unknown }).cancelAnimationFrame;
  resetMissionGlobals();
});

describe('mission preset definitions', () => {
  it('defines the v1 role presets with stable ids', () => {
    assert.deepEqual(
      MISSION_PRESETS.map((preset) => preset.id),
      [
        'crisis-desk',
        'supply-chain-risk',
        'energy-security',
        'osint-newsroom',
        'macro-market-watch',
        'tech-ai-watch',
        'good-news-explorer',
      ],
    );
  });

  it('uses approachable first-run labels for broad audience personas', () => {
    assert.equal(getMissionPreset('osint-newsroom')?.label, 'News Seeker');
    assert.equal(getMissionPreset('osint-newsroom')?.shortLabel, 'News');
    assert.equal(getMissionPreset('macro-market-watch')?.label, 'Stock Geek');
    assert.equal(getMissionPreset('macro-market-watch')?.shortLabel, 'Stocks');
    assert.equal(getMissionPreset('tech-ai-watch')?.label, 'Tech / AI Watcher');
    assert.equal(getMissionPreset('tech-ai-watch')?.shortLabel, 'Tech');
    assert.equal(getMissionPreset('good-news-explorer')?.label, 'Good News Explorer');
    assert.equal(getMissionPreset('good-news-explorer')?.shortLabel, 'Good');
  });

  it('uses known panel and layer keys without duplicate ids', () => {
    const ids = new Set<string>();
    for (const preset of MISSION_PRESETS) {
      assert.equal(ids.has(preset.id), false, `${preset.id} is duplicated`);
      ids.add(preset.id);
      assert.ok(preset.label.length > 0, `${preset.id} needs a label`);
      assert.ok(preset.description.length > 0, `${preset.id} needs a description`);
      assert.ok(preset.panels.includes('map'), `${preset.id} must include the map panel`);
      assert.ok(preset.panels.length > 3, `${preset.id} should enable a useful panel set`);
      assert.ok(preset.layers.length > 0, `${preset.id} should enable map layers`);
      assert.equal(new Set(preset.panels).size, preset.panels.length, `${preset.id} repeats panel ids`);
      assert.equal(new Set(preset.layers).size, preset.layers.length, `${preset.id} repeats layer ids`);

      for (const panelId of preset.panels) {
        assert.ok(ALL_PANELS[panelId], `${preset.id} references unknown panel ${panelId}`);
      }
      for (const layerId of preset.layers) {
        assert.ok(LAYER_REGISTRY[layerId], `${preset.id} references unknown layer ${String(layerId)}`);
      }
    }
  });

  it('returns null for unknown preset ids', () => {
    assert.equal(getMissionPreset('missing'), null);
    assert.equal(getMissionPreset(null), null);
  });
});

describe('applyMissionPresetToState', () => {
  it('applies a coherent full-variant preset while preserving dynamic panels', () => {
    const current = makePanelSettings('full');
    const applied = applyMissionPresetToState('crisis-desk', current, DEFAULT_MAP_LAYERS, 'full');

    assert.equal(applied.preset.id, 'crisis-desk');
    assert.equal(applied.panelSettings.map?.enabled, true);
    assert.equal(applied.panelSettings['live-news']?.enabled, true);
    assert.equal(applied.panelSettings['strategic-risk']?.enabled, true);
    assert.equal(applied.panelSettings.markets?.enabled, false);
    assert.equal(applied.panelSettings['cw-market-note']?.enabled, true);
    assert.equal(applied.panelSettings['mcp-risk-feed']?.enabled, false);
    assert.deepEqual(applied.panelOrder.slice(0, 5), [
      'live-news',
      'insights',
      'strategic-posture',
      'cii',
      'strategic-risk',
    ]);
    assert.equal(applied.mapLayers.conflicts, true);
    assert.equal(applied.mapLayers.ciiChoropleth, true);
  });

  it('filters enabled panels to the active variant instead of creating mini-variants', () => {
    for (const variant of VARIANTS) {
      const allowedPanels = new Set(VARIANT_DEFAULTS[variant] ?? []);
      for (const preset of MISSION_PRESETS) {
        const applied = applyMissionPresetToState(
          preset.id,
          makePanelSettings(variant),
          DEFAULT_MAP_LAYERS,
          variant,
        );
        for (const panelId of enabledPanelKeys(applied.panelSettings)) {
          if (panelId === 'map' || panelId === 'runtime-config' || panelId.startsWith('cw-') || panelId.startsWith('mcp-')) {
            continue;
          }
          assert.ok(
            allowedPanels.has(panelId),
            `${preset.id} enabled ${panelId} outside ${variant} variant defaults`,
          );
        }
      }
    }
  });

  it('falls back to variant defaults when a preset has too few matching panels', () => {
    for (const preset of MISSION_PRESETS.filter((preset) => preset.id !== 'good-news-explorer')) {
      const applied = applyMissionPresetToState(
        preset.id,
        makePanelSettings('happy'),
        DEFAULT_MAP_LAYERS,
        'happy',
      );
      assert.deepEqual(
        enabledWorkspacePanelKeys(applied.panelSettings),
        defaultWorkspacePanelKeys('happy'),
        `happy/${preset.id} should fall back to happy defaults`,
      );
    }

    const happyApplied = applyMissionPresetToState(
      'good-news-explorer',
      makePanelSettings('happy'),
      DEFAULT_MAP_LAYERS,
      'happy',
    );
    assert.deepEqual(happyApplied.panelOrder.slice(0, 4), [
      'positive-feed',
      'progress',
      'counters',
      'spotlight',
    ]);
    assert.equal(happyApplied.mapLayers.positiveEvents, true);
    assert.equal(happyApplied.mapLayers.speciesRecovery, true);

    const techApplied = applyMissionPresetToState(
      'tech-ai-watch',
      makePanelSettings('tech'),
      DEFAULT_MAP_LAYERS,
      'tech',
    );
    assert.deepEqual(techApplied.panelOrder.slice(0, 5), [
      'live-news',
      'insights',
      'ai',
      'tech',
      'startups',
    ]);
    assert.equal(techApplied.mapLayers.datacenters, true);
    assert.equal(techApplied.mapLayers.startupHubs, true);

    for (const [variant, presetId] of [
      ['tech', 'energy-security'],
      ['commodity', 'osint-newsroom'],
      ['energy', 'osint-newsroom'],
    ] as const) {
      const applied = applyMissionPresetToState(
        presetId,
        makePanelSettings(variant),
        DEFAULT_MAP_LAYERS,
        variant,
      );
      assert.deepEqual(
        enabledWorkspacePanelKeys(applied.panelSettings),
        defaultWorkspacePanelKeys(variant),
        `${variant}/${presetId} should fall back to ${variant} defaults`,
      );
    }
  });

  it('never applies a preset as an empty or single-panel workspace across variants', () => {
    for (const variant of VARIANTS) {
      for (const preset of MISSION_PRESETS) {
        const applied = applyMissionPresetToState(
          preset.id,
          makePanelSettings(variant),
          DEFAULT_MAP_LAYERS,
          variant,
        );
        assert.ok(
          enabledWorkspacePanelKeys(applied.panelSettings).length >= 2,
          `${variant}/${preset.id} should keep a useful workspace`,
        );
      }
    }
  });

  it('sanitizes preset layers through each variant allowlist', () => {
    for (const variant of VARIANTS) {
      const allowedLayers = getAllowedLayerKeys(variant);
      for (const preset of MISSION_PRESETS) {
        const applied = applyMissionPresetToState(
          preset.id,
          makePanelSettings(variant),
          DEFAULT_MAP_LAYERS,
          variant,
        );
        for (const [layerId, enabled] of Object.entries(applied.mapLayers)) {
          if (!enabled) continue;
          assert.ok(
            allowedLayers.has(layerId as keyof typeof LAYER_REGISTRY),
            `${preset.id} enabled layer ${layerId} outside ${variant} allowlist`,
          );
        }
      }
    }
  });
});

describe('resetMissionPresetState', () => {
  it('restores active variant defaults and preserves dynamic panels', () => {
    const current = makePanelSettings('full');
    current['live-news']!.enabled = false;
    current.markets!.enabled = true;
    current['cw-market-note']!.enabled = true;

    const reset = resetMissionPresetState(current, DEFAULT_MAP_LAYERS, 'full');

    assert.deepEqual(reset.panelOrder, VARIANT_DEFAULTS.full.filter((key) => key !== 'map'));
    assert.equal(reset.panelSettings.map?.enabled, true);
    assert.equal(reset.panelSettings['live-news']?.enabled, getEffectivePanelConfig('live-news', 'full').enabled);
    assert.equal(reset.panelSettings['energy-risk-overview']?.enabled, false);
    assert.equal(reset.panelSettings['cw-market-note']?.enabled, true);
    assert.deepEqual(reset.mapLayers, DEFAULT_MAP_LAYERS);
  });
});

describe('mission preset renderer filtering', () => {
  it('removes DeckGL-only energy layers on the mobile/SVG fallback path', () => {
    const applied = applyMissionPresetToState(
      'energy-security',
      makePanelSettings('energy'),
      DEFAULT_MAP_LAYERS,
      'energy',
    );

    assert.equal(applied.mapLayers.storageFacilities, true);
    assert.equal(applied.mapLayers.fuelShortages, true);
    assert.equal(applied.mapLayers.liveTankers, true);

    const filtered = filterMissionLayersForRenderer(applied.mapLayers, 'flat', false, DEFAULT_MAP_LAYERS);

    assert.equal(filtered.storageFacilities, false);
    assert.equal(filtered.fuelShortages, false);
    assert.equal(filtered.liveTankers, false);
    assert.ok(Object.values(filtered).some(Boolean), 'renderer filtering should keep executable context layers');
  });

  it('also filters fallback layers when every preset layer is renderer-incompatible', () => {
    const presetLayers = { ...DEFAULT_MAP_LAYERS };
    for (const key of Object.keys(presetLayers) as Array<keyof typeof presetLayers>) {
      presetLayers[key] = false;
    }
    presetLayers.storageFacilities = true;

    const fallbackLayers = { ...DEFAULT_MAP_LAYERS, storageFacilities: true };
    const filtered = filterMissionLayersForRenderer(presetLayers, 'flat', false, fallbackLayers);

    assert.equal(filtered.storageFacilities, false);
    assert.ok(Object.values(filtered).some(Boolean), 'filtered fallback should keep executable default layers');
  });

  it('removes supply-chain resilienceScore on the mobile/SVG fallback path', () => {
    const applied = applyMissionPresetToState(
      'supply-chain-risk',
      makePanelSettings('full'),
      DEFAULT_MAP_LAYERS,
      'full',
    );

    assert.equal(applied.mapLayers.resilienceScore, true);

    const filtered = filterMissionLayersForRenderer(applied.mapLayers, 'flat', false, DEFAULT_MAP_LAYERS);

    assert.equal(filtered.resilienceScore, false);
    assert.equal(filtered.tradeRoutes, true);
    assert.ok(Object.values(filtered).some(Boolean), 'renderer filtering should keep executable supply-chain layers');
  });
});

describe('mission preset persistence', () => {
  it('saves, loads, clears, and dismisses mission state', () => {
    assert.equal(loadStoredMissionPreset(), null);
    assert.equal(isMissionPresetPromptDismissed(), false);

    saveMissionPreset('crisis-desk');

    assert.equal(localStorage.getItem(MISSION_PRESET_STORAGE_KEY), 'crisis-desk');
    assert.equal(localStorage.getItem(MISSION_PRESET_DISMISSED_KEY), '1');
    assert.equal(loadStoredMissionPreset()?.id, 'crisis-desk');
    assert.equal(isMissionPresetPromptDismissed(), true);

    clearMissionPreset();

    assert.equal(loadStoredMissionPreset(), null);
    assert.equal(localStorage.getItem(MISSION_PRESET_STORAGE_KEY), null);
    assert.equal(isMissionPresetPromptDismissed(), true);
  });

  it('treats unknown stored ids as absent', () => {
    localStorage.setItem(MISSION_PRESET_STORAGE_KEY, 'stale');

    assert.equal(loadStoredMissionPreset(), null);
  });

  it('does not throw when storage is unavailable', () => {
    defineLocalStorage({
      getItem() { throw new Error('blocked'); },
      setItem() { throw new Error('blocked'); },
      removeItem() { throw new Error('blocked'); },
    });

    assert.doesNotThrow(() => saveMissionPreset('crisis-desk'));
    assert.doesNotThrow(() => clearMissionPreset());
    assert.doesNotThrow(() => dismissMissionPresetPrompt());
    assert.equal(loadStoredMissionPreset(), null);
    assert.equal(isMissionPresetPromptDismissed(), true);
  });
});

type MissionTestCallbacks = {
  appliedOrders: string[][];
  loadDataForLayer: string[];
  stopLayerActivity: string[];
  loadAllDataCalls: number;
  syncDataFreshnessCalls: number;
  mountLiveNewsCalls: number;
  waitForAisCalls: number;
};

type MissionHarness = {
  ctx: {
    panelSettings: Record<string, PanelConfig>;
    mapLayers: MapLayers;
    map: ReturnType<typeof makeMapSpy>;
    unifiedSettings: { refreshes: number; refreshPanelToggles(): void };
  };
  callbacks: MissionTestCallbacks;
  manager: EventHandlerManagerCtor extends new (...args: unknown[]) => infer Instance ? Instance & Record<string, (arg?: unknown) => void> : never;
  storage: MemoryStorage;
};

function activeLayers(layers: MapLayers): string[] {
  return Object.entries(layers)
    .filter(([, enabled]) => enabled)
    .map(([key]) => key)
    .sort();
}

function readJsonStorage<T>(key: string): T {
  const raw = localStorage.getItem(key);
  assert.ok(raw, `${key} should be persisted`);
  return JSON.parse(raw) as T;
}

function latestUrl(): URL {
  const history = globalThis.history as unknown as { latestUrl: string };
  assert.ok(history.latestUrl, 'URL state should have been synced');
  return new URL(history.latestUrl);
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForMissionTimers(): Promise<void> {
  await wait(320);
}

function makeMapSpy(options: { isGlobe?: boolean; isDeckGLActive?: boolean } = {}) {
  const state = {
    view: 'global',
    zoom: 2.3,
    timeRange: '7d',
    layers: { ...DEFAULT_MAP_LAYERS },
  };
  const calls = {
    setLayers: [] as MapLayers[],
    setView: [] as Array<{ view: string; zoom?: number }>,
    setTimeRange: [] as string[],
    setLayerLoading: [] as Array<{ layer: string; loading: boolean }>,
  };
  return {
    calls,
    setLayers(layers: MapLayers) {
      calls.setLayers.push({ ...layers });
      state.layers = { ...layers };
    },
    setView(view: string, zoom?: number) {
      calls.setView.push({ view, zoom });
      state.view = view;
      state.zoom = zoom ?? (view === 'global' ? 2.3 : state.zoom);
    },
    setTimeRange(timeRange: string) {
      calls.setTimeRange.push(timeRange);
      state.timeRange = timeRange;
    },
    getState() {
      return { ...state };
    },
    getCenter() {
      return { lat: 0, lon: 0 };
    },
    isGlobeMode() {
      return options.isGlobe ?? false;
    },
    isDeckGLActive() {
      return options.isDeckGLActive ?? true;
    },
    setLayerLoading(layer: string, loading: boolean) {
      calls.setLayerLoading.push({ layer, loading });
    },
  };
}

function createMissionHarness(options: { mobile?: boolean; storage?: MemoryStorage; map?: ReturnType<typeof makeMapSpy> } = {}): MissionHarness {
  const storage = options.storage ?? new MemoryStorage();
  defineLocalStorage(storage);
  const document = defineBrowserGlobals();
  const mount = document.createElement('span');
  mount.id = 'missionPresetMount';
  document.body.appendChild(mount);

  const callbacks: MissionTestCallbacks = {
    appliedOrders: [],
    loadDataForLayer: [],
    stopLayerActivity: [],
    loadAllDataCalls: 0,
    syncDataFreshnessCalls: 0,
    mountLiveNewsCalls: 0,
    waitForAisCalls: 0,
  };
  const unifiedSettings = {
    refreshes: 0,
    refreshPanelToggles() {
      this.refreshes += 1;
    },
  };
  const ctx = {
    map: options.map ?? makeMapSpy(),
    isMobile: options.mobile ?? false,
    isDesktopApp: false,
    container: document.body,
    panels: {},
    newsPanels: {},
    panelSettings: makePanelSettings('full'),
    mapLayers: { ...DEFAULT_MAP_LAYERS },
    allNews: [],
    newsByCategory: {},
    latestMarkets: [],
    latestPredictions: [],
    latestClusters: [],
    intelligenceCache: {},
    cyberThreatsCache: null,
    disabledSources: new Set<string>(),
    currentTimeRange: '7d',
    inFlight: new Set<string>(),
    seenGeoAlerts: new Set<string>(),
    monitors: [],
    signalModal: null,
    statusPanel: null,
    searchModal: null,
    findingsBadge: null,
    breakingBanner: null,
    playbackControl: null,
    exportPanel: null,
    unifiedSettings,
    pizzintIndicator: null,
    correlationEngine: null,
    llmStatusIndicator: null,
    countryBriefPage: null,
    countryTimeline: null,
    positivePanel: null,
    countersPanel: null,
    progressPanel: null,
    breakthroughsPanel: null,
    heroPanel: null,
    digestPanel: null,
    speciesPanel: null,
    renewablePanel: null,
    authModal: null,
    authHeaderWidget: null,
    tvMode: null,
    happyAllItems: [],
    isDestroyed: false,
    isPlaybackMode: false,
    isIdle: false,
    initialLoadComplete: true,
    resolvedLocation: 'global',
    activeChokepoint: null,
    initialUrlState: null,
    PANEL_ORDER_KEY: 'panel-order',
    PANEL_SPANS_KEY: 'panel-spans',
  };

  const manager = new EventHandlerManager(ctx, {
    updateSearchIndex() {},
    loadAllData: async () => { callbacks.loadAllDataCalls += 1; },
    flushStaleRefreshes() {},
    setHiddenSince() {},
    loadDataForLayer: (layer: string) => callbacks.loadDataForLayer.push(layer),
    waitForAisData: () => { callbacks.waitForAisCalls += 1; },
    syncDataFreshnessWithLayers: () => { callbacks.syncDataFreshnessCalls += 1; },
    ensureCorrectZones() {},
    applySavedPanelOrder: (panelOrder?: string[]) => callbacks.appliedOrders.push([...(panelOrder ?? [])]),
    refreshCiiAfterFocalPointsReady() {},
    stopLayerActivity: (layer: keyof MapLayers) => callbacks.stopLayerActivity.push(String(layer)),
    mountLiveNewsIfReady: () => { callbacks.mountLiveNewsCalls += 1; },
  });

  return { ctx, callbacks, manager: manager as MissionHarness['manager'], storage };
}

describe('mission preset shell integration', () => {
  it('rechecks mission prompt eligibility before the idle auto-open fires', async () => {
    const { manager } = createMissionHarness();
    const opened: Array<{ anchor: unknown; mobile: unknown }> = [];

    manager.setupMissionPresets();
    manager.openMissionPresetPopover = (anchor: unknown, mobile: unknown) => {
      opened.push({ anchor, mobile });
    };

    const tasks = (globalThis as { __missionAfterPaintTasks?: Array<() => void> }).__missionAfterPaintTasks ?? [];
    assert.equal(tasks.length, 1, 'desktop startup should schedule one mission prompt idle task');

    saveMissionPreset('supply-chain-risk');
    tasks[0]!();

    assert.deepEqual(opened, [], 'stored mission state should cancel the delayed auto-open');
  });

  it('applies a preset through the real manager path and resets state, storage, layers, map view, and URL to defaults', async () => {
    const { ctx, callbacks, manager } = createMissionHarness();
    const baselineWorkspace = defaultWorkspacePanelKeys('full');
    const baselineLayers = activeLayers(DEFAULT_MAP_LAYERS);

    manager.applyMissionPreset('supply-chain-risk');
    await waitForMissionTimers();

    assert.equal(ctx.panelSettings['supply-chain']?.enabled, true);
    assert.equal(ctx.panelSettings.markets?.enabled, true);
    assert.equal(ctx.panelSettings['live-news']?.enabled, false);
    assert.deepEqual(callbacks.appliedOrders[0]?.slice(0, 3), ['supply-chain', 'hormuz-tracker', 'cascade']);
    assert.equal(localStorage.getItem(MISSION_PRESET_STORAGE_KEY), 'supply-chain-risk');
    assert.deepEqual(readJsonStorage<string[]>('panel-order'), callbacks.appliedOrders[0]);
    assert.equal(readJsonStorage<MapLayers>('worldmonitor-layers').tradeRoutes, true);
    assert.equal(readJsonStorage<MapLayers>('worldmonitor-layers').resilienceScore, true);
    assert.deepEqual(ctx.map.calls.setView.at(-1), { view: 'global', zoom: 2.3 });
    assert.equal(ctx.map.calls.setTimeRange.at(-1), '7d');
    assert.equal(callbacks.waitForAisCalls, 1, 'AIS layer enable should initialize the AIS stream path');
    assert.ok(callbacks.loadDataForLayer.includes('tradeRoutes'), 'newly enabled non-AIS layers should load data');
    assert.ok(
      ((globalThis as { __missionAnalytics?: Array<{ name: string; args: unknown[] }> }).__missionAnalytics ?? [])
        .some((entry) => entry.name === 'trackMapLayerToggle' && entry.args[0] === 'tradeRoutes' && entry.args[1] === true),
      'programmatic layer analytics should be emitted for apply transitions',
    );
    assert.equal(latestUrl().searchParams.get('layers')?.includes('tradeRoutes'), true);

    manager.resetMissionPreset();
    await waitForMissionTimers();

    assert.equal(localStorage.getItem(MISSION_PRESET_STORAGE_KEY), null);
    assert.deepEqual(enabledWorkspacePanelKeys(ctx.panelSettings), baselineWorkspace);
    assert.deepEqual(activeLayers(ctx.mapLayers), baselineLayers);
    assert.deepEqual(readJsonStorage<string[]>('panel-order'), VARIANT_DEFAULTS.full.filter((key) => key !== 'map'));
    assert.deepEqual(activeLayers(readJsonStorage<MapLayers>('worldmonitor-layers')), baselineLayers);
    assert.deepEqual(callbacks.appliedOrders.at(-1), VARIANT_DEFAULTS.full.filter((key) => key !== 'map'));
    assert.deepEqual(ctx.map.calls.setView.at(-1), { view: 'global', zoom: undefined });
    assert.equal(ctx.map.calls.setTimeRange.at(-1), '7d');
    assert.ok(callbacks.stopLayerActivity.includes('tradeRoutes'), 'reset should stop layers the preset enabled');
    assert.deepEqual((globalThis as { __missionAis?: string[] }).__missionAis, ['init', 'disconnect']);
    assert.equal(latestUrl().searchParams.get('view'), 'global');
    assert.equal(latestUrl().searchParams.get('timeRange'), '7d');
    assert.deepEqual((latestUrl().searchParams.get('layers') ?? '').split(',').sort(), baselineLayers);
  });

  it('filters renderer-incompatible preset layers before persisting or running side effects on the mobile fallback renderer', async () => {
    const { ctx, callbacks, manager } = createMissionHarness({
      mobile: true,
      map: makeMapSpy({ isDeckGLActive: false }),
    });

    manager.applyMissionPreset('supply-chain-risk');
    await waitForMissionTimers();

    assert.equal(ctx.mapLayers.resilienceScore, false);
    assert.equal(readJsonStorage<MapLayers>('worldmonitor-layers').resilienceScore, false);
    assert.equal(ctx.mapLayers.tradeRoutes, true);
    assert.ok(callbacks.loadDataForLayer.includes('tradeRoutes'));
    assert.equal(callbacks.loadDataForLayer.includes('resilienceScore'), false);
    assert.equal(callbacks.stopLayerActivity.includes('resilienceScore'), false);
  });

  it('filters AIS before persisting a mission preset when AIS is not configured', async () => {
    (globalThis as { __missionAisConfigured?: boolean }).__missionAisConfigured = false;
    const { ctx, callbacks, manager } = createMissionHarness();

    manager.applyMissionPreset('supply-chain-risk');
    await waitForMissionTimers();

    assert.equal(ctx.mapLayers.ais, false);
    assert.equal(readJsonStorage<MapLayers>('worldmonitor-layers').ais, false);
    assert.equal(callbacks.waitForAisCalls, 0);
    assert.deepEqual((globalThis as { __missionAis?: string[] }).__missionAis, undefined);
    assert.equal((latestUrl().searchParams.get('layers') ?? '').split(',').includes('ais'), false);
    assert.equal(ctx.mapLayers.tradeRoutes, true);
  });

  it('still applies in-memory panel order and reset order when storage writes fail', async () => {
    const storage = new MemoryStorage();
    storage.throwOnSet = true;
    const { ctx, callbacks, manager } = createMissionHarness({ storage });

    assert.doesNotThrow(() => manager.applyMissionPreset('macro-market-watch'));
    await waitForMissionTimers();

    assert.equal(ctx.panelSettings.markets?.enabled, true);
    assert.deepEqual(callbacks.appliedOrders[0]?.slice(0, 4), ['markets', 'heatmap', 'market-breadth', 'earnings-calendar']);
    assert.equal(localStorage.getItem(MISSION_PRESET_STORAGE_KEY), null);

    assert.doesNotThrow(() => manager.resetMissionPreset());
    await waitForMissionTimers();

    assert.deepEqual(enabledWorkspacePanelKeys(ctx.panelSettings), defaultWorkspacePanelKeys('full'));
    assert.deepEqual(callbacks.appliedOrders.at(-1), VARIANT_DEFAULTS.full.filter((key) => key !== 'map'));
  });
});
