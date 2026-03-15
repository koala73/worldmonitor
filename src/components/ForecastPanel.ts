import { Panel } from './Panel';
import { escapeHtml } from '@/services/forecast';
import type { Forecast } from '@/services/forecast';
import { t } from '@/services/i18n';

const DOMAINS = ['all', 'conflict', 'market', 'supply_chain', 'political', 'military', 'cyber', 'infrastructure'] as const;

const DOMAIN_LABELS: Record<string, string> = {
  all: 'All',
  conflict: 'Conflict',
  market: 'Market',
  supply_chain: 'Supply Chain',
  political: 'Political',
  military: 'Military',
  cyber: 'Cyber',
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
    .fc-summary { font-size: 11px; color: var(--text-primary, #d7d7d7); margin: 6px 0 4px; line-height: 1.45; }
    .fc-scenario { font-size: 11px; color: var(--text-primary, #ccc); margin: 4px 0; font-style: italic; }
    .fc-hidden { display: none; }
    .fc-toggle-row { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 6px; }
    .fc-toggle { cursor: pointer; color: var(--text-secondary, #888); font-size: 11px; }
    .fc-toggle:hover { color: var(--text-primary, #eee); }
    .fc-calibration { font-size: 10px; color: var(--text-secondary, #777); margin-top: 2px; }
    .fc-bar { height: 3px; border-radius: 1.5px; margin-top: 3px; background: var(--border-color, #333); }
    .fc-bar-fill { height: 100%; border-radius: 1.5px; }
    .fc-empty { padding: 20px; text-align: center; color: var(--text-secondary, #888); }
    .fc-projections { font-size: 10px; color: var(--text-secondary, #777); margin-top: 3px; font-variant-numeric: tabular-nums; }
    .fc-detail { margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--border-color, #2a2a2a); }
    .fc-detail-grid { display: grid; gap: 8px; }
    .fc-section { display: grid; gap: 4px; }
    .fc-section-title { color: var(--text-secondary, #888); font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em; }
    .fc-section-copy { font-size: 11px; color: var(--text-primary, #d3d3d3); line-height: 1.45; }
    .fc-list-block { display: grid; gap: 4px; }
    .fc-list-item { font-size: 11px; color: var(--text-secondary, #a0a0a0); line-height: 1.4; }
    .fc-list-item::before { content: ''; display: inline-block; width: 6px; height: 1px; background: var(--text-secondary, #666); margin-right: 6px; vertical-align: middle; }
    .fc-chip-row { display: flex; flex-wrap: wrap; gap: 6px; }
    .fc-chip { border: 1px solid var(--border-color, #363636); border-radius: 999px; padding: 2px 8px; font-size: 10px; color: var(--text-secondary, #9a9a9a); background: rgba(255,255,255,0.02); }
    .fc-perspectives { margin-top: 2px; }
    .fc-perspective { font-size: 11px; color: var(--text-secondary, #999); padding: 2px 0; line-height: 1.4; }
    .fc-perspective strong { color: var(--text-primary, #ccc); font-weight: 600; }
  `;
  document.head.appendChild(style);
}

export class ForecastPanel extends Panel {
  private forecasts: Forecast[] = [];
  private activeDomain: string = 'all';

  constructor() {
    super({ id: 'forecast', title: 'AI Forecasts', showCount: true, infoTooltip: t('components.forecast.infoTooltip') });
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
        const card = toggle.closest('.fc-card');
        const panelId = toggle.dataset.fcToggle;
        const details = panelId ? card?.querySelector(`[data-fc-panel="${panelId}"]`) as HTMLElement | null : null;
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

    const summaryHtml = (f.feedSummary || f.scenario)
      ? `<div class="fc-summary">${escapeHtml(f.feedSummary || f.scenario)}</div>`
      : '';

    const calibrationHtml = f.calibration?.marketTitle
      ? `<div class="fc-calibration">Market: ${escapeHtml(f.calibration.marketTitle)} (${Math.round((f.calibration.marketPrice || 0) * 100)}%)</div>`
      : '';

    const proj = f.projections;
    const projectionsHtml = proj
      ? `<div class="fc-projections">24h: ${Math.round(proj.h24 * 100)}% | 7d: ${Math.round(proj.d7 * 100)}% | 30d: ${Math.round(proj.d30 * 100)}%</div>`
      : '';

    const detailHtml = this.renderDetail(f);

    return `
      <div class="fc-card">
        <div class="fc-header">
          <span class="fc-title"><span class="${trendClass}">${trendIcon}</span> ${escapeHtml(f.title)}</span>
          <span class="fc-prob ${probClass}">${pct}%</span>
        </div>
        <div class="fc-bar"><div class="fc-bar-fill" style="width:${pct}%;background:${probColor}"></div></div>
        ${projectionsHtml}
        <div class="fc-meta">${escapeHtml(f.region)} | ${escapeHtml(f.timeHorizon || '7d')} | <span class="${trendClass}">${f.trend || 'stable'}</span></div>
        ${summaryHtml}
        <div class="fc-toggle-row">
          <span class="fc-toggle" data-fc-toggle="detail">Analysis</span>
          <span class="fc-toggle" data-fc-toggle="signals">Signals (${(f.signals || []).length})</span>
        </div>
        ${detailHtml}
        <div class="fc-signals fc-hidden" data-fc-panel="signals">${signalsHtml}</div>
        ${cascadesHtml}
        ${calibrationHtml}
      </div>
    `;
  }

  private renderList(items: string[] | undefined): string {
    if (!items || items.length === 0) return '';
    return `<div class="fc-list-block">${items.map(item => `<div class="fc-list-item">${escapeHtml(item)}</div>`).join('')}</div>`;
  }

  private renderEvidence(items: Array<{ summary?: string; weight?: number }> | undefined): string {
    if (!items || items.length === 0) return '';
    return `<div class="fc-list-block">${items.map(item => {
      const suffix = typeof item.weight === 'number' ? ` (${Math.round(item.weight * 100)}%)` : '';
      return `<div class="fc-list-item">${escapeHtml(`${item.summary || ''}${suffix}`.trim())}</div>`;
    }).join('')}</div>`;
  }

  private renderActors(items: Array<{
    name?: string;
    category?: string;
    role?: string;
    objectives?: string[];
    constraints?: string[];
    likelyActions?: string[];
    influenceScore?: number;
  }> | undefined): string {
    if (!items || items.length === 0) return '';
    return `<div class="fc-list-block">${items.map(actor => {
      const chips = [
        actor.category ? actor.category : '',
        typeof actor.influenceScore === 'number' ? `Influence ${Math.round(actor.influenceScore * 100)}%` : '',
      ].filter(Boolean).map(chip => `<span class="fc-chip">${escapeHtml(chip)}</span>`).join('');
      const objective = actor.objectives?.[0] ? `<div class="fc-list-item"><strong>Objective:</strong> ${escapeHtml(actor.objectives[0])}</div>` : '';
      const constraint = actor.constraints?.[0] ? `<div class="fc-list-item"><strong>Constraint:</strong> ${escapeHtml(actor.constraints[0])}</div>` : '';
      const action = actor.likelyActions?.[0] ? `<div class="fc-list-item"><strong>Likely action:</strong> ${escapeHtml(actor.likelyActions[0])}</div>` : '';
      return `
        <div class="fc-section-copy">
          <strong>${escapeHtml(actor.name || 'Actor')}</strong>
          ${chips ? `<div class="fc-chip-row" style="margin-top:4px;">${chips}</div>` : ''}
          ${actor.role ? `<div class="fc-list-item">${escapeHtml(actor.role)}</div>` : ''}
          ${objective}
          ${constraint}
          ${action}
        </div>
      `;
    }).join('')}</div>`;
  }

  private renderBranches(items: Array<{
    kind?: string;
    title?: string;
    summary?: string;
    outcome?: string;
    projectedProbability?: number;
    rounds?: Array<{ round?: number; focus?: string; developments?: string[]; actorMoves?: string[] }>;
  }> | undefined): string {
    if (!items || items.length === 0) return '';
    return `<div class="fc-list-block">${items.map(branch => {
      const projected = typeof branch.projectedProbability === 'number'
        ? `<span class="fc-chip">Projected ${Math.round(branch.projectedProbability * 100)}%</span>`
        : '';
      const rounds = (branch.rounds || []).slice(0, 3).map(round => {
        const developments = (round.developments || []).slice(0, 2).join(' ');
        const actorMoves = (round.actorMoves || []).slice(0, 1).join(' ');
        const copy = [developments, actorMoves].filter(Boolean).join(' ');
        return `<div class="fc-list-item"><strong>R${round.round || 0}:</strong> ${escapeHtml(copy || round.focus || '')}</div>`;
      }).join('');
      return `
        <div class="fc-section-copy">
          <strong>${escapeHtml(branch.title || branch.kind || 'Branch')}</strong>
          <div class="fc-chip-row" style="margin-top:4px;">${projected}</div>
          ${branch.summary ? `<div class="fc-list-item">${escapeHtml(branch.summary)}</div>` : ''}
          ${branch.outcome ? `<div class="fc-list-item"><strong>Outcome:</strong> ${escapeHtml(branch.outcome)}</div>` : ''}
          ${rounds}
        </div>
      `;
    }).join('')}</div>`;
  }

  private renderDetail(f: Forecast): string {
    const caseFile = f.caseFile;
    const sections: string[] = [];

    if (f.scenario) {
      sections.push(`
        <div class="fc-section">
          <div class="fc-section-title">Executive View</div>
          <div class="fc-section-copy fc-scenario">${escapeHtml(f.scenario)}</div>
        </div>
      `);
    }

    if (caseFile?.baseCase) {
      sections.push(`
        <div class="fc-section">
          <div class="fc-section-title">Base Case</div>
          <div class="fc-section-copy">${escapeHtml(caseFile.baseCase)}</div>
        </div>
      `);
    }

    if (caseFile?.changeSummary || caseFile?.changeItems?.length) {
      sections.push(`
        <div class="fc-section">
          <div class="fc-section-title">What Changed</div>
          ${caseFile?.changeSummary ? `<div class="fc-section-copy">${escapeHtml(caseFile.changeSummary)}</div>` : ''}
          ${caseFile?.changeItems?.length ? this.renderList(caseFile.changeItems) : ''}
        </div>
      `);
    }

    if (caseFile?.worldState?.summary || caseFile?.worldState?.activePressures?.length || caseFile?.worldState?.stabilizers?.length || caseFile?.worldState?.keyUnknowns?.length) {
      sections.push(`
        <div class="fc-section">
          <div class="fc-section-title">World State</div>
          ${caseFile?.worldState?.summary ? `<div class="fc-section-copy">${escapeHtml(caseFile.worldState.summary)}</div>` : ''}
          ${caseFile?.worldState?.activePressures?.length ? `<div class="fc-section-copy"><strong>Pressures:</strong></div>${this.renderList(caseFile.worldState.activePressures)}` : ''}
          ${caseFile?.worldState?.stabilizers?.length ? `<div class="fc-section-copy"><strong>Stabilizers:</strong></div>${this.renderList(caseFile.worldState.stabilizers)}` : ''}
          ${caseFile?.worldState?.keyUnknowns?.length ? `<div class="fc-section-copy"><strong>Key unknowns:</strong></div>${this.renderList(caseFile.worldState.keyUnknowns)}` : ''}
        </div>
      `);
    }

    if (caseFile?.escalatoryCase || caseFile?.contrarianCase) {
      sections.push(`
        <div class="fc-section">
          <div class="fc-section-title">Alternative Paths</div>
          ${caseFile?.escalatoryCase ? `<div class="fc-section-copy"><strong>Escalatory:</strong> ${escapeHtml(caseFile.escalatoryCase)}</div>` : ''}
          ${caseFile?.contrarianCase ? `<div class="fc-section-copy"><strong>Contrarian:</strong> ${escapeHtml(caseFile.contrarianCase)}</div>` : ''}
        </div>
      `);
    }

    if (caseFile?.branches?.length) {
      sections.push(`
        <div class="fc-section">
          <div class="fc-section-title">Simulated Branches</div>
          ${this.renderBranches(caseFile.branches)}
        </div>
      `);
    }

    if (caseFile?.supportingEvidence?.length) {
      sections.push(`
        <div class="fc-section">
          <div class="fc-section-title">Supporting Evidence</div>
          ${this.renderEvidence(caseFile.supportingEvidence)}
        </div>
      `);
    }

    if (caseFile?.counterEvidence?.length) {
      sections.push(`
        <div class="fc-section">
          <div class="fc-section-title">Counter Evidence</div>
          ${this.renderEvidence(caseFile.counterEvidence)}
        </div>
      `);
    }

    if (caseFile?.triggers?.length) {
      sections.push(`
        <div class="fc-section">
          <div class="fc-section-title">Signals To Watch</div>
          ${this.renderList(caseFile.triggers)}
        </div>
      `);
    }

    if (caseFile?.actors?.length) {
      sections.push(`
        <div class="fc-section">
          <div class="fc-section-title">Actors</div>
          ${this.renderActors(caseFile.actors)}
        </div>
      `);
    } else if (caseFile?.actorLenses?.length) {
      sections.push(`
        <div class="fc-section">
          <div class="fc-section-title">Actor Lenses</div>
          ${this.renderList(caseFile.actorLenses)}
        </div>
      `);
    }

    if (f.perspectives?.strategic) {
      sections.push(`
        <div class="fc-section">
          <div class="fc-section-title">Perspectives</div>
          <div class="fc-perspectives">
            <div class="fc-perspective"><strong>Strategic:</strong> ${escapeHtml(f.perspectives.strategic)}</div>
            <div class="fc-perspective"><strong>Regional:</strong> ${escapeHtml(f.perspectives.regional || '')}</div>
            <div class="fc-perspective"><strong>Contrarian:</strong> ${escapeHtml(f.perspectives.contrarian || '')}</div>
          </div>
        </div>
      `);
    }

    const chips = [
      f.calibration?.marketTitle ? `Market: ${f.calibration.marketTitle}` : '',
      typeof f.priorProbability === 'number' ? `Prior: ${Math.round(f.priorProbability * 100)}%` : '',
      f.cascades?.length ? `Cascades: ${f.cascades.length}` : '',
    ].filter(Boolean);

    const chipHtml = chips.length > 0
      ? `<div class="fc-section"><div class="fc-section-title">Context</div><div class="fc-chip-row">${chips.map(chip => `<span class="fc-chip">${escapeHtml(chip)}</span>`).join('')}</div></div>`
      : '';

    return `
      <div class="fc-detail fc-hidden" data-fc-panel="detail">
        <div class="fc-detail-grid">
          ${sections.join('')}
          ${chipHtml}
        </div>
      </div>
    `;
  }
}
