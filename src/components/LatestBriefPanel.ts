/**
 * LatestBriefPanel — dashboard surface for the WorldMonitor Brief.
 *
 * Reads `/api/latest-brief` and renders one of three states:
 *
 *   - ready      → cover-card thumbnail + greeting + thread count +
 *                  "Read brief →" CTA that opens the signed magazine
 *                  URL in a new tab.
 *   - composing  → soft empty state. The composer hasn't produced
 *                  today's brief yet; the panel auto-refreshes on
 *                  the next user-visible interaction.
 *   - locked     → the PRO gate (ANONYMOUS or FREE_TIER) is
 *                  handled by the base Panel class via the
 *                  premium-locked-content pattern — the panel itself
 *                  is marked premium and the base draws the overlay.
 *
 * The signed URL is generated server-side in `api/latest-brief.ts`
 * so the token never lives in the client bundle. The panel only
 * displays + links to it.
 */

import { Panel } from './Panel';
import { getClerkToken, clearClerkTokenCache } from '@/services/clerk';
import { PanelGateReason, hasPremiumAccess } from '@/services/panel-gating';
import { getAuthState, subscribeAuthState } from '@/services/auth-state';
import { hasTier, getEntitlementState } from '@/services/entitlements';
import { h, rawHtml, replaceChildren, clearChildren } from '@/utils/dom-utils';

interface LatestBriefReady {
  status: 'ready';
  issueDate: string;
  dateLong: string;
  greeting: string;
  threadCount: number;
  magazineUrl: string;
}

interface LatestBriefComposing {
  status: 'composing';
  issueDate: string;
}

type LatestBriefResponse = LatestBriefReady | LatestBriefComposing;

/**
 * Typed access-failure surface. Lets the refresh loop branch on the
 * specific condition (sign-in / upgrade) instead of retrying as if
 * the error were transient.
 */
class BriefAccessError extends Error {
  readonly code: 'sign_in_required' | 'upgrade_required';
  constructor(code: BriefAccessError['code']) {
    super(code);
    this.code = code;
    this.name = 'BriefAccessError';
  }
}

const LATEST_BRIEF_ENDPOINT = '/api/latest-brief';

const WM_LOGO_SVG = (
  '<svg viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="2" '
  + 'stroke-linecap="round" aria-hidden="true">'
  + '<circle cx="32" cy="32" r="28"/>'
  + '<ellipse cx="32" cy="32" rx="5" ry="28"/>'
  + '<ellipse cx="32" cy="32" rx="14" ry="28"/>'
  + '<ellipse cx="32" cy="32" rx="22" ry="28"/>'
  + '<ellipse cx="32" cy="32" rx="28" ry="5"/>'
  + '<ellipse cx="32" cy="32" rx="28" ry="14"/>'
  + '<path d="M 6 32 L 20 32 L 24 24 L 30 40 L 36 22 L 42 38 L 46 32 L 56 32" stroke-width="2.4"/>'
  + '<circle cx="57" cy="32" r="1.8" fill="currentColor" stroke="none"/>'
  + '</svg>'
);

// Composing-state poll interval. 60s balances "responsive when the
// composer finishes between digest ticks" against "don't hammer
// Upstash with 401-path checks from backgrounded tabs".
const COMPOSING_POLL_MS = 60_000;

export class LatestBriefPanel extends Panel {
  private refreshing = false;
  private refreshQueued = false;
  /**
   * Local mirror of Panel base `_locked`. The base doesn't expose a
   * getter, so we track transitions by overriding showGatedCta() +
   * unlockPanel() below. The flag lets renderReady/renderComposing
   * detect a downgrade-while-fetching race and abort the render
   * even if abort() on the fetch signal was too late.
   */
  private gateLocked = false;
  private inflightAbort: AbortController | null = null;
  private composingPollId: ReturnType<typeof setTimeout> | null = null;
  private unsubscribeAuth: (() => void) | null = null;
  private onVisibility: (() => void) | null = null;
  /** Last Clerk user-id seen. Used to detect sign-in / sign-out transitions. */
  private lastUserId: string | null = null;

