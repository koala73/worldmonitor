import type { MarketServiceClient } from '@/generated/client/worldmonitor/market/v1/service_client';
import type { EconomicServiceClient, GetEuFsiResponse } from '@/generated/client/worldmonitor/economic/v1/service_client';
import { Panel } from './Panel';
import { t } from '@/services/i18n';
import { escapeHtml } from '@/utils/sanitize';
import { getHydratedData } from '@/services/bootstrap';

let _marketClient: MarketServiceClient | null = null;
async function getMarketClient(): Promise<MarketServiceClient> {
  if (!_marketClient) {
    const { MarketServiceClient } = await import('@/generated/client/worldmonitor/market/v1/service_client');
    const { getRpcBaseUrl } = await import('@/services/rpc-client');
    _marketClient = new MarketServiceClient(getRpcBaseUrl(), { fetch: (...args: Parameters<typeof fetch>) => globalThis.fetch(...args) });
  }
  return _marketClient;
}

let _economicClient: EconomicServiceClient | null = null;
async function getEconomicClient(): Promise<EconomicServiceClient> {
  if (!_economicClient) {
    const { EconomicServiceClient } = await import('@/generated/client/worldmonitor/economic/v1/service_client');
    const { getRpcBaseUrl } = await import('@/services/rpc-client');
    _economicClient = new EconomicServiceClient(getRpcBaseUrl(), { fetch: (...args: Parameters<typeof fetch>) => globalThis.fetch(...args) });
  }
  return _economicClient;
}

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

function cissLabelColor(label: string): string {
  if (label === 'Low') return '#27ae60';
  if (label === 'Moderate') return '#f39c12';
  if (label === 'Elevated') return '#e67e22';
  return '#c0392b';
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
    super({ id: 'fsi', title: 'Financial Stress Indicator', showCount: false, infoTooltip: t('components.fsi.infoTooltip') });
  }

  public async fetchData(): Promise<boolean> {
    this.showLoading();
    try {
      const hydrated = getHydratedData('fearGreedIndex') as Record<string, unknown> | undefined;
      let fsiValue = 0;
      let fsiLabel = '';
      let hygPrice = 0;
      let tltPrice = 0;
      let vix = 0;
      let hySpread = 0;

      if (hydrated && !hydrated.unavailable) {
        const hdr = (hydrated.headerMetrics ?? {}) as Record<string, Record<string, unknown> | null>;
        fsiValue = Number(hdr?.fsi?.value ?? 0);
        fsiLabel = String(hdr?.fsi?.label ?? '');
        vix = Number(hdr?.vix?.value ?? 0);
        hySpread = Number(hdr?.hySpread?.value ?? 0);
      }

      if (fsiValue <= 0) {
        const client = await getMarketClient();
        const resp = await client.getFearGreedIndex({});
        if (!resp.unavailable && resp.fsiValue > 0) {
          fsiValue = resp.fsiValue;
          fsiLabel = resp.fsiLabel;
          hygPrice = resp.hygPrice;
          tltPrice = resp.tltPrice;
          vix = resp.vix;
          hySpread = resp.hySpread;
        }
      }

      if (fsiValue <= 0) {
        if (!this._hasData) this.showError('FSI data unavailable', () => void this.fetchData());
        return false;
      }

      // Fetch EU CISS — check hydrated bootstrap first, then RPC fallback
      let euFsi: GetEuFsiResponse | null = null;
      try {
        const hydratedEuFsi = getHydratedData('euFsi') as GetEuFsiResponse | undefined;
        if (hydratedEuFsi && !hydratedEuFsi.unavailable && Number.isFinite(hydratedEuFsi.latestValue)) {
          euFsi = hydratedEuFsi;
        } else {
          const econClient = await getEconomicClient();
          const euResp = await econClient.getEuFsi({});
          if (!euResp.unavailable && Number.isFinite(euResp.latestValue)) euFsi = euResp;
        }
      } catch {
        // CISS unavailable — render without it
      }

      this._hasData = true;
      this.render({ fsiValue, fsiLabel, hygPrice, tltPrice, vix, hySpread }, euFsi);
      return true;
    } catch (e) {
      if (!this._hasData) this.showError(e instanceof Error ? e.message : 'Failed to load', () => void this.fetchData());
      return false;
    }
  }

  private render(
    resp: { fsiValue: number; fsiLabel: string; hygPrice: number; tltPrice: number; vix: number; hySpread: number },
    euFsi: GetEuFsiResponse | null,
  ): void {
    const { fsiValue, fsiLabel, hygPrice, tltPrice, vix, hySpread } = resp;
    const labelColor = fsiLabelColor(fsiLabel);
    const fillPct = Math.min(Math.max((fsiValue / 2.5) * 100, 0), 100);
    const interpretation = fsiInterpretation(fsiLabel);

    const cissSection = euFsi
      ? `<div style="margin-top:12px;padding-top:12px;border-top:1px solid rgba(255,255,255,0.07)">
          <div style="font-size:10px;color:var(--text-dim);text-transform:uppercase;letter-spacing:0.06em;margin-bottom:8px">EU CISS (Euro Area Systemic Stress)</div>
          <div style="display:flex;align-items:center;gap:12px;margin-bottom:8px">
            <div style="font-size:28px;font-weight:700;color:${cissLabelColor(euFsi.label)};line-height:1">${euFsi.latestValue.toFixed(4)}</div>
            <div>
              <div style="font-size:12px;font-weight:600;color:${cissLabelColor(euFsi.label)}">${escapeHtml(euFsi.label)}</div>
              <div style="font-size:10px;color:var(--text-dim)">${escapeHtml(euFsi.latestDate ? new Date(euFsi.latestDate).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '')}</div>
            </div>
          </div>
          <div style="background:rgba(255,255,255,0.07);border-radius:4px;height:6px;overflow:hidden">
            <div style="height:100%;width:${(euFsi.latestValue * 100).toFixed(1)}%;background:linear-gradient(90deg,#27ae60,#f39c12,#c0392b);border-radius:4px"></div>
          </div>
          <div style="display:flex;justify-content:space-between;font-size:9px;color:var(--text-dim);margin-top:3px">
            <span>0 — No stress</span><span>1 — Extreme stress</span>
          </div>
        </div>`
      : '';

    const html = `<div style="padding:12px 14px">
      <div style="text-align:center;margin-bottom:16px">
        <div style="font-size:11px;color:var(--text-dim);margin-bottom:4px">US FSI VALUE</div>
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
      ${cissSection}
    </div>`;

    this.setContent(html);
  }
}
