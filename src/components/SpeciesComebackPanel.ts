/**
 * SpeciesComebackPanel -- renders species conservation success story cards
 * with photos, D3 sparklines showing population recovery trends, IUCN
 * category badges, and source citations.
 *
 * Extends Panel base class. Sparklines use warm green area fills with
 * smooth monotone curves matching the ProgressChartsPanel pattern.
 */

import { Panel } from './Panel';
import * as d3 from 'd3';
import type { SpeciesRecovery } from '@/services/conservation-data';
import { getCSSColor } from '@/utils';
import { replaceChildren } from '@/utils/dom-utils';

const SPARKLINE_MARGIN = { top: 4, right: 8, bottom: 16, left: 8 };
const SPARKLINE_HEIGHT = 50;

const NUMBER_FORMAT = new Intl.NumberFormat('en-US');

/** SVG placeholder for broken images -- nature leaf icon on soft green bg */
const FALLBACK_IMAGE_SVG = 'data:image/svg+xml,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300" fill="%236B8F5E">' +
  '<rect width="400" height="300" fill="%23f0f4ed"/>' +
  '<text x="200" y="160" text-anchor="middle" font-size="64">&#x1F33F;</text>' +
  '</svg>',
);

export class SpeciesComebackPanel extends Panel {
  constructor() {
    super({ id: 'species', title: 'Conservation Wins', trackActivity: false });
  }

  /**
   * Set species data and render all cards.
   */
  public setData(species: SpeciesRecovery[]): void {
    // Clear existing content
    replaceChildren(this.content);

    // Empty state
    if (species.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'species-empty';
      empty.textContent = 'No conservation data available';
      this.content.appendChild(empty);
      return;
    }

    // Card grid container
    const grid = document.createElement('div');
    grid.className = 'species-grid';

    for (const entry of species) {
      const card = this.createCard(entry);
      grid.appendChild(card);
    }

    this.content.appendChild(grid);
  }

  /**
   * Create a single species card element.
   */
  private createCard(entry: SpeciesRecovery): HTMLElement {
    const card = document.createElement('div');
    card.className = 'species-card';

    // 1. Photo section
    card.appendChild(this.createPhotoSection(entry));

    // 2. Info section
    card.appendChild(this.createInfoSection(entry));

    // 3. Sparkline section
    const sparklineDiv = document.createElement('div');
    sparklineDiv.className = 'species-sparkline';
    card.appendChild(sparklineDiv);

    // Render sparkline after card is in DOM (needs measurable width)
    // Use a microtask so the card is attached before we draw
    queueMicrotask(() => {
      const color = getCSSColor('--green') || '#6B8F5E';
      this.renderSparkline(sparklineDiv, entry.populationData, color);
    });

    // 4. Summary section
    card.appendChild(this.createSummarySection(entry));

    return card;
  }

  /**
   * Create the photo section with lazy loading and error fallback.
   */
  private createPhotoSection(entry: SpeciesRecovery): HTMLElement {
    const photoDiv = document.createElement('div');
    photoDiv.className = 'species-photo';

    const img = document.createElement('img');
    img.src = entry.photoUrl;
    img.alt = entry.commonName;
    img.loading = 'lazy';
    img.onerror = () => {
      img.onerror = null; // prevent infinite loop
      img.src = FALLBACK_IMAGE_SVG;
    };

    photoDiv.appendChild(img);
    return photoDiv;
  }

  /**
   * Create the info section with name, badges, and region.
   */
  private createInfoSection(entry: SpeciesRecovery): HTMLElement {
    const infoDiv = document.createElement('div');
    infoDiv.className = 'species-info';

    const name = document.createElement('h4');
    name.className = 'species-name';
    name.textContent = entry.commonName;
    infoDiv.appendChild(name);

    const scientific = document.createElement('span');
    scientific.className = 'species-scientific';
    scientific.style.fontStyle = 'italic';
    scientific.textContent = entry.scientificName;
    infoDiv.appendChild(scientific);

    // Badges
    const badgesDiv = document.createElement('div');
    badgesDiv.className = 'species-badges';

    const recoveryBadge = document.createElement('span');
    recoveryBadge.className = `species-badge badge-${entry.recoveryStatus}`;
    recoveryBadge.textContent = entry.recoveryStatus.charAt(0).toUpperCase() + entry.recoveryStatus.slice(1);
    badgesDiv.appendChild(recoveryBadge);

    const iucnBadge = document.createElement('span');
    iucnBadge.className = 'species-badge badge-iucn';
    iucnBadge.textContent = entry.iucnCategory;
    badgesDiv.appendChild(iucnBadge);

    infoDiv.appendChild(badgesDiv);

    const region = document.createElement('span');
    region.className = 'species-region';
    region.textContent = entry.region;
    infoDiv.appendChild(region);

    return infoDiv;
  }

