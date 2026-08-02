import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createBrowserEnvironment } from './helpers/runtime-config-panel-harness.mjs';
import {
  buildThreatTimelineState,
  describeThreatTimelineTrend,
  normalizeClusterStories,
  normalizeServerInsightStories,
  normalizeThreatLevel,
} from '../src/components/threat-timeline-utils.ts';
import type { ServerInsights } from '../src/services/insights-loader.ts';
import type { ClusteredEvent } from '../src/types/index.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const NOW_MS = Date.UTC(2026, 5, 10, 12, 0, 0);

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
  fetch: snapshotGlobal('fetch'),
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

after(() => {
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
  restoreGlobal('fetch', originalGlobals.fetch);
});

function isoDaysAgo(days: number): string {
  return new Date(NOW_MS - days * 24 * 60 * 60 * 1000).toISOString();
}

function serverStory(overrides = {}) {
  return {
    primaryTitle: 'Border clashes intensify near capital',
    primarySource: 'ACLED',
    primaryLink: 'https://example.com/story',
    pubDate: isoDaysAgo(0),
    sourceCount: 2,
    importanceScore: 42,
    velocity: { level: 'normal', sourcesPerHour: 1 },
    isAlert: false,
    category: 'conflict',
    threatLevel: 'high',
    countryCode: 'SD',
    ...overrides,
  };
}

function trendForStories(stories: ReturnType<typeof serverStory>[]) {
  const items = normalizeServerInsightStories({
    generatedAt: new Date(NOW_MS).toISOString(),
    topStories: stories,
  });
  const state = buildThreatTimelineState(items, { nowMs: NOW_MS });
  return describeThreatTimelineTrend(state.days);
}

function runtimeIsoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

function runtimeServerInsights(overrides: Partial<ServerInsights> = {}): ServerInsights {
  return {
    worldBrief: 'Threat timeline test brief',
    briefProvider: 'groq',
    status: 'ok' as const,
    topStories: [
      serverStory({
        primaryTitle: 'Fresh server-backed escalation',
        primarySource: 'ACLED',
        pubDate: runtimeIsoDaysAgo(0),
        threatLevel: 'critical',
      }),
    ],
    generatedAt: new Date().toISOString(),
    clusterCount: 1,
    multiSourceCount: 1,
    fastMovingCount: 0,
    ...overrides,
  };
}

function fallbackCluster(): ClusteredEvent {
  return {
    id: 'cluster-fallback-1',
    primaryTitle: 'Fallback protests spread after outage',
    primarySource: 'Regional RSS',
    primaryLink: 'https://example.com/fallback',
    sourceCount: 2,
    topSources: [{ name: 'Regional RSS', tier: 2, url: 'https://example.com/source' }],
    allItems: [],
    firstSeen: new Date(runtimeIsoDaysAgo(1)),
    lastUpdated: new Date(runtimeIsoDaysAgo(0)),
    isAlert: true,
    threat: { level: 'high', category: 'protest', confidence: 0.8, source: 'keyword' },
  };
}

function waitForPanelRender(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 180));
}

