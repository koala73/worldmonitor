/**
 * ProgressChartsPanel -- displays 4 D3.js area charts showing humanity
 * getting better over decades: life expectancy rising, literacy increasing,
 * child mortality plummeting, extreme poverty declining.
 *
 * Extends Panel base class. Charts use warm happy-theme colors with
 * filled areas, smooth monotone curves, and hover tooltips.
 */

import { Panel } from './Panel';
import * as d3 from 'd3';
import { type ProgressDataSet, type ProgressDataPoint } from '@/services/progress-data';
import { getCSSColor } from '@/utils';
import { replaceChildren } from '@/utils/dom-utils';
import { escapeHtml } from '@/utils/sanitize';
import { t } from '@/services/i18n';

const CHART_MARGIN = { top: 8, right: 12, bottom: 24, left: 40 };
const CHART_HEIGHT = 90;
const RESIZE_DEBOUNCE_MS = 200;

export class ProgressChartsPanel extends Panel {
  private datasets: ProgressDataSet[] = [];
  private resizeObserver: ResizeObserver | null = null;
  private resizeDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private tooltip: HTMLDivElement | null = null;

  constructor() {
    super({ id: 'progress', title: 'Human Progress', trackActivity: false });
    this.setupResizeObserver();
  }

  /**
   * Set chart data and render all 4 area charts.
   */
  public setData(datasets: ProgressDataSet[]): void {
    this.datasets = datasets;

    // Clear existing content
    replaceChildren(this.content);

    // Filter out empty datasets
    const valid = datasets.filter(ds => ds.data.length > 0);
    if (valid.length === 0) {
      this.content.innerHTML = `<div class="progress-charts-empty" style="padding:16px;color:var(--text-dim);text-align:center;">${escapeHtml(t('components.progressCharts.noData'))}</div>`;
      return;
    }

    // Create tooltip once (shared by all charts)
    this.createTooltip();

    // Render each chart
    for (const dataset of valid) {
      this.renderChart(dataset);
    }
  }

  /**
   * Create a shared tooltip div for hover interactions.
   */
  private createTooltip(): void {
    if (this.tooltip) {
      this.tooltip.remove();
    }
    this.tooltip = document.createElement('div');
    this.tooltip.className = 'progress-chart-tooltip';
    Object.assign(this.tooltip.style, {
      position: 'absolute',
      pointerEvents: 'none',
      background: getCSSColor('--bg'),
      border: `1px solid ${getCSSColor('--border')}`,
      borderRadius: '6px',
      padding: '4px 8px',
      fontSize: '11px',
      color: getCSSColor('--text'),
      zIndex: '9999',
      display: 'none',
      whiteSpace: 'nowrap',
      boxShadow: `0 2px 6px ${getCSSColor('--shadow-color')}`,
    });
    this.content.style.position = 'relative';
    this.content.appendChild(this.tooltip);
  }

  /**
   * Render a single area chart for a ProgressDataSet.
   */
  private renderChart(dataset: ProgressDataSet): void {
    const { indicator, data, changePercent } = dataset;
    const oldest = data[0]!;

    // Container div
    const container = document.createElement('div');
    container.className = 'progress-chart-container';
    container.style.marginBottom = '12px';

    // Header row: label, change badge, unit
    const header = document.createElement('div');
    header.className = 'progress-chart-header';
    Object.assign(header.style, {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: '0 4px 4px 4px',
    });

    const labelSpan = document.createElement('span');
    labelSpan.className = 'progress-chart-label';
    Object.assign(labelSpan.style, {
      fontWeight: '600',
      fontSize: '12px',
      color: indicator.color,
    });
    labelSpan.textContent = indicator.label;

    const meta = document.createElement('span');
    meta.className = 'progress-chart-meta';
    Object.assign(meta.style, {
      fontSize: '11px',
      color: 'var(--text-dim)',
    });

    // Build change badge text
    const sign = changePercent >= 0 ? '+' : '';
    const changeText = `${sign}${changePercent.toFixed(1)}% since ${oldest.year}`;
    const unitText = indicator.unit ? ` (${indicator.unit})` : '';
    meta.textContent = changeText + unitText;

    header.appendChild(labelSpan);
    header.appendChild(meta);
    container.appendChild(header);

    // SVG chart area
    const chartDiv = document.createElement('div');
    chartDiv.className = 'progress-chart-svg-container';
    container.appendChild(chartDiv);

    // Insert before tooltip (tooltip should stay last)
    if (this.tooltip && this.tooltip.parentElement === this.content) {
      this.content.insertBefore(container, this.tooltip);
    } else {
      this.content.appendChild(container);
    }

    // Render the D3 chart
    this.renderD3Chart(chartDiv, data, indicator.color);
  }

