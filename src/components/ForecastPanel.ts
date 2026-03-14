import { Panel } from './Panel';
import { escapeHtml } from '@/services/forecast';
import type { Forecast } from '@/services/forecast';

const DOMAINS = ['all', 'conflict', 'market', 'supply_chain', 'political', 'military', 'infrastructure'] as const;

const DOMAIN_LABELS: Record<string, string> = {
  all: 'All',
  conflict: 'Conflict',
  market: 'Market',
  supply_chain: 'Supply Chain',
  political: 'Political',
  military: 'Military',
  infrastructure: 'Infra',
};

let _styleInjected = false;
function injectStyles(): void {
  if (_styleInjected) return;
  _styleInjected = true;
  const style = document.createElement('style');
  style.textContent = `
    .fc-panel { font-size: 12px; }
    .fc-filters { display: flex; flex-wrap: wrap; gap: 4px; padding: 6px 8px; border-bottom: 1px solid var(--border-color, #333); }
    .fc-filter { background: transparent; border: 1px solid var(--border-color, #444); color: var(--text-secondary, #aaa); padding: 2px 8px; border-radius: 3px; cursor: pointer; font-size: 11px; }
    .fc-filter.fc-active { background: var(--accent-color, #3b82f6); color: #fff; border-color: var(--accent-color, #3b82f6); }
    .fc-list { padding: 4px 0; }
    .fc-card { padding: 6px 10px; border-bottom: 1px solid var(--border-color, #222); }
    .fc-card:hover { background: var(--hover-bg, rgba(255,255,255,0.03)); }
    .fc-header { display: flex; justify-content: space-between; align-items: center; }
    .fc-title { font-weight: 600; color: var(--text-primary, #eee); }
    .fc-prob { font-weight: 700; font-size: 14px; }
    .fc-prob.high { color: #ef4444; }
    .fc-prob.medium { color: #f59e0b; }
    .fc-prob.low { color: #22c55e; }
    .fc-meta { color: var(--text-secondary, #888); font-size: 11px; margin-top: 2px; }
    .fc-trend-rising { color: #ef4444; }
    .fc-trend-falling { color: #22c55e; }
    .fc-trend-stable { color: var(--text-secondary, #888); }
    .fc-signals { margin-top: 4px; }
    .fc-signal { color: var(--text-secondary, #999); font-size: 11px; padding: 1px 0; }
    .fc-signal::before { content: ''; display: inline-block; width: 6px; height: 1px; background: var(--text-secondary, #666); margin-right: 6px; vertical-align: middle; }
    .fc-cascade { font-size: 11px; color: var(--accent-color, #3b82f6); margin-top: 3px; }
    .fc-scenario { font-size: 11px; color: var(--text-primary, #ccc); margin: 4px 0; font-style: italic; }
    .fc-hidden { display: none; }
    .fc-toggle { cursor: pointer; color: var(--text-secondary, #888); font-size: 11px; }
    .fc-toggle:hover { color: var(--text-primary, #eee); }
    .fc-calibration { font-size: 10px; color: var(--text-secondary, #777); margin-top: 2px; }
    .fc-bar { height: 3px; border-radius: 1.5px; margin-top: 3px; background: var(--border-color, #333); }
    .fc-bar-fill { height: 100%; border-radius: 1.5px; }
    .fc-empty { padding: 20px; text-align: center; color: var(--text-secondary, #888); }
    .fc-projections { font-size: 10px; color: var(--text-secondary, #777); margin-top: 3px; font-variant-numeric: tabular-nums; }
    .fc-perspectives { margin-top: 4px; }
    .fc-perspective { font-size: 11px; color: var(--text-secondary, #999); padding: 2px 0; line-height: 1.4; }
    .fc-perspective strong { color: var(--text-primary, #ccc); font-weight: 600; }
  `;
  document.head.appendChild(style);
}

export class ForecastPanel extends Panel {
  private forecasts: Forecast[] = [];
  private activeDomain: string = 'all';

