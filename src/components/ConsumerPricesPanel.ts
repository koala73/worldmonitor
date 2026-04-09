import { Panel } from './Panel';
import { t } from '@/services/i18n';
import { escapeHtml } from '@/utils/sanitize';
import { sparkline } from '@/utils/sparkline';
import {
  fetchConsumerPriceOverview,
  fetchConsumerPriceCategories,
  fetchConsumerPriceMovers,
  fetchRetailerPriceSpreads,
  fetchConsumerPriceFreshness,
  fetchAllMarketsOverview,
  MARKETS,
  SINGLE_MARKETS,
  DEFAULT_MARKET,
  DEFAULT_BASKET,
  type GetConsumerPriceOverviewResponse,
  type ListConsumerPriceCategoriesResponse,
  type ListConsumerPriceMoversResponse,
  type ListRetailerPriceSpreadsResponse,
  type GetConsumerPriceFreshnessResponse,
  type CategorySnapshot,
  type PriceMover,
  type RetailerSpread,
} from '@/services/consumer-prices';

type TabId = 'overview' | 'categories' | 'movers' | 'spread' | 'health';

const SETTINGS_KEY = 'wm-consumer-prices-v1';
const CHANGE_EVENT = 'wm-consumer-prices-settings-changed';

interface PanelSettings {
  market: string;
  basket: string;
  range: '7d' | '30d' | '90d';
  tab: TabId;
  categoryFilter: string | null;
}

const DEFAULT_SETTINGS: PanelSettings = {
  market: DEFAULT_MARKET,
  basket: DEFAULT_BASKET,
  range: '30d',
  tab: 'overview',
  categoryFilter: null,
};

function loadSettings(): PanelSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {}
  return { ...DEFAULT_SETTINGS };
}

function saveSettings(s: PanelSettings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
    window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: s }));
  } catch {}
}

function pctBadge(val: number | null | undefined, invertColor = false): string {
  if (val == null || val === 0) return '<span class="cp-badge cp-badge--neutral">—</span>';
  const cls = invertColor
    ? val > 0 ? 'cp-badge--red' : 'cp-badge--green'
    : val > 0 ? 'cp-badge--green' : 'cp-badge--red';
  const sign = val > 0 ? '+' : '';
  return `<span class="cp-badge ${cls}">${sign}${val.toFixed(1)}%</span>`;
}

function pricePressureBadge(wowPct: number): string {
  if (Math.abs(wowPct) < 0.5) return '<span class="cp-pressure cp-pressure--steady">Stable</span>';
  if (wowPct >= 2) return '<span class="cp-pressure cp-pressure--stress">Rising</span>';
  if (wowPct > 0.5) return '<span class="cp-pressure cp-pressure--watch">Mild Rise</span>';
  return '<span class="cp-pressure cp-pressure--green">Easing</span>';
}

function freshnessLabel(min: number | null): string {
  if (min == null || min === 0) return 'Unknown';
  if (min < 60) return `${min}m ago`;
  if (min < 1440) return `${Math.round(min / 60)}h ago`;
  return `${Math.round(min / 1440)}d ago`;
}

function freshnessClass(min: number | null): string {
  if (min == null) return 'cp-fresh--unknown';
  if (min <= 60) return 'cp-fresh--ok';
  if (min <= 240) return 'cp-fresh--warn';
  return 'cp-fresh--stale';
}

export class ConsumerPricesPanel extends Panel {
  private overview: GetConsumerPriceOverviewResponse | null = null;
  private categories: ListConsumerPriceCategoriesResponse | null = null;
  private movers: ListConsumerPriceMoversResponse | null = null;
  private spread: ListRetailerPriceSpreadsResponse | null = null;
  private freshness: GetConsumerPriceFreshnessResponse | null = null;
  private allMarkets: GetConsumerPriceOverviewResponse[] = [];
  private settings: PanelSettings = loadSettings();
  private loading = false; // tracks in-flight fetch to avoid duplicates