  /**
   * Render D3 area chart inside a container div.
   */
  private renderD3Chart(
    container: HTMLElement,
    data: ProgressDataPoint[],
    color: string,
  ): void {
    const containerWidth = this.content.clientWidth - 16; // 8px padding each side
    if (containerWidth <= 0) return;

    const width = containerWidth - CHART_MARGIN.left - CHART_MARGIN.right;
    const height = CHART_HEIGHT;

    const svg = d3.select(container)
      .append('svg')
      .attr('width', containerWidth)
      .attr('height', height + CHART_MARGIN.top + CHART_MARGIN.bottom)
      .style('display', 'block');

    const g = svg.append('g')
      .attr('transform', `translate(${CHART_MARGIN.left},${CHART_MARGIN.top})`);

    // Scales
    const xExtent = d3.extent(data, d => d.year) as [number, number];
    const yExtent = d3.extent(data, d => d.value) as [number, number];
    const yPadding = (yExtent[1] - yExtent[0]) * 0.1;

    const x = d3.scaleLinear()
      .domain(xExtent)
      .range([0, width]);

    const y = d3.scaleLinear()
      .domain([yExtent[0] - yPadding, yExtent[1] + yPadding])
      .range([height, 0]);

    // Area generator with smooth curve
    const area = d3.area<ProgressDataPoint>()
      .x(d => x(d.year))
      .y0(height)
      .y1(d => y(d.value))
      .curve(d3.curveMonotoneX);

    // Line generator for top edge
    const line = d3.line<ProgressDataPoint>()
      .x(d => x(d.year))
      .y(d => y(d.value))
      .curve(d3.curveMonotoneX);

    // Filled area
    g.append('path')
      .datum(data)
      .attr('d', area)
      .attr('fill', color)
      .attr('opacity', 0.2);

    // Stroke line
    g.append('path')
      .datum(data)
      .attr('d', line)
      .attr('fill', 'none')
      .attr('stroke', color)
      .attr('stroke-width', 2);

    // X axis
    const xAxis = d3.axisBottom(x)
      .ticks(Math.min(5, data.length))
      .tickFormat(d => String(d));

    const xAxisG = g.append('g')
      .attr('transform', `translate(0,${height})`)
      .call(xAxis);

    xAxisG.selectAll('text')
      .attr('fill', 'var(--text-dim)')
      .attr('font-size', '9px');
    xAxisG.selectAll('line').attr('stroke', 'var(--border-subtle)');
    xAxisG.select('.domain').attr('stroke', 'var(--border-subtle)');

    // Y axis
    const yAxis = d3.axisLeft(y)
      .ticks(3)
      .tickFormat(d => formatAxisValue(d as number));

    const yAxisG = g.append('g')
      .call(yAxis);

    yAxisG.selectAll('text')
      .attr('fill', 'var(--text-dim)')
      .attr('font-size', '9px');
    yAxisG.selectAll('line').attr('stroke', 'var(--border-subtle)');
    yAxisG.select('.domain').attr('stroke', 'var(--border-subtle)');

    // Hover interaction overlay
    this.addHoverInteraction(g, data, x, y, width, height, color, container);
  }

