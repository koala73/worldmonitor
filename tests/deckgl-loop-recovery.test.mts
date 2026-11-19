import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

import { createDeckLoopRecovery } from '../src/components/map/deck-loop-recovery.ts';
import { createIdleAwareFrameProvider } from '../src/utils/idle-aware-frame-provider.ts';

// luma.gl's AnimationLoop (9.4) runs each frame as: redraw(), then request the
// next frame. A throw inside redraw() is passed to onError and the loop calls
// stop(), so no next frame is ever requested and deck never commits another
// layer list (#9653). This mirrors that contract over the real frame provider.
function lumaLikeLoop(provider: ReturnType<typeof createIdleAwareFrameProvider>, onError: (error: Error) => void) {
  let running = true;
  let failNext: Error | null = null;
  let frames = 0;
  const frame = () => {
    if (!running) return;
    try {
      frames += 1;
      if (failNext) {
        const error = failNext;
        failNext = null;
        throw error;
      }
      provider.requestAnimationFrame(frame);
    } catch (error) {
      onError(error as Error);
      running = false;
    }
  };
  provider.requestAnimationFrame(frame);
  return {
    failOnce(error: Error) { failNext = error; },
    reportWithoutStopping(error: Error) { onError(error); },
    get frames() { return frames; },
  };
}

function harness() {
  let clock = 0;
  let nextId = 1;
  const pending = new Map<number, () => void>();
  const microtasks: Array<() => void> = [];
  const provider = createIdleAwareFrameProvider({
    idleIntervalMs: 250,
    activeWindowMs: 300,
    now: () => clock,
    requestAnimationFrame: (cb) => { const id = nextId++; pending.set(id, () => cb(clock)); return id; },
    cancelAnimationFrame: (id) => { pending.delete(id); },
    setTimeout: (cb) => { const id = nextId++; pending.set(id, cb); return id; },
    clearTimeout: (id) => { pending.delete(id); },
  });
  return {
    provider,
    defer: (fn: () => void) => { microtasks.push(fn); },
    advance(ms: number) { clock += ms; },
    now: () => clock,
    tick() {
      const due = [...pending.entries()];
      pending.clear();
      for (const [, cb] of due) cb();
      while (microtasks.length) microtasks.shift()!();
    },
  };
}

function setup({ alive = true, withLoop = true } = {}) {
  const h = harness();
  const restarts: string[] = [];
  const giveUps: string[] = [];
  const onError = createDeckLoopRecovery({
    hasPendingFrame: () => h.provider.hasPendingFrame(),
    isAlive: () => alive,
    restart: (error) => restarts.push(error.message),
    giveUp: (error) => giveUps.push(error.message),
    maxRestarts: 2,
    windowMs: 60_000,
    now: h.now,
    defer: h.defer,
  });
  const loop = withLoop ? lumaLikeLoop(h.provider, onError) : null;
  return { h, loop: loop!, restarts, giveUps, onError };
}

describe('idle-aware frame provider pending state', () => {
  it('reports a pending frame until it fires, and none after a cancel', () => {
    const h = harness();
    assert.equal(h.provider.hasPendingFrame(), false);
    const handle = h.provider.requestAnimationFrame(() => {});
    assert.equal(h.provider.hasPendingFrame(), true);
    h.tick();
    assert.equal(h.provider.hasPendingFrame(), false);
    const again = h.provider.requestAnimationFrame(() => {});
    h.provider.cancelAnimationFrame(again);
    assert.equal(h.provider.hasPendingFrame(), false);
    assert.notEqual(handle, again);
  });
});

describe('deck loop recovery (#9653)', () => {
  it('restarts deck when a frame error stopped its loop', () => {
    const { h, loop, restarts, giveUps } = setup();
    h.tick();
    loop.failOnce(new Error('readPixels failed'));
    h.tick();
    assert.deepEqual(restarts, ['readPixels failed']);
    assert.deepEqual(giveUps, []);
  });

  it('leaves a loop that kept running alone (layer and async picking errors)', () => {
    const { h, loop, restarts } = setup();
    h.tick();
    loop.reportWithoutStopping(new Error('layer update failed'));
    h.tick();
    assert.deepEqual(restarts, []);
    assert.ok(loop.frames >= 2, 'loop still producing frames');
  });

  it('gives up after the restart budget is spent inside the window', () => {
    // No loop is scheduled, as when each restarted deck dies on its first frame.
    const { h, restarts, giveUps, onError } = setup({ withLoop: false });
    for (const message of ['a', 'b', 'c']) {
      onError(new Error(message));
      h.tick();
    }
    assert.deepEqual(restarts, ['a', 'b']);
    assert.deepEqual(giveUps, ['c']);
  });

  it('restores the budget once old restarts leave the window', () => {
    const { h, restarts, giveUps, onError } = setup({ withLoop: false });
    for (const message of ['a', 'b']) {
      onError(new Error(message));
      h.tick();
    }
    h.advance(60_001);
    onError(new Error('c'));
    h.tick();
    assert.deepEqual(restarts, ['a', 'b', 'c']);
    assert.deepEqual(giveUps, []);
  });

  it('gives up with the restart error when the restart itself throws', () => {
    const h = harness();
    const giveUps: string[] = [];
    const onError = createDeckLoopRecovery({
      hasPendingFrame: () => h.provider.hasPendingFrame(),
      isAlive: () => true,
      restart: () => { throw new Error('addControl failed'); },
      giveUp: (error) => giveUps.push(error.message),
      maxRestarts: 2,
      windowMs: 60_000,
      now: h.now,
      defer: h.defer,
    });
    onError(new Error('frame failed'));
    h.tick();
    assert.deepEqual(giveUps, ['addControl failed']);
  });

  it('does nothing once the map is gone', () => {
    const { h, loop, restarts, giveUps } = setup({ alive: false });
    loop.failOnce(new Error('late'));
    h.tick();
    assert.deepEqual(restarts, []);
    assert.deepEqual(giveUps, []);
  });
});

describe('DeckGLMap wiring', () => {
  const src = readFileSync(resolve(import.meta.dirname, '..', 'src/components/DeckGLMap.ts'), 'utf8');

  it('routes every deck error through the loop recovery', () => {
    const onError = src.slice(src.indexOf('onError: (error: Error) => {'));
    assert.match(onError.slice(0, onError.indexOf('\n    };')), /this\.deckLoopRecovery\(error\)/);
  });

  it('claims its Sentry report so vendor-stack filters keep it', () => {
    assert.match(src, /kind: 'deck_loop_stopped'/);
  });

  it('falls back through the fatal-error path when restarts run out', () => {
    assert.match(src, /giveUp: \(error\) => [^\n]*this\.onFatalError/);
  });
});
