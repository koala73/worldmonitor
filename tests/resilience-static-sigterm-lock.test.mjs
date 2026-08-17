import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { test } from 'node:test';

import { installSigtermLockCleanup } from '../scripts/seed-resilience-static.mjs';

class FakeProcess extends EventEmitter {
  exitCodes = [];

  exit(code) {
    this.exitCodes.push(code);
    this.emit('exit-called', code);
  }
}

test('SIGTERM releases the resilience-static lock before exiting', async () => {
  const processRef = new FakeProcess();
  const calls = [];
  let resolveRelease;
  const releaseStarted = new Promise((resolve) => { resolveRelease = resolve; });
  let finishRelease;
  const releaseFinished = new Promise((resolve) => { finishRelease = resolve; });

  const removeHandler = installSigtermLockCleanup({
    runId: 'resilience-static:test-run',
    processRef,
    release: async (...args) => {
      calls.push(args);
      resolveRelease();
      await releaseFinished;
    },
    logError: () => {},
  });

  processRef.emit('SIGTERM');
  await releaseStarted;
  assert.deepEqual(processRef.exitCodes, [], 'must not exit before lock release settles');

  const exitCalled = once(processRef, 'exit-called');
  finishRelease();
  assert.deepEqual(await exitCalled, [143]);
  assert.deepEqual(calls, [['resilience:static', 'resilience-static:test-run']]);
  assert.equal(processRef.listenerCount('SIGTERM'), 0, 'the one-shot handler must not remain installed');

  removeHandler();
});

test('SIGTERM still exits when lock cleanup fails', async () => {
  const processRef = new FakeProcess();
  const errors = [];
  installSigtermLockCleanup({
    runId: 'resilience-static:test-failure',
    processRef,
    release: async () => { throw new Error('synthetic Redis failure'); },
    logError: (message) => errors.push(message),
  });

  const exitCalled = once(processRef, 'exit-called');
  processRef.emit('SIGTERM');

  assert.deepEqual(await exitCalled, [143]);
  assert.match(errors.join('\n'), /SIGTERM cleanup error: synthetic Redis failure/);
});
