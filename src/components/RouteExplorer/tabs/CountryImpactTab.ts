/**
 * Impact tab — shows strategic-product impact data for the destination
 * country. Renders top 5 products by value with chokepoint exposure,
 * lane-specific value for the selected HS2, and dependency flags.
 *
 * Clicking a strategic-product row fires onDrillSideways with that HS2,
 * allowing the explorer to re-query with the clicked product.
 */

import type {
  GetRouteImpactResponse,
  StrategicProduct,
} from '@/generated/server/worldmonitor/supply_chain/v1/service_server';
import {
  formatScoredResilienceOverallLabel,
  formatResilienceConfidence,
  formatResilienceScoreInterval,
  hasScoredResilienceOverall,
} from '@/components/resilience-widget-utils';
import type { ResilienceScoreResponse } from '@/services/resilience';
import { escapeHtml } from './route-utils';
import { setTrustedHtml, trustedHtml } from '@/utils/dom-utils';


export interface CountryImpactTabOptions {
  onDrillSideways?: (hs2: string) => void;
}

function hs4ToHs2(hs4: string): string {
  return String(Number.parseInt(hs4.slice(0, 2), 10));
}

function formatUsd(value: number): string {
  if (value >= 1e9) return `$${(value / 1e9).toFixed(1)}B`;
  if (value >= 1e6) return `$${(value / 1e6).toFixed(1)}M`;
  if (value >= 1e3) return `$${(value / 1e3).toFixed(0)}K`;
  return `$${value.toFixed(0)}`;
}

const FLAG_LABELS: Record<string, string> = {
  DEPENDENCY_FLAG_SINGLE_SOURCE_CRITICAL: 'Single Source Critical',
  DEPENDENCY_FLAG_SINGLE_CORRIDOR_CRITICAL: 'Single Corridor Critical',
  DEPENDENCY_FLAG_COMPOUND_RISK: 'Compound Risk',
  DEPENDENCY_FLAG_DIVERSIFIABLE: 'Diversifiable',
};

export class CountryImpactTab {
  public readonly element: HTMLDivElement;
  private opts: CountryImpactTabOptions;
  private data: GetRouteImpactResponse | null = null;
  private resilience: ResilienceScoreResponse | null = null;

  constructor(opts: CountryImpactTabOptions = {}) {
    this.opts = opts;
    this.element = document.createElement('div');
    this.element.className = 're-tab re-tab--impact';
    this.element.setAttribute('role', 'tabpanel');
    this.renderPlaceholder();
  }

  public update(data: GetRouteImpactResponse | null): void {
    this.data = data;
    if (!data) this.resilience = null;
    if (!data) { this.renderPlaceholder(); return; }
    if (data.comtradeSource === 'missing') { this.renderMissing(); return; }
    if (data.comtradeSource === 'empty') { this.renderEmpty(); return; }
    if (data.comtradeSource === 'lazy') { this.renderLazy(); return; }
    this.renderData(data);
  }

  public updateResilience(resilience: ResilienceScoreResponse | null): void {
    this.resilience = resilience;
    if (this.data && this.data.comtradeSource !== 'missing' && this.data.comtradeSource !== 'empty' && this.data.comtradeSource !== 'lazy') {
      this.updateResilienceSlot(this.data);
    }
  }

  private renderPlaceholder(): void {
    setTrustedHtml(this.element, trustedHtml('<div class="re-tab__placeholder">Pick a country pair and product to see the impact analysis.</div>', "legacy direct innerHTML migration"));
  }

  private renderMissing(): void {
    setTrustedHtml(this.element, trustedHtml('<div class="re-tab__empty">' +
      '<h3>No trade data available</h3>' +
      '<p>WorldMonitor does not have bilateral trade data for this destination country yet.</p>' +
      '</div>', "legacy direct innerHTML migration"));
  }

  private renderEmpty(): void {
    setTrustedHtml(this.element, trustedHtml('<div class="re-tab__empty">' +
      '<h3>No strategic products found</h3>' +
      '<p>The bilateral trade store returned empty data for this destination.</p>' +
      '</div>', "legacy direct innerHTML migration"));
  }

  private renderLazy(): void {
    setTrustedHtml(this.element, trustedHtml('<div class="re-tab__empty">' +
      '<h3>Loading trade data</h3>' +
      '<p>WorldMonitor is fetching trade data for this destination for the first time. ' +
      'Try again in a few seconds.</p>' +
      '</div>', "legacy direct innerHTML migration"));
  }

