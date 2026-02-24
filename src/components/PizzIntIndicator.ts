import type { PizzIntStatus, GdeltTensionPair } from '@/types';
import { t } from '@/services/i18n';
import { h, replaceChildren } from '@/utils/dom-utils';

const DEFCON_COLORS: Record<number, string> = {
  1: '#ff0040',
  2: '#ff4400',
  3: '#ffaa00',
  4: '#00aaff',
  5: '#2d8a6e',
};

export class PizzIntIndicator {
  private element: HTMLElement;
  private isExpanded = false;
  private status: PizzIntStatus | null = null;
  private tensions: GdeltTensionPair[] = [];

  constructor() {
    const panel = h('div', { className: 'pizzint-panel hidden' },
      h('div', { className: 'pizzint-header' },
        h('span', { className: 'pizzint-title' }, t('components.pizzint.title')),
        h('button', {
          className: 'pizzint-close',
          onClick: () => { this.isExpanded = false; panel.classList.add('hidden'); },
        }, '×'),
      ),
      h('div', { className: 'pizzint-status-bar' },
        h('div', { className: 'pizzint-defcon-label' }),
      ),
      h('div', { className: 'pizzint-locations' }),
      h('div', { className: 'pizzint-tensions' },
        h('div', { className: 'pizzint-tensions-title' }, t('components.pizzint.tensionsTitle')),
        h('div', { className: 'pizzint-tensions-list' }),
      ),
      h('div', { className: 'pizzint-footer' },
        h('span', { className: 'pizzint-source' },
          t('components.pizzint.source'), ' ',
          h('a', { href: 'https://pizzint.watch', target: '_blank', rel: 'noopener' }, 'PizzINT'),
        ),
        h('span', { className: 'pizzint-updated' }),
      ),
    );

    this.element = h('div', { className: 'pizzint-indicator' },
      h('button', {
        className: 'pizzint-toggle',
        title: t('components.pizzint.title'),
        onClick: () => { this.isExpanded = !this.isExpanded; panel.classList.toggle('hidden', !this.isExpanded); },
      },
        h('span', { className: 'pizzint-icon' }, '🍕'),
        h('span', { className: 'pizzint-defcon' }, '--'),
        h('span', { className: 'pizzint-score' }, '--%'),
      ),
      panel,
    );

  }

  public updateStatus(status: PizzIntStatus): void {
    this.status = status;
    this.render();
  }

  public updateTensions(tensions: GdeltTensionPair[]): void {
    this.tensions = tensions;
    this.renderTensions();
  }

  private render(): void {
    if (!this.status) return;

    const defconEl = this.element.querySelector('.pizzint-defcon') as HTMLElement;
    const scoreEl = this.element.querySelector('.pizzint-score') as HTMLElement;
    const labelEl = this.element.querySelector('.pizzint-defcon-label') as HTMLElement;
    const locationsEl = this.element.querySelector('.pizzint-locations') as HTMLElement;
    const updatedEl = this.element.querySelector('.pizzint-updated') as HTMLElement;

    const color = DEFCON_COLORS[this.status.defconLevel] || '#888';
    defconEl.textContent = t('components.pizzint.defcon', { level: String(this.status.defconLevel) });
    defconEl.style.background = color;
    defconEl.style.color = this.status.defconLevel <= 3 ? '#000' : '#fff';

    scoreEl.textContent = `${this.status.aggregateActivity}%`;
    labelEl.textContent = this.getDefconLabel(this.status.defconLevel);
    labelEl.style.color = color;

    replaceChildren(locationsEl,
      ...this.status.locations.map(loc =>
        h('div', { className: 'pizzint-location' },
          h('span', { className: 'pizzint-location-name' }, loc.name),
          h('span', { className: `pizzint-location-status ${this.getStatusClass(loc)}` }, this.getStatusLabel(loc)),
        ),
      ),
    );

    const timeAgo = this.formatTimeAgo(this.status.lastUpdate);
    updatedEl.textContent = t('components.pizzint.updated', { timeAgo });
  }

  private renderTensions(): void {
    const listEl = this.element.querySelector('.pizzint-tensions-list') as HTMLElement;
    if (!listEl) return;

    replaceChildren(listEl,
      ...this.tensions.map(tp => {
        const trendIcon = tp.trend === 'rising' ? '↑' : tp.trend === 'falling' ? '↓' : '→';
        const changeText = tp.changePercent > 0 ? `+${tp.changePercent}%` : `${tp.changePercent}%`;
        return h('div', { className: 'pizzint-tension-row' },
          h('span', { className: 'pizzint-tension-label' }, tp.label),
          h('span', { className: 'pizzint-tension-score' },
            h('span', { className: 'pizzint-tension-value' }, tp.score.toFixed(1)),
            h('span', { className: `pizzint-tension-trend ${tp.trend}` }, `${trendIcon} ${changeText}`),
          ),
        );
      }),
    );
  }

  private getStatusClass(loc: { is_closed_now: boolean; is_spike: boolean; current_popularity: number }): string {
    if (loc.is_closed_now) return 'closed';
    if (loc.is_spike) return 'spike';
    if (loc.current_popularity >= 70) return 'high';
    if (loc.current_popularity >= 40) return 'elevated';
    if (loc.current_popularity >= 15) return 'nominal';
    return 'quiet';
  }

  private getStatusLabel(loc: { is_closed_now: boolean; is_spike: boolean; current_popularity: number }): string {
    if (loc.is_closed_now) return t('components.pizzint.statusClosed');
    if (loc.is_spike) return `${t('components.pizzint.statusSpike')} ${loc.current_popularity}%`;
    if (loc.current_popularity >= 70) return `${t('components.pizzint.statusHigh')} ${loc.current_popularity}%`;
    if (loc.current_popularity >= 40) return `${t('components.pizzint.statusElevated')} ${loc.current_popularity}%`;
    if (loc.current_popularity >= 15) return `${t('components.pizzint.statusNominal')} ${loc.current_popularity}%`;
    return `${t('components.pizzint.statusQuiet')} ${loc.current_popularity}%`;
  }

  private formatTimeAgo(date: Date): string {
    const diff = Date.now() - date.getTime();
    if (diff < 60000) return t('components.pizzint.justNow');
    if (diff < 3600000) return t('components.pizzint.minutesAgo', { m: String(Math.floor(diff / 60000)) });
    return t('components.pizzint.hoursAgo', { h: String(Math.floor(diff / 3600000)) });
  }

  private getDefconLabel(level: number): string {
    const key = `components.pizzint.defconLabels.${level}`;
    const localized = t(key);
    return localized === key ? this.status?.defconLabel || '' : localized;
  }

  public getElement(): HTMLElement {
    return this.element;
  }

  public hide(): void {
    this.element.style.display = 'none';
  }

  public show(): void {
    this.element.style.display = '';
  }
}
