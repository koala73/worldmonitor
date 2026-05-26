import { Panel } from './Panel';
import { t } from '@/services/i18n';
import { getTechReadinessRankings, type TechReadinessScore } from '@/services/economic';
import { escapeHtml } from '@/utils/sanitize';

const COUNTRY_FLAGS: Record<string, string> = {
  'USA': '🇺🇸', 'CHN': '🇨🇳', 'JPN': '🇯🇵', 'DEU': '🇩🇪', 'KOR': '🇰🇷',
  'GBR': '🇬🇧', 'IND': '🇮🇳', 'ISR': '🇮🇱', 'SGP': '🇸🇬', 'TWN': '🇹🇼',
  'FRA': '🇫🇷', 'CAN': '🇨🇦', 'SWE': '🇸🇪', 'NLD': '🇳🇱', 'CHE': '🇨🇭',
  'FIN': '🇫🇮', 'IRL': '🇮🇪', 'AUS': '🇦🇺', 'BRA': '🇧🇷', 'IDN': '🇮🇩',
  'ESP': '🇪🇸', 'ITA': '🇮🇹', 'MEX': '🇲🇽', 'RUS': '🇷🇺', 'TUR': '🇹🇷',
  'SAU': '🇸🇦', 'ARE': '🇦🇪', 'POL': '🇵🇱', 'THA': '🇹🇭', 'MYS': '🇲🇾',
  'VNM': '🇻🇳', 'PHL': '🇵🇭', 'NZL': '🇳🇿', 'AUT': '🇦🇹', 'BEL': '🇧🇪',
  'DNK': '🇩🇰', 'NOR': '🇳🇴', 'PRT': '🇵🇹', 'CZE': '🇨🇿', 'ZAF': '🇿🇦',
  'NGA': '🇳🇬', 'KEN': '🇰🇪', 'EGY': '🇪🇬', 'ARG': '🇦🇷', 'CHL': '🇨🇱',
  'COL': '🇨🇴', 'PAK': '🇵🇰', 'BGD': '🇧🇩', 'UKR': '🇺🇦', 'ROU': '🇷🇴',
  'EST': '🇪🇪', 'LVA': '🇱🇻', 'LTU': '🇱🇹', 'HUN': '🇭🇺', 'GRC': '🇬🇷',
  'QAT': '🇶🇦', 'BHR': '🇧🇭', 'KWT': '🇰🇼', 'OMN': '🇴🇲', 'JOR': '🇯🇴',
};

export class TechReadinessPanel extends Panel {
  private rankings: TechReadinessScore[] = [];
  private loading = false;
  private lastFetch = 0;
  private readonly REFRESH_INTERVAL = 6 * 60 * 60 * 1000; // 6 hours
  /**
   * Local backoff state for retrying after an empty/failed fetch. Without
   * this, a single transient blip (slow-tier bootstrap abort + lazy-fetch
   * fail) left the panel stuck in an empty/error state until the user
   * restarted the app — refresh() is only fired at startup.
   *
   * Crucially, this counter MUST be local. Panel's own retryAttempt is
   * reset to 0 by every call to setContent() (e.g. via showFetchingState
   * at the top of refresh()), so relying on Panel.showError's default
   * `Math.min(15 * 2 ** retryAttempt, 180)` gave a flat 15s loop that
   * hammered the upstream every cycle during a persistent outage.
   */
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private localRetryAttempt = 0;
  private readonly MAX_RETRY_ATTEMPTS = 5;
  /** 30s → 60s → 2m → 4m → 5m (capped). Same delays for empty-payload
   *  and error retries — both indicate "try again later," and we want
   *  the same upstream-friendly cadence in either case. */
  private readonly RETRY_DELAYS_MS: ReadonlyArray<number> = [30_000, 60_000, 120_000, 240_000, 300_000];

  constructor() {
    super({
      id: 'tech-readiness',
      title: t('panels.techReadiness'),
      showCount: true,
      infoTooltip: t('components.techReadiness.infoTooltip'),
    });
    this.hideCountBadge();
  }

