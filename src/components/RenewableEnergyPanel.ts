/**
 * RenewableEnergyPanel -- displays a D3 arc gauge showing global renewable
 * electricity percentage, a historical trend sparkline, and a regional
 * breakdown with horizontal bars.
 *
 * Extends Panel base class. Uses theme-aware colors via getCSSColor().
 */

import { Panel } from './Panel';
import {
  select,
  arc,
  interpolate,
  easeCubicOut,
  extent,
  scaleLinear,
  area,
  curveMonotoneX,
  line,
  stack,
  stackOrderNone,
  stackOffsetNone,
  max,
  type SeriesPoint,
} from 'd3';
import type { RenewableEnergyData, RegionRenewableData, CapacitySeries } from '@/services/renewable-energy-data';
import { getCSSColor } from '@/utils';
import { replaceChildren } from '@/utils/dom-utils';

export class RenewableEnergyPanel extends Panel {
  constructor() {
    super({ id: 'renewable', title: 'Renewable Energy', trackActivity: false });
  }

  /**
   * Set data and render the full panel: gauge + sparkline + regional breakdown.
   */
  public setData(data: RenewableEnergyData): void {
    replaceChildren(this.content);

    // Empty state
    if (data.globalPercentage === 0 && data.regions.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'renewable-empty';
      Object.assign(empty.style, {
        padding: '24px 16px',
        color: 'var(--text-dim)',
        textAlign: 'center',
        fontSize: '13px',
      });
      empty.textContent = 'No renewable energy data available';
      this.content.appendChild(empty);
      return;
    }

    const container = document.createElement('div');
    container.className = 'renewable-container';
    Object.assign(container.style, {
      padding: '8px',
    });

    // Section 1: Gauge
    const gaugeSection = document.createElement('div');
    gaugeSection.className = 'renewable-gauge-section';
    Object.assign(gaugeSection.style, {
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      marginBottom: '12px',
    });
    this.renderGauge(gaugeSection, data.globalPercentage, data.globalYear);
    container.appendChild(gaugeSection);

    // Historical sparkline (bonus below gauge)
    if (data.historicalData.length > 2) {
      const sparkSection = document.createElement('div');
      sparkSection.className = 'renewable-sparkline-section';
      Object.assign(sparkSection.style, {
        marginBottom: '12px',
      });
      this.renderSparkline(sparkSection, data.historicalData);
      container.appendChild(sparkSection);
    }

    // Section 2: Regional Breakdown
    if (data.regions.length > 0) {
      const regionsSection = document.createElement('div');
      regionsSection.className = 'renewable-regions';
      this.renderRegions(regionsSection, data.regions);
      container.appendChild(regionsSection);
    }

    this.content.appendChild(container);
  }

  /**
   * Render the animated D3 arc gauge showing global renewable electricity %.
   */
  private renderGauge(
    container: HTMLElement,
    percentage: number,
    year: number,
  ): void {
    const size = 140;
    const radius = size / 2;
    const innerRadius = radius * 0.7;
    const outerRadius = radius;

    const svg = select(container)
      .append('svg')
      .attr('viewBox', `0 0 ${size} ${size}`)
      .attr('width', size)
      .attr('height', size)
      .style('display', 'block');

    const g = svg.append('g')
      .attr('transform', `translate(${radius},${radius})`);

    // Arc generator
    const arcGen = arc()
      .innerRadius(innerRadius)
      .outerRadius(outerRadius)
      .cornerRadius(4)
      .startAngle(0);

    // Background arc (full circle) -- theme-aware track color
    g.append('path')
      .datum({ endAngle: Math.PI * 2 })
      .attr('d', arcGen as any)
      .attr('fill', getCSSColor('--border'));

    // Foreground arc (renewable %) -- animated from 0 to target
    const targetAngle = (percentage / 100) * Math.PI * 2;
    const foreground = g.append('path')
      .datum({ endAngle: 0 })
      .attr('d', arcGen as any)
      .attr('fill', getCSSColor('--green'));

    // Animate the arc from 0 to target percentage
    const angleInterpolator = interpolate(0, targetAngle);
    foreground.transition()
      .duration(1500)
      .ease(easeCubicOut)
      .attrTween('d', () => (t: number) => {
        return (arcGen as any)({ endAngle: angleInterpolator(t) });
      });

    // Center text: percentage value
    g.append('text')
      .attr('class', 'gauge-value')
      .attr('text-anchor', 'middle')
      .attr('dominant-baseline', 'central')
      .attr('dy', '-0.15em')
      .attr('fill', getCSSColor('--text'))
      .attr('font-size', '22px')
      .attr('font-weight', '700')
      .text(`${percentage.toFixed(1)}%`);

    // Center text: "Renewable" label
    g.append('text')
      .attr('class', 'gauge-label')
      .attr('text-anchor', 'middle')
      .attr('dominant-baseline', 'central')
      .attr('dy', '1.4em')
      .attr('fill', getCSSColor('--text-dim'))
      .attr('font-size', '10px')
      .text('Renewable');

    // Data year label below gauge
    const yearLabel = document.createElement('div');
    yearLabel.className = 'gauge-year';
    Object.assign(yearLabel.style, {
      textAlign: 'center',
      fontSize: '10px',
      color: 'var(--text-dim)',
      marginTop: '4px',
    });
    yearLabel.textContent = `Data from ${year}`;
    container.appendChild(yearLabel);
  }

