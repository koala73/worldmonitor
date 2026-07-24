import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, before, beforeEach, describe, it } from 'node:test';
import { build } from 'esbuild';
import ts from 'typescript';

const root = resolve(import.meta.dirname, '..');
const DAY_MS = 24 * 60 * 60 * 1000;

interface PanelTestState {
  count: number;
  destroyed: boolean;
  error: boolean;
}

interface GivingPanelUnderTest {
  content: {
    innerHTML: string;
  };
  testState: PanelTestState;
  destroy(): void;
  hasData(): boolean;
  setData(data: unknown): void;
  showUnavailable(): void;
}

type GivingPanelConstructor = new () => GivingPanelUnderTest;

interface PendingTimer {
  callback: () => void;
  delay: number;
}

let GivingPanel: GivingPanelConstructor;
let now = Date.parse('2026-07-24T12:00:00.000Z');
let nextTimerId = 1;
let pendingTimers = new Map<number, PendingTimer>();
let originalSetTimeout: typeof globalThis.setTimeout;
let originalClearTimeout: typeof globalThis.clearTimeout;
let originalDateNow: typeof Date.now;

async function loadGivingPanel(): Promise<GivingPanelConstructor> {
  const panelPath = resolve(root, 'src/components/GivingPanel.ts').replace(/\\/g, '/');
  const stubModules = new Map([
    ['panel-stub', `
      export class Panel {
        constructor() {
          this.content = {
            innerHTML: '',
            querySelectorAll() { return []; },
          };
          this.testState = { count: 0, destroyed: false, error: false };
        }
        showLoading() {}
        showError() {
          this.testState.error = true;
          this.content.innerHTML = 'unavailable';
        }
        setErrorState(value) { this.testState.error = value; }
        setCount(value) { this.testState.count = value; }
        destroy() { this.testState.destroyed = true; }
      }
    `],
    ['giving-renderer-stub', `
      export function availableGivingTabs() { return ['platforms']; }
      export function renderGivingPanelContent(data) {
        return 'rendered:' + data.materializedAt;
      }
    `],
    ['giving-model-stub', `export const GIVING_STALE_CEILING_MS = ${DAY_MS};`],
    ['i18n-stub', `export function t(key) { return key; }`],
    ['dom-utils-stub', `
      export function trustedHtml(value) { return value; }
      export function setTrustedHtml(element, value) { element.innerHTML = String(value); }
    `],
  ]);

  const aliases = new Map([
    ['./Panel', 'panel-stub'],
    ['./giving-renderer', 'giving-renderer-stub'],
    ['@/services/giving/model', 'giving-model-stub'],
    ['@/services/i18n', 'i18n-stub'],
    ['@/utils/dom-utils', 'dom-utils-stub'],
  ]);

  const result = await build({
    entryPoints: [panelPath],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2020',
    write: false,
    plugins: [{
      name: 'giving-panel-expiry-test-stubs',
      setup(buildApi) {
        buildApi.onResolve({ filter: /.*/ }, (args) => {
          const target = aliases.get(args.path);
          return target ? { path: target, namespace: 'stub' } : null;
        });
        buildApi.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => ({
          contents: stubModules.get(args.path),
          loader: 'ts',
        }));
      },
    }],
  });

  const bundleUrl = `data:text/javascript;base64,${Buffer.from(result.outputFiles[0]!.text).toString('base64')}`;
  const module = await import(bundleUrl);
  return module.GivingPanel as GivingPanelConstructor;
}

function summary(materializedAt: number, platformCount = 1): unknown {
  return {
    materializedAt: new Date(materializedAt).toISOString(),
    platforms: Array.from({ length: platformCount }, (_, index) => ({
      platform: `Platform ${index + 1}`,
    })),
  };
}

function onlyPendingTimer(): [number, PendingTimer] {
  assert.equal(pendingTimers.size, 1, 'expected exactly one Giving expiry timer');
  return [...pendingTimers.entries()][0]!;
}

function runTimer(id: number): void {
  const timer = pendingTimers.get(id);
  assert.ok(timer, `timer ${id} must still be pending`);
  pendingTimers.delete(id);
  timer.callback();
}

function visit(node: ts.Node, callback: (child: ts.Node) => void): void {
  node.forEachChild((child) => {
    callback(child);
    visit(child, callback);
  });
}

before(async () => {
  GivingPanel = await loadGivingPanel();
});

