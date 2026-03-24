/**
 * REITSocialPanel — Social sentiment intelligence per REIT.
 *
 * Layout:
 *   ┌─────────────────────────────────────────┐
 *   │ SPG  ●7.2  ★4.1  ▲+12%  [tags...]     │
 *   │ O    ●8.1  ★4.3  — flat  [tags...]     │
 *   │ VNO  ●3.8  ★2.9  ▼-18%  [tags...]     │
 *   │ ⚠ Express: store closing mentions       │
 *   └─────────────────────────────────────────┘
 *
 * Empty state (first run): warm, patient message.
 * Stale state: shows last-known data with timestamp.
 * Mortgage REITs: excluded (no physical properties).
 */

import { Panel } from './Panel';
import { t } from '@/services/i18n';
import { escapeHtml } from '@/utils/sanitize';
import type { GetReitSocialSentimentResponse, ReitSocial } from '@/services/reits';

const SCORE_COLORS = (score: number): string => {
  if (score >= 7) return '#3fb950';
  if (score >= 5) return '#d29922';
  if (score >= 3) return '#f85149';
  return '#8b949e';
};

export class REITSocialPanel extends Panel {
  private onReitClick: ((symbol: string) => void) | null = null;

  constructor() {
    super({
      id: 'reit-social',
      title: t('panels.reitSocial') || 'REIT Social',
      infoTooltip: t('components.reitSocial.infoTooltip') || 'Social health scores from Google Reviews and Yelp, review velocity trends, and tenant risk signals',
    });
  }

  /** Set handler to focus map on REIT properties when clicked */
  public setReitClickHandler(handler: (symbol: string) => void): void {
    this.onReitClick = handler;
  }

  public renderSocial(data: GetReitSocialSentimentResponse): void {
    // Empty state — first run, no data yet
    if (!data.sentiments?.length && data.unavailableReason) {
      this.setContent(`
        <div style="padding:20px;text-align:center">
          <div style="font-size:24px;margin-bottom:8px;opacity:0.5">📊</div>
          <div style="font-size:12px;color:var(--text-dim);line-height:1.5">
            ${escapeHtml(data.unavailableReason)}
          </div>
        </div>
      `);
      if (data.stale) this.setDataBadge('cached', data.unavailableReason);
      return;
    }

    if (!data.sentiments?.length) {
      this.showError(t('common.failedToLoad') || 'Social data unavailable');
      return;
    }

    if (data.stale) {
      this.setDataBadge('cached', `Last updated: ${data.lastUpdated || 'unknown'}`);
    } else {
      this.setDataBadge('live');
    }

    // Sort by social health score descending
    const sorted = [...data.sentiments].sort((a, b) => b.socialHealthScore - a.socialHealthScore);

    // Collect tenant risk signals
    const allRisks = sorted.flatMap(s => s.tenantRiskSignals || []);

    const cardsHtml = sorted.map(s => this.renderCard(s)).join('');
    const risksHtml = allRisks.length > 0 ? this.renderRisks(allRisks) : '';

    this.setContent(`
      <div style="display:flex;flex-direction:column;gap:6px">
        ${cardsHtml}
      </div>
      ${risksHtml}
    `);

    this.setCount(sorted.length);
    this.attachClickListeners();
  }

  private renderCard(s: ReitSocial): string {
    const scoreColor = SCORE_COLORS(s.socialHealthScore);
    const velocityIcon = s.reviewVelocity > 10 ? '▲' : s.reviewVelocity < -10 ? '▼' : '—';
    const velocityColor = s.reviewVelocity > 10 ? '#3fb950' : s.reviewVelocity < -10 ? '#f85149' : '#8b949e';
    const stars = s.avgRating > 0 ? `★${s.avgRating.toFixed(1)}` : '—';

    const keywords = [
      ...(s.positiveKeywords || []).slice(0, 2).map(k => `<span style="font-size:9px;padding:1px 5px;border-radius:3px;background:#3fb95022;color:#3fb950">${escapeHtml(k)}</span>`),
      ...(s.negativeKeywords || []).slice(0, 2).map(k => `<span style="font-size:9px;padding:1px 5px;border-radius:3px;background:#f8514922;color:#f85149">${escapeHtml(k)}</span>`),
    ].join('');

    return `
      <div class="reit-social-card" data-reit-social-symbol="${escapeHtml(s.reitSymbol)}"
           style="display:flex;align-items:center;gap:10px;padding:8px;background:var(--bg);border:1px solid var(--border);border-radius:6px;cursor:pointer">
        <div style="min-width:50px">
          <div style="font-weight:600;font-size:11px">${escapeHtml(s.reitSymbol)}</div>
          <div style="font-size:9px;color:var(--text-dim)">${escapeHtml(s.sector)}</div>
        </div>
        <div style="display:flex;align-items:center;gap:2px;min-width:35px" title="Social Health Score">
          <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${scoreColor}"></span>
          <span style="font-size:12px;font-weight:600;color:${scoreColor}">${s.socialHealthScore.toFixed(1)}</span>
        </div>
        <div style="font-size:11px;color:#d2a8ff;min-width:30px" title="Average rating">${stars}</div>
        <div style="font-size:10px;color:${velocityColor};min-width:25px" title="Review velocity MoM">
          ${velocityIcon}${Math.abs(s.reviewVelocity) > 0 ? Math.abs(s.reviewVelocity).toFixed(0) + '%' : ''}
        </div>
        <div style="display:flex;gap:3px;flex-wrap:wrap;flex:1">${keywords}</div>
      </div>
    `;
  }

  private renderRisks(risks: string[]): string {
    return `
      <div style="margin-top:8px;padding:8px;background:#f8514911;border:1px solid #f8514933;border-radius:6px">
        ${risks.map(r => `
          <div style="font-size:10px;color:#f85149;padding:2px 0">
            ⚠ ${escapeHtml(r)}
          </div>
        `).join('')}
      </div>
    `;
  }

  private attachClickListeners(): void {
    this.content.querySelectorAll<HTMLElement>('.reit-social-card').forEach(card => {
      card.addEventListener('click', () => {
        const symbol = card.dataset.reitSocialSymbol;
        if (symbol && this.onReitClick) this.onReitClick(symbol);
      });
    });
  }
}