  public async refresh(isRetry = false): Promise<void> {
    if (this.loading) return;
    if (Date.now() - this.lastFetch < this.REFRESH_INTERVAL && this.rankings.length > 0) {
      return;
    }
    if (!isRetry) this.localRetryAttempt = 0;

    this.loading = true;
    this.clearRetryTimer();
    this.showFetchingState();

    try {
      const result = await getTechReadinessRankings();
      if (!this.element?.isConnected) return;
      this.rankings = result;
      if (result.length === 0) {
        // Server returned an empty payload (NOT a network failure — those
        // throw and land in the catch branch). Show a soft "refreshing"
        // state and retry on backoff in case the seed-meta is briefly out
        // of step with the underlying data key, instead of painting the
        // panel red as a hard error. Don't stamp lastFetch — we want
        // explicit retries, not a 6h cooldown on no data.
        this.showSoftRefreshing();
        this.scheduleRetry();
        return;
      }
      this.lastFetch = Date.now();
      this.localRetryAttempt = 0;
      this.render();
    } catch (error) {
      if (!this.element?.isConnected) return;
      console.error('[TechReadinessPanel] Error fetching data:', error);
      // Compute the backoff delay LOCALLY rather than letting Panel.showError
      // fall back to its retryAttempt-based formula — that counter is
      // reset by every showFetchingState() call at the top of refresh(),
      // so the default flow gave a flat 15s retry loop that hammered the
      // upstream every cycle.
      const delayMs = this.nextRetryDelayMs();
      if (delayMs === null) {
        this.renderTerminalError();
        return;
      }
      this.showError(
        t('common.failedTechReadiness'),
        () => void this.refresh(true),
        Math.round(delayMs / 1000),
      );
    } finally {
      this.loading = false;
    }
  }

  override destroy(): void {
    this.clearRetryTimer();
    super.destroy();
  }

