import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';

const REPO_ROOT = resolve(import.meta.dirname, '..');
const DATA_LOADER_PATH = resolve(REPO_ROOT, 'src/app/data-loader.ts');
const DATA_LOADER_TS = readFileSync(DATA_LOADER_PATH, 'utf8');
const DATA_LOADER_SOURCE = ts.createSourceFile(
  DATA_LOADER_PATH,
  DATA_LOADER_TS,
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

function findLoadAllDataMethod(): ts.MethodDeclaration {
  let match: ts.MethodDeclaration | undefined;

  visitDescendants(DATA_LOADER_SOURCE, node => {
    if (
      ts.isMethodDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'loadAllData'
    ) {
      match = node;
    }
  });

  assert.ok(match, 'could not find loadAllData method');
  assert.ok(match.body, 'loadAllData method has no body');
  return match;
}

function isTasksMapTaskCall(node: ts.Node): boolean {
  if (!ts.isCallExpression(node)) {
    return false;
  }

  const expression = node.expression;
  if (
    !ts.isPropertyAccessExpression(expression) ||
    !ts.isIdentifier(expression.expression) ||
    expression.expression.text !== 'tasks' ||
    expression.name.text !== 'map'
  ) {
    return false;
  }

  const callback = node.arguments[0];
  if (!callback || !ts.isArrowFunction(callback) || callback.parameters.length !== 1) {
    return false;
  }

  const parameter = callback.parameters[0]!.name;
  return (
    ts.isIdentifier(parameter) &&
    ts.isPropertyAccessExpression(callback.body) &&
    ts.isIdentifier(callback.body.expression) &&
    callback.body.expression.text === parameter.text &&
    callback.body.name.text === 'task'
  );
}

function isPromiseAllSettledCall(node: ts.Node): node is ts.CallExpression {
  return (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === 'Promise' &&
    node.expression.name.text === 'allSettled'
  );
}

function hasAwaitedAllTasksSettle(node: ts.Node): boolean {
  let found = false;

  visitDescendants(node, child => {
    if (
      ts.isAwaitExpression(child) &&
      isPromiseAllSettledCall(child.expression) &&
      child.expression.arguments.length === 1 &&
      isTasksMapTaskCall(child.expression.arguments[0]!)
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
  const loadAllDataMethod = findLoadAllDataMethod();

  it('does not add a blanket inter-batch startup delay', () => {
    const batchIdentifiers = findBlockedBatchIdentifiers(loadAllDataMethod);
    const taskSliceCalls = findTasksSliceCalls(loadAllDataMethod);

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

  it('awaits the scheduled guarded load promises together', () => {
    assert.ok(
      hasAwaitedAllTasksSettle(loadAllDataMethod),
      'loadAllData should settle the task promises without artificial inter-batch waits',
    );
  });
});
