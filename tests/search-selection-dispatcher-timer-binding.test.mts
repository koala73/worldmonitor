/**
 * Regression coverage for a Firefox-only production crash (WORLDMONITOR-ZV):
 *
 *   TypeError: 'setTimeout' called on an object that does not implement
 *   interface Window.
 *
 * `search-manager.ts` builds the `SearchSelectionDispatcher` bindings and
 * `SearchSelectionDispatcher` later invokes them as *methods*
 * (`this.bindings.setTimeout(...)`, `this.bindings.clearTimeout(...)`). Firefox's
 * spec-compliant WebIDL implementation brands `setTimeout`/`clearTimeout` to
 * their global object: calling them with any other receiver — including a
 * plain bindings object that merely holds the same function reference —
 * throws. Passing the bare global identifiers as shorthand properties
 * (`{ setTimeout, clearTimeout }`) reproduces exactly that receiver mismatch.
 *
 * This test extracts the real `setTimeout`/`clearTimeout` properties from the
 * `SearchSelectionDispatcher` bindings literal in `src/app/search-manager.ts`
 * (not a hand-copied snippet) and evaluates them against branded fakes that
 * throw the same TypeError Firefox does for any receiver other than
 * `undefined` (a bare/unqualified call) or `globalThis`. It shadows both bare
 * globals and `globalThis` so a direct `globalThis.setTimeout` property value
 * fails the same way as the pre-fix shorthand form.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import ts from 'typescript';

const managerSource = readFileSync(
  new URL('../src/app/search-manager.ts', import.meta.url),
  'utf8',
);
const sourceFile = ts.createSourceFile(
  'search-manager.ts',
  managerSource,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TS,
);

function findDispatcherBindingsLiteral(root: ts.SourceFile): ts.ObjectLiteralExpression {
  let found: ts.ObjectLiteralExpression | undefined;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'SearchSelectionDispatcher'
    ) {
      const [arg] = node.arguments ?? [];
      if (arg && ts.isObjectLiteralExpression(arg)) found = arg;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  assert.ok(found, 'new SearchSelectionDispatcher({...}) must remain in src/app/search-manager.ts');
  return found;
}

function extractPropertyText(literal: ts.ObjectLiteralExpression, propertyName: string): string {
  const property = literal.properties.find((candidate) => {
    const name = candidate.name;
    return name !== undefined && ts.isIdentifier(name) && name.text === propertyName;
  });
  assert.ok(property, `SearchSelectionDispatcher bindings must define "${propertyName}"`);
  return property.getText(sourceFile);
}

const bindingsLiteral = findDispatcherBindingsLiteral(sourceFile);
const setTimeoutPropertyText = extractPropertyText(bindingsLiteral, 'setTimeout');
const clearTimeoutPropertyText = extractPropertyText(bindingsLiteral, 'clearTimeout');

const transpiledSetTimeoutProperty = ts.transpileModule(setTimeoutPropertyText, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
}).outputText.trim().replace(/;$/, '');
const transpiledClearTimeoutProperty = ts.transpileModule(clearTimeoutPropertyText, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
}).outputText.trim().replace(/;$/, '');

/**
 * Build the real bindings object from the extracted source, resolving bare and
 * `globalThis` timer references to the branded fakes supplied here.
 */
function buildBindings(
  brandedSetTimeout: typeof setTimeout,
  brandedClearTimeout: typeof clearTimeout,
  timerGlobal: {
    setTimeout: typeof setTimeout;
    clearTimeout: typeof clearTimeout;
  } = {
    setTimeout: brandedSetTimeout,
    clearTimeout: brandedClearTimeout,
  },
): { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout } {
  // eslint-disable-next-line no-new-func
  const factory = new Function(
    'setTimeout',
    'clearTimeout',
    'globalThis',
    `'use strict';\nreturn {\n${transpiledSetTimeoutProperty},\n${transpiledClearTimeoutProperty}\n};`,
  ) as (st: typeof setTimeout, ct: typeof clearTimeout, timerGlobal: {
    setTimeout: typeof setTimeout;
    clearTimeout: typeof clearTimeout;
  }) => {
    setTimeout: typeof setTimeout;
    clearTimeout: typeof clearTimeout;
  };
  return factory(brandedSetTimeout, brandedClearTimeout, timerGlobal);
}

/** Mimics Firefox's WebIDL brand check: only a bare call or a call on the global object is legal. */
function brand<Args extends unknown[], R>(
  name: string,
  real: (...args: Args) => R,
  allowedGlobal: object = globalThis,
) {
  return function (this: unknown, ...args: Args): R {
    if (this !== undefined && this !== allowedGlobal) {
      throw new TypeError(`'${name}' called on an object that does not implement interface Window.`);
    }
    return real(...args);
  };
}

function createTimerQueue() {
  let nextHandle = 0;
  const callbacks = new Map<number, () => void>();
  return {
    setTimeout(callback: () => void, _delay: number): ReturnType<typeof setTimeout> {
      const handle = ++nextHandle;
      callbacks.set(handle, callback);
      return handle as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeout(timer: ReturnType<typeof setTimeout>): void {
      callbacks.delete(timer as unknown as number);
    },
    flush(): void {
      const pending = [...callbacks.values()];
      callbacks.clear();
      for (const callback of pending) callback();
    },
  };
}

describe('SearchSelectionDispatcher timer bindings (WORLDMONITOR-ZV)', () => {
  it('does not pass a bare setTimeout/clearTimeout reference that breaks when called as a method', () => {
    const timers = createTimerQueue();
    const timerGlobal = {} as {
      setTimeout: typeof setTimeout;
      clearTimeout: typeof clearTimeout;
    };
    const brandedSetTimeout = brand('setTimeout', timers.setTimeout, timerGlobal) as unknown as typeof setTimeout;
    const brandedClearTimeout = brand('clearTimeout', timers.clearTimeout, timerGlobal) as unknown as typeof clearTimeout;
    timerGlobal.setTimeout = brandedSetTimeout;
    timerGlobal.clearTimeout = brandedClearTimeout;
    const bindings = buildBindings(brandedSetTimeout, brandedClearTimeout, timerGlobal);

    const directGlobalReferences = {
      setTimeout: timerGlobal.setTimeout,
      clearTimeout: timerGlobal.clearTimeout,
    };
    assert.throws(
      () => directGlobalReferences.setTimeout(() => {}, 0),
      /interface Window/,
    );
    assert.throws(
      () => directGlobalReferences.clearTimeout(undefined as ReturnType<typeof setTimeout>),
      /interface Window/,
    );

    let fired = false;
    assert.doesNotThrow(() => {
      // SearchSelectionDispatcher always calls these as `this.bindings.setTimeout(...)`
      // / `this.bindings.clearTimeout(...)` — a method call on this exact object.
      const handle = bindings.setTimeout(() => {
        fired = true;
      }, 0);
      bindings.clearTimeout(handle);
      timers.flush();
    }, /interface Window/);

    assert.equal(fired, false, 'the timer scheduled above must have been cancelled before callbacks flush');
  });

  it('still schedules and fires a real timer through the bindings', async () => {
    const bindings = buildBindings(setTimeout, clearTimeout);
    await new Promise<void>((resolve, reject) => {
      bindings.setTimeout(() => {
        try {
          resolve();
        } catch (error) {
          reject(error as Error);
        }
      }, 0);
    });
  });
});
