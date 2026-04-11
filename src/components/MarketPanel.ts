import { Panel } from './Panel';
import { t } from '@/services/i18n';
import type { MarketData, CryptoData, TokenData } from '@/types';
import { formatPrice, formatChange, getChangeClass, getHeatmapClass } from '@/utils';
import { escapeHtml } from '@/utils/sanitize';
import { miniSparkline } from '@/utils/sparkline';
import { SITE_VARIANT } from '@/config';
import {
  getMarketWatchlistEntries,
  parseMarketWatchlistInput,
  resetMarketWatchlist,
  setMarketWatchlistEntries,
} from '@/services/market-watchlist';

export class MarketPanel extends Panel {
  private settingsBtn: HTMLButtonElement | null = null;
  private overlay: HTMLElement | null = null;

  constructor() {
    super({ id: 'markets', title: t('panels.markets'), infoTooltip: t('components.markets.infoTooltip') });
    this.createSettingsButton();
  }

  private createSettingsButton(): void {
    this.settingsBtn = document.createElement('button');
    this.settingsBtn.className = 'live-news-settings-btn';
    this.settingsBtn.title = 'Customize market watchlist';
    this.settingsBtn.textContent = 'Watchlist';
    this.settingsBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.openWatchlistModal();
    });
    this.header.appendChild(this.settingsBtn);
  }

  private openWatchlistModal(): void {
    if (this.overlay) return;

    const current = getMarketWatchlistEntries();
    const currentText = current.length
      ? current.map((e) => (e.name ? `${e.symbol}|${e.name}` : e.symbol)).join('\n')
      : '';

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay active';
    overlay.id = 'marketWatchlistModal';
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) this.closeWatchlistModal();
    });

    const modal = document.createElement('div');
    modal.className = 'modal unified-settings-modal';
    modal.style.maxWidth = '680px';

    modal.innerHTML = `
      <div class="modal-header">
        <span class="modal-title">Market watchlist</span>
        <button class="modal-close" aria-label="Close">×</button>
      </div>
      <div style="padding:14px 16px 16px 16px">
        <div style="color:var(--text-dim);font-size:12px;line-height:1.4;margin-bottom:10px">
          Add extra tickers (comma or newline separated). Friendly labels supported: SYMBOL|Label.
          Example: TSLA|Tesla, AAPL|Apple, ^GSPC|S&P 500
          <br/>
          Tip: keep it under ~30 unless you enjoy scrolling.
        </div>
        <textarea id="wmMarketWatchlistInput"
          style="width:100%;min-height:120px;resize:vertical;background:rgba(255,255,255,0.04);border:1px solid var(--border);color:var(--text);border-radius:10px;padding:10px;font-family:inherit;font-size:12px;outline:none"
          spellcheck="false"></textarea>
        <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px">
          <button type="button" class="panels-reset-layout" id="wmMarketResetBtn">Reset</button>
          <button type="button" class="panels-reset-layout" id="wmMarketCancelBtn">Cancel</button>
          <button type="button" class="panels-reset-layout" id="wmMarketSaveBtn" style="border-color:var(--text-dim);color:var(--text)">Save</button>
        </div>
      </div>
    `;

    const closeBtn = modal.querySelector('.modal-close') as HTMLButtonElement | null;
    closeBtn?.addEventListener('click', () => this.closeWatchlistModal());

    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    this.overlay = overlay;

    const input = modal.querySelector<HTMLTextAreaElement>('#wmMarketWatchlistInput');
    if (input) input.value = currentText;

    modal.querySelector<HTMLButtonElement>('#wmMarketCancelBtn')?.addEventListener('click', () => this.closeWatchlistModal());
    modal.querySelector<HTMLButtonElement>('#wmMarketResetBtn')?.addEventListener('click', () => {
      resetMarketWatchlist();
      if (input) input.value = ''; // defaults are always included automatically
      this.closeWatchlistModal();
    });
    modal.querySelector<HTMLButtonElement>('#wmMarketSaveBtn')?.addEventListener('click', () => {
      const raw = input?.value || '';
      const parsed = parseMarketWatchlistInput(raw);
      if (parsed.length === 0) resetMarketWatchlist();
      else setMarketWatchlistEntries(parsed);
      this.closeWatchlistModal();
    });
  }

  private closeWatchlistModal(): void {
    if (!this.overlay) return;
    this.overlay.remove();
    this.overlay = null;
  }

  public renderMarkets(data: MarketData[], rateLimited?: boolean): void {
    if (data.length === 0) {
      this.showRetrying(rateLimited ? t('common.rateLimitedMarket') : t('common.failedMarketData'));
      return;
    }

    const html = data
      .map(
        (stock) => `
      <div class="market-item">
        <div class="market-info">
          <span class="market-name">${escapeHtml(stock.name)}</span>
          <span class="market-symbol">${escapeHtml(stock.display)}</span>
        </div>
        <div class="market-data">
          ${miniSparkline(stock.sparkline, stock.change)}
          <span class="market-price">${formatPrice(stock.price!)}</span>
          <span class="market-change ${getChangeClass(stock.change!)}">${formatChange(stock.change!)}</span>
        </div>
      </div>
    `
      )
      .join('');

    this.setContent(html);
  }
}

