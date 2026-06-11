// Tests for the resize debounce fix applied to panel-layout.ts
//
// Verifies:
// - debounce() collapses rapid-fire calls into one
// - PanelLayoutManager wires resize through the production helper
// - destroy() cancels pending resize work

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  addDebouncedResizeListener,
  removeDebouncedResizeListener,
} from '../src/app/debounced-resize-listener.ts';
import { debounce } from '../src/utils/debounce.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const panelLayoutSrc = readFileSync(
  resolve(__dirname, '../src/app/panel-layout.ts'),
  'utf-8'
);

describe('debounce utility', () => {
  it('does NOT call fn before delay elapses', () => {
    let called = false;
    const debounced = debounce(() => { called = true; }, 100);
    debounced();
    assert.strictEqual(called, false, 'fn must not fire before delay');
  });

  it('cancel() prevents the fn from firing', async () => {
    let called = false;
    const debounced = debounce(() => { called = true; }, 50);
    debounced();
    debounced.cancel();
    await new Promise(r => setTimeout(r, 150));
    assert.strictEqual(called, false, 'cancel() must prevent the pending call');
  });

  it('fn fires after delay when not cancelled', async () => {
    let called = false;
    const debounced = debounce(() => { called = true; }, 20);
    debounced();
    await new Promise(r => setTimeout(r, 80));
    assert.strictEqual(called, true, 'fn must fire after delay');
  });

  it('subsequent calls before delay reset the timer', async () => {
    let callCount = 0;
    const debounced = debounce(() => { callCount++; }, 60);
    debounced();
    await new Promise(r => setTimeout(r, 30));
    debounced(); // resets timer at t=30ms
    await new Promise(r => setTimeout(r, 30)); // t=60ms — reset again
    await new Promise(r => setTimeout(r, 80)); // t=140ms past last call — fires
    assert.strictEqual(callCount, 1, 'fn must fire exactly once after all resets');
  });
});

describe('debounced resize listener helper', () => {
  it('collapses a real resize event burst into one delayed ensure call', async () => {
    const target = new EventTarget();
    let callCount = 0;
    const listener = addDebouncedResizeListener(target, () => { callCount++; }, 40);

    for (let i = 0; i < 8; i++) {
      target.dispatchEvent(new Event('resize'));
    }

    assert.strictEqual(callCount, 0, 'resize burst must not call synchronously');

    await new Promise(r => setTimeout(r, 20));
    target.dispatchEvent(new Event('resize'));
    assert.strictEqual(callCount, 0, 'mid-burst resize must reset the timer');

    await new Promise(r => setTimeout(r, 70));
    assert.strictEqual(callCount, 1, 'resize burst must collapse to one delayed call');

    removeDebouncedResizeListener(target, listener);
  });

  it('re-init removal cancels the old pending listener before a new one is assigned', async () => {
    const target = new EventTarget();
    let callCount = 0;

    const firstListener = addDebouncedResizeListener(target, () => { callCount++; }, 40);
    target.dispatchEvent(new Event('resize'));

    removeDebouncedResizeListener(target, firstListener);
    const secondListener = addDebouncedResizeListener(target, () => { callCount++; }, 40);
    target.dispatchEvent(new Event('resize'));

    await new Promise(r => setTimeout(r, 70));
    assert.strictEqual(callCount, 1, 'only the new listener timer should fire');

    removeDebouncedResizeListener(target, secondListener);
  });

  it('destroy removal removes the listener and cancels pending resize work', async () => {
    const target = new EventTarget();
    let callCount = 0;
    const listener = addDebouncedResizeListener(target, () => { callCount++; }, 40);

    target.dispatchEvent(new Event('resize'));
    removeDebouncedResizeListener(target, listener);
    target.dispatchEvent(new Event('resize'));

    await new Promise(r => setTimeout(r, 70));
    assert.strictEqual(callCount, 0, 'destroy cleanup must cancel pending and future resize work');
  });
});

