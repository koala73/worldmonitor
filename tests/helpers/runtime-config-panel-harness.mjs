import { build } from 'esbuild';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..', '..');
const entry = resolve(root, 'src/components/RuntimeConfigPanel.ts');

class MiniClassList {
  constructor() {
    this.values = new Set();
  }

  add(...tokens) {
    tokens.forEach((token) => this.values.add(token));
  }

  remove(...tokens) {
    tokens.forEach((token) => this.values.delete(token));
  }

  contains(token) {
    return this.values.has(token);
  }

  toggle(token, force) {
    if (force === true) {
      this.values.add(token);
      return true;
    }
    if (force === false) {
      this.values.delete(token);
      return false;
    }
    if (this.values.has(token)) {
      this.values.delete(token);
      return false;
    }
    this.values.add(token);
    return true;
  }

  setFromString(value) {
    this.values = new Set(String(value).split(/\s+/).filter(Boolean));
  }

  toString() {
    return Array.from(this.values).join(' ');
  }
}

class MiniNode extends EventTarget {
  constructor() {
    super();
    this.childNodes = [];
    this.parentNode = null;
    this.parentElement = null;
  }

  appendChild(child) {
    if (child instanceof MiniDocumentFragment) {
      const children = [...child.childNodes];
      children.forEach((node) => this.appendChild(node));
      return child;
    }
    if (child.parentNode) {
      child.parentNode.removeChild(child);
    }
    child.parentNode = this;
    child.parentElement = this instanceof MiniElement ? this : null;
    this.childNodes.push(child);
    return child;
  }

  append(...children) {
    children.forEach((child) => {
      if (child == null) return;
      if (typeof child === 'string' || typeof child === 'number') {
        this.appendChild(new MiniText(child));
        return;
      }
      this.appendChild(child);
    });
  }

  removeChild(child) {
    const index = this.childNodes.indexOf(child);
    if (index >= 0) {
      this.childNodes.splice(index, 1);
      child.parentNode = null;
      child.parentElement = null;
    }
    return child;
  }

  insertBefore(child, referenceNode) {
    if (referenceNode == null) {
      return this.appendChild(child);
    }
    if (child.parentNode) {
      child.parentNode.removeChild(child);
    }
    const index = this.childNodes.indexOf(referenceNode);
    if (index === -1) {
      return this.appendChild(child);
    }
    child.parentNode = this;
    child.parentElement = this instanceof MiniElement ? this : null;
    this.childNodes.splice(index, 0, child);
    return child;
  }

  get firstChild() {
    return this.childNodes[0] ?? null;
  }

  get lastChild() {
    return this.childNodes.at(-1) ?? null;
  }

  get firstElementChild() {
    return this.childNodes.find((child) => child instanceof MiniElement) ?? null;
  }

  get lastElementChild() {
    return [...this.childNodes].reverse().find((child) => child instanceof MiniElement) ?? null;
  }

  get childElementCount() {
    return this.childNodes.filter((child) => child instanceof MiniElement).length;
  }

  get textContent() {
    return this.childNodes.map((child) => child.textContent ?? '').join('');
  }

  set textContent(value) {
    this.childNodes = [new MiniText(value ?? '')];
  }

  replaceChildren(...children) {
    this.childNodes = [];
    this.append(...children);
  }
}

class MiniText extends MiniNode {
  constructor(value) {
    super();
    this.value = String(value);
  }

  get textContent() {
    return this.value;
  }

  set textContent(value) {
    this.value = String(value);
  }

  get outerHTML() {
    return this.value;
  }
}

class MiniDocumentFragment extends MiniNode {
  get outerHTML() {
    return this.childNodes.map((child) => child.outerHTML ?? child.textContent ?? '').join('');
  }
}

class MiniElement extends MiniNode {
  constructor(tagName) {
    super();
    this.tagName = tagName.toUpperCase();
    this.attributes = new Map();
    this.classList = new MiniClassList();
    this.dataset = {};
    this.style = {};
    this._innerHTML = '';
    this.id = '';
    this.title = '';
    this.disabled = false;
  }

  get className() {
    return this.classList.toString();
  }

  set className(value) {
    this.classList.setFromString(value);
  }

