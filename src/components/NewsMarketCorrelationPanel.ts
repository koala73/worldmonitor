import { Panel } from './Panel';
import { fetchTopicTimeline, INTEL_TOPICS } from '@/services/gdelt-intel';
import { ensureHydrated } from '@/services/bootstrap';
import {
  analyzeNewsMarketCorrelation,
  isMarketCorrelationPayload,
  parseSeriesTimestamp,
  type MarketCorrelationPayload,
  type MarketCorrelationSeries,
  type NewsMarketCorrelationResult,
  type TimeSeriesPoint,
} from '@/services/news-market-correlation';
import { escapeHtml, unsafeRawHtml } from '@/utils/sanitize';

const MARKET_OPTIONS = [
  { symbol: '^GSPC', label: 'S&P 500' },
  { symbol: '^IXIC', label: 'Nasdaq Composite' },
  { symbol: 'BTC-USD', label: 'Bitcoin' },
  { symbol: 'ETH-USD', label: 'Ethereum' },
  { symbol: 'GC=F', label: 'Gold' },
  { symbol: 'CL=F', label: 'WTI Crude' },
] as const;

const WINDOW_OPTIONS = [
  { hours: 24, label: '24 hours' },
  { hours: 72, label: '3 days' },
  { hours: 168, label: '7 days' },
  { hours: 336, label: '14 days' },
] as const;

const SVG_WIDTH = 560;
const SVG_HEIGHT = 210;
const MARGIN_LEFT = 42;
const MARGIN_RIGHT = 54;
const MARGIN_TOP = 12;
const MARGIN_BOTTOM = 28;
const CHART_WIDTH = SVG_WIDTH - MARGIN_LEFT - MARGIN_RIGHT;
const CHART_HEIGHT = SVG_HEIGHT - MARGIN_TOP - MARGIN_BOTTOM;

function finitePoints(points: TimeSeriesPoint[], cutoffMs: number): Array<{ timestampMs: number; value: number }> {
  return points
    .map((point) => ({ timestampMs: parseSeriesTimestamp(point.timestamp), value: point.value }))
    .filter((point) => Number.isFinite(point.timestampMs) && point.timestampMs >= cutoffMs && Number.isFinite(point.value))
    .sort((left, right) => left.timestampMs - right.timestampMs);
}

function extent(values: number[]): { min: number; max: number } {
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (min === max) {
    const pad = Math.abs(min) * 0.05 || 1;
    return { min: min - pad, max: max + pad };
  }
  const pad = (max - min) * 0.06;
  return { min: min - pad, max: max + pad };
}

function formatAxisValue(value: number): string {
  if (Math.abs(value) >= 1000) return value.toLocaleString(undefined, { maximumFractionDigits: 0 });
  if (Math.abs(value) >= 100) return value.toFixed(0);
  if (Math.abs(value) >= 10) return value.toFixed(1);
  return value.toFixed(2);
}

function polylineRuns(
  points: Array<{ timestampMs: number; value: number }>,
  x: (timestampMs: number) => number,
  y: (value: number) => number,
  maximumGapMs: number,
): string[] {
  const runs: string[] = [];
  let current: string[] = [];
  let previousTimestamp = Number.NEGATIVE_INFINITY;
  for (const point of points) {
    if (point.timestampMs - previousTimestamp > maximumGapMs && current.length > 0) {
      runs.push(current.join(' '));
      current = [];
    }
    current.push(`${x(point.timestampMs).toFixed(1)},${y(point.value).toFixed(1)}`);
    previousTimestamp = point.timestampMs;
  }
  if (current.length > 0) runs.push(current.join(' '));
  return runs;
}