export interface SectorValuation {
  trailingPE: number | null;
  forwardPE: number | null;
  beta: number | null;
  ytdReturn: number | null;
  threeYearReturn: number | null;
  fiveYearReturn: number | null;
}

type HeatmapTab = 'performance' | 'valuations';

export class HeatmapPanel extends Panel {
  private _tab: HeatmapTab = 'performance';
  private _heatmapData: Array<{ symbol?: string; name: string; change: number | null }> = [];
  private _sectorBars: Array<{ symbol: string; name: string; change1d: number }> = [];
  private _valuations: Record<string, SectorValuation> = {};

  constructor() {
    super({ id: 'heatmap', title: t('panels.heatmap'), infoTooltip: t('components.heatmap.infoTooltip') });
    this.content.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-tab]');
      const tab = btn?.dataset.tab;
      if (tab === 'performance' || tab === 'valuations') {
        this._tab = tab;
        this._render();
      }
    });
  }

  public renderHeatmap(
    data: Array<{ symbol?: string; name: string; change: number | null }>,
    sectorBars?: Array<{ symbol: string; name: string; change1d: number }>,
  ): void {
    this._heatmapData = data;
    this._sectorBars = sectorBars ?? [];
    this._render();
  }

  public updateValuations(valuations: Record<string, SectorValuation> | undefined): void {
    // undefined = caller has no valuations to push (e.g. fresh fetch returned
    // a payload without the field). Leave prior state intact so returning
    // users don't see the Valuations tab vanish mid-session.
    if (valuations === undefined) return;
    if (Object.keys(valuations).length === 0) {
      this._valuations = {};
      if (this._tab === 'valuations') this._tab = 'performance';
      this._render();
      return;
    }
    this._valuations = valuations;
    this._render();
  }

  private _buildTabBar(): string {
    const hasValuations = Object.keys(this._valuations).length > 0;
    if (!hasValuations) return '';
    return `<div style="display:flex;gap:4px;margin-bottom:8px">
      <button class="panel-tab${this._tab === 'performance' ? ' active' : ''}" data-tab="performance" style="font-size:11px;padding:3px 10px">Performance</button>
      <button class="panel-tab${this._tab === 'valuations' ? ' active' : ''}" data-tab="valuations" style="font-size:11px;padding:3px 10px">Valuations</button>
    </div>`;
  }

  private _render(): void {
    if (this._heatmapData.length === 0) {
      this.showRetrying(t('common.failedSectorData'));
      return;
    }

    const tabBar = this._buildTabBar();

    if (this._tab === 'valuations' && Object.keys(this._valuations).length > 0) {
      this.setContent(tabBar + this._renderValuations());
      return;
    }

    this.setContent(tabBar + this._renderPerformance());
  }

  private _renderPerformance(): string {
    const data = this._heatmapData;
    const tileHtml =
      '<div class="heatmap">' +
      data
        .map((sector) => {
          const change = sector.change ?? 0;
          const tickerHtml = sector.symbol
            ? `<div class="sector-ticker">${escapeHtml(sector.symbol)}</div>`
            : '';
          return `
        <div class="heatmap-cell ${getHeatmapClass(change)}">
          ${tickerHtml}
          <div class="sector-change ${getChangeClass(change)}">${formatChange(change)}</div>
          <div class="sector-name">${escapeHtml(sector.name)}</div>
        </div>
      `;
        })
        .join('') +
      '</div>';

    if (this._sectorBars.length === 0) return tileHtml;

    const sorted = [...this._sectorBars]
      .filter((s) => Number.isFinite(s.change1d))
      .sort((a, b) => b.change1d - a.change1d);
    if (sorted.length === 0) return tileHtml;

    const maxAbs = Math.max(...sorted.map((s) => Math.abs(s.change1d)), 3);
    const barChartHtml =
      '<div class="heatmap-bar-chart">' +
      sorted
        .map((s) => {
          const pct = Math.min((Math.abs(s.change1d) / maxAbs) * 100, 100).toFixed(1);
          const isPos = s.change1d >= 0;
          const color = isPos ? 'var(--green)' : 'var(--red)';
          const sign = isPos ? '+' : '';
          return `<div class="heatmap-bar-row">
  <span class="heatmap-bar-label">${escapeHtml(s.symbol)}</span>
  <div class="heatmap-bar-track"><div class="heatmap-bar-fill" style="width:${pct}%;background:${color}"></div></div>
  <span class="heatmap-bar-value ${isPos ? 'positive' : 'negative'}">${sign}${s.change1d.toFixed(2)}%</span>
</div>`;
        })
        .join('') +
      '</div>';

    return tileHtml + barChartHtml;
  }

  private _renderValuations(): string {
    const entries = Object.entries(this._valuations)
      .map(([symbol, v]) => ({ symbol, ...v }))
      .filter((e) => e.forwardPE !== null || e.trailingPE !== null);

    if (entries.length === 0) {
      return '<div style="padding:8px;color:var(--text-dim);font-size:12px">No valuation data available</div>';
    }

    const sorted = [...entries].sort((a, b) => (a.forwardPE ?? a.trailingPE ?? 999) - (b.forwardPE ?? b.trailingPE ?? 999));
    const peValues = sorted.map((e) => e.forwardPE ?? e.trailingPE ?? 0).filter((v) => v > 0);
    const median = (peValues.length > 0 ? peValues[Math.floor(peValues.length / 2)] : undefined) ?? 20;
    const maxPE = Math.max(...peValues, 30);

    const nameMap = new Map(this._heatmapData.map((s) => [s.symbol, s.name]));
    const fmtPE = (v: number | null) => v !== null ? v.toFixed(1) : '--';
    const fmtPct = (v: number | null) => {
      if (v === null) return '--';
      const pct = v * 100;
      return `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`;
    };
    const fmtBeta = (v: number | null) => v !== null ? v.toFixed(2) : '--';

    const peColor = (v: number | null): string => {
      if (v === null) return 'var(--text-dim)';
      if (v < median * 0.8) return 'var(--green)';
      if (v > median * 1.2) return 'var(--red)';
      return '#e6a817';
    };

    const barChart =
      '<div class="heatmap-bar-chart" style="margin-bottom:12px">' +
      sorted
        .map((e) => {
          const pe = e.forwardPE ?? e.trailingPE ?? 0;
          const pct = Math.min((pe / maxPE) * 100, 100).toFixed(1);
          const color = peColor(pe > 0 ? pe : null);
          const label = nameMap.get(e.symbol) ?? e.symbol;
          return `<div class="heatmap-bar-row">
  <span class="heatmap-bar-label" title="${escapeHtml(e.symbol)}">${escapeHtml(label)}</span>
  <div class="heatmap-bar-track"><div class="heatmap-bar-fill" style="width:${pct}%;background:${color}"></div></div>
  <span class="heatmap-bar-value" style="color:${color}">${pe > 0 ? pe.toFixed(1) + 'x' : '--'}</span>
</div>`;
        })
        .join('') +
      '</div>';

    const tableRows = sorted
      .map((e) => {
        const name = nameMap.get(e.symbol) ?? e.symbol;
        return `<tr>
  <td style="padding:3px 6px;white-space:nowrap;font-size:11px">${escapeHtml(name)}</td>
  <td style="padding:3px 6px;text-align:right;font-size:11px;color:${peColor(e.trailingPE)}">${fmtPE(e.trailingPE)}</td>
  <td style="padding:3px 6px;text-align:right;font-size:11px;color:${peColor(e.forwardPE)}">${fmtPE(e.forwardPE)}</td>
  <td style="padding:3px 6px;text-align:right;font-size:11px">${fmtBeta(e.beta)}</td>
  <td style="padding:3px 6px;text-align:right;font-size:11px;color:${e.ytdReturn === null ? 'var(--text-dim)' : e.ytdReturn >= 0 ? 'var(--green)' : 'var(--red)'}">${fmtPct(e.ytdReturn)}</td>
</tr>`;
      })
      .join('');

    const table = `<div style="overflow-x:auto">
<table style="width:100%;border-collapse:collapse;font-size:11px">
  <thead><tr style="color:var(--text-dim);border-bottom:1px solid var(--border)">
    <th style="padding:3px 6px;text-align:left;font-weight:500">Sector</th>
    <th style="padding:3px 6px;text-align:right;font-weight:500">Trail P/E</th>
    <th style="padding:3px 6px;text-align:right;font-weight:500">Fwd P/E</th>
    <th style="padding:3px 6px;text-align:right;font-weight:500">Beta</th>
    <th style="padding:3px 6px;text-align:right;font-weight:500">YTD</th>
  </tr></thead>
  <tbody>${tableRows}</tbody>
</table></div>`;

    return barChart + table;
  }
}