  get innerHTML() {
    if (this._innerHTML) return this._innerHTML;
    return this.childNodes.map((child) => child.outerHTML ?? child.textContent ?? '').join('');
  }

  set innerHTML(value) {
    this._innerHTML = String(value);
    this.childNodes = [];
  }

  appendChild(child) {
    this._innerHTML = '';
    return super.appendChild(child);
  }

  insertBefore(child, referenceNode) {
    this._innerHTML = '';
    return super.insertBefore(child, referenceNode);
  }

  removeChild(child) {
    this._innerHTML = '';
    return super.removeChild(child);
  }

  setAttribute(name, value) {
    const stringValue = String(value);
    this.attributes.set(name, stringValue);
    if (name === 'class') {
      this.className = stringValue;
    } else if (name === 'id') {
      this.id = stringValue;
    } else if (name.startsWith('data-')) {
      const key = name
        .slice(5)
        .split('-')
        .map((part, index) => (index === 0 ? part : `${part[0]?.toUpperCase() ?? ''}${part.slice(1)}`))
        .join('');
      this.dataset[key] = stringValue;
    }
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  hasAttribute(name) {
    return this.attributes.has(name);
  }

  removeAttribute(name) {
    this.attributes.delete(name);
    if (name === 'class') this.className = '';
  }

  matches(selector) {
    return matchesSelector(this, selector);
  }

  querySelector(selector) {
    return querySelectorAll(this, selector)[0] ?? null;
  }

  querySelectorAll(selector) {
    return querySelectorAll(this, selector);
  }

  closest(selector) {
    let current = this;
    while (current instanceof MiniElement) {
      if (current.matches(selector)) return current;
      current = current.parentElement;
    }
    return null;
  }

  remove() {
    if (this.parentNode) {
      this.parentNode.removeChild(this);
    }
  }

  getBoundingClientRect() {
    return { width: 1, height: 1, top: 0, left: 0, right: 1, bottom: 1 };
  }

  focus() {
    const doc = this.ownerDocument ?? globalThis.document;
    if (doc) doc.activeElement = this;
  }

  get nextElementSibling() {
    if (!this.parentNode) return null;
    const siblings = this.parentNode.childNodes.filter((child) => child instanceof MiniElement);
    const index = siblings.indexOf(this);
    return index >= 0 ? siblings[index + 1] ?? null : null;
  }

  get isConnected() {
    let current = this.parentNode;
    while (current) {
      if (current === globalThis.document?.body || current === globalThis.document?.documentElement) {
        return true;
      }
      current = current.parentNode;
    }
    return false;
  }

  get outerHTML() {
    return `<${this.tagName.toLowerCase()}>${this.innerHTML}</${this.tagName.toLowerCase()}>`;
  }

  get children() {
    return this.childNodes.filter((child) => child instanceof MiniElement);
  }

  get offsetParent() {
    return this.isConnected ? (this.parentElement ?? null) : null;
  }
}

class MiniStorage {
  constructor() {
    this.values = new Map();
  }

  getItem(key) {
    return this.values.has(key) ? this.values.get(key) : null;
  }

  setItem(key, value) {
    this.values.set(key, String(value));
  }

  removeItem(key) {
    this.values.delete(key);
  }

  clear() {
    this.values.clear();
  }
}

class MiniDocument extends EventTarget {
  constructor() {
    super();
    this.documentElement = new MiniElement('html');
    this.documentElement.clientHeight = 800;
    this.documentElement.clientWidth = 1200;
    this.body = new MiniElement('body');
    this.documentElement.ownerDocument = this;
    this.body.ownerDocument = this;
    this.documentElement.appendChild(this.body);
    this.activeElement = this.body;
  }

  createElement(tagName) {
    const element = new MiniElement(tagName);
    element.ownerDocument = this;
    return element;
  }

  createTextNode(value) {
    return new MiniText(value);
  }

  createDocumentFragment() {
    return new MiniDocumentFragment();
  }

  getElementById(id) {
    return querySelectorAll(this.documentElement, `#${id}`)[0] ?? null;
  }

  querySelector(selector) {
    return this.documentElement.querySelector(selector);
  }

