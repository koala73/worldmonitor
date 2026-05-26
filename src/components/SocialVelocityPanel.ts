import { Panel } from './Panel';
import { t } from '@/services/i18n';
import { escapeHtml, sanitizeUrl } from '@/utils/sanitize';
import { fetchSocialVelocity, type SocialVelocityPost } from '@/services/social-velocity';

function relativeTime(ms: number): string {
  if (!ms) return '';
  const diff = Date.now() - ms;
  const h = Math.floor(diff / 3600000);
  if (h < 1) return 'just now';
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function velocityColor(score: number): string {
  if (score >= 80) return '#e74c3c';
  if (score >= 50) return '#e67e22';
  if (score >= 25) return '#f1c40f';
  return '#27ae60';
}

function formatScore(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

export class SocialVelocityPanel extends Panel {
  private _posts: SocialVelocityPost[] = [];
  private _hasData = false;

  constructor() {
    super({ id: 'social-velocity', title: 'Social Velocity', showCount: false, infoTooltip: t('components.socialVelocity.infoTooltip') });
  }

  public async fetchData(): Promise<boolean> {
    this.showLoading();
    try {
      const data = await fetchSocialVelocity();
      if (!data.posts?.length) {
        if (!this._hasData) this.showError('No signal data available', () => void this.fetchData());
        return false;
      }
      this._posts = [...data.posts].sort((a, b) => b.velocityScore - a.velocityScore);
      this._hasData = true;
      this._render();
      return true;
    } catch (e) {
      if (!this._hasData) this.showError(e instanceof Error ? e.message : 'Failed to load', () => void this.fetchData());
      return false;
    }
  }

  public updateData(posts: SocialVelocityPost[]): void {
    this._posts = [...posts].sort((a, b) => b.velocityScore - a.velocityScore);
    this._hasData = this._posts.length > 0;
    if (this._hasData) this._render();
  }

  private _render(): void {
    const rows = this._posts.slice(0, 20).map((p, i) => {
      const age = relativeTime(p.createdAt);
      const vColor = velocityColor(p.velocityScore);
      const ratio = Math.round(p.upvoteRatio * 100);
      const barWidth = Math.max(4, Math.round(p.velocityScore));

      return `<div style="border-bottom:1px solid var(--border);padding:8px 0">
        <div style="display:flex;gap:8px;align-items:flex-start">
          <span style="flex-shrink:0;font-size:10px;font-weight:700;color:var(--text-dim);min-width:18px;text-align:right;margin-top:2px">${i + 1}</span>
          <div style="flex:1;min-width:0">
            <a href="${escapeHtml(sanitizeUrl(p.url))}" target="_blank" rel="noopener noreferrer" style="font-size:12px;font-weight:500;color:var(--text);text-decoration:none;line-height:1.35;display:block">${escapeHtml(p.title)}</a>
            <div style="display:flex;gap:8px;margin-top:4px;align-items:center;flex-wrap:wrap">
              <span style="font-size:9px;padding:1px 6px;border-radius:3px;background:rgba(255,255,255,0.06);color:var(--text-dim)">r/${escapeHtml(p.subreddit)}</span>
              <span style="font-size:9px;color:var(--text-dim)">&#9650; ${escapeHtml(formatScore(p.score))}</span>
              <span style="font-size:9px;color:var(--text-dim)">&#128172; ${escapeHtml(formatScore(p.numComments))}</span>
              <span style="font-size:9px;color:var(--text-dim)">${ratio}% up</span>
              ${age ? `<span style="font-size:9px;color:var(--text-dim)">${escapeHtml(age)}</span>` : ''}
            </div>
          </div>
          <div style="flex-shrink:0;display:flex;flex-direction:column;align-items:center;gap:2px">
            <span style="font-size:11px;font-weight:700;color:${vColor}">${Math.round(p.velocityScore)}</span>
            <div style="width:32px;height:3px;border-radius:2px;background:rgba(255,255,255,0.08)">
              <div style="height:100%;width:${barWidth}%;max-width:100%;border-radius:2px;background:${vColor}"></div>
            </div>
          </div>
        </div>
      </div>`;
    }).join('');

    this.setContent(`
      <div style="overflow-y:auto;max-height:440px">
        ${rows || '<div style="padding:16px;text-align:center;color:var(--text-dim);font-size:12px">No signals</div>'}
      </div>
      <div style="margin-top:6px;font-size:9px;color:var(--text-dim)">Reddit · velocity = recency × score × ratio</div>
    `);
  }
}