  /**
   * Render a small D3 area sparkline showing the global renewable % trend.
   */
  private renderSparkline(
    container: HTMLElement,
    historicalData: Array<{ year: number; value: number }>,
  ): void {
    const containerWidth = this.content.clientWidth - 16 || 200;
    const height = 40;
    const margin = { top: 4, right: 8, bottom: 4, left: 8 };
    const width = containerWidth - margin.left - margin.right;

    if (width <= 0) return;

    const svg = select(container)
      .append('svg')
      .attr('width', containerWidth)
      .attr('height', height + margin.top + margin.bottom)
      .style('display', 'block');

    const g = svg.append('g')
      .attr('transform', `translate(${margin.left},${margin.top})`);

    const xExtent = extent(historicalData, d => d.year) as [number, number];
    const yExtent = extent(historicalData, d => d.value) as [number, number];
    const yPadding = (yExtent[1] - yExtent[0]) * 0.1;

    const x = scaleLinear().domain(xExtent).range([0, width]);
    const y = scaleLinear()
      .domain([yExtent[0] - yPadding, yExtent[1] + yPadding])
      .range([height, 0]);

    const greenColor = getCSSColor('--green');

    // Area fill
    const sparkArea = area<{ year: number; value: number }>()
      .x(d => x(d.year))
      .y0(height)
      .y1(d => y(d.value))
      .curve(curveMonotoneX);

    g.append('path')
      .datum(historicalData)
      .attr('d', sparkArea)
      .attr('fill', greenColor)
      .attr('opacity', 0.15);

    // Line stroke
    const sparkLine = line<{ year: number; value: number }>()
      .x(d => x(d.year))
      .y(d => y(d.value))
      .curve(curveMonotoneX);

    g.append('path')
      .datum(historicalData)
      .attr('d', sparkLine)
      .attr('fill', 'none')
      .attr('stroke', greenColor)
      .attr('stroke-width', 1.5);
  }