  /**
   * Create the summary section with narrative and source citation.
   */
  private createSummarySection(entry: SpeciesRecovery): HTMLElement {
    const summaryDiv = document.createElement('div');
    summaryDiv.className = 'species-summary';

    const text = document.createElement('p');
    text.textContent = entry.summaryText;
    summaryDiv.appendChild(text);

    const cite = document.createElement('cite');
    cite.className = 'species-source';
    cite.textContent = entry.source;
    summaryDiv.appendChild(cite);

    return summaryDiv;
  }

  /**
   * Render a D3 area + line sparkline showing population recovery trend.
   * Uses viewBox for responsive sizing, matching ProgressChartsPanel pattern.
   */
  private renderSparkline(
    container: HTMLDivElement,
    data: Array<{ year: number; value: number }>,
    color: string,
  ): void {
    if (data.length < 2) return;

    // Use a fixed viewBox width for consistent rendering
    const viewBoxWidth = 280;
    const width = viewBoxWidth - SPARKLINE_MARGIN.left - SPARKLINE_MARGIN.right;
    const height = SPARKLINE_HEIGHT;

    const svg = d3.select(container)
      .append('svg')
      .attr('width', '100%')
      .attr('height', height + SPARKLINE_MARGIN.top + SPARKLINE_MARGIN.bottom)
      .attr('viewBox', `0 0 ${viewBoxWidth} ${height + SPARKLINE_MARGIN.top + SPARKLINE_MARGIN.bottom}`)
      .attr('preserveAspectRatio', 'xMidYMid meet')
      .style('display', 'block');

    const g = svg.append('g')
      .attr('transform', `translate(${SPARKLINE_MARGIN.left},${SPARKLINE_MARGIN.top})`);

    // Scales
    const xExtent = d3.extent(data, d => d.year) as [number, number];
    const yMax = d3.max(data, d => d.value) as number;
    const yPadding = yMax * 0.1;

    const x = d3.scaleLinear()
      .domain(xExtent)
      .range([0, width]);

    const y = d3.scaleLinear()
      .domain([0, yMax + yPadding])
      .range([height, 0]);

    // Area generator with smooth curve
    const area = d3.area<{ year: number; value: number }>()
      .x(d => x(d.year))
      .y0(height)
      .y1(d => y(d.value))
      .curve(d3.curveMonotoneX);

    // Line generator for top edge
    const line = d3.line<{ year: number; value: number }>()
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
      .attr('stroke-width', 1.5);

    // Start label (first data point)
    const first = data[0]!;
    g.append('text')
      .attr('x', x(first.year))
      .attr('y', height + SPARKLINE_MARGIN.bottom - 2)
      .attr('text-anchor', 'start')
      .attr('font-size', '9px')
      .attr('fill', 'var(--text-dim, #999)')
      .text(`${first.year}: ${NUMBER_FORMAT.format(first.value)}`);

    // End label (last data point)
    const last = data[data.length - 1]!;
    g.append('text')
      .attr('x', x(last.year))
      .attr('y', height + SPARKLINE_MARGIN.bottom - 2)
      .attr('text-anchor', 'end')
      .attr('font-size', '9px')
      .attr('fill', 'var(--text-dim, #999)')
      .text(`${last.year}: ${NUMBER_FORMAT.format(last.value)}`);
  }

  /**
   * Clean up and call parent destroy.
   */
  public destroy(): void {
    super.destroy();
  }
}
