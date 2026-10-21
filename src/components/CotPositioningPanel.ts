import type { MarketServiceClient } from '@/generated/client/worldmonitor/market/v1/service_client';
import { Panel } from './Panel';
import { t } from '@/services/i18n';
import { escapeHtml, unsafeRawHtml } from '@/utils/sanitize';

let _client: MarketServiceClient | null = null;
async function getMarketClient(): Promise<MarketServiceClient> {
  if (!_client) {
    const { MarketServiceClient } = await import('@/generated/client/worldmonitor/market/v1/service_client');
    const { getRpcBaseUrl } = await import('@/services/rpc-client');
    _client = new MarketServiceClient(getRpcBaseUrl(), { fetch: (...args: Parameters<typeof fetch>) => globalThis.fetch(...args) });
  }
  return _client;
}

interface CotInstrumentData {
  name: string;
  code: string;
  reportDate: string;
  assetManagerLong: string;
  assetManagerShort: string;
  leveragedFundsLong: string;
  leveragedFundsShort: string;
  smallTraderLong: string;
  smallTraderShort: string;
  smallTraderAvailable: boolean;
  dealerLong: string;
  dealerShort: string;
  netPct: number;
}

function toNum(v: string | number): number {
  return typeof v === 'number' ? v : parseInt(String(v), 10) || 0;
}

function renderPositionBar(netPct: number, label: string): string {
  const clamped = Math.max(-100, Math.min(100, netPct));
  const halfWidth = Math.abs(clamped) / 100 * 50;
  const color = clamped >= 0 ? '#2ecc71' : '#e74c3c';
  const leftPct = clamped >= 0 ? 50 : 50 - halfWidth;
  const sign = clamped >= 0 ? '+' : '';
  return `
    <div style="margin:3px 0">
      <div style="display:flex;justify-content:space-between;font-size:calc(9px * var(--wm-panel-effective-scale, 1));color:var(--text-dim);margin-bottom:2px">
        <span>${escapeHtml(label)}</span>
        <span style="color:${color};font-weight:600">${sign}${clamped.toFixed(1)}%</span>
      </div>
      <div style="position:relative;height:8px;background:rgba(255,255,255,0.06);border-radius:2px">
        <div style="position:absolute;top:0;bottom:0;left:50%;width:1px;background:rgba(255,255,255,0.15)"></div>
        <div style="position:absolute;top:0;bottom:0;left:${leftPct.toFixed(2)}%;width:${halfWidth.toFixed(2)}%;background:${color};border-radius:1px"></div>
      </div>
    </div>`;
}

function renderInstrument(item: CotInstrumentData): string {
  const levLong = toNum(item.leveragedFundsLong);
  const levShort = toNum(item.leveragedFundsShort);
  const smallLong = toNum(item.smallTraderLong);
  const smallShort = toNum(item.smallTraderShort);
  const amNetPct = item.netPct;
  const levNetPct = ((levLong - levShort) / Math.max(levLong + levShort, 1)) * 100;
  const smallNetPct = ((smallLong - smallShort) / Math.max(smallLong + smallShort, 1)) * 100;

  return `
    <div style="padding:8px 0;border-bottom:1px solid rgba(255,255,255,0.06)">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
        <span style="font-size:calc(12px * var(--wm-panel-effective-scale, 1));font-weight:600">${escapeHtml(item.name)}</span>
        <span style="font-size:calc(9px * var(--wm-panel-effective-scale, 1));color:var(--text-dim)">${escapeHtml(item.code)}</span>
      </div>
      ${renderPositionBar(amNetPct, 'Asset Managers')}
      ${renderPositionBar(levNetPct, 'Leveraged Funds')}
      ${item.smallTraderAvailable ? renderPositionBar(smallNetPct, 'Small Traders (non-reportable)') : ''}
    </div>`;
}

export class CotPositioningPanel extends Panel {
  private _hasData = false;

  constructor() {
    super({ id: 'cot-positioning', title: 'CFTC COT Positioning', showCount: false, infoTooltip: t('components.cotPositioning.infoTooltip') });
  }

  public async fetchData(): Promise<boolean> {
    this.showLoading();
    try {
      const client = await getMarketClient();
      const resp = await client.getCotPositioning({});
      if (resp.unavailable || !resp.instruments || resp.instruments.length === 0) {
        if (!this._hasData) this.showError('COT data unavailable', () => void this.fetchData());
        return false;
      }
      this._hasData = true;
      this.render(resp.instruments as CotInstrumentData[], resp.reportDate ?? '');
      return true;
    } catch (e) {
      if (!this._hasData) this.showError(e instanceof Error ? e.message : 'Failed to load', () => void this.fetchData());
      return false;
    }
  }

  private render(instruments: CotInstrumentData[], reportDate: string): void {
    const rows = instruments.map(renderInstrument).join('');
    const hasSmallTraderData = instruments.some((item) => item.smallTraderAvailable);
    const smallTraderCaveat = hasSmallTraderData
      ? 'Small traders use the CFTC non-reportable residual category. This seed stores the latest weekly snapshot, not historical releases, so a retail trend line is not shown.'
      : 'Small-trader positioning is unavailable until the next CFTC seed refresh. No retail trend line is shown.';
    const dateFooter = reportDate
      ? `<div style="font-size:calc(9px * var(--wm-panel-effective-scale, 1));color:var(--text-dim);margin-top:8px;text-align:right">Report date: ${escapeHtml(reportDate)}</div>`
      : '';
    const html = `
      <div style="padding:10px 14px">
        ${rows}
        <div style="margin-top:8px;padding:7px 8px;border:1px solid rgba(255,255,255,0.08);border-radius:4px;color:var(--text-dim);font-size:calc(9px * var(--wm-panel-effective-scale, 1));line-height:1.4">${escapeHtml(smallTraderCaveat)}</div>
        ${dateFooter}
      </div>`;
    this.setSafeContent(unsafeRawHtml(html, 'legacy Panel.setContent() migration'));
  }
}
