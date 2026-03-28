import { Panel } from './Panel';
import { escapeHtml } from '@/services/forecast';
import type { Forecast } from '@/services/forecast';
import { t } from '@/services/i18n';

const DOMAINS = ['all', 'conflict', 'market', 'supply_chain', 'political', 'military', 'cyber', 'infrastructure'] as const;
const PANEL_MIN_PROBABILITY = 0.1;

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

const DOMAIN_COLORS: Record<string, string> = {
  conflict:       '#e05252',
  market:         '#d29922',
  supply_chain:   '#58a6ff',
  political:      '#bc8cff',
  military:       '#f85149',
  cyber:          '#bc8cff',
  infrastructure: '#3fb950',
};

// Derived from stateKind — maps to a domain color bucket for the theater card accent
const STATE_KIND_DOMAIN: Record<string, string> = {
  supply_chain_disruption: 'supply_chain',
  freight_disruption:      'supply_chain',
  energy_disruption:       'market',
  energy_price_shock:      'market',
  military_posture:        'military',
  conflict_escalation:     'conflict',
};

// --- Types for simulation theater data -------------------------------------
const PATH_ID_LABELS: Record<string, string> = {
  escalation:     'Escalation',
  containment:    'Containment',
  market_cascade: 'Market Cascade',
};

interface SimulationPath {
  pathId: string;
  label: string;
  summary: string;
  confidence: number;
  keyActors: string[];
}

interface SimulationTheater {
  theaterId: string;
  theaterLabel: string;
  stateKind: string;
  topPaths: SimulationPath[];
  dominantReactions: string[];
  stabilizers: string[];
  invalidators: string[];
}

