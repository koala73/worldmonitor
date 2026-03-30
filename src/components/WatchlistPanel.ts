import { Panel } from './Panel';
import { escapeHtml } from '@/utils/sanitize';
import { getWatchedCountries, rankWatchedCountries, subscribeWatchlist, type WatchlistPlaybook } from '@/services/watchlist-playbooks';
import type { ReplayWatchSummary } from '@/services/replay-narrative';

export interface WatchCountrySnapshot {
  code: string;
  name: string;
  score: number;
  trend: 'rising' | 'stable' | 'falling';
  playbook: WatchlistPlaybook;
  addedAt?: number;
}

interface WatchlistPanelOptions {
  getCountrySnapshot: (code: string, name: string) => WatchCountrySnapshot | null;
  openCountryBrief: (code: string, name: string) => void;
}

const SEVERITY_CLASS: Record<WatchlistPlaybook['severity'], string> = {
  critical: 'watchlist-severity-critical',
  high: 'watchlist-severity-high',
  medium: 'watchlist-severity-medium',
  low: 'watchlist-severity-low',
};

export class WatchlistPanel extends Panel {
  private options: WatchlistPanelOptions;
  private unsubscribeWatchlist: (() => void) | null = null;
  private readonly boundDataRefreshed: () => void;
  private snapshots: WatchCountrySnapshot[] = [];

  constructor(options: WatchlistPanelOptions) {
    super({
      id: 'watchlist',
      title: 'Watchlist & Playbooks',
      showCount: true,
      trackActivity: true,
      infoTooltip: 'Saved countries ranked by current escalation playbook, with recommended next panels.',
    });
    this.options = options;

    this.content.addEventListener('click', (event) => {
      const target = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-watch-country]');
      if (!target) return;
      const code = target.dataset.code;
      const name = target.dataset.name;
      if (!code || !name) return;
      this.options.openCountryBrief(code, name);
    });

    this.boundDataRefreshed = () => this.refresh();
    document.addEventListener('wm:data-refreshed', this.boundDataRefreshed);
    this.unsubscribeWatchlist = subscribeWatchlist(() => this.refresh());
    this.refresh();
  }

  override destroy(): void {
    document.removeEventListener('wm:data-refreshed', this.boundDataRefreshed);
    this.unsubscribeWatchlist?.();
    this.unsubscribeWatchlist = null;
    super.destroy();
  }

  public refresh(): void {
    const watchedCountries = getWatchedCountries();
    this.snapshots = rankWatchedCountries(
      watchedCountries
        .map((country) => this.options.getCountrySnapshot(country.code, country.name))
        .filter((country): country is WatchCountrySnapshot => Boolean(country)),
    );

    this.setCount(this.snapshots.length);

    if (this.snapshots.length === 0) {
      this.content.innerHTML = `
        <div class="watchlist-empty">
          <div class="watchlist-empty-title">No watched countries yet</div>
          <div class="watchlist-empty-copy">Open any country brief and pin it to your watchlist to get ranked escalation playbooks here.</div>
        </div>
      `;
      return;
    }

    this.content.innerHTML = `
      <div class="watchlist-list">
        ${this.snapshots.slice(0, 8).map((snapshot) => this.renderCard(snapshot)).join('')}
      </div>
    `;
  }

  public getReplaySummary(): ReplayWatchSummary {
    return {
      criticalCount: this.snapshots.filter((snapshot) => snapshot.playbook.severity === 'critical').length,
      highCount: this.snapshots.filter((snapshot) => snapshot.playbook.severity === 'high').length,
      watchedCountries: this.snapshots.slice(0, 6).map((snapshot) => ({
        code: snapshot.code,
        name: snapshot.name,
        severity: snapshot.playbook.severity,
        scenario: snapshot.playbook.scenario,
        score: snapshot.score,
      })),
    };
  }

  private renderCard(snapshot: WatchCountrySnapshot): string {
    let trend = 'Stable';
    if (snapshot.trend === 'rising') trend = 'Rising';
    else if (snapshot.trend === 'falling') trend = 'Cooling';
    const panels = snapshot.playbook.priorityPanels.slice(0, 3).map((panel) => `<span class="watchlist-panel-chip">${escapeHtml(panel.replace(/-/g, ' '))}</span>`).join('');
    return `
      <button class="watchlist-card" data-watch-country="1" data-code="${escapeHtml(snapshot.code)}" data-name="${escapeHtml(snapshot.name)}">
        <div class="watchlist-card-top">
          <div>
            <div class="watchlist-country">${escapeHtml(snapshot.name)}</div>
            <div class="watchlist-scenario">${escapeHtml(snapshot.playbook.title)}</div>
          </div>
          <div class="watchlist-metrics">
            <span class="watchlist-severity ${SEVERITY_CLASS[snapshot.playbook.severity]}">${snapshot.playbook.severity.toUpperCase()}</span>
            <span class="watchlist-score">${snapshot.score}</span>
          </div>
        </div>
        <div class="watchlist-summary">${escapeHtml(snapshot.playbook.summary)}</div>
        <div class="watchlist-card-bottom">
          <span class="watchlist-trend">${trend}</span>
          <div class="watchlist-panels">${panels}</div>
        </div>
      </button>
    `;
  }
}
