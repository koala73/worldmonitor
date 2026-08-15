/**
 * #6577 — panels that repaint `this.content` themselves must clear the WHOLE
 * error state on their success render, not just the header chip.
 *
 * `showError(msg, onRetry)` does three things: it sets the header "Error" chip,
 * it arms a `setInterval` countdown that fires `onRetry` when it reaches zero,
 * and it advances `retryAttempt` so the next failure waits twice as long
 * (15s -> 30s -> 60s ... capped at 180s).
 *
 * `setContentHtml` unwinds all three implicitly. Panels that paint with
 * `replaceChildren(this.content, ...)` bypass that path, so they must clear the
 * whole state themselves. The panels below used to call `setErrorState(false)`,
 * which drops ONLY the chip — leaving the countdown ticking against a panel that
 * had already recovered (one redundant refresh per recovery) and leaving the
 * backoff latched a step high, so the next real failure re-entered at the wrong
 * rung.
 *
 * SUPERSEDED MECHANISM, SAME CONTRACT (#6678). #6577's fix was an explicit
 * `clearErrorState()` next to each raw write, because `Panel.setContentNodes` /
 * `setTrustedContent` did not exist yet. They do now, and #6678 routed all five
 * panels' SUCCESS writes through them — so the clear is part of the write and
 * none of these panels calls `clearErrorState()` directly any more. Do NOT copy
 * the old idiom into a new panel; use the sanctioned helpers.
 *
 * The cases below are unaffected because they drive each panel's real
 * `render()` / `setData()` / `renderArticles()` chain rather than the clear
 * itself — a broken clear inside the helper still fails them. What they no
 * longer pin is WHICH mechanism performs the clear; the per-call-site lock-bail
 * proof for the new mechanism lives in
 * `tests/dom/panel-content-write-6678.test.mts`.
 *
 * Each case drives the panel's OWN error and success call sites rather than the
 * shared `Panel` helper: a single mutation of `clearErrorState()` would be
 * killed by any one of them, but a per-site regression (one panel left on
 * `setErrorState`) is only visible if every site is exercised separately.
 * See docs/solutions/conventions/mutate-each-call-site-a-global-mutant-hides-per-site-holes.md
 *
 * The LOADING branches must NOT move to `clearErrorState()`, and the final
 * describe block pins that. Resetting `retryAttempt` on a loading render would
 * re-arm every retry at 15s forever and defeat the exponential backoff — so the
 * invariant there is the inverse of the one above: the rung must SURVIVE.
 *
 * The two loading shapes are not equivalent, and the distinction matters when
 * reading those cases:
 *   - `showLoading()` (Panel.ts) clears the chip AND the countdown, but
 *     deliberately leaves `retryAttempt` alone.
 *   - the raw `replaceChildren(this.content, …)` loading branches in
 *     ServiceStatus/TechEvents/DefensePatents clear NEITHER — the chip stays red
 *     and the interval keeps ticking for the whole retry fetch.
 * Both preserve the rung, which is the only property asserted below.
 *
 * REACHABILITY — three of these five panels are latent, not live. Only
 * TechEventsPanel and DefensePatentsPanel call an RPC that can actually reject:
 *   - ServiceStatusPanel: `fetchServiceStatuses` runs inside a CircuitBreaker
 *     whose `execute()` never rejects, and both of its returns hardcode
 *     `success: true` — so `if (!data.success) throw` is dead code and
 *     `showError` at :83 is unreachable.
 *   - GdeltIntelPanel: `fetchGdeltArticles` returns [] on `resp.error` and
 *     `fetchTopicTimeline` has a bare `catch { return null }`, so
 *     `loadActiveTopic`'s catch never runs and `showError` at :93 is unreachable.
 *   - GivingPanel: no caller ever passes an `onRetry` (see its case below).
 * Their cases reach the error state by injecting the private field or forcing a
 * mock rejection — states production cannot currently produce. They pin the
 * contract for the day those paths are made reachable; they are not evidence a
 * live user-facing bug was fixed on those three.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { initTestI18n } from './helpers/i18n.mts';

const {
  mockFetchTopicIntelligence,
  mockFetchTopicTimeline,
  mockRenderGivingPanelContent,
  mockAvailableGivingTabs,
} = vi.hoisted(() => ({
  mockFetchTopicIntelligence: vi.fn(),
  mockFetchTopicTimeline: vi.fn(),
  mockRenderGivingPanelContent: vi.fn(),
  mockAvailableGivingTabs: vi.fn(),
}));

vi.mock('@/services/gdelt-intel', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/services/gdelt-intel')>(),
  fetchTopicIntelligence: mockFetchTopicIntelligence,
  fetchTopicTimeline: mockFetchTopicTimeline,
}));

vi.mock('@/components/giving-renderer', () => ({
  availableGivingTabs: mockAvailableGivingTabs,
  renderGivingPanelContent: mockRenderGivingPanelContent,
}));

import { DefensePatentsPanel } from '@/components/DefensePatentsPanel';
import { GdeltIntelPanel } from '@/components/GdeltIntelPanel';
import { GivingPanel } from '@/components/GivingPanel';
import { ServiceStatusPanel } from '@/components/ServiceStatusPanel';
import { TechEventsPanel } from '@/components/TechEventsPanel';

/** Base-class state these tests reach into to observe the latch. */
interface PanelInternals {
  element: HTMLElement;
  header: HTMLElement;
  content: HTMLElement;
  retryCallback: (() => void) | null;
  retryAttempt: number;
  retryCountdownTimer: ReturnType<typeof setInterval> | null;
}

