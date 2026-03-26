import { Panel } from './Panel';
import { escapeHtml } from '@/utils/sanitize';

function fsiLabelColor(label: string): string {
  if (label === 'Low Stress') return '#27ae60';
  if (label === 'Moderate Stress') return '#f39c12';
  if (label === 'Elevated Stress') return '#e67e22';
  return '#c0392b';
}

function fsiInterpretation(label: string): string {
  if (label === 'Low Stress') return 'Credit markets functioning normally, equity/bond ratio healthy.';
  if (label === 'Moderate Stress') return 'Some deterioration in credit conditions, monitor closely.';
  if (label === 'Elevated Stress') return 'Significant credit market stress, defensive positioning warranted.';
  return 'Severe financial stress, systemic risk elevated.';
}

function metricCard(label: string, value: string): string {
  return `<div style="background:rgba(255,255,255,0.04);border-radius:6px;padding:8px 10px;border:1px solid rgba(255,255,255,0.07)">
    <div style="font-size:9px;color:var(--text-dim);text-transform:uppercase;letter-spacing:0.06em;margin-bottom:4px">${escapeHtml(label)}</div>
    <div style="font-size:16px;font-weight:600;color:var(--text)">${escapeHtml(value)}</div>
  </div>`;
}

export class FSIPanel extends Panel {
  private _hasData = false;

  constructor() {
    super({ id: 'fsi', title: 'Financial Stress Indicator', showCount: false });
  }

  public async fetchData(): Promise<boolean> {
    this.showLoading();
    try {
      const { MarketServiceClient } = await import('@/generated/client/worldmonitor/market/v1/service_client');
      const { getRpcBaseUrl } = await import('@/services/rpc-client');
      const client = new MarketServiceClient(getRpcBaseUrl(), { fetch: (...args: Parameters<typeof fetch>) => globalThis.fetch(...args) });
      const resp = await client.getFearGreedIndex({});
      if (resp.unavailable || resp.fsiValue <= 0) {
        if (!this._hasData) this.showError('FSI data unavailable', () => void this.fetchData());
        return false;
      }
      this._hasData = true;
      this.render(resp);
      return true;
    } catch (e) {
      if (!this._hasData) this.showError(e instanceof Error ? e.message : 'Failed to load', () => void this.fetchData());
      return false;
    }
  }

  private render(resp: { fsiValue: number; fsiLabel: string; hygPrice: number; tltPrice: number; vix: number; hySpread: number }): void {
    const { fsiValue, fsiLabel, hygPrice, tltPrice, vix, hySpread } = resp;
    const labelColor = fsiLabelColor(fsiLabel);
    const fillPct = Math.min(Math.max((fsiValue - 0.01) / (0.15 - 0.01) * 100, 0), 100);
    const interpretation = fsiInterpretation(fsiLabel);

    const html = `<div style="padding:12px 14px">
      <div style="text-align:center;margin-bottom:16px">
        <div style="font-size:11px;color:var(--text-dim);margin-bottom:4px">FSI VALUE</div>
        <div style="font-size:36px;font-weight:700;color:${labelColor};line-height:1">${fsiValue.toFixed(4)}</div>
        <div style="font-size:13px;font-weight:600;color:${labelColor};margin-top:4px">${escapeHtml(fsiLabel)}</div>
      </div>
      <div style="margin:0 0 12px">
        <div style="display:flex;justify-content:space-between;font-size:9px;color:var(--text-dim);margin-bottom:3px">
          <span>High Stress</span><span>Low Stress</span>
        </div>
        <div style="background:rgba(255,255,255,0.07);border-radius:4px;height:8px;overflow:hidden">
          <div style="height:100%;width:${fillPct.toFixed(1)}%;background:linear-gradient(90deg,#c0392b,#f39c12,#27ae60);border-radius:4px"></div>
        </div>
      </div>
      <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:8px;margin-bottom:12px">
        ${metricCard('VIX', vix > 0 ? vix.toFixed(2) : 'N/A')}
        ${metricCard('HY Spread', hySpread > 0 ? hySpread.toFixed(2) + '%' : 'N/A')}
        ${metricCard('HYG Price', hygPrice > 0 ? '$' + hygPrice.toFixed(2) : 'N/A')}
        ${metricCard('TLT Price', tltPrice > 0 ? '$' + tltPrice.toFixed(2) : 'N/A')}
      </div>
      <div style="font-size:11px;color:var(--text-dim);background:rgba(255,255,255,0.03);border-radius:6px;padding:8px 10px;border-left:3px solid ${labelColor}">
        ${escapeHtml(interpretation)}
      </div>
    </div>`;

    this.setContent(html);
  }
}
