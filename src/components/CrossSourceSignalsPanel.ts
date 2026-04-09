import { Panel } from './Panel';
import { escapeHtml } from '@/utils/sanitize';

interface CrossSourceSignal {
  id: string;
  type: string;
  theater: string;
  summary: string;
  severity: string;
  severityScore: number;
  detectedAt: number;
  contributingTypes: string[];
  signalCount: number;
}

interface CrossSourceSignalsData {
  signals: CrossSourceSignal[];
  evaluatedAt: number;
  compositeCount: number;
}

const SEVERITY_COLOR: Record<string, string> = {
  CROSS_SOURCE_SIGNAL_SEVERITY_CRITICAL: 'var(--semantic-critical)',
  CROSS_SOURCE_SIGNAL_SEVERITY_HIGH: '#ff8c8c',
  CROSS_SOURCE_SIGNAL_SEVERITY_MEDIUM: 'var(--yellow)',
  CROSS_SOURCE_SIGNAL_SEVERITY_LOW: 'var(--text-dim)',
};

const SEVERITY_LABEL: Record<string, string> = {
  CROSS_SOURCE_SIGNAL_SEVERITY_CRITICAL: 'CRITICAL',
  CROSS_SOURCE_SIGNAL_SEVERITY_HIGH: 'HIGH',
  CROSS_SOURCE_SIGNAL_SEVERITY_MEDIUM: 'MED',
  CROSS_SOURCE_SIGNAL_SEVERITY_LOW: 'LOW',
};

// Filled badge styles: bg + border + text per severity
const SEVERITY_BADGE_STYLE: Record<string, string> = {
  CROSS_SOURCE_SIGNAL_SEVERITY_CRITICAL: 'background:var(--semantic-critical);color:#fff;border:1px solid var(--semantic-critical)',
  CROSS_SOURCE_SIGNAL_SEVERITY_HIGH: 'background:rgba(255,140,140,0.15);color:#ff8c8c;border:1px solid rgba(255,140,140,0.4)',
  CROSS_SOURCE_SIGNAL_SEVERITY_MEDIUM: 'background:rgba(245,197,66,0.08);color:var(--yellow);border:1px solid rgba(245,197,66,0.35)',
  CROSS_SOURCE_SIGNAL_SEVERITY_LOW: 'background:transparent;color:var(--text-dim);border:1px solid var(--border)',
};

const TYPE_LABEL: Record<string, string> = {
  CROSS_SOURCE_SIGNAL_TYPE_COMPOSITE_ESCALATION: 'COMPOSITE',
  CROSS_SOURCE_SIGNAL_TYPE_THERMAL_SPIKE: 'THERMAL',
  CROSS_SOURCE_SIGNAL_TYPE_GPS_JAMMING: 'GPS JAM',
  CROSS_SOURCE_SIGNAL_TYPE_MILITARY_FLIGHT_SURGE: 'MIL FLTX',
  CROSS_SOURCE_SIGNAL_TYPE_UNREST_SURGE: 'UNREST',
  CROSS_SOURCE_SIGNAL_TYPE_OREF_ALERT_CLUSTER: 'ADVISORY',
  CROSS_SOURCE_SIGNAL_TYPE_VIX_SPIKE: 'VIX',
  CROSS_SOURCE_SIGNAL_TYPE_COMMODITY_SHOCK: 'COMDTY',
  CROSS_SOURCE_SIGNAL_TYPE_CYBER_ESCALATION: 'CYBER',
  CROSS_SOURCE_SIGNAL_TYPE_SHIPPING_DISRUPTION: 'SHIPPING',
  CROSS_SOURCE_SIGNAL_TYPE_SANCTIONS_SURGE: 'SANCTIONS',
  CROSS_SOURCE_SIGNAL_TYPE_EARTHQUAKE_SIGNIFICANT: 'QUAKE',
  CROSS_SOURCE_SIGNAL_TYPE_RADIATION_ANOMALY: 'RADIATION',
  CROSS_SOURCE_SIGNAL_TYPE_INFRASTRUCTURE_OUTAGE: 'INFRA',
  CROSS_SOURCE_SIGNAL_TYPE_WILDFIRE_ESCALATION: 'WILDFIRE',
  CROSS_SOURCE_SIGNAL_TYPE_DISPLACEMENT_SURGE: 'DISPLCMT',
  CROSS_SOURCE_SIGNAL_TYPE_FORECAST_DETERIORATION: 'FORECAST',
  CROSS_SOURCE_SIGNAL_TYPE_MARKET_STRESS: 'MARKET',
  CROSS_SOURCE_SIGNAL_TYPE_WEATHER_EXTREME: 'WEATHER',
  CROSS_SOURCE_SIGNAL_TYPE_MEDIA_TONE_DETERIORATION: 'MEDIA',
  CROSS_SOURCE_SIGNAL_TYPE_RISK_SCORE_SPIKE: 'RISK',
};

