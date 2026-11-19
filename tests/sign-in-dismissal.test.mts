/**
 * The /mcp-grant page used to wait for a Clerk session with no way to notice
 * that the sign-in modal had closed without one (2026-10-19: an interrupted
 * passkey prompt left the page on its spinner forever). The watcher that now
 * notices is pinned here with a fake clock; the page wiring is pinned in
 * e2e/mcp-grant-consent.spec.ts.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  watchSignInDismissal,
  type SignInDismissalClock,
  type SignInDismissalReason,
} from '../src/services/sign-in-dismissal.ts';

function fakeClock(): SignInDismissalClock & { advance(ms: number): void; pending(): number } {
  let now = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; cb: () => void }>();
  return {
    now: () => now,
    setTimeout(cb, ms) {
      const id = nextId++;
      timers.set(id, { at: now + ms, cb });
      return id;
    },
    clearTimeout(handle) {
      timers.delete(handle as number);
    },
    advance(ms) {
      const end = now + ms;
      for (;;) {
        let dueId: number | null = null;
        let dueAt = Infinity;
        for (const [id, t] of timers) {
          if (t.at <= end && t.at < dueAt) {
            dueAt = t.at;
            dueId = id;
          }
        }
        if (dueId === null) break;
        const timer = timers.get(dueId)!;
        timers.delete(dueId);
        now = timer.at;
        timer.cb();
      }
      now = end;
    },
    pending: () => timers.size,
  };
}

function setup(opts: { openTimeoutMs?: number; settleMs?: number } = {}) {
  const clock = fakeClock();
  let open = false;
  const reports: SignInDismissalReason[] = [];
  const watch = watchSignInDismissal({
    isOpen: () => open,
    onDismissed: (reason) => reports.push(reason),
    openTimeoutMs: opts.openTimeoutMs ?? 2_000,
    settleMs: opts.settleMs ?? 500,
    pollMs: 100,
    clock,
  });
  return {
    clock,
    reports,
    watch,
    setOpen(value: boolean) {
      open = value;
    },
  };
}

describe('watchSignInDismissal', () => {
  it('reports closed once a modal that opened stays gone for the settle window', () => {
    const t = setup();
    t.setOpen(true);
    t.clock.advance(1_000);
    assert.deepEqual(t.reports, []);

    t.setOpen(false);
    t.clock.advance(400);
    assert.deepEqual(t.reports, [], 'must wait out the settle window before reporting');
    t.clock.advance(300);
    assert.deepEqual(t.reports, ['closed']);
    assert.equal(t.clock.pending(), 0, 'a finished watch stops polling');
  });

  it('keeps waiting while the modal stays open, however long the user takes', () => {
    const t = setup();
    t.setOpen(true);
    t.clock.advance(10 * 60_000);
    assert.deepEqual(t.reports, []);
  });

  it('a modal that reappears inside the settle window resets it', () => {
    const t = setup();
    t.setOpen(true);
    t.clock.advance(200);
    t.setOpen(false);
    t.clock.advance(300);
    t.setOpen(true);
    t.clock.advance(300);
    t.setOpen(false);
    t.clock.advance(400);
    assert.deepEqual(t.reports, [], 'the second close has not settled yet');
    t.clock.advance(200);
    assert.deepEqual(t.reports, ['closed']);
  });

  it('reports never_opened when the modal does not mount in time', () => {
    const t = setup({ openTimeoutMs: 2_000 });
    t.clock.advance(1_900);
    assert.deepEqual(t.reports, []);
    t.clock.advance(200);
    assert.deepEqual(t.reports, ['never_opened']);
  });

  it('a slow mount inside the open timeout is not a dismissal', () => {
    const t = setup({ openTimeoutMs: 2_000 });
    t.clock.advance(1_500);
    t.setOpen(true);
    t.clock.advance(5_000);
    assert.deepEqual(t.reports, []);
  });

  it('cancel stops a pending report', () => {
    const t = setup();
    t.setOpen(true);
    t.clock.advance(200);
    t.setOpen(false);
    t.clock.advance(200);
    t.watch.cancel();
    t.clock.advance(5_000);
    assert.deepEqual(t.reports, []);
    assert.equal(t.clock.pending(), 0);
  });
});
