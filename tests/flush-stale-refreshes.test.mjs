/**
 * Unit tests for flushStaleRefreshes logic.
 *
 * Executes the actual flushStaleRefreshes method body extracted from
 * refresh-scheduler.ts using deterministic fake timers. This avoids
 * Playwright/browser overhead, avoids wall-clock sleeps, and keeps
 * behavior coverage aligned with source.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const appSrc = readFileSync(resolve(__dirname, '..', 'src', 'app', 'refresh-scheduler.ts'), 'utf-8');

function extractMethodBody(source, methodName) {
  const signature = new RegExp(`(?:private\\s+)?${methodName}\\s*\\(\\)\\s*(?::[^\\{]+)?\\{`);
  const match = signature.exec(source);
  if (!match) throw new Error(`Could not find ${methodName} in source`);

  const bodyStart = match.index + match[0].length;
  let depth = 1;
  let state = 'code';
  let escaped = false;

  for (let i = bodyStart; i < source.length; i += 1) {
    const ch = source[i];
    const next = source[i + 1];

    if (state === 'line-comment') {
      if (ch === '\n') state = 'code';
      continue;
    }
    if (state === 'block-comment') {
      if (ch === '*' && next === '/') {
        state = 'code';
        i += 1;
      }
      continue;
    }
    if (state === 'single-quote') {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '\'') {
        state = 'code';
      }
      continue;
    }
    if (state === 'double-quote') {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        state = 'code';
      }
      continue;
    }
    if (state === 'template') {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '`') {
        state = 'code';
      }
      continue;
    }

    if (ch === '/' && next === '/') {
      state = 'line-comment';
      i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      state = 'block-comment';
      i += 1;
      continue;
    }
    if (ch === '\'') {
      state = 'single-quote';
      continue;
    }
    if (ch === '"') {
      state = 'double-quote';
      continue;
    }
    if (ch === '`') {
      state = 'template';
      continue;
    }

    if (ch === '{') {
      depth += 1;
      continue;
    }
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(bodyStart, i);
    }
  }

  throw new Error(`Could not extract body for ${methodName}`);
}

function buildFlushStaleRefreshes(timers) {
  const methodBody = extractMethodBody(appSrc, 'flushStaleRefreshes');
  const factory = new Function('Date', 'setTimeout', 'clearTimeout', `
    return function flushStaleRefreshes() {
      ${methodBody}
    };
  `);

  return factory(
    { now: () => timers.now },
    timers.setTimeout.bind(timers),
    timers.clearTimeout.bind(timers)
  );
}

function createContext() {
  return {
    refreshRunners: new Map(),
    flushTimeoutIds: new Set(),
    hiddenSince: 0,
  };
}

function createFakeTimers(startMs = 1_000_000) {
  const tasks = new Map();
  let now = startMs;
  let nextId = 1;

  const sortedDueTasks = (target) =>
    Array.from(tasks.entries())
      .filter(([, task]) => task.at <= target)
      .sort((a, b) => (a[1].at - b[1].at) || (a[0] - b[0]));

  return {
    get now() {
      return now;
    },
    setTimeout(fn, delay = 0) {
      const id = nextId;
      nextId += 1;
      tasks.set(id, { at: now + Math.max(0, delay), fn });
      return id;
    },
    clearTimeout(id) {
      tasks.delete(id);
    },
    advanceBy(ms) {
      const target = now + Math.max(0, ms);
      while (true) {
        const due = sortedDueTasks(target);
        if (!due.length) break;
        const [id, task] = due[0];
        tasks.delete(id);
        now = task.at;
        task.fn();
      }
      now = target;
    },
    runAll() {
      while (tasks.size > 0) {
        const [[id, task]] = Array.from(tasks.entries()).sort(
          (a, b) => (a[1].at - b[1].at) || (a[0] - b[0])
        );
        tasks.delete(id);
        now = task.at;
        task.fn();
      }
    },
    has(id) {
      return tasks.has(id);
    },
  };
}

describe('flushStaleRefreshes behavior', () => {
  let ctx;
  let timers;
  let flushStaleRefreshes;

  beforeEach(() => {
    ctx = createContext();
    timers = createFakeTimers();
    flushStaleRefreshes = buildFlushStaleRefreshes(timers);
  });

  afterEach(() => {
    timers.runAll();
  });

  it('loads flushStaleRefreshes from App.ts source', () => {
    assert.equal(typeof flushStaleRefreshes, 'function');
  });

  it('re-triggers services hidden longer than their interval', () => {
    const flushed = [];

    ctx.refreshRunners.set('fast-service', {
      loop: { trigger: () => { flushed.push('fast-service'); } },
      intervalMs: 60_000,
    });
    ctx.refreshRunners.set('medium-service', {
      loop: { trigger: () => { flushed.push('medium-service'); } },
      intervalMs: 300_000,
    });
    ctx.refreshRunners.set('slow-service', {
      loop: { trigger: () => { flushed.push('slow-service'); } },
      intervalMs: 1_800_000,
    });

    ctx.hiddenSince = timers.now - 600_000; // 10 min hidden
    flushStaleRefreshes.call(ctx);
    timers.runAll();

    assert.ok(flushed.includes('fast-service'), 'fast-service (1m interval) should flush after 10m hidden');
    assert.ok(flushed.includes('medium-service'), 'medium-service (5m interval) should flush after 10m hidden');
    assert.ok(!flushed.includes('slow-service'), 'slow-service (30m interval) should NOT flush after 10m hidden');
    assert.equal(ctx.hiddenSince, 0, 'hiddenSince must be reset to 0');
  });

  it('does nothing when hiddenSince is 0', () => {
    let called = false;
    ctx.refreshRunners.set('service', {
      loop: { trigger: () => { called = true; } },
      intervalMs: 60_000,
    });

    ctx.hiddenSince = 0;
    flushStaleRefreshes.call(ctx);
    timers.runAll();
    assert.equal(called, false, 'No services should flush when hiddenSince is 0');
  });

  it('skips services hidden for less than their interval', () => {
    let called = false;
    ctx.refreshRunners.set('service', {
      loop: { trigger: () => { called = true; } },
      intervalMs: 300_000,
    });

    ctx.hiddenSince = timers.now - 30_000; // 30s hidden, 5m interval
    flushStaleRefreshes.call(ctx);
    timers.runAll();
    assert.equal(called, false, '30s hidden < 5m interval — should NOT flush');
    assert.equal(ctx.hiddenSince, 0, 'hiddenSince must still be reset even if no services flushed');
  });

  it('staggers re-triggered services deterministically by 150ms', () => {
    const timestamps = [];
    const start = timers.now;

    for (const name of ['svc-a', 'svc-b', 'svc-c']) {
      ctx.refreshRunners.set(name, {
        loop: { trigger: () => { timestamps.push(timers.now - start); } },
        intervalMs: 60_000,
      });
    }

    ctx.hiddenSince = timers.now - 600_000;
    flushStaleRefreshes.call(ctx);
    timers.runAll();

    assert.equal(timestamps.length, 3, 'All 3 services should fire');
    assert.deepEqual(timestamps, [0, 150, 300], 'Services should fire in 150ms steps');
  });

  it('cleans up stale flush timeout IDs after triggering', () => {
    ctx.refreshRunners.set('svc', {
      loop: { trigger: () => {} },
      intervalMs: 60_000,
    });

    ctx.hiddenSince = timers.now - 600_000;
    flushStaleRefreshes.call(ctx);

    // Before running timers, flushTimeoutIds should have pending entries
    assert.ok(ctx.flushTimeoutIds.size > 0, 'Should have pending flush timeout IDs');

    timers.runAll();

    // After running, the callbacks should self-delete from the set
    assert.equal(ctx.flushTimeoutIds.size, 0, 'Flush timeout IDs should be cleaned up after execution');
  });

  it('does not trigger non-stale services', () => {
    let called = false;
    ctx.refreshRunners.set('fresh', {
      loop: { trigger: () => { called = true; } },
      intervalMs: 1_800_000,
    });

    ctx.hiddenSince = timers.now - 60_000; // 1min hidden, 30min interval
    flushStaleRefreshes.call(ctx);
    timers.runAll();

    assert.equal(called, false, 'Non-stale service should not be triggered');
  });
});