  querySelectorAll(selector) {
    return this.documentElement.querySelectorAll(selector);
  }
}

function splitSelectorList(selector) {
  return String(selector)
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

function parseSimpleSelector(selector) {
  const trimmed = selector.trim();
  const result = {
    tag: null,
    id: null,
    classes: [],
    attributes: [],
    notAttributes: [],
  };
  let remaining = trimmed;

  const tagMatch = remaining.match(/^[a-zA-Z][a-zA-Z0-9-]*/);
  if (tagMatch) {
    result.tag = tagMatch[0].toUpperCase();
    remaining = remaining.slice(tagMatch[0].length);
  }

  while (remaining.length > 0) {
    if (remaining.startsWith('#')) {
      const match = remaining.match(/^#([A-Za-z0-9_-]+)/);
      if (!match) break;
      result.id = match[1];
      remaining = remaining.slice(match[0].length);
      continue;
    }

    if (remaining.startsWith('.')) {
      const match = remaining.match(/^\.([A-Za-z0-9_-]+)/);
      if (!match) break;
      result.classes.push(match[1]);
      remaining = remaining.slice(match[0].length);
      continue;
    }

    if (remaining.startsWith(':not(')) {
      const match = remaining.match(/^:not\(\[([^\]=]+)(?:="([^"]*)")?\]\)/);
      if (!match) break;
      result.notAttributes.push({ name: match[1], value: match[2] ?? null });
      remaining = remaining.slice(match[0].length);
      continue;
    }

    if (remaining.startsWith('[')) {
      const match = remaining.match(/^\[([^\]=]+)(?:="([^"]*)")?\]/);
      if (!match) break;
      result.attributes.push({ name: match[1], value: match[2] ?? null });
      remaining = remaining.slice(match[0].length);
      continue;
    }

    break;
  }

  return result;
}

function matchesSelector(element, selector) {
  return splitSelectorList(selector).some((part) => {
    const parsed = parseSimpleSelector(part);
    if (parsed.tag && element.tagName !== parsed.tag) return false;
    if (parsed.id && element.id !== parsed.id) return false;
    if (parsed.classes.some((name) => !element.classList.contains(name))) return false;
    if (parsed.attributes.some(({ name, value }) => {
      if (!element.hasAttribute(name)) return true;
      return value != null && element.getAttribute(name) !== value;
    })) return false;
    if (parsed.notAttributes.some(({ name, value }) => {
      if (!element.hasAttribute(name)) return false;
      return value == null ? true : element.getAttribute(name) === value;
    })) return false;
    return true;
  });
}

function querySelectorAll(root, selector) {
  const matches = [];

  function visit(node) {
    if (!(node instanceof MiniElement)) return;
    if (node.matches(selector)) {
      matches.push(node);
    }
    node.childNodes.forEach(visit);
  }

  if (root instanceof MiniElement) {
    root.childNodes.forEach(visit);
    return matches;
  }

  root.childNodes.forEach(visit);
  return matches;
}

export function createBrowserEnvironment() {
  const document = new MiniDocument();
  const localStorage = new MiniStorage();
  const window = {
    document,
    localStorage,
    innerHeight: 800,
    innerWidth: 1200,
    addEventListener() {},
    removeEventListener() {},
    open() {},
    location: {
      origin: 'https://worldmonitor.test',
      href: 'https://worldmonitor.test/',
    },
    navigator: {
      clipboard: {
        async writeText() {},
      },
    },
    getComputedStyle() {
      return {
        display: '',
        visibility: '',
        gridTemplateColumns: 'none',
        columnGap: '0',
      };
    },
  };

  return {
    document,
    localStorage,
    window,
    requestAnimationFrame(callback) {
      if (typeof callback === 'function') callback(0);
      return 1;
    },
    cancelAnimationFrame() {},
    HTMLElement: MiniElement,
    HTMLButtonElement: MiniElement,
  };
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

      export function safeHtml() {
        return document.createDocumentFragment();
      }
    `],
    ['analytics-stub', `export function trackPanelResized() {} export function trackFeatureToggle() {}`],
    ['ai-flow-settings-stub', `export function getAiFlowSettings() { return { badgeAnimation: false }; }`],
    ['sanitize-stub', `export function escapeHtml(value) { return String(value); }`],
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
