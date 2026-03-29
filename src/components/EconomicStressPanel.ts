import { Panel } from './Panel';
import { renderStatusCard } from './StatusCard';
import type { EconomicStressData } from '@/services/economic-stress';
import { tryInvokeTauri } from '@/services/tauri-bridge';
import { isGhostMode } from '@/services/mode-manager';

export class EconomicStressPanel extends Panel {
  private _previousStressIndex = 0;

  constructor() {
    super({ id: 'economic-stress', title: 'Economic Stress' });
    this.showLoading('Fetching economic indicators...');
  }

  update(data: EconomicStressData | null): void {
    if (!data) { this._renderError(); return; }
    if (data.fredKeyMissing) { this._renderKeyRequired(); return; }
    void this._checkNotification(data.stressIndex);
    this._render(data);
  }

  private async _checkNotification(index: number): Promise<void> {
    if (isGhostMode()) return;
    const prev = this._previousStressIndex;
    if (prev < 70 && index >= 70) {
      await tryInvokeTauri<void>('send_notification', {
        title: 'Economic Stress', body: `Stress index elevated: ${index}/100`, sound: 'Ping',
      });
    }
    if (prev < 85 && index >= 85) {
      await tryInvokeTauri<void>('send_notification', {
        title: 'Economic Stress', body: `Stress index critical: ${index}/100`, sound: 'Basso',
      });
    }
    this._previousStressIndex = index;
  }

  private _render(data: EconomicStressData): void {
    const el = this.getContentElement();
    const { stressIndex, trend, indicators, foodSecurity } = data;
    const pct = Math.min(100, stressIndex);
    const indexColor = stressIndex >= 85 ? '#ef4444' : (stressIndex >= 70 ? '#eab308' : '#22c55e');

    const trendGlyph = trend === 'rising'
      ? `<span style="color:#ef4444;">↑</span>`
      : (trend === 'falling'
      ? `<span style="color:#22c55e;">↓</span>`
      : `<span style="opacity:0.5;">→</span>`);

    const ind = indicators;
    const cards = [
      renderStatusCard({ label: 'Yield Curve',  value: `${ind.yieldCurve.value.toFixed(2)}%`,  severity: ind.yieldCurve.severity,  sublabel: ind.yieldCurve.label }),
      renderStatusCard({ label: 'Bank Spread',  value: `${ind.bankSpread.value.toFixed(2)}%`,  severity: ind.bankSpread.severity,  sublabel: ind.bankSpread.label }),
      renderStatusCard({ label: 'VIX',          value: ind.vix.value.toFixed(1),               severity: ind.vix.severity,         sublabel: ind.vix.label }),
      renderStatusCard({ label: 'Fin. Stress',  value: ind.fsi.value.toFixed(2),               severity: ind.fsi.severity,         sublabel: ind.fsi.label }),
      renderStatusCard({ label: 'Supply Chain', value: `${ind.supplyChain.value.toFixed(1)}σ`, severity: ind.supplyChain.severity,  sublabel: '~6wk lag' }),
      renderStatusCard({ label: 'Job Claims',   value: ind.jobClaims.value >= 1000 ? `${Math.round(ind.jobClaims.value / 1000)}K` : String(ind.jobClaims.value), severity: ind.jobClaims.severity, sublabel: ind.jobClaims.label }),
    ].join('');

    const fsVal = foodSecurity.value === null ? '—' : String(foodSecurity.value);
    const fsColor = foodSecurity.severity === 'critical' ? '#ef4444'
      : (foodSecurity.severity === 'warning' ? '#eab308' : '#22c55e');
    const fsLabel = foodSecurity.severity === 'critical' ? 'Severely stressed'
      : (foodSecurity.severity === 'warning' ? 'Moderately stressed' : 'Normal');

    const ts = new Date(data.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    el.innerHTML = `
<div style="padding:0.8rem;display:flex;flex-direction:column;gap:0.7rem;">
  <div>
    <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:0.35rem;">
      <div style="font-size:0.68rem;opacity:0.55;text-transform:uppercase;letter-spacing:0.05em;">Stress Index · ${ts}</div>
      <div style="display:flex;align-items:center;gap:0.35rem;">${trendGlyph}<div style="font-size:1.5rem;font-weight:700;color:${indexColor};line-height:1;">${stressIndex}<span style="font-size:0.8rem;opacity:0.5;">/100</span></div></div>
    </div>
    <div style="height:9px;background:rgba(255,255,255,0.07);border-radius:5px;overflow:hidden;position:relative;">
      <div style="position:absolute;inset:0;background:linear-gradient(90deg,#22c55e 0%,#eab308 50%,#ef4444 100%);opacity:0.25;border-radius:5px;"></div>
      <div style="position:absolute;left:${pct}%;top:0;width:2px;height:100%;background:#fff;border-radius:1px;transform:translateX(-50%);"></div>
      <div style="width:${pct}%;height:100%;background:linear-gradient(90deg,rgba(34,197,94,0.7) 0%,rgba(234,179,8,0.9) 60%,rgba(239,68,68,1) 100%);border-radius:5px;"></div>
    </div>
    <div style="display:flex;justify-content:space-between;font-size:0.62rem;opacity:0.38;margin-top:0.2rem;"><span>LOW</span><span>ELEVATED</span><span>CRITICAL</span></div>
  </div>
  <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:0.38rem;">${cards}</div>
  <div style="padding:0.4rem 0.55rem;background:rgba(255,255,255,0.04);border-radius:5px;font-size:0.7rem;opacity:0.75;">
    Global Food Security: <strong style="color:${fsColor};">${fsVal} / 100</strong> — ${fsLabel}
  </div>
</div>`;
  }

  private _renderKeyRequired(): void {
    const el = this.getContentElement();
    el.innerHTML = `<div style="padding:1rem;">${renderStatusCard({ label: 'Economic Stress', value: 'FRED API key required', severity: 'unknown', wide: true, sublabel: 'Add FRED_API_KEY in Settings → API Keys' })}</div>`;
  }

  private _renderError(): void {
    const el = this.getContentElement();
    el.innerHTML = `<div style="padding:1rem;">${renderStatusCard({ label: 'Economic Stress', value: 'Data unavailable', severity: 'unknown', wide: true })}</div>`;
  }
}
