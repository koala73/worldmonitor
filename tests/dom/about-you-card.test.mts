/**
 * The About-you card (U2): one question per step, a save per tap with
 * rollback on failure, Skip/close/Escape as one skip, the reload contract, and
 * the return-visit mode (R19).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/i18n', () => ({
  t: (_key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? _key,
}));

import {
  ABOUT_YOU_CARD_ID,
  mountAboutYouCard,
  type AboutYouCardDeps,
} from '@/components/AboutYouCard';

const ALL = ['primaryUse', 'usageContext', 'payer', 'role', 'alternative'] as const;

function makeDeps(overrides: Partial<AboutYouCardDeps> = {}): AboutYouCardDeps {
  return {
    recordAnswer: vi.fn(async () => ({ ok: true as const })),
    recordFreeText: vi.fn(async () => ({ ok: true as const })),
    skip: vi.fn(async () => ({ ok: true as const })),
    markReturnShown: vi.fn(async () => ({ ok: true as const })),
    track: vi.fn(),
    ...overrides,
  };
}

function card(): HTMLElement | null {
  return document.getElementById(ABOUT_YOU_CARD_ID);
}

function option(id: string): HTMLButtonElement {
  const button = card()?.querySelector<HTMLButtonElement>(`[data-option-id="${id}"]`);
  if (!button) throw new Error(`option ${id} not rendered`);
  return button;
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

afterEach(() => {
  card()?.remove();
  vi.useRealTimers();
});

describe('AboutYouCard', () => {
  it('is a safe-to-reload region, not a dialog, and does not take focus', () => {
    const before = document.activeElement;
    mountAboutYouCard({ mode: 'full', questions: [...ALL], surface: 'dashboard', deps: makeDeps() });
    const root = card()!;
    expect(root.getAttribute('data-reload-policy')).toBe('safe');
    expect(root.getAttribute('role')).toBe('region');
    expect(root.getAttribute('aria-labelledby')).toBeTruthy();
    expect(document.activeElement).toBe(before);
    expect(root.querySelector('[aria-live="polite"]')).not.toBeNull();
  });

  it('shows one question at a time, primary use first', () => {
    mountAboutYouCard({ mode: 'full', questions: [...ALL], surface: 'dashboard', deps: makeDeps() });
    expect(card()!.querySelectorAll('.about-you-card__question')).toHaveLength(1);
    expect(option('markets')).toBeTruthy();
    expect(card()!.querySelector('[data-option-id="work"]')).toBeNull();
  });

  it('tapping an option records it once with the shared id, then moves on', async () => {
    const deps = makeDeps();
    mountAboutYouCard({ mode: 'full', questions: [...ALL], surface: 'dashboard', deps });
    option('commodities').click();
    option('commodities').click();
    await flush();
    expect(deps.recordAnswer).toHaveBeenCalledTimes(1);
    expect(deps.recordAnswer).toHaveBeenCalledWith('primaryUse', 'commodities');
    expect(option('work')).toBeTruthy();
    expect(deps.track).toHaveBeenCalledWith('about-you-answered', expect.objectContaining({ questionId: 'primaryUse' }));
  });

  it('a failed save rolls the selection back and offers a retry', async () => {
    const recordAnswer = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, reason: 'error' })
      .mockResolvedValueOnce({ ok: true });
    const deps = makeDeps({ recordAnswer });
    mountAboutYouCard({ mode: 'full', questions: [...ALL], surface: 'dashboard', deps });
    option('news').click();
    await flush();
    expect(option('news').getAttribute('aria-pressed')).toBe('false');
    const retry = card()!.querySelector<HTMLButtonElement>('.about-you-card__retry');
    expect(retry).not.toBeNull();
    retry!.click();
    await flush();
    expect(recordAnswer).toHaveBeenCalledTimes(2);
    expect(option('personal')).toBeTruthy();
  });

  it('Skip records one skip and removes the card', async () => {
    const deps = makeDeps();
    mountAboutYouCard({ mode: 'full', questions: [...ALL], surface: 'dashboard', deps });
    card()!.querySelector<HTMLButtonElement>('.about-you-card__skip')!.click();
    await flush();
    expect(card()).toBeNull();
    expect(deps.skip).toHaveBeenCalledTimes(1);
    expect(deps.track).toHaveBeenCalledWith('about-you-skipped', expect.objectContaining({ questionId: 'primaryUse' }));
  });

  it('close and Escape count as a skip', async () => {
    const deps = makeDeps();
    mountAboutYouCard({ mode: 'full', questions: [...ALL], surface: 'dashboard', deps });
    card()!.querySelector<HTMLButtonElement>('.about-you-card__close')!.click();
    await flush();
    expect(deps.skip).toHaveBeenCalledTimes(1);

    const deps2 = makeDeps();
    mountAboutYouCard({ mode: 'full', questions: [...ALL], surface: 'dashboard', deps: deps2 });
    option('news').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await flush();
    expect(card()).toBeNull();
    expect(deps2.skip).toHaveBeenCalledTimes(1);
  });

  it('Skip waits for typed free text to save before recording the skip', async () => {
    let releaseText: (value: { ok: true }) => void = () => {};
    const recordFreeText = vi.fn(() => new Promise<{ ok: true }>((resolve) => { releaseText = resolve; }));
    const deps = makeDeps({ recordFreeText });
    mountAboutYouCard({ mode: 'full', questions: ['alternative'], surface: 'dashboard', deps });
    const textarea = card()!.querySelector('textarea')!;
    textarea.value = 'A Bloomberg terminal';
    card()!.querySelector<HTMLButtonElement>('.about-you-card__skip')!.click();
    await flush();
    expect(recordFreeText).toHaveBeenCalledWith('A Bloomberg terminal');
    expect(deps.skip).not.toHaveBeenCalled();
    releaseText({ ok: true });
    await flush();
    expect(deps.skip).toHaveBeenCalledTimes(1);
  });

  it('typed free text saves after a pause, so an automatic reload cannot lose it', async () => {
    vi.useFakeTimers();
    const deps = makeDeps();
    mountAboutYouCard({ mode: 'full', questions: ['alternative'], surface: 'dashboard', deps });
    const textarea = card()!.querySelector('textarea')!;
    textarea.value = 'A Bloomberg';
    textarea.dispatchEvent(new Event('input'));
    vi.advanceTimersByTime(500);
    textarea.value = 'A Bloomberg terminal';
    textarea.dispatchEvent(new Event('input'));
    expect(deps.recordFreeText).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1_500);
    expect(deps.recordFreeText).toHaveBeenCalledTimes(1);
    expect(deps.recordFreeText).toHaveBeenCalledWith('A Bloomberg terminal');
  });

  it('after the last answer it thanks the user and closes itself', async () => {
    vi.useFakeTimers();
    const deps = makeDeps();
    mountAboutYouCard({ mode: 'full', questions: ['usageContext'], surface: 'dashboard', deps });
    option('work').click();
    await flush();
    expect(card()!.textContent).toContain('Thanks');
    vi.advanceTimersByTime(4_000);
    expect(card()).toBeNull();
    expect(deps.skip).not.toHaveBeenCalled();
  });

  it('return mode asks only the given questions, marks the return shown, and closing does not skip', async () => {
    const deps = makeDeps();
    mountAboutYouCard({ mode: 'return', questions: ['usageContext'], surface: 'dashboard', deps });
    expect(deps.markReturnShown).toHaveBeenCalledTimes(1);
    expect(card()!.querySelector('[data-option-id="markets"]')).toBeNull();
    expect(option('personal')).toBeTruthy();
    card()!.querySelector<HTMLButtonElement>('.about-you-card__close')!.click();
    await flush();
    expect(deps.skip).not.toHaveBeenCalled();
  });

  it('mounts only one card at a time', () => {
    mountAboutYouCard({ mode: 'full', questions: [...ALL], surface: 'dashboard', deps: makeDeps() });
    expect(mountAboutYouCard({ mode: 'full', questions: [...ALL], surface: 'dashboard', deps: makeDeps() })).toBeNull();
    expect(document.querySelectorAll(`#${ABOUT_YOU_CARD_ID}`)).toHaveLength(1);
  });
});
