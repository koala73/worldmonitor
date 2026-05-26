import { Panel } from './Panel';
import { getRpcBaseUrl } from '@/services/rpc-client';
import { premiumFetch } from '@/services/premium-fetch';
import { IS_EMBEDDED_PREVIEW } from '@/utils/embedded-preview';
import { hasPremiumAccess } from '@/services/panel-gating';
import { subscribeAuthState } from '@/services/auth-state';
import { IntelligenceServiceClient } from '@/generated/client/worldmonitor/intelligence/v1/service_client';
import type { RegionalSnapshot, RegimeTransition, RegionalBrief } from '@/generated/client/worldmonitor/intelligence/v1/service_client';
import { h, replaceChildren } from '@/utils/dom-utils';
import { escapeHtml } from '@/utils/sanitize';
import { BOARD_REGIONS, DEFAULT_REGION_ID, buildBoardHtml, buildRegimeHistoryBlock, buildWeeklyBriefBlock, isLatestSequence } from './regional-intelligence-board-utils';

// get-regional-snapshot + get-regime-history + get-regional-brief are
// premium-gated. Plain globalThis.fetch skips Clerk/tester/api-key injection
// and returns 401 for pro users — premiumFetch is the correct fetcher here.
const client = new IntelligenceServiceClient(getRpcBaseUrl(), { fetch: premiumFetch });

/**
 * RegionalIntelligenceBoard — premium panel rendering a canonical
 * RegionalSnapshot as 6 structured blocks plus narrative sections.
 *
 * Blocks:
 *   1. Regime   — current label, previous label, transition driver
 *   2. Balance  — 7 axes + net_balance bar chart
 *   3. Actors   — top 5 actors by leverage score with deltas
 *   4. Scenarios — 3 horizons × 4 lanes (probability bars)
 *   5. Transmission — top 5 transmission paths
 *   6. Watchlist — active triggers + narrative watch_items
 *
 * Narrative sections (situation, balance_assessment, outlook 24h/7d/30d)
 * render inline above the blocks when populated by the seed's LLM layer.
 * Empty narrative fields are hidden rather than showing empty placeholders.
 *
 * Data source: /api/intelligence/v1/get-regional-snapshot (premium-gated).
 * One call per region change; no polling. Results are cached by the gateway.
 *
 * All HTML builders live in regional-intelligence-board-utils.ts so they can
 * be imported by node:test runners without pulling in Vite-only services.
 */
export class RegionalIntelligenceBoard extends Panel {
  private selector: HTMLSelectElement;
  private body: HTMLElement;
  private currentRegion: string = DEFAULT_REGION_ID;
  /**
   * Monotonically-increasing request sequence. Each `loadCurrent()` call
   * claims a new sequence before it awaits the RPC; when the response comes
   * back, it renders ONLY if its sequence still matches `latestSequence`.
   * Earlier in-flight fetches whose user has already moved on are discarded.
   * Replaces a naive `loading` boolean that used to drop rapid region
   * switches — see PR #2963 review.
   */
  private latestSequence = 0;

  /**
   * Tracks the last-seen entitlement so the auth subscription re-fires the
   * RPC only on a false→true transition, not on every unrelated auth state
   * update (session refresh, unrelated user prefs).
   */
  private lastHadPremium = false;
  /**
   * Handle for the `subscribeAuthState` listener, so `destroy()` can
   * unsubscribe. Without this, recreating the panel (e.g. on framework
   * swap or layout teardown → re-init) would leak listeners that still
   * hold a reference to the destroyed instance's `this` — every old
   * subscriber would call `loadCurrent()` / `renderEmpty()` on a stale
   * DOM tree on every future auth event. Panel.destroy IS called from
   * panel-layout teardown (panel-layout.ts:293, App.ts:1156); the
   * previous "Panel has no destroy hook" comment was wrong.
   */
  private authUnsubscribe: (() => void) | null = null;

  constructor() {
    super({
      id: 'regional-intelligence',
      title: 'Regional Intelligence',
      infoTooltip:
        'Canonical regional intelligence brief: regime label, 7-axis balance vector, top actors, scenario lanes, transmission paths, and watchlist. One snapshot per region, refreshed every 6 hours.',
      premium: 'locked',
    });

    this.selector = h('select', {
      className: 'rib-region-selector',
      'aria-label': 'Region',
    }) as HTMLSelectElement;
    for (const r of BOARD_REGIONS) {
      const opt = document.createElement('option');
      opt.value = r.id;
      opt.textContent = r.label;
      if (r.id === DEFAULT_REGION_ID) opt.selected = true;
      this.selector.appendChild(opt);
    }
    this.selector.addEventListener('change', () => {
      this.currentRegion = this.selector.value;
      void this.loadCurrent();
    });

    const controls = h('div', { className: 'rib-controls' }, this.selector);
    this.body = h('div', { className: 'rib-body' });

    replaceChildren(this.content, h('div', { className: 'rib-shell' }, controls, this.body));

    this.renderLoading();
    this.lastHadPremium = hasPremiumAccess();
    void this.loadCurrent();

    // Re-fire loadCurrent on false→true entitlement transitions (user signs
    // in / purchases PRO mid-session). Without this, a user whose Clerk
    // session hasn't resolved at panel-construction time would see
    // renderEmpty() and then stay empty forever even after sign-in, because
    // nothing else triggers loadCurrent for the current region.
    this.authUnsubscribe = subscribeAuthState(() => {
      const hasPremium = hasPremiumAccess();
      if (hasPremium && !this.lastHadPremium) {
        this.lastHadPremium = true;
        void this.loadCurrent();
      } else if (!hasPremium && this.lastHadPremium) {
        // Entitlement was revoked (sign-out, subscription ended) — blank
        // the panel so stale data doesn't linger for a user who can no
        // longer see it. Panel locking separately re-applies via
        // panel-layout's auth subscription.
        this.lastHadPremium = false;
        this.renderEmpty();
      }
    });
  }

