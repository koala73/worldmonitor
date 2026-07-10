import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  _buildQueuedErrorEventForTests,
  _buildQueuedUnhandledRejectionEventForTests,
  _resetSentryDeferStateForTests,
  _setSentryLoaderForTests,
  enqueueSentryCall,
  installPreInitErrorQueue,
  scheduleSentryInit,
} from '../src/bootstrap/sentry-defer';

function restoreGlobalProperty(name: 'window' | 'setTimeout', descriptor: PropertyDescriptor | undefined): void {
  if (descriptor) {
    Object.defineProperty(globalThis, name, descriptor);
  } else {
    Reflect.deleteProperty(globalThis, name);
  }
}

describe('deferred Sentry replay event shaping', () => {
  it('keeps Sentry import scheduling past the mobile Lighthouse audit window', () => {
    _resetSentryDeferStateForTests();
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    const previousSetTimeout = Object.getOwnPropertyDescriptor(globalThis, 'setTimeout');
    let recordedTimeout: number | null = null;
    let recordedDelay: number | null = null;
    let delayedCallback: (() => void) | null = null;

    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        requestIdleCallback: (_cb: () => void, opts?: { timeout: number }) => {
          recordedTimeout = opts?.timeout ?? null;
          return 1;
        },
        addEventListener() {},
        removeEventListener() {},
      },
    });
    Object.defineProperty(globalThis, 'setTimeout', {
      configurable: true,
      value: (cb: () => void, delay?: number) => {
        recordedDelay = delay ?? null;
        delayedCallback = cb;
        return 1;
      },
    });

    try {
      scheduleSentryInit();
      assert.equal(recordedDelay, 10_000);
      assert.equal(recordedTimeout, null);

      delayedCallback?.();
      assert.equal(recordedTimeout, 2_000);
    } finally {
      _resetSentryDeferStateForTests();
      restoreGlobalProperty('window', previousWindow);
      restoreGlobalProperty('setTimeout', previousSetTimeout);
    }
  });

  it('matches Sentry globalHandlers for primitive promise rejections', () => {
    const event = _buildQueuedUnhandledRejectionEventForTests('timeout');
    const value = event?.exception?.values?.[0];

    assert.equal(event?.level, 'error');
    assert.equal(value?.type, 'UnhandledRejection');
    assert.equal(value?.value, 'Non-Error promise rejection captured with value: timeout');
  });

  it('flushes errors thrown during the defer gap through the scheduled init path', async () => {
    _resetSentryDeferStateForTests();
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    const previousSetTimeout = Object.getOwnPropertyDescriptor(globalThis, 'setTimeout');
    const listeners = new Map<string, EventListener>();
    const removed: string[] = [];
    const queuedError = new Error('gap boom');
    const captured: unknown[] = [];
    let recordedDelay: number | null = null;
    let delayedCallback: (() => void) | null = null;
    let recordedIdleTimeout: number | null = null;
    let idleCallback: (() => void) | null = null;

    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        requestIdleCallback: (cb: () => void, opts?: { timeout: number }) => {
          recordedIdleTimeout = opts?.timeout ?? null;
          idleCallback = cb;
          return 1;
        },
        addEventListener(type: string, listener: EventListener) {
          listeners.set(type, listener);
        },
        removeEventListener(type: string, listener: EventListener) {
          if (listeners.get(type) === listener) removed.push(type);
        },
      },
    });
    Object.defineProperty(globalThis, 'setTimeout', {
      configurable: true,
      value: (cb: () => void, delay?: number) => {
        recordedDelay = delay ?? null;
        delayedCallback = cb;
        return 1;
      },
    });
    _setSentryLoaderForTests(async () => ({
      captureException(error: unknown, hint: unknown) {
        captured.push({ error, hint });
      },
      captureEvent() {
        throw new Error('captureEvent should not be used for Error instances');
      },
    } as never));

    try {
      installPreInitErrorQueue();
      listeners.get('error')?.({
        message: 'gap boom',
        filename: 'https://worldmonitor.app/assets/main.js',
        lineno: 10,
        colno: 20,
        error: queuedError,
      } as ErrorEvent);

      const initPromise = scheduleSentryInit();
      assert.equal(recordedDelay, 10_000);
      assert.equal(captured.length, 0);
      delayedCallback?.();
      assert.equal(recordedIdleTimeout, 2_000);
      assert.equal(captured.length, 0);

      idleCallback?.();
      await initPromise;

      assert.equal(captured.length, 1);
      assert.equal((captured[0] as { error: unknown }).error, queuedError);
      assert.deepEqual(
        (captured[0] as { hint: { mechanism: { type: string; handled: boolean } } }).hint.mechanism,
        { type: 'auto.browser.global_handlers.onerror', handled: false },
      );
      assert.deepEqual(removed.sort(), ['error', 'unhandledrejection']);
    } finally {
      _resetSentryDeferStateForTests();
      restoreGlobalProperty('window', previousWindow);
      restoreGlobalProperty('setTimeout', previousSetTimeout);
    }
  });

  it('keeps newer pre-init errors and calls when the bounded queues saturate', async () => {
    _resetSentryDeferStateForTests();
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    const previousSetTimeout = Object.getOwnPropertyDescriptor(globalThis, 'setTimeout');
    const listeners = new Map<string, EventListener>();
    const capturedEvents: unknown[] = [];
    const capturedCalls: string[] = [];
    const latestError = new Error('latest startup failure');
    let delayedCallback: (() => void) | null = null;
    let idleCallback: (() => void) | null = null;

    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        requestIdleCallback: (cb: () => void) => {
          idleCallback = cb;
          return 1;
        },
        addEventListener(type: string, listener: EventListener) {
          listeners.set(type, listener);
        },
        removeEventListener() {},
      },
    });
    Object.defineProperty(globalThis, 'setTimeout', {
      configurable: true,
      value: (cb: () => void) => {
        delayedCallback = cb;
        return 1;
      },
    });
    _setSentryLoaderForTests(async () => ({
      captureException(error: unknown) {
        capturedEvents.push(error);
      },
      captureEvent(event: unknown) {
        capturedEvents.push(event);
      },
      captureMessage(message: string) {
        capturedCalls.push(message);
      },
    } as never));

    try {
      installPreInitErrorQueue();
      const listener = listeners.get('error');
      assert.ok(listener, 'pre-init error listener should be installed');
      for (let i = 0; i < 50; i += 1) {
        listener({
          message: `noise-${i}`,
          filename: 'https://extension.invalid/noise.js',
          lineno: i,
          colno: 1,
          error: null,
        } as ErrorEvent);
      }
      listener({
        message: 'latest startup failure',
        filename: 'https://worldmonitor.app/assets/main.js',
        lineno: 1,
        colno: 1,
        error: latestError,
      } as ErrorEvent);
      for (let i = 0; i < 50; i += 1) {
        enqueueSentryCall((Sentry) => Sentry.captureMessage(`stale-${i}`));
      }
      enqueueSentryCall((Sentry) => Sentry.captureMessage('latest-call'));

      const initPromise = scheduleSentryInit();
      delayedCallback?.();
      idleCallback?.();
      await initPromise;

      assert.equal(capturedEvents.length, 50);
      assert.equal(capturedEvents[capturedEvents.length - 1], latestError);
      assert.equal(capturedCalls.length, 50);
      assert.equal(capturedCalls[0], 'stale-1');
      assert.equal(capturedCalls[capturedCalls.length - 1], 'latest-call');
    } finally {
      _resetSentryDeferStateForTests();
      restoreGlobalProperty('window', previousWindow);
      restoreGlobalProperty('setTimeout', previousSetTimeout);
    }
  });

  it('matches Sentry globalHandlers for object promise rejections', () => {
    const event = _buildQueuedUnhandledRejectionEventForTests({ beta: 2, alpha: 1 });
    const value = event?.exception?.values?.[0];

    assert.equal(event?.level, 'error');
    assert.equal(value?.type, 'UnhandledRejection');
    assert.equal(value?.value, 'Object captured as promise rejection with keys: alpha, beta');
    assert.deepEqual(event?.extra?.__serialized__, { beta: 2, alpha: 1 });
  });

  it('matches Sentry globalHandlers for Event promise rejections', () => {
    const reason = new Event('CustomEvent');
    const event = _buildQueuedUnhandledRejectionEventForTests(reason);
    const value = event?.exception?.values?.[0];

    assert.equal(event?.level, 'error');
    assert.equal(value?.type, 'Event');
    assert.equal(value?.value, 'Event `Event` (type=CustomEvent) captured as promise rejection');
    assert.deepEqual(event?.extra?.__serialized__, { type: 'CustomEvent' });
  });

  it('leaves Error promise rejections on the captureException path', () => {
    const event = _buildQueuedUnhandledRejectionEventForTests(new Error('boom'));
    assert.equal(event, null);
  });

  it('preserves original ErrorEvent location for missing-error fallbacks', () => {
    const event = _buildQueuedErrorEventForTests({
      message: 'Script error.',
      filename: 'https://cdn.example.com/widget.js',
      lineno: 12,
      colno: 34,
      error: null,
    });
    const value = event.exception?.values?.[0];
    const frame = value?.stacktrace?.frames?.[0];

    assert.equal(event.level, 'error');
    assert.equal(event.message, 'Script error.');
    assert.equal(value?.type, 'Error');
    assert.equal(value?.value, 'Script error.');
    assert.equal(frame?.filename, 'https://cdn.example.com/widget.js');
    assert.equal(frame?.lineno, 12);
    assert.equal(frame?.colno, 34);
    assert.equal(frame?.function, '?');
    assert.equal(frame?.in_app, true);
  });
});