/** Per-panel fields the render() call sites branch on. */
interface RenderFlags {
  loading: boolean;
  error: string | null;
}

function internals(panel: object): PanelInternals {
  return panel as unknown as PanelInternals;
}

function flags(panel: object): RenderFlags {
  return panel as unknown as RenderFlags;
}

function mount(panel: object): void {
  document.body.appendChild(internals(panel).element);
}

/** The countdown line rendered by `showError`, e.g. "Retrying (15s)". */
function countdownText(panel: object): string | null {
  return internals(panel).content.querySelector('.panel-error-countdown')?.textContent ?? null;
}

/** The header "Error" chip is a class on the header, not a child element. */
function hasErrorChip(panel: object): boolean {
  return internals(panel).header.classList.contains('panel-header-error');
}

/**
 * Drive one panel's real error site, then its real success site, and assert the
 * recovery unwound the countdown AND the backoff — not just the chip.
 */
async function expectRecoveryClearsRetryState(
  panel: object,
  driveError: () => void | Promise<void>,
  driveSuccess: () => void | Promise<void>,
): Promise<void> {
  await driveError();

  // Preconditions: the error site really did set the chip and arm a real
  // countdown on a fresh panel, so neither assertion below can pass vacuously
  // against a panel that was never in an error state to begin with.
  expect(hasErrorChip(panel)).toBe(true);
  expect(countdownText(panel)).toMatch(/\(15s\)/);

  // Swap the panel's own retry for a spy: an interval that survives the success
  // render is otherwise invisible, since the success write already replaced the
  // countdown element in the DOM.
  const orphanedRetry = vi.fn();
  internals(panel).retryCallback = orphanedRetry;

  await driveSuccess();

  expect(hasErrorChip(panel)).toBe(false);

  // 1a. The interval HANDLE itself must be gone. The callback assertion below
  // cannot see this: an implementation that nulled `retryCallback` instead of
  // calling `clearRetryCountdown()` would leave a live 1s interval writing to a
  // detached node and still pass, because the interval finds the callback null
  // when it expires. Observe `clearRetryCountdown()` directly.
  expect(internals(panel).retryCountdownTimer).toBeNull();

  // 1b. The pending auto-retry must not outlive the recovery.
  await vi.advanceTimersByTimeAsync(30_000);
  expect(orphanedRetry).not.toHaveBeenCalled();

  // 2. The backoff must be back at rung 0 — the next failure waits 15s, not 30s.
  (panel as { showError(m?: string, r?: () => void): void }).showError('again', () => {});
  expect(countdownText(panel)).toMatch(/\(15s\)/);
}