  /**
   * Render the regional breakdown with horizontal bar chart.
   */
  private renderRegions(
    container: HTMLElement,
    regions: RegionRenewableData[],
  ): void {
    // Find max percentage for bar scaling
    const maxPct = Math.max(...regions.map(r => r.percentage), 1);

    for (let i = 0; i < regions.length; i++) {
      const region = regions[i]!;
      const row = document.createElement('div');
      row.className = 'region-row';
      Object.assign(row.style, {
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        marginBottom: '6px',
      });

      // Region name
      const nameSpan = document.createElement('span');
      nameSpan.className = 'region-name';
      Object.assign(nameSpan.style, {
        fontSize: '11px',
        color: 'var(--text-dim)',
        minWidth: '120px',
        flexShrink: '0',
      });
      nameSpan.textContent = region.name;

      // Bar container
      const barContainer = document.createElement('div');
      barContainer.className = 'region-bar-container';
      Object.assign(barContainer.style, {
        flex: '1',
        height: '8px',
        background: 'var(--bg-secondary)',
        borderRadius: '4px',
        overflow: 'hidden',
      });

      // Bar fill
      const bar = document.createElement('div');
      bar.className = 'region-bar';
      // Opacity fades from 1.0 (first/highest) to 0.5 (last/lowest)
      const opacity = regions.length > 1
        ? 1.0 - (i / (regions.length - 1)) * 0.5
        : 1.0;
      Object.assign(bar.style, {
        width: `${(region.percentage / maxPct) * 100}%`,
        height: '100%',
        background: getCSSColor('--green'),
        opacity: String(opacity),
        borderRadius: '4px',
        transition: 'width 0.6s ease-out',
      });
      barContainer.appendChild(bar);

      // Value label
      const valueSpan = document.createElement('span');
      valueSpan.className = 'region-value';
      Object.assign(valueSpan.style, {
        fontSize: '11px',
        fontWeight: '600',
        color: 'var(--text)',
        minWidth: '42px',
        textAlign: 'right',
        flexShrink: '0',
      });
      valueSpan.textContent = `${region.percentage.toFixed(1)}%`;

      row.appendChild(nameSpan);
      row.appendChild(barContainer);
      row.appendChild(valueSpan);
      container.appendChild(row);
    }
  }

  /**
   * Set EIA installed capacity data and render a compact D3 stacked area chart
   * (solar + wind growth, coal decline) below the existing gauge/sparkline/regions.
   *
   * Appends to existing content — does NOT call replaceChildren().
   * Idempotent: removes any previous capacity section before re-rendering.
   */
  public setCapacityData(series: CapacitySeries[]): void {
    // Remove any existing capacity section (idempotent re-render)
    this.content.querySelector('.capacity-section')?.remove();

    if (!series || series.length === 0) return;

    const section = document.createElement('div');
    section.className = 'capacity-section';

    // Add a section header
    const header = document.createElement('div');
    header.className = 'capacity-header';
    header.textContent = 'US Installed Capacity (EIA)';
    section.appendChild(header);

    // Build the chart
    this.renderCapacityChart(section, series);
    this.content.appendChild(section);
  }