// Category icon prefix for type badges
const TYPE_ICON: Record<string, string> = {
  CROSS_SOURCE_SIGNAL_TYPE_COMPOSITE_ESCALATION: '⚡',
  CROSS_SOURCE_SIGNAL_TYPE_THERMAL_SPIKE: '🔴',
  CROSS_SOURCE_SIGNAL_TYPE_EARTHQUAKE_SIGNIFICANT: '🔴',
  CROSS_SOURCE_SIGNAL_TYPE_RADIATION_ANOMALY: '🔴',
  CROSS_SOURCE_SIGNAL_TYPE_WILDFIRE_ESCALATION: '🔴',
  CROSS_SOURCE_SIGNAL_TYPE_GPS_JAMMING: '📡',
  CROSS_SOURCE_SIGNAL_TYPE_CYBER_ESCALATION: '📡',
  CROSS_SOURCE_SIGNAL_TYPE_MILITARY_FLIGHT_SURGE: '✈️',
  CROSS_SOURCE_SIGNAL_TYPE_VIX_SPIKE: '📊',
  CROSS_SOURCE_SIGNAL_TYPE_COMMODITY_SHOCK: '📊',
  CROSS_SOURCE_SIGNAL_TYPE_MARKET_STRESS: '📊',
  CROSS_SOURCE_SIGNAL_TYPE_RISK_SCORE_SPIKE: '📊',
};
const TYPE_ICON_DEFAULT = '⚠️';

export class CrossSourceSignalsPanel extends Panel {
  private signals: CrossSourceSignal[] = [];
  private evaluatedAt: Date | null = null;
  private compositeCount = 0;

  constructor() {
    super({
      id: 'cross-source-signals',
      title: 'Cross-Source Signal Aggregator',
      showCount: true,
      trackActivity: true,
      infoTooltip: 'Aggregates 15+ real-time data streams every 15 minutes. Ranks cross-domain signals by severity and detects composite escalation when 3 or more signal categories co-fire in the same theater.',
    });
    // Inject keyframe once — used by the composite banner pulse dot
    const style = document.createElement('style');
    style.textContent = '@keyframes cross-source-pulse-dot{0%,100%{opacity:1}50%{opacity:.15}}';
    document.head.appendChild(style);
    this.showLoading('Loading signal data...');
  }

  public setData(data: CrossSourceSignalsData): void {
    this.signals = data.signals ?? [];
    this.evaluatedAt = data.evaluatedAt ? new Date(data.evaluatedAt) : null;
    this.compositeCount = data.compositeCount ?? 0;
    this.setCount(this.signals.length);
    this.resetRetryBackoff();
    this.render();
  }

  public showFetchError(): void {
    this.showError('Signal data unavailable — upstream feeds unreachable.', () => {/* refreshed by scheduler */});
  }

  private ageSuffix(ts: number): string {
    const diffMs = Date.now() - ts;
    const mins = Math.floor(diffMs / 60000);
    if (mins < 2) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    return `${Math.floor(mins / 60)}h ago`;
  }