  constructor() {
    super({
      id: 'consumer-prices',
      title: t('panels.consumerPrices'),
      defaultRowSpan: 2,
      infoTooltip: t('components.consumerPrices.infoTooltip'),
    });

    this.content.addEventListener('click', (e) => this.handleClick(e));
  }

  private handleClick(e: Event): void {
    const target = e.target as HTMLElement;

    const marketBtn = target.closest('[data-market]') as HTMLElement | null;
    if (marketBtn?.dataset.market) {
      const code = marketBtn.dataset.market;
      this.settings.market = code;
      this.settings.basket = code === 'all' ? DEFAULT_BASKET : `essentials-${code}`;
      this.settings.tab = 'overview';
      saveSettings(this.settings);
      void this.fetchData();
      return;
    }

    const tab = target.closest('.panel-tab') as HTMLElement | null;
    if (tab?.dataset.tab) {
      this.settings.tab = tab.dataset.tab as TabId;
      saveSettings(this.settings);
      this.render();
      return;
    }

    const catRow = target.closest('[data-category]') as HTMLElement | null;
    if (catRow?.dataset.category) {
      this.settings.categoryFilter = catRow.dataset.category;
      this.settings.tab = 'movers';
      saveSettings(this.settings);
      this.render();
      return;
    }

    const rangeBtn = target.closest('[data-range]') as HTMLElement | null;
    if (rangeBtn?.dataset.range) {
      this.settings.range = rangeBtn.dataset.range as PanelSettings['range'];
      saveSettings(this.settings);
      void this.fetchData();
      return;
    }

    const clearFilter = target.closest('[data-clear-filter]');
    if (clearFilter) {
      this.settings.categoryFilter = null;
      saveSettings(this.settings);
      this.render();
    }
  }

  public async fetchData(): Promise<void> {
    if (this.loading) return;
    this.loading = true;
    this.showLoading();

    const { market, basket, range } = this.settings;

    if (market === 'all') {
      const results = await fetchAllMarketsOverview();
      if (!this.element?.isConnected) { this.loading = false; return; }
      this.allMarkets = results;
      this.loading = false;
      this.render();
      return;
    }

    const [overview, categories, movers, spread, freshness] = await Promise.all([
      fetchConsumerPriceOverview(market, basket),
      fetchConsumerPriceCategories(market, basket, range),
      fetchConsumerPriceMovers(market, range),
      fetchRetailerPriceSpreads(market, basket),
      fetchConsumerPriceFreshness(market),
    ]);

    if (!this.element?.isConnected) { this.loading = false; return; }

    this.overview = overview;
    this.categories = categories;
    this.movers = movers;
    this.spread = spread;
    this.freshness = freshness;
    this.loading = false;
    this.render();
  }