interface EcbFxRateItem {
  currency: string;
  rate: number;
  change1d?: number | null;
}

type CommoditiesTab = 'commodities' | 'fx' | 'xau';

// CCYUSD=X (e.g. EURUSD): USD is quote, rate = USD/FC → XAU_FC = XAU_USD / rate
// USDCCY=X (e.g. USDJPY, USDCHF): USD is base, rate = FC/USD → XAU_FC = XAU_USD * rate
const XAU_CURRENCY_CONFIG: Array<{ symbol: string; label: string; flag: string; multiply: boolean }> = [
  { symbol: 'EURUSD=X',  label: 'EUR', flag: '🇪🇺', multiply: false },
  { symbol: 'GBPUSD=X',  label: 'GBP', flag: '🇬🇧', multiply: false },
  { symbol: 'USDJPY=X',  label: 'JPY', flag: '🇯🇵', multiply: true  },
  { symbol: 'USDCNY=X',  label: 'CNY', flag: '🇨🇳', multiply: true  },
  { symbol: 'USDINR=X',  label: 'INR', flag: '🇮🇳', multiply: true  },
  { symbol: 'AUDUSD=X',  label: 'AUD', flag: '🇦🇺', multiply: false },
  { symbol: 'USDCHF=X',  label: 'CHF', flag: '🇨🇭', multiply: true  },
  { symbol: 'USDCAD=X',  label: 'CAD', flag: '🇨🇦', multiply: true  },
  { symbol: 'USDTRY=X',  label: 'TRY', flag: '🇹🇷', multiply: true  },
];

