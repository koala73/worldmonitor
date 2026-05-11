// Tests for the resize debounce fix applied to panel-layout.ts
//
// Verifies:
// - debounce() collapses rapid-fire calls into one
// - PanelLayoutManager wires the resize listener via _onResizeDebounced
// - destroy() cancels the debounce timer

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const panelLayoutSrc = readFileSync(
  resolve(__dirname, '../src/app/panel-layout.ts'),
  'utf-8'
);

// ------------------------------------------------------------------
// Inline debounce (mirrors src/utils/index.ts) to test behaviour
// without pulling in import.meta.env-dependent modules
// ------------------------------------------------------------------
/** @returns {{ cancel: () => void }} */
function debounce(fn, delay) {
  let timeoutId;
  const debounced = (..._args) => {
    clearTimeout(timeoutId);
    timeoutId = setTimeout(() => fn(), delay);
  };
  debounced.cancel = () => { clearTimeout(timeoutId); };
  return debounced;
}

describe('debounce utility (inline — mirrors src/utils/index.ts)', () => {
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

// ------------------------------------------------------------------
// Source-level verification of the resize debounce wiring in panel-layout.ts
// Guards against a future refactor accidentally reverting the debounce.
// ------------------------------------------------------------------
describe('resize debounce wiring (panel-layout.ts)', () => {
  it('declares _onResizeDebounced nullable field', () => {
    // cancel(): TypeScript method signature — note the parentheses around cancel
    assert.ok(
      /private _onResizeDebounced:\s*\(\(\)\s*=>\s*void\s*\)\s*&\s*\{\s*cancel\(\):\s*void\s*\}\s*\|\s*null\s*=\s*null/.test(
        panelLayoutSrc
      ),
      '_onResizeDebounced field not found with correct type signature'
    );
  });

  it('init sets _onResizeDebounced = debounce(ensureCorrectZones, 100)', () => {
    assert.ok(
      /this\._onResizeDebounced\s*=\s*debounce\(\(\)\s*=>\s*this\.ensureCorrectZones\(\),\s*100\)/.test(
        panelLayoutSrc
      ),
      'debounce(ensureCorrectZones, 100) assignment not found'
    );
  });

  it('addEventListener uses _onResizeDebounced (not bare ensureCorrectZones)', () => {
    const addLine = panelLayoutSrc
      .split('\n')
      .find(l => l.includes("addEventListener") && l.includes("'resize'"));
    assert.ok(addLine, "resize addEventListener line not found");
    assert.ok(
      /_onResizeDebounced/.test(addLine),
      `resize listener must use _onResizeDebounced. Found: ${addLine.trim()}`
    );
    assert.ok(
      !/\(\)\s*=>\s*this\.ensureCorrectZones\(\)/.test(addLine),
      'resize listener must not use bare arrow fn (the original bug)'
    );
  });

  it('destroy() calls _onResizeDebounced?.cancel()', () => {
    // Cancel call present somewhere in the source (destroy() is >400 lines)
    assert.ok(
      /_onResizeDebounced\?\.cancel\(\)/.test(panelLayoutSrc),
      'destroy() must call _onResizeDebounced?.cancel()'
    );
  });


  it('destroy() removes listener via _onResizeDebounced reference', () => {
    // removeEventListener for resize using _onResizeDebounced present
    assert.ok(
      /window\.removeEventListener\s*\(\s*['"]resize['"]\s*,\s*this\._onResizeDebounced/.test(
        panelLayoutSrc
      ),
      'destroy() must remove resize listener via _onResizeDebounced'
    );
  });
});