  private render(): void {
    const { tab, range, categoryFilter, market } = this.settings;

    const tabs: Array<{ id: TabId; label: string }> = [
      { id: 'overview', label: t('components.consumerPrices.tabs.overview') },
      { id: 'categories', label: t('components.consumerPrices.tabs.categories') },
      { id: 'movers', label: t('components.consumerPrices.tabs.movers') },
      { id: 'spread', label: t('components.consumerPrices.tabs.spread') },
      { id: 'health', label: t('components.consumerPrices.tabs.health') },
    ];

    const tabsHtml = `
      <div class="panel-tabs">
        ${tabs.map((t_) => `
          <button class="panel-tab${tab === t_.id ? ' active' : ''}" data-tab="${t_.id}">
            ${escapeHtml(t_.label)}
          </button>
        `).join('')}
      </div>
    `;

    const marketBarHtml = `
      <div class="cp-market-bar">
        ${MARKETS.map((m) => `
          <button class="cp-market-btn${market === m.code ? ' active' : ''}" data-market="${m.code}">${m.label}</button>
        `).join('')}
      </div>
    `;

    const rangeHtml = `
      <div class="cp-range-bar">
        ${(['7d', '30d', '90d'] as const).map((r) => `
          <button class="cp-range-btn${range === r ? ' active' : ''}" data-range="${r}">${r}</button>
        `).join('')}
      </div>
    `;

    // All-markets global view — skip per-market tabs
    if (market === 'all') {
      this.setContent(`
        <div class="consumer-prices-panel">
          ${marketBarHtml}
          <div class="cp-body">${this.renderGlobalOverview()}</div>
        </div>
      `);
      return;
    }

    const noData = this.overview?.upstreamUnavailable;

    // When seed hasn't run yet, show a single full-panel placeholder instead
    // of the ugly "No price data available yet" text inside each tab body
    if (noData) {
      this.setContent(`
        <div class="consumer-prices-panel">
          ${marketBarHtml}
          ${tabsHtml}
          <div class="cp-body cp-seeding-state">
            <div class="cp-seeding-icon">📊</div>
            <div class="cp-seeding-title">Data collection in progress</div>
            <div class="cp-seeding-sub">Retail prices are being aggregated — check back in a few hours.</div>
          </div>
        </div>
      `);
      return;
    }

    let bodyHtml = '';
    switch (tab) {
      case 'overview':
        bodyHtml = this.renderOverview();
        break;
      case 'categories':
        bodyHtml = rangeHtml + this.renderCategories();
        break;
      case 'movers':
        bodyHtml = rangeHtml + (categoryFilter
          ? `<div class="cp-filter-bar">Filtered: <strong>${escapeHtml(categoryFilter)}</strong> <button data-clear-filter>✕</button></div>`
          : '') + this.renderMovers();
        break;
      case 'spread':
        bodyHtml = this.renderSpread();
        break;
      case 'health':
        bodyHtml = this.renderHealth();
        break;
    }

    this.setContent(`
      <div class="consumer-prices-panel">
        ${marketBarHtml}
        ${tabsHtml}
        <div class="cp-body">${bodyHtml}</div>
      </div>
    `);
  }

  private renderGlobalOverview(): string {
    if (this.allMarkets.length === 0) {
      return `<div class="cp-empty-state">Loading global data…</div>`;
    }
    const rows = SINGLE_MARKETS.map((m) => {
      const d = this.allMarkets.find((r) => r.marketCode === m.code);
      const hasData = d && d.asOf && d.asOf !== '0' && !d.upstreamUnavailable;
      if (!hasData) {
        return `
          <tr class="cp-global-row" data-market="${m.code}">
            <td class="cp-global-flag">${m.label}</td>
            <td colspan="4" class="cp-global-pending">Pending data</td>
          </tr>`;
      }
      const wowBadge = pctBadge(d.wowPct, true);
      const freshCls = freshnessClass(d.freshnessLagMin > 0 ? d.freshnessLagMin : null);
      return `
        <tr class="cp-global-row" data-market="${m.code}">
          <td class="cp-global-flag">${m.label}</td>
          <td class="cp-global-index">${d.essentialsIndex > 0 ? d.essentialsIndex.toFixed(1) : '—'}</td>
          <td class="cp-global-wow">${wowBadge}</td>
          <td class="cp-global-spread">${d.retailerSpreadPct > 0 ? `${d.retailerSpreadPct.toFixed(1)}%` : '—'}</td>
          <td class="cp-global-fresh ${freshCls}">${d.freshnessLagMin > 0 ? freshnessLabel(d.freshnessLagMin) : '—'}</td>
        </tr>`;
    }).join('');
    return `
      <table class="cp-global-table">
        <thead>
          <tr>
            <th>Market</th><th>Index</th><th>WoW</th><th>Spread</th><th>Updated</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
      <div class="cp-global-hint">Tap a market row to drill in</div>
    `;
  }

