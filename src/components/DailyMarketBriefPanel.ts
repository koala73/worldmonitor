import { Panel } from './Panel';
import { getCurrentLanguage, t } from '@/services/i18n';
import { hasPremiumAccess } from '@/services/panel-gating';
import { FrameworkSelector } from './FrameworkSelector';
import type { DailyMarketBrief } from '@/services/daily-market-brief';
import { describeFreshness } from '@/services/persistent-cache';
import { getCachedContentTranslation, translateContentText } from '@/services/content-translation';
import { escapeHtml } from '@/utils/sanitize';
import { getChangeClass } from '@/utils';

type BriefSource = 'live' | 'cached';
const BRIEF_COPY_TRANSLATION_DELAY_MS = 200;

function formatGeneratedTime(isoTimestamp: string, timezone: string, lang = 'en'): string {
  const locale = lang === 'en' ? 'en-US' : lang;
  try {
    return new Intl.DateTimeFormat(locale, {
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

function getBriefCopy(text: string, lang: string): string {
  return getCachedContentTranslation(text, lang) ?? text;
}

function stanceCopySource(stance: DailyMarketBrief['items'][number]['stance']): string {
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
  private briefCopyRequestId = 0;

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
    const lang = brief.lang || getCurrentLanguage();
    const freshness = describeFreshness(new Date(brief.generatedAt).getTime());
    this.setDataBadge(source, freshness);
    this.resetRetryBackoff();
    const actionPlanLabel = getBriefCopy('Action Plan', lang);
    const riskWatchLabel = getBriefCopy('Risk Watch', lang);
    const linkedHeadlineLabel = getBriefCopy('Linked headline', lang);

    const html = `
      <div class="daily-brief-shell" style="display:grid;gap:12px">
        <div class="daily-brief-card" style="display:grid;gap:6px;padding:12px;border:1px solid var(--border);border-radius:4px;background:rgba(255,255,255,0.03)">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:12px">
            <div style="font-size:13px;font-weight:600">${escapeHtml(brief.title)}</div>
            <div style="font-size:11px;color:var(--text-dim)">${escapeHtml(formatGeneratedTime(brief.generatedAt, brief.timezone, lang))}</div>
          </div>
          <div style="font-size:12px;line-height:1.5;color:var(--text)">${escapeHtml(brief.summary)}</div>
        </div>

        <div style="display:grid;gap:10px">
          <div style="padding:10px 12px;border:1px solid var(--border);border-radius:4px;background:rgba(255,255,255,0.02)">
            <div data-brief-copy="Action Plan" style="font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--text-dim);margin-bottom:4px">${escapeHtml(actionPlanLabel)}</div>
            <div style="font-size:12px;line-height:1.5">${escapeHtml(brief.actionPlan)}</div>
          </div>
          <div style="padding:10px 12px;border:1px solid var(--border);border-radius:4px;background:rgba(255,255,255,0.02)">
            <div data-brief-copy="Risk Watch" style="font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--text-dim);margin-bottom:4px">${escapeHtml(riskWatchLabel)}</div>
            <div style="font-size:12px;line-height:1.5">${escapeHtml(brief.riskWatch)}</div>
          </div>
        </div>

        <div style="display:grid;gap:8px">
          ${brief.items.map((item) => {
            const stanceSource = stanceCopySource(item.stance);
            const stanceLabel = getBriefCopy(stanceSource, lang);
            return `
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
                <div data-brief-copy="${escapeHtml(stanceSource)}" style="font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--text-dim)">${escapeHtml(stanceLabel)}</div>
                ${item.relatedHeadline ? `<div data-brief-copy="Linked headline" style="font-size:11px;color:var(--text-dim);text-align:right;max-width:55%">${escapeHtml(linkedHeadlineLabel)}</div>` : ''}
              </div>
              <div style="font-size:12px;line-height:1.45">${escapeHtml(item.note)}</div>
            </div>
          `;
          }).join('')}
        </div>

      </div>
    `;

    this.setContent(html);
    this.scheduleBriefCopyTranslation(lang);
  }

  public showUnavailable(message = 'The daily brief needs live market data before it can be generated.'): void {
    const lang = getCurrentLanguage();
    const displayMessage = getBriefCopy(message, lang);
    this.showError(displayMessage);

    const requestId = ++this.briefCopyRequestId;
    if (lang === 'en' || displayMessage !== message) return;
    setTimeout(() => {
      void this.translateUnavailableMessage(message, lang, requestId);
    }, BRIEF_COPY_TRANSLATION_DELAY_MS);
  }

  private scheduleBriefCopyTranslation(targetLang: string): void {
    const requestId = ++this.briefCopyRequestId;
    if (targetLang === 'en') return;
    setTimeout(() => {
      void this.translateBriefCopy(targetLang, requestId);
    }, BRIEF_COPY_TRANSLATION_DELAY_MS);
  }

  private async translateBriefCopy(targetLang: string, requestId: number): Promise<void> {
    if (requestId !== this.briefCopyRequestId || !this.element.isConnected) return;

    const labels = Array.from(this.content.querySelectorAll<HTMLElement>('[data-brief-copy]'));
    for (const label of labels) {
      if (requestId !== this.briefCopyRequestId || !label.isConnected) return;
      const source = label.dataset.briefCopy;
      if (!source) continue;

      const translated = await translateContentText(source, targetLang, { sourceLang: 'en' });
      if (requestId !== this.briefCopyRequestId || !label.isConnected) return;
      if (translated && translated !== source) {
        label.textContent = translated;
      }
    }
  }

  private async translateUnavailableMessage(message: string, targetLang: string, requestId: number): Promise<void> {
    const translated = await translateContentText(message, targetLang, { sourceLang: 'en' });
    if (requestId !== this.briefCopyRequestId || !this.element.isConnected) return;
    if (translated && translated !== message) {
      this.showError(translated);
    }
  }
}