  /**
   * Render a compact D3 stacked area chart (~110px tall) with:
   * - Stacked area for solar (gold/yellow) + wind (blue) — additive renewable capacity
   * - Declining area + line for coal (red)
   * - Year labels on x-axis (first + last)
   * - Compact inline legend below chart
   */
  private renderCapacityChart(
    container: HTMLElement,
    series: CapacitySeries[],
  ): void {
    // Extract series by source
    const solarSeries = series.find(s => s.source === 'SUN');
    const windSeries = series.find(s => s.source === 'WND');
    const coalSeries = series.find(s => s.source === 'COL');

    // Collect all years across all series
    const allYears = new Set<number>();
    for (const s of series) {
      for (const d of s.data) allYears.add(d.year);
    }
    if (allYears.size === 0) return;

    const sortedYears = [...allYears].sort((a, b) => a - b);

    // Build combined dataset for stacked area: { year, solar, wind }
    const solarMap = new Map(solarSeries?.data.map(d => [d.year, d.capacityMw]) ?? []);
    const windMap = new Map(windSeries?.data.map(d => [d.year, d.capacityMw]) ?? []);
    const coalMap = new Map(coalSeries?.data.map(d => [d.year, d.capacityMw]) ?? []);

    const combinedData = sortedYears.map(year => ({
      year,
      solar: solarMap.get(year) ?? 0,
      wind: windMap.get(year) ?? 0,
      coal: coalMap.get(year) ?? 0,
    }));

    // Chart dimensions
    const containerWidth = this.content.clientWidth - 16 || 200;
    const height = 100;
    const margin = { top: 4, right: 8, bottom: 16, left: 8 };
    const innerWidth = containerWidth - margin.left - margin.right;
    const innerHeight = height - margin.top - margin.bottom;

    if (innerWidth <= 0) return;

    // D3 stack for solar + wind
    const stackGen = stack<{ year: number; solar: number; wind: number }>()
      .keys(['solar', 'wind'])
      .order(stackOrderNone)
      .offset(stackOffsetNone);

    const stacked = stackGen(combinedData);

    // Scales
    const xScale = scaleLinear()
      .domain([sortedYears[0]!, sortedYears[sortedYears.length - 1]!])
      .range([0, innerWidth]);

    const stackedMax = max(stacked, layer => max(layer, d => d[1])) ?? 0;
    const coalMax = max(combinedData, d => d.coal) ?? 0;
    const yMax = Math.max(stackedMax, coalMax) * 1.1; // 10% padding

    const yScale = scaleLinear()
      .domain([0, yMax])
      .range([innerHeight, 0]);

    // Create SVG
    const svg = select(container)
      .append('svg')
      .attr('width', containerWidth)
      .attr('height', height)
      .attr('viewBox', `0 0 ${containerWidth} ${height}`)
      .style('display', 'block');

    const g = svg.append('g')
      .attr('transform', `translate(${margin.left},${margin.top})`);

    // Colors
    const solarColor = getCSSColor('--yellow');
    const windColor = getCSSColor('--semantic-info');
    const coalColor = getCSSColor('--red');

    // Area generator for stacked layers
    const stackArea = area<SeriesPoint<{ year: number; solar: number; wind: number }>>()
      .x(d => xScale(d.data.year))
      .y0(d => yScale(d[0]))
      .y1(d => yScale(d[1]))
      .curve(curveMonotoneX);

    const fillColors = [solarColor, windColor];

    // Render stacked areas (solar bottom, wind on top)
    stacked.forEach((layer, i) => {
      g.append('path')
        .datum(layer)
        .attr('d', stackArea)
        .attr('fill', fillColors[i]!)
        .attr('opacity', 0.6);
    });

    // Render coal as declining area + line
    const coalArea = area<{ year: number; coal: number }>()
      .x(d => xScale(d.year))
      .y0(innerHeight)
      .y1(d => yScale(d.coal))
      .curve(curveMonotoneX);

    g.append('path')
      .datum(combinedData)
      .attr('d', coalArea)
      .attr('fill', coalColor)
      .attr('opacity', 0.2);

    const coalLine = line<{ year: number; coal: number }>()
      .x(d => xScale(d.year))
      .y(d => yScale(d.coal))
      .curve(curveMonotoneX);

    g.append('path')
      .datum(combinedData)
      .attr('d', coalLine)
      .attr('fill', 'none')
      .attr('stroke', coalColor)
      .attr('stroke-width', 1.5)
      .attr('opacity', 0.8);

    // X-axis year labels: first + last
    const firstYear = sortedYears[0]!;
    const lastYear = sortedYears[sortedYears.length - 1]!;

    g.append('text')
      .attr('x', xScale(firstYear))
      .attr('y', innerHeight + 12)
      .attr('text-anchor', 'start')
      .attr('fill', getCSSColor('--text-dim'))
      .attr('font-size', '9px')
      .text(String(firstYear));

    g.append('text')
      .attr('x', xScale(lastYear))
      .attr('y', innerHeight + 12)
      .attr('text-anchor', 'end')
      .attr('fill', getCSSColor('--text-dim'))
      .attr('font-size', '9px')
      .text(String(lastYear));

    // Compact inline legend below chart
    const legend = document.createElement('div');
    legend.className = 'capacity-legend';

    const items: Array<{ color: string; label: string }> = [
      { color: solarColor, label: 'Solar' },
      { color: windColor, label: 'Wind' },
      { color: coalColor, label: 'Coal' },
    ];

    for (const item of items) {
      const el = document.createElement('div');
      el.className = 'capacity-legend-item';

      const dot = document.createElement('span');
      dot.className = 'capacity-legend-dot';
      dot.style.backgroundColor = item.color;

      const label = document.createElement('span');
      label.textContent = item.label;

      el.appendChild(dot);
      el.appendChild(label);
      legend.appendChild(el);
    }

    container.appendChild(legend);
  }

  /**
   * Clean up and call parent destroy.
   */
  public destroy(): void {
    super.destroy();
  }
}
