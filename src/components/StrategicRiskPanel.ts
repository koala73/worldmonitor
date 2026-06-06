import { Panel } from './Panel';
import { escapeHtml } from '@/utils/sanitize';
import { t } from '@/services/i18n';
import { getCSSColor } from '@/utils';
import {
  calculateStrategicRiskOverview,
  getRecentAlerts,
  getAlertCount,
  type StrategicRiskOverview,
  type UnifiedAlert,
  type AlertPriority,
} from '@/services/cross-module-integration';
import { detectConvergence, type GeoConvergenceAlert } from '@/services/geo-convergence';
import {
  dataFreshness,
  getStatusColor,
  getStatusIcon,
  type DataSourceState,
  type DataFreshnessSummary,
} from '@/services/data-freshness';
import { getLearningProgress, type CountryScore } from '@/services/country-instability';
import { fetchCachedRiskScores, toCountryScore, type CachedRiskScores } from '@/services/cached-risk-scores';
import { getCachedPosture } from '@/services/cached-theater-posture';
import { refreshDataFreshnessFromHealth } from '@/services/health-freshness';
import { setTrustedHtml, trustedHtml } from '@/utils/dom-utils';

const STRATEGIC_RISK_BANDS = [
  { min: 70, levelKey: 'critical', colorVar: '--semantic-critical' },
  { min: 50, levelKey: 'elevated', colorVar: '--semantic-elevated' },
  { min: 30, levelKey: 'moderate', colorVar: '--semantic-normal' },
  { min: 0, levelKey: 'low', colorVar: '--semantic-low' },
] as const;

export class StrategicRiskPanel extends Panel {
  private overview: StrategicRiskOverview | null = null;
  private alerts: UnifiedAlert[] = [];
  private convergenceAlerts: GeoConvergenceAlert[] = [];
  private freshnessSummary: DataFreshnessSummary | null = null;
  private unsubscribeFreshness: (() => void) | null = null;
  private onLocationClick?: (lat: number, lon: number) => void;
  private usedCachedScores = false;
  private breakingAlerts: Map<string, { threatLevel: 'critical' | 'high'; timestamp: number }> = new Map();
  private boundOnBreaking: ((e: Event) => void) | null = null;
  private breakingExpiryTimer: ReturnType<typeof setTimeout> | null = null;
  private lastHealthFreshnessRefreshAt = 0;

  constructor() {
    super({
      id: 'strategic-risk',
      title: t('panels.strategicRisk'),
      showCount: false,
      trackActivity: true,
      infoTooltip: t('components.strategicRisk.infoTooltip'),
    });
    this.init();
  }

  private async init(): Promise<void> {
    this.showLoading();
    try {
      // Subscribe to data freshness changes - debounce to avoid excessive recalculations
      let refreshTimeout: ReturnType<typeof setTimeout> | null = null;
      this.unsubscribeFreshness = dataFreshness.subscribe(() => {
        // Debounce refresh to batch multiple rapid updates
        if (refreshTimeout) clearTimeout(refreshTimeout);
        refreshTimeout = setTimeout(() => {
          this.refresh();
        }, 500);
      });

      // Listen for breaking news events (dispatched on document)
      this.boundOnBreaking = (e: Event) => {
        const detail = (e as CustomEvent).detail;
        if (!detail?.id) return;
        const level = detail.threatLevel;
        if (level !== 'critical' && level !== 'high') return;
        this.breakingAlerts.set(detail.id, {
          threatLevel: level,
          timestamp: Date.now(),
        });
        this.refresh();
      };
      document.addEventListener('wm:breaking-news', this.boundOnBreaking);

      await this.refresh();
    } catch (error) {
      console.error('[StrategicRiskPanel] Init error:', error);
      this.showError(t('common.failedRiskOverview'), () => void this.refresh());
    }
  }

  private lastRiskFingerprint = '';

