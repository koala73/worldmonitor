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
import { premiumFetch } from '@/services/premium-fetch';
import { PanelGateReason, hasPremiumAccess } from '@/services/panel-gating';
import { getAuthState } from '@/services/auth-state';
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
    // Defer the self-fetch until updatePanelGating() (called on mount
    // + on auth state changes) has either unlocked us or rendered
    // the gated CTA. If we fetch first, anonymous/free users would
    // hit 401/403 and see raw error UI for a moment before the gate
    // repaints over us. refresh() also short-circuits when the user
    // has no premium access, so a mid-session downgrade stops
    // hitting the endpoint immediately.
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
    // Check #1: gate before starting.
    if (this.gateLocked || !hasPremiumAccess(getAuthState())) return;
    this.refreshing = true;
    const controller = new AbortController();
    this.inflightAbort = controller;
    try {
      const data = await this.fetchLatest(controller.signal);
      // Check #3 (post-response): auth may have flipped during the
      // await. If the gate was flipped by updatePanelGating, it has
      // already replaced `this.content` with the locked CTA — we
      // must NOT overwrite that with brief content.
      if (this.gateLocked || !hasPremiumAccess(getAuthState())) return;
      if (data.status === 'ready') {
        this.renderReady(data);
      } else {
        this.renderComposing(data);
      }
    } catch (err) {
      // AbortError comes from showGatedCta's abort() → render nothing.
      if ((err as { name?: string } | null)?.name === 'AbortError') return;
      if (this.gateLocked || !hasPremiumAccess(getAuthState())) return;
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
    const res = await premiumFetch(LATEST_BRIEF_ENDPOINT, { signal });
    if (res.status === 401) {
      throw new Error('Sign in to view your brief.');
    }
    if (res.status === 403) {
      // PRO gate — base panel handles the visual. Keep the throw so
      // the caller's error branch is a no-op; locked-state overlay
      // already covers the content area.
      throw new Error('PRO required');
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

  private renderComposing(data: LatestBriefComposing): void {
    clearChildren(this.content);
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

    replaceChildren(this.content, coverCard);
  }
}