  constructor() {
    super({ id: 'forecast', title: 'AI Forecasts', showCount: true });
    injectStyles();
    this.content.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;

      const filterBtn = target.closest('[data-fc-domain]') as HTMLElement;
      if (filterBtn) {
        this.activeDomain = filterBtn.dataset.fcDomain || 'all';
        this.render();
        return;
      }

      const toggle = target.closest('[data-fc-toggle]') as HTMLElement;
      if (toggle) {
        const details = toggle.nextElementSibling as HTMLElement;
        if (details) details.classList.toggle('fc-hidden');
        return;
      }
    });
  }

  updateForecasts(forecasts: Forecast[]): void {
    this.forecasts = forecasts;
    this.setCount(forecasts.length);
    this.setDataBadge(forecasts.length > 0 ? 'live' : 'unavailable');
    this.render();
  }

  private render(): void {
    if (this.forecasts.length === 0) {
      this.setContent('<div class="fc-empty">No forecasts available</div>');
      return;
    }

    const filtered = this.activeDomain === 'all'
      ? this.forecasts
      : this.forecasts.filter(f => f.domain === this.activeDomain);

    const sorted = [...filtered].sort((a, b) =>
      (b.probability * b.confidence) - (a.probability * a.confidence)
    );

    const filtersHtml = DOMAINS.map(d =>
      `<button class="fc-filter${d === this.activeDomain ? ' fc-active' : ''}" data-fc-domain="${d}">${DOMAIN_LABELS[d]}</button>`
    ).join('');

    const cardsHtml = sorted.map(f => this.renderCard(f)).join('');

    this.setContent(`
      <div class="fc-panel">
        <div class="fc-filters">${filtersHtml}</div>
        <div class="fc-list">${cardsHtml}</div>
      </div>
    `);
  }

  private renderCard(f: Forecast): string {
    const pct = Math.round((f.probability || 0) * 100);
    const probClass = pct > 60 ? 'high' : pct > 35 ? 'medium' : 'low';
    const probColor = pct > 60 ? '#ef4444' : pct > 35 ? '#f59e0b' : '#22c55e';
    const trendIcon = f.trend === 'rising' ? '&#x25B2;' : f.trend === 'falling' ? '&#x25BC;' : '&#x2500;';
    const trendClass = `fc-trend-${f.trend || 'stable'}`;

    const signalsHtml = (f.signals || []).map(s =>
      `<div class="fc-signal">${escapeHtml(s.value)}</div>`
    ).join('');

    const cascadesHtml = (f.cascades || []).length > 0
      ? `<div class="fc-cascade">Cascades: ${f.cascades.map(c => escapeHtml(c.domain)).join(', ')}</div>`
      : '';

    const scenarioHtml = f.scenario
      ? `<div class="fc-scenario">${escapeHtml(f.scenario)}</div>`
      : '';

    const calibrationHtml = f.calibration?.marketTitle
      ? `<div class="fc-calibration">Market: ${escapeHtml(f.calibration.marketTitle)} (${Math.round((f.calibration.marketPrice || 0) * 100)}%)</div>`
      : '';

    const proj = f.projections;
    const projectionsHtml = proj
      ? `<div class="fc-projections">24h: ${Math.round(proj.h24 * 100)}% | 7d: ${Math.round(proj.d7 * 100)}% | 30d: ${Math.round(proj.d30 * 100)}%</div>`
      : '';

    const persp = f.perspectives;
    const perspectivesHtml = persp?.strategic
      ? `<span class="fc-toggle" data-fc-toggle>Perspectives</span>
         <div class="fc-perspectives fc-hidden">
           <div class="fc-perspective"><strong>Strategic:</strong> ${escapeHtml(persp.strategic)}</div>
           <div class="fc-perspective"><strong>Regional:</strong> ${escapeHtml(persp.regional || '')}</div>
           <div class="fc-perspective"><strong>Contrarian:</strong> ${escapeHtml(persp.contrarian || '')}</div>
         </div>`
      : '';

    return `
      <div class="fc-card">
        <div class="fc-header">
          <span class="fc-title"><span class="${trendClass}">${trendIcon}</span> ${escapeHtml(f.title)}</span>
          <span class="fc-prob ${probClass}">${pct}%</span>
        </div>
        <div class="fc-bar"><div class="fc-bar-fill" style="width:${pct}%;background:${probColor}"></div></div>
        ${projectionsHtml}
        <div class="fc-meta">${escapeHtml(f.region)} | ${escapeHtml(f.timeHorizon || '7d')} | <span class="${trendClass}">${f.trend || 'stable'}</span></div>
        ${scenarioHtml}
        ${perspectivesHtml}
        <span class="fc-toggle" data-fc-toggle>Signals (${(f.signals || []).length})</span>
        <div class="fc-signals fc-hidden">${signalsHtml}</div>
        ${cascadesHtml}
        ${calibrationHtml}
      </div>
    `;
  }
}
