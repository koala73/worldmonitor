/**
 * Unit tests for flushStaleRefreshes logic.
 *
 * Tests the stale-refresh flushing algorithm directly without Playwright
 * overhead. The function under test lives in App.ts but is a pure algorithm
 * over two Maps + a timestamp — we replicate its logic from source to keep
 * tests fast and free of browser dependencies.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const appSrc = readFileSync(resolve(__dirname, '..', 'src', 'App.ts'), 'utf-8');

// ========================================================================
// Verify source structure hasn't changed
// ========================================================================

describe('flushStaleRefreshes source contract', () => {
  it('method exists in App.ts', () => {
    assert.match(appSrc, /private flushStaleRefreshes\(\): void/,
      'flushStaleRefreshes must exist as a private method');
  });

  it('checks hiddenSince early return', () => {
    assert.match(appSrc, /if \(!this\.hiddenSince\) return/,
      'Must early-return when hiddenSince is falsy');
  });

  it('resets hiddenSince to 0', () => {
    assert.match(appSrc, /this\.hiddenSince = 0/,
      'Must reset hiddenSince to 0 after capturing duration');
  });

  it('staggers by 150ms', () => {
    assert.match(appSrc, /stagger \+= 150/,
      'Must stagger re-triggers by 150ms');
  });

  it('skips non-stale services', () => {
    assert.match(appSrc, /if \(hiddenMs < intervalMs\) continue/,
      'Must skip services where hidden duration < interval');
  });

  it('clears pending timeout before re-triggering', () => {
    assert.match(appSrc, /if \(pending\) clearTimeout\(pending\)/,
      'Must clear existing timeout before setting new one');
  });

  it('sets new timeout in refreshTimeoutIds', () => {
    assert.match(appSrc, /this\.refreshTimeoutIds\.set\(name, setTimeout/,
      'Must store new timeout ID in the map');
  });
});

// ========================================================================
// Behavioral tests — replicate the algorithm to test logic
// ========================================================================

/**
 * Standalone implementation of flushStaleRefreshes extracted from App.ts.
 * Kept in sync by the source contract tests above.
 */
function flushStaleRefreshes(ctx) {
  if (!ctx.hiddenSince) return;
  const hiddenMs = Date.now() - ctx.hiddenSince;
  ctx.hiddenSince = 0;

  let stagger = 0;
  for (const [name, { run, intervalMs }] of ctx.refreshRunners) {
    if (hiddenMs < intervalMs) continue;
    const pending = ctx.refreshTimeoutIds.get(name);
    if (pending) clearTimeout(pending);
    const delay = stagger;
    stagger += 150;
    ctx.refreshTimeoutIds.set(name, setTimeout(() => void run(), delay));
  }
}

function createContext() {
  return {
    refreshRunners: new Map(),
    refreshTimeoutIds: new Map(),
    hiddenSince: 0,
  };
}

// Track active timeouts for cleanup
let activeTimeouts = [];
const trackedSetTimeout = (fn, ms) => {
  const id = setTimeout(fn, ms);
  activeTimeouts.push(id);
  return id;
};