export class CommoditiesPanel extends Panel {
  private _tab: CommoditiesTab = 'commodities';
  private _commodityData: Array<{ display: string; price: number | null; change: number | null; sparkline?: number[]; symbol?: string }> = [];
  private _fxRates: EcbFxRateItem[] = [];

  constructor() {
    super({ id: 'commodities', title: t('panels.commodities'), infoTooltip: t('components.commodities.infoTooltip') });

    this.content.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-tab]');
      const tab = btn?.dataset.tab;
      if (tab === 'commodities' || tab === 'fx' || (tab === 'xau' && SITE_VARIANT === 'commodity')) {
        this._tab = tab as CommoditiesTab;
        this._render();
      }
    });
  }

  public renderCommodities(data: Array<{ symbol?: string; display: string; price: number | null; change: number | null; sparkline?: number[] }>): void {
    this._commodityData = data;
    this._render();
  }

  public updateFxRates(rates: EcbFxRateItem[]): void {
    this._fxRates = rates;
    this._render();
  }

  private _buildTabBar(hasFx: boolean, hasXau: boolean): string {
    const firstTabLabel = 'Commodities';
    const tabs: string[] = [
      `<button class="panel-tab${this._tab === 'commodities' ? ' active' : ''}" data-tab="commodities" style="font-size:11px;padding:3px 10px">${firstTabLabel}</button>`,
    ];
    if (hasFx) tabs.push(`<button class="panel-tab${this._tab === 'fx' ? ' active' : ''}" data-tab="fx" style="font-size:11px;padding:3px 10px">EUR FX</button>`);
    if (hasXau) tabs.push(`<button class="panel-tab${this._tab === 'xau' ? ' active' : ''}" data-tab="xau" style="font-size:11px;padding:3px 10px">XAU/FX</button>`);
    return tabs.length > 1 ? `<div style="display:flex;gap:4px;margin-bottom:8px">${tabs.join('')}</div>` : '';
  }

  private _renderXau(): string {
    const gcf = this._commodityData.find(d => d.symbol === 'GC=F' && d.price !== null);
    if (!gcf?.price) return `<div style="padding:8px;color:var(--text-dim);font-size:12px">Gold price unavailable</div>`;

    const goldUsd = gcf.price;
    const fxMap = new Map(this._commodityData.filter(d => d.symbol?.endsWith('=X')).map(d => [d.symbol!, d]));

    const rows = XAU_CURRENCY_CONFIG.map(cfg => {
      const fx = fxMap.get(cfg.symbol);
      if (!fx?.price || !Number.isFinite(fx.price)) return null;
      const xauPrice = cfg.multiply ? goldUsd * fx.price : goldUsd / fx.price;
      if (!Number.isFinite(xauPrice) || xauPrice <= 0) return null;
      const formatted = Math.round(xauPrice).toLocaleString();
      return `<div class="commodity-item">
        <div class="commodity-name">${escapeHtml(cfg.flag)} XAU/${escapeHtml(cfg.label)}</div>
        <div class="commodity-price" style="font-size:11px">${escapeHtml(formatted)}</div>
      </div>`;
    }).filter(Boolean);

    if (rows.length === 0) {
      const placeholders = XAU_CURRENCY_CONFIG.map(cfg =>
        `<div class="commodity-item">
          <div class="commodity-name">${escapeHtml(cfg.flag)} XAU/${escapeHtml(cfg.label)}</div>
          <div class="commodity-price" style="font-size:11px">--</div>
        </div>`
      ).join('');
      return `<div class="commodities-grid">${placeholders}</div><div style="margin-top:6px;font-size:9px;color:var(--text-dim)">FX rates unavailable</div>`;
    }
    return `<div class="commodities-grid">${rows.join('')}</div><div style="margin-top:6px;font-size:9px;color:var(--text-dim)">Computed from GC=F + Yahoo FX</div>`;
  }

  private _render(): void {
    const hasFx = this._fxRates.length > 0;
    const hasXau = SITE_VARIANT === 'commodity' && this._commodityData.some(d => d.symbol === 'GC=F' && d.price !== null);
    if (this._tab === 'xau' && !hasXau) this._tab = 'commodities';
    const tabBar = this._buildTabBar(hasFx, hasXau);

    if (this._tab === 'fx' && hasFx) {
      const items = this._fxRates.map(r => {
        const change = r.change1d ?? null;
        const changeStr = change !== null ? `${change >= 0 ? '+' : ''}${change.toFixed(4)}` : '';
        const changeClass = change === null ? '' : change >= 0 ? 'change-positive' : 'change-negative';
        return `<div class="commodity-item">
          <div class="commodity-name">EUR/${escapeHtml(r.currency)}</div>
          <div class="commodity-price">${escapeHtml(r.rate.toFixed(4))}</div>
          ${changeStr ? `<div class="commodity-change ${escapeHtml(changeClass)}">${escapeHtml(changeStr)}</div>` : ''}
        </div>`;
      }).join('');
      this.setContent(tabBar + `<div class="commodities-grid">${items}</div><div style="margin-top:6px;font-size:9px;color:var(--text-dim)">Source: ECB</div>`);
      return;
    }

    if (this._tab === 'xau' && hasXau) {
      this.setContent(tabBar + this._renderXau());
      return;
    }

    // Metals/Commodities tab — exclude FX and spot gold symbols from the display grid
    const validData = this._commodityData.filter(
      (d) => d.price !== null && !d.symbol?.endsWith('=X'),
    );
    if (validData.length === 0) {
      if (!hasFx) {
        this.showRetrying(t('common.failedCommodities'));
        return;
      }
      this.setContent(tabBar + `<div style="padding:8px;color:var(--text-dim);font-size:12px">${t('common.failedCommodities')}</div>`);
      return;
    }

    const grid = '<div class="commodities-grid">' +
      validData.map(c => `
        <div class="commodity-item">
          <div class="commodity-name">${escapeHtml(c.display)}</div>
          ${miniSparkline(c.sparkline, c.change, 60, 18)}
          <div class="commodity-price">${formatPrice(c.price!)}</div>
          <div class="commodity-change ${getChangeClass(c.change!)}">${formatChange(c.change!)}</div>
        </div>
      `).join('') + '</div>';

    this.setContent(tabBar + grid);
  }
}