beforeEach(() => {
  now = Date.parse('2026-07-24T12:00:00.000Z');
  nextTimerId = 1;
  pendingTimers = new Map();
  originalSetTimeout = globalThis.setTimeout;
  originalClearTimeout = globalThis.clearTimeout;
  originalDateNow = Date.now;

  globalThis.setTimeout = ((callback: () => void, delay = 0) => {
    const id = nextTimerId++;
    pendingTimers.set(id, { callback, delay });
    return id;
  }) as typeof globalThis.setTimeout;
  globalThis.clearTimeout = ((id: ReturnType<typeof globalThis.setTimeout>) => {
    pendingTimers.delete(Number(id));
  }) as typeof globalThis.clearTimeout;
  Date.now = () => now;
});

afterEach(() => {
  globalThis.setTimeout = originalSetTimeout;
  globalThis.clearTimeout = originalClearTimeout;
  Date.now = originalDateNow;
});

describe('Giving panel expiry and unavailable behavior', () => {
  it('clears a rendered v2 snapshot and renders unavailable at its 24-hour ceiling', () => {
    const panel = new GivingPanel();
    const materializedAt = now - 60 * 60 * 1000;

    panel.setData(summary(materializedAt, 2));

    assert.equal(panel.hasData(), true);
    assert.equal(panel.testState.count, 2);
    assert.match(panel.content.innerHTML, /rendered:/);
    const [timerId, timer] = onlyPendingTimer();
    assert.equal(timer.delay, DAY_MS - 60 * 60 * 1000);

    runTimer(timerId);

    assert.equal(panel.hasData(), false);
    assert.equal(panel.testState.count, 0);
    assert.equal(panel.testState.error, true);
    assert.equal(panel.content.innerHTML, 'unavailable');
  });

  it('refuses to render a snapshot that is already beyond the ceiling', () => {
    const panel = new GivingPanel();

    panel.setData(summary(now - DAY_MS - 1));

    assert.equal(panel.hasData(), false);
    assert.equal(panel.testState.count, 0);
    assert.equal(panel.testState.error, true);
    assert.equal(panel.content.innerHTML, 'unavailable');
    assert.equal(pendingTimers.size, 0);
  });

  it('reschedules expiry on replacement data and clears the timer on destroy', () => {
    const panel = new GivingPanel();
    panel.setData(summary(now - 2 * 60 * 60 * 1000));
    const [firstTimerId] = onlyPendingTimer();

    now += 10_000;
    panel.setData(summary(now - 60_000, 3));

    assert.equal(pendingTimers.has(firstTimerId), false);
    const [, replacementTimer] = onlyPendingTimer();
    assert.equal(replacementTimer.delay, DAY_MS - 60_000);
    assert.equal(panel.testState.count, 3);
    assert.equal(panel.testState.error, false);

    panel.destroy();

    assert.equal(pendingTimers.size, 0);
    assert.equal(panel.testState.destroyed, true);
  });

  it('ignores a late fetch result after the panel is destroyed', () => {
    const panel = new GivingPanel();
    panel.setData(summary(now - 60_000, 2));
    const renderedBeforeDestroy = panel.content.innerHTML;

    panel.destroy();
    panel.setData(summary(now, 4));
    panel.showUnavailable();

    assert.equal(pendingTimers.size, 0);
    assert.equal(panel.testState.destroyed, true);
    assert.equal(panel.testState.count, 2);
    assert.equal(panel.testState.error, false);
    assert.equal(panel.content.innerHTML, renderedBeforeDestroy);
  });

  it('routes an unavailable Giving fetch through the retained-data cold error guard', () => {
    const source = readFileSync(resolve(root, 'src/app/data-loader.ts'), 'utf8');
    const file = ts.createSourceFile(
      'src/app/data-loader.ts',
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    let unavailableBranch: ts.Statement | undefined;

    visit(file, (node) => {
      if (
        ts.isIfStatement(node)
        && ts.isPrefixUnaryExpression(node.expression)
        && node.expression.operator === ts.SyntaxKind.ExclamationToken
        && ts.isPropertyAccessExpression(node.expression.operand)
        && ts.isIdentifier(node.expression.operand.expression)
        && node.expression.operand.expression.text === 'givingResult'
        && node.expression.operand.name.text === 'ok'
      ) {
        unavailableBranch = node.thenStatement;
      }
    });

    assert.ok(unavailableBranch, 'Giving loader must branch on an unavailable result');
    let guardsColdGivingError = false;
    visit(unavailableBranch, (node) => {
      if (
        ts.isCallExpression(node)
        && ts.isPropertyAccessExpression(node.expression)
        && node.expression.name.text === 'showColdLoadError'
        && node.arguments[0]
        && ts.isStringLiteralLike(node.arguments[0])
        && node.arguments[0].text === 'giving'
      ) {
        guardsColdGivingError = true;
      }
    });
    assert.equal(guardsColdGivingError, true);
  });
});