  constructor() {
    super({
      id: 'latest-brief',
      title: 'Latest Brief',
      infoTooltip:
        "Your personalised daily editorial magazine. One brief per day, assembled from the news-intelligence layer and delivered via email, Telegram, Slack, and here.",
      // premium: 'locked' marks this as PRO-gated. The base Panel
      // handles the ANONYMOUS + FREE_TIER overlay via
      // panel-gating.ts's getPanelGateReason. No story content,
      // headline, or greeting leaks through DOM attributes on the
      // locked state — the base renders a generic "Upgrade to Pro"
      // card without touching our `content` element.
      premium: 'locked',
    });

    this.renderLoading();
    this.lastUserId = getAuthState().user?.id ?? null;
    // Refresh on ANY auth-id transition:
    //   null → id      : sign-in, load brief
    //   idA → idB      : account switch, load new user's brief
    //   id → null      : sign-out, abort + render sign-in CTA
    //                    (hasPremiumAccess may still be true via
    //                    desktop/tester key, so the layout-level
    //                    updatePanelGating won't re-lock us — we
    //                    must clear state ourselves)
    this.unsubscribeAuth = subscribeAuthState((state) => {
      const nextId = state.user?.id ?? null;
      if (nextId === this.lastUserId) return;
      this.lastUserId = nextId;
      this.inflightAbort?.abort();
      this.inflightAbort = null;
      this.clearComposingPoll();
      // The Clerk token cache is keyed by time, not user. On every
      // id transition we MUST drop it so the next fetch reflects
      // the new session. Without this, /api/latest-brief derives
      // userId from the stale token's sub claim and paints the
      // previous user's brief in the new session for up to 50s.
      clearClerkTokenCache();
      // Referral cache is self-invalidating: src/services/referral.ts
      // subscribes to auth-state at module load and drops its cache on
      // any id transition. No explicit call needed from the panel.
      if (nextId) {
        void this.refresh();
      } else {
        // Sign-out. Don't leave the previous user's content on
        // screen even when premium keys keep the panel unlocked.
        this.renderSignInRequired();
      }
    });
    // visibilitychange drives a refresh when the user returns to
    // the tab. Addresses the "composing → stays composing forever"
    // case where the composer completed while the tab was hidden.
    this.onVisibility = () => {
      if (document.visibilityState === 'visible') void this.refresh();
    };
    document.addEventListener('visibilitychange', this.onVisibility);
    void this.refresh();
  }