  private renderData(data: GetRouteImpactResponse): void {
    const bannerHtml = !data.hs2InSeededUniverse
      ? '<div class="re-impact__banner">Lane value for this HS code is not in WorldMonitor\'s strategic-products dataset. Top strategic products shown below.</div>'
      : '';

    const laneHtml = data.hs2InSeededUniverse
      ? `<div class="re-impact__lane">
          <div class="re-impact__lane-value">${formatUsd(data.laneValueUsd)}</div>
          <div class="re-impact__lane-label">Lane value at risk</div>
          ${data.primaryExporterIso2 ? `<div class="re-impact__lane-exporter">Top exporter: ${escapeHtml(data.primaryExporterIso2)} (${Math.round(data.primaryExporterShare * 100)}%)</div>` : ''}
        </div>`
      : '';

    const flagsHtml = data.dependencyFlags.length > 0
      ? `<div class="re-impact__flags">${data.dependencyFlags.map((f) => `<span class="re-impact__flag re-impact__flag--${f.toLowerCase().replace(/^dependency_flag_/, '')}">${escapeHtml(FLAG_LABELS[f] ?? f)}</span>`).join('')}</div>`
      : '';

    const productsHtml = this.renderProducts(data.topStrategicProducts);

    setTrustedHtml(this.element, trustedHtml(`${bannerHtml}${laneHtml}${flagsHtml}<div class="re-impact__resilience-slot">${this.renderResilience(data)}</div><h3 class="re-impact__products-title">Top strategic products</h3>${productsHtml}`, "legacy direct innerHTML migration"));
    this.attachDrillListeners();
  }

  private updateResilienceSlot(data: GetRouteImpactResponse): void {
    const slot = this.element.querySelector('.re-impact__resilience-slot');
    if (!slot) return;
    setTrustedHtml(slot, trustedHtml(this.renderResilience(data), "legacy direct innerHTML migration"));
  }

  private renderResilience(data: GetRouteImpactResponse): string {
    const resilience = this.resilience;
    if (resilience && hasScoredResilienceOverall(resilience)) {
      const scoreLabel = formatScoredResilienceOverallLabel(resilience.overallScore);
      const confidence = formatResilienceConfidence(resilience);
      const interval = formatResilienceScoreInterval(resilience.scoreInterval);
      return [
        '<div class="re-impact__resilience">',
        `  <span>Resilience: <strong>${escapeHtml(scoreLabel)}/100</strong></span>`,
        ...(interval
          ? [`  <span class="re-resilience-interval" title="${escapeHtml(interval.title)}">${escapeHtml(interval.label)}</span>`]
          : []),
        `  <span class="re-resilience-confidence${resilience.lowConfidence ? ' re-resilience-confidence--low' : ''}">${escapeHtml(confidence)}</span>`,
        '</div>',
      ].join('');
    }
    if (resilience) {
      return '<div class="re-impact__resilience"><span>Resilience: <strong>\u2014</strong></span><span class="re-resilience-confidence re-resilience-confidence--low">No scored resilience data</span></div>';
    }
    const fallbackScore = Number.isFinite(data.resilienceScore) ? Math.round(data.resilienceScore) : 0;
    if (fallbackScore > 0) {
      return `<div class="re-impact__resilience"><span>Resilience: <strong>${fallbackScore}/100</strong></span><span class="re-resilience-confidence">Confidence unavailable</span></div>`;
    }
    return '';
  }

  private renderProducts(products: StrategicProduct[]): string {
    if (products.length === 0) return '<div class="re-tab__empty">No products available.</div>';
    const rows = products.map((p) =>
      `<tr class="re-impact__product-row" data-hs2="${escapeHtml(hs4ToHs2(p.hs4))}" tabindex="0">` +
      `<td class="re-impact__product-code">HS ${escapeHtml(p.hs4)}</td>` +
      `<td class="re-impact__product-name">${escapeHtml(p.label)}</td>` +
      `<td class="re-impact__product-value">${formatUsd(p.totalValueUsd)}</td>` +
      `<td class="re-impact__product-exporter">${escapeHtml(p.topExporterIso2)} (${Math.round(p.topExporterShare * 100)}%)</td>` +
      `<td class="re-impact__product-chokepoint">${escapeHtml(p.primaryChokepointId)}</td>` +
      `</tr>`,
    );
    return [
      '<table class="re-impact__products">',
      '<thead><tr><th>HS4</th><th>Product</th><th>Value</th><th>Top Exporter</th><th>Chokepoint</th></tr></thead>',
      `<tbody>${rows.join('')}</tbody>`,
      '</table>',
    ].join('');
  }

  private attachDrillListeners(): void {
    if (!this.opts.onDrillSideways) return;
    const rows = this.element.querySelectorAll<HTMLElement>('.re-impact__product-row');
    rows.forEach((row) => {
      const hs2 = row.dataset.hs2;
      if (!hs2) return;
      const drill = () => this.opts.onDrillSideways?.(hs2);
      row.addEventListener('click', drill);
      row.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); drill(); }
      });
    });
  }
}
