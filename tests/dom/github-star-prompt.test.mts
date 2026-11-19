/**
 * Ask-once GitHub star prompt (src/services/github-star-prompt-state.ts,
 * src/app/github-star-prompt-boot.ts, src/app/github-star-prompt.ts).
 *
 * Pins the promises the prompt makes: it asks only from the 3rd visit day,
 * only after 30 s idle with focus, never twice after any close, never to paying
 * users or inside an iframe, and never when storage cannot keep the dismissal.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const auth = { isPending: false, premium: false, tierResolved: true };
const tracked: string[] = [];
const opened: string[] = [];
const openResult = { value: 'popup' as string };

vi.mock('@/services/auth-state', () => ({
  getAuthState: () => ({ user: null, isPending: auth.isPending }),
}));
vi.mock('@/services/panel-gating', () => ({
  hasPremiumAccess: () => auth.premium,
}));
vi.mock('@/services/widget-store', () => ({
  isProTierResolved: () => auth.tierResolved,
}));
vi.mock('@/services/analytics', () => ({
  trackGithubStarPrompt: (outcome: string) => { tracked.push(outcome); },
}));
vi.mock('@/services/external-navigation', () => ({
  openExternalUrl: async (url: string) => { opened.push(url); return openResult.value; },
}));
vi.mock('@/services/i18n', () => ({ t: (key: string) => key }));

import { bootGitHubStarPrompt } from '@/app/github-star-prompt-boot';
import {
  canPersistStarPromptDismissal,
  decideStarPrompt,
  localDayKey,
  recordVisitDay,
  STAR_PROMPT_DISMISSED_KEY,
  STAR_PROMPT_IDLE_MS,
  STAR_PROMPT_PROBE_KEY,
  STAR_PROMPT_VISITS_KEY,
  type StarPromptStorage,
} from '@/services/github-star-prompt-state';

const DAY1 = new Date(2026, 10, 1, 10);
const DAY2 = new Date(2026, 10, 2, 10);
const DAY3 = new Date(2026, 10, 3, 10);

function memoryStorage(): StarPromptStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => { data.set(k, String(v)); },
    removeItem: (k) => { data.delete(k); },
  };
}

/** Let the dynamic import of the controller chunk settle. */
async function flushImport(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
  await vi.dynamicImportSettled();
}

function toast(): HTMLElement | null {
  return document.querySelector('.github-star-prompt');
}

describe('visit-day ledger', () => {
  it('counts each local day once', () => {
    const s = memoryStorage();
    expect(recordVisitDay(s, '2026-11-01')).toBe(1);
    expect(recordVisitDay(s, '2026-11-01')).toBe(1);
    expect(recordVisitDay(s, '2026-11-02')).toBe(2);
    expect(recordVisitDay(s, '2026-11-05')).toBe(3);
  });

  it('returns null when storage is missing, throws, or drops writes', () => {
    expect(recordVisitDay(null, '2026-11-01')).toBeNull();
    const throwing: StarPromptStorage = {
      getItem: () => { throw new Error('blocked'); },
      setItem: () => { throw new Error('blocked'); },
      removeItem: () => {},
    };
    expect(recordVisitDay(throwing, '2026-11-01')).toBeNull();
    const dropping: StarPromptStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
    expect(recordVisitDay(dropping, '2026-11-01')).toBeNull();
  });

  it('returns null on a same-day visit when storage reads but no longer writes', () => {
    const s = memoryStorage();
    expect(recordVisitDay(s, '2026-11-03')).toBe(1);
    s.setItem = () => { throw new Error('QuotaExceededError'); };
    expect(recordVisitDay(s, '2026-11-03')).toBeNull();
  });

  it('probes that a NEW key can be written, and cleans up the probe', () => {
    const s = memoryStorage();
    expect(canPersistStarPromptDismissal(s)).toBe(true);
    expect(s.data.has(STAR_PROMPT_PROBE_KEY)).toBe(false);
    expect(canPersistStarPromptDismissal(null)).toBe(false);
  });

  it('recovers from a corrupt ledger by starting over', () => {
    const s = memoryStorage();
    s.data.set(STAR_PROMPT_VISITS_KEY, '{not json');
    expect(recordVisitDay(s, '2026-11-01')).toBe(1);
  });

  it('formats local days', () => {
    expect(localDayKey(new Date(2026, 0, 5, 23, 59))).toBe('2026-01-05');
  });
});

describe('decideStarPrompt', () => {
  const base = { inIframe: false, dismissed: false, visitDays: 3, premium: false };
  it('asks from the 3rd visit day', () => {
    expect(decideStarPrompt({ ...base, visitDays: 2 })).toBe('too-early');
    expect(decideStarPrompt(base)).toBe('ask');
  });
  it('suppresses iframes, dismissals, premium and unusable storage', () => {
    expect(decideStarPrompt({ ...base, inIframe: true })).toBe('in-iframe');
    expect(decideStarPrompt({ ...base, dismissed: true })).toBe('dismissed');
    expect(decideStarPrompt({ ...base, premium: true })).toBe('premium');
    expect(decideStarPrompt({ ...base, dismissed: null })).toBe('storage-unavailable');
    expect(decideStarPrompt({ ...base, visitDays: null })).toBe('storage-unavailable');
  });
});