  /**
   * Called by the dashboard when the panel first mounts or is
   * revisited. A refresh while one is already in flight queues a
   * single follow-up pass instead of being silently dropped — the
   * user-facing state always reflects the most recent intent
   * (e.g. retry after error, fresh fetch after a visibility change).
   *
   * Entitlement is checked THREE times to close the downgrade-
   * mid-fetch leak: before starting, on AbortController signal, and
   * again after the response resolves. All three are required — a
   * user can sign out between any two of them.
   */
  public async refresh(): Promise<void> {
    if (this.refreshing) {
      this.refreshQueued = true;
      return;
    }
    this.clearComposingPoll();
    // Check #1: gate before starting.
    const authState = getAuthState();
    if (this.gateLocked || !hasPremiumAccess(authState)) return;
    // Per-user endpoint needs a Clerk userId. Desktop API key +
    // browser tester keys satisfy hasPremiumAccess but don't bind
    // to a Clerk user, so there's nothing to fetch.
    const requestUserId = authState.user?.id ?? null;
    if (!requestUserId) {
      this.renderSignInRequired();
      return;
    }
    // Client-side entitlement is NOT authoritative. /api/latest-brief
    // does its own server-side entitlement check against the Clerk
    // JWT — that IS the source of truth. We only use the client
    // snapshot for AFFIRMATIVE DENIAL: skip the doomed fetch when
    // we KNOW the user is free. If the snapshot is missing, stale,
    // or the Convex subscription failed to establish, we fall
    // through and let the server decide. The server's 403 response
    // is translated to renderUpgradeRequired() in the catch block
    // below (via BriefAccessError).
    //
    // Consequence: an API-key-only user with a free Clerk account
    // will fire one doomed fetch per refresh and see the upgrade
    // CTA a beat later than they would with a client-side gate.
    // Accepted — the alternative (trusting the client snapshot as
    // a gate) locked legitimate Pro users out whenever the Convex
    // entitlement subscription was skipped or failed, which is a
    // worse failure mode.
    if (getEntitlementState() !== null && !hasTier(1)) {
      this.renderUpgradeRequired();
      return;
    }
    this.refreshing = true;
    const controller = new AbortController();
    this.inflightAbort = controller;
    try {
      const data = await this.fetchLatest(controller.signal);
      // Check #3 (post-response): verify we're still on the SAME
      // user AND still unlocked. A Clerk account switch during the
      // await (A→B) would otherwise paint user A's brief into user
      // B's session because getClerkToken caches for up to 50s
      // across account changes.
      if (this.gateLocked || !hasPremiumAccess(getAuthState())) return;
      if ((getAuthState().user?.id ?? null) !== requestUserId) return;
      if (data.status === 'ready') {
        this.renderReady(data);
      } else {
        this.renderComposing(data);
      }
    } catch (err) {
      // AbortError comes from showGatedCta's abort() → render nothing.
      if ((err as { name?: string } | null)?.name === 'AbortError') return;
      if (this.gateLocked || !hasPremiumAccess(getAuthState())) return;
      if ((getAuthState().user?.id ?? null) !== requestUserId) return;
      // Structured access errors render a terminal CTA, not a retry
      // error — retrying a 401 or 403 can't flip the outcome.
      if (err instanceof BriefAccessError) {
        if (err.code === 'sign_in_required') this.renderSignInRequired();
        else this.renderUpgradeRequired();
        return;
      }
      const message = err instanceof Error ? err.message : 'Brief unavailable — try again shortly.';
      this.showError(message, () => { void this.refresh(); });
    } finally {
      this.refreshing = false;
      this.inflightAbort = null;
      if (this.refreshQueued) {
        this.refreshQueued = false;
        void this.refresh();
      }
    }
  }

  /**
   * Override to abort any in-flight fetch so the response can't
   * overwrite the locked CTA after it's painted. Check #2 in the
   * three-gate sequence above.
   */
  public override showGatedCta(reason: PanelGateReason, onAction: () => void): void {
    this.gateLocked = true;
    this.inflightAbort?.abort();
    this.inflightAbort = null;
    this.clearComposingPoll();
    super.showGatedCta(reason, onAction);
  }

  /**
   * Override to catch the unlock transition. `updatePanelGating`
   * calls this when a user upgrades (free/anon → PRO). The base
   * clears locked content but leaves us empty — without this
   * override the panel stays blank until page reload. Trigger a
   * fresh fetch on transition.
   */
  public override unlockPanel(): void {
    const wasLocked = this.gateLocked;
    this.gateLocked = false;
    super.unlockPanel();
    if (wasLocked) {
      this.renderLoading();
      void this.refresh();
    }
  }

