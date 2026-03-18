import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rawSrc = readFileSync(resolve(__dirname, '..', 'src', 'services', 'runtime.ts'), 'utf-8');

function stripTS(src) {
  let out = src;
  out = out.replace(/\bexport\s+type\s+\w+\s*=[^;]+;/g, '');
  out = out.replace(/\bexport\s+interface\s+\w+\s*\{[^}]*\}/g, '');
  out = out.replace(/\bexport\s+/g, '');
  out = out.replace(/\bas\s+\{[^}]+\}/g, '');
  out = out.replace(/:\s*ReturnType<typeof\s+\w+>\s*\|\s*null/g, '');
  out = out.replace(/:\s*AbortController\s*\|\s*null/g, '');
  out = out.replace(/:\s*SmartPollReason/g, '');
  out = out.replace(/:\s*SmartPollContext/g, '');
  out = out.replace(/:\s*SmartPollOptions/g, '');
  out = out.replace(/:\s*SmartPollLoopHandle/g, '');
  out = out.replace(/:\s*Promise<void>/g, '');
  out = out.replace(/:\s*Promise<boolean\s*\|\s*void>\s*\|\s*boolean\s*\|\s*void/g, '');
  out = out.replace(/\(\s*ctx\s*\)\s*=>/g, '(ctx) =>');
  out = out.replace(/:\s*number\s*\|\s*null/g, '');
  out = out.replace(/:\s*(?:number|boolean|string|unknown|void)\b/g, '');
  out = out.replace(/\?\.\s*/g, '?.');
  return out;
}

const runtimeSrc = stripTS(rawSrc);

function extractBody(source, funcName) {
  const sig = new RegExp(`function\\s+${funcName}\\s*\\(`);
  const match = sig.exec(source);
  if (!match) throw new Error(`Could not find function ${funcName}`);

  const openBrace = source.indexOf('{', match.index);
  if (openBrace === -1) throw new Error(`No body found for ${funcName}`);
  const bodyStart = openBrace + 1;
  let depth = 1;
  let state = 'code';
  let escaped = false;

  for (let j = bodyStart; j < source.length; j++) {
    const ch = source[j];
    const next = source[j + 1];

    if (state === 'line-comment') { if (ch === '\n') state = 'code'; continue; }
    if (state === 'block-comment') { if (ch === '*' && next === '/') { state = 'code'; j++; } continue; }
    if (state === 'single-quote') { if (escaped) { escaped = false; } else if (ch === '\\') { escaped = true; } else if (ch === "'") { state = 'code'; } continue; }
    if (state === 'double-quote') { if (escaped) { escaped = false; } else if (ch === '\\') { escaped = true; } else if (ch === '"') { state = 'code'; } continue; }
    if (state === 'template') { if (escaped) { escaped = false; } else if (ch === '\\') { escaped = true; } else if (ch === '`') { state = 'code'; } continue; }

    if (ch === '/' && next === '/') { state = 'line-comment'; j++; continue; }
    if (ch === '/' && next === '*') { state = 'block-comment'; j++; continue; }
    if (ch === "'") { state = 'single-quote'; continue; }
    if (ch === '"') { state = 'double-quote'; continue; }
    if (ch === '`') { state = 'template'; continue; }
    if (ch === '{') { depth++; continue; }
    if (ch === '}') { depth--; if (depth === 0) return source.slice(bodyStart, j); }
  }
  throw new Error(`Could not extract body for ${funcName}`);
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
    get now() { return now; },
    get pendingCount() { return tasks.size; },
    setTimeout(fn, delay = 0) {
      const id = nextId++;
      tasks.set(id, { at: now + Math.max(0, delay), fn });
      return id;
    },
    clearTimeout(id) { tasks.delete(id); },
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
    async advanceByAsync(ms) {
      const target = now + Math.max(0, ms);
      while (true) {
        const due = sortedDueTasks(target);
        if (!due.length) break;
        const [id, task] = due[0];
        tasks.delete(id);
        now = task.at;
        task.fn();
        await Promise.resolve();
      }
      now = target;
    },
    runAll() {
      let safety = 0;
      while (tasks.size > 0 && safety < 500) {
        const [[id, task]] = Array.from(tasks.entries()).sort(
          (a, b) => (a[1].at - b[1].at) || (a[0] - b[0])
        );
        tasks.delete(id);
        now = task.at;
        task.fn();
        safety++;
      }
    },
  };
}

