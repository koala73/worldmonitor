import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { LatestRequestGuard } from '../src/utils/latest-request-guard.ts';

/**
 * Markets can be reloaded while an earlier load is still in flight (symbol
 * change, premium unlock, scheduled refresh). The earlier load must not write
 * its batch or final result over the newer one. `LatestRequestGuard` is the
 * primitive that decides that; the data-loader wiring that consumes it is
 * exercised end-to-end by e2e/settings-panel-live-apply.spec.ts.
 */
describe('LatestRequestGuard', () => {
  it('suppresses stale batch and final writes when a newer load starts', async () => {
    const guard = new LatestRequestGuard();
    const writes: string[] = [];
    let releaseOld!: () => void;

    const run = async (name: string, wait?: Promise<void>) => {
      const generation = guard.begin();
      if (wait) await wait;
      if (guard.isCurrent(generation)) writes.push(`${name}:batch`);
      await Promise.resolve();
      if (guard.isCurrent(generation)) writes.push(`${name}:final`);
      return guard.isCurrent(generation);
    };

    const oldWait = new Promise<void>((resolve) => {
      releaseOld = resolve;
    });
    const old = run('old-selection', oldWait);
    const current = run('new-selection');
    releaseOld();

    assert.equal(await current, true);
    assert.equal(await old, false);
    assert.deepEqual(writes, ['new-selection:batch', 'new-selection:final']);
  });

  it('treats only the newest generation as current', () => {
    const guard = new LatestRequestGuard();
    const first = guard.begin();
    const second = guard.begin();

    assert.equal(guard.isCurrent(first), false);
    assert.equal(guard.isCurrent(second), true);
  });

  it('keeps a single in-flight load current across awaits', async () => {
    const guard = new LatestRequestGuard();
    const generation = guard.begin();

    await Promise.resolve();
    assert.equal(guard.isCurrent(generation), true);
  });

  it('never reports a generation it did not issue as current', () => {
    const guard = new LatestRequestGuard();
    const generation = guard.begin();

    assert.equal(guard.isCurrent(generation + 1), false);
    assert.equal(guard.isCurrent(0), false);
  });
});
