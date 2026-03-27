import { Panel } from './Panel';
import { t } from '@/services/i18n';
import type { MarketData, CryptoData, TokenData } from '@/types';
import { formatPrice, formatChange, getChangeClass, getHeatmapClass } from '@/utils';
import { escapeHtml } from '@/utils/sanitize';
import { miniSparkline } from '@/utils/sparkline';
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

export class CommoditiesPanel extends Panel {
  constructor() {
    super({ id: 'commodities', title: t('panels.commodities'), infoTooltip: t('components.commodities.infoTooltip') });
  }

  public renderCommodities(data: Array<{ display: string; price: number | null; change: number | null; sparkline?: number[] }>): void {
    const validData = data.filter((d) => d.price !== null);

    if (validData.length === 0) {
      this.showRetrying(t('common.failedCommodities'));
      return;
    }

    const html =
      '<div class="commodities-grid">' +
      validData
        .map(
          (c) => `
        <div class="commodity-item">
          <div class="commodity-name">${escapeHtml(c.display)}</div>
          ${miniSparkline(c.sparkline, c.change, 60, 18)}
          <div class="commodity-price">${formatPrice(c.price!)}</div>
          <div class="commodity-change ${getChangeClass(c.change!)}">${formatChange(c.change!)}</div>
        </div>
      `
        )
        .join('') +
      '</div>';

    this.setContent(html);
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
