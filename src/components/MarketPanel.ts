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
import { PHYSICAL_DIVERGENCE_CONTRACT } from '../../shared/physical-divergence-contract.js';
import { openMarketChartModal } from './market-chart-modal';
import { navigateToStockResearch } from '@/features/stock-research/stock-research-overlay';
import { normalizeStockResearchSymbol } from '@/features/stock-research/stock-research-route';
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
    // Rows are marked role="button" purely on having a plottable series, so
    // every one of them must lead somewhere. The research route only accepts
    // /^[A-Z][A-Z0-9.-]{0,14}$/, which rejects the caret-prefixed indices
    // (^GSPC, ^DJI, ^IXIC …) and digit-leading Asian tickers (0700.HK,
    // 600519.SS …) that lead this panel — those keep the chart modal rather
    // than becoming announced-but-inert controls.
    bindMarketChartActivation(this.content, () => this._markets, (stock) => {
      if (normalizeStockResearchSymbol(stock.symbol)) navigateToStockResearch(stock.symbol, stock);
      else openMarketChartModal(stock);
    });
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
      <button class="panel-tab${this._tab === 'performance' ? ' active' : ''}" data-tab="performance" style="font-size:calc(11px * var(--wm-panel-effective-scale, 1));padding:3px 10px">Performance</button>
      <button class="panel-tab${this._tab === 'valuations' ? ' active' : ''}" data-tab="valuations" style="font-size:calc(11px * var(--wm-panel-effective-scale, 1));padding:3px 10px">Valuations</button>
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
      return '<div style="padding:8px;color:var(--text-dim);font-size:calc(12px * var(--wm-panel-effective-scale, 1))">No valuation data available</div>';
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
          ? ` <span title="Last known value; not refreshed this cycle" style="color:var(--text-dim);font-size:calc(9px * var(--wm-panel-effective-scale, 1))">(stale)</span>`
          : '';
        return `<tr${isStale ? ' style="opacity:0.65"' : ''}>
  <td style="padding:3px 6px;white-space:nowrap;font-size:calc(11px * var(--wm-panel-effective-scale, 1))">${escapeHtml(name)}${staleMark}</td>
  <td style="padding:3px 6px;text-align:right;font-size:calc(11px * var(--wm-panel-effective-scale, 1));color:${peColor(e.trailingPE)}">${fmtPE(e.trailingPE)}</td>
  <td style="padding:3px 6px;text-align:right;font-size:calc(11px * var(--wm-panel-effective-scale, 1));color:${peColor(e.forwardPE)}">${fmtPE(e.forwardPE)}</td>
  <td style="padding:3px 6px;text-align:right;font-size:calc(11px * var(--wm-panel-effective-scale, 1))">${fmtBeta(e.beta)}</td>
  <td style="padding:3px 6px;text-align:right;font-size:calc(11px * var(--wm-panel-effective-scale, 1));color:${e.ytdReturn === null ? 'var(--text-dim)' : e.ytdReturn >= 0 ? 'var(--green)' : 'var(--red)'}">${fmtPct(e.ytdReturn)}</td>
</tr>`;
      })
      .join('');

    const table = `<div style="overflow-x:auto">
<table style="width:100%;border-collapse:collapse;font-size:calc(11px * var(--wm-panel-effective-scale, 1))">
  <thead><tr style="color:var(--text-dim);border-bottom:1px solid var(--border)">
    <th scope="col" style="padding:3px 6px;text-align:left;font-weight:500">Sector</th>
    <th scope="col" style="padding:3px 6px;text-align:right;font-weight:500">Trail P/E</th>
    <th scope="col" style="padding:3px 6px;text-align:right;font-weight:500">Fwd P/E</th>
    <th scope="col" style="padding:3px 6px;text-align:right;font-weight:500">Beta</th>
    <th scope="col" style="padding:3px 6px;text-align:right;font-weight:500">YTD</th>
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

export type CommoditiesTab = 'commodities' | 'physical' | 'fx' | 'xau';

export interface CommoditiesTabSelectionResult {
  ok: boolean;
  status: 'applied' | 'skipped' | 'denied' | 'invalid';
  effectiveTab: CommoditiesTab;
  reason?: 'unknown_tab' | 'tab_unavailable';
}

// Use the generated types directly — never hand-roll a subset, which silently
// drifts when the proto gains fields.
import type {
  GetPhysicalDivergenceIndexResponse,
  GetPhysicalPremiumsResponse,
  GetHyperliquidFlowResponse,
  HyperliquidAssetFlow,
  PhysicalDivergenceReading,
  PhysicalDivergenceState,
  PhysicalPremiumRegime,
  PhysicalPremiumTrend,
  PhysicalPremium,
} from '@/generated/client/worldmonitor/market/v1/service_client';

function physicalDivergenceStateCopy(
  state: PhysicalDivergenceState,
  historyPoints: number,
  reason = '',
): string {
  switch (state) {
    case 'PHYSICAL_DIVERGENCE_STATE_OK':
      return '';
    case 'PHYSICAL_DIVERGENCE_STATE_INSUFFICIENT_HISTORY':
      return t('components.commodities.divergence.states.insufficientHistory', {
        count: historyPoints,
        required: PHYSICAL_DIVERGENCE_CONTRACT.history.minimumPoints,
      });
    case 'PHYSICAL_DIVERGENCE_STATE_STALE_INPUT':
      if (reason === PHYSICAL_DIVERGENCE_CONTRACT.reasons.physicalPrintStale) {
        return `${t('components.commodities.physical')}: ${t('popups.expired')}`;
      }
      if (reason === PHYSICAL_DIVERGENCE_CONTRACT.reasons.paperSnapshotStale) {
        return `${t('components.commodities.paper')}: ${t('popups.expired')}`;
      }
      if (reason === PHYSICAL_DIVERGENCE_CONTRACT.reasons.fxSnapshotStale) {
        return `FX: ${t('popups.expired')}`;
      }
      return t('components.commodities.divergence.states.staleInput');
    case 'PHYSICAL_DIVERGENCE_STATE_MISSING_INPUT':
      return t('components.commodities.divergence.states.missingInput');
    case 'PHYSICAL_DIVERGENCE_STATE_UNSPECIFIED':
      throw new Error('Physical divergence state is unspecified');
    default: {
      const exhaustive: never = state;
      throw new Error(`Unknown physical divergence state: ${String(exhaustive)}`);
    }
  }
}

function physicalRegimeLabel(regime: PhysicalPremiumRegime): string {
  switch (regime) {
    case 'PHYSICAL_PREMIUM_REGIME_NORMAL':
      return t('components.commodities.divergence.regimes.normal');
    case 'PHYSICAL_PREMIUM_REGIME_ELEVATED':
      return t('components.commodities.divergence.regimes.elevated');
    case 'PHYSICAL_PREMIUM_REGIME_STRESSED':
      return t('components.commodities.divergence.regimes.stressed');
    case 'PHYSICAL_PREMIUM_REGIME_EXTREME':
      return t('components.commodities.divergence.regimes.extreme');
    case 'PHYSICAL_PREMIUM_REGIME_UNSPECIFIED':
      throw new Error('Ok physical divergence reading has no regime');
    default: {
      const exhaustive: never = regime;
      throw new Error(`Unknown physical premium regime: ${String(exhaustive)}`);
    }
  }
}

function physicalRegimeColor(regime: PhysicalPremiumRegime): string {
  switch (regime) {
    case 'PHYSICAL_PREMIUM_REGIME_NORMAL': return 'var(--green)';
    case 'PHYSICAL_PREMIUM_REGIME_ELEVATED': return 'var(--yellow)';
    case 'PHYSICAL_PREMIUM_REGIME_STRESSED': return 'var(--orange, #f97316)';
    case 'PHYSICAL_PREMIUM_REGIME_EXTREME': return 'var(--red)';
    case 'PHYSICAL_PREMIUM_REGIME_UNSPECIFIED':
      throw new Error('Ok physical divergence reading has no regime color');
    default: {
      const exhaustive: never = regime;
      throw new Error(`Unknown physical premium regime color: ${String(exhaustive)}`);
    }
  }
}

function physicalTrendArrow(trend: PhysicalPremiumTrend): string {
  switch (trend) {
    case 'PHYSICAL_PREMIUM_TREND_WIDENING': return '↑';
    case 'PHYSICAL_PREMIUM_TREND_STABLE': return '→';
    case 'PHYSICAL_PREMIUM_TREND_NARROWING': return '↓';
    case 'PHYSICAL_PREMIUM_TREND_UNSPECIFIED':
      throw new Error('Ok physical divergence reading has no trend');
    default: {
      const exhaustive: never = trend;
      throw new Error(`Unknown physical premium trend: ${String(exhaustive)}`);
    }
  }
}

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
  private _physicalPremiums: PhysicalPremium[] = [];
  private _physicalPremiumFxAsOf = '';
  private _physicalDivergence: GetPhysicalDivergenceIndexResponse | null = null;
  private _physicalDivergenceUnavailable = false;
  private _physicalComparisonAttempted = false;

  constructor() {
    super({ id: 'commodities', title: t('panels.commodities'), infoTooltip: t('components.commodities.infoTooltip') });

    this.content.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-tab]');
      const tab = btn?.dataset.tab;
      if (tab) this.selectTab(tab);
    });
  }

  public getActiveTab(): CommoditiesTab {
    return this._tab;
  }

  public shouldRefreshPhysicalComparison(): boolean {
    return !this._physicalComparisonAttempted
      || this._tab === 'physical'
      || this._physicalPremiums.length === 0
      || this._physicalDivergenceUnavailable;
  }

  public selectTab(tab: string): CommoditiesTabSelectionResult {
    if (!['commodities', 'physical', 'fx', 'xau'].includes(tab)) {
      return { ok: false, status: 'invalid', effectiveTab: this._tab, reason: 'unknown_tab' };
    }
    const next = tab as CommoditiesTab;
    const available = next === 'commodities'
      || (next === 'physical' && this._physicalPremiums.length > 0)
      || (next === 'fx' && this._fxRates.length > 0)
      || (
        next === 'xau'
        && SITE_VARIANT === 'commodity'
        && this._commodityData.some((entry) => entry.symbol === 'GC=F' && entry.price !== null)
      );
    if (!available) {
      return { ok: false, status: 'denied', effectiveTab: this._tab, reason: 'tab_unavailable' };
    }
    if (this._tab === next) return { ok: true, status: 'skipped', effectiveTab: this._tab };
    this._tab = next;
    this._render();
    return { ok: true, status: 'applied', effectiveTab: this._tab };
  }

  public renderCommodities(data: Array<{ symbol?: string; display: string; price: number | null; change: number | null; sparkline?: number[] }>): void {
    this._commodityData = data;
    this._render();
  }

  public updateFxRates(rates: EcbFxRateItem[]): void {
    this._fxRates = rates;
    this._render();
  }

  public updatePhysicalPremiums(response: GetPhysicalPremiumsResponse): void {
    this._physicalComparisonAttempted = true;
    this._physicalPremiums = response.premiums;
    this._physicalPremiumFxAsOf = response.fx?.asOf ?? '';
    this._render();
  }

  public updatePhysicalDivergence(response: GetPhysicalDivergenceIndexResponse): void {
    this._physicalComparisonAttempted = true;
    this._physicalDivergence = response;
    this._physicalDivergenceUnavailable = false;
    this._render();
  }

  public showPhysicalDivergenceUnavailable(): void {
    this._physicalComparisonAttempted = true;
    this._physicalDivergence = null;
    this._physicalDivergenceUnavailable = true;
    this._render();
  }

  private _buildTabBar(hasPhysical: boolean, hasFx: boolean, hasXau: boolean): string {
    const firstTabLabel = t('components.commodities.commodities');
    const tabs: string[] = [
      `<button class="panel-tab${this._tab === 'commodities' ? ' active' : ''}" data-tab="commodities" style="font-size:calc(11px * var(--wm-panel-effective-scale, 1));padding:3px 10px">${firstTabLabel}</button>`,
    ];
    if (hasPhysical) tabs.push(`<button class="panel-tab${this._tab === 'physical' ? ' active' : ''}" data-tab="physical" style="font-size:calc(11px * var(--wm-panel-effective-scale, 1));padding:3px 10px">${t('components.commodities.physicalPremiums')}</button>`);
    if (hasFx) tabs.push(`<button class="panel-tab${this._tab === 'fx' ? ' active' : ''}" data-tab="fx" style="font-size:calc(11px * var(--wm-panel-effective-scale, 1));padding:3px 10px">EUR FX</button>`);
    if (hasXau) tabs.push(`<button class="panel-tab${this._tab === 'xau' ? ' active' : ''}" data-tab="xau" style="font-size:calc(11px * var(--wm-panel-effective-scale, 1));padding:3px 10px">XAU/FX</button>`);
    return tabs.length > 1 ? `<div style="display:flex;gap:4px;margin-bottom:8px">${tabs.join('')}</div>` : '';
  }

  private _renderPhysicalPremiums(): string {
    const rows = this._physicalPremiums.map((premium) => {
      if (!premium.physical || !premium.paper) return '';
      const metalKey = premium.metal === 'gold' ? 'gold' : 'silver';
      const metal = t(`components.commodities.metals.${metalKey}`);
      const unit = premium.physical.unit === 'kilogram' ? 'kg' : 'g';
      const physicalPrice = premium.physical.price.toLocaleString(undefined, { maximumFractionDigits: 2 });
      const paperPrice = premium.paper.price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      const premiumUsd = `${premium.premiumUsdPerOz >= 0 ? '+' : '-'}$${Math.abs(premium.premiumUsdPerOz).toFixed(2)}`;
      const premiumPct = `${premium.premiumPct >= 0 ? '+' : ''}${premium.premiumPct.toFixed(2)}%`;
      const divergence = this._physicalDivergence?.readings.find((reading) => reading.metal === premium.metal);
      const cohortMatches = divergence
        ? this._physicalDivergenceCohortMatches(divergence, premium)
        : false;
      const divergenceStatus = this._physicalDivergenceUnavailable
        ? ''
        : divergence && cohortMatches
        ? this._renderPhysicalDivergenceReading(divergence)
        : this._renderPhysicalDivergenceState('PHYSICAL_DIVERGENCE_STATE_MISSING_INPUT', 0);
      return `<div class="commodity-item physical-premium-item">
        <div class="commodity-name">${escapeHtml(metal)}</div>
        <div class="commodity-price">${escapeHtml(t('components.commodities.physical'))}: CNY ${escapeHtml(physicalPrice)}/${unit}</div>
        <div class="commodity-price">${escapeHtml(t('components.commodities.paper'))}: $${escapeHtml(paperPrice)}/oz</div>
        <div class="commodity-change ${getChangeClass(premium.premiumPct)}">${escapeHtml(t('components.commodities.premium'))}: ${escapeHtml(premiumUsd)}/oz (${escapeHtml(premiumPct)})</div>
        ${divergenceStatus}
        <div style="margin-top:4px;font-size:calc(9px * var(--wm-panel-effective-scale, 1));color:var(--text-dim)" title="${escapeHtml(premium.physical.source)}">${escapeHtml(premium.physical.source)}<br>${escapeHtml(t('components.commodities.asOf', { date: premium.physical.asOf }))}</div>
      </div>`;
    });
    const composite = this._renderPhysicalDivergenceComposite();
    return `${composite}<div class="commodities-grid">${rows.join('')}</div>`;
  }

  private _renderPhysicalDivergenceReading(reading: PhysicalDivergenceReading): string {
    if (reading.state !== 'PHYSICAL_DIVERGENCE_STATE_OK') {
      return this._renderPhysicalDivergenceState(reading.state, reading.historyPoints, reading.reason);
    }
    const label = physicalRegimeLabel(reading.regime);
    const color = physicalRegimeColor(reading.regime);
    const arrow5d = physicalTrendArrow(reading.trend5d);
    const arrow20d = physicalTrendArrow(reading.trend20d);
    return `<div class="physical-divergence-state" style="display:flex;align-items:center;gap:6px;margin-top:4px;font-size:calc(10px * var(--wm-panel-effective-scale, 1))">
      <span style="border:1px solid ${color};color:${color};border-radius:999px;padding:1px 6px">${escapeHtml(label)}</span>
      <span title="${escapeHtml(t('components.commodities.divergence.fiveDayTrend'))}">${escapeHtml(arrow5d)} 5d</span>
      <span title="${escapeHtml(t('components.commodities.divergence.twentyDayTrend'))}">${escapeHtml(arrow20d)} 20d</span>
    </div>`;
  }

  private _renderPhysicalDivergenceState(
    state: PhysicalDivergenceState,
    historyPoints: number,
    reason = '',
  ): string {
    return `<div class="physical-divergence-state" style="margin-top:4px;font-size:calc(10px * var(--wm-panel-effective-scale, 1));color:var(--text-dim)">${escapeHtml(physicalDivergenceStateCopy(state, historyPoints, reason))}</div>`;
  }

  private _renderPhysicalDivergenceComposite(): string {
    if (this._physicalDivergenceUnavailable) {
      return `<div class="physical-divergence-transport-error" style="margin-bottom:8px;font-size:calc(10px * var(--wm-panel-effective-scale, 1));color:var(--text-dim)">${escapeHtml(t('common.failedMarketData'))}</div>`;
    }
    const composite = this._physicalDivergence?.composite;
    if (!composite) return '';
    let label: string;
    const cohortsMatch = this._physicalPremiums.every((premium) => {
      const reading = this._physicalDivergence?.readings.find((candidate) => candidate.metal === premium.metal);
      return reading ? this._physicalDivergenceCohortMatches(reading, premium) : false;
    });
    if (!cohortsMatch) {
      label = physicalDivergenceStateCopy('PHYSICAL_DIVERGENCE_STATE_MISSING_INPUT', 0);
    } else if (composite.state === 'PHYSICAL_DIVERGENCE_STATE_OK') {
      if (composite.index == null) throw new Error('Ok physical divergence composite has no index');
      label = t('components.commodities.divergence.compositeValue', { value: composite.index.toFixed(1) });
    } else {
      const nonOkMember = this._physicalDivergence?.readings.find((reading) => reading.state === composite.state)
        ?? this._physicalDivergence?.readings.find((reading) => reading.state !== 'PHYSICAL_DIVERGENCE_STATE_OK');
      label = physicalDivergenceStateCopy(
        composite.state,
        nonOkMember?.historyPoints ?? 0,
        nonOkMember?.reason ?? composite.reason,
      );
    }
    return `<div class="physical-divergence-composite" style="margin-bottom:8px;font-size:calc(10px * var(--wm-panel-effective-scale, 1));color:var(--text-dim)">${escapeHtml(label)}</div>`;
  }

  private _physicalDivergenceCohortMatches(
    reading: PhysicalDivergenceReading,
    premium: PhysicalPremium,
  ): boolean {
    return reading.physicalAsOf === premium.physical?.asOf
      && reading.paperAsOf === Date.parse(premium.paper?.asOf ?? '')
      && reading.provenance?.fxAsOf === Date.parse(this._physicalPremiumFxAsOf);
  }

  private _renderXau(): string {
    const gcf = this._commodityData.find(d => d.symbol === 'GC=F' && d.price !== null);
    if (!gcf?.price) return `<div style="padding:8px;color:var(--text-dim);font-size:calc(12px * var(--wm-panel-effective-scale, 1))">Gold price unavailable</div>`;

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
        <div class="commodity-price" style="font-size:calc(11px * var(--wm-panel-effective-scale, 1))">${escapeHtml(formatted)}</div>
      </div>`;
    }).filter(Boolean);

    if (rows.length === 0) {
      const placeholders = XAU_CURRENCY_CONFIG.map(cfg =>
        `<div class="commodity-item">
          <div class="commodity-name">${escapeHtml(cfg.flag)} XAU/${escapeHtml(cfg.label)}</div>
          <div class="commodity-price" style="font-size:calc(11px * var(--wm-panel-effective-scale, 1))">--</div>
        </div>`
      ).join('');
      return `<div class="commodities-grid">${placeholders}</div><div style="margin-top:6px;font-size:calc(9px * var(--wm-panel-effective-scale, 1));color:var(--text-dim)">FX rates unavailable</div>`;
    }
    return `<div class="commodities-grid">${rows.join('')}</div><div style="margin-top:6px;font-size:calc(9px * var(--wm-panel-effective-scale, 1));color:var(--text-dim)">Computed from GC=F + Yahoo FX</div>`;
  }

  private _render(): void {
    const hasPhysical = this._physicalPremiums.length > 0;
    const hasFx = this._fxRates.length > 0;
    const hasXau = SITE_VARIANT === 'commodity' && this._commodityData.some(d => d.symbol === 'GC=F' && d.price !== null);
    if (this._tab === 'xau' && !hasXau) this._tab = 'commodities';
    if (this._tab === 'physical' && !hasPhysical) this._tab = 'commodities';
    const tabBar = this._buildTabBar(hasPhysical, hasFx, hasXau);

    if (this._tab === 'physical' && hasPhysical) {
      this.setSafeContent(unsafeRawHtml(tabBar + this._renderPhysicalPremiums(), 'legacy Panel.setContent() migration'));
      return;
    }

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
      this.setSafeContent(unsafeRawHtml(tabBar + `<div class="commodities-grid">${items}</div><div style="margin-top:6px;font-size:calc(9px * var(--wm-panel-effective-scale, 1));color:var(--text-dim)">Source: ECB</div>`, 'legacy Panel.setContent() migration'));
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
      if (!hasFx && !hasPhysical) {
        this.showRetrying(t('common.failedCommodities'));
        return;
      }
      this.setSafeContent(unsafeRawHtml(tabBar + `<div style="padding:8px;color:var(--text-dim);font-size:calc(12px * var(--wm-panel-effective-scale, 1))">${t('common.failedCommodities')}</div>`, 'legacy Panel.setContent() migration'));
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
