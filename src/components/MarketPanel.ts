import { Panel } from './Panel';
import { t } from '@/services/i18n';
import type { MarketData, CryptoData, TokenData } from '@/types';
import { formatPrice, formatChange, getChangeClass, getHeatmapClass } from '@/utils';
import { escapeHtml } from '@/utils/sanitize';
import { miniSparkline } from '@/utils/sparkline';
import { SITE_VARIANT } from '@/config';
import {
  STOCK_CATALOG,
  REGION_LABELS,
  MARKET_SYMBOLS,
  type CatalogSymbol,
} from '@/config/markets';
import {
  getCatalogSelection,
  setCatalogSelection,
  clearCatalogSelection,
} from '@/services/market-watchlist';

export class MarketPanel extends Panel {
  private pickerOverlay: HTMLElement | null = null;
  private escHandler: ((e: KeyboardEvent) => void) | null = null;

  constructor() {
    super({ id: 'markets', title: t('panels.markets'), infoTooltip: t('components.markets.infoTooltip') });
    this.addEditButton();
  }

  private addEditButton(): void {
    const btn = document.createElement('button');
    btn.className = 'icon-btn market-edit-btn';
    btn.title = 'Customize watchlist';
    btn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg>`;

    const closeBtn = this.header.querySelector('.panel-close-btn');
    if (closeBtn) {
      this.header.insertBefore(btn, closeBtn);
    } else {
      this.header.appendChild(btn);
    }

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.openPicker();
    });
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

  private openPicker(): void {
    if (this.pickerOverlay) return;

    const saved = getCatalogSelection();
    const defaultSyms = MARKET_SYMBOLS.map((s) => s.symbol);
    const selected = new Set(saved || defaultSyms);

    let activeRegion = 'all';
    let filterText = '';

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay active';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-label', 'Customize Markets');
    this.pickerOverlay = overlay;

    const regionKeys = Object.keys(REGION_LABELS);

    const getVisible = (): CatalogSymbol[] => {
      let list: CatalogSymbol[] = STOCK_CATALOG;
      if (activeRegion !== 'all') {
        list = list.filter((s) => s.region === activeRegion);
      }
      if (filterText) {
        const q = filterText.toLowerCase();
        list = list.filter(
          (s) =>
            s.name.toLowerCase().includes(q) ||
            s.symbol.toLowerCase().includes(q) ||
            s.display.toLowerCase().includes(q),
        );
      }
      return list;
    };

    const renderPills = () => {
      const bar = overlay.querySelector('.wl-region-bar');
      if (!bar) return;
      let html = `<button class="wl-pill${activeRegion === 'all' ? ' active' : ''}" data-region="all">All</button>`;
      for (const key of regionKeys) {
        html += `<button class="wl-pill${activeRegion === key ? ' active' : ''}" data-region="${key}">${escapeHtml(REGION_LABELS[key] || key)}</button>`;
      }
      bar.innerHTML = html;
    };

    const renderGrid = () => {
      const grid = overlay.querySelector('.wl-grid');
      if (!grid) return;
      const visible = getVisible();
      grid.innerHTML = visible
        .map((s) => {
          const on = selected.has(s.symbol);
          return `<div class="wl-item${on ? ' active' : ''}" data-symbol="${escapeHtml(s.symbol)}">
          <div class="wl-check">${on ? '&#10003;' : ''}</div>
          <div class="wl-item-info">
            <span class="wl-item-name">${escapeHtml(s.name)}</span>
            <span class="wl-item-ticker">${escapeHtml(s.display)}</span>
          </div>
        </div>`;
        })
        .join('');
      updateCounter();
    };

    const updateCounter = () => {
      const el = overlay.querySelector('.wl-counter');
      if (el) el.textContent = `${selected.size} selected`;
    };

    overlay.innerHTML = `
      <div class="modal wl-modal">
        <div class="modal-header">
          <span class="modal-title">Customize Watchlist</span>
          <button class="modal-close wl-close" aria-label="Close">&times;</button>
        </div>
        <div class="wl-region-bar"></div>
        <div class="wl-search">
          <input type="text" placeholder="Search stocks, indices..." />
        </div>
        <div class="wl-grid"></div>
        <div class="wl-footer">
          <span class="wl-counter"></span>
          <div class="wl-actions">
            <button class="wl-btn wl-reset">Reset defaults</button>
            <button class="wl-btn wl-btn-primary wl-save">Save</button>
          </div>
        </div>
      </div>
    `;

    overlay.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;

      if (target === overlay || target.closest('.wl-close')) {
        this.closePicker();
        return;
      }

      const pill = target.closest<HTMLElement>('.wl-pill');
      if (pill?.dataset.region) {
        activeRegion = pill.dataset.region;
        renderPills();
        renderGrid();
        return;
      }

      const item = target.closest<HTMLElement>('.wl-item');
      if (item?.dataset.symbol) {
        const sym = item.dataset.symbol;
        if (selected.has(sym)) selected.delete(sym);
        else selected.add(sym);
        item.classList.toggle('active');
        const check = item.querySelector('.wl-check');
        if (check) check.innerHTML = selected.has(sym) ? '&#10003;' : '';
        updateCounter();
        return;
      }

      if (target.closest('.wl-reset')) {
        clearCatalogSelection();
        this.closePicker();
        return;
      }

      if (target.closest('.wl-save')) {
        const ordered = STOCK_CATALOG
          .filter((s) => selected.has(s.symbol))
          .map((s) => s.symbol);
        if (ordered.length > 0) {
          setCatalogSelection(ordered);
        } else {
          clearCatalogSelection();
        }
        this.closePicker();
        return;
      }
    });

    overlay.addEventListener('input', (e) => {
      const input = e.target as HTMLInputElement;
      if (input.closest('.wl-search')) {
        filterText = input.value;
        renderGrid();
      }
    });

    this.escHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') this.closePicker();
    };
    document.addEventListener('keydown', this.escHandler);

    document.body.appendChild(overlay);
    renderPills();
    renderGrid();
  }

  private closePicker(): void {
    if (this.pickerOverlay) {
      this.pickerOverlay.remove();
      this.pickerOverlay = null;
    }
    if (this.escHandler) {
      document.removeEventListener('keydown', this.escHandler);
      this.escHandler = null;
    }
  }
}

export class HeatmapPanel extends Panel {
  constructor() {
    super({ id: 'heatmap', title: t('panels.heatmap'), infoTooltip: t('components.heatmap.infoTooltip') });
  }

  public renderHeatmap(
    data: Array<{ symbol?: string; name: string; change: number | null }>,
    sectorBars?: Array<{ symbol: string; name: string; change1d: number }>,
  ): void {
    if (data.length === 0) {
      this.showRetrying(t('common.failedSectorData'));
      return;
    }

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

    let barChartHtml = '';
    if (sectorBars && sectorBars.length > 0) {
      const sorted = [...sectorBars]
        .filter((s) => Number.isFinite(s.change1d))
        .sort((a, b) => b.change1d - a.change1d);
      if (sorted.length === 0) {
        this.setContent(tileHtml);
        return;
      }
      const maxAbs = Math.max(...sorted.map((s) => Math.abs(s.change1d)), 3);
      barChartHtml =
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
    }

    this.setContent(tileHtml + barChartHtml);
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
