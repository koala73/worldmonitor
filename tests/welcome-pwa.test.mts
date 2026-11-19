import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { registerWelcomeServiceWorker } from '../pro-test/src/welcome-pwa.ts';

function harness(t, options = {}) {
  const { readyState = 'loading', idle = true, getterThrows = false } = options;
  const frames = [];
  const idles = [];
  const timers = [];
  const loads = [];
  const calls = [];
  const warnings = [];
  const container = 'serviceWorker' in options
    ? options.serviceWorker
    : { register: async (...args) => { calls.push(args); } };
  const nav = getterThrows
    ? Object.defineProperty({}, 'serviceWorker', { get() { throw new DOMException('Sandboxed', 'SecurityError'); } })
    : { serviceWorker: container };
  const replacements = {
    navigator: nav,
    document: { readyState },
    window: {
      requestAnimationFrame: (cb) => frames.push(cb),
      ...(idle ? { requestIdleCallback: (cb, options) => { idles.push({ cb, options }); } } : {}),
      addEventListener: (event, cb, options) => {
        assert.equal(event, 'load');
        assert.equal(options.once, true);
        loads.push(cb);
      },
    },
    setTimeout: (cb, delay) => { timers.push({ cb, delay }); },
  };
  for (const [key, value] of Object.entries(replacements)) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
    t.after(() => {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    });
  }
  t.mock.method(console, 'warn', (...args) => warnings.push(args));
  return { frames, idles, timers, loads, calls, warnings };
}

describe('welcome PWA registration', () => {
  it('waits for load, two paint frames and idle before registering at the root', async (t) => {
    const h = harness(t);
    registerWelcomeServiceWorker();
    assert.equal(h.loads.length, 1);
    assert.equal(h.frames.length, 0);
    assert.equal(h.calls.length, 0);
    h.loads[0]();
    h.frames.shift()();
    assert.equal(h.idles.length, 0);
    h.frames.shift()();
    assert.equal(h.calls.length, 0);
    assert.equal(h.idles[0].options.timeout, 3000);
    h.idles[0].cb();
    h.idles[0].cb();
    await Promise.resolve();
    assert.deepEqual(h.calls, [['/sw.js', { scope: '/' }]]);
  });

  it('schedules after paint when loaded late and falls back to a timer without idle callbacks', async (t) => {
    const h = harness(t, { readyState: 'complete', idle: false });
    registerWelcomeServiceWorker();
    assert.equal(h.loads.length, 0);
    h.frames.shift()();
    h.frames.shift()();
    assert.equal(h.calls.length, 0);
    assert.equal(h.timers[0].delay, 0);
    h.timers[0].cb();
    await Promise.resolve();
    assert.deepEqual(h.calls, [['/sw.js', { scope: '/' }]]);
  });

  for (const options of [{ serviceWorker: undefined }, { getterThrows: true }]) {
    it(`leaves welcome boot intact with ${options.getterThrows ? 'a throwing getter' : 'no service worker'}`, (t) => {
      const h = harness(t, options);
      assert.doesNotThrow(registerWelcomeServiceWorker);
      assert.equal(h.loads.length, 0);
      assert.equal(h.frames.length, 0);
      assert.equal(h.calls.length, 0);
    });
  }

  for (const synchronous of [false, true]) {
    it(`contains ${synchronous ? 'synchronous' : 'asynchronous'} registration failures`, async (t) => {
      const error = new Error('Registration denied');
      const h = harness(t, {
        readyState: 'complete',
        serviceWorker: { register() { if (synchronous) throw error; return Promise.reject(error); } },
      });
      registerWelcomeServiceWorker();
      h.frames.shift()();
      h.frames.shift()();
      assert.doesNotThrow(() => h.idles[0].cb());
      await Promise.resolve();
      assert.equal(h.warnings.length, 1);
      assert.equal(h.warnings[0][1], error);
    });
  }

  it('contains a service-worker getter that starts throwing after scheduling', async (t) => {
    const h = harness(t, { readyState: 'complete' });
    registerWelcomeServiceWorker();
    const error = new DOMException('Sandboxed', 'SecurityError');
    Object.defineProperty(navigator, 'serviceWorker', { get() { throw error; } });
    h.frames.shift()();
    h.frames.shift()();
    assert.doesNotThrow(() => h.idles[0].cb());
    await Promise.resolve();
    assert.deepEqual(h.calls, []);
    assert.equal(h.warnings.length, 1);
    assert.equal(h.warnings[0][1], error);
  });
});
