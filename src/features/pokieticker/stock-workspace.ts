/**
 * Native full-screen stock workspace.
 *
 * This is intentionally an owned WorldMonitor surface: all values come through
 * MarketServiceClient, every provider state is rendered, and an empty provider
 * response remains an empty chart rather than a decorative/sample K-line.
 */

import * as d3 from 'd3';
import { PRIMARY_BRAND } from '@/config/brand';
import {
  MarketServiceClient,
  type DataProvenance,
  type GetStockBarsResponse,
  type GetStockQuoteResponse,
  type ListStockNewsResponse,
  type StockBar,
  type StockNewsItem,
} from '@/generated/client/worldmonitor/market/v1/service_client';
import { providerStatusDisplay } from '@/services/market-data-truth';
import { getRpcBaseUrl, rpcFetch } from '@/services/rpc-client';
import {
  DEFAULT_STOCK_WORKSPACE_SYMBOL,
  normalizeStockWorkspaceSymbol,
  stockWorkspaceSymbolFromPath,
  stockWorkspaceUrl,
} from './stock-workspace-route';
import './stock-workspace.css';

type RangeKey = '1D' | '5D' | '1M' | '3M' | '1Y' | '5Y' | 'MAX';

type SelectedRange = {
  startUtc: number;
  endUtc: number;
};

type WorkspaceData = {
  bars?: GetStockBarsResponse;
  quote?: GetStockQuoteResponse;
  news?: ListStockNewsResponse;
};

type WorkspaceState = {
  symbol: string;
  range: RangeKey;
  activeSymbols: string[];
  searchQuery: string;
  searchResults: Array<{ symbol: string; name: string; exchange: string; currency: string }>;
  selectedNewsId: string | null;
  selectedRange: SelectedRange | null;
  rangeResult: { available: boolean; reason: string } | null;
  loading: boolean;
  searchLoading: boolean;
  error: string | null;
};

const PINNED_LARGE_CAP_SYMBOLS = ['AAPL', 'MSFT', 'NVDA', 'AMZN', 'GOOGL', 'META', 'TSLA', 'BABA'] as const;

const RANGE_OPTIONS: ReadonlyArray<{ key: RangeKey; interval: string; label: string }> = [
  { key: '1D', interval: '1m', label: '1 日' },
  { key: '5D', interval: '5m', label: '5 日' },
  { key: '1M', interval: '30m', label: '1 月' },
  { key: '3M', interval: '1d', label: '3 月' },
  { key: '1Y', interval: '1d', label: '1 年' },
  { key: '5Y', interval: '1w', label: '5 年' },
  { key: 'MAX', interval: '1w', label: '全部' },
];

const client = new MarketServiceClient(getRpcBaseUrl(), { fetch: rpcFetch });

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(label: string, className: string, onClick: () => void, disabled = false): HTMLButtonElement {
  const node = element('button', className, label);
  node.type = 'button';
  node.disabled = disabled;
  node.addEventListener('click', onClick);
  return node;
}

function formatPrice(value: number | undefined, currency = 'USD'): string {
  if (!Number.isFinite(value)) return '—';
  return new Intl.NumberFormat('en-US', {
    style: 'currency', currency: currency || 'USD', maximumFractionDigits: 2,
  }).format(value as number);
}

function formatTimestamp(timestamp: number | undefined): string {
  if (!Number.isFinite(timestamp) || !timestamp || timestamp <= 0) return '未提供时间';
  return new Intl.DateTimeFormat('zh-CN', {
    dateStyle: 'medium', timeStyle: 'short', timeZone: 'America/New_York',
  }).format(new Date(timestamp as number));
}

function validBarsForSymbol(bars: readonly StockBar[] | undefined, symbol: string): StockBar[] {
  const normalized = normalizeStockWorkspaceSymbol(symbol);
  if (!normalized) return [];
  return (bars ?? []).filter((bar) => (
    bar.symbol === normalized
    && Number.isFinite(bar.timestampUtc)
    && Number.isFinite(bar.open)
    && Number.isFinite(bar.high)
    && Number.isFinite(bar.low)
    && Number.isFinite(bar.close)
    && Number.isFinite(bar.volume)
    && bar.low <= bar.open
    && bar.low <= bar.close
    && bar.high >= bar.open
    && bar.high >= bar.close
  ));
}