export class CryptoPanel extends Panel {
  constructor() {
    super({ id: 'crypto', title: t('panels.crypto'), infoTooltip: t('components.crypto.infoTooltip') });
  }

  public renderCrypto(data: CryptoData[]): void {
    if (data.length === 0) {
      this.showRetrying(t('common.failedCryptoData'));
      return;
    }

    const html = data
      .map(
        (coin) => `
      <div class="market-item">
        <div class="market-info">
          <span class="market-name">${escapeHtml(coin.name)}</span>
          <span class="market-symbol">${escapeHtml(coin.symbol)}</span>
        </div>
        <div class="market-data">
          ${miniSparkline(coin.sparkline, coin.change)}
          <span class="market-price">$${coin.price.toLocaleString()}</span>
          <span class="market-change ${getChangeClass(coin.change)}">${formatChange(coin.change)}</span>
        </div>
      </div>
    `
      )
      .join('');

    this.setContent(html);
  }
}

export class CryptoHeatmapPanel extends Panel {
  constructor() {
    super({ id: 'crypto-heatmap', title: 'Crypto Sectors' });
  }

  public renderSectors(data: Array<{ id: string; name: string; change: number }>): void {
    if (data.length === 0) {
      this.showRetrying(t('common.failedSectorData'));
      return;
    }

    const html =
      '<div class="heatmap">' +
      data
        .map((sector) => {
          const change = sector.change ?? 0;
          return `
        <div class="heatmap-cell ${getHeatmapClass(change)}">
          <div class="sector-name">${escapeHtml(sector.name)}</div>
          <div class="sector-change ${getChangeClass(change)}">${formatChange(change)}</div>
        </div>
      `;
        })
        .join('') +
      '</div>';

    this.setContent(html);
  }
}

