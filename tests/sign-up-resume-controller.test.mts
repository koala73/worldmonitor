/**
 * The resume controller against fake ports (#8577). Two triggers only: the
 * first Clerk emission after load (hydration) and a Create-account click
 * (user). Hydration never sends an email; a click on an expired code resends
 * first so the card's "code sent" subtitle is true.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  asEpochMs,
  asSignUpAttemptId,
  createSignUpResumeController,
  type FunnelTracker,
  type ResumeSurface,
  type SignUpResumePorts,
  type SignUpSnapshot,
} from '../src/services/sign-up-resume.ts';

const NOW = 1_790_400_000_000;
const ATTEMPT_ID = asSignUpAttemptId('sua_3Jr2uAz4iuUohdPDXnaKu9y6N6Y');

function pending(codeExpiresAt: number = NOW + 10 * 60_000): SignUpSnapshot {
  return {
    kind: 'pending',
    id: ATTEMPT_ID,
    email: 'new-user@example.com',
    strategy: 'email_code',
    emailUnverified: true,
    codeExpiresAt: asEpochMs(codeExpiresAt),
    abandonAt: asEpochMs(NOW + 24 * 3_600_000),
  };
}

interface Harness {
  ports: SignUpResumePorts;
  state: {
    signUp: SignUpSnapshot;
    signedIn: boolean;
    clerkModalOpen: boolean;
    resendResult: 'ok' | 'fail';
  };
  log: string[];
  surface: ResumeSurface & { opened: number; closed: number; dismiss: (() => void) | null };
  resends: number;
  markers: Map<string, string>;
}

function harness(signUp: SignUpSnapshot = pending()): Harness {
  const log: string[] = [];
  const markers = new Map<string, string>();
  const state = { signUp, signedIn: false, clerkModalOpen: false, resendResult: 'ok' as 'ok' | 'fail' };
  let open = false;
  const surface = {
    opened: 0,
    closed: 0,
    dismiss: null as (() => void) | null,
    open: (_attempt: { attemptId: string; email: string }, onDismiss: () => void) => {
      open = true;
      surface.opened += 1;
      surface.dismiss = onDismiss;
    },
    close: () => {
      open = false;
      surface.closed += 1;
    },
    isOpen: () => open,
  };
  const track: FunnelTracker = {
    started: () => log.push('started'),
    resumed: (p) => log.push(`resumed:${p.trigger}:${p.code}:${p.sinceBootMs}`),
    dismissed: () => log.push('dismissed'),
  };
  const h: Harness = {
    state,
    log,
    surface,
    markers,
    resends: 0,
    ports: {
      now: () => asEpochMs(NOW),
      sinceBootMs: () => 4200,
      readSnapshot: () => ({ signUp: state.signUp, signedIn: state.signedIn }),
      clerkModalOpen: () => state.clerkModalOpen,
      markers: {
        claimStarted: (id) => {
          if (markers.has(`started:${id}`)) return false;
          markers.set(`started:${id}`, '1');
          return true;
        },
        dismissed: (id) => markers.has(`dismissed:${id}`),
        markDismissed: (id) => void markers.set(`dismissed:${id}`, '1'),
        markResumed: () => void markers.set('resumed', '1'),
      },
      surface,
      resendCode: () => {
        h.resends += 1;
        return state.resendResult === 'ok' ? Promise.resolve() : Promise.reject(new Error('attempt gone'));
      },
      track,
    },
  };
  return h;
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('sign-up resume controller', () => {
  it('opens once on hydration, tracks started and resumed, and ignores later emissions', () => {
    const h = harness();
    const c = createSignUpResumeController(h.ports);
    c.onClerkEmission(true);
    c.onClerkEmission(false);
    c.onClerkEmission(false);
    assert.equal(h.surface.opened, 1);
    assert.equal(h.resends, 0);
    assert.deepEqual(h.log, ['started', 'resumed:hydration:live:4200']);
    assert.equal(h.markers.get('resumed'), '1');
  });

  it('does not open while Clerk\'s own modal is on screen', () => {
    const h = harness();
    h.state.clerkModalOpen = true;
    const c = createSignUpResumeController(h.ports);
    c.onClerkEmission(true);
    assert.equal(h.surface.opened, 0);
    assert.equal(c.resumeOnUserIntent(() => {}), false);
  });

  it('closes the surface when a session appears', () => {
    const h = harness();
    const c = createSignUpResumeController(h.ports);
    c.onClerkEmission(true);
    h.state.signedIn = true;
    c.onClerkEmission(false);
    assert.equal(h.surface.closed, 1);
    assert.equal(h.surface.isOpen(), false);
  });

  it('never resends an expired code on hydration', async () => {
    const h = harness(pending(NOW - 1));
    const c = createSignUpResumeController(h.ports);
    c.onClerkEmission(true);
    await tick();
    assert.equal(h.resends, 0);
    assert.equal(h.surface.opened, 0);
    assert.deepEqual(h.log, ['started']);
  });

  it('resends an expired code on the user trigger, then opens', async () => {
    const h = harness(pending(NOW - 1));
    const c = createSignUpResumeController(h.ports);
    c.onClerkEmission(true);
    let fallbacks = 0;
    assert.equal(c.resumeOnUserIntent(() => { fallbacks += 1; }), true);
    assert.equal(h.resends, 1);
    assert.equal(h.surface.opened, 0, 'opens only after the resend settles');
    await tick();
    assert.equal(h.surface.opened, 1);
    assert.equal(fallbacks, 0);
    assert.deepEqual(h.log, ['started', 'resumed:user:expired:4200']);
  });

  it('falls back to Clerk\'s modal when the resend fails', async () => {
    const h = harness(pending(NOW - 1));
    h.state.resendResult = 'fail';
    const c = createSignUpResumeController(h.ports);
    c.onClerkEmission(true);
    let fallbacks = 0;
    assert.equal(c.resumeOnUserIntent(() => { fallbacks += 1; }), true);
    await tick();
    assert.equal(fallbacks, 1);
    assert.equal(h.surface.opened, 0);
    assert.equal(h.markers.has('resumed'), false);
  });

  it('takes a live-code click without resending, and a second click is a no-op', () => {
    const h = harness();
    const c = createSignUpResumeController(h.ports);
    assert.equal(c.resumeOnUserIntent(() => {}), true);
    assert.equal(c.resumeOnUserIntent(() => {}), true);
    assert.equal(h.surface.opened, 1);
    assert.equal(h.resends, 0);
  });

  it('remembers a dismissal per attempt and does not reopen it on hydration', () => {
    const h = harness();
    const c = createSignUpResumeController(h.ports);
    c.onClerkEmission(true);
    h.surface.dismiss?.();
    assert.deepEqual(h.log, ['started', 'resumed:hydration:live:4200', 'dismissed']);
    assert.equal(h.markers.has(`dismissed:${ATTEMPT_ID}`), true);

    const again = createSignUpResumeController(h.ports);
    again.onClerkEmission(true);
    assert.equal(h.surface.opened, 1);
    assert.equal(again.resumeOnUserIntent(() => {}), false, 'a click after dismissal goes to Clerk');
  });

  it('tracks started once per attempt id across reloads and emissions', () => {
    const h = harness();
    createSignUpResumeController(h.ports).onClerkEmission(true);
    createSignUpResumeController(h.ports).onClerkEmission(true);
    assert.equal(h.log.filter((e) => e === 'started').length, 1);
  });

  it('does nothing when Clerk never loaded', () => {
    const h = harness();
    const c = createSignUpResumeController({ ...h.ports, readSnapshot: () => null });
    c.onClerkEmission(true);
    assert.equal(h.surface.opened, 0);
    assert.deepEqual(h.log, []);
    assert.equal(c.resumeOnUserIntent(() => {}), false);
  });
});
