import { Panel } from './Panel';
import { t } from '@/services/i18n';
import type { ConvergenceCard, CorrelationDomain } from '@/services/correlation-engine';
import { h, replaceChildren } from '@/utils/dom-utils';
import { readableTextColor } from '@/utils/contrast';
import {
  publishLocalCorrelationCards,
  subscribeCorrelationSnapshot,
  type CorrelationSnapshotState,
} from '@/services/correlation-snapshots';
import { describeFreshness } from '@/services/persistent-cache';
import { hasPremiumAccess } from '@/services/panel-gating';

// Score-badge BACKGROUND colors. Badge text color is chosen per-background via
// readableTextColor() so it clears WCAG AA on each: white on the dark `low`
// badge, dark text on the light/mid critical/high/medium hues (white was 3.41 /
// 2.39 / 1.51 on those). `low` was also darkened #888888 → #6f6f6f. (#4418/#4421)
const SCORE_COLORS = {
  critical: '#ff4444',
  high: '#ff8800',
  medium: '#ffcc00',
  low: '#6f6f6f',
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
  private snapshotState: CorrelationSnapshotState = { status: 'loading', snapshot: null, offline: false };
  private stopSnapshots?: () => void;
  private correlationDestroyed = false;
  private assessmentHandler?: (cards: ConvergenceCard[]) => void;
  private assessedCards?: ConvergenceCard[];
  private renderedCards?: ConvergenceCard[];
  private renderedOrigin?: 'seed' | 'local';

  constructor(id: string, title: string, domain: CorrelationDomain, infoTooltip?: string) {
    super({ id, title, showCount: true, infoTooltip });
    this.domain = domain;

    this.requestRender();
    this.observeNearViewport(() => {
      if (this.correlationDestroyed) return;
      this.stopSnapshots = subscribeCorrelationSnapshot(this.domain, state => {
        this.snapshotState = state;
        this.requestAssessments();
        this.requestRender(false);
      });
    }, 400);

    this.boundUpdateHandler = ((e: CustomEvent) => {
      if (e.detail?.assessmentUpdate && e.detail?.domains?.includes(this.domain)) {
        this.requestRender();
      }
    }) as EventListener;
    document.addEventListener('wm:correlation-updated', this.boundUpdateHandler);
  }

  override destroy(): void {
    this.correlationDestroyed = true;
    this.assessmentHandler?.([]);
    this.stopSnapshots?.();
    document.removeEventListener('wm:correlation-updated', this.boundUpdateHandler);
    super.destroy();
  }

  setMapNavigateHandler(handler: (lat: number, lon: number) => void): void {
    this.onMapNavigate = handler;
  }

  setAssessmentHandler(handler: (cards: ConvergenceCard[]) => void): void {
    this.assessmentHandler = handler;
    this.assessedCards = undefined;
    this.requestAssessments();
    this.requestRender();
  }

  private requestAssessments(): void {
    const cards = this.snapshotState.snapshot?.cards;
    if (!this.assessmentHandler || cards === this.assessedCards) return;
    this.assessedCards = cards;
    this.assessmentHandler(cards ?? []);
  }

  protected navigateToMap(lat: number, lon: number): void {
    this.onMapNavigate?.(lat, lon);
  }

  protected renderSupplement(): HTMLElement | null {
    return null;
  }

  private pendingRender = false;
  private forceRender = false;
  /** Schedule a safe redraw for subclasses that install deferred panel data. */
  protected requestRender(force = true): void {
    this.forceRender ||= force;
    if (this.correlationDestroyed || this.pendingRender) return;
    this.pendingRender = true;
    requestAnimationFrame(() => {
      this.pendingRender = false;
      if (this.correlationDestroyed) return;
      const force = this.forceRender;
      this.forceRender = false;
      this.render(force);
    });
  }

  updateCards(cards: ConvergenceCard[]): void {
    if (!this.correlationDestroyed) publishLocalCorrelationCards(this.domain, cards);
  }

  private render(force = true): void {
    if (this.correlationDestroyed) return;
    const cards = this.snapshotState.snapshot?.cards ?? [];
    this.setCount(cards.length);
    if (this.countEl) this.countEl.hidden = this.snapshotState.snapshot === null;
    const { snapshot, status, offline } = this.snapshotState;
    const notice = h('div', {
      className: 'correlation-status',
      role: 'status',
      style: 'padding:8px;opacity:0.7;font-size:calc(10px * var(--wm-panel-effective-scale, 1));line-height:1.5;',
    }, snapshot
      ? t(`components.correlation.${offline ? 'savedOffline' : status === 'updating' ? 'saved' : 'updated'}`, {
        time: describeFreshness(snapshot.computedAt),
      })
      : t(`components.correlation.${offline ? 'offline' : status === 'loading' ? 'loading' : 'waiting'}`),
    ...(snapshot?.origin === 'local' ? [h('div', {}, t('components.correlation.localSignals'))] : []));

    const emptyText = t(`components.correlation.${status === 'updating' ? 'emptySaved' : 'empty'}`);
    const previousNotice = this.content.querySelector('.correlation-status');
    if (!force && !this.isLocked && previousNotice
      && this.renderedCards === snapshot?.cards && this.renderedOrigin === snapshot?.origin) {
      // Updating age/connectivity must not replace focused controls or reset scrolling.
      previousNotice.replaceChildren(...notice.childNodes);
      const empty = this.content.querySelector('.correlation-empty');
      if (empty) empty.textContent = emptyText;
      return;
    }
    this.renderedCards = snapshot?.cards;
    this.renderedOrigin = snapshot?.origin;
    const supplement = this.renderSupplement();

    if (!snapshot) {
      this.setContentNodes(...(supplement ? [supplement] : []), notice);
      return;
    }

    if (cards.length === 0) {
      const empty = h('div', {
        className: 'correlation-empty',
        style: 'padding:12px;text-align:center;opacity:0.5;font-size:calc(11px * var(--wm-panel-effective-scale, 1));',
      }, emptyText);
      // #6557: a settled empty state is authoritative content.
      this.setContentNodes(...(supplement ? [supplement] : []), notice, empty);
      return;
    }

    const cardEls = cards.map(card => this.buildCard(card));
    // #6557: success render with data — route through the sanctioned helper.
    this.setContentNodes(
      ...(supplement ? [supplement] : []),
      notice,
      h('div', { className: 'correlation-cards' }, ...cardEls),
    );
  }

  private buildCard(card: ConvergenceCard): HTMLElement {
    const scoreColor = card.score >= 70 ? SCORE_COLORS.critical
      : card.score >= 50 ? SCORE_COLORS.high
      : card.score >= 30 ? SCORE_COLORS.medium
      : SCORE_COLORS.low;

    const trend = TREND_ICONS[card.trend] ?? TREND_ICONS.stable!;
    const isExpanded = this.expandedCard === card.id;

    const header = h('div', {
      className: 'correlation-card-header',
      style: 'display:flex;align-items:center;gap:6px;cursor:pointer;padding:8px;',
    },
      h('span', {
        style: `display:inline-block;min-width:28px;text-align:center;padding:2px 6px;border-radius:10px;font-size:calc(10px * var(--wm-panel-effective-scale, 1));font-weight:700;color:${readableTextColor(scoreColor)};background:${scoreColor};`,
      }, String(card.score)),
      h('span', {
        style: 'flex:1;font-size:calc(11px * var(--wm-panel-effective-scale, 1));line-height:1.3;',
      }, card.title),
      h('span', {
        style: 'font-size:calc(9px * var(--wm-panel-effective-scale, 1));opacity:0.6;white-space:nowrap;',
      }, t('components.correlation.signals', { count: card.signals.length })),
      h('span', {
        style: `font-size:calc(12px * var(--wm-panel-effective-scale, 1));color:${trend.color};`,
      }, trend.symbol),
    );

    const detailEl = h('div', {
      className: 'correlation-card-detail',
      style: `display:${isExpanded ? 'block' : 'none'};padding:0 8px 8px;font-size:calc(10px * var(--wm-panel-effective-scale, 1));border-top:1px solid rgba(255,255,255,0.05);`,
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
          style: 'font-size:calc(8px * var(--wm-panel-effective-scale, 1));padding:1px 4px;border-radius:3px;background:rgba(255,255,255,0.1);white-space:nowrap;',
        }, s.type),
        h('span', { style: 'opacity:0.8;' }, s.label),
      ),
    );

    const children: HTMLElement[] = [
      h('div', { style: 'padding:6px 0;' }, ...signalList),
    ];

    if (card.assessment && hasPremiumAccess()) {
      children.push(h('div', {
        style: 'padding:6px 8px;margin:4px 0;border-radius:4px;background:rgba(100,150,255,0.08);border-left:2px solid rgba(100,150,255,0.3);font-size:calc(10px * var(--wm-panel-effective-scale, 1));line-height:1.4;',
      }, card.assessment));
    } else if (card.score >= 60 && this.assessmentHandler && hasPremiumAccess()) {
      children.push(h('div', {
        style: 'padding:4px;font-size:calc(9px * var(--wm-panel-effective-scale, 1));opacity:0.4;font-style:italic;',
      }, t('components.correlation.analyzing')));
    }

    if (card.location) {
      const mapBtn = h('button', {
        style: 'margin-top:4px;padding:3px 8px;font-size:calc(9px * var(--wm-panel-effective-scale, 1));border:1px solid rgba(255,255,255,0.15);border-radius:3px;background:transparent;color:inherit;cursor:pointer;',
      }, t('components.correlation.viewOnMap'));
      mapBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.navigateToMap(card.location!.lat, card.location!.lon);
      });
      children.push(mapBtn);
    }

    replaceChildren(el, ...children);
  }
}