function closestBar(bars: readonly StockBar[], timestamp: number): StockBar {
  let candidate = bars[0]!;
  let distance = Math.abs(candidate.timestampUtc - timestamp);
  for (const bar of bars.slice(1)) {
    const nextDistance = Math.abs(bar.timestampUtc - timestamp);
    if (nextDistance < distance) {
      candidate = bar;
      distance = nextDistance;
    }
  }
  return candidate;
}

function safeExternalUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

function sourceLabel(provenance: DataProvenance | undefined): string {
  if (!provenance) return '尚未收到数据源状态';
  const display = providerStatusDisplay(provenance.providerStatus);
  const fresh = provenance.freshnessSeconds >= 0
    ? ` · 新鲜度 ${provenance.freshnessSeconds}s`
    : '';
  return `${display.label} · ${provenance.provider || '未声明 Provider'}${fresh}`;
}

function rangeOption(key: RangeKey): { key: RangeKey; interval: string; label: string } {
  return RANGE_OPTIONS.find((option) => option.key === key) ?? RANGE_OPTIONS[0]!;
}

function rangeCaption(range: SelectedRange): string {
  const date = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeZone: 'America/New_York' });
  return `${date.format(new Date(range.startUtc))} — ${date.format(new Date(range.endUtc))}`;
}

async function responseOrError<T>(request: Promise<T>): Promise<T | Error> {
  try {
    return await request;
  } catch (error) {
    return error instanceof Error ? error : new Error('市场服务未返回可读响应。');
  }
}

class StockWorkspace {
  private readonly state: WorkspaceState;
  private data: WorkspaceData = {};
  private loadVersion = 0;
  private searchTimer: number | null = null;
  private resizeObserver: ResizeObserver | null = null;

  constructor(private readonly root: HTMLElement) {
    const symbol = stockWorkspaceSymbolFromPath(window.location.pathname);
    this.state = {
      symbol,
      range: '1M',
      activeSymbols: [...PINNED_LARGE_CAP_SYMBOLS],
      searchQuery: '',
      searchResults: [],
      selectedNewsId: null,
      selectedRange: null,
      rangeResult: null,
      loading: true,
      searchLoading: false,
      error: null,
    };
  }

  mount(): void {
    window.addEventListener('popstate', () => {
      const nextSymbol = stockWorkspaceSymbolFromPath(window.location.pathname);
      if (nextSymbol === this.state.symbol) return;
      this.state.symbol = nextSymbol;
      this.state.selectedNewsId = null;
      this.state.selectedRange = null;
      this.state.rangeResult = null;
      void this.loadSymbol();
    });
    this.render();
    void this.loadSymbol();
  }

  private currentProvenance(): DataProvenance | undefined {
    return this.data.bars?.provenance ?? this.data.quote?.provenance ?? this.data.news?.provenance;
  }

  private async loadSymbol(): Promise<void> {
    const requestVersion = ++this.loadVersion;
    const symbol = this.state.symbol;
    const option = rangeOption(this.state.range);
    this.state.loading = true;
    this.state.error = null;
    this.data = {};
    this.render();

    const [bars, quote, news] = await Promise.all([
      responseOrError(client.getStockBars({ symbol, interval: option.interval, startUtc: 0, endUtc: 0, range: option.key })),
      responseOrError(client.getStockQuote({ symbol })),
      responseOrError(client.listStockNews({ symbol, limit: 50 })),
    ]);

    if (requestVersion !== this.loadVersion) return;
    this.state.loading = false;
    const errors = [bars, quote, news].filter((value): value is Error => value instanceof Error);
    this.data = {
      bars: bars instanceof Error ? undefined : bars,
      quote: quote instanceof Error ? undefined : quote,
      news: news instanceof Error ? undefined : news,
    };
    this.state.error = errors.length > 0
      ? `部分股票请求未返回：${errors.map((error) => error.message).join('；')}`
      : null;
    this.render();
  }

