import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { createIdleAwareFrameProvider } from '../src/utils/idle-aware-frame-provider.ts';

// deck.gl's animation loop asks for a frame on every vsync to poll for pending
// layer updates, even when nothing changed. Each scheduled frame forces a full
// style / prepaint / intersection-observer pass. Measured on a production build
// at 4x CPU: suppressing those idle frames cut idle main-thread time from
// 255-512 ms to 40-54 ms per 6 s.

type Scheduled = { id: number; cb: (t: number) => void; kind: 'raf' | 'timeout'; delay?: number };

function harness() {
  let clock = 0;
  let nextId = 1;
  const pending = new Map<number, Scheduled>();
  const env = {
    now: () => clock,
    requestAnimationFrame: (cb: (t: number) => void) => { const id = nextId++; pending.set(id, { id, cb, kind: 'raf' }); return id; },
    cancelAnimationFrame: (id: number) => { pending.delete(id); },
    setTimeout: (cb: () => void, delay: number) => { const id = nextId++; pending.set(id, { id, cb: () => cb(), kind: 'timeout', delay }); return id; },
    clearTimeout: (id: number) => { pending.delete(id); },
  };
  return {
    env,
    advance(ms: number) { clock += ms; },
    pending: () => [...pending.values()],
    fire(id: number) { const p = pending.get(id); assert.ok(p, `no pending callback ${id}`); pending.delete(id); p.cb(clock); },
  };
}

describe('idle-aware frame provider', () => {
  it('uses display frames while active', () => {
    const h = harness();
    const provider = createIdleAwareFrameProvider({ idleIntervalMs: 250, activeWindowMs: 300, ...h.env });
    provider.wake();
    provider.requestAnimationFrame(() => {});
    assert.equal(h.pending()[0]!.kind, 'raf');
  });

  it('drops to a slow timer once the active window has passed', () => {
    const h = harness();
    const provider = createIdleAwareFrameProvider({ idleIntervalMs: 250, activeWindowMs: 300, ...h.env });
    provider.wake();
    h.advance(301);
    provider.requestAnimationFrame(() => {});
    const [p] = h.pending();
    assert.equal(p!.kind, 'timeout');
    assert.equal(p!.delay, 250);
  });

  it('starts idle when never woken', () => {
    const h = harness();
    const provider = createIdleAwareFrameProvider({ idleIntervalMs: 250, activeWindowMs: 300, ...h.env });
    provider.requestAnimationFrame(() => {});
    assert.equal(h.pending()[0]!.kind, 'timeout');
  });

  it('wake upgrades a pending idle timer to the next display frame', () => {
    const h = harness();
    const provider = createIdleAwareFrameProvider({ idleIntervalMs: 250, activeWindowMs: 300, ...h.env });
    const calls: number[] = [];
    const handle = provider.requestAnimationFrame((t) => calls.push(t));
    assert.equal(h.pending()[0]!.kind, 'timeout');

    provider.wake();
    const after = h.pending();
    assert.equal(after.length, 1, 'the idle timer is replaced, not duplicated');
    assert.equal(after[0]!.kind, 'raf');

    h.fire(after[0]!.id);
    assert.equal(calls.length, 1, 'the loop callback runs exactly once');

    provider.cancelAnimationFrame(handle);
    assert.equal(h.pending().length, 0);
  });

  it('cancel clears whichever primitive backs the handle', () => {
    const h = harness();
    const provider = createIdleAwareFrameProvider({ idleIntervalMs: 250, activeWindowMs: 300, ...h.env });
    const idle = provider.requestAnimationFrame(() => {});
    provider.cancelAnimationFrame(idle);
    provider.wake();
    const active = provider.requestAnimationFrame(() => {});
    provider.cancelAnimationFrame(active);
    assert.equal(h.pending().length, 0);
  });

  it('passes a timestamp to timer-driven callbacks', () => {
    const h = harness();
    const provider = createIdleAwareFrameProvider({ idleIntervalMs: 250, activeWindowMs: 300, ...h.env });
    let seen: number | undefined;
    provider.requestAnimationFrame((t) => { seen = t; });
    h.advance(250);
    h.fire(h.pending()[0]!.id);
    assert.equal(seen, 250);
  });

  it('dispose cancels pending work and keeps later requests inert', () => {
    const h = harness();
    const provider = createIdleAwareFrameProvider({ idleIntervalMs: 250, activeWindowMs: 300, ...h.env });
    provider.requestAnimationFrame(() => {});
    provider.dispose();
    assert.equal(h.pending().length, 0);
    provider.wake();
    provider.requestAnimationFrame(() => {});
    assert.equal(h.pending().length, 0);
  });
});

describe('DeckGLMap wiring', () => {
  const src = readFileSync(resolve(import.meta.dirname, '..', 'src/components/DeckGLMap.ts'), 'utf8');

  it('hands the provider to deck through the animation loop prop', () => {
    assert.match(src, /animationFrameProvider: this\.deckFrameProvider/);
  });

  it('wakes the loop before every layer update and on map activity', () => {
    const setProps = src.indexOf('this.deckOverlay?.setProps({ layers: built });');
    const wake = src.lastIndexOf('this.deckFrameProvider.wake();', setProps);
    assert.ok(wake >= 0 && setProps - wake < 400, 'layer updates must wake the loop first');
    assert.match(src, /DECK_FRAME_WAKE_EVENTS/);
    for (const ev of ['render', 'mousemove', 'mousedown', 'wheel', 'touchstart', 'movestart']) {
      assert.match(src, new RegExp(`'${ev}'`), `${ev} must wake the loop`);
    }
  });

  it('disposes the provider on destroy', () => {
    assert.match(src, /this\.deckFrameProvider\.dispose\(\);/);
  });
});