function parseTheaters(json: string): SimulationTheater[] {
  try {
    const arr = JSON.parse(json);
    if (!Array.isArray(arr)) return [];
    return arr.filter(
      (v): v is SimulationTheater =>
        v && typeof v === 'object' && typeof v.theaterId === 'string' && typeof v.theaterLabel === 'string',
    );
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------

let _styleInjected = false;
function injectStyles(): void {
  if (_styleInjected) return;
  _styleInjected = true;
  const style = document.createElement('style');
  style.textContent = `
    .fc-panel { font-size: 12px; }
    .fc-filters { display: flex; flex-wrap: wrap; gap: 4px; padding: 6px 8px; border-bottom: 1px solid var(--border-color, #333); }
    .fc-filter { background: transparent; border: 1px solid var(--border-color, #444); color: var(--text-secondary, #aaa); padding: 2px 8px; border-radius: 3px; cursor: pointer; font-size: 11px; font-family: inherit; }
    .fc-filter.fc-active { background: var(--accent-color, #3b82f6); color: #fff; border-color: var(--accent-color, #3b82f6); }

    /* ── NEXUS: theater grid ─────────────────────────────────────────────── */
    .fc-nexus { padding: 8px; }
    .fc-theater-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 8px; margin-bottom: 10px; }
    .fc-theater-card {
      background: var(--panel-bg, #161b22);
      border: 1px solid var(--border-color, #30363d);
      border-radius: 8px;
      padding: 18px 16px;
      cursor: pointer;
      transition: all 0.2s;
      position: relative;
      overflow: hidden;
    }
    .fc-theater-card::before {
      content: '';
      position: absolute;
      top: 0; left: 0; right: 0;
      height: 2px;
      background: var(--fc-theater-color, #58a6ff);
    }
    .fc-theater-card:hover { border-color: #40464f; transform: translateY(-1px); }
    .fc-theater-card.fc-theater-selected { border-color: var(--accent-color, #58a6ff); background: rgba(88,166,255,0.04); }
    .fc-theater-top { display: flex; align-items: flex-start; justify-content: space-between; margin-bottom: 10px; }
    .fc-theater-name { font-size: 11px; font-weight: 700; line-height: 1.3; color: var(--text-primary, #e6edf3); flex: 1; padding-right: 8px; }
    .fc-gauge-wrap { position: relative; width: 38px; height: 38px; flex-shrink: 0; }
    .fc-gauge-svg { width: 38px; height: 38px; transform: rotate(-90deg); }
    .fc-gauge-bg { fill: none; stroke: var(--border-color, #30363d); stroke-width: 4; }
    .fc-gauge-fill { fill: none; stroke-width: 4; stroke-linecap: round; }
    .fc-gauge-label { position: absolute; top: 50%; left: 50%; transform: translate(-50%,-50%); font-size: 9px; font-weight: 700; }
    .fc-theater-path { font-size: 9px; color: var(--text-secondary, #7d8590); line-height: 1.4; margin-top: 4px; display: flex; align-items: center; gap: 4px; flex-wrap: wrap; }
    .fc-path-type { font-size: 8px; padding: 1px 4px; border-radius: 2px; font-weight: 600; letter-spacing: 0.03em; opacity: 0.75; white-space: nowrap; }
    .fc-path-type-escalation    { background: rgba(224,82,82,0.2); color: #e05252; border: 1px solid rgba(224,82,82,0.3); }
    .fc-path-type-containment   { background: rgba(63,185,80,0.15); color: #3fb950; border: 1px solid rgba(63,185,80,0.25); }
    .fc-path-type-market_cascade { background: rgba(210,153,34,0.15); color: #d29922; border: 1px solid rgba(210,153,34,0.25); }
    .fc-cat-tag {
      font-size: 9px; padding: 1px 5px; border-radius: 3px; white-space: nowrap;
      flex-shrink: 0; font-weight: 500; display: inline-block;
    }

    /* ── NEXUS: expanded theater detail ─────────────────────────────────── */
    .fc-theater-detail {
      background: var(--panel-bg, #161b22);
      border: 1px solid var(--border-color, #30363d);
      border-radius: 5px;
      margin-bottom: 10px;
      overflow: hidden;
    }
    .fc-theater-detail-hdr { padding: 10px 12px; border-bottom: 1px solid var(--border-color, #30363d); display: flex; align-items: center; gap: 8px; }
    .fc-theater-detail-name { font-size: 12px; font-weight: 700; color: var(--text-primary, #e6edf3); }
    .fc-theater-paths { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; padding: 10px 12px; }
    @media (max-width: 480px) { .fc-theater-paths { grid-template-columns: 1fr; } }
    .fc-path-card { background: rgba(0,0,0,0.25); border: 1px solid var(--border-color, #30363d); border-radius: 4px; padding: 9px 10px; }
    .fc-path-label { font-size: 10px; font-weight: 700; color: var(--text-primary, #e6edf3); margin-bottom: 2px; }
    .fc-path-conf { font-size: 9px; color: var(--text-secondary, #7d8590); margin-bottom: 5px; }
    .fc-path-bar { height: 2px; border-radius: 1px; margin: 4px 0; }
    .fc-path-summary { font-size: 10px; color: var(--text-secondary, #7d8590); line-height: 1.5; }
    .fc-path-actors { display: flex; flex-wrap: wrap; gap: 3px; margin-top: 5px; }
    .fc-actor-chip { font-size: 9px; padding: 1px 5px; border: 1px solid var(--border-color, #30363d); border-radius: 2px; color: var(--text-secondary, #7d8590); background: rgba(255,255,255,0.02); }
    .fc-theater-footer { padding: 8px 12px; border-top: 1px solid var(--border-color, #30363d); display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 8px; }
    .fc-theater-footer-section { }
    .fc-footer-title { font-size: 9px; color: var(--text-secondary, #7d8590); text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 5px; }
    .fc-footer-item { font-size: 9px; color: var(--text-secondary, #7d8590); padding: 2px 0; line-height: 1.4; }
    .fc-footer-item::before { content: '›'; margin-right: 4px; }
    .fc-stab-item::before { color: #3fb950; }
    .fc-inval-item::before { color: #e05252; }
    .fc-react-item::before { color: #58a6ff; }

    /* ── Section label ───────────────────────────────────────────────────── */
    .fc-section-label { font-size: 9px; text-transform: uppercase; letter-spacing: 0.1em; color: var(--text-secondary, #7d8590); padding: 6px 8px 4px; }

    /* ── Forecast probability table ──────────────────────────────────────── */
    .fc-prob-table { border: 1px solid var(--border-color, #30363d); border-radius: 4px; overflow: hidden; margin: 0 8px 8px; }
    .fc-prob-hdr { display: grid; grid-template-columns: 1fr 80px 100px 60px; padding: 8px 14px; border-bottom: 1px solid var(--border-color, #30363d); }
    .fc-prob-hdr span { font-size: 9px; color: var(--text-secondary, #7d8590); text-transform: uppercase; letter-spacing: 0.08em; }
    .fc-prob-item { border-bottom: 1px solid var(--border-color, #30363d); }
    .fc-prob-item:last-child { border-bottom: none; }
    .fc-prob-row { display: grid; grid-template-columns: 1fr 80px 100px 60px; align-items: center; padding: 9px 14px; cursor: pointer; transition: background 0.1s; }
    .fc-prob-item:hover .fc-prob-row { background: rgba(255,255,255,0.02); }
    .fc-prob-label { font-size: 10px; color: var(--text-secondary, #7d8590); line-height: 1.4; }
    .fc-bar-wrap { display: flex; align-items: center; gap: 8px; }
    .fc-prob-bar-track { flex: 1; height: 4px; background: var(--border-color, #30363d); border-radius: 2px; overflow: hidden; min-width: 40px; }
    .fc-prob-bar-fill { height: 100%; border-radius: 2px; }
    .fc-prob-pct { font-size: 11px; font-weight: 700; min-width: 30px; text-align: right; }
    .fc-trend-text { font-size: 10px; }
    .fc-domain-tag { font-size: 9px; padding: 2px 6px; border-radius: 3px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

    /* ── Detail toggle (hidden by default; shown on item hover) ──────────── */
    .fc-hidden { display: none; }
    .fc-toggle-row { display: none; flex-wrap: wrap; gap: 8px; padding: 0 14px 8px; }
    .fc-prob-item:hover .fc-toggle-row { display: flex; }
    .fc-toggle { cursor: pointer; color: var(--text-secondary, #7d8590); font-size: 11px; }
    .fc-toggle:hover { color: var(--text-primary, #e6edf3); }
    .fc-detail { padding: 8px 14px 4px; border-top: 1px solid var(--border-color, #2a2a2a); }
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
    .fc-scenario { font-style: italic; }
    .fc-signals { padding: 8px 14px 4px; border-top: 1px solid var(--border-color, #2a2a2a); display: grid; gap: 2px; }
    .fc-signals-title { color: var(--text-secondary, #888); font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: 4px; }
    .fc-signal { color: var(--text-secondary, #a0a0a0); font-size: 11px; padding: 3px 0 3px 12px; line-height: 1.45; position: relative; }
    .fc-signal::before { content: ''; position: absolute; left: 0; top: 9px; display: inline-block; width: 6px; height: 1px; background: var(--text-secondary, #555); }
    .fc-empty { padding: 20px; text-align: center; color: var(--text-secondary, #888); }
  `;
  document.head.appendChild(style);
}

export class ForecastPanel extends Panel {
  private forecasts: Forecast[] = [];
  private activeDomain: string = 'all';
  private theaters: SimulationTheater[] = [];
  private expandedTheaterId: string | null = null;

  constructor() {
    super({ id: 'forecast', title: 'AI Forecasts', showCount: true, infoTooltip: t('components.forecast.infoTooltip') });
    injectStyles();
    this.content.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;

      const filterBtn = target.closest('[data-fc-domain]') as HTMLElement | null;
      if (filterBtn) {
        this.activeDomain = filterBtn.dataset.fcDomain || 'all';
        this.render();
        return;
      }

      const theaterBtn = target.closest('[data-fc-theater]') as HTMLElement | null;
      if (theaterBtn) {
        const tid = theaterBtn.dataset.fcTheater || null;
        this.expandedTheaterId = this.expandedTheaterId === tid ? null : tid;
        this.render();
        return;
      }

      const toggle = target.closest('[data-fc-toggle]') as HTMLElement | null;
      if (toggle) {
        const item = toggle.closest('.fc-prob-item');
        const panelId = toggle.dataset.fcToggle;
        const detail = panelId ? item?.querySelector(`[data-fc-panel="${panelId}"]`) as HTMLElement | null : null;
        if (detail) detail.classList.toggle('fc-hidden');
        return;
      }

      // Touch/click on the prob row itself: show the toggle row so Analysis is reachable on touch devices
      const probRow = target.closest('.fc-prob-row') as HTMLElement | null;
      if (probRow) {
        const item = probRow.closest('.fc-prob-item') as HTMLElement | null;
        const toggleRow = item?.querySelector('.fc-toggle-row') as HTMLElement | null;
        if (toggleRow) toggleRow.style.display = toggleRow.style.display === 'flex' ? '' : 'flex';
        return;
      }
    });
  }

  updateForecasts(forecasts: Forecast[]): void {
    this.forecasts = forecasts;
    const visible = this.getVisibleForecasts();
    this.setCount(visible.length);
    this.setDataBadge(visible.length > 0 ? 'live' : 'unavailable');
    this.render();
  }

  updateSimulation(theaterSummariesJson: string): void {
    this.theaters = parseTheaters(theaterSummariesJson);
    // Only re-render if forecasts are already loaded — prevents a flash of "No forecasts available"
    // when the simulation RPC resolves before the forecast RPC. updateForecasts will trigger
    // the combined render when it arrives.
    if (this.forecasts.length > 0) this.render();
  }

  private getVisibleForecasts(): Forecast[] {
    return this.forecasts.filter(f => (f.probability || 0) >= PANEL_MIN_PROBABILITY);
  }

  private render(): void {
    const visibleForecasts = this.getVisibleForecasts();
    if (visibleForecasts.length === 0) {
      this.setContent('<div class="fc-empty">No forecasts available</div>');
      return;
    }

    const filtered = this.activeDomain === 'all'
      ? visibleForecasts
      : visibleForecasts.filter(f => f.domain === this.activeDomain);

    const filtersHtml = DOMAINS.map(d =>
      `<button class="fc-filter${d === this.activeDomain ? ' fc-active' : ''}" data-fc-domain="${d}">${DOMAIN_LABELS[d]}</button>`
    ).join('');

    const nexusHtml = this.theaters.length > 0
      ? `<div class="fc-nexus">${this.renderNexus()}</div><div class="fc-section-label">Probability Bets</div>`
      : '';
    const tableHtml = this.renderProbTable(filtered);

    this.setContent(`
      <div class="fc-panel">
        <div class="fc-filters">${filtersHtml}</div>
        ${nexusHtml}
        ${tableHtml}
      </div>
    `);
  }

  // ── NEXUS theater grid + expandable detail ──────────────────────────────

  private renderNexus(): string {
    const cards = this.theaters.map(t => this.renderTheaterCard(t)).join('');
    const detail = this.expandedTheaterId
      ? this.renderTheaterDetail(this.theaters.find(t => t.theaterId === this.expandedTheaterId) ?? null)
      : '';
    return `
      <div class="fc-section-label" style="padding-top:4px">Active Theaters</div>
      <div class="fc-theater-grid">${cards}</div>
      ${detail}
    `;
  }

  private renderTheaterCard(t: SimulationTheater): string {
    const domain = STATE_KIND_DOMAIN[t.stateKind] || 'supply_chain';
    const color = DOMAIN_COLORS[domain] || '#58a6ff';
    const catLabel = DOMAIN_LABELS[domain] || domain;
    const dominantPath = t.topPaths[0];
    const conf = dominantPath?.confidence ?? 0;
    const confPct = Math.round(conf * 100);
    const confColor = conf >= 0.65 ? '#3fb950' : conf >= 0.45 ? '#d29922' : '#e05252';
    const isSelected = this.expandedTheaterId === t.theaterId;

    // SVG gauge: circumference for r=15 is 94.25; stroke-dashoffset = circ * (1 - conf)
    const r = 15;
    const circ = 2 * Math.PI * r;
    const offset = circ * (1 - conf);

    return `
      <div class="fc-theater-card${isSelected ? ' fc-theater-selected' : ''}"
           style="--fc-theater-color:${color}"
           data-fc-theater="${escapeHtml(t.theaterId)}">
        <div class="fc-theater-top">
          <div class="fc-theater-name">${escapeHtml(t.theaterLabel)}</div>
          <div class="fc-gauge-wrap">
            <svg class="fc-gauge-svg" viewBox="0 0 34 34">
              <circle class="fc-gauge-bg" cx="17" cy="17" r="${r}"/>
              <circle class="fc-gauge-fill" cx="17" cy="17" r="${r}"
                stroke="${confColor}"
                stroke-dasharray="${circ.toFixed(1)}"
                stroke-dashoffset="${offset.toFixed(1)}"/>
            </svg>
            <span class="fc-gauge-label" style="color:${confColor}">${conf > 0 ? confPct + '%' : '—'}</span>
          </div>
        </div>
        <span class="fc-cat-tag" style="background:${color}1f;color:${color};border:1px solid ${color}47">${escapeHtml(catLabel)}</span>
        ${dominantPath ? `<div class="fc-theater-path">${dominantPath.pathId ? `<span class="fc-path-type fc-path-type-${escapeHtml(dominantPath.pathId)}">${escapeHtml(PATH_ID_LABELS[dominantPath.pathId] ?? dominantPath.pathId)}</span>` : ''}${escapeHtml(dominantPath.label)}</div>` : ''}
      </div>
    `;
  }

  private renderTheaterDetail(t: SimulationTheater | null): string {
    if (!t) return '';
    const domain = STATE_KIND_DOMAIN[t.stateKind] || 'supply_chain';
    const color = DOMAIN_COLORS[domain] || '#58a6ff';
    const catLabel = DOMAIN_LABELS[domain] || domain;

    const pathsHtml = t.topPaths.map(p => {
      const pctColor = p.confidence >= 0.65 ? '#3fb950' : p.confidence >= 0.45 ? '#d29922' : '#e05252';
      const actors = p.keyActors.map(a => `<span class="fc-actor-chip">${escapeHtml(a)}</span>`).join('');
      const typeTag = p.pathId ? `<span class="fc-path-type fc-path-type-${escapeHtml(p.pathId)}">${escapeHtml(PATH_ID_LABELS[p.pathId] ?? p.pathId)}</span>` : '';
      const confText = p.confidence > 0 ? `${Math.round(p.confidence * 100)}% probability` : '—';
      return `
        <div class="fc-path-card">
          <div class="fc-path-label">${typeTag}${escapeHtml(p.label)}</div>
          <div class="fc-path-conf">${confText}</div>
          <div class="fc-path-bar" style="background:${pctColor};width:${Math.round(p.confidence * 100)}%"></div>
          <div class="fc-path-summary">${escapeHtml(p.summary)}</div>
          ${actors ? `<div class="fc-path-actors">${actors}</div>` : ''}
        </div>
      `;
    }).join('');

    const reactions = t.dominantReactions.map(r =>
      `<div class="fc-footer-item fc-react-item">${escapeHtml(r)}</div>`
    ).join('');
    const stabilizers = t.stabilizers.map(s =>
      `<div class="fc-footer-item fc-stab-item">${escapeHtml(s)}</div>`
    ).join('');
    const invalidators = t.invalidators.map(s =>
      `<div class="fc-footer-item fc-inval-item">${escapeHtml(s)}</div>`
    ).join('');

    return `
      <div class="fc-theater-detail">
        <div class="fc-theater-detail-hdr">
          <span class="fc-theater-detail-name">${escapeHtml(t.theaterLabel)}</span>
          <span class="fc-cat-tag" style="background:${color}1f;color:${color};border:1px solid ${color}47">${escapeHtml(catLabel)}</span>
        </div>
        <div class="fc-theater-paths">${pathsHtml}</div>
        ${reactions || stabilizers || invalidators ? `
          <div class="fc-theater-footer">
            <div class="fc-theater-footer-section">
              <div class="fc-footer-title">Reactions</div>
              ${reactions || '<div class="fc-footer-item" style="opacity:0.4">—</div>'}
            </div>
            <div class="fc-theater-footer-section">
              <div class="fc-footer-title">Stabilizers</div>
              ${stabilizers || '<div class="fc-footer-item" style="opacity:0.4">—</div>'}
            </div>
            <div class="fc-theater-footer-section">
              <div class="fc-footer-title">Invalidators</div>
              ${invalidators || '<div class="fc-footer-item" style="opacity:0.4">—</div>'}
            </div>
          </div>
        ` : ''}
      </div>
    `;
  }

  // ── Probability table (replaces the old 2-col card grid) ────────────────

  private renderProbTable(forecasts: Forecast[]): string {
    if (forecasts.length === 0) {
      return '<div class="fc-empty">No forecasts for this filter</div>';
    }
    const header = `<div class="fc-prob-hdr">
      <span>Forecast</span><span>Probability</span><span>Trend</span><span>Domain</span>
    </div>`;
    const rows = forecasts.map(f => this.renderProbRow(f)).join('');
    return `<div class="fc-prob-table">${header}${rows}</div>`;
  }

  private renderProbRow(f: Forecast): string {
    const pct      = Math.round((f.probability || 0) * 100);
    const domain   = f.domain || 'conflict';
    const catColor = DOMAIN_COLORS[domain] || '#7d8590';
    const catLabel = DOMAIN_LABELS[domain] || domain;
    const probColor = pct >= 60 ? '#3fb950' : pct >= 40 ? '#d29922' : '#e05252';
    const trendText  = f.trend === 'rising' ? '↑ rising' : f.trend === 'falling' ? '↓ falling' : '→ stable';
    const trendColor = f.trend === 'rising' ? '#3fb950' : f.trend === 'falling' ? '#e05252' : '#7d8590';

    const sigs = f.signals || [];
    const signalsHtml = sigs.length > 0
      ? `<div class="fc-signals-title">Analysis Signals (${sigs.length})</div>${sigs.map(s =>
          `<div class="fc-signal">${escapeHtml(s.value.replace(/^[\s\u2013\u2014\-]+/, ''))}</div>`
        ).join('')}`
      : '';

    return `
      <div class="fc-prob-item">
        <div class="fc-prob-row">
          <span class="fc-prob-label"
                style="border-left:2px solid ${catColor}47;padding-left:6px">
            ${escapeHtml(f.title)}
          </span>
          <div class="fc-bar-wrap">
            <div class="fc-prob-bar-track">
              <div class="fc-prob-bar-fill" style="background:${probColor};width:${pct}%"></div>
            </div>
            <span class="fc-prob-pct" style="color:${probColor}">${pct}%</span>
          </div>
          <span class="fc-trend-text" style="color:${trendColor}">${trendText}</span>
          <span class="fc-domain-tag"
                style="background:${catColor}1f;color:${catColor};border:1px solid ${catColor}33">
            ${escapeHtml(catLabel)}
          </span>
        </div>
        <div class="fc-toggle-row">
          <span class="fc-toggle" data-fc-toggle="detail-${escapeHtml(f.id)}">Analysis</span>
          ${sigs.length > 0 ? `<span class="fc-toggle" data-fc-toggle="signals-${escapeHtml(f.id)}">Signals (${sigs.length})</span>` : ''}
        </div>
        <div class="fc-detail fc-hidden" data-fc-panel="detail-${escapeHtml(f.id)}">${this.renderDetailBody(f)}</div>
        ${signalsHtml ? `<div class="fc-signals fc-hidden" data-fc-panel="signals-${escapeHtml(f.id)}">${signalsHtml}</div>` : ''}
      </div>
    `;
  }

  // ── Detail sections (shared by rows) ────────────────────────────────────

  private renderDetailBody(f: Forecast): string {
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
    if (caseFile?.worldState?.summary || caseFile?.worldState?.activePressures?.length) {
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
      f.calibration?.marketTitle ? `Market: ${f.calibration.marketTitle} (${Math.round((f.calibration.marketPrice || 0) * 100)}%)` : '',
      typeof f.priorProbability === 'number' ? `Prior: ${Math.round(f.priorProbability * 100)}%` : '',
      f.cascades?.length ? `Cascades: ${f.cascades.length}` : '',
    ].filter(Boolean);
    if (chips.length > 0) {
      sections.push(`<div class="fc-section"><div class="fc-section-title">Context</div><div class="fc-chip-row">${chips.map(c => `<span class="fc-chip">${escapeHtml(c)}</span>`).join('')}</div></div>`);
    }

    return `<div class="fc-detail-grid">${sections.join('')}</div>`;
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
      return `
        <div class="fc-section-copy">
          <strong>${escapeHtml(actor.name || 'Actor')}</strong>
          ${chips ? `<div class="fc-chip-row" style="margin-top:4px;">${chips}</div>` : ''}
          ${actor.role ? `<div class="fc-list-item">${escapeHtml(actor.role)}</div>` : ''}
          ${actor.objectives?.[0] ? `<div class="fc-list-item"><strong>Objective:</strong> ${escapeHtml(actor.objectives[0])}</div>` : ''}
          ${actor.constraints?.[0] ? `<div class="fc-list-item"><strong>Constraint:</strong> ${escapeHtml(actor.constraints[0])}</div>` : ''}
          ${actor.likelyActions?.[0] ? `<div class="fc-list-item"><strong>Likely action:</strong> ${escapeHtml(actor.likelyActions[0])}</div>` : ''}
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
        const copy = [(round.developments || []).slice(0, 2).join(' '), (round.actorMoves || []).slice(0, 1).join(' ')].filter(Boolean).join(' ');
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
}
