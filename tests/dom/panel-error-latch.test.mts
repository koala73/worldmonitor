/**
 * Panel error-chip latch — DOM regression coverage (#6557).
 *
 * `Panel.showError()` sets three pieces of error state: the red `Error` chip on
 * the header (`panel-header-error`), a ticking auto-retry countdown, and the
 * exponential backoff counter. Only `setContentHtml()` (reached via
 * `setSafeContent`) drops all three on a successful render.
 *
 * Panels that paint their own DOM — `replaceChildren(this.content, …)` or
 * `setTrustedHtml(this.content, …)` — bypass that entirely. In production this
 * showed as `cii` and `strategic-risk` rendering a full, correct dataset under
 * a red `Error` chip that survived every later render for the rest of the
 * session.
 *
 * The cases below drive the REAL panels through the REAL recovery path: paint a
 * success render after `showError()` and require the chip, the countdown and
 * the backoff to be gone. A test that only asserted the chip would miss the
 * still-ticking countdown, which fires one redundant refresh per latched panel.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { Panel } from '@/components/Panel';
import { CascadePanel } from '@/components/CascadePanel';
import { CIIPanel } from '@/components/CIIPanel';
import { StrategicRiskPanel } from '@/components/StrategicRiskPanel';
import { WM_FOLLOWED_COUNTRIES_CHANGED } from '@/services/followed-countries';
import type { CachedRiskScores } from '@/services/cached-risk-scores';
import { h, trustedHtml } from '@/utils/dom-utils';
import { unsafeRawHtml } from '@/utils/sanitize';

import { initTestI18n } from './helpers/i18n.mts';

beforeAll(async () => {
  await initTestI18n();
});

/** The three pieces of state `showError()` sets, read off a live panel. */
interface PanelErrorInternals {
  element: HTMLElement;
  header: HTMLElement;
  content: HTMLElement;
  retryAttempt: number;
  retryCountdownTimer: ReturnType<typeof setInterval> | null;
}

function internals(panel: Panel): PanelErrorInternals {
  return panel as unknown as PanelErrorInternals;
}

function hasErrorChip(panel: Panel): boolean {
  return internals(panel).header.classList.contains('panel-header-error');
}

function cachedScores(): CachedRiskScores {
  return {
    cii: [
      {
        code: 'UA',
        name: 'Ukraine',
        score: 90,
        level: 'critical',
        trend: 'rising',
        change24h: 3,
        components: { unrest: 80, conflict: 95, security: 90, information: 70 },
        lastUpdated: '2026-08-13T00:00:00.000Z',
      },
      {
        code: 'RU',
        name: 'Russia',
        score: 80,
        level: 'high',
        trend: 'rising',
        change24h: 6,
        components: { unrest: 70, conflict: 85, security: 80, information: 75 },
        lastUpdated: '2026-08-13T00:00:00.000Z',
      },
    ],
    strategicRisk: {
      score: 71,
      level: 'high',
      trend: 'stable',
      lastUpdated: '2026-08-13T00:00:00.000Z',
      contributors: [{ country: 'Ukraine', code: 'UA', score: 90, level: 'critical' }],
    },
    protestCount: 0,
    computedAt: '2026-08-13T00:00:00.000Z',
    cached: true,
    degraded: false,
    stale: false,
  };
}

