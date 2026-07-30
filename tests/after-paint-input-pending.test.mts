import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isInputPending } from '@/utils/after-paint';

type Scheduling = { isInputPending?: (...args: unknown[]) => boolean };

/**
 * Swap `globalThis.navigator` around a call. Node 22+ ships a real `navigator`
 * global (configurable), so save/restore its property descriptor rather than a
 * plain assignment — an ESM (strict-mode) assignment to a getter-only global
 * would throw.
 */
function withNavigator<T>(value: { scheduling?: Scheduling } | undefined, run: () => T): T {
  const desc = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  if (value === undefined) {
    delete (globalThis as { navigator?: unknown }).navigator;
  } else {
    Object.defineProperty(globalThis, 'navigator', { value, configurable: true, writable: true });
  }
  try {
    return run();
  } finally {
    if (desc) Object.defineProperty(globalThis, 'navigator', desc);
    else delete (globalThis as { navigator?: unknown }).navigator;
  }
}

test('isInputPending returns true when the API reports pending input (#5042)', () => {
  const val = withNavigator({ scheduling: { isInputPending: () => true } }, () => isInputPending());
  assert.equal(val, true);
});

test('isInputPending returns false when the API reports no pending input', () => {
  const val = withNavigator({ scheduling: { isInputPending: () => false } }, () => isInputPending());
  assert.equal(val, false);
});

test('isInputPending returns false when navigator.scheduling lacks isInputPending (graceful, R6)', () => {
  const val = withNavigator({ scheduling: {} }, () => isInputPending());
  assert.equal(val, false);
});

test('isInputPending returns false when navigator.scheduling is absent (R6)', () => {
  const val = withNavigator({}, () => isInputPending());
  assert.equal(val, false);
});

test('isInputPending returns false when navigator is absent (node/SSR, R6)', () => {
  const val = withNavigator(undefined, () => isInputPending());
  assert.equal(val, false);
});

test('isInputPending calls the API with no arguments (discrete-only scope)', () => {
  let receivedArgs: unknown[] | null = null;
  withNavigator(
    { scheduling: { isInputPending: (...args: unknown[]) => { receivedArgs = args; return false; } } },
    () => isInputPending(),
  );
  assert.deepEqual(receivedArgs, [], 'no-arg call keeps includeContinuous at its false default');
});
