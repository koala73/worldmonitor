import { Panel } from './Panel';
import { getCSSColor } from '@/utils';
import { calculateCII, type CountryScore } from '@/services/country-instability';
import { t } from '../services/i18n';
import { h, replaceChildren, rawHtml } from '@/utils/dom-utils';

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

  private static readonly SHARE_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12v7a2 2 0 002 2h12a2 2 0 002-2v-7"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/></svg>';

  private buildTrendArrow(trend: CountryScore['trend'], change: number): HTMLElement {
    if (trend === 'rising') return h('span', { className: 'trend-up' }, `↑${change > 0 ? change : ''}`);
    if (trend === 'falling') return h('span', { className: 'trend-down' }, `↓${Math.abs(change)}`);
    return h('span', { className: 'trend-stable' }, '→');
  }

  private buildCountry(country: CountryScore): HTMLElement {
    const color = this.getLevelColor(country.level);
    const emoji = this.getLevelEmoji(country.level);

    const shareBtn = h('button', {
      className: 'cii-share-btn',
      dataset: { code: country.code, name: country.name },
      title: t('common.shareStory'),
    });
    shareBtn.appendChild(rawHtml(CIIPanel.SHARE_SVG));

    return h('div', { className: 'cii-country', dataset: { code: country.code } },
      h('div', { className: 'cii-header' },
        h('span', { className: 'cii-emoji' }, emoji),
        h('span', { className: 'cii-name' }, country.name),
        h('span', { className: 'cii-score' }, String(country.score)),
        this.buildTrendArrow(country.trend, country.change24h),
        shareBtn,
      ),
      h('div', { className: 'cii-bar-container' },
        h('div', { className: 'cii-bar', style: `width: ${country.score}%; background: ${color};` }),
      ),
      h('div', { className: 'cii-components' },
        h('span', { title: t('common.unrest') }, `U:${country.components.unrest}`),
        h('span', { title: t('common.conflict') }, `C:${country.components.conflict}`),
        h('span', { title: t('common.security') }, `S:${country.components.security}`),
        h('span', { title: t('common.information') }, `I:${country.components.information}`),
      ),
    );
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
        replaceChildren(this.content, h('div', { className: 'empty-state' }, t('components.cii.noSignals')));
        return;
      }

      const listEl = h('div', { className: 'cii-list' }, ...withData.map(s => this.buildCountry(s)));
      replaceChildren(this.content, listEl);
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
