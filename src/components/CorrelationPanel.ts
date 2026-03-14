import { Panel } from './Panel';
import type { ConvergenceCard, CorrelationDomain } from '@/services/correlation-engine';
import { h, replaceChildren } from '@/utils/dom-utils';
import { getHydratedData } from '@/services/bootstrap';

let correlationBootstrap: Record<string, ConvergenceCard[]> | null | undefined;
function getCorrelationBootstrap(): Record<string, ConvergenceCard[]> | null {
  if (correlationBootstrap === undefined) {
    correlationBootstrap = (getHydratedData('correlationCards') as Record<string, ConvergenceCard[]>) ?? null;
  }
  return correlationBootstrap;
}

const SCORE_COLORS = {
  critical: '#ff4444',
  high: '#ff8800',
  medium: '#ffcc00',
  low: '#888888',
};

const TREND_ICONS: Record<string, { symbol: string; color: string }> = {
  escalating: { symbol: '\u2191', color: '#ff4444' },
  stable: { symbol: '\u2192', color: '#888888' },
  'de-escalating': { symbol: '\u2193', color: '#44cc44' },
};

export class CorrelationPanel extends Panel {
  private domain: CorrelationDomain;
  private expandedCard: string | null = null;
  private onMapNavigate?: (lat: number, lon: number) => void;
  private boundUpdateHandler: EventListener;
  private hasLiveData = false;

  constructor(id: string, title: string, domain: CorrelationDomain) {
    super({ id, title, showCount: true });
    this.domain = domain;

    const bootstrap = getCorrelationBootstrap();
    const cards = bootstrap?.[domain] ?? null;
    if (cards && cards.length > 0) {
      this.cards = cards;
      this.requestRender();
    } else {
      this.showLoading('Waiting for data...');
    }

    this.boundUpdateHandler = ((e: CustomEvent) => {
      if (e.detail?.domains?.includes(this.domain)) {
        this.requestRender();
      }
    }) as EventListener;
    document.addEventListener('wm:correlation-updated', this.boundUpdateHandler);
  }

  override destroy(): void {
    document.removeEventListener('wm:correlation-updated', this.boundUpdateHandler);
    super.destroy();
  }

  setMapNavigateHandler(handler: (lat: number, lon: number) => void): void {
    this.onMapNavigate = handler;
  }

  private pendingRender = false;
  private requestRender(): void {
    if (this.pendingRender) return;
    this.pendingRender = true;
    requestAnimationFrame(() => {
      this.pendingRender = false;
      this.render();
    });
  }

  private cards: ConvergenceCard[] = [];

  updateCards(cards: ConvergenceCard[]): void {
    this.hasLiveData = true;
    this.cards = cards;
    this.requestRender();
  }

  private render(): void {
    const cards = this.cards;
    this.setCount(cards.length);

    if (cards.length === 0) {
      replaceChildren(this.content, h('div', {
        className: 'correlation-empty',
        style: 'padding:12px;text-align:center;opacity:0.5;font-size:11px;',
      }, 'No active convergence detected'));
      return;
    }

    const cardEls = cards.map(card => this.buildCard(card));
    replaceChildren(this.content, h('div', { className: 'correlation-cards' }, ...cardEls));
  }

  private buildCard(card: ConvergenceCard): HTMLElement {
    const scoreColor = card.score >= 70 ? SCORE_COLORS.critical
      : card.score >= 50 ? SCORE_COLORS.high
      : card.score >= 30 ? SCORE_COLORS.medium
      : SCORE_COLORS.low;

    const trend = TREND_ICONS[card.trend] ?? TREND_ICONS['stable']!;
    const isExpanded = this.expandedCard === card.id;

    const header = h('div', {
      className: 'correlation-card-header',
      style: 'display:flex;align-items:center;gap:6px;cursor:pointer;padding:8px;',
    },
      h('span', {
        style: `display:inline-block;min-width:28px;text-align:center;padding:2px 6px;border-radius:10px;font-size:10px;font-weight:700;color:#fff;background:${scoreColor};`,
      }, String(card.score)),
      h('span', {
        style: 'flex:1;font-size:11px;line-height:1.3;',
      }, card.title),
      h('span', {
        style: 'font-size:9px;opacity:0.6;white-space:nowrap;',
      }, `${card.signals.length} signals`),
      h('span', {
        style: `font-size:12px;color:${trend.color};`,
      }, trend.symbol),
    );

    const detailEl = h('div', {
      className: 'correlation-card-detail',
      style: `display:${isExpanded ? 'block' : 'none'};padding:0 8px 8px;font-size:10px;border-top:1px solid rgba(255,255,255,0.05);`,
    });

    if (isExpanded) {
      this.populateDetail(detailEl, card);
    }

    header.addEventListener('click', () => {
      this.expandedCard = this.expandedCard === card.id ? null : card.id;
      this.render();
    });

    return h('div', {
      className: 'correlation-card',
      style: 'border:1px solid rgba(255,255,255,0.08);border-radius:6px;margin-bottom:4px;background:rgba(255,255,255,0.02);',
    }, header, detailEl);
  }

  private populateDetail(el: HTMLElement, card: ConvergenceCard): void {
    const signalList = card.signals.slice(0, 10).map(s =>
      h('div', { style: 'padding:2px 0;display:flex;gap:6px;align-items:baseline;' },
        h('span', {
          style: 'font-size:8px;padding:1px 4px;border-radius:3px;background:rgba(255,255,255,0.1);white-space:nowrap;',
        }, s.type),
        h('span', { style: 'opacity:0.8;' }, s.label),
      ),
    );

    const children: HTMLElement[] = [
      h('div', { style: 'padding:6px 0;' }, ...signalList),
    ];

    if (card.assessment) {
      children.push(h('div', {
        style: 'padding:6px 8px;margin:4px 0;border-radius:4px;background:rgba(100,150,255,0.08);border-left:2px solid rgba(100,150,255,0.3);font-size:10px;line-height:1.4;',
      }, card.assessment));
    } else if (card.score >= 60 && this.hasLiveData) {
      children.push(h('div', {
        style: 'padding:4px;font-size:9px;opacity:0.4;font-style:italic;',
      }, 'Analyzing...'));
    }

    if (card.location) {
      const mapBtn = h('button', {
        style: 'margin-top:4px;padding:3px 8px;font-size:9px;border:1px solid rgba(255,255,255,0.15);border-radius:3px;background:transparent;color:inherit;cursor:pointer;',
      }, 'View on map');
      mapBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.onMapNavigate?.(card.location!.lat, card.location!.lon);
      });
      children.push(mapBtn);
    }

    replaceChildren(el, ...children);
  }
}