  private renderOverview(): string {
    const d = this.overview;
    if (!d || !d.asOf || d.asOf === '0') return this.renderEmptyState('No price data available yet');

    return `
      <div class="cp-overview-grid">
        <div class="cp-stat-card">
          <div class="cp-stat-label">Essentials Basket</div>
          <div class="cp-stat-value">${d.essentialsIndex > 0 ? d.essentialsIndex.toFixed(1) : '—'}</div>
          <div class="cp-stat-sub">Index (base 100)</div>
        </div>
        <div class="cp-stat-card">
          <div class="cp-stat-label">Value Basket</div>
          <div class="cp-stat-value">${d.valueBasketIndex > 0 ? d.valueBasketIndex.toFixed(1) : '—'}</div>
          <div class="cp-stat-sub">Index (base 100)</div>
        </div>
        <div class="cp-stat-card">
          <div class="cp-stat-label">Week-over-Week</div>
          <div class="cp-stat-value">${pctBadge(d.wowPct, true)}</div>
          <div class="cp-stat-sub">${pricePressureBadge(d.wowPct)}</div>
        </div>
        <div class="cp-stat-card">
          <div class="cp-stat-label">Month-over-Month</div>
          <div class="cp-stat-value">${pctBadge(d.momPct, true)}</div>
        </div>
        <div class="cp-stat-card">
          <div class="cp-stat-label">Retailer Spread</div>
          <div class="cp-stat-value">${d.retailerSpreadPct > 0 ? `${d.retailerSpreadPct.toFixed(1)}%` : '—'}</div>
          <div class="cp-stat-sub">Cheapest vs most exp.</div>
        </div>
        <div class="cp-stat-card">
          <div class="cp-stat-label">Coverage</div>
          <div class="cp-stat-value">${d.coveragePct > 0 ? `${d.coveragePct.toFixed(0)}%` : '—'}</div>
          <div class="cp-stat-sub ${freshnessClass(d.freshnessLagMin)}">
            ${freshnessLabel(d.freshnessLagMin)}
          </div>
        </div>
      </div>
      ${d.topCategories?.length ? `
        <div class="cp-section-label">Top Category Movers</div>
        <div class="cp-category-mini">
          ${d.topCategories.slice(0, 5).map((c) => this.renderCategoryMini(c)).join('')}
        </div>
      ` : ''}
    `;
  }

  private renderCategoryMini(c: CategorySnapshot): string {
    const spark = c.sparkline?.length ? sparkline(c.sparkline, 'var(--accent)', 40, 16) : '';
    return `
      <div class="cp-cat-mini-row" data-category="${escapeHtml(c.slug)}">
        <span class="cp-cat-name">${escapeHtml(c.name)}</span>
        <span class="cp-cat-spark">${spark}</span>
        ${pctBadge(c.momPct, true)}
      </div>
    `;
  }

  private renderCategories(): string {
    const cats = this.categories?.categories;
    if (!cats?.length) return this.renderEmptyState('No category data yet');

    return `
      <table class="cp-table">
        <thead>
          <tr>
            <th>Category</th>
            <th>WoW</th>
            <th>MoM</th>
            <th>Trend</th>
            <th>Coverage</th>
          </tr>
        </thead>
        <tbody>
          ${cats.map((c) => `
            <tr class="cp-cat-row" data-category="${escapeHtml(c.slug)}">
              <td><strong>${escapeHtml(c.name)}</strong></td>
              <td>${pctBadge(c.wowPct, true)}</td>
              <td>${pctBadge(c.momPct, true)}</td>
              <td>${c.sparkline?.length ? sparkline(c.sparkline, 'var(--accent)', 48, 18) : '—'}</td>
              <td>${c.coveragePct > 0 ? `${c.coveragePct.toFixed(0)}%` : '—'}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
  }

  private renderMovers(): string {
    const d = this.movers;
    if (!d) return this.renderEmptyState('No price movement data yet');

    const { categoryFilter } = this.settings;
    const filterFn = (m: PriceMover) => !categoryFilter || m.category === categoryFilter;

    const risers = (d.risers ?? []).filter(filterFn).slice(0, 8);
    const fallers = (d.fallers ?? []).filter(filterFn).slice(0, 8);

    if (!risers.length && !fallers.length) return this.renderEmptyState('No movers for this selection');

    return `
      <div class="cp-movers-grid">
        <div class="cp-movers-col">
          <div class="cp-col-header cp-col-header--up">Rising</div>
          ${risers.map((m) => this.renderMoverRow(m, 'up')).join('') || '<div class="cp-empty-col">None</div>'}
        </div>
        <div class="cp-movers-col">
          <div class="cp-col-header cp-col-header--down">Falling</div>
          ${fallers.map((m) => this.renderMoverRow(m, 'down')).join('') || '<div class="cp-empty-col">None</div>'}
        </div>
      </div>
    `;
  }

