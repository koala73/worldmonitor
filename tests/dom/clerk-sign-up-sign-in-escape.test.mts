/**
 * Clerk's sign-up code card has no way back to sign-in. Under strict
 * enumeration protection an email that already has an account, typed into
 * sign-up, lands there and never gets a code; Clerk emails "sign in instead"
 * with no link. The escape adds the missing Sign in action to that card only.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  SIGN_UP_CODE_CARD_SELECTOR,
  installSignUpSignInEscape,
} from '../../shared/clerk-sign-up-escape';

const flush = () => new Promise((r) => setTimeout(r, 0));

function clerkCard(part: string): HTMLDivElement {
  const box = document.createElement('div');
  box.className = 'cl-cardBox';
  const card = document.createElement('div');
  card.className = `cl-card ${part}`;
  const form = document.createElement('form');
  form.append(document.createElement('input'));
  card.append(form);
  box.append(card);
  document.body.append(box);
  return card;
}

function escapeButton(card: Element): HTMLButtonElement | null {
  return card.querySelector<HTMLButtonElement>('[data-wm-sign-in-escape] button');
}

let dispose: (() => void) | null = null;

beforeEach(() => {
  document.body.replaceChildren();
});

afterEach(() => {
  dispose?.();
  dispose = null;
});

describe('sign-up code card escape to sign-in', () => {
  it('targets Clerk\'s sign-up email-code card', () => {
    expect(SIGN_UP_CODE_CARD_SELECTOR).toBe('.cl-signUp-emailCode');
  });

  it('adds one Sign in action to a code card that mounts after install, and clicking it hands over', async () => {
    let calls = 0;
    dispose = installSignUpSignInEscape(document, () => { calls += 1; });
    const card = clerkCard('cl-signUp-emailCode');
    await flush();
    const button = escapeButton(card);
    expect(button?.textContent).toBe('Sign in');
    expect(button?.type).toBe('button');
    expect(card.querySelector('[data-wm-sign-in-escape]')?.textContent).toContain('Already have an account?');
    button!.click();
    expect(calls).toBe(1);
    // Clerk re-renders inside the card; the action is never duplicated.
    card.querySelector('form')!.append(document.createElement('span'));
    await flush();
    expect(card.querySelectorAll('[data-wm-sign-in-escape]').length).toBe(1);
  });

  it('adds one action, inside the innermost card, when Clerk puts the class on nested elements', async () => {
    // Seen on production: an ancestor of the card carries the same class, and
    // decorating both rendered a second row outside the card.
    dispose = installSignUpSignInEscape(document, () => {});
    const outer = document.createElement('div');
    outer.className = 'cl-cardBox cl-signUp-emailCode';
    const inner = document.createElement('div');
    inner.className = 'cl-card cl-signUp-emailCode';
    outer.append(inner);
    document.body.append(outer);
    await flush();
    expect(document.querySelectorAll('[data-wm-sign-in-escape]').length).toBe(1);
    expect(inner.lastElementChild?.hasAttribute('data-wm-sign-in-escape')).toBe(true);
  });

  it('decorates an element that becomes the code card by a class change', async () => {
    dispose = installSignUpSignInEscape(document, () => {});
    const card = clerkCard('cl-signUp-start');
    await flush();
    expect(escapeButton(card)).toBeNull();
    card.className = 'cl-card cl-signUp-emailCode';
    await flush();
    expect(escapeButton(card)).not.toBeNull();
  });

  it('removes the action when the element stops being the code card, keeping a nested card\'s action', async () => {
    dispose = installSignUpSignInEscape(document, () => {});
    const card = clerkCard('cl-signUp-emailCode');
    await flush();
    expect(escapeButton(card)).not.toBeNull();
    card.className = 'cl-card cl-signUp-start';
    await flush();
    expect(escapeButton(card)).toBeNull();

    const outer = document.createElement('div');
    outer.className = 'cl-cardBox cl-signUp-emailCode';
    const inner = document.createElement('div');
    inner.className = 'cl-card cl-signUp-emailCode';
    outer.append(inner);
    document.body.append(outer);
    await flush();
    outer.className = 'cl-cardBox';
    await flush();
    expect(inner.querySelectorAll('[data-wm-sign-in-escape]').length).toBe(1);
  });

  it('restores the action when Clerk replaces the card\'s children', async () => {
    dispose = installSignUpSignInEscape(document, () => {});
    const card = clerkCard('cl-signUp-emailCode');
    await flush();
    expect(escapeButton(card)).not.toBeNull();
    const form = document.createElement('form');
    form.append(document.createElement('input'));
    card.replaceChildren(form);
    await flush();
    expect(card.querySelectorAll('[data-wm-sign-in-escape]').length).toBe(1);
  });

  it('decorates a code card already on screen at install', () => {
    const card = clerkCard('cl-signUp-emailCode');
    dispose = installSignUpSignInEscape(document, () => {});
    expect(escapeButton(card)).not.toBeNull();
  });

  it('leaves the sign-up start card and the sign-in code card alone', async () => {
    dispose = installSignUpSignInEscape(document, () => {});
    const start = clerkCard('cl-signUp-start');
    const signInCode = clerkCard('cl-signIn-emailCode');
    await flush();
    expect(escapeButton(start)).toBeNull();
    expect(escapeButton(signInCode)).toBeNull();
  });

  it('dispose removes the action and stops watching', async () => {
    const first = clerkCard('cl-signUp-emailCode');
    const stop = installSignUpSignInEscape(document, () => {});
    expect(escapeButton(first)).not.toBeNull();
    stop();
    expect(escapeButton(first)).toBeNull();
    const later = clerkCard('cl-signUp-emailCode');
    await flush();
    expect(escapeButton(later)).toBeNull();
  });
});

describe('switching from sign-up to sign-in', () => {
  // The cap is a product decision: Sign in must open within two seconds.
  const CAP_MS = 2_000;
  const FRAME_MS = 16;

  function harness() {
    const log: string[] = [];
    const frames: Array<() => void> = [];
    let clock = 0;
    const state = { mounted: true };
    const deps = {
      authSurfaceMounted: () => state.mounted,
      now: () => clock,
      nextFrame: (cb: () => void) => { frames.push(cb); },
    };
    const runFrame = () => { clock += FRAME_MS; frames.shift()?.(); };
    const clerk = { closeSignUp: () => log.push('closeSignUp'), closeSignIn: () => log.push('closeSignIn') };
    return { log, frames, deps, clerk, state, runFrame };
  }

  it('closes both forms at once and opens sign-in only after Clerk has unmounted them', async () => {
    const { createSignUpToSignInSwitch } = await import('../../shared/clerk-sign-up-escape');
    const h = harness();
    const sw = createSignUpToSignInSwitch(h.clerk, h.deps);
    sw.run(() => h.log.push('open'));
    expect(h.log).toEqual(['closeSignUp', 'closeSignIn']);
    h.runFrame();
    h.runFrame();
    expect(h.log).not.toContain('open');
    h.state.mounted = false;
    h.runFrame();
    expect(h.log).toEqual(['closeSignUp', 'closeSignIn', 'open']);
  });

  it('stays in flight until sign-in is on screen, and ignores a second click meanwhile', async () => {
    const { createSignUpToSignInSwitch } = await import('../../shared/clerk-sign-up-escape');
    const h = harness();
    const sw = createSignUpToSignInSwitch(h.clerk, h.deps);
    sw.run(() => h.log.push('open'));
    expect(sw.inFlight()).toBe(true);
    h.state.mounted = false;
    h.runFrame();
    expect(h.log).toContain('open');
    sw.run(() => h.log.push('second'));
    // Sign-in has not mounted yet: a dismissal watcher must not see a cancel.
    for (let i = 0; i < 50; i++) h.runFrame();
    expect(sw.inFlight()).toBe(true);
    h.state.mounted = true;
    h.runFrame();
    expect(sw.inFlight()).toBe(false);
    expect(h.log.filter((e) => e === 'open').length).toBe(1);
    expect(h.log).not.toContain('second');
    expect(h.frames.length).toBe(0);
    sw.run(() => h.log.push('again'));
    expect(h.log.slice(-2)).toEqual(['closeSignUp', 'closeSignIn']);
  });

  it('opens sign-in anyway at the two-second cap, then ends the switch two seconds later if sign-in never mounts', async () => {
    const { createSignUpToSignInSwitch } = await import('../../shared/clerk-sign-up-escape');
    const h = harness();
    const sw = createSignUpToSignInSwitch(h.clerk, h.deps);
    sw.run(() => { h.log.push('open'); h.state.mounted = false; });
    const capFrame = Math.ceil(CAP_MS / FRAME_MS);
    for (let i = 0; i < capFrame - 1; i++) h.runFrame();
    expect(h.log).not.toContain('open');
    h.runFrame();
    expect(h.log.filter((e) => e === 'open').length).toBe(1);
    for (let i = 0; i < capFrame - 1; i++) h.runFrame();
    expect(sw.inFlight()).toBe(true);
    h.runFrame();
    expect(sw.inFlight()).toBe(false);
    expect(h.frames.length).toBe(0);
  });

  it('ends the switch when opening sign-in throws', async () => {
    const { createSignUpToSignInSwitch } = await import('../../shared/clerk-sign-up-escape');
    const h = harness();
    const sw = createSignUpToSignInSwitch(h.clerk, h.deps);
    sw.run(() => { throw new Error('ui components not ready'); });
    h.state.mounted = false;
    expect(() => h.runFrame()).toThrow('ui components not ready');
    expect(sw.inFlight()).toBe(false);
  });
});