describe('boot gate and controller', () => {
  let destroy: (() => void) | null = null;

  beforeEach(() => {
    localStorage.clear();
    document.body.innerHTML = '';
    auth.isPending = false;
    auth.premium = false;
    auth.tierResolved = true;
    tracked.length = 0;
    opened.length = 0;
    openResult.value = 'popup';
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame'] });
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  });

  afterEach(() => {
    destroy?.();
    destroy = null;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  async function bootOn(day: Date) {
    const result = bootGitHubStarPrompt(day);
    destroy = result.destroy;
    await flushImport();
    return result.decision;
  }

  async function reachThirdDay() {
    expect(await bootOn(DAY1)).toBe('too-early');
    destroy?.();
    expect(await bootOn(DAY2)).toBe('too-early');
    destroy?.();
    expect(await bootOn(DAY3)).toBe('ask');
  }

  it('shows after 30 s idle on the 3rd visit day, and input restarts the wait', async () => {
    await reachThirdDay();
    vi.advanceTimersByTime(STAR_PROMPT_IDLE_MS - 1_000);
    window.dispatchEvent(new KeyboardEvent('keydown'));
    vi.advanceTimersByTime(STAR_PROMPT_IDLE_MS - 1_000);
    expect(toast()).toBeNull();
    vi.advanceTimersByTime(1_000);
    expect(toast()).not.toBeNull();
    expect(tracked).toEqual(['shown']);
  });

  it('Star opens GitHub and never asks again', async () => {
    await reachThirdDay();
    vi.advanceTimersByTime(STAR_PROMPT_IDLE_MS);
    toast()!.querySelector<HTMLButtonElement>('.update-toast-action')!.click();
    await flushImport();
    expect(opened).toEqual(['https://github.com/koala73/worldmonitor']);
    expect(toast()).toBeNull();
    expect(localStorage.getItem(STAR_PROMPT_DISMISSED_KEY)).toBe('1');
    expect(tracked).toEqual(['shown', 'starred']);
    destroy?.();
    expect(await bootOn(new Date(2026, 10, 9, 10))).toBe('dismissed');
  });

  it('a failed open still dismisses but is not counted as starred', async () => {
    openResult.value = 'failed';
    await reachThirdDay();
    vi.advanceTimersByTime(STAR_PROMPT_IDLE_MS);
    toast()!.querySelector<HTMLButtonElement>('.update-toast-action')!.click();
    await flushImport();
    expect(opened).toHaveLength(1);
    expect(toast()).toBeNull();
    expect(localStorage.getItem(STAR_PROMPT_DISMISSED_KEY)).toBe('1');
    expect(tracked).toEqual(['shown']);
  });

  it('× dismisses permanently', async () => {
    await reachThirdDay();
    vi.advanceTimersByTime(STAR_PROMPT_IDLE_MS);
    toast()!.querySelector<HTMLButtonElement>('.update-toast-dismiss')!.click();
    expect(opened).toEqual([]);
    expect(tracked).toEqual(['shown', 'dismissed']);
    destroy?.();
    expect(await bootOn(new Date(2026, 10, 9, 10))).toBe('dismissed');
  });

  it('does not show to a paying user found during the idle wait', async () => {
    await reachThirdDay();
    auth.premium = true;
    vi.advanceTimersByTime(STAR_PROMPT_IDLE_MS);
    expect(toast()).toBeNull();
    expect(tracked).toEqual([]);
  });

  it('skips boot entirely for a cached Pro hint', async () => {
    localStorage.setItem('wm-entitlement-hint', 'pro');
    await bootOn(DAY1);
    destroy?.();
    await bootOn(DAY2);
    destroy?.();
    expect(await bootOn(DAY3)).toBe('premium');
  });

  it('skips the session while the Pro verdict is unresolved (auth pending or no entitlement snapshot)', async () => {
    await reachThirdDay();
    auth.tierResolved = false;
    vi.advanceTimersByTime(STAR_PROMPT_IDLE_MS * 3);
    expect(toast()).toBeNull();
    expect(tracked).toEqual([]);
  });

  it('waits out a modal or another toast, then shows', async () => {
    await reachThirdDay();
    const other = document.createElement('div');
    other.className = 'update-toast';
    document.body.append(other);
    vi.advanceTimersByTime(STAR_PROMPT_IDLE_MS);
    expect(toast()).toBeNull();
    other.remove();
    vi.advanceTimersByTime(STAR_PROMPT_IDLE_MS);
    expect(toast()).not.toBeNull();
  });

  it('does not show while the window lacks focus', async () => {
    await reachThirdDay();
    vi.mocked(document.hasFocus).mockReturnValue(false);
    vi.advanceTimersByTime(STAR_PROMPT_IDLE_MS * 2);
    expect(toast()).toBeNull();
    vi.mocked(document.hasFocus).mockReturnValue(true);
    window.dispatchEvent(new FocusEvent('focus'));
    vi.advanceTimersByTime(STAR_PROMPT_IDLE_MS);
    expect(toast()).not.toBeNull();
  });

  it('a dismissal from another tab during the wait wins', async () => {
    await reachThirdDay();
    localStorage.setItem(STAR_PROMPT_DISMISSED_KEY, '1');
    vi.advanceTimersByTime(STAR_PROMPT_IDLE_MS);
    expect(toast()).toBeNull();
  });

  it('does not show when the existing ledger rewrites but a new key cannot be added (quota)', async () => {
    await reachThirdDay();
    // At the quota, overwriting an existing key succeeds but adding one throws.
    const realSetItem = localStorage.setItem.bind(localStorage);
    const spy = vi.spyOn(localStorage, 'setItem').mockImplementation((k: string, v: string) => {
      if (localStorage.getItem(k) === null) throw new DOMException('full', 'QuotaExceededError');
      realSetItem(k, v);
    });
    try {
      vi.advanceTimersByTime(STAR_PROMPT_IDLE_MS);
      expect(toast()).toBeNull();
      expect(tracked).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });

  it('destroy before idle removes listeners and never shows', async () => {
    await reachThirdDay();
    destroy?.();
    destroy = null;
    vi.advanceTimersByTime(STAR_PROMPT_IDLE_MS * 2);
    expect(toast()).toBeNull();
  });
});