export function buildNewsMarketChart(
  newsPoints: TimeSeriesPoint[],
  marketPoints: TimeSeriesPoint[],
  windowHours: number,
): string {
  const latest = Math.max(
    ...newsPoints.map((point) => parseSeriesTimestamp(point.timestamp)).filter(Number.isFinite),
    ...marketPoints.map((point) => parseSeriesTimestamp(point.timestamp)).filter(Number.isFinite),
  );
  if (!Number.isFinite(latest)) return '<div class="news-market-correlation__empty">No timestamped series available.</div>';
  const cutoff = latest - windowHours * 60 * 60 * 1000;
  const news = finitePoints(newsPoints, cutoff);
  const market = finitePoints(marketPoints, cutoff);
  if (news.length < 2 || market.length < 2) {
    return '<div class="news-market-correlation__empty">Not enough overlapping history for this window.</div>';
  }

  const start = Math.max(cutoff, Math.min(news[0]!.timestampMs, market[0]!.timestampMs));
  const end = Math.max(news[news.length - 1]!.timestampMs, market[market.length - 1]!.timestampMs);
  const duration = Math.max(1, end - start);
  const newsExtent = extent(news.map((point) => point.value));
  const marketExtent = extent(market.map((point) => point.value));
  const x = (timestampMs: number) => MARGIN_LEFT + ((timestampMs - start) / duration) * CHART_WIDTH;
  const newsY = (value: number) => MARGIN_TOP + (1 - (value - newsExtent.min) / (newsExtent.max - newsExtent.min)) * CHART_HEIGHT;
  const marketY = (value: number) => MARGIN_TOP + (1 - (value - marketExtent.min) / (marketExtent.max - marketExtent.min)) * CHART_HEIGHT;

  const grid = [0, 0.25, 0.5, 0.75, 1].map((ratio) => {
    const y = MARGIN_TOP + ratio * CHART_HEIGHT;
    const newsValue = newsExtent.max - ratio * (newsExtent.max - newsExtent.min);
    const marketValue = marketExtent.max - ratio * (marketExtent.max - marketExtent.min);
    return `<line x1="${MARGIN_LEFT}" y1="${y.toFixed(1)}" x2="${SVG_WIDTH - MARGIN_RIGHT}" y2="${y.toFixed(1)}" stroke="rgba(255,255,255,0.07)"/><text x="${MARGIN_LEFT - 5}" y="${y.toFixed(1)}" text-anchor="end" dominant-baseline="middle" fill="#f59e0b" font-size="8">${escapeHtml(formatAxisValue(newsValue))}</text><text x="${SVG_WIDTH - MARGIN_RIGHT + 5}" y="${y.toFixed(1)}" text-anchor="start" dominant-baseline="middle" fill="#60a5fa" font-size="8">${escapeHtml(formatAxisValue(marketValue))}</text>`;
  }).join('');
  const xLabels = [0, 0.5, 1].map((ratio) => {
    const timestamp = start + ratio * duration;
    const label = new Date(timestamp).toLocaleString(undefined, {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
    });
    return `<text x="${x(timestamp).toFixed(1)}" y="${SVG_HEIGHT - 7}" text-anchor="${ratio === 0 ? 'start' : ratio === 1 ? 'end' : 'middle'}" fill="rgba(255,255,255,0.45)" font-size="8">${escapeHtml(label)}</text>`;
  }).join('');
  const newsLines = polylineRuns(news, x, newsY, 3 * 60 * 60 * 1000)
    .filter((run) => run.includes(' '))
    .map((run) => `<polyline points="${run}" fill="none" stroke="#f59e0b" stroke-width="1.6" stroke-linejoin="round"/>`)
    .join('');
  const marketLines = polylineRuns(market, x, marketY, 2 * 60 * 60 * 1000)
    .filter((run) => run.includes(' '))
    .map((run) => `<polyline points="${run}" fill="none" stroke="#60a5fa" stroke-width="1.6" stroke-linejoin="round"/>`)
    .join('');

  return `<svg class="news-market-correlation__chart" viewBox="0 0 ${SVG_WIDTH} ${SVG_HEIGHT}" role="img" aria-label="News volume and market price over a shared time axis">${grid}${xLabels}${newsLines}${marketLines}</svg>`;
}

function relationshipLabel(result: NewsMarketCorrelationResult): string {
  const labels: Record<NewsMarketCorrelationResult['relationship'], string> = {
    'insufficient-data': 'Insufficient aligned observations',
    none: 'No clear relationship',
    'weak-positive': 'Weak positive relationship',
    'weak-negative': 'Weak negative relationship',
    'moderate-positive': 'Moderate positive relationship',
    'moderate-negative': 'Moderate negative relationship',
    'strong-positive': 'Strong positive relationship',
    'strong-negative': 'Strong negative relationship',
  };
  return labels[result.relationship];
}

