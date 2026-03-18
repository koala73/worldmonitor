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

  private convictionLabel(yes: number): { label: string; cls: string } {
    if (yes >= 60) return { label: t('components.predictions.leanYes'), cls: 'conviction-yes' };
    if (yes <= 40) return { label: t('components.predictions.leanNo'), cls: 'conviction-no' };
    return { label: t('components.predictions.tossUp'), cls: 'conviction-neutral' };
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

        let expiryStr = '';
        if (p.endDate) {
          const d = new Date(p.endDate);
          if (Number.isFinite(d.getTime())) {
            expiryStr = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
          }
        }

        const isKalshi = p.source === 'kalshi';
        const sourceLabel = isKalshi ? 'Kalshi' : 'Polymarket';
        const srcClass = isKalshi ? 'kalshi' : 'polymarket';
        const { label: convLabel, cls: convCls } = this.convictionLabel(yesPercent);

        const yesStrong = yesPercent >= 60 ? ' prediction-bar-strong' : '';
        const noStrong = noPercent >= 60 ? ' prediction-bar-strong' : '';

        return `<div class="prediction-item prediction-src-${srcClass}">
        <div class="prediction-head">
          <span class="prediction-source" data-source="${srcClass}">${sourceLabel}</span>
          ${titleHtml}
        </div>
        <div class="prediction-meta">
          ${volumeStr ? `<span>${t('components.predictions.vol')}: ${volumeStr}</span>` : ''}
          ${expiryStr ? `<span>${t('components.predictions.closes')}: ${expiryStr}</span>` : ''}
          <span class="prediction-conviction ${convCls}">${convLabel}</span>
        </div>
        <div class="prediction-bar">
          <div class="prediction-yes${yesStrong}" style="width:${yesPercent}%">
            <span class="prediction-label">${t('components.predictions.yes')} ${yesPercent}%</span>
          </div>
          <div class="prediction-no${noStrong}" style="width:${noPercent}%">
            <span class="prediction-label">${t('components.predictions.no')} ${noPercent}%</span>
          </div>
        </div>
      </div>`;
      })
      .join('');

    this.setContent(html);
  }
}