describe('Panel error state is cleared by direct-write content renders', () => {
  let panel: Panel;

  beforeEach(() => {
    vi.useFakeTimers();
    panel = new Panel({ id: 'error-latch-probe', title: 'Probe' });
    document.body.appendChild(internals(panel).element);
  });

  afterEach(() => {
    panel.destroy();
    document.body.innerHTML = '';
    vi.useRealTimers();
  });

  it('showError latches the chip, the countdown and the backoff', () => {
    const retry = vi.fn();
    panel.showError('boom', retry, 30);

    expect(hasErrorChip(panel)).toBe(true);
    expect(internals(panel).retryCountdownTimer).not.toBeNull();
    expect(internals(panel).retryAttempt).toBe(1);
  });

  it('clears all three when a node render commits through setContentNodes', () => {
    const retry = vi.fn();
    panel.showError('boom', retry, 30);

    (panel as unknown as { setContentNodes: (...c: unknown[]) => void })
      .setContentNodes(h('div', { className: 'recovered' }, 'real data'));

    expect(hasErrorChip(panel)).toBe(false);
    expect(internals(panel).retryCountdownTimer).toBeNull();
    expect(internals(panel).retryAttempt).toBe(0);
    expect(internals(panel).content.querySelector('.recovered')).not.toBeNull();

    // The recovered panel must not fire the retry the failed load scheduled.
    vi.advanceTimersByTime(60_000);
    expect(retry).not.toHaveBeenCalled();
  });

  it('clears all three when a trusted-HTML render commits through setTrustedContent', () => {
    const retry = vi.fn();
    panel.showError('boom', retry, 30);

    (panel as unknown as { setTrustedContent: (html: unknown) => void })
      .setTrustedContent(trustedHtml('<div class="recovered">real data</div>', 'test fixture'));

    expect(hasErrorChip(panel)).toBe(false);
    expect(internals(panel).retryCountdownTimer).toBeNull();
    expect(internals(panel).retryAttempt).toBe(0);
    expect(internals(panel).content.querySelector('.recovered')).not.toBeNull();

    vi.advanceTimersByTime(60_000);
    expect(retry).not.toHaveBeenCalled();
  });

  it('showRetrying is cleared by a recovery render too', () => {
    // showRetrying sets the same chip as showError and is the entry point a
    // dozen other panels use for the same failure class.
    panel.showRetrying('retrying', 30);
    expect(hasErrorChip(panel)).toBe(true);

    (panel as unknown as { setContentNodes: (...c: unknown[]) => void })
      .setContentNodes(h('div', { className: 'recovered' }, 'real data'));

    expect(hasErrorChip(panel)).toBe(false);
    expect(internals(panel).retryCountdownTimer).toBeNull();
  });

  it('re-latches on a second failure and clears again on the next recovery', () => {
    const retry = vi.fn();
    const commit = (panel as unknown as { setContentNodes: (...c: unknown[]) => void });

    panel.showError('boom', retry, 30);
    commit.setContentNodes(h('div', { className: 'recovered' }, 'real data'));
    expect(hasErrorChip(panel)).toBe(false);

    // A recovered panel must still be able to report the NEXT failure — a fix
    // that cleared the chip permanently would also pass the tests above.
    panel.showError('boom again', retry, 30);
    expect(hasErrorChip(panel)).toBe(true);

    commit.setContentNodes(h('div', { className: 'recovered' }, 'real data again'));
    expect(hasErrorChip(panel)).toBe(false);
    expect(internals(panel).retryAttempt).toBe(0);
  });

  it('a loading render does NOT reset the backoff ladder', () => {
    // The invariant that justifies the seam: `showLoading` clears the chip and
    // countdown but deliberately leaves `retryAttempt` alone, so the backoff
    // keeps climbing across a failing source's retries. Moving the clear into
    // `replaceContent()` — the fix #6557 originally proposed — would flatten
    // the ladder here while every other case in this file stayed green.
    const retry = vi.fn();
    panel.showError('boom', retry, 30);
    panel.showError('boom', retry, 30);
    expect(internals(panel).retryAttempt).toBe(2);

    panel.showLoading('loading');

    expect(hasErrorChip(panel)).toBe(false);
    expect(internals(panel).retryCountdownTimer).toBeNull();
    expect(internals(panel).retryAttempt).toBe(2);
  });

  it('an immediate render cancels a debounced write still in flight', () => {
    // setSafeContent commits 150ms late. Without cancelling it, the queued
    // string lands AFTER the node render and overwrites the recovered DOM —
    // the panel looks correct, then silently reverts a tick later.
    panel.setSafeContent(unsafeRawHtml('<div class="stale">stale</div>', 'test fixture'));

    (panel as unknown as { setContentNodes: (...c: unknown[]) => void })
      .setContentNodes(h('div', { className: 'recovered' }, 'real data'));
    expect(internals(panel).content.querySelector('.recovered')).not.toBeNull();

    vi.advanceTimersByTime(500);

    expect(internals(panel).content.querySelector('.stale')).toBeNull();
    expect(internals(panel).content.querySelector('.recovered')).not.toBeNull();
  });

  it('a trusted-HTML render cancels a debounced write still in flight', () => {
    // The twin of the case above. setContentNodes and setTrustedContent are
    // documented as true twins, but only the node half had a debounce-race
    // test — deleting cancelPendingContentWrite() from setTrustedContent alone
    // passed the entire suite.
    panel.setSafeContent(unsafeRawHtml('<div class="stale">stale</div>', 'test fixture'));

    (panel as unknown as { setTrustedContent: (html: unknown) => void })
      .setTrustedContent(trustedHtml('<div class="recovered">real data</div>', 'test fixture'));
    expect(internals(panel).content.querySelector('.recovered')).not.toBeNull();

    vi.advanceTimersByTime(500);

    expect(internals(panel).content.querySelector('.stale')).toBeNull();
    expect(internals(panel).content.querySelector('.recovered')).not.toBeNull();
  });

  it('showError is not overwritten by a debounced write queued before it', () => {
    // The #6557 symptom reached from the other direction. showError paints
    // through replaceContent, which did not cancel the pending write, so the
    // queued data HTML committed 150ms later OVER the error DOM while the chip
    // stayed set — correct-looking data under a red chip nothing clears.
    panel.setSafeContent(unsafeRawHtml('<div class="stale">stale data</div>', 'test fixture'));

    panel.showError('boom', vi.fn(), 30);
    expect(internals(panel).content.querySelector('.panel-error-state')).not.toBeNull();

    vi.advanceTimersByTime(500);

    expect(internals(panel).content.querySelector('.stale')).toBeNull();
    expect(internals(panel).content.querySelector('.panel-error-state')).not.toBeNull();
    expect(hasErrorChip(panel)).toBe(true);
  });

  it('a lock landing during the debounce window does not leak the payload', () => {
    // The paywall half of the same seam: setContentImmediate is the one
    // immediate write with no _locked bail, so a write queued just before
    // showGatedCta/showLocked painted premium markup over the upgrade CTA and
    // was never repainted, because every other writer bails while locked.
    panel.setSafeContent(unsafeRawHtml('<div class="premium-payload">paid</div>', 'test fixture'));

    panel.showLocked(['probe feature']);
    expect(internals(panel).content.querySelector('.panel-locked-state')).not.toBeNull();

    vi.advanceTimersByTime(500);

    expect(internals(panel).content.querySelector('.premium-payload')).toBeNull();
    expect(internals(panel).content.querySelector('.panel-locked-state')).not.toBeNull();
  });

  it('the debounced commit itself refuses to write to a locked panel', () => {
    // Pins setContentImmediate's own _locked bail rather than the caller-side
    // cancel. Every lock path today repaints through replaceContent, which now
    // cancels the pending write, so the lock-during-debounce case above passes
    // with or without this guard — it would be an unpinned, unobservable
    // guarantee. Here the lock is set WITHOUT a repaint, which is the shape a
    // future gating path that only toggles state would take.
    panel.setSafeContent(unsafeRawHtml('<div class="premium-payload">paid</div>', 'test fixture'));
    (panel as unknown as { _locked: boolean })._locked = true;

    vi.advanceTimersByTime(500);

    expect(internals(panel).content.querySelector('.premium-payload')).toBeNull();
  });

  it('a locked panel is not painted over by either helper', () => {
    // The helpers are advertised as twins of setSafeContent, which bails while
    // locked. Without the same bail, a gated panel migrating onto them would
    // paint premium content over its upgrade CTA.
    panel.showLocked(['probe feature']);
    expect(internals(panel).content.querySelector('.panel-locked-state')).not.toBeNull();

    (panel as unknown as { setContentNodes: (...c: unknown[]) => void })
      .setContentNodes(h('div', { className: 'premium-payload' }, 'paid data'));
    (panel as unknown as { setTrustedContent: (html: unknown) => void })
      .setTrustedContent(trustedHtml('<div class="premium-payload">paid data</div>', 'test fixture'));

    expect(internals(panel).content.querySelector('.premium-payload')).toBeNull();
    expect(internals(panel).content.querySelector('.panel-locked-state')).not.toBeNull();
  });
});

