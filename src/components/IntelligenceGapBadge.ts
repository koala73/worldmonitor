import { getRecentSignals, type CorrelationSignal } from '@/services/correlation';
import { getSignalContext } from '@/utils/analysis-constants';
import { escapeHtml } from '@/utils/sanitize';

const LOW_COUNT_THRESHOLD = 3;
const MAX_VISIBLE_FINDINGS = 10;
const SORT_TIME_TOLERANCE_MS = 60000;
const REFRESH_INTERVAL_MS = 10000;

export class IntelligenceFindingsBadge {
  private badge: HTMLElement;
  private dropdown: HTMLElement;
  private isOpen = false;
  private refreshInterval: ReturnType<typeof setInterval> | null = null;
  private lastSignalCount = 0;
  private onSignalClick: ((signal: CorrelationSignal) => void) | null = null;
  private signals: CorrelationSignal[] = [];
  private boundCloseDropdown = () => this.closeDropdown();

  constructor() {
    this.badge = document.createElement('button');
    this.badge.className = 'intel-findings-badge';
    this.badge.title = 'Intelligence findings';
    this.badge.innerHTML = '<span class="findings-icon">🎯</span><span class="findings-count">0</span>';

    this.dropdown = document.createElement('div');
    this.dropdown.className = 'intel-findings-dropdown';

    this.badge.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggleDropdown();
    });

    // Event delegation for finding items
    this.dropdown.addEventListener('click', (e) => {
      const item = (e.target as HTMLElement).closest('.finding-item');
      if (!item) return;
      e.stopPropagation();
      const id = item.getAttribute('data-signal-id');
      const signal = this.signals.find(s => s.id === id);
      if (signal && this.onSignalClick) {
        this.onSignalClick(signal);
        this.closeDropdown();
      }
    });

    document.addEventListener('click', this.boundCloseDropdown);

    this.mount();
    this.update();
    this.startRefresh();
  }

  public setOnSignalClick(handler: (signal: CorrelationSignal) => void): void {
    this.onSignalClick = handler;
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
    this.signals = getRecentSignals();
    const count = this.signals.length;

    const countEl = this.badge.querySelector('.findings-count');
    if (countEl) {
      countEl.textContent = String(count);
    }

    // Pulse animation when new signals arrive
    if (count > this.lastSignalCount && this.lastSignalCount > 0) {
      this.badge.classList.add('pulse');
      setTimeout(() => this.badge.classList.remove('pulse'), 1000);
    }
    this.lastSignalCount = count;

    // Update badge status
    this.badge.classList.remove('status-none', 'status-low', 'status-high');
    if (count === 0) {
      this.badge.classList.add('status-none');
      this.badge.title = 'No recent intelligence findings';
    } else if (count <= LOW_COUNT_THRESHOLD) {
      this.badge.classList.add('status-low');
      this.badge.title = `${count} intelligence finding${count > 1 ? 's' : ''}`;
    } else {
      this.badge.classList.add('status-high');
      this.badge.title = `${count} intelligence findings - review recommended`;
    }

    this.renderDropdown();
  }

  private renderDropdown(): void {
    if (this.signals.length === 0) {
      this.dropdown.innerHTML = `
        <div class="findings-header">
          <span class="header-title">Intelligence Findings</span>
          <span class="findings-badge none">MONITORING</span>
        </div>
        <div class="findings-content">
          <div class="findings-empty">
            <span class="empty-icon">📡</span>
            <span class="empty-text">Scanning for correlations and anomalies...</span>
          </div>
        </div>
      `;
      return;
    }

    // Sort by timestamp (newest first) and confidence
    const sorted = [...this.signals].sort((a, b) => {
      const timeDiff = b.timestamp.getTime() - a.timestamp.getTime();
      if (Math.abs(timeDiff) < SORT_TIME_TOLERANCE_MS) return b.confidence - a.confidence;
      return timeDiff;
    });

    const highConfidence = sorted.filter(s => s.confidence >= 70).length;
    const statusClass = highConfidence > 0 ? 'high' : 'moderate';
    const statusText = highConfidence > 0 ? `${highConfidence} HIGH CONFIDENCE` : `${this.signals.length} DETECTED`;

    const findingsHtml = sorted.slice(0, MAX_VISIBLE_FINDINGS).map(signal => {
      const context = getSignalContext(signal.type);
      const confidenceClass = signal.confidence >= 70 ? 'high' : signal.confidence >= 50 ? 'medium' : 'low';
      const timeAgo = this.formatTimeAgo(signal.timestamp);

      return `
        <div class="finding-item" data-signal-id="${escapeHtml(signal.id)}">
          <div class="finding-header">
            <span class="finding-type">${this.getTypeIcon(signal.type)} ${escapeHtml(signal.title)}</span>
            <span class="finding-confidence ${confidenceClass}">${signal.confidence}%</span>
          </div>
          <div class="finding-description">${escapeHtml(signal.description)}</div>
          <div class="finding-meta">
            <span class="finding-insight">${escapeHtml(context.actionableInsight.split('.')[0] || '')}</span>
            <span class="finding-time">${timeAgo}</span>
          </div>
        </div>
      `;
    }).join('');

    const moreCount = this.signals.length - MAX_VISIBLE_FINDINGS;
    this.dropdown.innerHTML = `
      <div class="findings-header">
        <span class="header-title">Intelligence Findings</span>
        <span class="findings-badge ${statusClass}">${statusText}</span>
      </div>
      <div class="findings-content">
        <div class="findings-list">
          ${findingsHtml}
        </div>
        ${moreCount > 0 ? `<div class="findings-more">+${moreCount} more findings</div>` : ''}
      </div>
    `;
  }

  private getTypeIcon(type: string): string {
    const icons: Record<string, string> = {
      breaking_surge: '🔥',
      silent_divergence: '🔇',
      flow_price_divergence: '📊',
      explained_market_move: '💡',
      prediction_leads_news: '🔮',
      geo_convergence: '🌍',
      hotspot_escalation: '⚠️',
      news_leads_markets: '📰',
      velocity_spike: '📈',
      convergence: '🔀',
      triangulation: '🔺',
      flow_drop: '⬇️',
      sector_cascade: '🌊',
    };
    return icons[type] || '📌';
  }

  private formatTimeAgo(date: Date): string {
    const ms = Date.now() - date.getTime();
    if (ms < 60000) return 'just now';
    if (ms < 3600000) return `${Math.floor(ms / 60000)}m ago`;
    if (ms < 86400000) return `${Math.floor(ms / 3600000)}h ago`;
    return `${Math.floor(ms / 86400000)}d ago`;
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