export class TokenListPanel extends Panel {
  public renderTokens(data: TokenData[]): void {
    if (data.length === 0) {
      this.showRetrying(t('common.failedCryptoData'));
      return;
    }

    const rows = data
      .map(
        (tok) => `
      <div class="market-item">
        <div class="market-info">
          <span class="market-name">${escapeHtml(tok.name)}</span>
          <span class="market-symbol">${escapeHtml(tok.symbol)}</span>
        </div>
        <div class="market-data">
          <span class="market-price">$${tok.price.toLocaleString(undefined, { maximumFractionDigits: tok.price < 1 ? 6 : 2 })}</span>
          <span class="market-change ${getChangeClass(tok.change24h)}">${formatChange(tok.change24h)}</span>
          <span class="market-change market-change--7d ${getChangeClass(tok.change7d)}">${formatChange(tok.change7d)}W</span>
        </div>
      </div>
    `
      )
      .join('');

    this.setContent(rows);
  }
}

export class DefiTokensPanel extends TokenListPanel {
  constructor() {
    super({ id: 'defi-tokens', title: 'DeFi Tokens', infoTooltip: t('components.defiTokens.infoTooltip') });
  }
}

export class AiTokensPanel extends TokenListPanel {
  constructor() {
    super({ id: 'ai-tokens', title: 'AI Tokens', infoTooltip: t('components.aiTokens.infoTooltip') });
  }
}

export class OtherTokensPanel extends TokenListPanel {
  constructor() {
    super({ id: 'other-tokens', title: 'Alt Tokens', infoTooltip: t('components.altTokens.infoTooltip') });
  }
}