async function loadThreatTimelinePanelHarness() {
  const tempDir = mkdtempSync(join(tmpdir(), 'wm-threat-timeline-panel-'));
  const outfile = join(tempDir, 'ThreatTimelinePanel.bundle.mjs');
  const panelPath = resolve(root, 'src/components/ThreatTimelinePanel.ts').replace(/\\/g, '/');
  const insightsLoaderPath = resolve(root, 'src/services/insights-loader.ts').replace(/\\/g, '/');

  const virtualEntrySource = `
    export { ThreatTimelinePanel } from '${panelPath}';
    export { __resetServerInsightsCacheForTests } from '${insightsLoaderPath}';
  `;
  const stubModules = new Map<string, string>([
    ['i18n-stub', `
      export function t(key) {
        if (key === 'common.live') return 'Live';
        if (key === 'common.cached') return 'Cached';
        if (key === 'common.unavailable') return 'Unavailable';
        return key;
      }
    `],
    ['runtime-stub', `
      export function isDesktopRuntime() { return false; }
      export function toApiUrl(path) { return path; }
    `],
    ['tauri-bridge-stub', `export function invokeTauri() { return Promise.reject(new Error('not wired in test')); }`],
    ['analytics-stub', `export function trackPanelResized() {}`],
    ['ai-flow-settings-stub', `export function getAiFlowSettings() { return { badgeAnimation: false }; }`],
    ['runtime-config-stub', `export function getSecretState() { return { present: true }; }`],
    ['bootstrap-stub', `export function getHydratedData() { return null; }`],
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
    ['virtual-entry', virtualEntrySource],
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
    ['@/services/runtime-config', 'runtime-config-stub'],
    ['@/services/bootstrap', 'bootstrap-stub'],
    ['../utils/dom-utils', 'dom-utils-stub'],
    ['@/utils/dom-utils', 'dom-utils-stub'],
    ['@/services/panel-gating', 'panel-gating-stub'],
    ['@/services/checkout', 'checkout-stub'],
    ['@/config/products', 'products-stub'],
    ['virtual:threat-timeline-entry', 'virtual-entry'],
  ]);

  const plugin = {
    name: 'threat-timeline-panel-test-stubs',
    setup(buildApi: import('esbuild').PluginBuild) {
      buildApi.onResolve({ filter: /.*/ }, (args) => {
        const target = aliasMap.get(args.path);
        if (target) return { path: target, namespace: 'stub' };
        if (args.path.startsWith('@/')) {
          const absolutePath = resolve(root, 'src', args.path.slice(2));
          return { path: existsSync(absolutePath) ? absolutePath : `${absolutePath}.ts` };
        }
        return null;
      });

      buildApi.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => ({
        contents: stubModules.get(args.path),
        loader: 'ts' as const,
        resolveDir: root,
      }));
    },
  };

  try {
    const result = await build({
      entryPoints: [{ in: 'virtual:threat-timeline-entry', out: 'ThreatTimelinePanel.bundle' }],
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
      ThreatTimelinePanel: mod.ThreatTimelinePanel as typeof import('../src/components/ThreatTimelinePanel.ts').ThreatTimelinePanel,
      __resetServerInsightsCacheForTests: mod.__resetServerInsightsCacheForTests as () => void,
      cleanup() {
        rmSync(tempDir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    rmSync(tempDir, { recursive: true, force: true });
    throw error;
  }
}

describe('ThreatTimelinePanel utilities', () => {
  it('normalizes the threat taxonomy into the panel lanes', () => {
    assert.equal(normalizeThreatLevel('critical'), 'critical');
    assert.equal(normalizeThreatLevel('elevated'), 'medium');
    assert.equal(normalizeThreatLevel('moderate'), 'medium');
    assert.equal(normalizeThreatLevel('unknown'), 'info');
    assert.equal(normalizeThreatLevel(undefined), 'info');
  });

  it('buckets server insight stories into a 7-day severity distribution', () => {
    const items = normalizeServerInsightStories({
      generatedAt: new Date(NOW_MS).toISOString(),
      topStories: [
        serverStory({ threatLevel: 'critical', pubDate: isoDaysAgo(0), primaryTitle: 'Critical item' }),
        serverStory({ threatLevel: 'high', pubDate: isoDaysAgo(1), primaryTitle: 'High item' }),
        serverStory({ threatLevel: 'medium', pubDate: isoDaysAgo(2), primaryTitle: 'Medium item' }),
        serverStory({ threatLevel: 'low', pubDate: isoDaysAgo(6), primaryTitle: 'Low item' }),
        serverStory({ threatLevel: 'info', pubDate: isoDaysAgo(8), primaryTitle: 'Old item' }),
      ],
    });

    const state = buildThreatTimelineState(items, { nowMs: NOW_MS });

    assert.equal(state.days.length, 7);
    assert.equal(state.totals.critical, 1);
    assert.equal(state.totals.high, 1);
    assert.equal(state.totals.medium, 1);
    assert.equal(state.totals.low, 1);
    assert.equal(state.totals.info, 0, 'items older than 7 days are excluded');
    assert.equal(state.hasData, true);
  });

  it('sorts grouped current alerts by threat severity before recency', () => {
    const items = normalizeServerInsightStories({
      generatedAt: new Date(NOW_MS).toISOString(),
      topStories: [
        serverStory({ threatLevel: 'low', pubDate: isoDaysAgo(0), primaryTitle: 'Fresh low' }),
        serverStory({ threatLevel: 'critical', pubDate: isoDaysAgo(1), primaryTitle: 'Older critical' }),
        serverStory({ threatLevel: 'high', pubDate: isoDaysAgo(0), primaryTitle: 'Fresh high' }),
      ],
    });

    const state = buildThreatTimelineState(items, { nowMs: NOW_MS });

    assert.deepEqual(state.groups.map(group => group.level), ['critical', 'high', 'low']);
    assert.equal(state.items[0]?.title, 'Older critical');
    assert.equal(state.items[1]?.title, 'Fresh high');
  });

  it('surfaces empty and degraded states without throwing away the 7-day scaffold', () => {
    const state = buildThreatTimelineState([], {
      nowMs: NOW_MS,
      status: 'degraded',
      statusMessage: 'Server insight snapshot unavailable',
    });

    assert.equal(state.hasData, false);
    assert.equal(state.status, 'degraded');
    assert.equal(state.days.length, 7);
    assert.deepEqual(state.groups, []);
    assert.match(state.degradedReasons.join('\n'), /Server insight snapshot unavailable/);
  });

  it('normalizes cluster fallback provenance from keyword-classified items', () => {
    const items = normalizeClusterStories([{
      id: 'cluster-1',
      primaryTitle: 'Protests spread after blackout',
      primarySource: 'Regional RSS',
      primaryLink: 'https://example.com/cluster',
      sourceCount: 1,
      topSources: [{ name: 'Regional RSS', tier: 2, url: 'https://example.com/source' }],
      allItems: [],
      firstSeen: new Date(isoDaysAgo(1)),
      lastUpdated: new Date(isoDaysAgo(0)),
      isAlert: true,
      threat: { level: 'high', category: 'protest', confidence: 0.8, source: 'keyword' },
    }]);

    assert.equal(items[0]?.provenance, 'Keyword fallback');
    assert.equal(items[0]?.threatLevel, 'high');
  });

  it('describes quiet, worsening, easing, and noisy threat trends', () => {
    assert.deepEqual(
      trendForStories([serverStory({ threatLevel: 'info', pubDate: isoDaysAgo(0) })]),
      { label: 'Quiet', copy: 'No critical/high days', className: 'quiet' },
    );

    assert.deepEqual(
      trendForStories([
        serverStory({ threatLevel: 'high', pubDate: isoDaysAgo(0), primaryTitle: 'Recent high' }),
        serverStory({ threatLevel: 'critical', pubDate: isoDaysAgo(1), primaryTitle: 'Recent critical' }),
      ]),
      { label: 'Worsening', copy: '2 recent vs 0 earlier', className: 'worsening' },
    );

    assert.deepEqual(
      trendForStories([
        serverStory({ threatLevel: 'high', pubDate: isoDaysAgo(6), primaryTitle: 'Earlier high' }),
        serverStory({ threatLevel: 'critical', pubDate: isoDaysAgo(5), primaryTitle: 'Earlier critical' }),
      ]),
      { label: 'Easing', copy: '0 recent vs 2 earlier', className: 'easing' },
    );

    assert.deepEqual(
      trendForStories([
        serverStory({ threatLevel: 'high', pubDate: isoDaysAgo(6), primaryTitle: 'Earlier high' }),
        serverStory({ threatLevel: 'high', pubDate: isoDaysAgo(0), primaryTitle: 'Recent high' }),
      ]),
      { label: 'Noisy', copy: '1 recent vs 1 earlier', className: 'noisy' },
    );
  });
});

describe('ThreatTimelinePanel registration', () => {
  it('is registered in the full variant, layout, data loader, command palette, and intelligence category', () => {
    const panelsSrc = readFileSync(resolve(root, 'src/config/panels.ts'), 'utf-8');
    const layoutSrc = readFileSync(resolve(root, 'src/app/panel-layout.ts'), 'utf-8');
    const dataLoaderSrc = readFileSync(resolve(root, 'src/app/data-loader.ts'), 'utf-8');
    const commandsSrc = readFileSync(resolve(root, 'src/config/commands.ts'), 'utf-8');

    assert.match(panelsSrc, /'threat-timeline':\s*\{\s*name:\s*'Threat Timeline'/);
    assert.match(panelsSrc, /intelligence:\s*\{[\s\S]*panelKeys:\s*\[[^\]]*'threat-timeline'/);
    assert.match(layoutSrc, /isPanelInVariantDefaults\('threat-timeline'\)[\s\S]*lazyDefaultPanel\('threat-timeline',\s*\(\)\s*=>\s*import\('@\/components\/ThreatTimelinePanel'\),\s*'ThreatTimelinePanel'\)/);
    assert.match(dataLoaderSrc, /isPanelInVariantDefaults\('threat-timeline'\)[\s\S]*panels\['threat-timeline'\]\s+as ThreatTimelinePanel/);
    assert.match(commandsSrc, /id:\s*'panel:threat-timeline'[\s\S]*keywords:\s*\[[^\]]*'threat trend'/);
  });
});

describe('ThreatTimelinePanel refresh behavior', () => {
  it('replaces stale live content with degraded cluster fallback after an insights refetch failure, then recovers', async () => {
    const harness = await loadThreatTimelinePanelHarness();
    const { ThreatTimelinePanel, __resetServerInsightsCacheForTests } = harness;
    __resetServerInsightsCacheForTests();
    const panel = new ThreatTimelinePanel();
    try {
      const rootEl = panel.getElement();
      const contentEl = rootEl.querySelector('.panel-content');
      const badgeEl = rootEl.querySelector('.panel-data-badge');
      assert.ok(contentEl, 'panel content node should exist');
      assert.ok(badgeEl, 'panel data badge should exist');

      panel.updateFromServerInsights(runtimeServerInsights());
      await waitForPanelRender();

      assert.match(contentEl.innerHTML, /Fresh server-backed escalation/);
      assert.ok(badgeEl.classList.contains('live'), 'precondition: live server snapshot is rendered');
      assert.match(badgeEl.textContent ?? '', /Insights snapshot/);

      __resetServerInsightsCacheForTests();
      let fetchCalls = 0;
      defineGlobal('fetch', async () => {
        fetchCalls += 1;
        throw new Error('bootstrap unavailable');
      });

      await assert.doesNotReject(() => panel.refresh([fallbackCluster()]));
      await waitForPanelRender();

      assert.equal(fetchCalls, 1, 'refresh attempted the on-demand insights fetch');
      assert.match(contentEl.innerHTML, /Fallback protests spread after outage/);
      assert.match(contentEl.innerHTML, /Keyword fallback/);
      assert.match(contentEl.innerHTML, /Server insight snapshot unavailable/);
      assert.doesNotMatch(contentEl.innerHTML, /Fresh server-backed escalation/, 'degraded fallback replaces stale server content');
      assert.ok(badgeEl.classList.contains('cached'), 'degraded fallback is visibly badged as cached/degraded');
      assert.match(badgeEl.textContent ?? '', /degraded/);

      const recovered = runtimeServerInsights({
        topStories: [
          serverStory({
            primaryTitle: 'Recovered server-backed escalation',
            primarySource: 'ACLED',
            pubDate: runtimeIsoDaysAgo(0),
            threatLevel: 'critical',
          }),
        ],
      });
      defineGlobal('fetch', async () => new Response(JSON.stringify({ data: { insights: recovered } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));

      await panel.refresh();
      await waitForPanelRender();

      assert.match(contentEl.innerHTML, /Recovered server-backed escalation/);
      assert.doesNotMatch(contentEl.innerHTML, /Fallback protests spread after outage/);
      assert.doesNotMatch(contentEl.innerHTML, /Server insight snapshot unavailable/);
      assert.ok(badgeEl.classList.contains('live'), 'server recovery restores the live badge');
    } finally {
      panel.destroy();
      harness.cleanup();
    }
  });

  it('truncates long item titles without splitting emoji surrogate pairs', async () => {
    const harness = await loadThreatTimelinePanelHarness();
    const { ThreatTimelinePanel } = harness;
    const panel = new ThreatTimelinePanel();
    try {
      const contentEl = panel.getElement().querySelector('.panel-content');
      assert.ok(contentEl, 'panel content node should exist');

      const longTitle = `${'a'.repeat(90)}🙂${'b'.repeat(20)}`;
      panel.updateFromServerInsights(runtimeServerInsights({
        topStories: [
          serverStory({
            primaryTitle: longTitle,
            primarySource: 'ACLED',
            pubDate: runtimeIsoDaysAgo(0),
            threatLevel: 'high',
          }),
        ],
      }));
      await waitForPanelRender();

      assert.ok(contentEl.innerHTML.includes(`${'a'.repeat(90)}🙂...`));
      assert.doesNotMatch(contentEl.innerHTML, /\uFFFD/);
      assert.doesNotMatch(contentEl.innerHTML, /bbbbbbbbbbbbbbbbbbbb/);
    } finally {
      panel.destroy();
      harness.cleanup();
    }
  });

  // Supplemental source guard for the SVG label rendering bug; behavior above
  // proves the refresh failure path without relying on source text shape.
  it('renders SVG day labels with tspans instead of collapsed newline text', () => {
    const panelSrc = readFileSync(resolve(root, 'src/components/ThreatTimelinePanel.ts'), 'utf-8');

    assert.match(panelSrc, /<tspan x="\$\{centerX\}" dy="0">/);
    assert.match(panelSrc, /<tspan x="\$\{centerX\}" dy="10">/);
    assert.doesNotMatch(panelSrc, /label\.replace\(' ', '\\n'\)/);
  });
});