  /** Public API for tests and agent tools: force-load a region directly. */
  public async loadRegion(regionId: string): Promise<void> {
    this.currentRegion = regionId;
    this.selector.value = regionId;
    await this.loadCurrent();
  }

  override destroy(): void {
    this.authUnsubscribe?.();
    this.authUnsubscribe = null;
    // Invalidate any in-flight loadCurrent: the existing sequence guard
    // (see `isLatestSequence` checks) drops responses whose sequence no
    // longer matches `latestSequence`. Bumping it here ensures a pending
    // getRegionalSnapshot that resolves after destroy doesn't try to
    // render into a detached DOM tree.
    this.latestSequence += 1;
    super.destroy();
  }

  private async loadCurrent(): Promise<void> {
    // Skip premium RPCs when this app instance is running inside the /pro
    // marketing page's live-preview iframe — no Clerk session carries across
    // that boundary, so every call would 401. The breaker + renderEmpty path
    // already handles "no data" cases visually; short-circuiting here keeps
    // the /pro console and Sentry quiet from these expected failures.
    if (IS_EMBEDDED_PREVIEW) {
      this.renderEmpty();
      return;
    }

    // Skip premium RPCs for anonymous/free users. Without this the panel
    // fires get-regional-snapshot on every page load for every visitor and
    // gets a 401 in the browser console. The panel's `premium: 'locked'`
    // config + apiKeyPanels entry already keeps it visually hidden until
    // the user is PRO — this just stops the RPC from firing during the
    // constructor's `void this.loadCurrent()` before Clerk auth resolves.
    if (!hasPremiumAccess()) {
      this.renderEmpty();
      return;
    }

    // Claim a sequence number BEFORE we await anything. The latest claim
    // wins — any response from an earlier sequence is dropped so fast
    // dropdown switches can't leave the panel rendering a stale region.
    this.latestSequence += 1;
    const mySequence = this.latestSequence;
    const myRegion = this.currentRegion;
    this.renderLoading();

    // Phase 1: render the snapshot immediately — never blocked by Phase 3
    // enrichments. History + brief fire in parallel but don't gate the
    // board's core render path. PR #2995 review: the old Promise.allSettled
    // approach blocked the entire panel on slow enrichment RPCs.
    let snapshot: RegionalSnapshot | undefined;
    let actualRegion = myRegion;
    let fallbackFrom: string | null = null;
    try {
      const resp = await client.getRegionalSnapshot({ regionId: myRegion });
      if (!isLatestSequence(mySequence, this.latestSequence)) return;
      snapshot = resp.snapshot;
    } catch (err) {
      if (!isLatestSequence(mySequence, this.latestSequence)) return;
      this.renderError(err instanceof Error ? err.message : String(err));
      return;
    }

    // If the requested region has no snapshot yet, race the other regions
    // and render the FIRST one that returns data. Better UX than telling
    // the user to wait — and we never block on a slow/hung region because
    // (a) we resolve on the first non-empty success rather than waiting for
    // all to settle, and (b) a hard timeout caps the total wait. The
    // generated client has no default per-request timeout, so without both
    // guards a single hung region could leave the panel on the loader.
    if (!snapshot?.regionId) {
      const fallbackIds = BOARD_REGIONS.map(r => r.id).filter(id => id !== myRegion);
      const FALLBACK_TIMEOUT_MS = 4000;
      const winner = await new Promise<{ snapshot: RegionalSnapshot; id: string } | null>(resolve => {
        if (fallbackIds.length === 0) {
          resolve(null);
          return;
        }
        let resolved = false;
        let pending = fallbackIds.length;
        const settle = (value: { snapshot: RegionalSnapshot; id: string } | null) => {
          if (resolved) return;
          resolved = true;
          resolve(value);
        };
        const timer = setTimeout(() => settle(null), FALLBACK_TIMEOUT_MS);
        for (const id of fallbackIds) {
          client.getRegionalSnapshot({ regionId: id })
            .then(resp => {
              if (resp.snapshot?.regionId) {
                clearTimeout(timer);
                settle({ snapshot: resp.snapshot, id });
                return;
              }
              if (--pending === 0) {
                clearTimeout(timer);
                settle(null);
              }
            })
            .catch(() => {
              if (--pending === 0) {
                clearTimeout(timer);
                settle(null);
              }
            });
        }
      });
      if (!isLatestSequence(mySequence, this.latestSequence)) return;
      if (winner) {
        snapshot = winner.snapshot;
        actualRegion = winner.id;
        fallbackFrom = myRegion;
      }
    }

    if (!snapshot?.regionId) {
      this.renderEmpty();
      return;
    }

    // Render the snapshot blocks immediately — the user sees content now.
    // Pass null for both Phase 3 blocks so they're omitted entirely during
    // the initial paint. They'll be appended (or shown as empty-state) once
    // the background enrichment RPCs resolve. Without null here, the default
    // undefined would render a false "No weekly brief available yet" while
    // the fetch is still in flight. PR #2995 review.
    this.renderBoard(snapshot, null, null, fallbackFrom);

    // Phase 2: fire history + brief RPCs in background. Use actualRegion so
    // the enrichments match the rendered snapshot when we fell back.
    const historyPromise = client.getRegimeHistory({ regionId: actualRegion, limit: 20 }).catch(() => null);
    const briefPromise = client.getRegionalBrief({ regionId: actualRegion }).catch(() => null);

    Promise.allSettled([historyPromise, briefPromise]).then(([hResult, bResult]) => {
      if (!isLatestSequence(mySequence, this.latestSequence)) return;

      // Distinguish: RPC failed or upstreamUnavailable (null → omit block)
      // vs RPC succeeded with real data (render block, even if empty).
      // The server returns upstreamUnavailable:true in the body on Redis
      // failure, which still resolves as a fulfilled promise. Check for it.
      const hValue = hResult.status === 'fulfilled' ? hResult.value : null;
      const transitions: RegimeTransition[] | null =
        hValue && !(hValue as unknown as { upstreamUnavailable?: boolean }).upstreamUnavailable
          ? (hValue.transitions ?? [])
          : null;

      const bValue = bResult.status === 'fulfilled' ? bResult.value : null;
      const brief: RegionalBrief | undefined | null =
        bValue && !(bValue as unknown as { upstreamUnavailable?: boolean }).upstreamUnavailable
          ? bValue.brief   // undefined = no brief yet, RegionalBrief = render
          : null;          // null = RPC or upstream failed → omit block

      this.renderBoard(snapshot!, transitions, brief, fallbackFrom);
    });
  }

