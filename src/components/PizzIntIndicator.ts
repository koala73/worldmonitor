import type { PizzIntLocation, PizzIntStatus, GdeltTensionPair, TensionEvidence } from '@/types';
import { getCurrentLanguageTag, t } from '@/services/i18n';
import { h, replaceChildren } from '@/utils/dom-utils';
import tensionPairs from '../../shared/gdelt-tension-pairs.json';

const DEFCON_COLORS: Record<number, string> = {
  1: '#ff0040',
  2: '#ff4400',
  3: '#ffaa00',
  4: '#00aaff',
  5: '#2d8a6e',
};

const MAX_EVIDENCE = 3;
// More airports than this read as a count.
const MAX_NAMED_AIRPORTS = 2;
const AIRPORT_STATUS_KEYS: Record<string, string> = {
  closed: 'components.pizzint.evidenceAirportClosed',
  halted: 'components.pizzint.evidenceAirportHalted',
  restricted: 'components.pizzint.evidenceAirportRestricted',
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
          t('components.pizzint.indexSource'),
          h('span', { className: 'pizzint-venue-source', hidden: true },
            ' · ', t('components.pizzint.venueSource'), ' ',
            h('a', { href: 'https://www.pizzint.watch', target: '_blank', rel: 'noopener' }, 'PizzINT'),
          ),
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
    const labelEl = this.element.querySelector('.pizzint-defcon-label') as HTMLElement;
    const locationsEl = this.element.querySelector('.pizzint-locations') as HTMLElement;
    const updatedEl = this.element.querySelector('.pizzint-updated') as HTMLElement;
    // PizzINT is credited for its venue data. The BestTime fallback is a
    // paid API, not a source to name, so the footer reads only the index.
    const venueEl = this.element.querySelector<HTMLElement>('.pizzint-venue-source');
    if (venueEl) venueEl.hidden = this.status.locationsMonitored === 0
      || this.status.locations.some(loc => loc.data_source === 'besttime');

    if (this.status.locationsMonitored === 0) {
      defconEl.textContent = '--';
      defconEl.style.background = '';
      defconEl.style.color = '';
      labelEl.textContent = t('components.pizzint.pizzaUnavailable');
      labelEl.style.color = '';
      replaceChildren(locationsEl);
      updatedEl.textContent = '';
      return;
    }

    const color = DEFCON_COLORS[this.status.defconLevel] || '#888';
    defconEl.textContent = t('components.pizzint.defcon', { level: String(this.status.defconLevel) });
    defconEl.style.background = color;
    // Black on every DEFCON hue clears WCAG AA 4.5:1 (green #2d8a6e→4.97:1,
    // blue #00aaff→8.2:1); white failed on levels 4–5 (4.22:1 / 2.56:1).
    defconEl.style.color = '#000';

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
      ...tensionPairs.flatMap(config => {
        const tp = this.tensions.find(pair => pair.id === config.id);
        if (!tp) return [h('div', { className: 'pizzint-tension-row' },
          h('span', { className: 'pizzint-tension-label' }, config.label),
          h('span', { className: 'pizzint-tension-score' }, t('components.pizzint.insufficientData')),
        )];
        const trendIcon = tp.trend === 'rising' ? '↑' : tp.trend === 'falling' ? '↓' : '→';
        const changeText = tp.changePercent > 0 ? `+${tp.changePercent}%` : `${tp.changePercent}%`;
        const evidence = this.describeEvidence(tp.evidence ?? []);
        return [
          h('div', { className: 'pizzint-tension-row' },
            h('span', { className: 'pizzint-tension-label' }, tp.label),
            h('span', { className: 'pizzint-tension-score' },
              h('span', { className: 'pizzint-tension-value' }, tp.score.toFixed(1)),
              h('span', { className: `pizzint-tension-trend ${tp.trend}` }, `${trendIcon} ${changeText}`),
            ),
          ),
          ...(evidence ? [h('div', { className: 'pizzint-tension-evidence' }, evidence)] : []),
        ];
      }),
    );
  }

  private describeEvidence(items: TensionEvidence[]): string {
    if (items.length === 0) return '';
    const lang = getCurrentLanguageTag();
    const count = (n: number) => new Intl.NumberFormat(lang, { maximumFractionDigits: n < 10 ? 1 : 0 }).format(n);
    let regions: Intl.DisplayNames | null = null;
    try { regions = new Intl.DisplayNames([lang], { type: 'region' }); } catch { /* runtime without region names */ }
    const country = (code: string) => regions?.of(code) ?? code;
    const countries = (codes: string[]) => codes.map(country).join(', ');
    const usual = (item: TensionEvidence) => item.baseline == null
      ? '' : ` ${t('components.pizzint.evidenceUsual', { value: count(item.baseline) })}`;
    const describe = (item: TensionEvidence): string => {
      const value = count(item.value);
      switch (item.channel) {
        case 'strikes':
          return t('components.pizzint.evidenceStrikes', { countries: countries(item.countries), value }) + usual(item);
        case 'airports':
          if (item.baseline == null && item.airports.length > 0 && item.airports.length <= MAX_NAMED_AIRPORTS) {
            return item.airports
              .map(airport => AIRPORT_STATUS_KEYS[airport.status] ? t(AIRPORT_STATUS_KEYS[airport.status]!, { name: airport.name }) : '')
              .filter(Boolean)
              .join(', ');
          }
          return t('components.pizzint.evidenceAirports', { value }) + usual(item);
        case 'military_aircraft':
          return t('components.pizzint.evidenceMilitaryAircraft', { country: countries(item.countries), value }) + usual(item);
        case 'pla_aircraft':
          return t('components.pizzint.evidencePlaAircraft', { value }) + usual(item);
        case 'pla_ships':
          return t('components.pizzint.evidencePlaShips', { value }) + usual(item);
        case 'sanctions':
          return t('components.pizzint.evidenceSanctions', { country: countries(item.countries), value }) + usual(item);
        default:
          return '';
      }
    };
    return items.map(describe).filter(Boolean).slice(0, MAX_EVIDENCE).join(' · ');
  }

  private getStatusClass(loc: PizzIntLocation): string {
    if (loc.is_closed_now) return 'closed';
    if (loc.no_live_signal) return 'closed';
    if (loc.is_spike) return 'spike';
    return 'nominal';
  }

  private getStatusLabel(loc: PizzIntLocation): string {
    if (loc.is_closed_now) return t('components.pizzint.statusClosed');
    if (loc.no_live_signal) return t('components.pizzint.statusNoData');
    if (loc.percentage_of_usual === null) return t('components.pizzint.statusNoBaseline');
    const deviation = Math.round(loc.percentage_of_usual - 100);
    if (loc.is_spike) return `${t('components.pizzint.statusSpike')} +${deviation}%`;
    if (Math.abs(deviation) <= 10) return t('components.pizzint.statusNormal');
    return `${deviation > 0 ? '+' : '−'}${Math.abs(deviation)}% ${t('components.pizzint.vsUsual')}`;
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
