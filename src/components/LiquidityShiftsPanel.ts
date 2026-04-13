import type { MarketServiceClient } from '@/generated/client/worldmonitor/market/v1/service_client';
import { Panel } from './Panel';
import { t } from '@/services/i18n';
import { escapeHtml } from '@/utils/sanitize';
import { formatChange, getChangeClass } from '@/utils';

let _client: MarketServiceClient | null = null;

async function getMarketClient(): Promise<MarketServiceClient> {
  if (!_client) {
    const { MarketServiceClient } = await import('@/generated/client/worldmonitor/market/v1/service_client');
    const { getRpcBaseUrl } = await import('@/services/rpc-client');
    _client = new MarketServiceClient(getRpcBaseUrl(), { fetch: (...args: Parameters<typeof fetch>) => globalThis.fetch(...args) });
  }
  return _client;
}

const TOP_STOCKS = ['AAPL', 'MSFT', 'NVDA', 'AMZN', 'GOOGL', 'META', 'TSLA'];
const COT_PRIORITY = ['CL', 'GC', 'SI', 'ES', 'NQ'];

// Display aliases for CFTC instrument codes that aren't self-explanatory.
const INSTRUMENT_LABELS: Record<string, string> = {
  ES: 'S&P 500 futures',
  NQ: 'Nasdaq futures',
};

function toNum(v: string | number): number {
  if (typeof v === 'number') return v;
  const n = parseInt(String(v), 10);
  return Number.isFinite(n) ? n : 0;
}

function renderShiftPill(value: number | null): string {
  if (value === null) return '<span class="commodity-change">—</span>';
  return `<span class="commodity-change ${getChangeClass(value)}">${formatChange(value)}</span>`;
}

function pct(longPos: number, shortPos: number): number | null {
  const gross = longPos + shortPos;
  if (gross <= 0) return null;
  return ((longPos - shortPos) / gross) * 100;
}

function formatLevShift(value: number | null): string {
  if (value === null) return '—';
  const sign = value >= 0 ? '+' : '';
  return `${sign}${value.toFixed(1)}%`;
}

export class LiquidityShiftsPanel extends Panel {
  private _hasData = false;

  constructor() {
    super({
      id: 'liquidity-shifts',
      title: t('components.liquidityShifts.title'),
      showCount: false,
      infoTooltip: t('components.liquidityShifts.infoTooltip'),
    });
  }

  public async fetchData(): Promise<boolean> {
    this.showLoading();
    try {
      const client = await getMarketClient();
      const [cotResp, stocksResp] = await Promise.all([
        client.getCotPositioning({}),
        client.listMarketQuotes({ symbols: TOP_STOCKS }),
      ]);

      const cotRows = (cotResp.instruments ?? [])
        .filter((i) => COT_PRIORITY.includes(i.code ?? ''))
        .sort((a, b) => COT_PRIORITY.indexOf(a.code ?? '') - COT_PRIORITY.indexOf(b.code ?? ''));

      if (cotRows.length === 0 && (stocksResp.quotes?.length ?? 0) === 0) {
        if (!this._hasData) this.showError(t('components.liquidityShifts.unavailable'), () => void this.fetchData());
        return false;
      }

      this._hasData = true;
      const cotHtml = cotRows.map((row) => {
        const longPos = toNum(row.assetManagerLong ?? 0);
        const shortPos = toNum(row.assetManagerShort ?? 0);
        const net = pct(longPos, shortPos);
        const levLong = toNum(row.leveragedFundsLong ?? 0);
        const levShort = toNum(row.leveragedFundsShort ?? 0);
        // CFTC Disaggregated report (GC/SI/CL) has no Leveraged Funds
        // category — only TFF report (ES/NQ) does. Skip the sub-line entirely
        // rather than render a misleading "Lev +0.0%" for commodity rows.
        const hasLev = levLong > 0 || levShort > 0;
        const levNet = hasLev ? pct(levLong, levShort) : null;
        const code = row.code ?? '';
        const label = INSTRUMENT_LABELS[code] ?? row.name ?? code;
        const levLine = hasLev
          ? `<div class="market-symbol">${t('components.liquidityShifts.lev')} ${escapeHtml(formatLevShift(levNet))}</div>`
          : '';

        return `<div class="liquidity-row">
          <div class="liquidity-row__info">
            <div class="market-name">${escapeHtml(label)}</div>
            <div class="market-symbol">${escapeHtml(code)} • ${t('components.liquidityShifts.longShort', { long: String(longPos), short: String(shortPos) })}</div>
          </div>
          <div class="liquidity-row__values">
            <div>${renderShiftPill(net)}</div>
            ${levLine}
          </div>
        </div>`;
      }).join('');

      // The RPC preserves seed-bootstrap order, not request order, so re-sort
      // by TOP_STOCKS to keep the panel's row order stable.
      const stockOrder = new Map(TOP_STOCKS.map((sym, i) => [sym, i]));
      const stocks = [...(stocksResp.quotes ?? [])].sort((a, b) => {
        const ai = stockOrder.get(a.symbol ?? '') ?? Number.MAX_SAFE_INTEGER;
        const bi = stockOrder.get(b.symbol ?? '') ?? Number.MAX_SAFE_INTEGER;
        return ai - bi;
      });
      const stockRows = stocks
        .map((q) => {
          const ch = Number(q.change ?? 0);
          return `<div class="market-item liquidity-stock-row">
            <div class="market-info">
              <span class="market-name">${escapeHtml(q.name || q.symbol || '')}</span>
              <span class="market-symbol">${escapeHtml(q.symbol || '')}</span>
            </div>
            <div>${renderShiftPill(ch)}</div>
          </div>`;
        })
        .join('');

      const emptyCot = `<div class="market-symbol">${t('components.liquidityShifts.noCot')}</div>`;
      const emptyStocks = `<div class="market-symbol">${t('components.liquidityShifts.noStocks')}</div>`;
      const reportDateLine = cotResp.reportDate
        ? `<div class="market-symbol liquidity-report-date">${t('components.liquidityShifts.reportDate', { date: cotResp.reportDate })}</div>`
        : '';

      this.setContent(`
        <div class="liquidity-shifts-panel">
          <div class="liquidity-shifts-panel__section-title">${t('components.liquidityShifts.cotSection')}</div>
          ${cotHtml || emptyCot}
          <div class="liquidity-shifts-panel__section-title liquidity-shifts-panel__section-title--gap">${t('components.liquidityShifts.stocksSection')}</div>
          ${stockRows || emptyStocks}
          ${reportDateLine}
        </div>
      `);
      return true;
    } catch (e) {
      if (!this._hasData) this.showError(e instanceof Error ? e.message : t('components.liquidityShifts.failed'), () => void this.fetchData());
      return false;
    }
  }
}
