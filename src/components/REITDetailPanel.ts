/**
 * REITDetailPanel — Single REIT detailed view.
 *
 * Layout:
 *   ┌─────────────────────────────────────────────────┐
 *   │ 180607.SZ  华夏中海商业REIT        ¥5.83 +0.52% │
 *   │ retail · china · yield 4.00%                     │
 *   ├─────────────────────────────────────────────────┤
 *   │ ┌─Key Metrics──┐ ┌─Social Health──┐            │
 *   │ │ Price  ¥5.83  │ │ Score   7.0    │            │
 *   │ │ Yield  4.00%  │ │ Rating  ★4.0   │            │
 *   │ │ Change +0.52% │ │ Velocity +10%  │            │
 *   │ │ Exposure  15  │ │ 环宇城不错     │            │
 *   │ └──────────────┘ └────────────────┘            │
 *   ├─────────────────────────────────────────────────┤
 *   │ Properties (1)                                   │
 *   │ 📍 佛山映月湖环宇城 · Foshan, GD · Shopping Mall │
 *   ├─────────────────────────────────────────────────┤
 *   │ Peer Comparison (retail sector)                  │
 *   │ O    $57.82  +1.23%  5.41%  ●6.8               │
 *   │ SPG  $148.90 +0.89%  5.09%  ●7.2               │
 *   └─────────────────────────────────────────────────┘
 */

import { Panel } from './Panel';
import type {} from '@/services/i18n';
import { formatChange, getChangeClass } from '@/utils';
import { escapeHtml } from '@/utils/sanitize';
import { miniSparkline } from '@/utils/sparkline';
import type { ReitQuote, ReitSocial, ReitExposureSummary } from '@/services/reits';
import REIT_PROPERTIES from '../../data/reit-properties.json';

type ReitProp = { reitSymbol: string; propertyName: string; lat: number; lng: number; sector: string; propertyType: string; sqft: number; city: string; state: string; metro: string };

const SECTOR_COLORS: Record<string, string> = {
  retail: '#58a6ff', industrial: '#3fb950', residential: '#d2a8ff',
  office: '#d29922', healthcare: '#f85149', datacenter: '#79c0ff',
  specialty: '#e3b341', mortgage: '#8b949e',
};

export class REITDetailPanel extends Panel {
  private currentSymbol: string | null = null;
  private allQuotes: ReitQuote[] = [];
  private socialData: ReitSocial[] = [];
  private exposureData: ReitExposureSummary[] = [];
  private onMapFocus: ((lat: number, lng: number) => void) | null = null;

  constructor() {
    super({
      id: 'reit-detail',
      title: 'REIT Detail',
      infoTooltip: 'Detailed view of a single REIT — properties, metrics, social sentiment, and peer comparison',
    });
  }

  /** Set the map focus handler */
  public setMapFocusHandler(handler: (lat: number, lng: number) => void): void {
    this.onMapFocus = handler;
  }

  /** Update available data (called by data loader) */
  public setData(quotes: ReitQuote[], social: ReitSocial[], exposure: ReitExposureSummary[]): void {
    this.allQuotes = quotes;
    this.socialData = social;
    this.exposureData = exposure;
    // Re-render if a REIT is already selected
    if (this.currentSymbol) this.showReit(this.currentSymbol);
  }

  /** Show detail for a specific REIT */
  public showReit(symbol: string): void {
    this.currentSymbol = symbol;
    const quote = this.allQuotes.find(q => q.symbol === symbol);
    if (!quote) {
      this.setContent(`<div style="padding:16px;text-align:center;color:var(--text-dim);font-size:12px">No data for ${escapeHtml(symbol)}</div>`);
      return;
    }

    const social = this.socialData.find(s => s.reitSymbol === symbol);
    const exposure = this.exposureData.find(e => e.reitSymbol === symbol);
    const properties = (REIT_PROPERTIES as ReitProp[]).filter(p => p.reitSymbol === symbol);
    const peers = this.allQuotes.filter(q => q.sector === quote.sector && q.symbol !== symbol).slice(0, 5);

    const html = [
      this.renderHeader(quote),
      this.renderMetrics(quote, social, exposure),
      this.renderProperties(properties),
      this.renderPeers(quote, peers),
    ].join('');

    this.setContent(html);
    this.attachListeners(properties);
  }

