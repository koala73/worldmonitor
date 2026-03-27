import { Panel } from './Panel';
import { t } from '@/services/i18n';
import { hasPremiumAccess } from '@/services/panel-gating';
import { FrameworkSelector } from './FrameworkSelector';
import type { DailyMarketBrief } from '@/services/daily-market-brief';
import { describeFreshness } from '@/services/persistent-cache';
import { escapeHtml } from '@/utils/sanitize';
import { getChangeClass } from '@/utils';

type BriefSource = 'live' | 'cached';

function formatGeneratedTime(isoTimestamp: string, timezone: string): string {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour: 'numeric',
      minute: '2-digit',
      month: 'short',
      day: 'numeric',
    }).format(new Date(isoTimestamp));
  } catch {
    return isoTimestamp;
  }
}

function stanceLabel(stance: DailyMarketBrief['items'][number]['stance']): string {
  if (stance === 'bullish') return 'Bullish';
  if (stance === 'defensive') return 'Defensive';
  return 'Neutral';
}

function formatPrice(price: number | null): string {
  if (typeof price !== 'number' || !Number.isFinite(price)) return 'N/A';
  return price.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function formatChange(change: number | null): string {
  if (typeof change !== 'number' || !Number.isFinite(change)) return 'Flat';
  const sign = change > 0 ? '+' : '';
  return `${sign}${change.toFixed(2)}%`;
}

export class DailyMarketBriefPanel extends Panel {
  private fwSelector: FrameworkSelector;

  constructor() {
    super({ id: 'daily-market-brief', title: 'Daily Market Brief', infoTooltip: t('components.dailyMarketBrief.infoTooltip'), premium: 'locked' });
    this.fwSelector = new FrameworkSelector({ panelId: 'daily-market-brief', isPremium: hasPremiumAccess(), panel: this, note: 'Applies to client-generated analysis only' });
    this.header.appendChild(this.fwSelector.el);
  }

  public override destroy(): void {
    this.fwSelector.destroy();
    super.destroy();
  }

  public renderBrief(brief: DailyMarketBrief, source: BriefSource = 'live'): void {
    const freshness = describeFreshness(new Date(brief.generatedAt).getTime());
    this.setDataBadge(source, freshness);
    this.resetRetryBackoff();

    const html = `
      <div class="daily-brief-shell" style="display:grid;gap:12px">
        <div class="daily-brief-card" style="display:grid;gap:6px;padding:12px;border:1px solid var(--border);border-radius:4px;background:rgba(255,255,255,0.03)">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:12px">
            <div style="font-size:13px;font-weight:600">${escapeHtml(brief.title)}</div>
            <div style="font-size:11px;color:var(--text-dim)">${escapeHtml(formatGeneratedTime(brief.generatedAt, brief.timezone))}</div>
          </div>
          <div style="font-size:12px;line-height:1.5;color:var(--text)">${escapeHtml(brief.summary)}</div>
        </div>

        <div style="display:grid;gap:10px">
          <div style="padding:10px 12px;border:1px solid var(--border);border-radius:4px;background:rgba(255,255,255,0.02)">
            <div style="font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--text-dim);margin-bottom:4px">Action Plan</div>
            <div style="font-size:12px;line-height:1.5">${escapeHtml(brief.actionPlan)}</div>
          </div>
          <div style="padding:10px 12px;border:1px solid var(--border);border-radius:4px;background:rgba(255,255,255,0.02)">
            <div style="font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--text-dim);margin-bottom:4px">Risk Watch</div>
            <div style="font-size:12px;line-height:1.5">${escapeHtml(brief.riskWatch)}</div>
          </div>
        </div>

        <div style="display:grid;gap:8px">
          ${brief.items.map((item) => `
            <div style="display:grid;gap:6px;padding:10px 12px;border:1px solid var(--border);border-radius:4px;background:rgba(255,255,255,0.02)">
              <div style="display:flex;align-items:center;justify-content:space-between;gap:12px">
                <div>
                  <div style="font-size:12px;font-weight:600">${escapeHtml(item.name)}</div>
                  <div style="font-size:11px;color:var(--text-dim)">${escapeHtml(item.display)}</div>
                </div>
                <div style="text-align:right">
                  <div style="font-size:12px;font-weight:600">${escapeHtml(formatPrice(item.price))}</div>
                  <div class="market-change ${getChangeClass(item.change ?? 0)}" style="font-size:11px">${escapeHtml(formatChange(item.change))}</div>
                </div>
              </div>
              <div style="display:flex;align-items:center;justify-content:space-between;gap:12px">
                <div style="font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--text-dim)">${escapeHtml(stanceLabel(item.stance))}</div>
                ${item.relatedHeadline ? `<div style="font-size:11px;color:var(--text-dim);text-align:right;max-width:55%">Linked headline</div>` : ''}
              </div>
              <div style="font-size:12px;line-height:1.45">${escapeHtml(item.note)}</div>
            </div>
          `).join('')}
        </div>

      </div>
    `;

    this.setContent(html);
  }

  public showUnavailable(message = 'The daily brief needs live market data before it can be generated.'): void {
    this.showError(message);
  }
}