function lagLabel(result: NewsMarketCorrelationResult): string {
  if (result.leadLag.relationship === 'neither') return 'Neither series clearly leads';
  const subject = result.leadLag.relationship === 'news-leads' ? 'News leads' : 'Market leads';
  return `${subject} by ${result.leadLag.hours}h (r=${result.leadLag.coefficient?.toFixed(2) ?? '—'}, n=${result.leadLag.sampleSize})`;
}

export class NewsMarketCorrelationPanel extends Panel {
  private selectedTopic = 'sanctions';
  private selectedSymbol = '^GSPC';
  private windowHours = 168;
  private hasData = false;
  private requestGeneration = 0;
  private renderedSelection: { topic: string; symbol: string; windowHours: number } | null = null;

  constructor() {
    super({
      id: 'news-market-correlation',
      title: 'News ↔ Markets',
      showCount: false,
      className: 'panel-wide',
      defaultRowSpan: 2,
      infoTooltip: 'Exploratory Pearson correlation between persisted GDELT topic volume and hourly market returns. The chart shows news volume and price on separate axes. Correlation and lead/lag do not establish causation.',
    });
  }

  public async fetchData(): Promise<boolean> {
    const generation = ++this.requestGeneration;
    const selectedTopic = this.selectedTopic;
    const selectedSymbol = this.selectedSymbol;
    const windowHours = this.windowHours;
    if (!this.hasData) this.showLoading();
    try {
      const [hydratedMarketPayload, topicTimeline] = await Promise.all([
        ensureHydrated('marketCorrelationSeries'),
        fetchTopicTimeline(selectedTopic),
      ]);
      if (generation !== this.requestGeneration) return false;
      const marketPayload = isMarketCorrelationPayload(hydratedMarketPayload)
        ? hydratedMarketPayload
        : undefined;
      const selectedMarket = marketPayload?.series?.find((item) => item.symbol === selectedSymbol);
      const market = selectedMarket?.points?.length ? selectedMarket : marketPayload?.series?.find((item) => item.points?.length);
      if (!topicTimeline?.vol?.length || !market?.points?.length || !marketPayload) {
        if (this.hasData) this.restoreRenderedSelection();
        else this.showError('Correlation series unavailable', () => void this.fetchData(), 300);
        return false;
      }
      this.selectedSymbol = market.symbol;
      const newsPoints = topicTimeline.vol.map((point) => ({ timestamp: point.date, value: point.value }));
      const analysis = analyzeNewsMarketCorrelation(newsPoints, market.points, {
        windowHours,
        maxLagHours: 6,
      });
      this.hasData = true;
      this.renderedSelection = {
        topic: selectedTopic,
        symbol: market.symbol,
        windowHours,
      };
      this.renderPanel(newsPoints, marketPayload, market, analysis, windowHours);
      return true;
    } catch (error) {
      if (generation !== this.requestGeneration) return false;
      if (this.hasData) {
        this.restoreRenderedSelection();
      } else {
        this.showError(error instanceof Error ? error.message : 'Failed to load correlation series', () => void this.fetchData(), 300);
      }
      return false;
    }
  }

  private restoreRenderedSelection(): void {
    if (!this.renderedSelection) return;
    this.selectedTopic = this.renderedSelection.topic;
    this.selectedSymbol = this.renderedSelection.symbol;
    this.windowHours = this.renderedSelection.windowHours;
    const topic = this.content.querySelector<HTMLSelectElement>('[data-role="news-topic"]');
    const market = this.content.querySelector<HTMLSelectElement>('[data-role="market-symbol"]');
    const window = this.content.querySelector<HTMLSelectElement>('[data-role="window-hours"]');
    if (topic) topic.value = this.selectedTopic;
    if (market) market.value = this.selectedSymbol;
    if (window) window.value = String(this.windowHours);
  }