  private renderHeader(q: ReitQuote): string {
    const currency = q.market === 'china' ? '¥' : '$';
    const sectorColor = SECTOR_COLORS[q.sector] || '#8b949e';
    const changeClass = getChangeClass(q.change);

    return `
      <div style="padding:12px 0;border-bottom:1px solid var(--border)">
        <div style="display:flex;justify-content:space-between;align-items:baseline">
          <div>
            <span style="font-size:16px;font-weight:700;color:var(--text)">${escapeHtml(q.symbol)}</span>
            <span style="font-size:13px;color:var(--text-dim);margin-left:8px">${escapeHtml(q.name)}</span>
          </div>
          <div style="text-align:right">
            <span style="font-size:18px;font-weight:700;color:var(--text)">${currency}${q.price.toFixed(2)}</span>
            <span class="${changeClass}" style="font-size:13px;margin-left:6px">${formatChange(q.change)}</span>
          </div>
        </div>
        <div style="margin-top:6px;display:flex;gap:6px;align-items:center">
          <span style="font-size:10px;padding:2px 6px;border-radius:3px;background:${sectorColor}22;color:${sectorColor}">${escapeHtml(q.sector)}</span>
          <span style="font-size:10px;padding:2px 6px;border-radius:3px;background:var(--bg);color:var(--text-dim)">${q.market === 'china' ? '🇨🇳 C-REIT' : '🇺🇸 US REIT'}</span>
          <span style="font-size:10px;color:#d2a8ff;font-weight:600">Yield ${q.dividendYield.toFixed(2)}%</span>
          <span style="margin-left:auto">${miniSparkline(q.sparkline, q.change)}</span>
        </div>
      </div>
    `;
  }

  private renderMetrics(q: ReitQuote, social: ReitSocial | undefined, exposure: ReitExposureSummary | undefined): string {
    const scoreColor = social && social.socialHealthScore >= 7 ? '#3fb950' : social && social.socialHealthScore >= 5 ? '#d29922' : '#8b949e';
    const expColor = q.disasterExposureScore > 50 ? '#f85149' : q.disasterExposureScore > 25 ? '#d29922' : '#3fb950';

    return `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;padding:12px 0;border-bottom:1px solid var(--border)">
        <div style="background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:10px">
          <div style="font-size:10px;font-weight:600;color:var(--text-dim);margin-bottom:8px">KEY METRICS</div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;font-size:11px">
            <div><span style="color:var(--text-dim)">Yield</span></div>
            <div style="text-align:right;color:#d2a8ff;font-weight:600">${q.dividendYield.toFixed(2)}%</div>
            <div><span style="color:var(--text-dim)">Change</span></div>
            <div style="text-align:right" class="${getChangeClass(q.change)}">${formatChange(q.change)}</div>
            <div><span style="color:var(--text-dim)">Exposure</span></div>
            <div style="text-align:right;color:${expColor};font-weight:600">${q.disasterExposureScore}/100</div>
            ${exposure ? `
              <div><span style="color:var(--text-dim)">Seismic</span></div>
              <div style="text-align:right">${exposure.seismicZoneCount} properties</div>
              <div><span style="color:var(--text-dim)">Wildfire</span></div>
              <div style="text-align:right">${exposure.wildfireRiskCount} properties</div>
              <div><span style="color:var(--text-dim)">Hurricane</span></div>
              <div style="text-align:right">${exposure.hurricaneCorridorCount} properties</div>
            ` : ''}
          </div>
        </div>
        <div style="background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:10px">
          <div style="font-size:10px;font-weight:600;color:var(--text-dim);margin-bottom:8px">SOCIAL HEALTH</div>
          ${social ? `
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
              <span style="font-size:24px;font-weight:700;color:${scoreColor}">${social.socialHealthScore.toFixed(1)}</span>
              <span style="font-size:11px;color:#d2a8ff">★${social.avgRating.toFixed(1)}</span>
              <span style="font-size:10px;color:${social.reviewVelocity > 0 ? '#3fb950' : social.reviewVelocity < 0 ? '#f85149' : '#8b949e'}">
                ${social.reviewVelocity > 0 ? '▲' : social.reviewVelocity < 0 ? '▼' : '—'}${Math.abs(social.reviewVelocity)}%
              </span>
            </div>
            ${social.positiveKeywords.length > 0 ? `
              <div style="display:flex;flex-wrap:wrap;gap:3px;margin-bottom:4px">
                ${social.positiveKeywords.map(k => `<span style="font-size:9px;padding:1px 5px;border-radius:3px;background:#3fb95022;color:#3fb950">${escapeHtml(k)}</span>`).join('')}
              </div>
            ` : ''}
            ${social.negativeKeywords.length > 0 ? `
              <div style="display:flex;flex-wrap:wrap;gap:3px">
                ${social.negativeKeywords.map(k => `<span style="font-size:9px;padding:1px 5px;border-radius:3px;background:#f8514922;color:#f85149">${escapeHtml(k)}</span>`).join('')}
              </div>
            ` : ''}
            ${social.tenantRiskSignals.length > 0 ? `
              <div style="margin-top:6px;font-size:10px;color:#f85149">⚠ ${social.tenantRiskSignals.map(s => escapeHtml(s)).join(', ')}</div>
            ` : ''}
          ` : `
            <div style="font-size:11px;color:var(--text-dim)">No social data available${q.sector === 'mortgage' ? ' (mortgage REIT)' : ''}</div>
          `}
        </div>
      </div>
    `;
  }

