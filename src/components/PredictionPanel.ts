import { Panel } from './Panel';
import type { PredictionMarket } from '@/services/prediction';
import { escapeHtml, sanitizeUrl } from '@/utils/sanitize';
import { t } from '@/services/i18n';

export class PredictionPanel extends Panel {
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
        ${titleHtml}
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
  }
}