  private renderMoverRow(m: PriceMover, dir: 'up' | 'down'): string {
    const sign = m.changePct > 0 ? '+' : '';
    return `
      <div class="cp-mover-row cp-mover-row--${dir}">
        <div class="cp-mover-title">${escapeHtml(m.title)}</div>
        <div class="cp-mover-meta">
          <span class="cp-mover-cat">${escapeHtml(m.category)}</span>
          <span class="cp-mover-retailer">${escapeHtml(m.retailerSlug)}</span>
        </div>
        <div class="cp-mover-pct">${sign}${m.changePct.toFixed(1)}%</div>
      </div>
    `;
  }

  private renderSpread(): string {
    const d = this.spread;
    if (!d?.retailers?.length) return this.renderEmptyState('Retailer comparison starts once data is collected');

    return `
      <div class="cp-spread-header">
        <span>Spread: <strong>${d.spreadPct.toFixed(1)}%</strong></span>
        <span class="cp-spread-basket">${escapeHtml(d.basketSlug)} · ${escapeHtml(d.currencyCode)}</span>
      </div>
      <div class="cp-spread-list">
        ${d.retailers.map((r, i) => this.renderSpreadRow(r, i, d.currencyCode)).join('')}
      </div>
    `;
  }

  private renderSpreadRow(r: RetailerSpread, rank: number, currency: string): string {
    const isChepeast = rank === 0;
    return `
      <div class="cp-spread-row ${isChepeast ? 'cp-spread-row--cheapest' : ''}">
        <div class="cp-spread-rank">#${rank + 1}</div>
        <div class="cp-spread-name">${escapeHtml(r.name)}</div>
        <div class="cp-spread-total">${currency} ${r.basketTotal.toFixed(2)}</div>
        <div class="cp-spread-delta">${isChepeast ? '<span class="cp-badge cp-badge--green">Cheapest</span>' : pctBadge(r.deltaVsCheapestPct, true)}</div>
        <div class="cp-spread-items">${r.itemCount} items</div>
        <div class="cp-spread-fresh ${freshnessClass(r.freshnessMin)}">${freshnessLabel(r.freshnessMin)}</div>
      </div>
    `;
  }

  private renderHealth(): string {
    const d = this.freshness;
    if (!d?.retailers?.length) return this.renderEmptyState('Health data not yet available');

    return `
      <div class="cp-health-summary">
        <span>Overall freshness: <strong class="${freshnessClass(d.overallFreshnessMin)}">${freshnessLabel(d.overallFreshnessMin)}</strong></span>
        ${d.stalledCount > 0 ? `<span class="cp-stalled-badge">${d.stalledCount} stalled</span>` : ''}
      </div>
      <div class="cp-health-list">
        ${d.retailers.map((r) => `
          <div class="cp-health-row">
            <span class="cp-health-name">${escapeHtml(r.name)}</span>
            <span class="cp-health-status cp-health-status--${r.status}">${r.status}</span>
            <span class="cp-health-rate">${r.parseSuccessRate > 0 ? `${r.parseSuccessRate.toFixed(0)}% parse` : '—'}</span>
            <span class="cp-health-fresh ${freshnessClass(r.freshnessMin)}">${freshnessLabel(r.freshnessMin)}</span>
          </div>
        `).join('')}
      </div>
    `;
  }

  private renderEmptyState(msg: string): string {
    return `<div class="cp-empty-state">${escapeHtml(msg)}</div>`;
  }
}