  private async search(): Promise<void> {
    const query = this.state.searchQuery.trim();
    if (!query) {
      this.state.searchResults = [];
      this.state.searchLoading = false;
      this.render();
      return;
    }
    this.state.searchLoading = true;
    this.render();
    try {
      const response = await client.searchStocks({ query, limit: 12 });
      if (query !== this.state.searchQuery.trim()) return;
      this.state.searchResults = response.results
        .filter((item) => normalizeStockWorkspaceSymbol(item.symbol) !== null)
        .map((item) => ({ ...item, symbol: normalizeStockWorkspaceSymbol(item.symbol)! }));
    } catch {
      // A provider outage must leave search visibly empty; do not offer an
      // invented list as if it came from the authorized market provider.
      this.state.searchResults = [];
    } finally {
      if (query === this.state.searchQuery.trim()) {
        this.state.searchLoading = false;
        this.render();
      }
    }
  }

  private setSearchQuery(value: string): void {
    this.state.searchQuery = value;
    if (this.searchTimer !== null) window.clearTimeout(this.searchTimer);
    this.searchTimer = window.setTimeout(() => void this.search(), 260);
  }

  private selectSymbol(rawSymbol: string): void {
    const symbol = normalizeStockWorkspaceSymbol(rawSymbol);
    if (!symbol) return;
    if (!this.state.activeSymbols.includes(symbol)) this.state.activeSymbols.push(symbol);
    this.state.symbol = symbol;
    this.state.searchQuery = '';
    this.state.searchResults = [];
    this.state.selectedNewsId = null;
    this.state.selectedRange = null;
    this.state.rangeResult = null;
    history.pushState({}, '', stockWorkspaceUrl(symbol));
    void this.loadSymbol();
  }

  private setRange(range: RangeKey): void {
    if (this.state.range === range) return;
    this.state.range = range;
    this.state.selectedRange = null;
    this.state.rangeResult = null;
    void this.loadSymbol();
  }

  private async analyzeSelectedRange(range: SelectedRange): Promise<void> {
    const symbol = this.state.symbol;
    this.state.rangeResult = { available: false, reason: '正在请求区间解释；未返回前不会生成分析。' };
    this.render();
    try {
      const response = await client.analyzeStockRange({ symbol, startUtc: range.startUtc, endUtc: range.endUtc });
      if (this.state.symbol !== symbol || this.state.selectedRange !== range) return;
      const analysis = response.analysis;
      this.state.rangeResult = analysis
        ? { available: analysis.available, reason: analysis.reason }
        : { available: false, reason: 'Provider 未返回可解释区间结果。' };
    } catch (error) {
      this.state.rangeResult = {
        available: false,
        reason: error instanceof Error ? error.message : '区间解释请求不可用。',
      };
    }
    this.render();
  }

  private selectRange(range: SelectedRange): void {
    if (range.endUtc <= range.startUtc) return;
    this.state.selectedRange = range;
    this.state.rangeResult = null;
    void this.analyzeSelectedRange(range);
  }

  private render(): void {
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.root.replaceChildren();

    const page = element('main', 'pokie-workspace');
    page.dataset.providerStatus = this.currentProvenance()?.providerStatus ?? 'PROVIDER_STATUS_NOT_CONFIGURED';
    page.setAttribute('aria-label', '股票工作区');

    const header = element('header', 'pokie-workspace__header');
    const brand = element('div', 'pokie-workspace__brand');
    brand.append(element('span', 'pokie-workspace__eyebrow', PRIMARY_BRAND));
    brand.append(element('h1', 'pokie-workspace__title', '全球股票 · 事件时间轴'));
    header.append(brand);
    const headerActions = element('div', 'pokie-workspace__header-actions');
    const sourceLink = element('a', 'pokie-workspace__source-link', '数据真实性说明');
    sourceLink.href = '/docs/integration/PROVIDER_MATRIX.md';
    headerActions.append(sourceLink);
    const mapLink = element('a', 'pokie-workspace__map-link', '返回全球地图');
    mapLink.href = '/';
    headerActions.append(mapLink);
    header.append(headerActions);
    page.append(header);

    page.append(this.renderSelector());
    page.append(this.renderProviderStrip());

    const layout = element('section', 'pokie-workspace__layout');
    const chartColumn = element('section', 'pokie-workspace__chart-column');
    chartColumn.append(this.renderPriceHeader());
    chartColumn.append(this.renderRangeToolbar());
    const chart = element('div', 'pokie-workspace__chart');
    chart.setAttribute('aria-label', `${this.state.symbol} K 线图`);
    chartColumn.append(chart);
    chartColumn.append(this.renderChartCaption());
    layout.append(chartColumn, this.renderResearchRail());
    page.append(layout);

    const footer = element('footer', 'pokie-workspace__footer');
    footer.textContent = 'K 线、报价和新闻仅在服务端返回可验证数据时呈现；新闻关联、情绪和价格因果在 Phase 5 前不会被伪造。非投资建议。';
    page.append(footer);
    this.root.append(page);

    requestAnimationFrame(() => {
      if (!chart.isConnected) return;
      this.drawChart(chart);
      this.resizeObserver = new ResizeObserver(() => this.drawChart(chart));
      this.resizeObserver.observe(chart);
    });
  }