  public async refresh(): Promise<boolean> {
    void this.refreshHealthFreshness();
    this.freshnessSummary = dataFreshness.getSummary();
    this.convergenceAlerts = detectConvergence();

    // Prune stale breaking alerts (>30 min)
    const BREAKING_TTL = 30 * 60 * 1000;
    const now = Date.now();
    const cutoff = now - BREAKING_TTL;
    const staleIds: string[] = [];
    for (const [id, entry] of this.breakingAlerts) {
      if (entry.timestamp < cutoff) staleIds.push(id);
    }
    for (const id of staleIds) this.breakingAlerts.delete(id);

    // Schedule next expiry-driven refresh
    if (this.breakingExpiryTimer) clearTimeout(this.breakingExpiryTimer);
    if (this.breakingAlerts.size > 0) {
      let earliest = Infinity;
      for (const entry of this.breakingAlerts.values()) {
        if (entry.timestamp < earliest) earliest = entry.timestamp;
      }
      const msUntilExpiry = (earliest + BREAKING_TTL) - now + 500;
      this.breakingExpiryTimer = setTimeout(() => this.refresh(), Math.max(1000, msUntilExpiry));
    }

    // Severity-weighted score: critical=15, high=8
    let breakingScore = 0;
    for (const entry of this.breakingAlerts.values()) {
      breakingScore += entry.threatLevel === 'critical' ? 15 : 8;
    }
    breakingScore = Math.min(15, breakingScore);

    // Gather theater postures from cached service
    const cachedPosture = getCachedPosture();
    const postures = cachedPosture?.postures;
    const staleFactor = cachedPosture?.stale ? 0.5 : 1;

    // Prefer server/cached scores before calculating the overview so the
    // cross-module alert baseline is not seeded from local CII on first refresh.
    const { inLearning } = getLearningProgress();
    this.usedCachedScores = false;
    const cachedRiskScores = await fetchCachedRiskScores(this.signal);
    if (!this.element?.isConnected) return false;

    const localOverview = calculateStrategicRiskOverview(
      this.convergenceAlerts,
      postures ?? undefined,
      breakingScore,
      staleFactor
    );
    this.overview = localOverview;
    this.alerts = getRecentAlerts(24);

    if (cachedRiskScores?.strategicRisk) {
      this.applyCachedRiskOverview(cachedRiskScores, localOverview);
      this.usedCachedScores = true;
      console.log('[StrategicRiskPanel] Using cached scores from backend');
    } else if (inLearning || this.freshnessSummary.overallStatus === 'insufficient') {
      console.log('[StrategicRiskPanel] Cached backend scores unavailable; using local fallback');
    }

    const badgeDetail = this.freshnessSummary
      ? t('components.strategicRisk.sourcesDetail', {
        active: this.freshnessSummary.activeSources,
        total: this.freshnessSummary.totalSources,
      })
      : undefined;
    if (this.usedCachedScores) {
      this.setDataBadge('cached', badgeDetail);
    } else if (!this.freshnessSummary || this.freshnessSummary.activeSources === 0) {
      this.setDataBadge('unavailable');
    } else {
      this.setDataBadge('live', badgeDetail);
    }

    this.render();

    const alertIds = this.alerts.map(a => a.id).sort().join(',');
    const fp = `${this.overview?.compositeScore}|${this.overview?.trend}|${alertIds}`;
    const changed = fp !== this.lastRiskFingerprint;
    this.lastRiskFingerprint = fp;
    return changed;
  }

  private async refreshHealthFreshness(): Promise<void> {
    const now = Date.now();
    if (now - this.lastHealthFreshnessRefreshAt < 60_000) return;
    try {
      await refreshDataFreshnessFromHealth({ signal: this.signal });
    } catch (error) {
      // Health is additive; local session freshness remains useful if it fails.
      console.debug('[StrategicRiskPanel] Health freshness fetch failed (non-fatal)', error);
    } finally {
      this.lastHealthFreshnessRefreshAt = Date.now();
    }
  }

  private cachedTrendToOverviewTrend(trend: string): StrategicRiskOverview['trend'] {
    if (trend === 'rising' || trend === 'escalating') return 'escalating';
    if (trend === 'falling' || trend === 'de-escalating') return 'de-escalating';
    return 'stable';
  }

