/**
 * REITPeerOverlay — Slide-in peer comparison panel from right.
 *
 * Shows selected REIT vs sector peers:
 *   yield comparison, change%, socialHealthScore, disaster exposure.
 *
 * Triggered by clicking a REIT row in REITPanel.
 * Slides in from right (300px), overlays map area.
 * Close with '×' or click outside.
 */

import { escapeHtml } from '@/utils/sanitize';
import { formatPrice, formatChange, getChangeClass } from '@/utils';
import type { ReitQuote, ReitSocial, ReitExposureSummary } from '@/services/reits';

export class REITPeerOverlay {
  private overlay: HTMLElement | null = null;

  /**
   * Open the peer comparison for a given REIT symbol.
   * Finds all sector peers and renders a comparison view.
   */
  public show(
    symbol: string,
    allQuotes: ReitQuote[],
    socialData: ReitSocial[],
    exposureData: ReitExposureSummary[],
  ): void {
    this.close();

    const target = allQuotes.find(q => q.symbol === symbol);
    if (!target) return;

    const peers = allQuotes
      .filter(q => q.sector === target.sector && q.symbol !== symbol)
      .slice(0, 8);

    const all = [target, ...peers];

    const socialMap = new Map(socialData.map(s => [s.reitSymbol, s]));
    const exposureMap = new Map(exposureData.map(e => [e.reitSymbol, e]));

    // Create overlay
    this.overlay = document.createElement('div');
    this.overlay.className = 'reit-peer-overlay';
    this.overlay.style.cssText = `
      position:fixed;top:0;right:0;bottom:0;width:320px;
      background:var(--panel-bg, #161b22);border-left:1px solid var(--border, #30363d);
      z-index:1000;overflow-y:auto;padding:16px;
      animation:slideInRight 0.2s ease-out;
      box-shadow:-4px 0 20px rgba(0,0,0,0.3);
    `;

    // Backdrop
    const backdrop = document.createElement('div');
    backdrop.style.cssText = 'position:fixed;top:0;left:0;right:320px;bottom:0;z-index:999;';
    backdrop.addEventListener('click', () => this.close());

    // Header
    const header = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">
        <div>
          <div style="font-size:14px;font-weight:600;color:var(--text, #e6edf3)">${escapeHtml(target.symbol)} vs Peers</div>
          <div style="font-size:11px;color:var(--text-dim, #8b949e)">${escapeHtml(target.sector)} sector · ${all.length} REITs</div>
        </div>
        <button data-reit-peer-close style="background:none;border:none;color:var(--text-dim, #8b949e);font-size:18px;cursor:pointer;padding:4px 8px">×</button>
      </div>
    `;

    // Comparison rows
    const rows = all.map(q => {
      const isTarget = q.symbol === symbol;
      const social = socialMap.get(q.symbol);
      const exposure = exposureMap.get(q.symbol);
      const currency = q.market === 'china' ? '¥' : '$';
      const scoreColor = social && social.socialHealthScore >= 7 ? '#3fb950' : social && social.socialHealthScore >= 5 ? '#d29922' : '#8b949e';
      const expColor = exposure && exposure.disasterExposureScore > 50 ? '#f85149' : exposure && exposure.disasterExposureScore > 25 ? '#d29922' : '#3fb950';

      return `
        <div style="padding:10px;background:${isTarget ? 'var(--accent-bg, #1f6feb22)' : 'var(--bg, #0d1117)'};border:1px solid ${isTarget ? 'var(--accent, #58a6ff)33' : 'var(--border, #30363d)'};border-radius:6px;margin-bottom:6px">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
            <span style="font-weight:600;font-size:12px;color:var(--text, #e6edf3)">${escapeHtml(q.symbol)}${isTarget ? ' ←' : ''}</span>
            <span style="font-size:11px;color:var(--text-dim, #8b949e)">${escapeHtml(q.name)}</span>
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:4px;font-size:10px">
            <div>
              <div style="color:var(--text-dim, #8b949e)">Price</div>
              <div style="font-weight:600">${currency}${formatPrice(q.price)}</div>
            </div>
            <div>
              <div style="color:var(--text-dim, #8b949e)">Change</div>
              <div class="${getChangeClass(q.change)}" style="font-weight:600">${formatChange(q.change)}</div>
            </div>
            <div>
              <div style="color:var(--text-dim, #8b949e)">Yield</div>
              <div style="font-weight:600;color:#d2a8ff">${q.dividendYield.toFixed(2)}%</div>
            </div>
            <div>
              <div style="color:var(--text-dim, #8b949e)">Social</div>
              <div style="font-weight:600;color:${scoreColor}">${social ? social.socialHealthScore.toFixed(1) : '—'}</div>
            </div>
          </div>
          ${exposure ? `
            <div style="margin-top:6px;font-size:10px;color:${expColor}">
              Exposure: ${exposure.disasterExposureScore}/100
              ${exposure.seismicZoneCount > 0 ? ` · ${exposure.seismicZoneCount} seismic` : ''}
              ${exposure.wildfireRiskCount > 0 ? ` · ${exposure.wildfireRiskCount} fire` : ''}
              ${exposure.hurricaneCorridorCount > 0 ? ` · ${exposure.hurricaneCorridorCount} storm` : ''}
            </div>
          ` : ''}
        </div>
      `;
    }).join('');

    this.overlay.innerHTML = `${header}<div>${rows}</div>`;

    // Attach close handler
    this.overlay.querySelector('[data-reit-peer-close]')?.addEventListener('click', () => this.close());

    // Add CSS animation if not already present
    if (!document.getElementById('reit-peer-animation')) {
      const style = document.createElement('style');
      style.id = 'reit-peer-animation';
      style.textContent = `
        @keyframes slideInRight {
          from { transform: translateX(100%); opacity: 0; }
          to { transform: translateX(0); opacity: 1; }
        }
      `;
      document.head.appendChild(style);
    }

    document.body.appendChild(backdrop);
    document.body.appendChild(this.overlay);

    // Store backdrop for cleanup
    (this.overlay as any)._backdrop = backdrop;
  }

  public close(): void {
    if (this.overlay) {
      const backdrop = (this.overlay as any)._backdrop;
      if (backdrop) backdrop.remove();
      this.overlay.remove();
      this.overlay = null;
    }
  }

  public isOpen(): boolean {
    return this.overlay !== null;
  }
}
