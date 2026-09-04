/**
 * Coverage for the passkey offer card (`src/components/PasskeyOfferPrompt.ts`).
 *
 * These are **semantic** assertions. happy-dom performs no layout, so a test
 * claiming "the card clears the bottom nav" would pass no matter what the CSS
 * said — geometry is proved in a real browser per the plan's Verification
 * Contract, not here.
 *
 * What this file does pin, because each fails silently in production:
 *   - the live region is a dedicated, initially-empty node, not the card
 *   - the card is a labelled region, never a dialog, and never moves focus
 *   - hiding removes it from the accessibility tree (not just visually)
 *   - restoring does not re-announce a status the user already heard
 *   - a terminal failure stays put; only success is allowed to auto-dismiss
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// Repo convention for DOM tests: t() echoes the key, so a rendered label that
// equals its key proves the string went through i18n rather than being a
// hardcoded literal.
vi.mock('@/services/i18n', () => ({ t: (key: string) => key }));

import { PasskeyOfferPrompt } from '@/components/PasskeyOfferPrompt';

/** Run scheduled callbacks synchronously so announcement timing is testable. */
const immediate = (cb: () => void): number => { cb(); return 0; };

function mount(overrides: Partial<{ onAccept: () => void; onDismiss: () => void }> = {}) {
  const onAccept = overrides.onAccept ?? vi.fn();
  const onDismiss = overrides.onDismiss ?? vi.fn();
  const prompt = new PasskeyOfferPrompt({ onAccept, onDismiss });
  document.body.appendChild(prompt.getElement());
  return { prompt, onAccept, onDismiss, el: prompt.getElement() };
}

const accept = (el: HTMLElement) => el.querySelector<HTMLButtonElement>('.passkey-offer-accept');
const dismiss = (el: HTMLElement) => el.querySelector<HTMLButtonElement>('.passkey-offer-dismiss');
const close = (el: HTMLElement) => el.querySelector<HTMLButtonElement>('.passkey-offer-close');
const status = (el: HTMLElement) => el.querySelector<HTMLElement>('.passkey-offer-status');
const announce = (el: HTMLElement) => el.querySelector<HTMLElement>('.passkey-offer-announce');
const body = (el: HTMLElement) => el.querySelector<HTMLElement>('.passkey-offer-body');

beforeEach(() => {
  document.body.replaceChildren();
});

describe('PasskeyOfferPrompt — structure and intents', () => {
  it('renders accept and dismiss as real buttons', () => {
    const { el } = mount();
    expect(accept(el)?.tagName).toBe('BUTTON');
    expect(dismiss(el)?.tagName).toBe('BUTTON');
    expect(accept(el)?.type).toBe('button');
  });

  it('invokes onAccept exactly once per accept activation', () => {
    const { el, onAccept } = mount();
    accept(el)?.click();
    expect(onAccept).toHaveBeenCalledOnce();
  });

  it('invokes onDismiss from both the dismiss and the close control', () => {
    const { el, onDismiss } = mount();
    dismiss(el)?.click();
    close(el)?.click();
    expect(onDismiss).toHaveBeenCalledTimes(2);
  });

  it('routes every visible label through t() rather than a hardcoded literal', () => {
    const { el } = mount();
    expect(el.querySelector('.passkey-offer-title')?.textContent).toBe('components.passkeyOffer.title');
    expect(el.querySelector('.passkey-offer-body')?.textContent).toBe('components.passkeyOffer.body');
    expect(accept(el)?.textContent).toBe('components.passkeyOffer.accept');
    expect(dismiss(el)?.textContent).toBe('components.passkeyOffer.dismiss');
    expect(el.getAttribute('aria-label')).toBe('components.passkeyOffer.title');
    expect(close(el)?.getAttribute('aria-label')).toBe('components.passkeyOffer.close');
  });
});

