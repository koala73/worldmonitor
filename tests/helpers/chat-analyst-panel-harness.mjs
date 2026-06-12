import { build } from 'esbuild';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createBrowserEnvironment } from './runtime-config-panel-harness.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..', '..');
const entry = resolve(root, 'src/components/ChatAnalystPanel.ts');

function snapshotGlobal(name) {
  return {
    exists: Object.prototype.hasOwnProperty.call(globalThis, name),
    value: globalThis[name],
  };
}

function restoreGlobal(name, snapshot) {
  if (snapshot.exists) {
    Object.defineProperty(globalThis, name, {
      configurable: true,
      writable: true,
      value: snapshot.value,
    });
    return;
  }
  delete globalThis[name];
}

function defineGlobal(name, value) {
  Object.defineProperty(globalThis, name, {
    configurable: true,
    writable: true,
    value,
  });
}

async function loadChatAnalystPanel() {
  const tempDir = mkdtempSync(join(tmpdir(), 'wm-chat-analyst-panel-'));
  const outfile = join(tempDir, 'ChatAnalystPanel.bundle.mjs');

  const stubModules = new Map([
    ['i18n-stub', `
      // Empty string for every key — skips Panel's infoTooltip safeHtml() path
      // (gated by \`if (options.infoTooltip)\`) which would otherwise crash the
      // MiniDocument template-element shim.
      export function t() { return ''; }
    `],
    ['runtime-stub', `
      export function isDesktopRuntime() { return false; }
    `],
    ['tauri-bridge-stub', `
      export function invokeTauri() { return Promise.reject(new Error('not wired in test')); }
    `],
    ['analytics-stub', `
      export function trackPanelResized() {}
      export function trackAnalystControlAction(actionType, status, reason) {
        globalThis.__wmAnalystControlTelemetry?.push({
          actionType,
          status,
          ...(reason ? { reason } : {}),
        });
      }
    `],
    ['ai-flow-settings-stub', `
      export function getAiFlowSettings() { return { badgeAnimation: false }; }
    `],
    ['runtime-config-stub', `
      export function getSecretState() { return { present: true }; }
    `],
    ['panel-gating-stub', `
      export const PanelGateReason = Object.freeze({
        NONE: 'none',
        ANONYMOUS: 'anonymous',
        FREE_TIER: 'free_tier',
      });
    `],
    ['premium-fetch-stub', `
      export function premiumFetch() { return Promise.reject(new Error('not wired in test')); }
    `],
    ['analyst-markdown-stub', `
      export function postProcessAnalystHtml(html) { return html; }
    `],
    ['marked-stub', `
      export const marked = { parse: (s) => s };
    `],
    ['dompurify-stub', `
      export default { sanitize: (s) => s };
    `],
    ['checkout-stub', `
      export function startCheckout() {}
    `],
    ['products-stub', `
      export const DEFAULT_UPGRADE_PRODUCT = 'pro';
    `],
  ]);

  const aliasMap = new Map([
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
    ['@/services/premium-fetch', 'premium-fetch-stub'],
    ['@/utils/analyst-markdown', 'analyst-markdown-stub'],
    ['@/services/checkout', 'checkout-stub'],
    ['@/config/products', 'products-stub'],
    ['marked', 'marked-stub'],
    ['dompurify', 'dompurify-stub'],
  ]);

  const plugin = {
    name: 'chat-analyst-panel-test-stubs',
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
    ChatAnalystPanel: mod.ChatAnalystPanel,
    cleanupBundle() {
      rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

export async function createChatAnalystPanelHarness() {
  const originalGlobals = {
    document: snapshotGlobal('document'),
    window: snapshotGlobal('window'),
    localStorage: snapshotGlobal('localStorage'),
    requestAnimationFrame: snapshotGlobal('requestAnimationFrame'),
    cancelAnimationFrame: snapshotGlobal('cancelAnimationFrame'),
    navigator: snapshotGlobal('navigator'),
    HTMLElement: snapshotGlobal('HTMLElement'),
    HTMLButtonElement: snapshotGlobal('HTMLButtonElement'),
    Node: snapshotGlobal('Node'),
  };
  const browserEnvironment = createBrowserEnvironment();

  // dom-utils.h() and appendChildren() branch on `instanceof Node`. The
  // browser harness models nodes via MiniNode (extends EventTarget), so we
  // hoist the MiniNode constructor to globalThis.Node so the instanceof
  // checks match. Walk up the prototype chain from MiniElement to find it.
  const MiniNode = Object.getPrototypeOf(browserEnvironment.HTMLElement.prototype).constructor;

  defineGlobal('document', browserEnvironment.document);
  defineGlobal('window', browserEnvironment.window);
  defineGlobal('localStorage', browserEnvironment.localStorage);
  defineGlobal('requestAnimationFrame', browserEnvironment.requestAnimationFrame);
  defineGlobal('cancelAnimationFrame', browserEnvironment.cancelAnimationFrame);
  defineGlobal('navigator', browserEnvironment.window.navigator);
  defineGlobal('HTMLElement', browserEnvironment.HTMLElement);
  defineGlobal('HTMLButtonElement', browserEnvironment.HTMLButtonElement);
  defineGlobal('Node', MiniNode);

  let ChatAnalystPanel;
  let cleanupBundle;
  try {
    ({ ChatAnalystPanel, cleanupBundle } = await loadChatAnalystPanel());
  } catch (error) {
    restoreGlobal('document', originalGlobals.document);
    restoreGlobal('window', originalGlobals.window);
    restoreGlobal('localStorage', originalGlobals.localStorage);
    restoreGlobal('requestAnimationFrame', originalGlobals.requestAnimationFrame);
    restoreGlobal('cancelAnimationFrame', originalGlobals.cancelAnimationFrame);
    restoreGlobal('navigator', originalGlobals.navigator);
    restoreGlobal('HTMLElement', originalGlobals.HTMLElement);
    restoreGlobal('HTMLButtonElement', originalGlobals.HTMLButtonElement);
    throw error;
  }

  function createPanel() {
    return new ChatAnalystPanel();
  }

  function cleanup() {
    cleanupBundle();
    restoreGlobal('document', originalGlobals.document);
    restoreGlobal('window', originalGlobals.window);
    restoreGlobal('localStorage', originalGlobals.localStorage);
    restoreGlobal('requestAnimationFrame', originalGlobals.requestAnimationFrame);
    restoreGlobal('cancelAnimationFrame', originalGlobals.cancelAnimationFrame);
    restoreGlobal('navigator', originalGlobals.navigator);
    restoreGlobal('HTMLElement', originalGlobals.HTMLElement);
    restoreGlobal('HTMLButtonElement', originalGlobals.HTMLButtonElement);
    restoreGlobal('Node', originalGlobals.Node);
  }

  return {
    document: browserEnvironment.document,
    createPanel,
    cleanup,
  };
}
