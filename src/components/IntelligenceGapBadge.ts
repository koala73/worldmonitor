import { getRecentSignals, type CorrelationSignal } from '@/services/correlation';
import { getRecentAlerts, type UnifiedAlert } from '@/services/cross-module-integration';
import { t } from '@/services/i18n';
import { getSignalContext } from '@/utils/analysis-constants';
import { escapeHtml } from '@/utils/sanitize';

const LOW_COUNT_THRESHOLD = 3;
const MAX_VISIBLE_FINDINGS = 10;
const SORT_TIME_TOLERANCE_MS = 60000;
const REFRESH_INTERVAL_MS = 10000;
const ALERT_HOURS = 6;

type FindingSource = 'signal' | 'alert';

interface UnifiedFinding {
  id: string;
  source: FindingSource;
  type: string;
  title: string;
  description: string;
  confidence: number;
  priority: 'critical' | 'high' | 'medium' | 'low';
  timestamp: Date;
  original: CorrelationSignal | UnifiedAlert;
}

export class IntelligenceFindingsBadge {
  private badge: HTMLElement;
  private dropdown: HTMLElement;
  private isOpen = false;
  private refreshInterval: ReturnType<typeof setInterval> | null = null;
  private lastFindingCount = 0;
  private onSignalClick: ((signal: CorrelationSignal) => void) | null = null;
  private onAlertClick: ((alert: UnifiedAlert) => void) | null = null;
  private findings: UnifiedFinding[] = [];
  private boundCloseDropdown = () => this.closeDropdown();
  private audio: HTMLAudioElement | null = null;
  private audioEnabled = true;

