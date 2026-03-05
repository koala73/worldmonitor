import {
  select,
  scaleTime,
  scaleBand,
  axisBottom,
  timeFormat,
  type Selection,
  type ScaleTime,
  type ScaleBand,
  type NumberValue,
} from 'd3';
import { escapeHtml } from '@/utils/sanitize';
import { getCSSColor } from '@/utils';
import { t } from '@/services/i18n';

export interface TimelineEvent {
  timestamp: number;
  lane: 'protest' | 'conflict' | 'natural' | 'military';
  label: string;
  severity?: 'low' | 'medium' | 'high' | 'critical';
}

const LANES: TimelineEvent['lane'][] = ['protest', 'conflict', 'natural', 'military'];

const LANE_COLORS: Record<TimelineEvent['lane'], string> = {
  protest: '#ffaa00',
  conflict: '#ff4444',
  natural: '#b478ff',
  military: '#64b4ff',
};

const SEVERITY_RADIUS: Record<string, number> = {
  low: 4,
  medium: 5,
  high: 7,
  critical: 9,
};

const MARGIN = { top: 20, right: 20, bottom: 30, left: 80 };
const HEIGHT = 200;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

export class CountryTimeline {
  private container: HTMLElement;
  private svg: Selection<SVGSVGElement, unknown, null, undefined> | null = null;
  private tooltip: HTMLDivElement | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private currentEvents: TimelineEvent[] = [];
  private handleThemeChange: () => void;

  constructor(container: HTMLElement) {
    this.container = container;
    this.createTooltip();
    this.resizeObserver = new ResizeObserver(() => {
      if (this.currentEvents.length > 0) this.render(this.currentEvents);
    });
    this.resizeObserver.observe(this.container);

    this.handleThemeChange = () => {
      // Re-create tooltip with new theme colors
      if (this.tooltip) {
        this.tooltip.remove();
        this.tooltip = null;
      }
      this.createTooltip();
      // Re-render chart with new colors
      if (this.currentEvents.length > 0) this.render(this.currentEvents);
    };
    window.addEventListener('theme-changed', this.handleThemeChange);
  }

  private createTooltip(): void {
    this.tooltip = document.createElement('div');
    Object.assign(this.tooltip.style, {
      position: 'absolute',
      pointerEvents: 'none',
      background: getCSSColor('--bg'),
      border: `1px solid ${getCSSColor('--border')}`,
      borderRadius: '6px',
      padding: '6px 10px',
      fontSize: '12px',
      color: getCSSColor('--text'),
      zIndex: '9999',
      display: 'none',
      whiteSpace: 'nowrap',
      boxShadow: `0 2px 8px ${getCSSColor('--shadow-color')}`,
    });
    this.container.style.position = 'relative';
    this.container.appendChild(this.tooltip);
  }

  render(events: TimelineEvent[]): void {
    this.currentEvents = events;
    if (this.svg) this.svg.remove();

    const width = this.container.clientWidth;
    if (width <= 0) return;

    const innerW = width - MARGIN.left - MARGIN.right;
    const innerH = HEIGHT - MARGIN.top - MARGIN.bottom;

    this.svg = select(this.container)
      .append('svg')
      .attr('width', width)
      .attr('height', HEIGHT)
      .attr('style', 'display:block;');

    const g = this.svg
      .append('g')
      .attr('transform', `translate(${MARGIN.left},${MARGIN.top})`);

    const now = Date.now();
    const xScale = scaleTime()
      .domain([new Date(now - SEVEN_DAYS_MS), new Date(now)])
      .range([0, innerW]);

    const yScale = scaleBand<string>()
      .domain(LANES)
      .range([0, innerH])
      .padding(0.2);

    this.drawGrid(g, xScale, innerH);
    this.drawAxes(g, xScale, yScale, innerH);
    this.drawNowMarker(g, xScale, new Date(now), innerH);
    this.drawEmptyLaneLabels(g, events, yScale, innerW);
    this.drawEvents(g, events, xScale, yScale);
  }

  private drawGrid(
    g: Selection<SVGGElement, unknown, null, undefined>,
    xScale: ScaleTime<number, number>,
    innerH: number,
  ): void {
    const ticks = xScale.ticks(6);
    g.selectAll('.grid-line')
      .data(ticks)
      .join('line')
      .attr('x1', (d) => xScale(d))
      .attr('x2', (d) => xScale(d))
      .attr('y1', 0)
      .attr('y2', innerH)
      .attr('stroke', getCSSColor('--border-subtle'))
      .attr('stroke-width', 1);
  }

