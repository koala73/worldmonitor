/**
 * #6678 — the five panels #6577 fixed still painted `this.content` themselves.
 * Routing their SUCCESS writes through `Panel.setContentNodes()` /
 * `Panel.setTrustedContent()` is what #6678 finishes, and this file is its proof.
 *
 * The migration is deliberately RUNG-NEUTRAL. Every one of these panels already
 * called `clearErrorState()` on its success path (#6587, `f2b0ef683`), so the
 * chip / countdown / backoff behaviour pinned by
 * `tests/dom/panel-error-latch-6577.test.mts` is unchanged by this migration.
 * That file must stay green throughout; it is not the proof of this change.
 *
 * What the sanctioned helpers ADD over a raw `replaceChildren(this.content, …)`
 * preceded by `clearErrorState()` is exactly three things
 * (`Panel.ts:1287` / `:1298`):
 *   1. a `_locked` bail BEFORE the write,
 *   2. `cancelPendingContentWrite()`,
 *   3. `invalidateCommittedHtml()`.
 *
 * (2) and (3) are unobservable from outside the base class for these five: none
 * of them calls `setSafeContent`, so no debounced write can be pending and
 * `lastCommittedHtml` is never consulted. (1) is observable at every call site
 * and is the one with a user-visible failure mode — a success render landing on
 * a locked panel paints content straight over the upgrade CTA. That is what
 * every case below drives.
 *
 * PER CALL SITE, not once on the base class. `tests/panel-content-write-guard.test.mts`
 * already asserts `Panel.setContentNodes` bails on `_locked`, so a mutation of
 * the bail itself dies there. What that assertion CANNOT see is one panel left
 * behind on `replaceChildren` — which is precisely the state #6678 exists to
 * end. So every migrated write is exercised separately, the same argument
 * `panel-error-latch-6577.test.mts` makes for `clearErrorState()`.
 * See docs/solutions/conventions/mutate-each-call-site-a-global-mutant-hides-per-site-holes.md
 *
 * LATENT, like the #6577 cases, and for the same kind of reason. None of these
 * five keys is in `WEB_PREMIUM_PANELS` (`src/app/panel-layout.ts:126`), so
 * `updatePanelGating` resolves `PanelGateReason.NONE` for them and never gates
 * them today. But `showLocked()` is public API on every `Panel`, and the
 * lazy-registration path (`panel-layout.ts:3396`) locks whatever it is handed.
 * These cases pin the contract at each call site for the day one of these
 * panels becomes premium; they are not evidence a live paywall hole was closed.
 *
 * NON-VACUITY: every case first drives the SAME success write on an UNLOCKED
 * panel and asserts the panel's own markup landed. Without that, a panel whose
 * success render silently no-ops would satisfy the locked assertion for entirely
 * the wrong reason.
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

/** Base-class state these tests reach into. */
interface PanelInternals {
  element: HTMLElement;
  content: HTMLElement;
  retryAttempt: number;
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

function lockedCta(panel: object): Element | null {
  return internals(panel).content.querySelector('.panel-locked-state');
}

/** The countdown line rendered by `showError`, e.g. "Retrying (15s)". */
function countdownText(panel: object): string | null {
  return internals(panel).content.querySelector('.panel-error-countdown')?.textContent ?? null;
}

/**
 * Drive one panel's real success write twice — once unlocked to prove the write
 * is live, once locked to prove it bails — and assert the upgrade CTA survives.
 *
 * `successSelector` must be markup only THIS panel's success branch produces, or
 * the locked assertion could be satisfied by leftovers from another render.
 */
async function expectSuccessWriteRespectsLock(
  panel: object,
  driveSuccess: () => void | Promise<void>,
  successSelector: string,
): Promise<void> {
  // Non-vacuity: unlocked, this write really does paint the panel's content.
  await driveSuccess();
  expect(internals(panel).content.querySelector(successSelector)).not.toBeNull();

  (panel as { showLocked(features?: string[]): void }).showLocked(['Premium feature']);

  // Precondition: the lock really did take the content over.
  expect(lockedCta(panel)).not.toBeNull();
  expect(internals(panel).content.querySelector(successSelector)).toBeNull();

  await driveSuccess();

  // The bail is the whole point. A success write that lands here paints panel
  // content over the upgrade CTA — the paywall hole `setContentNodes` closes.
  expect(lockedCta(panel)).not.toBeNull();
  expect(internals(panel).content.querySelector(successSelector)).toBeNull();
}

beforeAll(async () => {
  await initTestI18n();
});

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('ServiceStatusPanel', () => {
  it('does not paint the service list over a locked panel', async () => {
    const panel = new ServiceStatusPanel();
    mount(panel);

    await expectSuccessWriteRespectsLock(
      panel,
      () => {
        flags(panel).loading = false;
        flags(panel).error = null;
        (panel as unknown as { render(): void }).render();
      },
      '.service-status-summary',
    );

    panel.destroy();
  });
});

describe('TechEventsPanel', () => {
  it('does not paint the events list over a locked panel', async () => {
    vi.spyOn(
      TechEventsPanel.prototype as unknown as { fetchEvents(): Promise<void> },
      'fetchEvents',
    ).mockResolvedValue(undefined);

    const panel = new TechEventsPanel('tech-events');
    mount(panel);

    await expectSuccessWriteRespectsLock(
      panel,
      () => {
        flags(panel).loading = false;
        flags(panel).error = null;
        (panel as unknown as { render(): void }).render();
      },
      '.tech-events-panel',
    );

    panel.destroy();
  });
});

describe('DefensePatentsPanel', () => {
  it('does not paint the patents list over a locked panel', async () => {
    vi.spyOn(
      DefensePatentsPanel.prototype as unknown as { fetchPatents(): Promise<void> },
      'fetchPatents',
    ).mockResolvedValue(undefined);

    const panel = new DefensePatentsPanel();
    mount(panel);

    await expectSuccessWriteRespectsLock(
      panel,
      () => {
        flags(panel).loading = false;
        flags(panel).error = null;
        (panel as unknown as { render(): void }).render();
      },
      '.defense-patents-panel',
    );

    panel.destroy();
  });
});

/**
 * `renderArticles` carries BOTH of GdeltIntelPanel's migrated writes — the
 * empty-state branch and the article-list branch — and the ratchet counted them
 * as two. Each needs its own case, or migrating one and leaving the other would
 * still show green.
 */
describe('GdeltIntelPanel', () => {
  async function newPanel(): Promise<GdeltIntelPanel> {
    mockFetchTopicIntelligence.mockResolvedValue({ articles: [], fetchedAt: new Date() });
    mockFetchTopicTimeline.mockResolvedValue(null);
    const panel = new GdeltIntelPanel();
    mount(panel);
    await vi.advanceTimersByTimeAsync(0);
    return panel;
  }

  it('does not paint the article list over a locked panel', async () => {
    const panel = await newPanel();
    const articles = [{
      url: 'https://example.com/story',
      title: 'Story',
      source: 'example.com',
      date: new Date().toISOString(),
      tone: 0,
    }];

    await expectSuccessWriteRespectsLock(
      panel,
      () => {
        (panel as unknown as { renderArticles(a: unknown[]): void }).renderArticles(articles);
      },
      '.gdelt-intel-articles',
    );

    panel.destroy();
  });

  it('does not paint the empty state over a locked panel', async () => {
    const panel = await newPanel();

    await expectSuccessWriteRespectsLock(
      panel,
      () => {
        (panel as unknown as { renderArticles(a: unknown[]): void }).renderArticles([]);
      },
      '.empty-state',
    );

    panel.destroy();
  });

  /**
   * `renderTopicSummary` is the one write #6678 deliberately did NOT migrate: it
   * inserts a SIBLING before `this.content`, so the wiping helpers would destroy
   * the articles it sits above. Staying off the helper costs the `_locked` bail,
   * and `showLocked` only sweeps siblings once — at lock time — so a summary
   * inserted afterwards would paint above the upgrade CTA. The panel honours the
   * lock by hand instead; this pins that, because nothing else does.
   */
  it('does not show the topic summary over a locked panel', async () => {
    const timeline = {
      tone: [{ value: -2 }, { value: -1 }, { value: 0.5 }],
      vol: [{ value: 10 }, { value: 20 }, { value: 30 }],
    };
    const panel = await newPanel();
    const render = (panel as unknown as { renderTopicSummary(t: unknown): void });
    const summary = () => internals(panel).element.querySelector<HTMLElement>('.gdelt-topic-summary');

    // Non-vacuity: unlocked, this timeline really does paint a visible summary.
    render.renderTopicSummary(timeline);
    expect(summary()).not.toBeNull();
    expect(summary()!.style.display).not.toBe('none');

    (panel as unknown as { showLocked(f?: string[]): void }).showLocked(['Premium feature']);
    expect(lockedCta(panel)).not.toBeNull();

    // A refresh landing while locked must not paint a sparkline over the CTA.
    render.renderTopicSummary(timeline);
    expect(summary()?.style.display).toBe('none');

    // ...and unlocking must not strand it hidden.
    (panel as unknown as { unlockPanel(): void }).unlockPanel();
    expect(summary()!.style.display).not.toBe('none');

    panel.destroy();
  });
});

/**
 * The hazard #6678 CREATES, and the reason these two cases live here rather
 * than beside the success cases above.
 *
 * After this migration, ServiceStatus / TechEvents / DefensePatents each have
 * exactly ONE `replaceChildren(this.content, …)` left, and it is the loading
 * branch — so their ratchet entries read `x1`. The inventory's own rule ("a pair
 * that shrank or vanished MUST be updated here") reads like an invitation to
 * drive that last one to zero. Doing so would route a LOADING render through
 * `setContentNodes`, whose `clearErrorState()` resets `retryAttempt`, and every
 * retry would re-arm at the 15s floor instead of climbing toward the 180s cap.
 *
 * `tests/dom/panel-error-latch-6577.test.mts` already pins this — but only for
 * TechEventsPanel, and that file says so itself: its loading block is "a
 * base-class contract test riding on a convenient subclass, not a per-call-site
 * test". Before #6678 that was proportionate. Now that the loading branch is the
 * only write left in all three, the other two need their own case, or migrating
 * ServiceStatusPanel's or DefensePatentsPanel's loading branch ships green.
 */
describe('loading branches keep the backoff rung after the success migration', () => {
  /** Drive the real error site once: rung 0 is consumed, `retryAttempt` becomes 1. */
  function driveFirstFailure(panel: object): void {
    flags(panel).loading = false;
    flags(panel).error = 'boom';
    (panel as unknown as { render(): void }).render();
    // Non-vacuity: prove we really are at rung 1 before the loading render, so a
    // later "(30s)" cannot be an accident of the panel never having failed.
    expect(countdownText(panel)).toMatch(/\(15s\)/);
    expect(internals(panel).retryAttempt).toBe(1);
  }

  /** Drive the real error site again; the countdown reports the rung it re-entered at. */
  function driveSecondFailure(panel: object): string | null {
    flags(panel).loading = false;
    flags(panel).error = 'boom';
    (panel as unknown as { render(): void }).render();
    return countdownText(panel);
  }

  /**
   * `loadingSelector` is non-vacuity, not decoration: without it, DELETING the
   * loading branch outright leaves both cases below green — the rung would
   * survive a render that painted nothing at all, which is not the invariant.
   */
  function driveLoading(panel: object, loadingSelector: string): void {
    flags(panel).loading = true;
    (panel as unknown as { render(): void }).render();
    expect(internals(panel).content.querySelector(loadingSelector)).not.toBeNull();
  }

  it('ServiceStatusPanel keeps the rung across its loading render', () => {
    const panel = new ServiceStatusPanel();
    mount(panel);

    driveFirstFailure(panel);
    driveLoading(panel, '.service-status-loading');

    // 30s, not 15s: the loading render must not have reset the backoff.
    expect(driveSecondFailure(panel)).toMatch(/\(30s\)/);

    panel.destroy();
  });

  it('DefensePatentsPanel keeps the rung across its loading render', () => {
    vi.spyOn(
      DefensePatentsPanel.prototype as unknown as { fetchPatents(): Promise<void> },
      'fetchPatents',
    ).mockResolvedValue(undefined);

    const panel = new DefensePatentsPanel();
    mount(panel);

    driveFirstFailure(panel);
    driveLoading(panel, '.defense-patents-loading');

    expect(driveSecondFailure(panel)).toMatch(/\(30s\)/);

    panel.destroy();
  });
});

/**
 * GivingPanel is the `setTrustedContent` case — it builds its own markup string
 * through `giving-renderer` rather than DOM nodes, so it is the only one of the
 * five that cannot use `setContentNodes`.
 */
describe('GivingPanel', () => {
  it('does not paint the summary over a locked panel', async () => {
    mockAvailableGivingTabs.mockReturnValue(['platforms']);
    mockRenderGivingPanelContent.mockReturnValue('<div class="giving-body"></div>');

    const panel = new GivingPanel();
    mount(panel);

    await expectSuccessWriteRespectsLock(
      panel,
      () => {
        panel.setData({
          materializedAt: new Date(Date.now() - 60_000).toISOString(),
          platforms: [{ platform: 'Platform 1' }],
        } as unknown as Parameters<GivingPanel['setData']>[0]);
      },
      '.giving-body',
    );

    panel.destroy();
  });
});

// ── #6714: a locked panel's success render must still clear the error state ──
//
// The helpers bail on _locked before any WRITE (pinned above), but the
// error-state clear now runs ahead of the bail: clearing the chip and the
// backoff rung paints nothing, so it cannot reopen the paywall hole. Before
// #6714 the bail came first, so a fail -> lock -> recover sequence left a red
// header over the lock CTA and a stale retryAttempt rung after unlock.
describe('locked-panel error-state clear (#6714)', () => {
  it('clears the error chip and backoff rung even though the success write bails', async () => {
    vi.spyOn(
      TechEventsPanel.prototype as unknown as { fetchEvents(): Promise<void> },
      'fetchEvents',
    ).mockResolvedValue(undefined);

    const panel = new TechEventsPanel('tech-events');
    mount(panel);

    // 1. Fail: paint the error state and climb the backoff ladder.
    flags(panel).loading = false;
    flags(panel).error = 'source down';
    (panel as unknown as { render(): void }).render();
    expect(countdownText(panel), 'precondition: the error state is visible').not.toBeNull();
    expect(internals(panel).retryAttempt, 'precondition: the backoff rung advanced').toBeGreaterThan(0);

    // 2. Lock the panel (the fail -> lock half of the sequence).
    panel.showLocked(['Premium feature']);
    expect(lockedCta(panel)).not.toBeNull();

    // 3. The source recovers and the success write lands — it must bail
    //    (CTA survives) yet still clear the error state.
    flags(panel).loading = false;
    flags(panel).error = null;
    (panel as unknown as { render(): void }).render();

    expect(lockedCta(panel), 'the write still bails on the lock').not.toBeNull();
    expect(internals(panel).retryAttempt, 'the backoff rung is cleared, not stranded').toBe(0);
    expect(countdownText(panel), 'the error chip is cleared, not latched over the CTA').toBeNull();

    panel.destroy();
  });

  it('isLocked is the base-class accessor, not a class-name proxy', () => {
    // The accessor exists so positional writers (GdeltIntelPanel's summary
    // hide) can honour the lock without mirroring private state through
    // classList. Reading it before/after showLocked pins the contract.
    const panel = new ServiceStatusPanel();
    mount(panel);
    expect((panel as unknown as { isLocked: boolean }).isLocked).toBe(false);
    panel.showLocked(['Premium feature']);
    expect((panel as unknown as { isLocked: boolean }).isLocked).toBe(true);
    panel.unlockPanel();
    expect((panel as unknown as { isLocked: boolean }).isLocked).toBe(false);
    panel.destroy();
  });
});