describe('PasskeyOfferPrompt — accessibility', () => {
  it('is a labelled region, not a dialog, and does not move focus on mount', () => {
    const { el } = mount();
    expect(el.tagName).toBe('ASIDE');
    expect(el.getAttribute('aria-label')).toBeTruthy();
    expect(el.getAttribute('role')).toBeNull();
    expect(el.getAttribute('aria-modal')).toBeNull();
    expect(document.activeElement).not.toBe(el);
    expect(el.contains(document.activeElement)).toBe(false);
  });

  it('puts aria-live on a dedicated node that is empty on mount — never on the card', () => {
    const { el } = mount();
    expect(el.getAttribute('aria-live')).toBeNull();
    const live = status(el);
    expect(live?.getAttribute('aria-live')).toBe('polite');
    expect(live?.textContent).toBe('');
  });

  it('announces arrival on a later frame, once the region already exists', () => {
    const { prompt, el } = mount();
    expect(announce(el)?.textContent).toBe('');
    prompt.announceOnMount(immediate);
    expect(announce(el)?.textContent).not.toBe('');
  });

  it('does NOT paint the arrival sentence, which restates the body copy', () => {
    // Shipped broken: the arrival sentence went into the VISIBLE status node,
    // so the card showed two sentences saying the same thing.
    const { prompt, el } = mount();
    prompt.announceOnMount(immediate);

    expect(status(el)?.textContent).toBe('');
    const spoken = announce(el)?.textContent ?? '';
    expect(spoken).not.toBe('');
    expect(spoken).not.toBe(body(el)?.textContent);
  });

  it('drops the stale arrival sentence once a state exists', () => {
    const { prompt, el } = mount();
    prompt.announceOnMount(immediate);
    prompt.setState('succeeded');

    expect(announce(el)?.textContent).toBe('');
    expect(status(el)?.textContent).not.toBe('');
  });

  it('sets aria-busy and disables the actions during the ceremony', () => {
    const { prompt, el } = mount();
    prompt.setState('busy');
    expect(el.getAttribute('aria-busy')).toBe('true');
    expect(accept(el)?.disabled).toBe(true);
    expect(dismiss(el)?.disabled).toBe(true);
  });

  it('cannot start a second ceremony from a double-tap while busy', () => {
    const { prompt, el, onAccept } = mount();
    accept(el)?.click();
    prompt.setState('busy');
    accept(el)?.click();
    expect(onAccept).toHaveBeenCalledOnce();
  });
});