beforeAll(async () => {
  await initTestI18n();
});

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  document.body.innerHTML = '';
  vi.useRealTimers();
});

describe('ServiceStatusPanel', () => {
  it('clears the countdown and backoff when the service list renders', async () => {
    const panel = new ServiceStatusPanel();
    mount(panel);

    await expectRecoveryClearsRetryState(
      panel,
      () => {
        flags(panel).loading = false;
        flags(panel).error = 'boom';
        (panel as unknown as { render(): void }).render();
      },
      () => {
        flags(panel).error = null;
        (panel as unknown as { render(): void }).render();
      },
    );

    panel.destroy();
  });
});

describe('TechEventsPanel', () => {
  it('clears the countdown and backoff when the events list renders', async () => {
    const fetchEvents = vi
      .spyOn(TechEventsPanel.prototype as unknown as { fetchEvents(): Promise<void> }, 'fetchEvents')
      .mockResolvedValue(undefined);

    const panel = new TechEventsPanel('tech-events');
    mount(panel);
    expect(fetchEvents).toHaveBeenCalled();

    await expectRecoveryClearsRetryState(
      panel,
      () => {
        flags(panel).loading = false;
        flags(panel).error = 'boom';
        (panel as unknown as { render(): void }).render();
      },
      () => {
        flags(panel).error = null;
        (panel as unknown as { render(): void }).render();
      },
    );

    panel.destroy();
  });
});

describe('DefensePatentsPanel', () => {
  it('clears the countdown and backoff when the patents list renders', async () => {
    const fetchPatents = vi
      .spyOn(DefensePatentsPanel.prototype as unknown as { fetchPatents(): Promise<void> }, 'fetchPatents')
      .mockResolvedValue(undefined);

    const panel = new DefensePatentsPanel();
    mount(panel);
    expect(fetchPatents).toHaveBeenCalled();

    await expectRecoveryClearsRetryState(
      panel,
      () => {
        flags(panel).loading = false;
        flags(panel).error = 'boom';
        (panel as unknown as { render(): void }).render();
      },
      () => {
        flags(panel).error = null;
        (panel as unknown as { render(): void }).render();
      },
    );

    panel.destroy();
  });
});

describe('GdeltIntelPanel', () => {
  /**
   * `renderArticles` is the success site for BOTH callers, and only one of them
   * can prove the countdown clears: `loadActiveTopic` opens with `showLoading()`
   * (which drops the countdown but deliberately keeps the backoff), whereas the
   * cached `selectTopic` branch paints straight over a live error state. The
   * case below drives `renderArticles` directly so the pending countdown is
   * still armed when the success write lands — the cached-topic scenario.
   */
  it('clears the countdown and backoff when articles render', async () => {
    mockFetchTopicIntelligence.mockResolvedValue({ articles: [], fetchedAt: new Date() });
    mockFetchTopicTimeline.mockResolvedValue(null);

    const panel = new GdeltIntelPanel();
    mount(panel);
    await vi.advanceTimersByTimeAsync(0);

    await expectRecoveryClearsRetryState(
      panel,
      async () => {
        mockFetchTopicIntelligence.mockRejectedValue(new Error('boom'));
        mockFetchTopicTimeline.mockRejectedValue(new Error('boom'));
        await (panel as unknown as { loadActiveTopic(): Promise<void> }).loadActiveTopic();
      },
      () => {
        (panel as unknown as { renderArticles(a: unknown[]): void }).renderArticles([]);
      },
    );

    panel.destroy();
  });
});