describe('flushStaleRefreshes behavior', () => {
  let ctx;

  beforeEach(() => {
    ctx = createContext();
    activeTimeouts = [];
  });

  afterEach(() => {
    // Clean up ALL timeouts to prevent leaks
    for (const id of activeTimeouts) clearTimeout(id);
    for (const id of ctx.refreshTimeoutIds.values()) clearTimeout(id);
    activeTimeouts = [];
  });

  it('re-triggers services hidden longer than their interval', async () => {
    const flushed = [];

    ctx.refreshRunners.set('fast-service', {
      run: async () => { flushed.push('fast-service'); },
      intervalMs: 60_000,
    });
    ctx.refreshRunners.set('medium-service', {
      run: async () => { flushed.push('medium-service'); },
      intervalMs: 300_000,
    });
    ctx.refreshRunners.set('slow-service', {
      run: async () => { flushed.push('slow-service'); },
      intervalMs: 1_800_000,
    });

    for (const name of ctx.refreshRunners.keys()) {
      ctx.refreshTimeoutIds.set(name, trackedSetTimeout(() => {}, 999_999));
    }

    ctx.hiddenSince = Date.now() - 600_000; // 10 min hidden
    flushStaleRefreshes(ctx);

    await new Promise((r) => setTimeout(r, 600));

    assert.ok(flushed.includes('fast-service'), 'fast-service (1m interval) should flush after 10m hidden');
    assert.ok(flushed.includes('medium-service'), 'medium-service (5m interval) should flush after 10m hidden');
    assert.ok(!flushed.includes('slow-service'), 'slow-service (30m interval) should NOT flush after 10m hidden');
    assert.equal(ctx.hiddenSince, 0, 'hiddenSince must be reset to 0');
  });

  it('does nothing when hiddenSince is 0', async () => {
    let called = false;
    ctx.refreshRunners.set('service', {
      run: async () => { called = true; },
      intervalMs: 60_000,
    });
    // No fake timeout needed — method should return before checking timeouts

    ctx.hiddenSince = 0;
    flushStaleRefreshes(ctx);

    await new Promise((r) => setTimeout(r, 100));
    assert.equal(called, false, 'No services should flush when hiddenSince is 0');
  });

  it('skips services hidden for less than their interval', async () => {
    let called = false;
    ctx.refreshRunners.set('service', {
      run: async () => { called = true; },
      intervalMs: 300_000,
    });
    ctx.refreshTimeoutIds.set('service', trackedSetTimeout(() => {}, 999_999));

    ctx.hiddenSince = Date.now() - 30_000; // 30s hidden, 5m interval
    flushStaleRefreshes(ctx);

    await new Promise((r) => setTimeout(r, 300));
    assert.equal(called, false, '30s hidden < 5m interval — should NOT flush');
    assert.equal(ctx.hiddenSince, 0, 'hiddenSince must still be reset even if no services flushed');
  });

  it('staggers re-triggered services in order with minimum gaps', async () => {
    const timestamps = [];
    const start = Date.now();

    for (const name of ['svc-a', 'svc-b', 'svc-c']) {
      ctx.refreshRunners.set(name, {
        run: async () => { timestamps.push(Date.now() - start); },
        intervalMs: 60_000,
      });
      ctx.refreshTimeoutIds.set(name, trackedSetTimeout(() => {}, 999_999));
    }

    ctx.hiddenSince = Date.now() - 600_000;
    flushStaleRefreshes(ctx);

    await new Promise((r) => setTimeout(r, 700));

    assert.equal(timestamps.length, 3, 'All 3 services should fire');
    // Assert ordering and minimum gaps instead of absolute time windows
    assert.ok(timestamps[0] < timestamps[1], 'Second service fires after first');
    assert.ok(timestamps[1] < timestamps[2], 'Third service fires after second');
    assert.ok(timestamps[1] - timestamps[0] >= 100, 'Gap between 1st and 2nd >= 100ms');
    assert.ok(timestamps[2] - timestamps[1] >= 100, 'Gap between 2nd and 3rd >= 100ms');
  });

  it('replaces timeout IDs in refreshTimeoutIds after flush', () => {
    ctx.refreshRunners.set('svc', {
      run: async () => {},
      intervalMs: 60_000,
    });
    const originalId = trackedSetTimeout(() => {}, 999_999);
    ctx.refreshTimeoutIds.set('svc', originalId);

    ctx.hiddenSince = Date.now() - 600_000;
    flushStaleRefreshes(ctx);

    const newId = ctx.refreshTimeoutIds.get('svc');
    assert.ok(newId !== undefined, 'refreshTimeoutIds should still have an entry for the service');
    assert.notEqual(newId, originalId, 'Timeout ID should be replaced with a new one');
  });

  it('does not touch timeout IDs for non-stale services', () => {
    ctx.refreshRunners.set('fresh', {
      run: async () => {},
      intervalMs: 1_800_000,
    });
    const originalId = trackedSetTimeout(() => {}, 999_999);
    ctx.refreshTimeoutIds.set('fresh', originalId);

    ctx.hiddenSince = Date.now() - 60_000; // 1min hidden, 30min interval
    flushStaleRefreshes(ctx);

    assert.equal(ctx.refreshTimeoutIds.get('fresh'), originalId,
      'Non-stale service timeout should be untouched');
  });
});