  private renderSignal(sig: CrossSourceSignal, index: number): string {
    const isComposite = sig.type === 'CROSS_SOURCE_SIGNAL_TYPE_COMPOSITE_ESCALATION';
    const sevColor = SEVERITY_COLOR[sig.severity] ?? 'var(--text-dim)';
    const sevBadgeStyle = SEVERITY_BADGE_STYLE[sig.severity] ?? SEVERITY_BADGE_STYLE.CROSS_SOURCE_SIGNAL_SEVERITY_LOW;
    const typeLabel = TYPE_LABEL[sig.type] ?? sig.type.replace('CROSS_SOURCE_SIGNAL_TYPE_', '');
    const typeIcon = TYPE_ICON[sig.type] ?? TYPE_ICON_DEFAULT;
    const age = this.ageSuffix(sig.detectedAt);

    const cardStyle = isComposite
      ? 'box-shadow:0 0 0 1px rgba(255,80,80,0.3),0 2px 8px rgba(255,80,80,0.08);border-color:rgba(255,80,80,0.25)'
      : 'border:1px solid var(--border)';

    const contributors = isComposite && sig.contributingTypes.length > 0
      ? `<div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:5px">${
          sig.contributingTypes.slice(0, 5).map(t =>
            `<span style="font-size:9px;font-family:var(--font-mono);padding:1px 5px;background:rgba(255,255,255,0.05);border:1px solid var(--border);color:var(--text-dim);text-transform:uppercase;letter-spacing:0.06em;border-radius:2px">${escapeHtml(t)}</span>`
          ).join('')
        }</div>`
      : '';

    return `
      <div style="display:flex;align-items:stretch;${cardStyle};background:rgba(255,255,255,0.02);overflow:hidden">
        <div style="width:4px;flex-shrink:0;background:${sevColor}"></div>
        <div style="display:flex;gap:10px;align-items:flex-start;padding:10px;flex:1;min-width:0">
          <div style="font-size:12px;font-weight:700;color:var(--text-dim);min-width:18px;text-align:right;flex-shrink:0;font-family:var(--font-mono);padding-top:1px">${index + 1}</div>
          <div style="flex:1;min-width:0">
            <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:5px">
              <span style="font-size:10px;padding:2px 6px;border:1px solid var(--border);color:var(--text-dim);font-family:var(--font-mono);text-transform:uppercase;letter-spacing:0.06em;display:inline-flex;align-items:center;gap:4px"><span>${typeIcon}</span>${escapeHtml(typeLabel)}</span>
              <span style="font-size:10px;padding:2px 6px;font-family:var(--font-mono);text-transform:uppercase;letter-spacing:0.08em;font-weight:700;${sevBadgeStyle}">${escapeHtml(SEVERITY_LABEL[sig.severity] ?? '')}</span>
              <span style="display:inline-flex;align-items:center;gap:5px;background:rgba(255,255,255,0.06);border-radius:3px;padding:2px 7px;font-size:10px;color:rgba(232,234,237,0.65);font-family:var(--font-mono);letter-spacing:0.04em;white-space:nowrap">${escapeHtml(sig.theater)}<span style="opacity:0.4"> · </span>${escapeHtml(age)}</span>
            </div>
            <div style="font-size:12px;line-height:1.5;color:var(--text)">${escapeHtml(sig.summary)}</div>
            ${contributors}
          </div>
        </div>
      </div>
    `;
  }

  private render(): void {
    if (this.signals.length === 0) {
      if (!this.evaluatedAt) {
        this.showError('Signal aggregator is initializing. First evaluation runs within 15 minutes.', () => {/* refreshed by scheduler */});
      } else {
        this.setContent('<div style="padding:16px 0;text-align:center;font-size:12px;color:var(--text-dim)">No cross-source signals detected.</div>');
      }
      return;
    }

    const evalTime = this.evaluatedAt
      ? `Evaluated ${this.evaluatedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
      : '';

    const compositeNote = this.compositeCount > 0
      ? `<div style="display:flex;align-items:center;gap:8px;font-size:12px;color:var(--semantic-critical);padding:7px 10px;border:1px solid rgba(255,80,80,0.3);background:rgba(255,80,80,0.06);margin-bottom:8px"><div style="width:7px;height:7px;border-radius:50%;background:var(--semantic-critical);flex-shrink:0;animation:cross-source-pulse-dot 2s ease-in-out infinite"></div>${this.compositeCount} composite escalation zone${this.compositeCount > 1 ? 's' : ''} detected</div>`
      : '';

    const signalRows = this.signals.map((s, i) => this.renderSignal(s, i)).join('');

    this.setContent(`
      <div style="display:flex;flex-direction:column;gap:6px">
        ${compositeNote}
        ${signalRows}
        ${evalTime ? `<div style="font-size:10px;color:var(--text-dim);padding-top:8px;border-top:1px solid var(--border);text-align:center;font-family:var(--font-mono)">${escapeHtml(evalTime)}</div>` : ''}
      </div>
    `);
  }
}