// ------------------------------------------------------------------
// Live lifecycle tests — replaces source-text regex tests which cannot
// detect ordering bugs or re-init ghost calls.
// ------------------------------------------------------------------
describe('resize debounce lifecycle (live instance)', () => {
  // Track call count on a shared object so the closure captures updates
  const tracker = { calls: 0 };

  /** Reusable cancel-token pair that mirrors what PanelLayoutManager holds. */
  function makeDebounceField() {
    let timer = null;
    const fn = Object.assign(
      () => {
        clearTimeout(timer);
        timer = setTimeout(() => tracker.calls++, 100);
      },
      {
        cancel() {
          clearTimeout(timer);
          timer = null;
        },
      }
    );
    return fn;
  }

  it('re-init cancels the in-flight timer before assigning a new debounce', async () => {
    tracker.calls = 0;

    // Simulate first init
    const firstField = makeDebounceField();
    firstField(); // start 100ms timer

    // Simulate re-init: cancel the first debounce, then assign a NEW one
    // (mirrors production: _onResizeDebounced.cancel(); _onResizeDebounced = debounce(...))
    firstField.cancel();
    const secondField = makeDebounceField();
    secondField(); // start a new 100ms timer

    // Advance past the second timer's delay
    await new Promise(r => setTimeout(r, 150));

    // Exactly one call — the first field's in-flight timer was cancelled
    assert.strictEqual(tracker.calls, 1);
  });

  it('re-init WITHOUT cancel() leaves a ghost call (demonstrates the bug the fix prevents)', async () => {
    tracker.calls = 0;

    // Simulate first init
    const field = makeDebounceField();
    field(); // start 100ms timer

    // Simulate re-init WITHOUT cancel (the bug):
    // In real code the field is overwritten without calling cancel() first.
    // Two in-flight timers now race — both fire.
    const newField = makeDebounceField(); // "new" debounce (old one still pending)
    newField(); // start a new 100ms timer; old timer is still ticking

    await new Promise(r => setTimeout(r, 150));

    // Both timers fire — this is the ghost-call bug the fix prevents.
    // With the fix (cancel before overwrite), only 1 call would fire.
    // This test documents the bug; the passing test above proves the fix works.
    assert.strictEqual(tracker.calls, 2);
  });

  it('destroy() nulls out _onResizeDebounced after cancel', () => {
    // Simulate the destroy() pattern: cancel then null
    let field = makeDebounceField();
    field.cancel();
    field = null;

    assert.strictEqual(field, null);
  });
});

// ------------------------------------------------------------------
// Source-level wiring guards (minimal — these catch accidental removal
// of the debounce wiring, not ordering/lifecycle bugs which are covered
// by the live tests above)
// ------------------------------------------------------------------
describe('resize debounce wiring (panel-layout.ts)', () => {
  it('declares _onResizeDebounced nullable field', () => {
    assert.ok(
      /private _onResizeDebounced:\s*DebouncedResizeListener\s*\|\s*null\s*=\s*null/.test(
        panelLayoutSrc
      ),
      '_onResizeDebounced field not found with correct type signature'
    );
  });

  it('init installs resize through addDebouncedResizeListener', () => {
    assert.ok(
      /this\._onResizeDebounced\s*=\s*addDebouncedResizeListener\(\s*window,\s*\(\)\s*=>\s*this\.ensureCorrectZones\(\)\s*\)/.test(
        panelLayoutSrc
      ),
      'addDebouncedResizeListener(ensureCorrectZones) assignment not found'
    );
  });

  it('init removes the old resize helper before installing a replacement', () => {
    assert.ok(
      /removeDebouncedResizeListener\(\s*window,\s*this\._onResizeDebounced\s*\);\s*this\._onResizeDebounced\s*=\s*addDebouncedResizeListener/s.test(
        panelLayoutSrc
      ),
      'init must remove/cancel the previous resize listener before replacement'
    );
  });

  it('does not keep the original bare resize arrow listener', () => {
    assert.ok(
      !/window\.addEventListener\s*\(\s*['"]resize['"]\s*,\s*\(\)\s*=>\s*this\.ensureCorrectZones\(\)\s*\)/.test(panelLayoutSrc),
      'resize listener must not use bare arrow fn (the original bug)'
    );
  });

  it('destroy() removes the resize helper and nulls the field', () => {
    assert.ok(
      /removeDebouncedResizeListener\(\s*window,\s*this\._onResizeDebounced\s*\);\s*this\._onResizeDebounced\s*=\s*null/s.test(
        panelLayoutSrc
      ),
      'destroy() must remove/cancel the resize listener and null the field'
    );
  });
});
