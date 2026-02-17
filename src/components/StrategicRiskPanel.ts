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
import { getLearningProgress } from '@/services/country-instability';
import { fetchCachedRiskScores } from '@/services/cached-risk-scores';

export class StrategicRiskPanel extends Panel {
  private overview: StrategicRiskOverview | null = null;
  private alerts: UnifiedAlert[] = [];
  private convergenceAlerts: GeoConvergenceAlert[] = [];
  private freshnessSummary: DataFreshnessSummary | null = null;
  private refreshInterval: ReturnType<typeof setInterval> | null = null;
  private unsubscribeFreshness: (() => void) | null = null;
  private onLocationClick?: (lat: number, lon: number) => void;
  private usedCachedScores = false;

  constructor() {
    super({
      id: 'strategic-risk',
      title: t('panels.strategicRisk'),
      showCount: false,
      trackActivity: true,
      infoTooltip: `<strong>Methodology</strong>
        Composite score (0-100) blending:
        <ul>
          <li>50% Country Instability (top 5 weighted)</li>
          <li>30% Geographic convergence zones</li>
          <li>20% Infrastructure incidents</li>
        </ul>
        Auto-refreshes every 5 minutes.`,
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
      await this.refresh();
      this.startAutoRefresh();
    } catch (error) {
      console.error('[StrategicRiskPanel] Init error:', error);
      this.showError(t('common.failedRiskOverview'));
    }
  }

  private startAutoRefresh(): void {
    this.refreshInterval = setInterval(() => this.refresh(), 5 * 60 * 1000);
  }

  public async refresh(): Promise<void> {
    this.freshnessSummary = dataFreshness.getSummary();
    this.convergenceAlerts = detectConvergence();
    this.overview = calculateStrategicRiskOverview(this.convergenceAlerts);
    this.alerts = getRecentAlerts(24);

    // Try to get cached scores during learning mode
    const { inLearning } = getLearningProgress();
    this.usedCachedScores = false;
    if (inLearning) {
      const cached = await fetchCachedRiskScores();
      if (cached && cached.strategicRisk) {
        this.usedCachedScores = true;
        console.log('[StrategicRiskPanel] Using cached scores from backend');
      }
    }

    if (!this.freshnessSummary || this.freshnessSummary.activeSources === 0) {
      this.setDataBadge('unavailable');
    } else if (this.usedCachedScores) {
      this.setDataBadge('cached');
    } else {
      this.setDataBadge('live');
    }

    this.render();
  }

  private getScoreColor(score: number): string {
    if (score >= 70) return getCSSColor('--semantic-critical');
    if (score >= 50) return getCSSColor('--semantic-high');
    if (score >= 30) return getCSSColor('--semantic-elevated');
    return getCSSColor('--semantic-normal');
  }

  private getScoreLevel(score: number): string {
    if (score >= 70) return 'Critical';
    if (score >= 50) return 'Elevated';
    if (score >= 30) return 'Moderate';
    return 'Low';
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
          <div class="risk-no-data-title">Insufficient Data</div>
          <div class="risk-no-data-desc">
            Unable to assess risk level.<br>
            Enable data sources to begin monitoring.
          </div>
        </div>

        <div class="risk-section">
          <div class="risk-section-title">Required Data Sources</div>
          <div class="risk-sources">
            ${riskSources.map(source => this.renderSourceRow(source)).join('')}
          </div>
        </div>

        <div class="risk-section">
          <div class="risk-section-title">Optional Sources</div>
          <div class="risk-sources">
            ${sources.filter(s => !s.requiredForRisk).slice(0, 4).map(source => this.renderSourceRow(source)).join('')}
          </div>
        </div>

        <div class="risk-actions">
          <button class="risk-action-btn risk-action-primary" data-action="enable-core">
            Enable Core Feeds
          </button>
        </div>

        <div class="risk-footer">
          <span class="risk-updated">Waiting for data...</span>
          <button class="risk-refresh-btn">Refresh</button>
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
          <span class="risk-status-text">Learning Mode - ${remainingMinutes}m until reliable</span>
          <div class="learning-progress-mini">
            <div class="learning-bar" style="width: ${progress}%"></div>
          </div>
        </div>`
      : '';

    return `
      <div class="strategic-risk-panel">
        ${statusBanner}

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
            <span class="risk-trend-label">Trend</span>
            <div class="risk-trend" style="color: ${this.getTrendColor(this.overview.trend)}">
              ${this.getTrendEmoji(this.overview.trend)} ${this.overview.trend.charAt(0).toUpperCase() + this.overview.trend.slice(1)}
            </div>
          </div>
        </div>

        ${this.renderMetrics()}
        ${this.renderTopRisks()}
        ${this.renderRecentAlerts()}

        <div class="risk-footer">
          <span class="risk-updated">Updated: ${this.overview.timestamp.toLocaleTimeString()}</span>
          <button class="risk-refresh-btn">Refresh</button>
        </div>
      </div>
    `;
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
        <span class="risk-source-time">${source.status === 'no_data' ? 'no data' : timeSince}</span>
        ${panelId && (source.status === 'no_data' || source.status === 'disabled') ? `
          <button class="risk-source-enable" data-panel="${panelId}">Enable</button>
        ` : ''}
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
          <span class="risk-metric-label">Convergence</span>
        </div>
        <div class="risk-metric">
          <span class="risk-metric-value">${this.overview.avgCIIDeviation.toFixed(1)}</span>
          <span class="risk-metric-label">CII Deviation</span>
        </div>
        <div class="risk-metric">
          <span class="risk-metric-value">${this.overview.infrastructureIncidents}</span>
          <span class="risk-metric-label">Infra Events</span>
        </div>
        <div class="risk-metric">
          <span class="risk-metric-value">${alertCounts.critical + alertCounts.high}</span>
          <span class="risk-metric-label">High Alerts</span>
        </div>
      </div>
    `;
  }

  private renderTopRisks(): string {
    if (!this.overview || this.overview.topRisks.length === 0) {
      return '<div class="risk-empty">No significant risks detected</div>';
    }

    // Get convergence zone for first risk if available
    const topZone = this.overview.topConvergenceZones[0];

    return `
      <div class="risk-section">
        <div class="risk-section-title">Top Risks</div>
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
        <div class="risk-section-title">Recent Alerts (${this.alerts.length})</div>
        <div class="risk-alerts">
          ${displayAlerts.map(alert => {
      const hasLocation = alert.location && alert.location.lat && alert.location.lon;
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

    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes}m ago`;
    if (hours < 24) return `${hours}h ago`;
    return date.toLocaleDateString();
  }

  private render(): void {
    this.freshnessSummary = dataFreshness.getSummary();

    if (!this.overview) {
      this.showLoading();
      return;
    }

    // Render full data view — partial data is handled gracefully by CII baselines
    // Only show insufficient state if zero sources after 60s (true failure)
    let html: string;
    const uptime = performance.now();
    if (this.freshnessSummary.overallStatus === 'insufficient' && uptime > 60_000) {
      html = this.renderInsufficientData();
    } else {
      html = this.renderFullData();
    }

    this.content.innerHTML = html;
    this.attachEventListeners();
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
        if (this.onLocationClick && !isNaN(lat) && !isNaN(lon)) {
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
        if (this.onLocationClick && !isNaN(lat) && !isNaN(lon)) {
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
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
    }
    if (this.unsubscribeFreshness) {
      this.unsubscribeFreshness();
    }
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
