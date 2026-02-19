import { Panel } from './Panel';
import { escapeHtml } from '@/utils/sanitize';
import { getCSSColor } from '@/utils';
import { calculateCII, type CountryScore } from '@/services/country-instability';
import { t } from '../services/i18n';

export class CIIPanel extends Panel {
  private scores: CountryScore[] = [];
  private focalPointsReady = false;
  private onShareStory?: (code: string, name: string) => void;

  constructor() {
    super({
      id: 'cii',
      title: t('panels.cii'),
      infoTooltip: t('components.cii.infoTooltip'),
    });
    this.showLoading(t('common.loading'));
  }

  public setShareStoryHandler(handler: (code: string, name: string) => void): void {
    this.onShareStory = handler;
  }

  private getLevelColor(level: CountryScore['level']): string {
    switch (level) {
      case 'critical': return getCSSColor('--semantic-critical');
      case 'high': return getCSSColor('--semantic-high');
      case 'elevated': return getCSSColor('--semantic-elevated');
      case 'normal': return getCSSColor('--semantic-normal');
      case 'low': return getCSSColor('--semantic-low');
    }
  }

  private getLevelEmoji(level: CountryScore['level']): string {
    switch (level) {
      case 'critical': return '🔴';
      case 'high': return '🟠';
      case 'elevated': return '🟡';
      case 'normal': return '🟢';
      case 'low': return '⚪';
    }
  }

  private getTrendArrow(trend: CountryScore['trend'], change: number): string {
    if (trend === 'rising') return `<span class="trend-up">↑${change > 0 ? change : ''}</span>`;
    if (trend === 'falling') return `<span class="trend-down">↓${Math.abs(change)}</span>`;
    return '<span class="trend-stable">→</span>';
  }

  private renderCountry(country: CountryScore): string {
    const barWidth = country.score;
    const color = this.getLevelColor(country.level);
    const emoji = this.getLevelEmoji(country.level);
    const trend = this.getTrendArrow(country.trend, country.change24h);

    return `
      <div class="cii-country" data-code="${escapeHtml(country.code)}">
        <div class="cii-header">
          <span class="cii-emoji">${emoji}</span>
          <span class="cii-name">${escapeHtml(country.name)}</span>
          <span class="cii-score">${country.score}</span>
          ${trend}
          <button class="cii-share-btn" data-code="${escapeHtml(country.code)}" data-name="${escapeHtml(country.name)}" title="${t('common.shareStory')}"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12v7a2 2 0 002 2h12a2 2 0 002-2v-7"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/></svg></button>
        </div>
        <div class="cii-bar-container">
          <div class="cii-bar" style="width: ${barWidth}%; background: ${color};"></div>
        </div>
        <div class="cii-components">
          <span title="${t('common.unrest')}">U:${country.components.unrest}</span>
          <span title="${t('common.conflict')}">C:${country.components.conflict}</span>
          <span title="${t('common.security')}">S:${country.components.security}</span>
          <span title="${t('common.information')}">I:${country.components.information}</span>
        </div>
      </div>
    `;
  }

  private bindShareButtons(): void {
    if (!this.onShareStory) return;
    this.content.querySelectorAll('.cii-share-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const el = e.currentTarget as HTMLElement;
        const code = el.dataset.code || '';
        const name = el.dataset.name || '';
        if (code && name) this.onShareStory!(code, name);
      });
    });
  }

  public async refresh(forceLocal = false): Promise<void> {
    if (!this.focalPointsReady && !forceLocal) {
      return;
    }

    if (forceLocal) {
      this.focalPointsReady = true;
      console.log('[CIIPanel] Focal points ready, calculating scores...');
    }

    this.showLoading();

    try {
      const localScores = calculateCII();
      const localWithData = localScores.filter(s => s.score > 0).length;
      this.scores = localScores;
      console.log(`[CIIPanel] Calculated ${localWithData} countries with focal point intelligence`);

      const withData = this.scores.filter(s => s.score > 0);
      this.setCount(withData.length);

      if (withData.length === 0) {
        this.content.innerHTML = `<div class="empty-state">${t('components.cii.noSignals')}</div>`;
        return;
      }

      const html = withData.map(s => this.renderCountry(s)).join('');
      this.content.innerHTML = `<div class="cii-list">${html}</div>`;
      this.bindShareButtons();
    } catch (error) {
      console.error('[CIIPanel] Refresh error:', error);
      this.showError(t('common.failedCII'));
    }
  }

  public getScores(): CountryScore[] {
    return this.scores;
  }
}
