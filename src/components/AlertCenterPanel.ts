import { Panel } from './Panel';
import type { CorrelationSignal } from '@/services/correlation';
import { getRecentSignals } from '@/services/correlation';
import { getRecentBreakingAlerts, type BreakingAlert } from '@/services/breaking-news-alerts';
import { t } from '@/services/i18n';
import type { EvidencePack } from '@/services/evidence-pack';
import { EvidenceDrawer } from './EvidenceDrawer';

interface AlertEntry {
  id: string;
  kind: 'breaking' | 'signal';
  title: string;
  description: string;
  severity: 'critical' | 'high' | 'medium' | 'info';
  timestamp: Date;
  placeSummary?: string;
  link?: string;
  evidence?: EvidencePack;
}

export class AlertCenterPanel extends Panel {
  private alerts: AlertEntry[] = [];
  private lastViewedAt: number = Date.now();
  private readonly boundOnBreaking: (e: Event) => void;
  private readonly boundOnClick: (e: Event) => void;
  private readonly evidenceDrawer = new EvidenceDrawer();

  constructor() {
    super({
      id: 'alert-center',
      title: t('panels.alertCenter'),
      showCount: true,
      trackActivity: true,
      infoTooltip: 'Persistent history of intelligence signals and breaking alerts — last 100 events.',
    });

    const recentBreakingAlerts = getRecentBreakingAlerts();
    if (recentBreakingAlerts.length > 0) {
      this.ingestBreakingAlerts(recentBreakingAlerts);
    }

    // Seed with any recent signals already in the history buffer
    const recent = getRecentSignals();
    if (recent.length > 0) {
      this.ingestSignals(recent);
    }

    // Listen for live breaking alerts dispatched by breaking-news-alerts.ts
    this.boundOnBreaking = (e: Event) => {
      const alert = (e as CustomEvent<BreakingAlert>).detail;
      const entry: AlertEntry = {
        id: alert.id,
        kind: 'breaking',
        title: alert.headline,
        description: `${alert.origin.replace(/_/g, ' ')} · ${alert.source}`,
        severity: alert.threatLevel,
        timestamp: alert.timestamp,
        placeSummary: alert.placeSummary,
        link: alert.link,
        evidence: alert.evidence,
      };
      this.ingestEntries([entry]);
    };
    document.addEventListener('wm:breaking-news', this.boundOnBreaking);

    this.boundOnClick = (e: Event) => {
      const target = e.target as HTMLElement;
      const whyBtn = target.closest('.ac-why-btn') as HTMLElement | null;
      if (!whyBtn) return;

      e.preventDefault();
      e.stopPropagation();

      const alertId = whyBtn.dataset.alertId;
      if (!alertId) return;
      const entry = this.alerts.find((item) => item.id === alertId);
      if (!entry?.evidence) return;

      this.evidenceDrawer.show({
        title: entry.title,
        subtitle: entry.description,
        evidence: entry.evidence,
      });
    };
    this.content.addEventListener('click', this.boundOnClick);

    // Reset unread badge when user interacts with the panel
    this.element.addEventListener('click', () => {
      this.lastViewedAt = Date.now();
      this.setCount(0);
    });

    this.render();
  }

  /** Called from data-loader after addToSignalHistory() */
  public addSignals(signals: CorrelationSignal[]): void {
    this.ingestSignals(signals);
  }

  override destroy(): void {
    document.removeEventListener('wm:breaking-news', this.boundOnBreaking);
    this.content.removeEventListener('click', this.boundOnClick);
    super.destroy();
  }

  private ingestSignals(signals: CorrelationSignal[]): void {
    const entries: AlertEntry[] = signals.map(s => ({
      id: s.id,
      kind: 'signal' as const,
      title: s.title,
      description: s.description,
      severity: signalSeverity(s),
      timestamp: s.timestamp,
      placeSummary: typeof s.data.placeSummary === 'string' ? s.data.placeSummary : undefined,
      evidence: s.evidence,
    }));
    this.ingestEntries(entries);
  }