describe('PasskeyOfferPrompt — states', () => {
  it('keeps the card mounted and the accept control enabled when retryable (AE3)', () => {
    const { prompt, el } = mount();
    prompt.setState('retryable');
    expect(el.isConnected).toBe(true);
    expect(accept(el)?.disabled).toBe(false);
    expect(status(el)?.textContent).not.toBe('');
  });

  it('writes confirmation into the live region on success (AE2)', () => {
    const { prompt, el } = mount();
    prompt.setState('succeeded');
    // Asserting the announced text, not merely that unmount happened — the
    // point of the success state is that the user hears something.
    expect(status(el)?.textContent).not.toBe('');
    expect(el.isConnected).toBe(true);
  });

  it('leaves a terminal failure on screen until the user closes it', async () => {
    vi.useFakeTimers();
    try {
      const { prompt, el } = mount();
      prompt.setState('failed');
      expect(status(el)?.textContent).not.toBe('');
      // No timer may remove an error the user has not read.
      await vi.advanceTimersByTimeAsync(60_000);
      expect(el.isConnected).toBe(true);
      close(el)?.click();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('PasskeyOfferPrompt — terminal states lock accept (PR #7353 review)', () => {
  it('disables accept during the success linger so a second tap cannot duplicate creation', () => {
    const { prompt, el, onAccept } = mount();
    prompt.setState('succeeded');
    expect(accept(el)?.disabled).toBe(true);
    accept(el)?.click();
    expect(onAccept).not.toHaveBeenCalled();
  });

  it('disables accept after a terminal failure — it was classified non-retryable', () => {
    const { prompt, el, onAccept } = mount();
    prompt.setState('failed');
    expect(accept(el)?.disabled).toBe(true);
    accept(el)?.click();
    expect(onAccept).not.toHaveBeenCalled();
  });

  it('keeps dismiss available in terminal states so a failure can be closed', () => {
    const { prompt, el, onDismiss } = mount();
    prompt.setState('failed');
    expect(dismiss(el)?.disabled).toBe(false);
    dismiss(el)?.click();
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it('ignores a synthetic accept in a terminal state even past the disabled attribute', () => {
    const { prompt, el, onAccept } = mount();
    prompt.setState('succeeded');
    accept(el)!.disabled = false; // simulate a stale listener or scripted click
    accept(el)?.click();
    expect(onAccept).not.toHaveBeenCalled();
  });

  it('still allows accept from the retryable state (AE3)', () => {
    const { prompt, el, onAccept } = mount();
    prompt.setState('retryable');
    accept(el)?.click();
    expect(onAccept).toHaveBeenCalledOnce();
  });
});

describe('PasskeyOfferPrompt — overlay arbitration', () => {
  it('hiding removes the card from the accessibility tree, not just visually', () => {
    const { prompt, el } = mount();
    prompt.hide();
    expect(el.hidden).toBe(true);
  });

  it('defers the arrival announcement until an initially hidden card is restored', () => {
    const { prompt, el } = mount();
    const scheduledFrame: { run: (() => void) | null } = { run: null };
    prompt.hide();
    prompt.announceOnMount((cb) => { scheduledFrame.run = cb; return 1; });

    scheduledFrame.run?.();
    expect(announce(el)?.textContent).toBe('');

    prompt.restore(immediate);
    expect(announce(el)?.textContent).not.toBe('');
  });

  it('restoring does not re-announce a status the user already heard', () => {
    const { prompt, el } = mount();
    prompt.setState('retryable');
    const heard = status(el)?.textContent;
    expect(heard).not.toBe('');

    prompt.hide();
    // Cleared before re-showing, then re-written — a live region that still
    // holds its old text when it reappears announces the outcome twice.
    prompt.restore(immediate);
    expect(status(el)?.textContent).toBe(heard);
    expect(el.hidden).toBe(false);
  });

  it('restores focus to the prompt control only when nothing else claimed it', () => {
    const { prompt, el } = mount();
    accept(el)?.focus();
    expect(document.activeElement).toBe(accept(el));

    prompt.hide();
    prompt.restore(immediate);
    expect(document.activeElement).toBe(accept(el));
  });

  it('leaves focus alone when the user moved on while the overlay was up', () => {
    const { prompt, el } = mount();
    accept(el)?.focus();
    prompt.hide();

    const elsewhere = document.createElement('button');
    document.body.appendChild(elsewhere);
    elsewhere.focus();

    prompt.restore(immediate);
    expect(document.activeElement).toBe(elsewhere);
  });
});

describe('PasskeyOfferPrompt — positioning wiring (semantic only)', () => {
  it('carries the class the bottom-stack custom properties target', () => {
    // Geometry is unprovable here — happy-dom does no layout. This only pins
    // that the element opts into the shared stack; real non-overlap is a
    // browser check in the Verification Contract.
    const { el } = mount();
    expect(el.classList.contains('passkey-offer-prompt')).toBe(true);
  });
});

describe('PasskeyOfferPrompt — teardown', () => {
  it('removes the element and leaves no listener firing on a detached node', () => {
    const { prompt, el, onAccept, onDismiss } = mount();
    const acceptBtn = accept(el);
    prompt.destroy();

    expect(el.isConnected).toBe(false);
    acceptBtn?.click();
    expect(onAccept).not.toHaveBeenCalled();
    expect(onDismiss).not.toHaveBeenCalled();
  });
});
