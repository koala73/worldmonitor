import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DeferredHeavyCommit } from '../src/components/map/deferred-layer-commit.ts';

/** Controllable scheduler: captures the queued flush so the test fires it deterministically. */
function makeScheduler() {
  let queued: (() => void) | null = null;
  let scheduleCount = 0;
  let cancelCount = 0;
  return {
    schedule: (run: () => void) => {
      queued = run;
      scheduleCount += 1;
      return () => {
        cancelCount += 1;
        queued = null;
      };
    },
    fire: () => {
      const r = queued;
      queued = null;
      r?.();
    },
    get pending() {
      return queued !== null;
    },
    get scheduleCount() {
      return scheduleCount;
    },
    get cancelCount() {
      return cancelCount;
    },
  };
}

describe('DeferredHeavyCommit (#4558 U2 nucleus)', () => {
  it('coalesces a burst of stages into one deferred flush', () => {
    const sched = makeScheduler();
    const commits: string[][] = [];
    const gate = new DeferredHeavyCommit<number[]>({
      schedule: sched.schedule,
      isAlive: () => true,
      onCommit: (k) => commits.push(k),
    });

    gate.stage('conflict', [1]);
    gate.stage('protests', [2]);
    gate.stage('conflict', [1, 1]); // supersede
    // Coalesced: prior schedules cancelled, one live flush.
    assert.ok(gate.hasPending());
    assert.equal(sched.cancelCount, sched.scheduleCount - 1);

    sched.fire();
    assert.equal(commits.length, 1);
    assert.deepEqual(commits[0]!.sort(), ['conflict', 'protests']);
    assert.ok(!gate.hasPending());
  });

  it('present() returns previously-committed data (R2 no-flicker), undefined on first build (R3)', () => {
    const sched = makeScheduler();
    const gate = new DeferredHeavyCommit<string>({
      schedule: sched.schedule,
      isAlive: () => true,
      onCommit: () => {},
    });

    // First build: nothing committed yet -> present is undefined (layer shows empty one frame).
    assert.equal(gate.present('conflict'), undefined);

    gate.stage('conflict', 'A');
    // Phase 1 of the NEXT render still shows nothing until the deferred flush commits.
    assert.equal(gate.present('conflict'), undefined);
    sched.fire();
    assert.equal(gate.present('conflict'), 'A');

    // A later data change: Phase 1 keeps showing the OLD committed value (no blank).
    gate.stage('conflict', 'B');
    assert.equal(gate.present('conflict'), 'A');
    sched.fire();
    assert.equal(gate.present('conflict'), 'B');
  });

  it('drops the flush without committing when the map is torn down (R4)', () => {
    const sched = makeScheduler();
    let alive = true;
    const commits: string[][] = [];
    const gate = new DeferredHeavyCommit<number>({
      schedule: sched.schedule,
      isAlive: () => alive,
      onCommit: (k) => commits.push(k),
    });

    gate.stage('conflict', 1);
    alive = false; // teardown between schedule and flush
    sched.fire();

    assert.equal(commits.length, 0, 'no commit after teardown');
    assert.equal(gate.present('conflict'), undefined, 'nothing committed');
    assert.ok(!gate.hasPending());
  });

  it('does not schedule when staged data equals committed data', () => {
    const sched = makeScheduler();
    const gate = new DeferredHeavyCommit<string>({
      schedule: sched.schedule,
      isAlive: () => true,
      onCommit: () => {},
      equals: (a, b) => a === b,
    });

    gate.stage('conflict', 'A');
    sched.fire();
    const after = sched.scheduleCount;

    gate.stage('conflict', 'A'); // identical -> no-op
    assert.equal(sched.scheduleCount, after, 'no new flush scheduled');
    assert.ok(!gate.hasPending());
    assert.deepEqual(gate.pendingKeys(), []);
  });

  it('onCommit reports only the keys whose data actually changed', () => {
    const sched = makeScheduler();
    const commits: string[][] = [];
    const gate = new DeferredHeavyCommit<number>({
      schedule: sched.schedule,
      isAlive: () => true,
      onCommit: (k) => commits.push([...k].sort()),
      equals: (a, b) => a === b,
    });

    gate.stage('conflict', 1);
    gate.stage('protests', 2);
    sched.fire();
    assert.deepEqual(commits[0], ['conflict', 'protests']);

    gate.stage('conflict', 1); // unchanged -> filtered before schedule
    gate.stage('protests', 9); // changed
    sched.fire();
    assert.deepEqual(commits[1], ['protests']);
  });

  it('cancel() drops staged data and any scheduled flush', () => {
    const sched = makeScheduler();
    const commits: string[][] = [];
    const gate = new DeferredHeavyCommit<number>({
      schedule: sched.schedule,
      isAlive: () => true,
      onCommit: (k) => commits.push(k),
    });

    gate.stage('conflict', 1);
    assert.ok(gate.hasPending());
    gate.cancel();
    assert.ok(!gate.hasPending());
    assert.deepEqual(gate.pendingKeys(), []);
    sched.fire(); // nothing queued
    assert.equal(commits.length, 0);
  });

  it('clears the scheduled flush when the only pending key reverts to its committed value', () => {
    const sched = makeScheduler();
    const commits: string[][] = [];
    const gate = new DeferredHeavyCommit<string>({
      schedule: sched.schedule,
      isAlive: () => true,
      onCommit: (k) => commits.push(k),
      equals: (a, b) => a === b,
    });

    gate.stage('conflict', 'A');
    sched.fire();
    assert.deepEqual(commits[0], ['conflict']);
    const cancelsBefore = sched.cancelCount;

    // Real change schedules a flush, then revert it before the flush runs.
    gate.stage('conflict', 'B');
    assert.ok(gate.hasPending());
    gate.stage('conflict', 'A'); // back to committed -> pending empties

    assert.ok(!gate.hasPending(), 'no stale flush once nothing is pending');
    assert.deepEqual(gate.pendingKeys(), []);
    assert.equal(sched.pending, false, 'scheduler queue drained');
    assert.equal(sched.cancelCount, cancelsBefore + 1, 'prior schedule cancelled');

    sched.fire(); // nothing queued -> no extra commit
    assert.equal(commits.length, 1, 'reverted change commits nothing');
  });

  it('keeps the scheduled flush when one of several pending keys reverts', () => {
    const sched = makeScheduler();
    const commits: string[][] = [];
    const gate = new DeferredHeavyCommit<string>({
      schedule: sched.schedule,
      isAlive: () => true,
      onCommit: (k) => commits.push([...k].sort()),
      equals: (a, b) => a === b,
    });

    gate.stage('conflict', 'A'); // committed empty -> stays pending
    gate.stage('protests', 'B');
    gate.stage('conflict', undefined as unknown as string); // committed.get is undefined -> reverts conflict only

    assert.ok(gate.hasPending(), 'flush stays scheduled while protests is pending');
    assert.deepEqual(gate.pendingKeys(), ['protests']);
    sched.fire();
    assert.deepEqual(commits[0], ['protests']);
  });
});