describe('CIIPanel recovery renders clear the error chip', () => {
  let panel: CIIPanel;

  beforeEach(() => {
    vi.useFakeTimers();
    panel = new CIIPanel();
    document.body.appendChild(internals(panel).element);
  });

  afterEach(() => {
    panel.destroy();
    document.body.innerHTML = '';
    vi.useRealTimers();
  });

  it('renderFromCached clears the chip left by a transient showError', () => {
    panel.showError('boom', vi.fn(), 30);
    expect(hasErrorChip(panel)).toBe(true);

    panel.renderFromCached(cachedScores());

    expect(hasErrorChip(panel)).toBe(false);
    expect(internals(panel).retryCountdownTimer).toBeNull();
    expect(internals(panel).retryAttempt).toBe(0);
    expect(internals(panel).content.querySelectorAll('.cii-country')).toHaveLength(2);
  });

  it('country drill-in is on the name, not the row that wraps Follow/Share', () => {
    panel.renderFromCached(cachedScores());
    const row = internals(panel).content.querySelector('.cii-country');
    expect(row).not.toBeNull();
    expect(row?.getAttribute('role')).toBeNull();
    expect(row?.getAttribute('tabindex')).toBeNull();
    const name = row?.querySelector('.cii-name');
    expect(name?.getAttribute('role')).toBe('button');
    expect(name?.getAttribute('tabindex')).toBe('0');
    expect(row?.querySelector('.cii-share-btn')?.tagName).toBe('BUTTON');
  });

  it('a watchlist re-render clears the chip left by a transient showError', () => {
    // Seed scores so the watchlist subscription has rows to repaint.
    panel.renderFromCached(cachedScores());
    panel.showError('boom', vi.fn(), 30);
    expect(hasErrorChip(panel)).toBe(true);

    // The production trigger: a follow/unfollow (or a cross-tab storage event)
    // repaints the rows straight into `this.content`, over the error state.
    window.dispatchEvent(new CustomEvent(WM_FOLLOWED_COUNTRIES_CHANGED));

    expect(internals(panel).content.querySelectorAll('.cii-country')).toHaveLength(2);
    expect(hasErrorChip(panel)).toBe(false);
    expect(internals(panel).retryCountdownTimer).toBeNull();
    expect(internals(panel).retryAttempt).toBe(0);
  });

  it('renderUnavailable clears the chip', () => {
    panel.showError('boom', vi.fn(), 30);

    panel.renderUnavailable();

    expect(hasErrorChip(panel)).toBe(false);
    expect(internals(panel).retryCountdownTimer).toBeNull();
  });
});

