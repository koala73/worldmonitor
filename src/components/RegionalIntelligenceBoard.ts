import { Panel } from './Panel';
import { getRpcBaseUrl } from '@/services/rpc-client';
import { IntelligenceServiceClient } from '@/generated/client/worldmonitor/intelligence/v1/service_client';
import type { RegionalSnapshot, RegimeTransition, RegionalBrief } from '@/generated/client/worldmonitor/intelligence/v1/service_client';
import { h, replaceChildren } from '@/utils/dom-utils';
import { escapeHtml } from '@/utils/sanitize';
import { BOARD_REGIONS, DEFAULT_REGION_ID, buildBoardHtml, buildRegimeHistoryBlock, buildWeeklyBriefBlock, isLatestSequence } from './regional-intelligence-board-utils';

const client = new IntelligenceServiceClient(getRpcBaseUrl(), {
  fetch: (...args) => globalThis.fetch(...args),
});

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
    void this.loadCurrent();
  }

  /** Public API for tests and agent tools: force-load a region directly. */
  public async loadRegion(regionId: string): Promise<void> {
    this.currentRegion = regionId;
    this.selector.value = regionId;
    await this.loadCurrent();
  }

  private async loadCurrent(): Promise<void> {
    // Claim a sequence number BEFORE we await anything. The latest claim
    // wins — any response from an earlier sequence is dropped so fast
    // dropdown switches can't leave the panel rendering a stale region.
    this.latestSequence += 1;
    const mySequence = this.latestSequence;
    const myRegion = this.currentRegion;
    this.renderLoading();

    try {
      // Fire all 3 RPCs in parallel — snapshot is required, history + brief
      // are best-effort enhancements. If either fails, the board still renders
      // with just the snapshot data.
      const [snapshotResp, historyResp, briefResp] = await Promise.allSettled([
        client.getRegionalSnapshot({ regionId: myRegion }),
        client.getRegimeHistory({ regionId: myRegion, limit: 20 }),
        client.getRegionalBrief({ regionId: myRegion }),
      ]);
      if (!isLatestSequence(mySequence, this.latestSequence)) return;

      if (snapshotResp.status === 'rejected') {
        const err = snapshotResp.reason;
        this.renderError(err instanceof Error ? err.message : String(err));
        return;
      }
      const snapshot = snapshotResp.value.snapshot;
      if (!snapshot?.regionId) {
        this.renderEmpty();
        return;
      }

      // Distinguish RPC success (render block, even if empty) from RPC failure
      // (omit block entirely). null = RPC failed, array/object = RPC succeeded.
      const transitions: RegimeTransition[] | null = historyResp.status === 'fulfilled'
        ? (historyResp.value.transitions ?? [])
        : null;
      // Distinguish: RPC failed (null) vs RPC succeeded with no brief (undefined).
      // null → omit block. undefined → show "no brief yet" empty state.
      const brief: RegionalBrief | undefined | null = briefResp.status === 'fulfilled'
        ? briefResp.value.brief  // undefined when server returns {} (no brief exists yet)
        : null;                  // null when RPC itself failed

      this.renderBoard(snapshot, transitions, brief);
    } catch (err) {
      if (!isLatestSequence(mySequence, this.latestSequence)) return;
      console.error('[RegionalIntelligenceBoard] load failed', err);
      this.renderError(err instanceof Error ? err.message : String(err));
    }
  }

  private renderLoading(): void {
    this.body.innerHTML =
      '<div class="rib-status" style="padding:16px;color:var(--text-dim);font-size:12px">Loading regional snapshot…</div>';
  }

  private renderEmpty(): void {
    this.body.innerHTML =
      '<div class="rib-status" style="padding:16px;color:var(--text-dim);font-size:12px">No snapshot available yet for this region. The next cron cycle will populate it within 6 hours.</div>';
  }

  private renderError(message: string): void {
    this.body.innerHTML = `<div class="rib-status rib-status-error" style="padding:16px;color:var(--danger);font-size:12px">Failed to load snapshot: ${escapeHtml(message)}</div>`;
  }

  /** Render the full board HTML from a hydrated snapshot + optional Phase 3 data.
   *  null = RPC failed (omit block entirely), array/object = RPC succeeded (render, even if empty). */
  public renderBoard(snapshot: RegionalSnapshot, transitions?: RegimeTransition[] | null, brief?: RegionalBrief | null): void {
    let html = buildBoardHtml(snapshot);
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