  private drawAxes(
    g: Selection<SVGGElement, unknown, null, undefined>,
    xScale: ScaleTime<number, number>,
    yScale: ScaleBand<string>,
    innerH: number,
  ): void {
    const xAxis = axisBottom(xScale)
      .ticks(6)
      .tickFormat(timeFormat('%b %d') as (d: Date | NumberValue, i: number) => string);

    const xAxisG = g
      .append('g')
      .attr('transform', `translate(0,${innerH})`)
      .call(xAxis);

    xAxisG.selectAll('text').attr('fill', getCSSColor('--text-dim')).attr('font-size', '10px');
    xAxisG.selectAll('line').attr('stroke', getCSSColor('--border'));
    xAxisG.select('.domain').attr('stroke', getCSSColor('--border'));

    const laneLabels: Record<string, string> = {
      protest: 'Protest',
      conflict: 'Conflict',
      natural: 'Natural',
      military: 'Military',
    };

    g.selectAll('.lane-label')
      .data(LANES)
      .join('text')
      .attr('x', -10)
      .attr('y', (d) => (yScale(d) ?? 0) + yScale.bandwidth() / 2)
      .attr('text-anchor', 'end')
      .attr('dominant-baseline', 'central')
      .attr('fill', (d: TimelineEvent['lane']) => LANE_COLORS[d])
      .attr('font-size', '11px')
      .attr('font-weight', '500')
      .text((d: TimelineEvent['lane']) => laneLabels[d] || d);
  }

  private drawNowMarker(
    g: Selection<SVGGElement, unknown, null, undefined>,
    xScale: ScaleTime<number, number>,
    now: Date,
    innerH: number,
  ): void {
    const x = xScale(now);
    g.append('line')
      .attr('x1', x)
      .attr('x2', x)
      .attr('y1', 0)
      .attr('y2', innerH)
      .attr('stroke', getCSSColor('--text'))
      .attr('stroke-width', 1)
      .attr('stroke-dasharray', '4,3')
      .attr('opacity', 0.6);

    g.append('text')
      .attr('x', x)
      .attr('y', -6)
      .attr('text-anchor', 'middle')
      .attr('fill', getCSSColor('--text-muted'))
      .attr('font-size', '9px')
      .text(t('components.countryTimeline.now'));
  }

  private drawEmptyLaneLabels(
    g: Selection<SVGGElement, unknown, null, undefined>,
    events: TimelineEvent[],
    yScale: ScaleBand<string>,
    innerW: number,
  ): void {
    const populatedLanes = new Set(events.map((e) => e.lane));
    const emptyLanes = LANES.filter((l) => !populatedLanes.has(l));

    g.selectAll('.empty-label')
      .data(emptyLanes)
      .join('text')
      .attr('x', innerW / 2)
      .attr('y', (d) => (yScale(d) ?? 0) + yScale.bandwidth() / 2)
      .attr('text-anchor', 'middle')
      .attr('dominant-baseline', 'central')
      .attr('fill', getCSSColor('--text-ghost'))
      .attr('font-size', '10px')
      .attr('font-style', 'italic')
      .text(t('components.countryTimeline.noEventsIn7Days'));
  }

  private drawEvents(
    g: Selection<SVGGElement, unknown, null, undefined>,
    events: TimelineEvent[],
    xScale: ScaleTime<number, number>,
    yScale: ScaleBand<string>,
  ): void {
    const tooltip = this.tooltip!;
    const container = this.container;
    const fmt = timeFormat('%b %d, %H:%M');

    g.selectAll('.event-circle')
      .data(events)
      .join('circle')
      .attr('cx', (d) => xScale(new Date(d.timestamp)))
      .attr('cy', (d) => (yScale(d.lane) ?? 0) + yScale.bandwidth() / 2)
      .attr('r', (d) => SEVERITY_RADIUS[d.severity ?? 'medium'] ?? 5)
      .attr('fill', (d) => LANE_COLORS[d.lane])
      .attr('opacity', 0.85)
      .attr('cursor', 'pointer')
      .attr('stroke', getCSSColor('--shadow-color'))
      .attr('stroke-width', 0.5)
      .on('mouseenter', function (event: MouseEvent, d: TimelineEvent) {
        select(this).attr('opacity', 1).attr('stroke', getCSSColor('--text')).attr('stroke-width', 1.5);
        const dateStr = fmt(new Date(d.timestamp));
        tooltip.innerHTML = `<strong>${escapeHtml(d.label)}</strong><br/>${escapeHtml(dateStr)}`;
        tooltip.style.display = 'block';
        const rect = container.getBoundingClientRect();
        const x = event.clientX - rect.left + 12;
        const y = event.clientY - rect.top - 10;
        tooltip.style.left = `${x}px`;
        tooltip.style.top = `${y}px`;
      })
      .on('mousemove', function (event: MouseEvent) {
        const rect = container.getBoundingClientRect();
        const x = event.clientX - rect.left + 12;
        const y = event.clientY - rect.top - 10;
        tooltip.style.left = `${x}px`;
        tooltip.style.top = `${y}px`;
      })
      .on('mouseleave', function () {
        select(this).attr('opacity', 0.85).attr('stroke', getCSSColor('--shadow-color')).attr('stroke-width', 0.5);
        tooltip.style.display = 'none';
      });
  }

  destroy(): void {
    window.removeEventListener('theme-changed', this.handleThemeChange);
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }
    if (this.svg) {
      this.svg.remove();
      this.svg = null;
    }
    if (this.tooltip) {
      this.tooltip.remove();
      this.tooltip = null;
    }
    this.currentEvents = [];
  }
}