function buildSmartPollLoop(timers, docMock) {
  const isAbortErrorBody = extractBody(runtimeSrc, 'isAbortError');
  const hasVisibilityApiBody = extractBody(runtimeSrc, 'hasVisibilityApi');
  const isDocumentHiddenBody = extractBody(runtimeSrc, 'isDocumentHidden');
  const mainBody = extractBody(runtimeSrc, 'startSmartPollLoop');

  const factory = new Function(
    'setTimeout', 'clearTimeout', 'Math', 'AbortController', 'document',
    `
    function isAbortError(error) { ${isAbortErrorBody} }
    function hasVisibilityApi() { ${hasVisibilityApiBody} }
    function isDocumentHidden() { ${isDocumentHiddenBody} }
    return function startSmartPollLoop(poll, opts) { ${mainBody} };
    `
  );

  return factory(
    timers.setTimeout.bind(timers),
    timers.clearTimeout.bind(timers),
    Math,
    AbortController,
    docMock,
  );
}

function createDocMock(hidden = false) {
  const listeners = new Map();
  return {
    visibilityState: hidden ? 'hidden' : 'visible',
    addEventListener(evt, fn) {
      if (!listeners.has(evt)) listeners.set(evt, []);
      listeners.get(evt).push(fn);
    },
    removeEventListener(evt, fn) {
      if (!listeners.has(evt)) return;
      const arr = listeners.get(evt);
      const idx = arr.indexOf(fn);
      if (idx !== -1) arr.splice(idx, 1);
    },
    _fire(evt) {
      for (const fn of (listeners.get(evt) || [])) fn();
    },
    _setHidden(h) {
      this.visibilityState = h ? 'hidden' : 'visible';
    },
    _listenerCount(evt) {
      return (listeners.get(evt) || []).length;
    },
  };
}