  private cachedTimestamp(cached: CachedRiskScores): Date | null {
    const raw = cached.strategicRisk.lastUpdated ?? cached.computedAt;
    if (!raw) return null;
    const parsed = new Date(raw);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  private cachedTopRisks(cached: CachedRiskScores, ciiScores: CountryScore[]): string[] {
    const contributors = cached.strategicRisk.contributors
      .filter((c) => c.score > 0)
      .slice(0, 5)
      .map((c) => `${c.country}: ${c.score} (${c.level})`);
    if (contributors.length > 0) return contributors;
    return ciiScores
      .filter((s) => s.score > 0)
      .slice(0, 5)
      .map((s) => `${s.name}: ${s.score} (${s.level})`);
  }

  private applyCachedRiskOverview(cached: CachedRiskScores, localOverview: StrategicRiskOverview): void {
    const ciiScores = cached.cii
      .map(toCountryScore)
      .sort((a, b) => b.score - a.score);

    this.overview = {
      ...localOverview,
      avgCIIDeviation: ciiScores[0]?.score ?? cached.strategicRisk.score,
      compositeScore: Math.max(0, Math.min(100, Math.round(cached.strategicRisk.score))),
      trend: this.cachedTrendToOverviewTrend(cached.strategicRisk.trend),
      topRisks: this.cachedTopRisks(cached, ciiScores),
      unstableCountries: ciiScores.filter(s => s.score >= 50).slice(0, 5),
      timestamp: this.cachedTimestamp(cached),
      degraded: cached.degraded,
      stale: cached.stale,
    };
  }

  private getScoreColor(score: number): string {
    return getCSSColor(this.getScoreBand(score).colorVar);
  }

  private getScoreLevel(score: number): string {
    return t(`components.strategicRisk.levels.${this.getScoreBand(score).levelKey}`);
  }

  private getScoreBand(score: number): typeof STRATEGIC_RISK_BANDS[number] {
    return STRATEGIC_RISK_BANDS.find((band) => score >= band.min) ?? STRATEGIC_RISK_BANDS[STRATEGIC_RISK_BANDS.length - 1]!;
  }

  private getTrendEmoji(trend: string): string {
    switch (trend) {
      case 'escalating': return '📈';
      case 'de-escalating': return '📉';
      default: return '➡️';
    }
  }

  private getTrendColor(trend: string): string {
    switch (trend) {
      case 'escalating': return getCSSColor('--semantic-critical');
      case 'de-escalating': return getCSSColor('--semantic-normal');
      default: return getCSSColor('--text-dim');
    }
  }


  private getPriorityColor(priority: AlertPriority): string {
    switch (priority) {
      case 'critical': return getCSSColor('--semantic-critical');
      case 'high': return getCSSColor('--semantic-high');
      case 'medium': return getCSSColor('--semantic-elevated');
      case 'low': return getCSSColor('--semantic-normal');
    }
  }

  private getPriorityEmoji(priority: AlertPriority): string {
    switch (priority) {
      case 'critical': return '🔴';
      case 'high': return '🟠';
      case 'medium': return '🟡';
      case 'low': return '🟢';
    }
  }

  private getTypeEmoji(type: string): string {
    switch (type) {
      case 'convergence': return '🎯';
      case 'cii_spike': return '📊';
      case 'cascade': return '🔗';
      case 'sanctions': return '🚫';
      case 'radiation': return '☢️';
      case 'composite': return '⚠️';
      default: return '📍';
    }
  }

  /**
   * Render when we have insufficient data - can't assess risk
   */
  private renderInsufficientData(): string {
    const sources = dataFreshness.getAllSources();
    const riskSources = sources.filter(s => s.requiredForRisk);

    return `
      <div class="strategic-risk-panel">
        <div class="risk-no-data">
          <div class="risk-no-data-icon">⚠️</div>
          <div class="risk-no-data-title">${t('components.strategicRisk.insufficientData')}</div>
          <div class="risk-no-data-desc">
            ${t('components.strategicRisk.unableToAssess')}<br>${t('components.strategicRisk.enableDataSources')}
          </div>
        </div>

        <div class="risk-section">
          <div class="risk-section-title">${t('components.strategicRisk.requiredDataSources')}</div>
          <div class="risk-sources">
            ${riskSources.map(source => this.renderSourceRow(source)).join('')}
          </div>
        </div>

        <div class="risk-section">
          <div class="risk-section-title">${t('components.strategicRisk.optionalSources')}</div>
          <div class="risk-sources">
            ${sources.filter(s => !s.requiredForRisk).slice(0, 4).map(source => this.renderSourceRow(source)).join('')}
          </div>
        </div>

        <div class="risk-actions">
          <button class="risk-action-btn risk-action-primary" data-action="enable-core">
            ${t('components.strategicRisk.enableCoreFeeds')}
          </button>
        </div>

        <div class="risk-footer">
          <span class="risk-updated">${t('components.strategicRisk.waitingForData')}</span>
          <button class="risk-refresh-btn">${t('components.strategicRisk.refresh')}</button>
        </div>
      </div>
    `;
  }


  /**
   * Render full data view - normal operation
   */
  private renderFullData(): string {
    if (!this.overview || !this.freshnessSummary) return '';

    const score = this.overview.compositeScore;
    const color = this.getScoreColor(score);
    const level = this.getScoreLevel(score);
    const scoreDeg = Math.round((score / 100) * 270);

    // Check for learning mode - skip if using cached scores
    const { inLearning, remainingMinutes, progress } = getLearningProgress();
    const showLearning = inLearning && !this.usedCachedScores;
    // Only show status banner when there's something to report (learning mode)
    const statusBanner = showLearning
      ? `<div class="risk-status-banner risk-status-learning">
          <span class="risk-status-icon">📊</span>
          <span class="risk-status-text">${t('components.strategicRisk.learningMode', { minutes: String(remainingMinutes) })}</span>
          <div class="learning-progress-mini">
            <div class="learning-bar" style="width: ${progress}%"></div>
          </div>
        </div>`
      : '';
    const cacheStateBanner = this.renderCachedRiskStateBanner();

    return `
      <div class="strategic-risk-panel">
        ${statusBanner}
        ${cacheStateBanner}

        <div class="risk-gauge">
          <div class="risk-score-container">
            <div class="risk-score-ring" style="--score-color: ${color}; --score-deg: ${scoreDeg}deg;">
              <div class="risk-score-inner">
                <div class="risk-score" style="color: ${color}">${score}</div>
                <div class="risk-level" style="color: ${color}">${level}</div>
              </div>
            </div>
          </div>
          <div class="risk-trend-container">
            <span class="risk-trend-label">${t('components.strategicRisk.trend')}</span>
            <div class="risk-trend" style="color: ${this.getTrendColor(this.overview.trend)}">
              ${this.getTrendEmoji(this.overview.trend)} ${this.overview.trend === 'escalating' ? t('components.strategicRisk.trends.escalating') : this.overview.trend === 'de-escalating' ? t('components.strategicRisk.trends.deEscalating') : t('components.strategicRisk.trends.stable')}
            </div>
          </div>
        </div>

        ${this.renderMetrics()}
        ${this.renderFreshnessSurface()}
        ${this.renderTopRisks()}
        ${this.renderRecentAlerts()}

        <div class="risk-footer">
          <span class="risk-updated">${t('components.strategicRisk.updated', { time: this.formatOverviewTimestamp() })}</span>
          <button class="risk-refresh-btn">${t('components.strategicRisk.refresh')}</button>
        </div>
      </div>
    `;
  }

  private renderCachedRiskStateBanner(): string {
    if (!this.overview || (!this.overview.degraded && !this.overview.stale)) return '';
    const labels = [
      this.overview.degraded ? t('components.strategicRisk.sourceStates.degraded') : '',
      this.overview.stale ? t('components.strategicRisk.sourceStates.stale') : '',
    ].filter(Boolean);
    return `<div class="risk-status-banner risk-status-cached">
      <span class="risk-status-icon">!</span>
      <span class="risk-status-text">${t('components.strategicRisk.cachedCiiStatus', { states: labels.join(' · ') })}</span>
    </div>`;
  }

  private renderSourceRow(source: DataSourceState): string {
    const panelId = dataFreshness.getPanelIdForSource(source.id);
    const timeSince = dataFreshness.getTimeSince(source.id);

    return `
      <div class="risk-source-row">
        <span class="risk-source-status" style="color: ${getStatusColor(source.status)}">
          ${getStatusIcon(source.status)}
        </span>
        <span class="risk-source-name">${escapeHtml(source.name)}</span>
        <span class="risk-source-time">${source.status === 'no_data' ? t('components.strategicRisk.noData') : timeSince}</span>
        ${panelId && (source.status === 'no_data' || source.status === 'disabled') ? `
          <button class="risk-source-enable" data-panel="${panelId}">${t('components.strategicRisk.enable')}</button>
        ` : ''}
      </div>
    `;
  }

  private renderFreshnessSurface(): string {
    if (!this.freshnessSummary) return '';
    const sources = dataFreshness.getAllSources()
      .filter(source => source.status !== 'no_data' && source.status !== 'disabled')
      .sort((a, b) => {
        const order: Record<string, number> = { error: 0, very_stale: 1, stale: 2, fresh: 3 };
        return (order[a.status] ?? 4) - (order[b.status] ?? 4);
      })
      .slice(0, 6);

    if (sources.length === 0) return '';
    return `
      <div class="risk-section">
        <div class="risk-section-title">${t('components.strategicRisk.dataFreshness')}</div>
        <div class="risk-sources-compact">
          ${sources.map(source => `
            <span class="risk-source-chip" title="${escapeHtml(source.healthStatus || source.status)}" style="border-color: ${getStatusColor(source.status)}">
              <span class="risk-source-dot" style="color: ${getStatusColor(source.status)}">${getStatusIcon(source.status)}</span>
              <span class="risk-source-name">${escapeHtml(source.name)}</span>
              <span class="risk-source-time">${escapeHtml(dataFreshness.getTimeSince(source.id))}</span>
            </span>
          `).join('')}
        </div>
      </div>
    `;
  }

  private renderMetrics(): string {
    if (!this.overview) return '';

    const alertCounts = getAlertCount();

    return `
      <div class="risk-metrics">
        <div class="risk-metric">
          <span class="risk-metric-value">${this.overview.convergenceAlerts}</span>
          <span class="risk-metric-label">${t('components.strategicRisk.convergenceMetric')}</span>
        </div>
        <div class="risk-metric">
          <span class="risk-metric-value">${this.overview.avgCIIDeviation.toFixed(1)}</span>
          <span class="risk-metric-label">${t('components.strategicRisk.ciiDeviation')}</span>
        </div>
        <div class="risk-metric">
          <span class="risk-metric-value">${this.overview.infrastructureIncidents}</span>
          <span class="risk-metric-label">${t('components.strategicRisk.infraEvents')}</span>
        </div>
        <div class="risk-metric">
          <span class="risk-metric-value">${alertCounts.critical + alertCounts.high}</span>
          <span class="risk-metric-label">${t('components.strategicRisk.highAlerts')}</span>
        </div>
      </div>
    `;
  }

  private renderTopRisks(): string {
    if (!this.overview || this.overview.topRisks.length === 0) {
      return `<div class="risk-empty">${t('components.strategicRisk.noRisks')}</div>`;
    }

    // Get convergence zone for first risk if available
    const topZone = this.overview.topConvergenceZones[0];

    return `
      <div class="risk-section">
        <div class="risk-section-title">${t('components.strategicRisk.topRisks')}</div>
        <div class="risk-list">
          ${this.overview.topRisks.map((risk, i) => {
      // First risk is convergence - make it clickable if we have location
      const isConvergence = i === 0 && risk.startsWith('Convergence:') && topZone;
      if (isConvergence) {
        return `
                <div class="risk-item risk-item-clickable" data-lat="${topZone.lat}" data-lon="${topZone.lon}">
                  <span class="risk-rank">${i + 1}.</span>
                  <span class="risk-text">${escapeHtml(risk)}</span>
                  <span class="risk-location-icon">↗</span>
                </div>
              `;
      }
      return `
              <div class="risk-item">
                <span class="risk-rank">${i + 1}.</span>
                <span class="risk-text">${escapeHtml(risk)}</span>
              </div>
            `;
    }).join('')}
        </div>
      </div>
    `;
  }

  private renderRecentAlerts(): string {
    if (this.alerts.length === 0) {
      return '';
    }

    const displayAlerts = this.alerts.slice(0, 5);

    return `
      <div class="risk-section">
        <div class="risk-section-title">${t('components.strategicRisk.recentAlerts', { count: String(this.alerts.length) })}</div>
        <div class="risk-alerts">
          ${displayAlerts.map(alert => {
      const hasLocation = alert.location?.lat && alert.location.lon;
      const clickableClass = hasLocation ? 'risk-alert-clickable' : '';
      const locationAttrs = hasLocation
        ? `data-lat="${alert.location!.lat}" data-lon="${alert.location!.lon}"`
        : '';

      return `
              <div class="risk-alert ${clickableClass}" style="border-left: 3px solid ${this.getPriorityColor(alert.priority)}" ${locationAttrs}>
                <div class="risk-alert-header">
                  <span class="risk-alert-type">${this.getTypeEmoji(alert.type)}</span>
                  <span class="risk-alert-priority">${this.getPriorityEmoji(alert.priority)}</span>
                  <span class="risk-alert-title">${escapeHtml(alert.title)}</span>
                  ${hasLocation ? '<span class="risk-location-icon">↗</span>' : ''}
                </div>
                <div class="risk-alert-summary">${escapeHtml(alert.summary)}</div>
                <div class="risk-alert-time">${this.formatTime(alert.timestamp)}</div>
              </div>
            `;
    }).join('')}
        </div>
      </div>
    `;
  }

  private formatTime(date: Date): string {
    const now = new Date();
    const diff = now.getTime() - date.getTime();
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(minutes / 60);

    if (minutes < 1) return t('components.strategicRisk.time.justNow');
    if (minutes < 60) return t('components.strategicRisk.time.minutesAgo', { count: String(minutes) });
    if (hours < 24) return t('components.strategicRisk.time.hoursAgo', { count: String(hours) });
    return date.toLocaleDateString();
  }

  private formatOverviewTimestamp(): string {
    return this.overview?.timestamp ? this.overview.timestamp.toLocaleTimeString() : '&mdash;';
  }

  private render(): void {
    this.freshnessSummary = dataFreshness.getSummary();

    try {
      if (!this.overview) {
        this.showLoading();
        return;
      }

      // Render full data view — partial data is handled gracefully by CII baselines
      // Only show insufficient state if zero sources after 60s (true failure)
      const uptime = performance.now();
      const html =
        this.freshnessSummary.overallStatus === 'insufficient' && uptime > 60_000 && !this.usedCachedScores
          ? this.renderInsufficientData()
          : this.renderFullData();

      setTrustedHtml(this.content, trustedHtml(html, "legacy direct innerHTML migration"));
      this.attachEventListeners();
    } catch (e: unknown) {
      console.error('[StrategicRiskPanel] Render error:', e);
      this.showError(t('common.failedRiskOverview'), () => this.refresh());
    }
  }

  private attachEventListeners(): void {
    // Refresh button
    const refreshBtn = this.content.querySelector('.risk-refresh-btn');
    if (refreshBtn) {
      refreshBtn.addEventListener('click', () => this.refresh());
    }

    // Enable source buttons
    const enableBtns = this.content.querySelectorAll('.risk-source-enable');
    enableBtns.forEach(btn => {
      btn.addEventListener('click', (e) => {
        const panelId = (e.target as HTMLElement).dataset.panel;
        if (panelId) {
          this.emitEnablePanel(panelId);
        }
      });
    });

    // Action buttons
    const actionBtns = this.content.querySelectorAll('.risk-action-btn');
    actionBtns.forEach(btn => {
      btn.addEventListener('click', (e) => {
        const action = (e.target as HTMLElement).dataset.action;
        if (action === 'enable-core') {
          this.emitEnablePanels(['protests', 'intel', 'live-news']);
        } else if (action === 'enable-all') {
          this.emitEnablePanels(['protests', 'intel', 'live-news', 'military', 'shipping']);
        }
      });
    });

    // Clickable risk items (convergence zones)
    const clickableRisks = this.content.querySelectorAll('.risk-item-clickable');
    clickableRisks.forEach(item => {
      item.addEventListener('click', () => {
        const lat = parseFloat((item as HTMLElement).dataset.lat || '0');
        const lon = parseFloat((item as HTMLElement).dataset.lon || '0');
        if (this.onLocationClick && !Number.isNaN(lat) && !Number.isNaN(lon)) {
          this.onLocationClick(lat, lon);
        }
      });
    });

    // Clickable alerts with location
    const clickableAlerts = this.content.querySelectorAll('.risk-alert-clickable');
    clickableAlerts.forEach(alert => {
      alert.addEventListener('click', () => {
        const lat = parseFloat((alert as HTMLElement).dataset.lat || '0');
        const lon = parseFloat((alert as HTMLElement).dataset.lon || '0');
        if (this.onLocationClick && !Number.isNaN(lat) && !Number.isNaN(lon)) {
          this.onLocationClick(lat, lon);
        }
      });
    });
  }

  private emitEnablePanel(panelId: string): void {
    window.dispatchEvent(new CustomEvent('enable-panel', { detail: { panelId } }));
  }

  private emitEnablePanels(panelIds: string[]): void {
    panelIds.forEach(id => this.emitEnablePanel(id));
  }

  public destroy(): void {
    if (this.boundOnBreaking) {
      document.removeEventListener('wm:breaking-news', this.boundOnBreaking);
      this.boundOnBreaking = null;
    }
    if (this.breakingExpiryTimer) {
      clearTimeout(this.breakingExpiryTimer);
      this.breakingExpiryTimer = null;
    }
    if (this.unsubscribeFreshness) {
      this.unsubscribeFreshness();
    }
    super.destroy();
  }

  public getOverview(): StrategicRiskOverview | null {
    return this.overview;
  }

  public getAlerts(): UnifiedAlert[] {
    return this.alerts;
  }

  public setLocationClickHandler(handler: (lat: number, lon: number) => void): void {
    this.onLocationClick = handler;
  }
}