  private ingestBreakingAlerts(alerts: BreakingAlert[]): void {
    const entries: AlertEntry[] = alerts.map((alert) => ({
      id: alert.id,
      kind: 'breaking',
      title: alert.headline,
      description: `${alert.origin.replace(/_/g, ' ')} · ${alert.source}`,
      severity: alert.threatLevel,
      timestamp: alert.timestamp,
      placeSummary: alert.placeSummary,
      link: alert.link,
      evidence: alert.evidence,
    }));
    this.ingestEntries(entries);
  }

  private ingestEntries(entries: AlertEntry[]): void {
    // Dedupe by id
    const existingIds = new Set(this.alerts.map(a => a.id));
    const fresh = entries.filter(e => !existingIds.has(e.id));
    if (fresh.length === 0) return;

    this.alerts.unshift(...fresh);
    if (this.alerts.length > 100) {
      this.alerts.splice(100); // drop oldest entries in-place, no re-allocation
    }

    const unread = this.alerts.filter(a => a.timestamp.getTime() > this.lastViewedAt).length;
    this.setCount(unread);
    this.render();
  }

  /** Called when the panel becomes visible/active — reset unread badge */
  onActivate(): void {
    this.lastViewedAt = Date.now();
    this.setCount(0);
  }

  private render(): void {
    if (this.alerts.length === 0) {
      this.setContent('<div class="panel-empty">No alerts in the past 30 minutes.</div>');
      return;
    }

    // Breaking alerts pinned first, then signals sorted newest-first
    const breaking = this.alerts.filter(a => a.kind === 'breaking');
    const signals = this.alerts.filter(a => a.kind === 'signal');

    const rows = [...breaking, ...signals].map(a => {
      const pill = severityPill(a.severity);
      const ago = timeAgo(a.timestamp);
      // Only allow https:// links to prevent javascript: or data: href injection
      const safeLink = a.link?.startsWith('https://') ? a.link : null;
      const title = safeLink
        ? `<a href="${escHtml(safeLink)}" target="_blank" rel="noopener noreferrer">${escHtml(a.title)}</a>`
        : escHtml(a.title);
      const detail = a.placeSummary ? `${a.description} · ${a.placeSummary}` : a.description;
      const whyButton = a.evidence
        ? `<button class="ac-why-btn" data-alert-id="${escHtml(a.id)}" type="button">Why</button>`
        : '';
      return `<tr class="${rowClass(a.severity)}">
        <td class="ac-sev">${pill}</td>
        <td class="ac-title">${title}</td>
        <td class="ac-desc"><div>${escHtml(detail)}</div>${whyButton}</td>
        <td class="ac-age">${ago}</td>
      </tr>`;
    }).join('');

    this.setContent(`
      <div class="ct-panel-content">
        <table class="eq-table ct-table">
          <thead>
            <tr>
              <th>Level</th>
              <th>Alert</th>
              <th>Detail</th>
              <th>Age</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
        <div class="fires-footer">
          <span class="fires-source">Intelligence signals · Breaking alerts</span>
          <span class="fires-updated">${this.alerts.length} event${this.alerts.length === 1 ? '' : 's'}</span>
        </div>
      </div>
    `);
  }
}

function severityPill(s: AlertEntry['severity']): string {
  const labels: Record<AlertEntry['severity'], string> = {
    critical: 'CRIT',
    high: 'HIGH',
    medium: 'MED',
    info: 'INFO',
  };
  return `<span class="ac-pill ac-pill-${s}">${labels[s]}</span>`;
}

function signalSeverity(signal: CorrelationSignal): AlertEntry['severity'] {
  if (signal.confidence > 0.8) return 'high';
  if (signal.confidence > 0.65) return 'medium';
  return 'info';
}

function rowClass(s: AlertEntry['severity']): string {
  return { critical: 'eq-row eq-major', high: 'eq-row eq-strong', medium: 'eq-row eq-moderate', info: 'eq-row' }[s] ?? 'eq-row';
}

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function timeAgo(d: Date): string {
  try {
    const secs = Math.floor((Date.now() - d.getTime()) / 1000);
    if (secs < 0) return 'now';
    if (secs < 60) return `${secs}s ago`;
    const mins = Math.floor(secs / 60);
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return `${Math.floor(hrs / 24)}d ago`;
  } catch {
    return '—';
  }
}
