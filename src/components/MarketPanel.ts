import { Panel } from './Panel';
import { t } from '@/services/i18n';
import type { MarketData, CryptoData, TokenData } from '@/types';
import { formatPrice, formatChange, getChangeClass, getHeatmapClass } from '@/utils';
import { escapeHtml, unsafeRawHtml } from '@/utils/sanitize';
import { miniSparkline } from '@/utils/sparkline';
import { SITE_VARIANT } from '@/config';
import { createWatchlistButton } from './watchlist-modal';
import {
  renderChinaCorporateDisclosureSignals,
  type ChinaCorporateDisclosureSnapshot,
} from './market-disclosures';
import {
  composeMarketPanelContent,
  groupUnavailableSymbols,
  type UnavailableSymbolGroup,
} from './market-panel-content';
import type {
  MarketQuoteUnavailable,
  MarketQuoteUnavailableReason,
} from '@/generated/client/worldmonitor/market/v1/service_client';
import { openMarketChartModal } from './market-chart-modal';
import {
  bindMarketChartActivation,
  getMarketChartRowAttributes,
} from './market-chart-interactions';

// Not in the `common` namespace on purpose: `common` ships whole inside the
// budgeted first-paint shell bundle, and this notice only ever renders after a
// market fetch has completed.
const UNAVAILABLE_REASON_KEYS: Record<MarketQuoteUnavailableReason, string> = {
  MARKET_QUOTE_UNAVAILABLE_REASON_UNSPECIFIED: 'components.markets.unavailable.notFound',
  MARKET_QUOTE_UNAVAILABLE_REASON_NOT_FOUND: 'components.markets.unavailable.notFound',
  MARKET_QUOTE_UNAVAILABLE_REASON_PROVIDER_ERROR: 'components.markets.unavailable.providerError',
  MARKET_QUOTE_UNAVAILABLE_REASON_PROVIDER_RATE_LIMITED: 'components.markets.unavailable.rateLimited',
  MARKET_QUOTE_UNAVAILABLE_REASON_PROVIDER_NOT_CONFIGURED: 'components.markets.unavailable.notConfigured',
  MARKET_QUOTE_UNAVAILABLE_REASON_REQUEST_LIMIT_EXCEEDED: 'components.markets.unavailable.requestLimit',
  MARKET_QUOTE_UNAVAILABLE_REASON_UPSTREAM_BUDGET_EXHAUSTED: 'components.markets.unavailable.budget',
  MARKET_QUOTE_UNAVAILABLE_REASON_SEED_UNAVAILABLE: 'components.markets.unavailable.seed',
};

function unavailableSymbolLine(group: UnavailableSymbolGroup): string {
  // An unrecognized reason (a server ahead of this bundle) still names the
  // symbols rather than dropping the line — silence is the bug being fixed.
  const reason = t(UNAVAILABLE_REASON_KEYS[group.reason] ?? 'components.markets.unavailable.notFound');
  const symbols = group.symbols.join(', ');
  return group.overflow > 0
    ? t('components.markets.unavailable.symbolsMore', { symbols, count: group.overflow, reason })
    : t('components.markets.unavailable.symbols', { symbols, reason });
}

export class MarketPanel extends Panel {
  private _markets: MarketData[] = [];
  private _marketsRateLimited = false;
  private _marketsUnavailable: readonly MarketQuoteUnavailable[] = [];
  private _disclosures: ChinaCorporateDisclosureSnapshot | null = null;

  constructor() {
    super({ id: 'markets', title: t('panels.markets'), infoTooltip: t('components.markets.infoTooltip') });
    this.header.appendChild(createWatchlistButton());

    // Delegated once on the persistent content element (each render only swaps
    // innerHTML): click or Enter/Space on a plottable ticker opens its terminal chart.
    bindMarketChartActivation(this.content, () => this._markets, openMarketChartModal);
  }

  public renderMarkets(
    data: MarketData[],
    rateLimited?: boolean,
    unavailable?: readonly MarketQuoteUnavailable[],
  ): void {
    this._markets = data;
    this._marketsRateLimited = Boolean(rateLimited);
    this._marketsUnavailable = unavailable ?? [];
    this._renderMarketsAndDisclosures();
  }

  public renderDisclosures(snapshot: ChinaCorporateDisclosureSnapshot | null | undefined): void {
    this._disclosures = snapshot ?? null;
    this._renderMarketsAndDisclosures();
  }