  constructor() {
    this.badge = document.createElement('button');
    this.badge.className = 'intel-findings-badge';
    this.badge.title = t('components.intelligenceFindings.badgeTitle');
    this.badge.innerHTML = '<span class="findings-icon">🎯</span><span class="findings-count">0</span>';

    this.dropdown = document.createElement('div');
    this.dropdown.className = 'intel-findings-dropdown';

    this.badge.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggleDropdown();
    });

    // Event delegation for finding items and "more" link
    this.dropdown.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;

      // Handle "more findings" click - show all in modal
      if (target.closest('.findings-more')) {
        e.stopPropagation();
        this.showAllFindings();
        this.closeDropdown();
        return;
      }

      // Handle individual finding click
      const item = target.closest('.finding-item');
      if (!item) return;
      e.stopPropagation();
      const id = item.getAttribute('data-finding-id');
      const finding = this.findings.find(f => f.id === id);
      if (!finding) return;

      if (finding.source === 'signal' && this.onSignalClick) {
        this.onSignalClick(finding.original as CorrelationSignal);
      } else if (finding.source === 'alert' && this.onAlertClick) {
        this.onAlertClick(finding.original as UnifiedAlert);
      }
      this.closeDropdown();
    });

    document.addEventListener('click', this.boundCloseDropdown);

    this.mount();
    this.initAudio();
    this.update();
    this.startRefresh();
  }

  private initAudio(): void {
    this.audio = new Audio('data:audio/wav;base64,UklGRnoGAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQoGAACBhYqFbF1fdJivrJBhNjVgodDbq2EcBj+a2teleQYjfKapmWswEjCJvuPQfSoXZZ+3qqBJESSP0unGaxMJVYiytrFeLhR6p8znrFUXRW+bs7V3Qx1hn8Xjp1cYPnegprhkMCFmoLi1k0sZTYGlqqlUIA==');
    this.audio.volume = 0.3;
  }

  private playSound(): void {
    if (this.audioEnabled && this.audio) {
      this.audio.currentTime = 0;
      this.audio.play().catch(() => {});
    }
  }

  public setOnSignalClick(handler: (signal: CorrelationSignal) => void): void {
    this.onSignalClick = handler;
  }

  public setOnAlertClick(handler: (alert: UnifiedAlert) => void): void {
    this.onAlertClick = handler;
  }

  private mount(): void {
    const headerRight = document.querySelector('.header-right');
    if (headerRight) {
      this.badge.appendChild(this.dropdown);
      headerRight.insertBefore(this.badge, headerRight.firstChild);
    }
  }

  private startRefresh(): void {
    this.refreshInterval = setInterval(() => this.update(), REFRESH_INTERVAL_MS);
  }

  public update(): void {
    this.findings = this.mergeFindings();
    const count = this.findings.length;

    const countEl = this.badge.querySelector('.findings-count');
    if (countEl) {
      countEl.textContent = String(count);
    }

    // Pulse animation and sound when new findings arrive
    if (count > this.lastFindingCount && this.lastFindingCount > 0) {
      this.badge.classList.add('pulse');
      setTimeout(() => this.badge.classList.remove('pulse'), 1000);
      this.playSound();
    }
    this.lastFindingCount = count;

    // Update badge status based on priority
    const hasCritical = this.findings.some(f => f.priority === 'critical');
    const hasHigh = this.findings.some(f => f.priority === 'high' || f.confidence >= 0.7);

    this.badge.classList.remove('status-none', 'status-low', 'status-high');
    if (count === 0) {
      this.badge.classList.add('status-none');
      this.badge.title = t('components.intelligenceFindings.none');
    } else if (hasCritical || hasHigh) {
      this.badge.classList.add('status-high');
      this.badge.title = t('components.intelligenceFindings.reviewRecommended', { count: String(count) });
    } else if (count <= LOW_COUNT_THRESHOLD) {
      this.badge.classList.add('status-low');
      this.badge.title = t('components.intelligenceFindings.count', { count: String(count) });
    } else {
      this.badge.classList.add('status-high');
      this.badge.title = t('components.intelligenceFindings.reviewRecommended', { count: String(count) });
    }

    this.renderDropdown();
  }

  private mergeFindings(): UnifiedFinding[] {
    const signals = getRecentSignals();
    const alerts = getRecentAlerts(ALERT_HOURS);

    const signalFindings: UnifiedFinding[] = signals.map(s => ({
      id: `signal-${s.id}`,
      source: 'signal' as FindingSource,
      type: s.type,
      title: s.title,
      description: s.description,
      confidence: s.confidence,
      priority: s.confidence >= 0.7 ? 'high' as const : s.confidence >= 0.5 ? 'medium' as const : 'low' as const,
      timestamp: s.timestamp,
      original: s,
    }));

    const alertFindings: UnifiedFinding[] = alerts.map(a => ({
      id: `alert-${a.id}`,
      source: 'alert' as FindingSource,
      type: a.type,
      title: a.title,
      description: a.summary,
      confidence: this.priorityToConfidence(a.priority),
      priority: a.priority,
      timestamp: a.timestamp,
      original: a,
    }));

    // Merge and sort by timestamp (newest first), then by priority
    return [...signalFindings, ...alertFindings].sort((a, b) => {
      const timeDiff = b.timestamp.getTime() - a.timestamp.getTime();
      if (Math.abs(timeDiff) < SORT_TIME_TOLERANCE_MS) {
        return this.priorityScore(b.priority) - this.priorityScore(a.priority);
      }
      return timeDiff;
    });
  }

  private priorityToConfidence(priority: string): number {
    const map: Record<string, number> = { critical: 95, high: 80, medium: 60, low: 40 };
    return map[priority] ?? 50;
  }

  private priorityScore(priority: string): number {
    const map: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1 };
    return map[priority] ?? 0;
  }

  private renderDropdown(): void {
    if (this.findings.length === 0) {
      this.dropdown.innerHTML = `
        <div class="findings-header">
          <span class="header-title">${t('components.intelligenceFindings.title')}</span>
          <span class="findings-badge none">${t('components.intelligenceFindings.monitoring')}</span>
        </div>
        <div class="findings-content">
          <div class="findings-empty">
            <span class="empty-icon">📡</span>
            <span class="empty-text">${t('components.intelligenceFindings.scanning')}</span>
          </div>
        </div>
      `;
      return;
    }

    const criticalCount = this.findings.filter(f => f.priority === 'critical').length;
    const highCount = this.findings.filter(f => f.priority === 'high' || f.confidence >= 70).length;

    let statusClass = 'moderate';
    let statusText = t('components.intelligenceFindings.detected', { count: String(this.findings.length) });
    if (criticalCount > 0) {
      statusClass = 'critical';
      statusText = t('components.intelligenceFindings.critical', { count: String(criticalCount) });
    } else if (highCount > 0) {
      statusClass = 'high';
      statusText = t('components.intelligenceFindings.highPriority', { count: String(highCount) });
    }

    const findingsHtml = this.findings.slice(0, MAX_VISIBLE_FINDINGS).map(finding => {
      const timeAgo = this.formatTimeAgo(finding.timestamp);
      const icon = this.getTypeIcon(finding.type);
      const priorityClass = finding.priority;
      const insight = this.getInsight(finding);

      return `
        <div class="finding-item ${priorityClass}" data-finding-id="${escapeHtml(finding.id)}">
          <div class="finding-header">
            <span class="finding-type">${icon} ${escapeHtml(finding.title)}</span>
            <span class="finding-confidence ${priorityClass}">${t(`components.intelligenceFindings.priority.${finding.priority}`)}</span>
          </div>
          <div class="finding-description">${escapeHtml(finding.description)}</div>
          <div class="finding-meta">
            <span class="finding-insight">${escapeHtml(insight)}</span>
            <span class="finding-time">${timeAgo}</span>
          </div>
        </div>
      `;
    }).join('');

    const moreCount = this.findings.length - MAX_VISIBLE_FINDINGS;
    this.dropdown.innerHTML = `
      <div class="findings-header">
        <span class="header-title">${t('components.intelligenceFindings.title')}</span>
        <span class="findings-badge ${statusClass}">${statusText}</span>
      </div>
      <div class="findings-content">
        <div class="findings-list">
          ${findingsHtml}
        </div>
        ${moreCount > 0 ? `<div class="findings-more">${t('components.intelligenceFindings.more', { count: String(moreCount) })}</div>` : ''}
      </div>
    `;
  }

  private getInsight(finding: UnifiedFinding): string {
    if (finding.source === 'signal') {
      const context = getSignalContext((finding.original as CorrelationSignal).type);
      return context.actionableInsight.split('.')[0] || '';
    }
    // For alerts, provide actionable insight based on type and severity
    const alert = finding.original as UnifiedAlert;
    if (alert.type === 'cii_spike') {
      const cii = alert.components.ciiChange;
      if (cii && cii.change >= 30) return t('components.intelligenceFindings.insights.criticalDestabilization');
      if (cii && cii.change >= 20) return t('components.intelligenceFindings.insights.significantShift');
      return t('components.intelligenceFindings.insights.developingSituation');
    }
    if (alert.type === 'convergence') return t('components.intelligenceFindings.insights.convergence');
    if (alert.type === 'cascade') return t('components.intelligenceFindings.insights.cascade');
    return t('components.intelligenceFindings.insights.review');
  }

  private getTypeIcon(type: string): string {
    const icons: Record<string, string> = {
      // Correlation signals
      breaking_surge: '🔥',
      silent_divergence: '🔇',
      flow_price_divergence: '📊',
      explained_market_move: '💡',
      prediction_leads_news: '🔮',
      geo_convergence: '🌍',
      hotspot_escalation: '⚠️',
      news_leads_markets: '📰',
      velocity_spike: '📈',
      keyword_spike: '📊',
      convergence: '🔀',
      triangulation: '🔺',
      flow_drop: '⬇️',
      sector_cascade: '🌊',
      // Unified alerts
      cii_spike: '🔴',
      cascade: '⚡',
      composite: '🔗',
    };
    return icons[type] || '📌';
  }

  private formatTimeAgo(date: Date): string {
    const ms = Date.now() - date.getTime();
    if (ms < 60000) return t('components.intelligenceFindings.time.justNow');
    if (ms < 3600000) return t('components.intelligenceFindings.time.minutesAgo', { count: String(Math.floor(ms / 60000)) });
    if (ms < 86400000) return t('components.intelligenceFindings.time.hoursAgo', { count: String(Math.floor(ms / 3600000)) });
    return t('components.intelligenceFindings.time.daysAgo', { count: String(Math.floor(ms / 86400000)) });
  }

  private toggleDropdown(): void {
    this.isOpen = !this.isOpen;
    this.dropdown.classList.toggle('open', this.isOpen);
    this.badge.classList.toggle('active', this.isOpen);
    if (this.isOpen) {
      this.update();
    }
  }

  private closeDropdown(): void {
    this.isOpen = false;
    this.dropdown.classList.remove('open');
    this.badge.classList.remove('active');
  }

  private showAllFindings(): void {
    // Create modal overlay
    const overlay = document.createElement('div');
    overlay.className = 'findings-modal-overlay';

    const findingsHtml = this.findings.map(finding => {
      const timeAgo = this.formatTimeAgo(finding.timestamp);
      const icon = this.getTypeIcon(finding.type);
      const insight = this.getInsight(finding);

      return `
        <div class="findings-modal-item ${finding.priority}" data-finding-id="${escapeHtml(finding.id)}">
          <div class="findings-modal-item-header">
            <span class="findings-modal-item-type">${icon} ${escapeHtml(finding.title)}</span>
            <span class="findings-modal-item-priority ${finding.priority}">${t(`components.intelligenceFindings.priority.${finding.priority}`)}</span>
          </div>
          <div class="findings-modal-item-desc">${escapeHtml(finding.description)}</div>
          <div class="findings-modal-item-meta">
            <span class="findings-modal-item-insight">${escapeHtml(insight)}</span>
            <span class="findings-modal-item-time">${timeAgo}</span>
          </div>
        </div>
      `;
    }).join('');

    overlay.innerHTML = `
      <div class="findings-modal">
        <div class="findings-modal-header">
          <span class="findings-modal-title">🎯 ${t('components.intelligenceFindings.all', { count: String(this.findings.length) })}</span>
          <button class="findings-modal-close">×</button>
        </div>
        <div class="findings-modal-content">
          ${findingsHtml}
        </div>
      </div>
    `;

    // Add click handlers
    overlay.querySelector('.findings-modal-close')?.addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).classList.contains('findings-modal-overlay')) {
        overlay.remove();
      }
    });

    // Handle clicking individual items
    overlay.querySelectorAll('.findings-modal-item').forEach(item => {
      item.addEventListener('click', () => {
        const id = item.getAttribute('data-finding-id');
        const finding = this.findings.find(f => f.id === id);
        if (!finding) return;

        if (finding.source === 'signal' && this.onSignalClick) {
          this.onSignalClick(finding.original as CorrelationSignal);
          overlay.remove();
        } else if (finding.source === 'alert' && this.onAlertClick) {
          this.onAlertClick(finding.original as UnifiedAlert);
          overlay.remove();
        }
      });
    });

    document.body.appendChild(overlay);
  }

  public destroy(): void {
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
    }
    document.removeEventListener('click', this.boundCloseDropdown);
    this.badge.remove();
  }
}

// Re-export with old name for backwards compatibility
export { IntelligenceFindingsBadge as IntelligenceGapBadge };