describe('GivingPanel', () => {
  /**
   * Latent, not live: `data-loader.showColdLoadError` reaches this panel as a
   * bare `callPanel('giving', 'showError')` with no retry callback, and the
   * panel never calls `setRetryCallback` — so today `showError` skips the
   * countdown block entirely and nothing latches. This case drives the public
   * `showError(msg, onRetry)` overload to pin the contract for the day a retry
   * callback IS wired in, which is the only reason `setData` needs the full
   * `clearErrorState()` rather than a chip reset.
   */
  it('clears the countdown and backoff when a summary renders', async () => {
    mockAvailableGivingTabs.mockReturnValue(['platforms']);
    mockRenderGivingPanelContent.mockReturnValue('<div class="giving-body"></div>');

    const panel = new GivingPanel();
    mount(panel);

    await expectRecoveryClearsRetryState(
      panel,
      () => {
        panel.showError('boom', () => {});
      },
      () => {
        panel.setData({
          materializedAt: new Date(Date.now() - 60_000).toISOString(),
          platforms: [{ platform: 'Platform 1' }],
        } as unknown as Parameters<GivingPanel['setData']>[0]);
      },
    );

    panel.destroy();
  });
});

/**
 * The inverse half of #6577, and the reason none of the five edits above may be
 * copied onto a loading branch. A SUCCESS render must reset `retryAttempt`; a
 * LOADING render must NOT — otherwise every retry re-arms at the 15s floor and
 * the ladder never climbs toward the 180s cap.
 *
 * Without these two cases the rule lives only in the prose above, so a
 * contributor "fixing" the red chip that lingers during a retry fetch could swap
 * a loading branch onto `clearErrorState()` and defeat exponential backoff with
 * a fully green suite.
 *
 * Both loading shapes are covered because they differ in what else they touch:
 * the raw `replaceChildren` branch clears neither chip nor countdown, while
 * `showLoading()` clears both. Only the rung is asserted, since that is the one
 * property both must share.
 *
 * TechEventsPanel is the vehicle for both because it is one of only two panels
 * in this file whose error path is genuinely reachable in production, so the
 * rung it reports is a real one. Note the asymmetry, though: the first case
 * drives TechEvents' OWN loading branch (the raw `replaceChildren` at
 * TechEventsPanel.ts:71 — the only loading shape it has), while the second calls
 * the inherited `showLoading()` directly. TechEvents never calls `showLoading()`
 * itself; the panels that take that shape are GdeltIntelPanel (:76) and
 * GivingPanel (:28, constructor only). The second case is therefore a
 * base-class contract test riding on a convenient subclass, not a per-call-site
 * test of TechEvents — it pins `Panel.showLoading()` for every panel that uses it.
 */
describe('loading renders preserve the backoff rung', () => {
  function newPanel(): TechEventsPanel {
    vi.spyOn(
      TechEventsPanel.prototype as unknown as { fetchEvents(): Promise<void> },
      'fetchEvents',
    ).mockResolvedValue(undefined);
    const panel = new TechEventsPanel('tech-events');
    mount(panel);
    return panel;
  }

  /** Drive the real error site once: rung 0 is consumed, `retryAttempt` becomes 1. */
  function driveFirstFailure(panel: TechEventsPanel): void {
    flags(panel).loading = false;
    flags(panel).error = 'boom';
    (panel as unknown as { render(): void }).render();
    // Non-vacuity: prove we really are at rung 1 before the loading render, so a
    // later "(30s)" cannot be an accident of the panel never having failed.
    expect(countdownText(panel)).toMatch(/\(15s\)/);
    expect(internals(panel).retryAttempt).toBe(1);
  }

  /** Drive the real error site again; the countdown reports the rung it re-entered at. */
  function driveSecondFailure(panel: TechEventsPanel): string | null {
    flags(panel).loading = false;
    flags(panel).error = 'boom';
    (panel as unknown as { render(): void }).render();
    return countdownText(panel);
  }

  it('keeps the rung across the raw replaceChildren loading branch', () => {
    const panel = newPanel();
    driveFirstFailure(panel);

    flags(panel).loading = true;
    (panel as unknown as { render(): void }).render();

    expect(internals(panel).content.querySelector('.tech-events-loading')).not.toBeNull();

    // 30s, not 15s: the loading render must not have reset the backoff.
    expect(driveSecondFailure(panel)).toMatch(/\(30s\)/);

    panel.destroy();
  });

  it('keeps the rung across showLoading()', () => {
    const panel = newPanel();
    driveFirstFailure(panel);

    panel.showLoading();

    expect(driveSecondFailure(panel)).toMatch(/\(30s\)/);

    panel.destroy();
  });
});
