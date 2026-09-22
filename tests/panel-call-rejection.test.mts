/**
 * WORLDMONITOR-11N regression.
 *
 * `DataLoader.callPanel` dispatched panel methods as `obj[method](...args)` and
 * discarded the return value. Panel update methods are `async` — `InsightsPanel
 * .updateInsights` awaits `updateFromServer`, whose own catch handler awaits
 * `updateFromClient` outside any try — so a rejection there had no handler and
 * escaped to `onunhandledrejection`. In production that surfaced as
 * `TimeoutError: signal timed out`, the abort reason from the insights loader's
 * shared controller, reported with the loader's async stack even though the
 * loader itself catches (verified: `fetchServerInsights` never rejects).
 *
 * A dropped panel rejection must become an observable, reported error instead.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { enqueuePanelCall, invokePanelMethod, replayPendingCalls } from '../src/app/pending-panel-data';
import { _resetSentryDeferStateForTests, _setSentryLoaderForTests, scheduleSentryInit } from '../src/bootstrap/sentry-defer';

/** Let queued microtasks and one macrotask turn so a leak would be flagged. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 10));
}

describe('invokePanelMethod — async panel rejections must not escape', () => {
  let unhandled: unknown[] = [];
  let onUnhandled: (reason: unknown) => void;

  beforeEach(() => {
    unhandled = [];
    onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on('unhandledRejection', onUnhandled);
  });

  afterEach(() => {
    process.off('unhandledRejection', onUnhandled);
  });

  it('does not leak an unhandled rejection when an async panel method rejects', async () => {
    const panel = {
      updateInsights: async () => { throw new Error('boom'); },
    };

    invokePanelMethod(panel, 'insights', 'updateInsights', [], () => {});
    await settle();

    assert.deepEqual(unhandled, [], 'a rejected panel update must not reach onunhandledrejection');
  });

  it('reports the rejection so the failure stays observable', async () => {
    const seen: Array<{ key: string; method: string; error: unknown; dispatch: string }> = [];
    const boom = new Error('boom');
    const panel = { updateInsights: async () => { throw boom; } };

    invokePanelMethod(panel, 'insights', 'updateInsights', [], (key, method, error, dispatch) => {
      seen.push({ key, method, error, dispatch });
    });
    await settle();

    assert.equal(seen.length, 1, 'exactly one report per rejected call');
    assert.equal(seen[0]?.key, 'insights');
    assert.equal(seen[0]?.method, 'updateInsights');
    assert.equal(seen[0]?.dispatch, 'direct');
    assert.equal(seen[0]?.error, boom, 'the original error must reach the reporter');
  });

  it('preserves the abort reason a shared signal rejects with', async () => {
    const reason = new DOMException('signal timed out', 'TimeoutError');
    const panel = { updateInsights: async () => { throw reason; } };
    const seen: unknown[] = [];

    invokePanelMethod(panel, 'insights', 'updateInsights', [], (_k, _m, error) => { seen.push(error); });
    await settle();

    assert.deepEqual(unhandled, [], 'the 11N signature must not escape');
    assert.equal(seen[0], reason);
  });

  it('does not re-leak when the reporter itself throws', async () => {
    const panel = { updateInsights: async () => { throw new Error('boom'); } };

    invokePanelMethod(panel, 'insights', 'updateInsights', [], () => {
      throw new Error('reporter exploded');
    });
    await settle();

    assert.deepEqual(unhandled, [], 'a throwing reporter must not recreate the unhandled rejection');
  });

  it('does not report anything when the async method resolves', async () => {
    const seen: unknown[] = [];
    const panel = { updateInsights: async () => 'ok' };

    const dispatched = invokePanelMethod(panel, 'insights', 'updateInsights', [], (_k, _m, e) => { seen.push(e); });
    await settle();

    assert.equal(dispatched, true);
    assert.deepEqual(seen, [], 'a successful update must stay silent');
  });
});

describe('invokePanelMethod — dispatch contract callPanel depends on', () => {
  it('returns true and forwards arguments for a synchronous method', () => {
    const calls: unknown[][] = [];
    const panel = { setData: (...args: unknown[]) => { calls.push(args); } };

    const dispatched = invokePanelMethod(panel, 'giving', 'setData', [1, 'two'], () => {});

    assert.equal(dispatched, true);
    assert.deepEqual(calls, [[1, 'two']]);
  });

  it('returns false when the panel is missing so the caller can queue the call', () => {
    assert.equal(invokePanelMethod(undefined, 'insights', 'updateInsights', [], () => {}), false);
    assert.equal(invokePanelMethod(null, 'insights', 'updateInsights', [], () => {}), false);
  });

  it('returns false when the method is absent so the caller can queue the call', () => {
    assert.equal(invokePanelMethod({}, 'insights', 'updateInsights', [], () => {}), false);
  });

  it('lets a synchronous throw propagate, matching the previous direct-call behavior', () => {
    const panel = { setData: () => { throw new Error('sync boom'); } };

    assert.throws(() => invokePanelMethod(panel, 'giving', 'setData', [], () => {}), /sync boom/);
  });
});

it('sends distinct dispatch tags through the default Sentry sink', async (t) => {
  _resetSentryDeferStateForTests();
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const captured: Array<{ error: unknown; tags: Record<string, string> }> = [];
  t.mock.method(console, 'error', () => {});
  t.mock.timers.enable({ apis: ['setTimeout'] });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { removeEventListener() {} } });
  _setSentryLoaderForTests(async () => ({
    captureException(error: unknown, context: { tags: Record<string, string> }) {
      captured.push({ error, tags: context.tags });
    },
  } as never));
  try {
    const reason = new DOMException('signal timed out', 'TimeoutError');
    const panel = { updateInsights: async () => { throw reason; } };
    invokePanelMethod(panel, 'insights', 'updateInsights', []);
    enqueuePanelCall('insights', 'updateInsights', []);
    await replayPendingCalls('insights', panel);
    const init = scheduleSentryInit();
    t.mock.timers.tick(10_000);
    await init;
    assert.deepEqual(captured, ['direct', 'queued'].map((dispatch) => ({
      error: reason,
      tags: { kind: 'panel_call_rejected', panel: 'insights', method: 'updateInsights', dispatch },
    })));
  } finally {
    _resetSentryDeferStateForTests();
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});
