import { Panel } from './Panel';
import { escapeHtml } from '@/utils/sanitize';
import { t } from '@/services/i18n';
import { fetchOrefHistory } from '@/services/oref-alerts';
import type { OrefAlertsResponse, OrefAlert, OrefHistoryEntry } from '@/services/oref-alerts';

const MAX_HISTORY_WAVES = 50;
const ONE_HOUR_MS = 60 * 60 * 1000;
const HISTORY_TTL = 3 * 60 * 1000;

export class OrefSirensPanel extends Panel {
  private alerts: OrefAlert[] = [];
  private historyCount24h = 0;
  private historyWaves: OrefHistoryEntry[] = [];
  private historyFetchInFlight = false;
  private historyLastFetchAt = 0;

  constructor() {
    super({
      id: 'oref-sirens',
      title: t('panels.orefSirens'),
      showCount: true,
      trackActivity: true,
      infoTooltip: t('components.orefSirens.infoTooltip'),
    });
    this.showLoading(t('components.orefSirens.checking'));
  }

  public setData(data: OrefAlertsResponse): void {
    if (!data.configured) {
      this.setContent(`<div class="panel-empty">${t('components.orefSirens.notConfigured')}</div>`);
      this.setCount(0);
      return;
    }

    const prevCount = this.alerts.length;
    this.alerts = data.alerts || [];
    this.historyCount24h = data.historyCount24h || 0;
    this.setCount(this.alerts.length || this.historyCount24h);

    if (prevCount === 0 && this.alerts.length > 0) {
      this.setNewBadge(this.alerts.length);
    }

    this.render();
    this.loadHistory();
  }

  private loadHistory(): void {
    if (this.historyFetchInFlight) return;
    if (Date.now() - this.historyLastFetchAt < HISTORY_TTL) return;
    this.historyFetchInFlight = true;
    this.historyLastFetchAt = Date.now();
    fetchOrefHistory()
      .then(resp => {
        if (resp.history?.length) {
          this.historyWaves = resp.history;
          this.render();
        }
      })
      .catch((err) => { console.warn('[OrefSirensPanel] History fetch failed:', err); })
      .finally(() => { this.historyFetchInFlight = false; });
  }

  private formatAlertTime(dateStr: string): string {
    try {
      const ts = new Date(dateStr).getTime();
      if (!Number.isFinite(ts)) return '';
      const diff = Date.now() - ts;
      if (diff < 60_000) return t('components.orefSirens.justNow');
      const mins = Math.floor(diff / 60_000);
      if (mins < 60) return `${mins}m`;
      const hours = Math.floor(mins / 60);
      if (hours < 24) return `${hours}h`;
      return `${Math.floor(hours / 24)}d`;
    } catch {
      return '';
    }
  }

  private formatWaveTime(dateStr: string): string {
    try {
      const d = new Date(dateStr);
      if (!Number.isFinite(d.getTime())) return '';
      return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
        + ' ' + d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    } catch {
      return '';
    }
  }

  private renderHistoryWaves(): string {
    if (!this.historyWaves.length) {
      if (this.historyCount24h > 0) {
        return `<div class="oref-history-section">
          <div class="oref-history-title">${t('components.orefSirens.historySummary', { count: String(this.historyCount24h), waves: '...' })}</div>
          <div class="oref-wave-list" style="opacity:0.5;text-align:center;padding:8px">${t('components.orefSirens.loadingHistory', { defaultValue: 'Loading history...' })}</div>
        </div>`;
      }
      return '';
    }

    const now = Date.now();
    const withTs = this.historyWaves.map(w => ({ wave: w, ts: new Date(w.timestamp).getTime() }));
    withTs.sort((a, b) => b.ts - a.ts);
    const sorted = withTs.slice(0, MAX_HISTORY_WAVES);

    const rows = sorted.map(({ wave, ts }) => {
      const isRecent = now - ts < ONE_HOUR_MS;
      const rowClass = isRecent ? 'oref-wave-row oref-wave-recent' : 'oref-wave-row';
      const badge = isRecent ? '<span class="oref-recent-badge">RECENT</span>' : '';
      const types = wave.alerts.map(a => escapeHtml(a.title || a.cat));
      const uniqueTypes = [...new Set(types)];
      const totalAreas = wave.alerts.reduce((sum, a) => sum + (a.data?.length || 0), 0);
      const summary = uniqueTypes.join(', ') + (totalAreas > 0 ? ` — ${totalAreas} areas` : '');

      return `<div class="${rowClass}">
        <div class="oref-wave-header">
          <span class="oref-wave-time">${this.formatWaveTime(wave.timestamp)}</span>
          ${badge}
        </div>
        <div class="oref-wave-summary">${summary}</div>
      </div>`;
    }).join('');

    return `<div class="oref-history-section">
      <div class="oref-history-title">${t('components.orefSirens.historySummary', { count: String(this.historyCount24h), waves: String(sorted.length) })}</div>
      <div class="oref-wave-list">${rows}</div>
    </div>`;
  }

  private render(): void {
    const historyHtml = this.renderHistoryWaves();

    if (this.alerts.length === 0) {
      this.setContent(`
        <div class="oref-panel-content">
          <div class="oref-status oref-ok">
            <span class="oref-status-icon">&#x2705;</span>
            <span>${t('components.orefSirens.noAlerts')}</span>
          </div>
          ${historyHtml}
        </div>
      `);
      return;
    }

    const alertRows = this.alerts.slice(0, 20).map(alert => {
      const areas = (alert.data || []).map(a => escapeHtml(a)).join(', ');
      const time = this.formatAlertTime(alert.alertDate);
      return `<div class="oref-alert-row">
        <div class="oref-alert-header">
          <span class="oref-alert-title">${escapeHtml(alert.title || alert.cat)}</span>
          <span class="oref-alert-time">${time}</span>
        </div>
        <div class="oref-alert-areas">${areas}</div>
      </div>`;
    }).join('');

    this.setContent(`
      <div class="oref-panel-content">
        <div class="oref-status oref-danger">
          <span class="oref-pulse"></span>
          <span>${t('components.orefSirens.activeSirens', { count: String(this.alerts.length) })}</span>
        </div>
        <div class="oref-list">${alertRows}</div>
        ${historyHtml}
      </div>
    `);
  }
}
