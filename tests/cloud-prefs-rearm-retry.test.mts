import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { rearmTemporaryCloudPrefsRetry } from '../src/utils/cloud-prefs-retry.ts';

function headersWithRetryAfter(value: string): Headers {
  const headers = new Headers();
  headers.set('Retry-After', value);
  return headers;
}

describe('rearmTemporaryCloudPrefsRetry', () => {
  it('schedules a pending upload retry using Retry-After seconds', () => {
    let generation = 7;
    let pendingCount = 0;
    let clearCount = 0;
    let uploadCount = 0;
    let scheduledCallback: (() => void) | null = null;
    let scheduledDelay = 0;
    const timer = { id: 1 } as unknown as ReturnType<typeof setTimeout>;
    const timers: Array<ReturnType<typeof setTimeout> | null> = [];

    const handled = rearmTemporaryCloudPrefsRetry({
      status: 429,
      headers: headersWithRetryAfter('12'),
      myGeneration: 7,
      getAuthGeneration: () => generation,
      setPending: () => { pendingCount += 1; },
      clearRetryTimer: () => { clearCount += 1; },
      setRetryTimer: (nextTimer) => { timers.push(nextTimer); },
      uploadNow: () => { uploadCount += 1; },
      setTimeoutFn: (callback: () => void, delay: number) => {
        scheduledCallback = callback;
        scheduledDelay = delay;
        return timer;
      },
    });

    assert.equal(handled, true);
    assert.equal(pendingCount, 1);
    assert.equal(clearCount, 1);
    assert.equal(scheduledDelay, 12_000);
    assert.deepEqual(timers, [timer]);

    assert.ok(scheduledCallback, 'retry callback should be scheduled');
    scheduledCallback();

    assert.deepEqual(timers, [timer, null]);
    assert.equal(uploadCount, 1);

    generation = 8;
    scheduledCallback();
    assert.equal(uploadCount, 1, 'stale retry callbacks must not upload after auth changes');
  });

  it('treats stale generations as handled without scheduling a retry', () => {
    let touched = false;

    const handled = rearmTemporaryCloudPrefsRetry({
      status: 503,
      headers: headersWithRetryAfter('5'),
      myGeneration: 1,
      getAuthGeneration: () => 2,
      setPending: () => { touched = true; },
      clearRetryTimer: () => { touched = true; },
      setRetryTimer: () => { touched = true; },
      uploadNow: () => { touched = true; },
      setTimeoutFn: (() => {
        touched = true;
        return undefined as unknown as ReturnType<typeof setTimeout>;
      }) as typeof setTimeout,
    });

    assert.equal(handled, true);
    assert.equal(touched, false);
  });

  it('ignores non-temporary statuses', () => {
    let touched = false;

    const handled = rearmTemporaryCloudPrefsRetry({
      status: 409,
      headers: headersWithRetryAfter('5'),
      myGeneration: 1,
      getAuthGeneration: () => 1,
      setPending: () => { touched = true; },
      clearRetryTimer: () => { touched = true; },
      setRetryTimer: () => { touched = true; },
      uploadNow: () => { touched = true; },
    });

    assert.equal(handled, false);
    assert.equal(touched, false);
  });
});