  private _renderMarketsAndDisclosures(): void {
    const disclosureHtml = renderChinaCorporateDisclosureSignals(this._disclosures);
    const marketsHtml = this._markets
      .map((stock, idx) => {
        const attrs = getMarketChartRowAttributes(
          stock,
          idx,
          t('components.markets.chart.title', { symbol: stock.display }),
        );
        return `
      <div${attrs}>
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
    `;
      })
      .join('');
    const content = composeMarketPanelContent({
      hasMarkets: this._markets.length > 0,
      marketsHtml,
      disclosureHtml,
      unavailableMessage: this._marketsRateLimited
        ? t('common.rateLimitedMarket')
        : t('common.failedMarketData'),
      unavailableSymbolLines: groupUnavailableSymbols(this._marketsUnavailable).map(unavailableSymbolLine),
    });
    if (content.kind === 'retry') {
      this.showRetrying(content.message);
      return;
    }
    this.setSafeContent(unsafeRawHtml(
      content.html,
      'legacy Panel.setContent() migration',
    ));
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
  private _staleValuationSymbols: Set<string> = new Set();

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

  public updateValuations(
    valuations: Record<string, SectorValuation> | undefined,
    staleSymbols?: string[],
  ): void {
    // undefined = caller has no valuations to push (e.g. fresh fetch returned
    // a payload without the field). Leave prior state intact so returning
    // users don't see the Valuations tab vanish mid-session.
    if (valuations === undefined) return;
    this._staleValuationSymbols = new Set((staleSymbols ?? []).map((s) => s.toUpperCase()));
    if (Object.keys(valuations).length === 0) {
      this._valuations = {};
      if (this._tab === 'valuations') this._tab = 'performance';
      this._render();
      return;
    }
    // A record replayed from the seeder's last-good snapshot can arrive with
    // null-valued keys omitted. `SectorValuation` declares them `number | null`,
    // and every formatter guards with `=== null`, so a MISSING key would slip
    // through and reach `undefined.toFixed()`. Coerce to the declared shape.
    const normalized: Record<string, SectorValuation> = {};
    for (const [symbol, value] of Object.entries(valuations)) {
      normalized[symbol] = {
        trailingPE: value?.trailingPE ?? null,
        forwardPE: value?.forwardPE ?? null,
        beta: value?.beta ?? null,
        ytdReturn: value?.ytdReturn ?? null,
        threeYearReturn: value?.threeYearReturn ?? null,
        fiveYearReturn: value?.fiveYearReturn ?? null,
      };
    }
    this._valuations = normalized;
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
      this.setSafeContent(unsafeRawHtml(tabBar + this._renderValuations(), 'legacy Panel.setContent() migration'));
      return;
    }

    this.setSafeContent(unsafeRawHtml(tabBar + this._renderPerformance(), 'legacy Panel.setContent() migration'));
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
        // A stale row carries real numbers replayed from the seeder's last-good
        // snapshot, so it must not read as current data.
        const isStale = this._staleValuationSymbols.has(e.symbol.toUpperCase());
        const staleMark = isStale
          ? ` <span title="Last known value; not refreshed this cycle" style="color:var(--text-dim);font-size:9px">(stale)</span>`
          : '';
        return `<tr${isStale ? ' style="opacity:0.65"' : ''}>
  <td style="padding:3px 6px;white-space:nowrap;font-size:11px">${escapeHtml(name)}${staleMark}</td>
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

// Use the generated types directly — never hand-roll a subset, which silently
// drifts when the proto gains fields.
import type {
  GetHyperliquidFlowResponse,
  HyperliquidAssetFlow,
} from '@/generated/client/worldmonitor/market/v1/service_client';

function parseFiniteNumber(s: string): number | null {
  if (typeof s !== 'string' || s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * OI Δ1h derived from sparkOi tail: (last - lookback) / lookback.
 * 12 samples back = 1h at 5min cadence. Returns null if too few samples.
 */
function oiDelta1h(sparkOi: number[]): number | null {
  if (!Array.isArray(sparkOi) || sparkOi.length < 13) return null;
  const last = sparkOi[sparkOi.length - 1];
  const lookback = sparkOi[sparkOi.length - 13];
  if (last == null || lookback == null) return null;
  if (!(lookback > 0) || !Number.isFinite(last)) return null;
  return (last - lookback) / lookback;
}

/**
 * Map the raw bootstrap-hydrated seed snapshot (seeder JSON shape) into the
 * same view model the RPC mapper produces. Bootstrap returns the raw Redis
 * blob (numeric fields), not the proto response (string-encoded numbers).
 */
export function mapHyperliquidFlowSeed(raw: Record<string, unknown>): HyperliquidFlowView | null {
  const assets = Array.isArray(raw.assets) ? (raw.assets as Array<Record<string, unknown>>) : null;
  if (!assets || assets.length === 0) return null;
  const fxAssets: HyperliquidAssetView[] = [];
  const commodityAssets: HyperliquidAssetView[] = [];
  for (const a of assets) {
    const funding = typeof a.funding === 'number' && Number.isFinite(a.funding) ? a.funding : null;
    const sparkOi = Array.isArray(a.sparkOi) ? (a.sparkOi as number[]).filter((v) => Number.isFinite(v)) : [];
    const sparkScore = Array.isArray(a.sparkScore) ? (a.sparkScore as number[]).filter((v) => Number.isFinite(v)) : [];
    const view: HyperliquidAssetView = {
      symbol: String(a.symbol ?? ''),
      display: String(a.display ?? ''),
      group: String(a.group ?? ''),
      funding,
      oiDelta1h: oiDelta1h(sparkOi),
      composite: typeof a.composite === 'number' ? a.composite : 0,
      warmup: Boolean(a.warmup),
      stale: Boolean(a.stale),
      sparkScore,
    };
    if (view.group === 'fx') fxAssets.push(view);
    else commodityAssets.push(view);
  }
  return {
    ts: typeof raw.ts === 'number' ? raw.ts : 0,
    warmup: Boolean(raw.warmup),
    fxAssets,
    commodityAssets,
    unavailable: false,
  };
}

export function mapHyperliquidFlowResponse(resp: GetHyperliquidFlowResponse): HyperliquidFlowView {
  const fxAssets: HyperliquidAssetView[] = [];
  const commodityAssets: HyperliquidAssetView[] = [];
  for (const a of resp.assets as HyperliquidAssetFlow[]) {
    const view: HyperliquidAssetView = {
      symbol: a.symbol,
      display: a.display,
      group: a.group,
      funding: parseFiniteNumber(a.funding),
      oiDelta1h: oiDelta1h(a.sparkOi),
      composite: Number(a.composite || 0),
      warmup: Boolean(a.warmup),
      stale: Boolean(a.stale),
      sparkScore: Array.isArray(a.sparkScore) ? a.sparkScore : [],
    };
    if (a.group === 'fx') fxAssets.push(view);
    else commodityAssets.push(view);
  }
  return {
    ts: Number(resp.ts || 0),
    warmup: Boolean(resp.warmup),
    fxAssets,
    commodityAssets,
    unavailable: false,
  };
}

interface HyperliquidAssetView {
  symbol: string;
  display: string;
  group: string;
  funding: number | null;
  oiDelta1h: number | null;
  composite: number;
  warmup: boolean;
  stale: boolean;
  sparkScore: number[];
}

interface HyperliquidFlowView {
  ts: number;
  warmup: boolean;
  fxAssets: HyperliquidAssetView[];
  commodityAssets: HyperliquidAssetView[];
  unavailable: boolean;
}

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
      if (
        tab === 'commodities' ||
        tab === 'fx' ||
        (tab === 'xau' && SITE_VARIANT === 'commodity')
      ) {
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
        // Zero is signless and neutral, matching the FX panel (#6199). The
        // seeder writes 0 both for "unchanged" and for "no prior observation"
        // (scripts/seed-ecb-fx-rates.mjs), so a green "+0.0000" claims a gain
        // that may not even be a measurement. These two surfaces render the
        // same seeded field and must not disagree about it.
        const changeStr = change !== null ? `${change > 0 ? '+' : ''}${change.toFixed(4)}` : '';
        const changeClass = change === null || change === 0 ? '' : change > 0 ? 'change-positive' : 'change-negative';
        return `<div class="commodity-item">
          <div class="commodity-name">EUR/${escapeHtml(r.currency)}</div>
          <div class="commodity-price">${escapeHtml(r.rate.toFixed(4))}</div>
          ${changeStr ? `<div class="commodity-change ${escapeHtml(changeClass)}">${escapeHtml(changeStr)}</div>` : ''}
        </div>`;
      }).join('');
      this.setSafeContent(unsafeRawHtml(tabBar + `<div class="commodities-grid">${items}</div><div style="margin-top:6px;font-size:9px;color:var(--text-dim)">Source: ECB</div>`, 'legacy Panel.setContent() migration'));
      return;
    }

    if (this._tab === 'xau' && hasXau) {
      this.setSafeContent(unsafeRawHtml(tabBar + this._renderXau(), 'legacy Panel.setContent() migration'));
      return;
    }

    // Metals/Commodities tab — exclude FX and spot gold symbols from the display grid.
    // Require a finite numeric price: the feed sometimes omits `price` (undefined),
    // and `d.price !== null` lets undefined through to `formatPrice(c.price!)`
    // (WORLDMONITOR-SH). A finite-price guard also keeps the adjacent `c.change!`
    // row meaningful (a record with no price carries no usable change either).
    const validData = this._commodityData.filter(
      (d) => typeof d.price === 'number' && Number.isFinite(d.price) && !d.symbol?.endsWith('=X'),
    );
    if (validData.length === 0) {
      if (!hasFx) {
        this.showRetrying(t('common.failedCommodities'));
        return;
      }
      this.setSafeContent(unsafeRawHtml(tabBar + `<div style="padding:8px;color:var(--text-dim);font-size:12px">${t('common.failedCommodities')}</div>`, 'legacy Panel.setContent() migration'));
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

    this.setSafeContent(unsafeRawHtml(tabBar + grid, 'legacy Panel.setContent() migration'));
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

    this.setSafeContent(unsafeRawHtml(html, 'legacy Panel.setContent() migration'));
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

    this.setSafeContent(unsafeRawHtml(html, 'legacy Panel.setContent() migration'));
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

    this.setSafeContent(unsafeRawHtml(rows, 'legacy Panel.setContent() migration'));
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