  private renderSelector(): HTMLElement {
    const selector = element('section', 'pokie-workspace__selector');
    const label = element('div', 'pokie-workspace__selector-label');
    label.append(element('strong', undefined, '优先观察：标普 500 高市值公司'));
    label.append(element('span', undefined, '可搜索已获数据源验证的全球股票'));
    selector.append(label);

    const chips = element('div', 'pokie-workspace__ticker-chips');
    for (const symbol of this.state.activeSymbols) {
      const chip = button(symbol, `pokie-workspace__ticker${symbol === this.state.symbol ? ' is-active' : ''}`, () => this.selectSymbol(symbol));
      chip.setAttribute('aria-pressed', String(symbol === this.state.symbol));
      chips.append(chip);
    }
    selector.append(chips);

    const search = element('div', 'pokie-workspace__search');
    const input = element('input', 'pokie-workspace__search-input') as HTMLInputElement;
    input.type = 'search';
    input.placeholder = '搜索证券代码或公司名称';
    input.value = this.state.searchQuery;
    input.setAttribute('aria-label', '搜索股票');
    input.addEventListener('input', () => this.setSearchQuery(input.value));
    input.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      const first = this.state.searchResults[0];
      if (first) this.selectSymbol(first.symbol);
    });
    search.append(input);
    if (this.state.searchLoading) search.append(element('span', 'pokie-workspace__search-state', '正在查询数据源…'));
    if (this.state.searchQuery && !this.state.searchLoading && this.state.searchResults.length === 0) {
      search.append(element('span', 'pokie-workspace__search-state', '没有收到可验证的搜索结果'));
    }
    if (this.state.searchResults.length > 0) {
      const results = element('ul', 'pokie-workspace__search-results');
      for (const result of this.state.searchResults) {
        const item = element('li');
        const pick = button(`${result.symbol} · ${result.name}`, 'pokie-workspace__search-result', () => this.selectSymbol(result.symbol));
        pick.title = [result.exchange, result.currency].filter(Boolean).join(' · ');
        item.append(pick);
        results.append(item);
      }
      search.append(results);
    }
    selector.append(search);
    return selector;
  }

  private renderProviderStrip(): HTMLElement {
    const provenance = this.currentProvenance();
    const display = provenance ? providerStatusDisplay(provenance.providerStatus) : providerStatusDisplay('PROVIDER_STATUS_NOT_CONFIGURED');
    const strip = element('section', `pokie-workspace__provider pokie-workspace__provider--${display.tone}`);
    const primary = element('div', 'pokie-workspace__provider-primary');
    primary.append(element('strong', 'pokie-workspace__provider-status', sourceLabel(provenance)));
    const exactTime = provenance?.observedAt ? `最后观测：${formatTimestamp(provenance.observedAt)}` : '未收到 Provider 观测时间';
    primary.append(element('span', undefined, exactTime));
    strip.append(primary);
    const details = element('div', 'pokie-workspace__provider-details');
    if (provenance?.isFallback) details.append(element('span', undefined, `Fallback：${provenance.fallbackReason || '已标记但未提供原因'}`));
    if (provenance?.licenseNote) details.append(element('span', undefined, provenance.licenseNote));
    const sourceUrl = safeExternalUrl(provenance?.sourceUrl ?? '');
    if (sourceUrl) {
      const link = element('a', 'pokie-workspace__provider-link', 'Provider 方法/来源');
      link.href = sourceUrl;
      link.target = '_blank';
      link.rel = 'noreferrer';
      details.append(link);
    }
    strip.append(details);
    return strip;
  }

  private renderPriceHeader(): HTMLElement {
    const bars = validBarsForSymbol(this.data.bars?.bars, this.state.symbol);
    const quote = this.data.quote?.quote;
    const lastBar = bars.length > 0 ? bars[bars.length - 1] : undefined;
    const price = quote?.price ?? lastBar?.close;
    const currency = quote?.currency ?? lastBar?.currency ?? 'USD';
    const delta = quote?.changePercent;
    const header = element('div', 'pokie-workspace__price-header');
    const identity = element('div');
    identity.append(element('h2', 'pokie-workspace__symbol', this.state.symbol));
    identity.append(element('span', 'pokie-workspace__session', quote?.session?.replace('MARKET_SESSION_', '') || lastBar?.session?.replace('MARKET_SESSION_', '') || '状态待确认'));
    header.append(identity);
    const priceBlock = element('div', 'pokie-workspace__price-block');
    priceBlock.append(element('strong', 'pokie-workspace__price', formatPrice(price, currency)));
    if (Number.isFinite(delta)) {
      priceBlock.append(element('span', `pokie-workspace__change ${(delta as number) >= 0 ? 'is-up' : 'is-down'}`, `${(delta as number) >= 0 ? '+' : ''}${(delta as number).toFixed(2)}%`));
    } else {
      priceBlock.append(element('span', 'pokie-workspace__change is-muted', '无可验证报价'));
    }
    header.append(priceBlock);
    return header;
  }

  private renderRangeToolbar(): HTMLElement {
    const toolbar = element('div', 'pokie-workspace__ranges');
    toolbar.setAttribute('aria-label', 'K 线时间范围');
    for (const option of RANGE_OPTIONS) {
      const control = button(option.label, `pokie-workspace__range${option.key === this.state.range ? ' is-active' : ''}`, () => this.setRange(option.key));
      control.setAttribute('aria-pressed', String(option.key === this.state.range));
      toolbar.append(control);
    }
    return toolbar;
  }

  private renderChartCaption(): HTMLElement {
    const note = element('div', 'pokie-workspace__chart-caption');
    const bars = validBarsForSymbol(this.data.bars?.bars, this.state.symbol);
    if (this.state.loading) {
      note.textContent = `正在向服务端请求 ${this.state.symbol} 的 ${this.state.range} 数据；加载期间不绘制占位 K 线。`;
    } else if (bars.length === 0) {
      note.textContent = '未收到可验证且属于当前证券的 OHLC 序列；图表保持为空。配置密钥不是实时授权证明，授权状态会单独显示。';
    } else {
      note.textContent = `${bars.length} 根经合约校验的 ${this.data.bars?.interval ?? ''} K 线。拖拽图表选择区间；十字光标显示该根真实 OHLC。`;
    }
    return note;
  }

  private railSection(title: string, caption?: string): { section: HTMLElement; body: HTMLElement } {
    const section = element('section', 'pokie-workspace__rail-section');
    section.append(element('h3', 'pokie-workspace__rail-title', title));
    if (caption) section.append(element('p', 'pokie-workspace__rail-caption', caption));
    const body = element('div', 'pokie-workspace__rail-body');
    section.append(body);
    return { section, body };
  }

  private renderResearchRail(): HTMLElement {
    const rail = element('aside', 'pokie-workspace__research-rail');
    rail.setAttribute('aria-label', '股票新闻与研究面板');
    rail.append(this.renderNewsSection());
    rail.append(this.renderCategoriesSection());
    rail.append(this.renderRangeSection());
    rail.append(this.renderSimilarSection());
    rail.append(this.renderPredictionSection());
    rail.append(this.renderStorySection());
    return rail;
  }

  private renderNewsSection(): HTMLElement {
    const { section, body } = this.railSection('新闻与事件粒子', '仅显示 Provider 返回的带来源、链接和发布时间的公司新闻。');
    const news = this.data.news?.items ?? [];
    if (news.length === 0) {
      body.append(element('p', 'pokie-workspace__empty-note', '此标的没有收到可显示的来源新闻。没有新闻时不会制造粒子。'));
      return section;
    }
    const list = element('ol', 'pokie-workspace__news-list');
    for (const item of news) list.append(this.renderNewsItem(item));
    body.append(list);
    return section;
  }

  private renderNewsItem(item: StockNewsItem): HTMLElement {
    const row = element('li', `pokie-workspace__news-item${this.state.selectedNewsId === item.id ? ' is-selected' : ''}`);
    const link = element('a', 'pokie-workspace__news-link', item.title);
    const url = safeExternalUrl(item.sourceUrl);
    if (url) {
      link.href = url;
      link.target = '_blank';
      link.rel = 'noreferrer';
    } else {
      link.removeAttribute('href');
      link.setAttribute('aria-disabled', 'true');
    }
    link.addEventListener('focus', () => {
      this.state.selectedNewsId = item.id;
    });
    row.append(link);
    row.append(element('span', 'pokie-workspace__news-meta', `${item.source} · ${formatTimestamp(item.publishedAtUtc)}`));
    row.append(element('span', 'pokie-workspace__news-analysis-state', '利好/利空分类与实际回报：待 Phase 5 的证据化分析，当前不作因果断言。'));
    return row;
  }

  private renderCategoriesSection(): HTMLElement {
    const { section, body } = this.railSection('新闻分类', '分类筛选外形已保留；没有经过 Phase 5 的分析结果时不会给新闻套上利好/利空标签。');
    const controls = element('div', 'pokie-workspace__category-controls');
    for (const category of ['市场', '政策', '财报', '产品技术', '竞争', '管理']) {
      const control = button(category, 'pokie-workspace__category', () => {}, true);
      control.title = '等待经证据化的新闻分类管线。';
      controls.append(control);
    }
    body.append(controls);
    body.append(element('p', 'pokie-workspace__empty-note', '状态：未分类。新闻相关性、情绪和市场因果不会由界面猜测。'));
    return section;
  }

  private renderRangeSection(): HTMLElement {
    const { section, body } = this.railSection('区间解释', '在图中拖拽选择日期范围后，才会请求后端解释。');
    const range = this.state.selectedRange;
    if (!range) {
      body.append(element('p', 'pokie-workspace__empty-note', '尚未选择区间。'));
      return section;
    }
    body.append(element('strong', 'pokie-workspace__range-caption', rangeCaption(range)));
    const result = this.state.rangeResult;
    body.append(element('p', result?.available ? 'pokie-workspace__analysis-ok' : 'pokie-workspace__empty-note', result?.reason ?? '正在等待区间分析响应。'));
    body.append(button('清除区间', 'pokie-workspace__secondary-button', () => {
      this.state.selectedRange = null;
      this.state.rangeResult = null;
      this.render();
    }));
    return section;
  }

  private renderSimilarSection(): HTMLElement {
    const { section, body } = this.railSection('相似事件 / 相似交易日', '需要真实事件 ID 与历史检索证据。');
    body.append(element('p', 'pokie-workspace__empty-note', '当前没有可验证的事件 ID，因此不返回相似日或相似新闻样例。'));
    return section;
  }

  private renderPredictionSection(): HTMLElement {
    const { section, body } = this.railSection('预测与实际回报', '模型版本、置信度、预测窗口和后续实际回报必须分栏。');
    body.append(element('p', 'pokie-workspace__empty-note', '模型和回测尚未配置。界面不显示 T+1/T+3/T+5 预测、模拟收益或“买卖”结论。'));
    return section;
  }

  private renderStorySection(): HTMLElement {
    const { section, body } = this.railSection('价格与事件故事', '故事只可引用可点击的来源，并应将相关性与因果分开。');
    body.append(element('p', 'pokie-workspace__empty-note', '当前没有经证据链生成的故事。新闻出现于同一时段不等于新闻造成价格变化。'));
    return section;
  }

  private drawChart(target: HTMLElement): void {
    target.replaceChildren();
    const bars = validBarsForSymbol(this.data.bars?.bars, this.state.symbol);
    if (bars.length === 0) {
      const empty = element('div', 'pokie-workspace__chart-empty');
      empty.append(element('strong', undefined, this.state.loading ? '等待服务端数据…' : '没有可验证 K 线'));
      empty.append(element('span', undefined, this.state.error ?? sourceLabel(this.currentProvenance())));
      target.append(empty);
      return;
    }

    const bounds = target.getBoundingClientRect();
    const width = Math.max(320, Math.floor(bounds.width || 960));
    const height = width < 540 ? 400 : 500;
    const margin = { top: 28, right: 68, bottom: 74, left: 74 };
    const volumeHeight = 58;
    const plotWidth = width - margin.left - margin.right;
    const plotHeight = height - margin.top - margin.bottom - volumeHeight;
    const timestamps = bars.map((bar) => bar.timestampUtc);
    const low = d3.min(bars, (bar) => bar.low) ?? 0;
    const high = d3.max(bars, (bar) => bar.high) ?? 1;
    const padding = Math.max((high - low) * 0.08, high * 0.002, 0.01);
    const minTimestamp = d3.min(timestamps) ?? Date.now();
    const maxTimestamp = d3.max(timestamps) ?? minTimestamp + 60_000;
    const timePadding = Math.max((maxTimestamp - minTimestamp) * 0.02, 60_000);
    const x = d3.scaleUtc()
      .domain([new Date(minTimestamp - timePadding), new Date(maxTimestamp + timePadding)])
      .range([margin.left, width - margin.right]);
    const y = d3.scaleLinear().domain([low - padding, high + padding]).nice().range([margin.top + plotHeight, margin.top]);
    const volumeMax = Math.max(d3.max(bars, (bar) => bar.volume) ?? 1, 1);
    const volume = d3.scaleLinear().domain([0, volumeMax]).range([0, volumeHeight - 10]);
    const svg = d3.create('svg')
      .attr('class', 'pokie-workspace__chart-svg')
      .attr('viewBox', `0 0 ${width} ${height}`)
      .attr('role', 'img')
      .attr('aria-label', `${this.state.symbol} 的可验证 OHLC K 线`);

    const grid = svg.append('g').attr('class', 'pokie-workspace__grid');
    grid.call(d3.axisLeft(y).ticks(width < 540 ? 5 : 8).tickSize(-plotWidth).tickFormat(() => ''));
    svg.append('g')
      .attr('class', 'pokie-workspace__axis pokie-workspace__axis--price')
      .attr('transform', `translate(${margin.left},0)`)
      .call(d3.axisLeft(y).ticks(width < 540 ? 5 : 8).tickFormat(d3.format(',.2f')));
    const timeFormatter = d3.utcFormat(width < 540 ? '%m/%d' : '%Y-%m-%d');
    svg.append('g')
      .attr('class', 'pokie-workspace__axis pokie-workspace__axis--time')
      .attr('transform', `translate(0,${margin.top + plotHeight})`)
      .call(d3.axisBottom(x).ticks(width < 540 ? 4 : 8).tickFormat((value) => timeFormatter(new Date(value.valueOf()))));

    const candleWidth = Math.max(2, Math.min(14, (plotWidth / bars.length) * 0.62));
    const candles = svg.append('g').attr('class', 'pokie-workspace__candles');
    candles.selectAll('line')
      .data(bars)
      .join('line')
      .attr('x1', (bar) => x(new Date(bar.timestampUtc)))
      .attr('x2', (bar) => x(new Date(bar.timestampUtc)))
      .attr('y1', (bar) => y(bar.high))
      .attr('y2', (bar) => y(bar.low))
      .attr('class', (bar) => bar.close >= bar.open ? 'is-up' : 'is-down');
    candles.selectAll('rect')
      .data(bars)
      .join('rect')
      .attr('x', (bar) => x(new Date(bar.timestampUtc)) - (candleWidth / 2))
      .attr('y', (bar) => y(Math.max(bar.open, bar.close)))
      .attr('width', candleWidth)
      .attr('height', (bar) => Math.max(1, Math.abs(y(bar.open) - y(bar.close))))
      .attr('class', (bar) => bar.close >= bar.open ? 'is-up' : 'is-down');

    const volumeGroup = svg.append('g').attr('class', 'pokie-workspace__volume');
    volumeGroup.selectAll('rect')
      .data(bars)
      .join('rect')
      .attr('x', (bar) => x(new Date(bar.timestampUtc)) - (candleWidth / 2))
      .attr('y', (bar) => height - margin.bottom - volume(bar.volume))
      .attr('width', candleWidth)
      .attr('height', (bar) => volume(bar.volume))
      .attr('class', (bar) => bar.close >= bar.open ? 'is-up' : 'is-down');
    svg.append('text')
      .attr('class', 'pokie-workspace__volume-label')
      .attr('x', margin.left)
      .attr('y', height - margin.bottom - volumeHeight + 12)
      .text('成交量');

    const news = (this.data.news?.items ?? []).filter((item) => item.publishedAtUtc >= minTimestamp && item.publishedAtUtc <= maxTimestamp);
    const particleLayer = svg.append('g').attr('class', 'pokie-workspace__news-particles');
    particleLayer.selectAll('circle')
      .data(news)
      .join('circle')
      .attr('cx', (item) => x(new Date(item.publishedAtUtc)))
      .attr('cy', margin.top + plotHeight - 8)
      .attr('r', (item) => this.state.selectedNewsId === item.id ? 5 : 3.25)
      .attr('class', (item) => this.state.selectedNewsId === item.id ? 'is-selected' : '')
      .attr('tabindex', 0)
      .attr('role', 'button')
      .attr('aria-label', (item) => `来源新闻：${item.title}`)
      .on('click', (_event, item) => {
        this.state.selectedNewsId = item.id;
        this.render();
      })
      .on('keydown', (event, item) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        this.state.selectedNewsId = item.id;
        this.render();
      });

    const crosshair = svg.append('line').attr('class', 'pokie-workspace__crosshair').attr('visibility', 'hidden');
    const selection = svg.append('rect').attr('class', 'pokie-workspace__selection').attr('visibility', 'hidden');
    const tooltip = element('div', 'pokie-workspace__chart-tooltip');
    tooltip.hidden = true;
    target.append(svg.node()!, tooltip);

    let dragStartX: number | null = null;
    const boundedX = (event: PointerEvent): number => {
      const [rawX] = d3.pointer(event, svg.node());
      return Math.max(margin.left, Math.min(width - margin.right, rawX));
    };
    svg.on('pointermove', (event: PointerEvent) => {
      const pointerX = boundedX(event);
      if (dragStartX !== null) {
        const left = Math.min(dragStartX, pointerX);
        selection.attr('visibility', 'visible').attr('x', left).attr('y', margin.top).attr('width', Math.abs(pointerX - dragStartX)).attr('height', plotHeight);
        return;
      }
      const bar = closestBar(bars, x.invert(pointerX).getTime());
      const barX = x(new Date(bar.timestampUtc));
      crosshair.attr('visibility', 'visible').attr('x1', barX).attr('x2', barX).attr('y1', margin.top).attr('y2', margin.top + plotHeight);
      tooltip.hidden = false;
      tooltip.textContent = `${bar.tradingDate}  O ${formatPrice(bar.open, bar.currency)}  H ${formatPrice(bar.high, bar.currency)}  L ${formatPrice(bar.low, bar.currency)}  C ${formatPrice(bar.close, bar.currency)}  Vol ${new Intl.NumberFormat('en-US', { notation: 'compact' }).format(bar.volume)}`;
      tooltip.style.left = `${Math.max(8, Math.min(width - 330, barX + 10))}px`;
      tooltip.style.top = `${margin.top + 10}px`;
    });
    svg.on('pointerleave', () => {
      if (dragStartX !== null) return;
      crosshair.attr('visibility', 'hidden');
      tooltip.hidden = true;
    });
    svg.on('pointerdown', (event: PointerEvent) => {
      if (event.button !== 0) return;
      dragStartX = boundedX(event);
      (svg.node() as SVGSVGElement).setPointerCapture?.(event.pointerId);
      event.preventDefault();
    });
    svg.on('pointerup', (event: PointerEvent) => {
      if (dragStartX === null) return;
      const endX = boundedX(event);
      const startX = dragStartX;
      dragStartX = null;
      selection.attr('visibility', 'hidden');
      (svg.node() as SVGSVGElement).releasePointerCapture?.(event.pointerId);
      if (Math.abs(endX - startX) < 10) return;
      const startUtc = x.invert(Math.min(startX, endX)).getTime();
      const endUtc = x.invert(Math.max(startX, endX)).getTime();
      this.selectRange({ startUtc, endUtc });
    });
  }
}

export function initStockWorkspace(targetId = 'app'): void {
  const root = document.getElementById(targetId);
  if (!root) throw new Error(`Stock workspace mount target #${targetId} was not found.`);
  root.replaceChildren();
  new StockWorkspace(root).mount();
}

// Keep the default visible to navigation/tests without constructing a mutable
// fixture. It is a watchlist choice, not a quote, candle or company-data claim.
export { DEFAULT_STOCK_WORKSPACE_SYMBOL };
