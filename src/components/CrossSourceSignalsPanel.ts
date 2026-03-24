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
    this.showLoading('Loading signal data...');
  }

  public setData(data: CrossSourceSignalsData): void {
    this.signals = data.signals ?? [];
    this.evaluatedAt = data.evaluatedAt ? new Date(data.evaluatedAt) : null;
    this.compositeCount = data.compositeCount ?? 0;
    this.setCount(this.signals.length);
    this.render();
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
    const typeLabel = TYPE_LABEL[sig.type] ?? sig.type.replace('CROSS_SOURCE_SIGNAL_TYPE_', '');
    const age = this.ageSuffix(sig.detectedAt);
    const compositeBorder = isComposite ? `border-left:3px solid ${sevColor};padding-left:11px;` : '';

    const contributors = isComposite && sig.contributingTypes.length > 0
      ? `<div style="margin-top:4px;font-size:10px;color:var(--text-dim);letter-spacing:0.06em">${escapeHtml(sig.contributingTypes.slice(0, 5).join(' · '))}</div>`
      : '';

    return `
      <div style="display:flex;gap:10px;align-items:flex-start;padding:10px;border:1px solid var(--border);background:rgba(255,255,255,0.02);${compositeBorder}">
        <div style="font-size:13px;font-weight:700;color:var(--text-dim);min-width:20px;text-align:right;flex-shrink:0">${index + 1}</div>
        <div style="flex:1;min-width:0">
          <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:4px">
            <span style="font-size:10px;padding:2px 5px;border:1px solid var(--border);color:var(--text-dim);font-family:var(--font-mono);text-transform:uppercase;letter-spacing:0.08em">${escapeHtml(typeLabel)}</span>
            <span style="font-size:10px;padding:2px 5px;border:1px solid ${sevColor};color:${sevColor};font-family:var(--font-mono);text-transform:uppercase;letter-spacing:0.08em">${escapeHtml(SEVERITY_LABEL[sig.severity] ?? '')}</span>
            <span style="font-size:11px;color:var(--text-dim)">${escapeHtml(sig.theater)}</span>
            <span style="font-size:10px;color:var(--text-dim);margin-left:auto">${escapeHtml(age)}</span>
          </div>
          <div style="font-size:12px;line-height:1.5;color:var(--text)">${escapeHtml(sig.summary)}</div>
          ${contributors}
        </div>
      </div>
    `;
  }

  private render(): void {
    if (this.signals.length === 0) {
      this.setContent('<div style="padding:16px 0;text-align:center;font-size:12px;color:var(--text-dim)">No cross-source signals detected.</div>');
      return;
    }

    const evalTime = this.evaluatedAt
      ? `Evaluated ${this.evaluatedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
      : '';

    const compositeNote = this.compositeCount > 0
      ? `<div style="font-size:12px;color:var(--semantic-critical);padding:6px 8px;border:1px solid rgba(var(--semantic-critical-rgb,255,80,80),0.3);background:rgba(var(--semantic-critical-rgb,255,80,80),0.06);margin-bottom:8px">${this.compositeCount} composite escalation zone${this.compositeCount > 1 ? 's' : ''} detected</div>`
      : '';

    const signalRows = this.signals.map((s, i) => this.renderSignal(s, i)).join('');

    this.setContent(`
      <div style="display:flex;flex-direction:column;gap:6px">
        ${compositeNote}
        ${signalRows}
        ${evalTime ? `<div style="font-size:10px;color:var(--text-dim);padding-top:8px;border-top:1px solid var(--border);text-align:center">${escapeHtml(evalTime)}</div>` : ''}
      </div>
    `);
  }
}