  /**
   * Add mouse hover tooltip interaction to a chart.
   */
  private addHoverInteraction(
    g: d3.Selection<SVGGElement, unknown, null, undefined>,
    data: ProgressDataPoint[],
    x: d3.ScaleLinear<number, number>,
    y: d3.ScaleLinear<number, number>,
    width: number,
    height: number,
    color: string,
    container: HTMLElement,
  ): void {
    const tooltip = this.tooltip;
    if (!tooltip) return;

    const bisector = d3.bisector<ProgressDataPoint, number>(d => d.year).left;

    // Invisible overlay rect for mouse events
    const overlay = g.append('rect')
      .attr('width', width)
      .attr('height', height)
      .attr('fill', 'none')
      .attr('pointer-events', 'all')
      .style('cursor', 'crosshair');

    // Vertical line + dot (hidden by default)
    const focusLine = g.append('line')
      .attr('stroke', color)
      .attr('stroke-width', 1)
      .attr('stroke-dasharray', '3,3')
      .attr('opacity', 0);

    const focusDot = g.append('circle')
      .attr('r', 3.5)
      .attr('fill', color)
      .attr('stroke', '#fff')
      .attr('stroke-width', 1.5)
      .attr('opacity', 0);

    overlay
      .on('mousemove', (event: MouseEvent) => {
        const [mx] = d3.pointer(event, overlay.node()!);
        const yearVal = x.invert(mx);
        const idx = bisector(data, yearVal, 1);
        const d0 = data[idx - 1];
        const d1 = data[idx];
        if (!d0) return;
        const nearest = d1 && (yearVal - d0.year > d1.year - yearVal) ? d1 : d0;

        const cx = x(nearest.year);
        const cy = y(nearest.value);

        focusLine
          .attr('x1', cx).attr('x2', cx)
          .attr('y1', 0).attr('y2', height)
          .attr('opacity', 0.4);

        focusDot
          .attr('cx', cx).attr('cy', cy)
          .attr('opacity', 1);

        tooltip.textContent = `${nearest.year}: ${formatTooltipValue(nearest.value)}`;
        tooltip.style.display = 'block';

        // Position tooltip relative to the content area
        const contentRect = this.content.getBoundingClientRect();
        const containerRect = container.getBoundingClientRect();
        const tooltipX = containerRect.left - contentRect.left + CHART_MARGIN.left + cx + 10;
        const tooltipY = containerRect.top - contentRect.top + CHART_MARGIN.top + cy - 12;
        tooltip.style.left = `${tooltipX}px`;
        tooltip.style.top = `${tooltipY}px`;
      })
      .on('mouseleave', () => {
        focusLine.attr('opacity', 0);
        focusDot.attr('opacity', 0);
        tooltip.style.display = 'none';
      });
  }

  /**
   * Set up a ResizeObserver to re-render charts on panel resize.
   */
  private setupResizeObserver(): void {
    this.resizeObserver = new ResizeObserver(() => {
      if (this.datasets.length === 0) return;
      if (this.resizeDebounceTimer) {
        clearTimeout(this.resizeDebounceTimer);
      }
      this.resizeDebounceTimer = setTimeout(() => {
        this.setData(this.datasets);
      }, RESIZE_DEBOUNCE_MS);
    });
    this.resizeObserver.observe(this.content);
  }

  /**
   * Clean up observers, timers, and DOM elements.
   */
  public destroy(): void {
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }
    if (this.resizeDebounceTimer) {
      clearTimeout(this.resizeDebounceTimer);
      this.resizeDebounceTimer = null;
    }
    if (this.tooltip) {
      this.tooltip.remove();
      this.tooltip = null;
    }
    this.datasets = [];
    super.destroy();
  }
}

// ---- Formatting Helpers ----

function formatAxisValue(value: number): string {
  if (value >= 1000) return `${(value / 1000).toFixed(0)}K`;
  if (value >= 100) return value.toFixed(0);
  if (value >= 10) return value.toFixed(1);
  return value.toFixed(2);
}

function formatTooltipValue(value: number): string {
  if (value >= 1000) return value.toLocaleString('en-US', { maximumFractionDigits: 0 });
  if (value >= 10) return value.toFixed(1);
  return value.toFixed(2);
}