  private async fetchLatest(signal: AbortSignal): Promise<LatestBriefResponse> {
    // /api/latest-brief is user-scoped and Bearer-only. premiumFetch
    // short-circuits on desktop WORLDMONITOR_API_KEY / tester keys
    // and never sends Clerk, producing a 401 we can't recover from.
    // Always mint a fresh Bearer here — the refresh() pre-check
    // guaranteed authState.user exists.
    const token = await getClerkToken();
    if (!token) {
      // Clerk token evicted between the pre-check and now (logout,
      // cache expiry + Clerk session gone). Surface as sign-in.
      throw new Error('Sign in to view your brief.');
    }
    const res = await fetch(LATEST_BRIEF_ENDPOINT, {
      signal,
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status === 401) {
      throw new BriefAccessError('sign_in_required');
    }
    if (res.status === 403) {
      // Server says the Clerk userId is not Pro. This can happen
      // when the client's authState says role=pro but the server's
      // entitlement source (Convex) disagrees, or when the Clerk
      // plan claim goes stale. Surface as upgrade CTA — not a
      // retryable error, since retrying won't flip entitlement.
      throw new BriefAccessError('upgrade_required');
    }
    if (!res.ok) {
      throw new Error(`Brief service unavailable (${res.status})`);
    }
    const body = (await res.json()) as LatestBriefResponse;
    if (!body || (body.status !== 'ready' && body.status !== 'composing')) {
      throw new Error('Unexpected response from brief service');
    }
    return body;
  }

  private renderLoading(): void {
    clearChildren(this.content);
    this.content.appendChild(
      h('div', { className: 'latest-brief-empty' },
        h('div', { className: 'latest-brief-empty-title' }, 'Loading your brief…'),
      ),
    );
  }

  /**
   * Desktop / tester-key auth can satisfy hasPremiumAccess without a
   * Clerk userId. /api/latest-brief is user-scoped, so there's
   * nothing to fetch. Render a specific CTA rather than pretending
   * this is an error state.
   */
  private renderSignInRequired(): void {
    clearChildren(this.content);
    const logo = h('div', { className: 'latest-brief-logo' });
    logo.appendChild(rawHtml(WM_LOGO_SVG));
    this.content.appendChild(
      h('div', { className: 'latest-brief-card latest-brief-card--composing' },
        logo,
        h('div', { className: 'latest-brief-empty-title' }, 'Sign in to view your brief.'),
        h('div', { className: 'latest-brief-empty-body' },
          'Your personalised brief is tied to your WorldMonitor account. Sign in to see today\u2019s issue.',
        ),
      ),
    );
  }

  /**
   * Free Clerk account (either via local authState or via a 403
   * from the server). Render an upgrade CTA instead of retrying —
   * the user needs a plan change, not a fresh fetch.
   */
  private renderUpgradeRequired(): void {
    clearChildren(this.content);
    const logo = h('div', { className: 'latest-brief-logo' });
    logo.appendChild(rawHtml(WM_LOGO_SVG));
    this.content.appendChild(
      h('div', { className: 'latest-brief-card latest-brief-card--composing' },
        logo,
        h('div', { className: 'latest-brief-empty-title' }, 'Pro required.'),
        h('div', { className: 'latest-brief-empty-body' },
          'The WorldMonitor Brief is included with the Pro plan. Upgrade to unlock today\u2019s issue.',
        ),
      ),
    );
  }

  private scheduleComposingPoll(): void {
    this.clearComposingPoll();
    this.composingPollId = setTimeout(() => {
      this.composingPollId = null;
      void this.refresh();
    }, COMPOSING_POLL_MS);
  }

  private clearComposingPoll(): void {
    if (this.composingPollId !== null) {
      clearTimeout(this.composingPollId);
      this.composingPollId = null;
    }
  }

  private renderComposing(data: LatestBriefComposing): void {
    clearChildren(this.content);
    // While we're stuck on composing, re-poll every minute so the
    // panel transitions to ready on the next cron tick without
    // requiring a full page reload.
    this.scheduleComposingPoll();
    // h()'s applyProps has no special-case for innerHTML — passing
    // it as a prop sets a literal DOM attribute named "innerHTML"
    // rather than parsing HTML. Use rawHtml() which returns a
    // DocumentFragment.
    const logoDiv = h('div', { className: 'latest-brief-logo' });
    logoDiv.appendChild(rawHtml(WM_LOGO_SVG));
    this.content.appendChild(
      h('div', { className: 'latest-brief-card latest-brief-card--composing' },
        logoDiv,
        h('div', { className: 'latest-brief-empty-title' }, 'Your brief is composing.'),
        h('div', { className: 'latest-brief-empty-body' },
          `The editorial team at WorldMonitor is writing your ${data.issueDate} brief. Check back in a moment.`,
        ),
      ),
    );
  }

  private renderReady(data: LatestBriefReady): void {
    const threadLabel = data.threadCount === 1 ? '1 thread' : `${data.threadCount} threads`;

    const coverLogo = h('div', { className: 'latest-brief-cover-logo' });
    coverLogo.appendChild(rawHtml(WM_LOGO_SVG));

    const coverCard = h('a', {
      className: 'latest-brief-card latest-brief-card--ready',
      href: data.magazineUrl,
      target: '_blank',
      rel: 'noopener noreferrer',
      'aria-label': `Open today's brief — ${threadLabel}`,
    },
      h('div', { className: 'latest-brief-cover' },
        coverLogo,
        h('div', { className: 'latest-brief-cover-issue' }, data.dateLong),
        h('div', { className: 'latest-brief-cover-title' }, 'WorldMonitor'),
        h('div', { className: 'latest-brief-cover-title' }, 'Brief.'),
        h('div', { className: 'latest-brief-cover-kicker' }, threadLabel),
      ),
      h('div', { className: 'latest-brief-meta' },
        h('div', { className: 'latest-brief-greeting' }, data.greeting),
        h('div', { className: 'latest-brief-cta' }, 'Read brief →'),
      ),
    );

    // Share button: referral plumbing is server-side (GET /api/referral/me).
    // Keep the button in the DOM even before the profile resolves so
    // the layout doesn't jump; disable-and-enable once the fetch lands.
    const shareBtn = h('button', {
      type: 'button',
      className: 'latest-brief-share',
      'aria-label': 'Share WorldMonitor — copies a referral link',
      disabled: true,
    }, 'Share ↗');
    const shareStatus = h('span', {
      className: 'latest-brief-share-status',
      'aria-live': 'polite',
    }, '');
    const shareRow = h(
      'div',
      { className: 'latest-brief-share-row' },
      shareBtn,
      shareStatus,
    );

    replaceChildren(this.content, coverCard, shareRow);

    // Lazy-load the referral module so the share wiring doesn't pull
    // into every dashboard bundle the panel lives in.
    void (async () => {
      try {
        const mod = await import('@/services/referral');
        const profile = await mod.getReferralProfile();
        if (!profile) {
          shareRow.remove();
          return;
        }
        (shareBtn as HTMLButtonElement).disabled = false;
        // No invite/conversion count rendered. Attribution flows
        // through Dodopayments metadata (not registrations.referredBy)
        // today, so counting from one store would mislead. Metrics
        // will reappear once the two paths are unified.
        shareBtn.addEventListener('click', async () => {
          const originalLabel = shareBtn.textContent ?? 'Share ↗';
          (shareBtn as HTMLButtonElement).disabled = true;
          try {
            const result = await mod.shareReferral(profile);
            if (result === 'shared') {
              shareStatus.textContent = 'Thanks for sharing';
            } else if (result === 'copied') {
              shareStatus.textContent = 'Link copied';
            } else if (result === 'error') {
              shareStatus.textContent = 'Share unavailable';
            }
          } finally {
            (shareBtn as HTMLButtonElement).disabled = false;
            shareBtn.textContent = originalLabel;
          }
        });
      } catch {
        // Lazy-import failure is non-fatal — just hide the row.
        shareRow.remove();
      }
    })();
  }

  public override destroy(): void {
    this.clearComposingPoll();
    this.inflightAbort?.abort();
    this.inflightAbort = null;
    if (this.onVisibility) {
      document.removeEventListener('visibilitychange', this.onVisibility);
      this.onVisibility = null;
    }
    this.unsubscribeAuth?.();
    this.unsubscribeAuth = null;
    super.destroy();
  }
}