describe('StrategicRiskPanel recovery render clears the error chip', () => {
  let panel: StrategicRiskPanel;

  beforeEach(() => {
    vi.useFakeTimers();
    // A real Panel supplies the real header/content DOM and error state; the
    // prototype swap gives it StrategicRiskPanel's real `render()` without
    // running the constructor's async init (network + document listeners).
    const base = new Panel({ id: 'strategic-risk', title: 'Strategic Risk Overview' });
    Object.setPrototypeOf(base, StrategicRiskPanel.prototype);
    panel = base as StrategicRiskPanel;
    Object.assign(panel, {
      overview: {
        convergenceAlerts: 0,
        avgCIIDeviation: 90,
        infrastructureIncidents: 0,
        compositeScore: 71,
        trend: 'stable',
        topRisks: [],
        topConvergenceZones: [],
        unstableCountries: [],
        timestamp: new Date('2026-08-13T00:00:00.000Z'),
        degraded: false,
        stale: false,
      },
      alerts: [],
      convergenceAlerts: [],
      breakingAlerts: new Map(),
      breakingExpiryTimer: null,
    });
    document.body.appendChild(internals(panel).element);
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.useRealTimers();
  });

  it('render() clears the chip left by a transient showError', () => {
    panel.showError('boom', vi.fn(), 30);
    expect(hasErrorChip(panel)).toBe(true);

    (panel as unknown as { render: () => void }).render();

    expect(internals(panel).content.querySelector('.strategic-risk-panel')).not.toBeNull();
    expect(hasErrorChip(panel)).toBe(false);
    expect(internals(panel).retryCountdownTimer).toBeNull();
    expect(internals(panel).retryAttempt).toBe(0);
  });
});

describe('CascadePanel recovery render clears the error chip', () => {
  let panel: CascadePanel;

  beforeEach(() => {
    vi.useFakeTimers();
    // Same prototype swap as Strategic Risk. Proving `setTrustedContent` clears
    // does not prove THIS call site is wired to it, so drive the real render().
    const base = new Panel({ id: 'cascade', title: 'Infrastructure Cascade' });
    Object.setPrototypeOf(base, CascadePanel.prototype);
    panel = base as CascadePanel;
    Object.assign(panel, {
      graph: { nodes: new Map(), edges: new Map() },
      selectedNode: null,
      cascadeResult: null,
      filter: 'cable',
    });
    document.body.appendChild(internals(panel).element);
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.useRealTimers();
  });

  it('render() clears the chip left by a transient showError', () => {
    panel.showError('boom', vi.fn(), 30);
    expect(hasErrorChip(panel)).toBe(true);

    (panel as unknown as { render: () => void }).render();

    expect(internals(panel).content.querySelector('.cascade-panel')).not.toBeNull();
    expect(hasErrorChip(panel)).toBe(false);
    expect(internals(panel).retryCountdownTimer).toBeNull();
    expect(internals(panel).retryAttempt).toBe(0);
  });

  it("init()'s failure arms a retry, so the recovery render is reachable", () => {
    // Without an onRetry, Panel.showError leaves retryCallback null and arms no
    // countdown — and nothing else re-renders this panel: the error DOM carries
    // none of the controls setupDelegatedListeners binds, and refresh() has no
    // callers. The clear above was unreachable in the real failure, so the
    // wiring test passed while production stayed dead for the session.
    const init = vi.fn();
    panel.showError('boom', () => void init(), 30);

    expect(hasErrorChip(panel)).toBe(true);
    expect(internals(panel).retryCountdownTimer).not.toBeNull();

    vi.advanceTimersByTime(31_000);
    expect(init).toHaveBeenCalled();
  });
});
