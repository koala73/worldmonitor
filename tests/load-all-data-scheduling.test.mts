import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';

const REPO_ROOT = resolve(import.meta.dirname, '..');
const DATA_LOADER_PATH = resolve(REPO_ROOT, 'src/app/data-loader.ts');
const PANEL_LAYOUT_PATH = resolve(REPO_ROOT, 'src/app/panel-layout.ts');
const DATA_LOADER_TS = readFileSync(DATA_LOADER_PATH, 'utf8');
const PANEL_LAYOUT_TS = readFileSync(PANEL_LAYOUT_PATH, 'utf8');
const DATA_LOADER_SOURCE = ts.createSourceFile(
  DATA_LOADER_PATH,
  DATA_LOADER_TS,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TS,
);
const PANEL_LAYOUT_SOURCE = ts.createSourceFile(
  PANEL_LAYOUT_PATH,
  PANEL_LAYOUT_TS,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TS,
);

function visitDescendants(node: ts.Node, visitor: (child: ts.Node) => void): void {
  node.forEachChild(child => {
    visitor(child);
    visitDescendants(child, visitor);
  });
}

function findMethod(source: ts.SourceFile, name: string): ts.MethodDeclaration {
  let match: ts.MethodDeclaration | undefined;

  visitDescendants(source, node => {
    if (
      ts.isMethodDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name
    ) {
      match = node;
    }
  });

  assert.ok(match, `could not find ${name} method`);
  assert.ok(match.body, `${name} method has no body`);
  return match;
}

function isRunHydrationTasksCall(node: ts.Node): node is ts.CallExpression {
  return (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    ts.isThis(node.expression.expression) &&
    node.expression.name.text === 'runHydrationTasks'
  );
}

function hasAwaitedHydrationRunner(node: ts.Node): boolean {
  let found = false;

  visitDescendants(node, child => {
    if (
      ts.isAwaitExpression(child) &&
      isRunHydrationTasksCall(child.expression) &&
      child.expression.arguments.length === 2 &&
      ts.isIdentifier(child.expression.arguments[0]!) &&
      child.expression.arguments[0]!.text === 'tasks' &&
      ts.isIdentifier(child.expression.arguments[1]!) &&
      child.expression.arguments[1]!.text === 'forceAll'
    ) {
      found = true;
    }
  });

  return found;
}

function findBlockedBatchIdentifiers(node: ts.Node): string[] {
  const hits: string[] = [];
  const blocked = new Set(['BATCH_DELAY_MS', 'BATCH_SIZE']);

  visitDescendants(node, child => {
    if (ts.isIdentifier(child) && blocked.has(child.text)) {
      hits.push(child.text);
    }
  });

  return hits;
}

function findTasksSliceCalls(node: ts.Node): string[] {
  const hits: string[] = [];

  visitDescendants(node, child => {
    if (
      ts.isCallExpression(child) &&
      ts.isPropertyAccessExpression(child.expression) &&
      ts.isIdentifier(child.expression.expression) &&
      child.expression.expression.text === 'tasks' &&
      child.expression.name.text === 'slice'
    ) {
      hits.push(child.getText(DATA_LOADER_SOURCE));
    }
  });

  return hits;
}

describe('loadAllData scheduler', () => {
  const loadAllDataMethod = findMethod(DATA_LOADER_SOURCE, 'loadAllData');
  const runLoadAllDataMethod = findMethod(DATA_LOADER_SOURCE, 'runLoadAllData');
  const loadSatellitesMethod = findMethod(DATA_LOADER_SOURCE, 'loadSatellites');

  it('does not add a blanket inter-batch startup delay', () => {
    const batchIdentifiers = findBlockedBatchIdentifiers(runLoadAllDataMethod);
    const taskSliceCalls = findTasksSliceCalls(runLoadAllDataMethod);

    assert.deepEqual(
      batchIdentifiers,
      [],
      'loadAllData must not reintroduce fixed startup batch constants; throttle constrained sources in their loader/service instead',
    );
    assert.deepEqual(
      taskSliceCalls,
      [],
      'loadAllData must not batch the startup task list; throttle constrained sources in their loader/service instead',
    );
  });

  it('awaits the prioritized hydration scheduler for guarded load tasks', () => {
    assert.ok(
      hasAwaitedHydrationRunner(runLoadAllDataMethod),
      'runLoadAllData should delegate guarded task execution to the prioritized hydration scheduler',
    );
  });

  it('coalesces overlapping loadAllData calls behind one active promise', () => {
    const text = loadAllDataMethod.getText(DATA_LOADER_SOURCE);
    assert.match(text, /if\s*\(\s*this\.loadAllDataPromise\s*\)/);
    assert.match(text, /this\.loadAllDataRerunRequested\s*=\s*true/);
    assert.match(text, /this\.loadAllDataQueuedForceAll\s*=\s*this\.loadAllDataQueuedForceAll\s*\|\|\s*forceAll/);
    assert.match(text, /return\s+this\.loadAllDataPromise/);
  });

  it('keeps satellite.js chunk failures local to the satellite layer', () => {
    const text = loadSatellitesMethod.getText(DATA_LOADER_SOURCE);
    assert.match(
      text,
      /try\s*\{[\s\S]*?this\.cachedSatRecs\s*=\s*await\s+initSatRecs\(data\);[\s\S]*?\}\s*catch\s*\(err\)\s*\{/,
      'loadSatellites must catch lazy satellite.js import/init failures locally',
    );
    assert.match(
      text,
      /this\.cachedSatRecs\s*=\s*\[\];/,
      'failed satellite initialization should clear cached satellite records',
    );
    assert.match(
      text,
      /this\.ctx\.map\?\.setSatellites\(\[\]\);/,
      'failed satellite initialization should clear the rendered satellite layer',
    );
    assert.match(
      text,
      /return;/,
      'failed satellite initialization should return without starting propagation',
    );
  });
});

describe('viewport hydration scheduler lifecycle', () => {
  const destroyMethod = findMethod(PANEL_LAYOUT_SOURCE, 'destroy');
  const observeMethod = findMethod(PANEL_LAYOUT_SOURCE, 'observePanelsForViewport');
  const observePanelMethod = findMethod(PANEL_LAYOUT_SOURCE, 'observePanelForHydration');

  it('cancels pending idle hydration during teardown', () => {
    assert.match(
      destroyMethod.getText(PANEL_LAYOUT_SOURCE),
      /this\.cancelScheduledLoadAllIdle\s*\(\s*\)/,
      'destroy should cancel a pending requestIdleCallback hydration before tearing panels down',
    );
  });

  it('keeps the no-window viewport fallback before reading window.innerHeight', () => {
    assert.match(
      observeMethod.getText(PANEL_LAYOUT_SOURCE),
      /this\.observePanelForHydration\(panel\);/,
      'observePanelsForViewport should delegate per-panel viewport handling to observePanelForHydration',
    );
    const text = observePanelMethod.getText(PANEL_LAYOUT_SOURCE);
    const guardIndex = text.indexOf("typeof window === 'undefined'");
    const innerHeightIndex = text.indexOf('window.innerHeight');
    assert.ok(guardIndex >= 0, 'observer should preserve an explicit no-window guard');
    assert.ok(innerHeightIndex >= 0, 'observer should still classify visible panels when window exists');
    assert.ok(
      guardIndex < innerHeightIndex,
      'observer must not read window.innerHeight before the no-window fallback can schedule hydration',
    );
  });
});