  private renderProperties(properties: ReitProp[]): string {
    if (properties.length === 0) {
      return `<div style="padding:12px 0;font-size:11px;color:var(--text-dim);border-bottom:1px solid var(--border)">No property data available</div>`;
    }

    const rows = properties.map(p => {
      const typeLabel = p.propertyType.replace(/_/g, ' ');
      const sqftLabel = p.sqft > 0 ? `${(p.sqft / 10000).toFixed(0)}万sqft` : '';
      return `
        <div class="reit-detail-property" data-lat="${p.lat}" data-lng="${p.lng}"
             style="display:flex;align-items:center;gap:8px;padding:6px 0;cursor:pointer;border-bottom:1px solid var(--border)11">
          <span style="font-size:14px">📍</span>
          <div style="flex:1">
            <div style="font-size:11px;font-weight:600;color:var(--text)">${escapeHtml(p.propertyName)}</div>
            <div style="font-size:10px;color:var(--text-dim)">${escapeHtml(p.city)}, ${escapeHtml(p.state)} · ${escapeHtml(typeLabel)} ${sqftLabel ? '· ' + sqftLabel : ''}</div>
          </div>
          <span style="font-size:10px;color:var(--accent)">→ Map</span>
        </div>
      `;
    }).join('');

    return `
      <div style="padding:12px 0;border-bottom:1px solid var(--border)">
        <div style="font-size:10px;font-weight:600;color:var(--text-dim);margin-bottom:8px">PROPERTIES (${properties.length})</div>
        ${rows}
      </div>
    `;
  }

  private renderPeers(current: ReitQuote, peers: ReitQuote[]): string {
    if (peers.length === 0) return '';

    const rows = peers.map(p => {
      const currency = p.market === 'china' ? '¥' : '$';
      const social = this.socialData.find(s => s.reitSymbol === p.symbol);
      const scoreColor = social && social.socialHealthScore >= 7 ? '#3fb950' : social && social.socialHealthScore >= 5 ? '#d29922' : '#8b949e';

      return `
        <div class="reit-detail-peer" data-symbol="${escapeHtml(p.symbol)}"
             style="display:grid;grid-template-columns:70px 1fr 65px 55px 50px 35px;gap:4px;align-items:center;padding:5px 0;font-size:11px;cursor:pointer;border-bottom:1px solid var(--border)11">
          <span style="font-weight:600">${escapeHtml(p.symbol)}</span>
          <span style="color:var(--text-dim);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(p.name)}</span>
          <span style="text-align:right">${currency}${p.price.toFixed(2)}</span>
          <span style="text-align:right" class="${getChangeClass(p.change)}">${formatChange(p.change)}</span>
          <span style="text-align:right;color:#d2a8ff">${p.dividendYield.toFixed(1)}%</span>
          <span style="text-align:right;color:${scoreColor};font-weight:600">${social ? social.socialHealthScore.toFixed(1) : '—'}</span>
        </div>
      `;
    }).join('');

    return `
      <div style="padding:12px 0">
        <div style="font-size:10px;font-weight:600;color:var(--text-dim);margin-bottom:8px">SECTOR PEERS (${escapeHtml(current.sector)})</div>
        <div style="display:grid;grid-template-columns:70px 1fr 65px 55px 50px 35px;gap:4px;font-size:10px;color:var(--text-dim);padding-bottom:4px;border-bottom:1px solid var(--border)">
          <span>Symbol</span><span>Name</span><span style="text-align:right">Price</span><span style="text-align:right">Chg</span><span style="text-align:right">Yield</span><span style="text-align:right">Social</span>
        </div>
        ${rows}
      </div>
    `;
  }

  private attachListeners(_properties: ReitProp[]): void {
    // Property → map focus
    this.content.querySelectorAll<HTMLElement>('.reit-detail-property').forEach(el => {
      el.addEventListener('click', () => {
        const lat = parseFloat(el.dataset.lat || '0');
        const lng = parseFloat(el.dataset.lng || '0');
        if (lat && lng && this.onMapFocus) this.onMapFocus(lat, lng);
      });
    });

    // Peer → switch to that REIT
    this.content.querySelectorAll<HTMLElement>('.reit-detail-peer').forEach(el => {
      el.addEventListener('click', () => {
        const symbol = el.dataset.symbol;
        if (symbol) this.showReit(symbol);
      });
    });
  }
}