  private clearRetryTimer(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  private hideCountBadge(): void {
    if (this.countEl) this.countEl.style.display = 'none';
  }

  private showCountBadge(count: number): void {
    this.setCount(count);
    if (this.countEl) this.countEl.style.display = '';
  }

  /**
   * Returns the next backoff delay in ms, or null when MAX_RETRY_ATTEMPTS
   * is reached. Increments the counter as a side effect.
   */
  private nextRetryDelayMs(): number | null {
    if (this.localRetryAttempt >= this.MAX_RETRY_ATTEMPTS) return null;
    const delay = this.RETRY_DELAYS_MS[this.localRetryAttempt] ?? 300_000;
    this.localRetryAttempt += 1;
    return delay;
  }

  private scheduleRetry(): void {
    const delay = this.nextRetryDelayMs();
    if (delay === null) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.refresh(true);
    }, delay);
  }

  /**
   * Render a terminal "out of retries" error state. Bypasses Panel.showError
   * because calling that without an onRetry would re-fire the prior
   * retryCallback (Panel only replaces retryCallback when onRetry is
   * defined — passing undefined leaves the stale one in place and starts
   * a new countdown).
   *
   * setContent() sync-resets setErrorState(false), so we re-flip it AFTER
   * to keep the red header for the terminal error.
   */
  private renderTerminalError(): void {
    this.hideCountBadge();
    this.setContent(`
      <div class="panel-error-state" style="padding:24px 16px;text-align:center">
        <div class="panel-error-msg" style="color:var(--danger,#e0654b);font-size:13px">
          ${escapeHtml(t('common.failedTechReadiness'))}
        </div>
      </div>
    `);
    this.setErrorState(true);
  }

  private showSoftRefreshing(): void {
    // Soft empty state — distinct from showError() so the panel header
    // doesn't paint red on a benign empty payload. Caller schedules an
    // auto-retry; this is just the visual placeholder while we wait.
    this.hideCountBadge();
    this.setContent(`
      <div class="panel-soft-empty" style="padding:24px 16px;color:var(--text-dim);font-size:12px;text-align:center;line-height:1.5">
        <div style="font-size:20px;margin-bottom:8px">⌛</div>
        <div>${escapeHtml(t('components.techReadiness.dataPreparing'))}</div>
      </div>
    `);
  }

  private showFetchingState(): void {
    this.setContent(`
      <div class="tech-fetch-progress">
        <div class="tech-fetch-icon">
          <div class="tech-globe-ring"></div>
          <span class="tech-globe">🌐</span>
        </div>
        <div class="tech-fetch-title">${t('components.techReadiness.fetchingData')}</div>
        <div class="tech-fetch-indicators">
          <div class="tech-indicator-item" style="animation-delay: 0s">
            <span class="tech-indicator-icon">🌐</span>
            <span class="tech-indicator-name">${t('components.techReadiness.internetUsersIndicator')}</span>
            <span class="tech-indicator-status"></span>
          </div>
          <div class="tech-indicator-item" style="animation-delay: 0.2s">
            <span class="tech-indicator-icon">📱</span>
            <span class="tech-indicator-name">${t('components.techReadiness.mobileSubscriptionsIndicator')}</span>
            <span class="tech-indicator-status"></span>
          </div>
          <div class="tech-indicator-item" style="animation-delay: 0.4s">
            <span class="tech-indicator-icon">📡</span>
            <span class="tech-indicator-name">${t('components.techReadiness.broadbandAccess')}</span>
            <span class="tech-indicator-status"></span>
          </div>
          <div class="tech-indicator-item" style="animation-delay: 0.6s">
            <span class="tech-indicator-icon">🔬</span>
            <span class="tech-indicator-name">${t('components.techReadiness.rdExpenditure')}</span>
            <span class="tech-indicator-status"></span>
          </div>
        </div>
        <div class="tech-fetch-note">${t('components.techReadiness.analyzingCountries')}</div>
      </div>
    `);
  }

  private getFlag(countryCode: string): string {
    return COUNTRY_FLAGS[countryCode] || '🌐';
  }

  private getScoreClass(score: number): string {
    if (score >= 70) return 'high';
    if (score >= 40) return 'medium';
    return 'low';
  }

  private formatComponent(value: number | null): string {
    if (value === null) return '—';
    return Math.round(value).toString();
  }

  private render(): void {
    // Empty-result branch was removed: refresh() now routes empty payloads
    // through showSoftRefreshing() + scheduleRetry() and only calls render()
    // when there's data to show. Painting "no data available" via
    // showError() flipped the panel into red error styling and gave the
    // user no recovery path on a benign empty payload.
    const top = this.rankings.slice(0, 25);
    this.showCountBadge(this.rankings.length);

    const html = `
      <div class="tech-readiness-list">
        ${top.map(country => {
      const scoreClass = this.getScoreClass(country.score);
      return `
            <div class="readiness-item ${scoreClass}" data-country="${escapeHtml(country.country)}">
              <div class="readiness-rank">#${country.rank}</div>
              <div class="readiness-flag">${this.getFlag(country.country)}</div>
              <div class="readiness-info">
                <div class="readiness-name">${escapeHtml(country.countryName)}</div>
                <div class="readiness-components">
                  <span title="${t('components.techReadiness.internetUsers')}">🌐${this.formatComponent(country.components.internet)}</span>
                  <span title="${t('components.techReadiness.mobileSubscriptions')}">📱${this.formatComponent(country.components.mobile)}</span>
                  <span title="${t('components.techReadiness.rdSpending')}">🔬${this.formatComponent(country.components.rdSpend)}</span>
                </div>
              </div>
              <div class="readiness-score ${scoreClass}">${country.score}</div>
            </div>
          `;
    }).join('')}
      </div>
      <div class="readiness-footer">
        <span class="readiness-source">${t('components.techReadiness.source')}</span>
        <span class="readiness-updated">${t('components.techReadiness.updated', { date: new Date(this.lastFetch).toLocaleDateString() })}</span>
      </div>
    `;

    this.setContent(html);
  }
}
