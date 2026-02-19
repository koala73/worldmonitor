import { Panel } from './Panel';
import type { PredictionMarket } from '@/types';
import { escapeHtml, sanitizeUrl } from '@/utils/sanitize';
import { t, getCurrentLanguage } from '@/services/i18n';
import { translateTextCached } from '@/services';

export class PredictionPanel extends Panel {
  private autoTranslateRunId = 0;

  constructor() {
    super({
      id: 'polymarket',
      title: t('panels.polymarket'),
      infoTooltip: t('components.prediction.infoTooltip'),
    });
  }

  private formatVolume(volume?: number): string {
    if (!volume) return '';
    if (volume >= 1_000_000) return `$${(volume / 1_000_000).toFixed(1)}M`;
    if (volume >= 1_000) return `$${(volume / 1_000).toFixed(0)}K`;
    return `$${volume.toFixed(0)}`;
  }

  public renderPredictions(data: PredictionMarket[]): void {
    if (data.length === 0) {
      this.showError(t('common.failedPredictions'));
      return;
    }

    const currentLang = getCurrentLanguage();
    const showTranslate = currentLang !== 'en';
    const translateTitle = currentLang === 'vi' ? 'Dịch' : 'Translate';

    const html = data
      .map((p) => {
        const yesPercent = Math.round(p.yesPrice);
        const noPercent = 100 - yesPercent;
        const volumeStr = this.formatVolume(p.volume);

        const safeUrl = sanitizeUrl(p.url || '');
        const titleHtml = safeUrl
          ? `<a href="${safeUrl}" target="_blank" rel="noopener" class="prediction-question prediction-link">${escapeHtml(p.title)}</a>`
          : `<div class="prediction-question">${escapeHtml(p.title)}</div>`;

        return `
      <div class="prediction-item">
        <div class="prediction-question-row">
          ${titleHtml}
          ${showTranslate ? `<button type="button" class="item-translate-btn prediction-translate-btn" title="${translateTitle}" data-text="${escapeHtml(p.title)}">文</button>` : ''}
        </div>
        ${volumeStr ? `<div class="prediction-volume">${t('components.predictions.vol')}: ${volumeStr}</div>` : ''}
        <div class="prediction-bar">
          <div class="prediction-yes" style="width: ${yesPercent}%">
            <span class="prediction-label">${t('components.predictions.yes')} ${yesPercent}%</span>
          </div>
          <div class="prediction-no" style="width: ${noPercent}%">
            <span class="prediction-label">${t('components.predictions.no')} ${noPercent}%</span>
          </div>
        </div>
      </div>
    `;
      })
      .join('');

    this.setContent(html);
    this.bindTranslateEvents();
    this.queueAutoTranslatePredictions();
  }

  private bindTranslateEvents(): void {
    const buttons = this.content.querySelectorAll<HTMLElement>('.prediction-translate-btn');
    buttons.forEach((button) => {
      if (button.dataset.boundClick === '1') return;
      button.dataset.boundClick = '1';
      button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        const text = button.dataset.text;
        if (text) void this.handleTranslate(button, text);
      });
    });
  }

  private async handleTranslate(button: HTMLElement, text: string): Promise<void> {
    const currentLang = getCurrentLanguage();
    if (currentLang === 'en') return;

    const itemEl = button.closest('.prediction-item');
    const titleEl = itemEl?.querySelector('.prediction-question') as HTMLElement | null;
    if (!titleEl) return;

    const originalText = (titleEl.dataset.original || titleEl.textContent || text).trim();
    if (!originalText) return;
    button.innerHTML = '...';
    button.style.pointerEvents = 'none';

    try {
      const translated = await translateTextCached(originalText, currentLang);
      if (!translated) {
        button.innerHTML = '文';
        return;
      }

      titleEl.textContent = translated;
      titleEl.dataset.original = originalText;
      titleEl.dataset.translatedLang = currentLang;
      button.dataset.text = originalText;
      button.innerHTML = '✓';
      button.classList.add('translated');
      button.title = (currentLang === 'vi' ? 'Bản gốc: ' : 'Original: ') + originalText;
    } catch (error) {
      console.error('[PredictionPanel] Translation failed:', error);
      button.innerHTML = '文';
    } finally {
      button.style.pointerEvents = 'auto';
    }
  }

  private queueAutoTranslatePredictions(): void {
    const lang = getCurrentLanguage();
    if (lang === 'en') return;

    const runId = ++this.autoTranslateRunId;
    window.setTimeout(() => {
      if (runId !== this.autoTranslateRunId) return;
      void this.autoTranslateVisiblePredictions(lang);
    }, 0);
  }

  private async autoTranslateVisiblePredictions(lang: string): Promise<void> {
    const titleEls = Array.from(this.content.querySelectorAll<HTMLElement>('.prediction-item .prediction-question'));
    if (titleEls.length === 0) return;

    await Promise.allSettled(titleEls.map(async (titleEl) => {
      if (titleEl.dataset.translatedLang === lang) return;

      const sourceText = (titleEl.dataset.original || titleEl.textContent || '').trim();
      if (!sourceText) return;

      const translated = await translateTextCached(sourceText, lang);
      if (!translated) return;

      titleEl.dataset.original = sourceText;
      titleEl.dataset.translatedLang = lang;
      titleEl.textContent = translated;

      const button = titleEl.closest('.prediction-item')?.querySelector<HTMLElement>('.prediction-translate-btn');
      if (!button) return;
      button.dataset.text = sourceText;
      button.innerHTML = '✓';
      button.classList.add('translated');
      button.title = (lang === 'vi' ? 'Bản gốc: ' : 'Original: ') + sourceText;
    }));
  }
}