describe('startSmartPollLoop', () => {
  let timers;
  let doc;
  let startSmartPollLoop;

  beforeEach(() => {
    timers = createFakeTimers();
    doc = createDocMock();
    startSmartPollLoop = buildSmartPollLoop(timers, doc);
  });

  describe('scheduling', () => {
    it('fires first tick after intervalMs', async () => {
      let calls = 0;
      startSmartPollLoop(() => { calls++; }, { intervalMs: 5_000, jitterFraction: 0 });

      assert.equal(calls, 0);
      timers.advanceBy(4_999);
      await Promise.resolve();
      assert.equal(calls, 0);
      timers.advanceBy(1);
      await Promise.resolve();
      assert.equal(calls, 1);
    });

    it('subsequent ticks continue firing', async () => {
      let calls = 0;
      startSmartPollLoop(() => { calls++; }, { intervalMs: 5_000, jitterFraction: 0 });

      timers.advanceBy(5_000);
      await Promise.resolve();
      assert.equal(calls, 1);

      timers.advanceBy(5_000);
      await Promise.resolve();
      assert.equal(calls, 2);

      timers.advanceBy(5_000);
      await Promise.resolve();
      assert.equal(calls, 3);
    });
  });

  describe('jitter', () => {
    it('delay varies within ±jitterFraction of base interval', async () => {
      const delays = [];
      let lastCall = timers.now;
      const poll = () => {
        delays.push(timers.now - lastCall);
        lastCall = timers.now;
      };

      startSmartPollLoop(poll, { intervalMs: 10_000, jitterFraction: 0.2 });

      for (let i = 0; i < 250; i++) {
        timers.advanceBy(500);
        await Promise.resolve();
      }

      assert.ok(delays.length >= 8, `expected at least 8 calls, got ${delays.length}`);
      for (const d of delays) {
        assert.ok(d >= 8_000, `delay ${d} should be >= 8000`);
        assert.ok(d <= 13_000, `delay ${d} should be <= 13000`);
      }
    });
  });

  describe('backoff', () => {
    it('doubles interval on false return, resets on success', async () => {
      let returnVal = false;
      let calls = 0;
      startSmartPollLoop(() => { calls++; return returnVal; }, {
        intervalMs: 1_000, jitterFraction: 0, maxBackoffMultiplier: 8,
      });

      timers.advanceBy(1_000);
      await Promise.resolve();
      assert.equal(calls, 1);

      timers.advanceBy(2_000);
      await Promise.resolve();
      assert.equal(calls, 2);

      timers.advanceBy(4_000);
      await Promise.resolve();
      assert.equal(calls, 3);

      returnVal = true;
      timers.advanceBy(8_000);
      await Promise.resolve();
      assert.equal(calls, 4);

      timers.advanceBy(1_000);
      await Promise.resolve();
      assert.equal(calls, 5);
    });

    it('caps at maxBackoffMultiplier', async () => {
      let calls = 0;
      startSmartPollLoop(() => { calls++; return false; }, {
        intervalMs: 1_000, jitterFraction: 0, maxBackoffMultiplier: 4,
      });

      timers.advanceBy(1_000); await Promise.resolve(); // 1x
      timers.advanceBy(2_000); await Promise.resolve(); // 2x
      timers.advanceBy(4_000); await Promise.resolve(); // 4x (cap)
      assert.equal(calls, 3);

      timers.advanceBy(4_000); await Promise.resolve(); // still 4x
      assert.equal(calls, 4);
    });
  });

  describe('error backoff', () => {
    it('thrown errors trigger backoff and onError', async () => {
      const errors = [];
      let calls = 0;
      startSmartPollLoop(() => {
        calls++;
        throw new Error('fail');
      }, {
        intervalMs: 1_000, jitterFraction: 0, maxBackoffMultiplier: 4,
        onError: (e) => errors.push(e),
      });

      timers.advanceBy(1_000);
      await Promise.resolve();
      assert.equal(calls, 1);
      assert.equal(errors.length, 1);
      assert.equal(errors[0].message, 'fail');

      timers.advanceBy(2_000);
      await Promise.resolve();
      assert.equal(calls, 2);
    });
  });

  describe('shouldRun gating', () => {
    it('poll skipped when shouldRun returns false', async () => {
      let gate = false;
      let calls = 0;
      startSmartPollLoop(() => { calls++; }, {
        intervalMs: 1_000, jitterFraction: 0, shouldRun: () => gate,
      });

      timers.advanceBy(1_000);
      await Promise.resolve();
      assert.equal(calls, 0);

      gate = true;
      timers.advanceBy(1_000);
      await Promise.resolve();
      assert.equal(calls, 1);
    });
  });

  describe('runImmediately', () => {
    it('fires at t=0 with reason startup', async () => {
      let capturedReason = null;
      startSmartPollLoop((ctx) => { capturedReason = ctx.reason; }, {
        intervalMs: 5_000, runImmediately: true, jitterFraction: 0,
      });

      await Promise.resolve();
      assert.equal(capturedReason, 'startup');
    });
  });

  describe('pauseWhenHidden', () => {
    it('no ticks while hidden', async () => {
      doc._setHidden(true);
      let calls = 0;
      startSmartPollLoop(() => { calls++; }, {
        intervalMs: 1_000, jitterFraction: 0, pauseWhenHidden: true,
      });

      timers.advanceBy(10_000);
      await Promise.resolve();
      assert.equal(calls, 0);
    });

    it('resumes on visibility change to visible', async () => {
      doc._setHidden(false);
      let calls = 0;
      const handle = startSmartPollLoop(() => { calls++; }, {
        intervalMs: 1_000, jitterFraction: 0, pauseWhenHidden: true,
        visibilityDebounceMs: 0,
      });

      timers.advanceBy(1_000);
      await Promise.resolve();
      assert.equal(calls, 1);

      doc._setHidden(true);
      doc._fire('visibilitychange');
      timers.advanceBy(5_000);
      await Promise.resolve();
      assert.equal(calls, 1);

      doc._setHidden(false);
      doc._fire('visibilitychange');
      await Promise.resolve();
      assert.ok(calls >= 2, `expected resume poll, got ${calls}`);

      handle.stop();
    });

    it('aborts in-flight on hide', async () => {
      let aborted = false;
      const handle = startSmartPollLoop(async (ctx) => {
        ctx.signal?.addEventListener('abort', () => { aborted = true; });
        return new Promise(() => { });
      }, {
        intervalMs: 1_000, jitterFraction: 0, pauseWhenHidden: true,
        runImmediately: true, visibilityDebounceMs: 0,
      });

      await Promise.resolve();
      doc._setHidden(true);
      doc._fire('visibilitychange');
      assert.equal(aborted, true);
      handle.stop();
    });
  });

  describe('hiddenMultiplier', () => {
    it('interval scaled when hidden (not paused)', async () => {
      doc._setHidden(true);
      let calls = 0;
      startSmartPollLoop(() => { calls++; }, {
        intervalMs: 1_000, hiddenMultiplier: 5, jitterFraction: 0,
        pauseWhenHidden: false,
      });

      timers.advanceBy(4_999);
      await Promise.resolve();
      assert.equal(calls, 0);

      timers.advanceBy(1);
      await Promise.resolve();
      assert.equal(calls, 1);
    });
  });

  describe('hiddenIntervalMs', () => {
    it('explicit hidden interval overrides multiplier', async () => {
      doc._setHidden(true);
      let calls = 0;
      startSmartPollLoop(() => { calls++; }, {
        intervalMs: 1_000, hiddenMultiplier: 100,
        hiddenIntervalMs: 3_000, jitterFraction: 0,
        pauseWhenHidden: false,
      });

      timers.advanceBy(2_999);
      await Promise.resolve();
      assert.equal(calls, 0);

      timers.advanceBy(1);
      await Promise.resolve();
      assert.equal(calls, 1);
    });
  });

  describe('refreshOnVisible', () => {
    it('immediate run with reason resume on tab visible', async () => {
      let capturedReason = null;
      startSmartPollLoop((ctx) => { capturedReason = ctx.reason; }, {
        intervalMs: 60_000, refreshOnVisible: true, jitterFraction: 0,
        visibilityDebounceMs: 0,
      });

      doc._setHidden(true);
      doc._fire('visibilitychange');
      doc._setHidden(false);
      doc._fire('visibilitychange');
      await Promise.resolve();
      assert.equal(capturedReason, 'resume');
    });
  });

  describe('visibility debounce', () => {
    it('rapid show events coalesced within visibilityDebounceMs', async () => {
      let calls = 0;
      startSmartPollLoop(() => { calls++; }, {
        intervalMs: 60_000, refreshOnVisible: true,
        visibilityDebounceMs: 500, jitterFraction: 0,
      });

      doc._setHidden(true);
      doc._fire('visibilitychange');
      doc._setHidden(false);
      doc._fire('visibilitychange');
      doc._setHidden(true);
      doc._fire('visibilitychange');
      doc._setHidden(false);
      doc._fire('visibilitychange');
      await Promise.resolve();
      assert.equal(calls, 0);

      timers.advanceBy(500);
      await Promise.resolve();
      assert.equal(calls, 1);
    });
  });

  describe('trigger()', () => {
    it('manual trigger fires immediately and resets schedule', async () => {
      let calls = 0;
      let lastReason = null;
      const handle = startSmartPollLoop((ctx) => { calls++; lastReason = ctx.reason; }, {
        intervalMs: 10_000, jitterFraction: 0,
      });

      handle.trigger();
      await Promise.resolve();
      assert.equal(calls, 1);
      assert.equal(lastReason, 'manual');

      timers.advanceBy(10_000);
      await Promise.resolve();
      assert.equal(calls, 2);
      assert.equal(lastReason, 'interval');
    });
  });

  describe('stop()', () => {
    it('clears timers, aborts in-flight, removes listener, isActive false', async () => {
      let aborted = false;
      const handle = startSmartPollLoop(async (ctx) => {
        ctx.signal?.addEventListener('abort', () => { aborted = true; });
        return new Promise(() => { });
      }, {
        intervalMs: 1_000, jitterFraction: 0, runImmediately: true,
      });

      await Promise.resolve();
      assert.equal(handle.isActive(), true);

      handle.stop();
      assert.equal(handle.isActive(), false);
      assert.equal(aborted, true);
      assert.equal(doc._listenerCount('visibilitychange'), 0);

      timers.advanceBy(10_000);
      await Promise.resolve();
    });
  });

  describe('AbortSignal', () => {
    it('signal provided to poll fn', async () => {
      let receivedSignal = null;
      startSmartPollLoop((ctx) => { receivedSignal = ctx.signal; }, {
        intervalMs: 1_000, jitterFraction: 0,
      });

      timers.advanceBy(1_000);
      await Promise.resolve();
      assert.ok(receivedSignal instanceof AbortSignal);
    });

    it('abort errors do not trigger backoff', async () => {
      let calls = 0;
      startSmartPollLoop((_ctx) => {
        calls++;
        const err = new Error('aborted');
        err.name = 'AbortError';
        throw err;
      }, {
        intervalMs: 1_000, jitterFraction: 0, maxBackoffMultiplier: 4,
      });

      timers.advanceBy(1_000); await Promise.resolve();
      assert.equal(calls, 1);
      timers.advanceBy(1_000); await Promise.resolve();
      assert.equal(calls, 2);
    });
  });

  describe('in-flight guard', () => {
    it('concurrent calls are deferred, not dropped', async () => {
      let calls = 0;
      const resolvers = [];
      const handle = startSmartPollLoop(() => {
        calls++;
        return new Promise(r => resolvers.push(r));
      }, {
        intervalMs: 1_000, jitterFraction: 0,
      });

      timers.advanceBy(1_000);
      await Promise.resolve();
      assert.equal(calls, 1);

      timers.advanceBy(1_000);
      await Promise.resolve();
      assert.equal(calls, 1);

      resolvers[0]();
      await Promise.resolve();
      await Promise.resolve();

      timers.advanceBy(1_000);
      await Promise.resolve();
      assert.equal(calls, 2);

      resolvers[1]?.();
      handle.stop();
    });
  });
});
