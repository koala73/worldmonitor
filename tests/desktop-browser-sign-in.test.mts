/**
 * Desktop Sign in through the system browser (#9396 follow-up): the renderer
 * side. Rust runs the browser round trip (start) and redeems the ticket
 * (finish); the renderer signs out an existing session only between the two,
 * activates the session it is told about, and falls back to the in-app Clerk
 * card when the remaining step is one the WebView can do.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  createSingleFlightSignIn,
  runDesktopBrowserSignIn,
  type BrowserSignInDeps,
  type BrowserSignInOutcome,
} from '../src/services/desktop-browser-sign-in.ts';

const COMPLETE: BrowserSignInOutcome = { status: 'complete', createdSessionId: 'sess_1', identifier: 'a@b.c' };

function deps(overrides: Partial<BrowserSignInDeps> = {}) {
  const log: string[] = [];
  const base: BrowserSignInDeps = {
    fapiHost: 'clerk.worldmonitor.app',
    start: async (fapiHost) => { log.push(`start:${fapiHost}`); },
    finish: async () => { log.push('finish'); return COMPLETE; },
    cancel: async () => { log.push('cancel'); },
    reloadClient: async () => { log.push('reload'); },
    setActive: async (sessionId) => { log.push(`setActive:${sessionId}`); },
    notify: (message) => { log.push(`notify:${message}`); },
    openInApp: () => { log.push('openInApp'); },
    showWaiting: () => {
      log.push('waiting');
      return () => log.push('dismiss');
    },
    ...overrides,
  };
  return { deps: base, log };
}

describe('runDesktopBrowserSignIn', () => {
  it('activates the session Rust created and says who is signed in', async () => {
    const { deps: d, log } = deps();
    assert.equal(await runDesktopBrowserSignIn(d), 'signed_in');
    assert.deepEqual(log, [
      'waiting',
      'start:clerk.worldmonitor.app',
      'dismiss',
      'finish',
      'reload',
      'setActive:sess_1',
      'notify:Signed in as a@b.c',
    ]);
  });

  it('never signs the user out: Rust redeems on a fresh client and swaps only on success', async () => {
    for (const finish of [
      async () => COMPLETE,
      async () => { throw 'network_failed'; },
      async () => { throw 'sign_in_refused'; },
    ]) {
      const { deps: d, log } = deps({ finish });
      await runDesktopBrowserSignIn(d);
      assert.equal(log.some((entry) => entry.includes('signOut')), false);
    }
  });

  it('reloads the client before falling back to the in-app card for another step', async () => {
    const { deps: d, log } = deps({
      finish: async () => ({ status: 'needs_second_factor', createdSessionId: null, identifier: 'a@b.c' }),
    });
    assert.equal(await runDesktopBrowserSignIn(d), 'fallback');
    assert.ok(log.indexOf('reload') < log.indexOf('openInApp'));
    assert.equal(log.some((entry) => entry.startsWith('setActive')), false);
  });

  it('stays quiet when the user cancels', async () => {
    const { deps: d, log } = deps({ start: async () => { throw 'cancelled'; } });
    assert.equal(await runDesktopBrowserSignIn(d), 'cancelled');
    assert.equal(log.some((entry) => entry.startsWith('notify')), false);
  });

  it('does not report a second click as a failure', async () => {
    const { deps: d, log } = deps({ start: async () => { throw 'already_running'; } });
    assert.equal(await runDesktopBrowserSignIn(d), 'cancelled');
    assert.ok(log.includes('notify:Finish signing in in your browser.'));
  });

  it('offers the in-app card when the browser cannot be used', async () => {
    for (const reason of ['browser_failed', 'listener_failed', 'unsupported_host']) {
      const { deps: d, log } = deps({ start: async () => { throw reason; } });
      assert.equal(await runDesktopBrowserSignIn(d), 'fallback', reason);
      assert.ok(log.includes('openInApp'), reason);
    }
  });

  it('explains every server or network failure', async () => {
    const messages = new Map<string, RegExp>([
      ['timed_out', /timed out/],
      ['invalid_grant', /expired/],
      ['sign_in_refused', /cannot sign in/],
      ['service_unavailable', /try again in a moment/i],
      ['upstream_unavailable', /try again in a moment/i],
      ['network_failed', /try again in a moment/i],
      ['exchange_failed', /try again/i],
      ['something new', /try again/i],
    ]);
    for (const [reason, pattern] of messages) {
      const { deps: d, log } = deps({ start: async () => { throw reason; } });
      assert.equal(await runDesktopBrowserSignIn(d), 'failed', reason);
      const notice = log.find((entry) => entry.startsWith('notify:')) ?? '';
      assert.match(notice, pattern, reason);
    }
  });

  it('wires Cancel and Sign in here instead from the waiting bar', async () => {
    let actions: { onCancel(): void; onInApp(): void } | undefined;
    let release: (reason: string) => void = () => {};
    const { deps: d, log } = deps({
      showWaiting: (handlers) => {
        actions = handlers;
        return () => log.push('dismiss');
      },
      start: () => new Promise((_, reject) => { release = reject; }),
    });

    const run = runDesktopBrowserSignIn(d);
    await Promise.resolve();
    actions!.onInApp();
    release('cancelled');
    assert.equal(await run, 'cancelled');
    assert.ok(log.includes('cancel'));
    assert.ok(log.includes('openInApp'));
  });

  it('treats a complete status without a session id as a failure', async () => {
    const { deps: d, log } = deps({
      finish: async () => ({ status: 'complete', createdSessionId: null, identifier: null }),
    });
    assert.equal(await runDesktopBrowserSignIn(d), 'failed');
    assert.equal(log.some((entry) => entry.startsWith('setActive')), false);
  });
});

describe('createSingleFlightSignIn', () => {
  it('keeps one attempt alive through sign-out, redemption and activation', async () => {
    let finishFirst: (outcome: BrowserSignInOutcome) => void = () => {};
    const { deps: d, log } = deps({
      finish: () => new Promise((resolve) => { finishFirst = resolve; }),
    });
    const busy: string[] = [];
    const signIn = createSingleFlightSignIn(() => busy.push('busy'));

    const first = signIn(d);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(await signIn(d), 'cancelled', 'a second click while one runs is refused');
    assert.deepEqual(busy, ['busy']);
    assert.equal(log.filter((entry) => entry.startsWith('start:')).length, 1);
    assert.equal(log.filter((entry) => entry === 'waiting').length, 1, 'the live waiting bar is not replaced');

    finishFirst(COMPLETE);
    assert.equal(await first, 'signed_in');
    const { deps: again } = deps();
    assert.equal(await signIn(again), 'signed_in', 'a later click starts a new attempt');
  });
});
