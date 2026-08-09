import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import ts from 'typescript';

const layout = readFileSync(new URL('../src/app/panel-layout.ts', import.meta.url), 'utf8');
const handlers = readFileSync(new URL('../src/app/event-handlers.ts', import.meta.url), 'utf8');
const mobileNav = readFileSync(new URL('../src/app/mobile-primary-nav.ts', import.meta.url), 'utf8');
const css = readFileSync(new URL('../src/styles/main.css', import.meta.url), 'utf8');
const shell = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const search = readFileSync(new URL('../src/components/SearchModal.ts', import.meta.url), 'utf8');
const popup = readFileSync(new URL('../src/components/MapPopup.ts', import.meta.url), 'utf8');
const settings = readFileSync(new URL('../src/components/UnifiedSettings.ts', import.meta.url), 'utf8');
const deepDive = readFileSync(new URL('../src/components/CountryDeepDivePanel.ts', import.meta.url), 'utf8');

function loadReconcileHarness(overlayHistory: unknown): new () => {
  setActive(tab: string): void;
  reconcileOverlayForTab(tab: string): string | undefined | null;
  activeCalls: string[];
  ctx: { unifiedSettings: { hasPendingChanges(): boolean; close(): void } | null };
} {
  const signature = 'private reconcileOverlayForTab(';
  const start = mobileNav.indexOf(signature);
  assert.ok(start >= 0, 'mobile navigation must expose one reconciliation method');
  const braceStart = mobileNav.indexOf('{', start);
  let depth = 0;
  let end = -1;
  for (let index = braceStart; index < mobileNav.length; index += 1) {
    if (mobileNav[index] === '{') depth += 1;
    if (mobileNav[index] === '}') {
      depth -= 1;
      if (depth === 0) {
        end = index + 1;
        break;
      }
    }
  }
  assert.ok(end > braceStart, 'reconciliation method must have balanced braces');
  const method = mobileNav.slice(start, end).replace(/^private\s+/, '');
  const source = `class Harness {
    activeCalls: string[] = [];
    ctx: { unifiedSettings: { hasPendingChanges(): boolean; close(): void } | null } = { unifiedSettings: null };
    setActive(tab: string): void { this.activeCalls.push(tab); }
    ${method}
  }`;
  const compiled = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.None },
  }).outputText;
  // eslint-disable-next-line no-new-func
  return new Function('overlayHistory', `${compiled}\nreturn Harness;`)(overlayHistory);
}

describe('mobile P0 navigation contract (#5201)', () => {
  it('renders the five primary destinations in a real bottom navigation landmark', () => {
    assert.match(layout, /<nav class="mobile-tab-bar"[^>]*aria-label="Primary"/);
    for (const tab of ['today', 'map', 'search', 'alerts', 'more']) {
      assert.match(layout, new RegExp(`data-mobile-tab="${tab}"`));
    }
  });

  it('replaces the mobile footer, hamburger, and search FAB without affecting desktop', () => {
    assert.doesNotMatch(layout, /id="searchMobileFab"/);
    assert.doesNotMatch(layout, /id="hamburgerBtn"/);
    assert.match(css, /@media \(max-width: 768px\)[\s\S]*?\.site-footer\s*\{[^}]*display:\s*none/);
    assert.doesNotMatch(css, /\.hamburger-btn/);
    assert.doesNotMatch(css, /\.search-mobile-fab/);
    assert.match(css, /\.mobile-tab-bar\s*\{/);
    assert.match(css, /\.mobile-tab-bar\s*\{[^}]*position:\s*fixed[^}]*z-index:\s*10003/);
    assert.match(css, /\.map-popup\.map-popup-sheet\s*\{[^}]*padding-bottom:\s*calc\(58px/);
    assert.match(css, /\.region-bottom-sheet\s*\{[^}]*padding-bottom:\s*calc\(58px/);
    assert.match(css, /\.search-overlay\.search-mobile \.search-sheet\s*\{[^}]*padding-bottom:\s*calc\(58px/);
  });

  it('wires Today, Map, Search, Alerts, and More as distinct actions', () => {
    assert.match(mobileNav, /private setupTabBar\(\): void/);
    assert.match(mobileNav, /case 'today':/);
    assert.match(mobileNav, /case 'map':/);
    assert.match(mobileNav, /case 'search':/);
    assert.match(mobileNav, /case 'alerts':/);
    assert.match(mobileNav, /case 'more':/);
    assert.match(mobileNav, /private alertScrollFrame: number \| null = null/);
    assert.match(mobileNav, /this\.alertScrollFrame = requestAnimationFrame/);
    assert.match(mobileNav, /cancelAnimationFrame\(this\.alertScrollFrame\)/);
  });

  it('defaults first-time mobile visitors to the collapsed-map Today state before hydration', () => {
    assert.match(layout, /loadFromStorage<boolean>\('mobile-map-collapsed', true\)/);
    assert.match(shell, /localStorage\.getItem\('mobile-map-collapsed'\)!=='false'/);
  });

  it('provides an account mount inside More instead of hiding auth on mobile', () => {
    assert.match(layout, /id="mobileAuthWidgetMount"/);
    assert.match(mobileNav, /mobileAuthWidgetMount/);
  });

  it('routes every P0 overlay family through the shared browser-history manager', () => {
    assert.match(mobileNav, /overlayHistory\.open\('menu'/);
    assert.match(mobileNav, /overlayHistory\.replaceInPlace\(replaceOverlayId, 'region'/);
    assert.match(search, /overlayHistory\.open\('search'/);
    assert.match(popup, /overlayHistory\.openCancelable\('map-popup'/);
    assert.match(settings, /overlayHistory\.open\('settings'/);
    assert.match(deepDive, /overlayHistory\.open\('deep-dive'/);
    assert.match(handlers, /history\.replaceState\(history\.state, '', shareUrl\)/);
  });

  it('executes one overlay reconciliation contract for every primary-tab transition', () => {
    const calls: Array<{ method: string; id: string }> = [];
    let top: string | null = 'search';
    const overlayHistory = {
      top: () => top,
      dismiss: (id: string) => {
        calls.push({ method: 'dismiss', id });
        top = null;
      },
    };
    const Harness = loadReconcileHarness(overlayHistory);
    const harness = new Harness();

    assert.equal(harness.reconcileOverlayForTab('search'), null, 're-tapping Search toggles it closed');
    assert.deepEqual(calls, [{ method: 'dismiss', id: 'search' }]);
    assert.deepEqual(harness.activeCalls, ['today']);

    top = 'menu';
    calls.length = 0;
    assert.equal(harness.reconcileOverlayForTab('today'), undefined);
    assert.deepEqual(calls, [{ method: 'dismiss', id: 'menu' }]);

    top = 'search';
    calls.length = 0;
    assert.equal(harness.reconcileOverlayForTab('more'), 'search');
    assert.deepEqual(calls, [], 'Search stays registered until More replaces it in place');

    top = 'settings-pending';
    assert.equal(harness.reconcileOverlayForTab('search'), 'settings-pending');

    let dirtyCloseCalls = 0;
    harness.ctx.unifiedSettings = {
      hasPendingChanges: () => true,
      close: () => { dirtyCloseCalls += 1; },
    };
    top = 'settings';
    assert.equal(harness.reconcileOverlayForTab('search'), null, 'dirty Settings must block replacement');
    assert.equal(dirtyCloseCalls, 1);
    assert.deepEqual(harness.activeCalls.at(-1), 'more');
  });
});