  private renderLoading(): void {
    this.body.innerHTML =
      '<div class="rib-status" style="padding:16px;color:var(--text-dim);font-size:12px">Loading regional intelligence…</div>';
  }

  private renderEmpty(): void {
    this.body.innerHTML =
      '<div class="rib-status" style="padding:16px;color:var(--text-dim);font-size:12px">Regional intelligence is being refreshed. Try selecting another region above.</div>';
  }

  private renderError(message: string): void {
    this.body.innerHTML = `<div class="rib-status rib-status-error" style="padding:16px;color:var(--danger);font-size:12px">We couldn't load this region right now: ${escapeHtml(message)}</div>`;
  }

  /** Render the full board HTML from a hydrated snapshot + optional Phase 3 data.
   *  null = RPC failed (omit block entirely), array/object = RPC succeeded (render, even if empty).
   *  fallbackFrom: when set, renders a small notice explaining we're showing a
   *  different region than the one the user selected. */
  public renderBoard(
    snapshot: RegionalSnapshot,
    transitions?: RegimeTransition[] | null,
    brief?: RegionalBrief | null,
    fallbackFrom?: string | null,
  ): void {
    let html = '';
    if (fallbackFrom) {
      const requestedLabel = BOARD_REGIONS.find(r => r.id === fallbackFrom)?.label ?? fallbackFrom;
      const actualLabel = BOARD_REGIONS.find(r => r.id === snapshot.regionId)?.label ?? snapshot.regionId;
      html += `<div class="rib-fallback-notice" style="padding:10px 16px;margin:0 0 8px;background:var(--bg-elevated,rgba(255,255,255,0.04));border-left:3px solid var(--warning,#d4a015);font-size:12px;color:var(--text-dim);line-height:1.5">${escapeHtml(requestedLabel)} is being refreshed — showing ${escapeHtml(actualLabel)} in the meantime.</div>`;
    }
    html += buildBoardHtml(snapshot);
    // Phase 3 blocks: only render when the RPC succeeded (non-null).
    // null means the RPC failed — omit the block so we don't show a
    // misleading "no data yet" message for a transient outage.
    // An empty array/undefined-brief from a successful RPC correctly
    // shows the "no transitions" / "no brief" empty state.
    if (transitions !== null && transitions !== undefined) {
      html += buildRegimeHistoryBlock(transitions);
    }
    // brief: null = RPC failed (omit), undefined = no brief yet (show empty state),
    // RegionalBrief = render content. Only null omits the block.
    if (brief !== null) {
      html += buildWeeklyBriefBlock(brief);
    }
    this.body.innerHTML = html;
  }
}