  private renderPanel(
    newsPoints: TimeSeriesPoint[],
    payload: MarketCorrelationPayload,
    market: MarketCorrelationSeries,
    analysis: NewsMarketCorrelationResult,
    windowHours: number,
  ): void {
    const topicOptions = INTEL_TOPICS.map((topic) => `<option value="${escapeHtml(topic.id)}"${topic.id === this.selectedTopic ? ' selected' : ''}>${escapeHtml(topic.name)}</option>`).join('');
    const availableSymbols = new Set(payload.series.filter((item) => item.points?.length).map((item) => item.symbol));
    const marketOptions = MARKET_OPTIONS.map((item) => `<option value="${escapeHtml(item.symbol)}"${item.symbol === this.selectedSymbol ? ' selected' : ''}${availableSymbols.has(item.symbol) ? '' : ' disabled'}>${escapeHtml(item.label)}</option>`).join('');
    const windowOptions = WINDOW_OPTIONS.map((item) => `<option value="${item.hours}"${item.hours === this.windowHours ? ' selected' : ''}>${escapeHtml(item.label)}</option>`).join('');
    const coefficient = analysis.coefficient === null ? '—' : analysis.coefficient.toFixed(2);
    const interval = analysis.confidenceInterval
      ? `[${analysis.confidenceInterval.low.toFixed(2)}, ${analysis.confidenceInterval.high.toFixed(2)}]`
      : '—';
    const relationshipClass = analysis.relationship === 'none' || analysis.relationship === 'insufficient-data'
      ? 'news-market-correlation__result--neutral'
      : analysis.coefficient !== null && analysis.coefficient < 0
        ? 'news-market-correlation__result--negative'
        : 'news-market-correlation__result--positive';
    const freshness = payload.updatedAt ? new Date(payload.updatedAt).toLocaleString() : 'unknown';

    const html = `<div class="news-market-correlation">
      <div class="news-market-correlation__controls">
        <label>News topic<select data-role="news-topic">${topicOptions}</select></label>
        <label>Market<select data-role="market-symbol">${marketOptions}</select></label>
        <label>Window<select data-role="window-hours">${windowOptions}</select></label>
      </div>
      <div class="news-market-correlation__legend"><span><i class="news-market-correlation__dot news-market-correlation__dot--news"></i>GDELT news volume</span><span><i class="news-market-correlation__dot news-market-correlation__dot--market"></i>${escapeHtml(market.label)} price</span></div>
      ${buildNewsMarketChart(newsPoints, market.points, windowHours)}
      <div class="news-market-correlation__stats">
        <div><span>Pearson r</span><strong>${escapeHtml(coefficient)}</strong><small>n=${analysis.sampleSize} hourly returns</small></div>
        <div><span>95% interval</span><strong>${escapeHtml(interval)}</strong><small>displayed window</small></div>
        <div class="${relationshipClass}"><span>Interpretation</span><strong>${escapeHtml(relationshipLabel(analysis))}</strong><small>${escapeHtml(lagLabel(analysis))}</small></div>
      </div>
      <div class="news-market-correlation__caveat">Pearson r compares topic volume with hourly market returns. The ±6h lead/lag scan is exploratory. Correlation is not causation; weak and null results are retained.</div>
      <div class="news-market-correlation__freshness">Market series updated ${escapeHtml(freshness)}</div>
    </div>`;

    this.setSafeContent(unsafeRawHtml(html, 'news-market-correlation controlled panel markup'), () => this.bindControls());
  }

  private bindControls(): void {
    this.content.querySelector<HTMLSelectElement>('[data-role="news-topic"]')?.addEventListener('change', (event) => {
      this.selectedTopic = (event.currentTarget as HTMLSelectElement).value;
      void this.fetchData();
    });
    this.content.querySelector<HTMLSelectElement>('[data-role="market-symbol"]')?.addEventListener('change', (event) => {
      this.selectedSymbol = (event.currentTarget as HTMLSelectElement).value;
      void this.fetchData();
    });
    this.content.querySelector<HTMLSelectElement>('[data-role="window-hours"]')?.addEventListener('change', (event) => {
      this.windowHours = Number((event.currentTarget as HTMLSelectElement).value) || 168;
      void this.fetchData();
    });
  }
}
