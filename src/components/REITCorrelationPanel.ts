/**
 * REITCorrelationPanel — Macro correlation engine with regime signal.
 *
 * Layout:
 *   ┌──────────────────────────────────────────┐
 *   │ Fed Funds 5.33%  ▲+25bps  corr: -0.72   │
 *   │ 10Y Treas 4.28%  ▲+12bps  corr: -0.58   │
 *   │ CPI (YoY) 3.2%   ▼-0.3%  corr: +0.35   │
 *   │ UNRATE    3.7%   — flat   corr: -0.30   │
 *   ├──────────────────────────────────────────┤
 *   │ REGIME: CAUTIOUS                         │
 *   │ Spread: REIT yield - 10Y = +1.8%        │
 *   ├──────────────────────────────────────────┤
 *   │ Sector Rotation: ↑IND ↑DC ↓OFF ↓RES    │
 *   └──────────────────────────────────────────┘
 */

import { Panel } from './Panel';
import { t } from '@/services/i18n';
import { escapeHtml } from '@/utils/sanitize';
import type {
  GetReitCorrelationResponse,
  FredIndicatorSnapshot,
  CorrelationCoefficient,
  SectorRotationSignal,
  ReitRegime,
} from '@/services/reits';

const REGIME_STYLES: Record<string, { color: string; label: string }> = {
  REIT_REGIME_FAVORABLE: { color: '#3fb950', label: 'FAVORABLE' },
  REIT_REGIME_CAUTIOUS: { color: '#d29922', label: 'CAUTIOUS' },
  REIT_REGIME_STRESS: { color: '#f85149', label: 'STRESS' },
  REIT_REGIME_NEUTRAL: { color: '#8b949e', label: 'NEUTRAL' },
};

export class REITCorrelationPanel extends Panel {
  constructor() {
    super({
      id: 'reit-correlation',
      title: t('panels.reitCorrelation') || 'REIT Macro',
      infoTooltip: t('components.reitCorrelation.infoTooltip') || 'Macro indicator correlation with REIT sectors, regime classification, sector rotation signals, and bond yield spread',
    });
  }

  public renderCorrelation(data: GetReitCorrelationResponse): void {
    if (!data.indicators?.length) {
      this.showError(t('common.failedToLoad') || 'Macro data unavailable — regime unknown');
      return;
    }

    const indicatorsHtml = this.renderIndicators(data.indicators, data.correlations);
    const regimeHtml = this.renderRegime(data.regime, data.yieldSpread);
    const rotationHtml = this.renderSectorRotation(data.sectorRotation);

    this.setContent(`${indicatorsHtml}${regimeHtml}${rotationHtml}`);
  }

  /** Render with loading state for circuit breaker cooldown */
  public setCorrelationRetrying(remainingSeconds: number): void {
    this.showRetrying(t('common.upstreamUnavailable') || 'FRED data unavailable', remainingSeconds);
  }

  private renderIndicators(indicators: FredIndicatorSnapshot[], correlations: CorrelationCoefficient[]): string {
    // For the "All" view, show avg correlation across retail sector as representative
    const getCorr = (indicatorId: string): CorrelationCoefficient | undefined =>
      correlations.find(c => c.indicatorId === indicatorId && c.sector === 'retail');

    return `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:10px">
        ${indicators.map(ind => {
          const corr = getCorr(ind.seriesId);
          const dirColor = ind.direction === 'rising' ? '#f85149' : ind.direction === 'falling' ? '#3fb950' : '#8b949e';
          const corrColor = corr && corr.coefficient < -0.4 ? '#f85149' : corr && corr.coefficient > 0.3 ? '#3fb950' : '#8b949e';

          return `
            <div style="background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:10px">
              <div style="font-size:10px;color:var(--text-dim)">${escapeHtml(ind.name)}</div>
              <div style="font-size:18px;font-weight:600;color:${dirColor}">${ind.value.toFixed(2)}%</div>
              <div style="font-size:10px;color:${dirColor}">${escapeHtml(ind.changeDescription)}</div>
              ${corr ? `
                <div style="margin-top:6px;font-size:10px;color:${corrColor}">
                  <span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:${corrColor};margin-right:4px"></span>
                  REIT corr: ${corr.coefficient > 0 ? '+' : ''}${corr.coefficient} (${escapeHtml(corr.interpretation)})
                </div>
              ` : ''}
            </div>
          `;
        }).join('')}
      </div>
    `;
  }

  private renderRegime(regime: ReitRegime, yieldSpread: number): string {
    const style = REGIME_STYLES[regime as string] ?? { color: '#8b949e', label: 'NEUTRAL' };
    const spreadSign = yieldSpread > 0 ? '+' : '';
    const spreadColor = yieldSpread > 1.5 ? '#3fb950' : yieldSpread > 0 ? '#d29922' : '#f85149';

    return `
      <div style="background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:8px 10px;margin-bottom:10px;font-size:11px">
        <span style="font-weight:600;color:var(--accent)">REGIME:</span>
        <span style="display:inline-block;padding:2px 8px;border-radius:3px;font-size:10px;font-weight:700;background:${style.color}22;color:${style.color};margin-left:4px">
          ${style.label}
        </span>
        <span style="margin-left:12px;color:var(--text-dim)">Yield Spread:</span>
        <span style="font-weight:600;color:${spreadColor};margin-left:4px">${spreadSign}${yieldSpread.toFixed(2)}%</span>
        <span style="color:var(--text-dim);font-size:10px;margin-left:2px">(REIT avg − 10Y)</span>
      </div>
    `;
  }

  private renderSectorRotation(rotation: SectorRotationSignal[]): string {
    if (!rotation.length) return '';

    const overweight = rotation.filter(r => r.signal === 'overweight');
    const underweight = rotation.filter(r => r.signal === 'underweight');

    return `
      <div style="font-size:11px">
        <div style="font-weight:600;color:var(--text);margin-bottom:6px">Sector Rotation</div>
        ${overweight.length ? `
          <div style="margin-bottom:4px">
            <span style="color:#3fb950;font-weight:600">▲ Overweight:</span>
            ${overweight.map(r => `<span style="display:inline-block;padding:1px 6px;border-radius:3px;background:#3fb95022;color:#3fb950;font-size:10px;margin-left:4px" title="${escapeHtml(r.reason)}">${escapeHtml(r.sector)}</span>`).join('')}
          </div>
        ` : ''}
        ${underweight.length ? `
          <div>
            <span style="color:#f85149;font-weight:600">▼ Underweight:</span>
            ${underweight.map(r => `<span style="display:inline-block;padding:1px 6px;border-radius:3px;background:#f8514922;color:#f85149;font-size:10px;margin-left:4px" title="${escapeHtml(r.reason)}">${escapeHtml(r.sector)}</span>`).join('')}
          </div>
        ` : ''}
      </div>
    `;
  }
}
