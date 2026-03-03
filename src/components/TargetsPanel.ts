// TargetsPanel.ts — "My Targets" watchlist for SalesIntel
// Vanilla TypeScript, direct DOM manipulation, dark theme

export interface TargetCompany {
  name: string;
  domain?: string;
  industry: string;
  tier: 1 | 2 | 3;
  lastSignalType: string;
  lastSignalTime: Date;
  signalHealth: number; // 0-100
  signalCount: number;
}

/* ------------------------------------------------------------------ */
/*  Colour palette                                                     */
/* ------------------------------------------------------------------ */

const C = {
  bg:          '#0A0F1C',
  card:        '#0f172a',
  border:      '#1E293B',
  text:        '#e2e8f0',
  textSec:     '#94a3b8',
  accent:      '#3B82F6',
  accentHover: '#2563eb',
  rowAlt:      '#0d1424',
  rowHover:    '#141d32',
  green:       '#10b981',
  blue:        '#3b82f6',
  amber:       '#f59e0b',
  gray:        '#6b7280',
  red:         '#ef4444',
} as const;

function healthColor(v: number): string {
  if (v >= 80) return C.green;
  if (v >= 60) return C.blue;
  if (v >= 40) return C.amber;
  return C.gray;
}

function tierColor(t: 1 | 2 | 3): string {
  if (t === 1) return C.green;
  if (t === 2) return C.blue;
  return C.gray;
}

function avatarColor(name: string): string {
  const palette = ['#6366f1', '#8b5cf6', '#ec4899', '#f43f5e', '#f97316', '#eab308', '#22c55e', '#14b8a6', '#06b6d4', '#3b82f6'];
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return palette[Math.abs(hash) % palette.length];
}

function relativeTime(date: Date): string {
  const now = Date.now();
  const diff = now - date.getTime();
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hrs = Math.floor(min / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return date.toLocaleDateString();
}

function escapeHtml(s: string): string {
  const el = document.createElement('span');
  el.textContent = s;
  return el.innerHTML;
}

/* ------------------------------------------------------------------ */
/*  Styles                                                             */
/* ------------------------------------------------------------------ */

const STYLE_ID = 'targets-panel-styles';

function injectStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
/* ── TargetsPanel ─────────────────────────────────────────────────── */

.tp-root {
  background: ${C.bg};
  color: ${C.text};
  font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  -webkit-font-smoothing: antialiased;
  min-height: 100%;
  padding: 28px 32px;
  box-sizing: border-box;
}

/* ── Header ────────────────────────────────────────────────────────── */

.tp-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 24px;
}

.tp-title {
  font-size: 22px;
  font-weight: 600;
  letter-spacing: -0.3px;
  color: ${C.text};
  margin: 0;
}

.tp-subtitle {
  font-size: 13px;
  color: ${C.textSec};
  margin-top: 2px;
}

.tp-quick-add {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 9px 18px;
  font-size: 13px;
  font-weight: 500;
  color: #fff;
  background: ${C.accent};
  border: none;
  border-radius: 8px;
  cursor: pointer;
  transition: background 0.15s, box-shadow 0.15s;
  letter-spacing: 0.01em;
}
.tp-quick-add:hover {
  background: ${C.accentHover};
  box-shadow: 0 0 0 3px rgba(59,130,246,0.25);
}
.tp-quick-add svg {
  width: 15px;
  height: 15px;
}

/* ── Stats row ─────────────────────────────────────────────────────── */

.tp-stats {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 16px;
  margin-bottom: 20px;
}

.tp-stat-card {
  background: ${C.card};
  border: 1px solid ${C.border};
  border-radius: 12px;
  padding: 20px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.tp-stat-label {
  font-size: 12px;
  font-weight: 500;
  color: ${C.textSec};
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.tp-stat-value-row {
  display: flex;
  align-items: baseline;
  gap: 10px;
}

.tp-stat-value {
  font-size: 28px;
  font-weight: 700;
  letter-spacing: -0.5px;
  color: ${C.text};
  line-height: 1;
}

.tp-stat-trend {
  font-size: 12px;
  font-weight: 600;
  display: inline-flex;
  align-items: center;
  gap: 2px;
}
.tp-stat-trend.up   { color: ${C.green}; }
.tp-stat-trend.down { color: ${C.red};   }

.tp-stat-badge {
  font-size: 11px;
  font-weight: 600;
  padding: 2px 8px;
  border-radius: 4px;
  letter-spacing: 0.3px;
}
.tp-stat-badge.new-badge {
  background: rgba(59,130,246,0.15);
  color: ${C.accent};
}
.tp-stat-badge.strong {
  background: rgba(16,185,129,0.12);
  color: ${C.green};
}
.tp-stat-badge.weak {
  background: rgba(239,68,68,0.12);
  color: ${C.red};
}

/* ── Filters ───────────────────────────────────────────────────────── */

.tp-filters {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 18px;
  flex-wrap: wrap;
}

.tp-filter-select {
  appearance: none;
  background: ${C.card} url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M0 0l5 6 5-6z' fill='%2394a3b8'/%3E%3C/svg%3E") no-repeat right 12px center;
  border: 1px solid ${C.border};
  border-radius: 8px;
  color: ${C.text};
  font-family: inherit;
  font-size: 13px;
  padding: 8px 32px 8px 12px;
  cursor: pointer;
  transition: border-color 0.15s;
  min-width: 130px;
}
.tp-filter-select:hover,
.tp-filter-select:focus {
  border-color: ${C.accent};
  outline: none;
}
.tp-filter-select option {
  background: ${C.card};
  color: ${C.text};
}

.tp-filter-clear {
  background: none;
  border: none;
  color: ${C.textSec};
  font-size: 12px;
  font-family: inherit;
  cursor: pointer;
  padding: 4px 0;
  margin-left: auto;
  transition: color 0.15s;
}
.tp-filter-clear:hover {
  color: ${C.accent};
}

/* ── Table ─────────────────────────────────────────────────────────── */

.tp-table-wrap {
  border: 1px solid ${C.border};
  border-radius: 12px;
  overflow: hidden;
  background: ${C.card};
}

.tp-table {
  width: 100%;
  border-collapse: collapse;
  table-layout: fixed;
}

.tp-table th {
  text-align: left;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.6px;
  color: ${C.textSec};
  padding: 14px 16px;
  border-bottom: 1px solid ${C.border};
  background: ${C.card};
  white-space: nowrap;
}

.tp-table th:nth-child(1) { width: 30%; }
.tp-table th:nth-child(2) { width: 10%; }
.tp-table th:nth-child(3) { width: 22%; }
.tp-table th:nth-child(4) { width: 22%; }
.tp-table th:nth-child(5) { width: 16%; }

.tp-table td {
  padding: 14px 16px;
  font-size: 13px;
  border-bottom: 1px solid rgba(30,41,59,0.5);
  vertical-align: middle;
}

.tp-table tbody tr:nth-child(even) td {
  background: ${C.rowAlt};
}

.tp-table tbody tr {
  transition: background 0.12s;
}
.tp-table tbody tr:hover td {
  background: ${C.rowHover};
}

/* company cell */
.tp-company-cell {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
}

.tp-avatar {
  width: 34px;
  height: 34px;
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
  font-weight: 700;
  color: #fff;
  flex-shrink: 0;
}

.tp-company-info {
  min-width: 0;
}

.tp-company-name {
  font-weight: 600;
  color: ${C.text};
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.tp-company-industry {
  font-size: 11px;
  color: ${C.textSec};
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  margin-top: 1px;
}

/* tier badge */
.tp-tier {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  font-weight: 700;
  width: 28px;
  height: 22px;
  border-radius: 6px;
  letter-spacing: 0;
}

/* signal cell */
.tp-signal-type {
  font-weight: 500;
  color: ${C.text};
}

.tp-signal-time {
  font-size: 11px;
  color: ${C.textSec};
  margin-top: 2px;
}

/* health bar */
.tp-health-wrap {
  display: flex;
  align-items: center;
  gap: 10px;
}

.tp-health-bar-bg {
  flex: 1;
  height: 6px;
  border-radius: 3px;
  background: rgba(255,255,255,0.06);
  overflow: hidden;
}

.tp-health-bar-fill {
  height: 100%;
  border-radius: 3px;
  transition: width 0.4s ease;
}

.tp-health-pct {
  font-size: 12px;
  font-weight: 600;
  min-width: 34px;
  text-align: right;
}

/* actions */
.tp-actions-cell {
  display: flex;
  align-items: center;
  gap: 8px;
}

.tp-view-btn {
  font-family: inherit;
  font-size: 12px;
  font-weight: 500;
  padding: 5px 12px;
  border-radius: 6px;
  border: 1px solid ${C.border};
  background: transparent;
  color: ${C.text};
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s;
}
.tp-view-btn:hover {
  border-color: ${C.accent};
  background: rgba(59,130,246,0.08);
  color: ${C.accent};
}

.tp-delete-btn {
  background: none;
  border: none;
  color: ${C.textSec};
  cursor: pointer;
  padding: 4px;
  border-radius: 4px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: color 0.15s, background 0.15s;
}
.tp-delete-btn:hover {
  color: ${C.red};
  background: rgba(239,68,68,0.1);
}
.tp-delete-btn svg {
  width: 15px;
  height: 15px;
}

/* ── Pagination ────────────────────────────────────────────────────── */

.tp-pagination {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 0 0;
}

.tp-page-info {
  font-size: 13px;
  color: ${C.textSec};
}

.tp-page-controls {
  display: flex;
  align-items: center;
  gap: 4px;
}

.tp-page-btn {
  font-family: inherit;
  font-size: 13px;
  font-weight: 500;
  min-width: 34px;
  height: 34px;
  padding: 0 8px;
  border: 1px solid ${C.border};
  border-radius: 6px;
  background: transparent;
  color: ${C.textSec};
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s, color 0.15s;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.tp-page-btn:hover:not(:disabled) {
  border-color: ${C.accent};
  color: ${C.text};
}
.tp-page-btn:disabled {
  opacity: 0.35;
  cursor: default;
}
.tp-page-btn.active {
  background: ${C.accent};
  border-color: ${C.accent};
  color: #fff;
}

.tp-page-ellipsis {
  font-size: 13px;
  color: ${C.textSec};
  padding: 0 4px;
}

/* ── Empty state ───────────────────────────────────────────────────── */

.tp-empty {
  text-align: center;
  padding: 64px 24px;
  color: ${C.textSec};
}
.tp-empty-icon {
  font-size: 36px;
  margin-bottom: 12px;
  opacity: 0.5;
}
.tp-empty-title {
  font-size: 15px;
  font-weight: 600;
  color: ${C.text};
  margin-bottom: 6px;
}
.tp-empty-desc {
  font-size: 13px;
  color: ${C.textSec};
}

/* ── Responsive ────────────────────────────────────────────────────── */

@media (max-width: 900px) {
  .tp-stats { grid-template-columns: 1fr; }
  .tp-root  { padding: 20px 16px; }
}
`;
  document.head.appendChild(style);
}

/* ------------------------------------------------------------------ */
/*  Icons (inline SVG strings)                                         */
/* ------------------------------------------------------------------ */

const ICON_PLUS = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="8" y1="3" x2="8" y2="13"/><line x1="3" y1="8" x2="13" y2="8"/></svg>`;

const ICON_TRASH = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 4 4 4 13 4"/><path d="M5.5 4V3a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v1"/><path d="M12 4v9a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V4"/><line x1="7" y1="7" x2="7" y2="11"/><line x1="9" y1="7" x2="9" y2="11"/></svg>`;

const ICON_CHEVRON_LEFT = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="10 3 5 8 10 13"/></svg>`;

const ICON_CHEVRON_RIGHT = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 3 11 8 6 13"/></svg>`;

/* ------------------------------------------------------------------ */
/*  TargetsPanel                                                       */
/* ------------------------------------------------------------------ */

export class TargetsPanel {
  private container: HTMLElement | null = null;
  private root: HTMLElement | null = null;

  private targets: TargetCompany[] = [];
  private filtered: TargetCompany[] = [];

  /* pagination */
  private pageSize = 10;
  private currentPage = 1;

  /* filters */
  private filterSector  = '';
  private filterTier    = '';
  private filterStatus  = '';

  /* callbacks */
  private viewCallback: ((company: string) => void) | null = null;

  /* ── lifecycle ──────────────────────────────────────────────────── */

  constructor() {
    injectStyles();
  }

  public render(container: HTMLElement): void {
    this.container = container;
    this.root = document.createElement('div');
    this.root.className = 'tp-root';
    container.appendChild(this.root);
    this.applyFilters();
    this.update();
  }

  public destroy(): void {
    if (this.root && this.container?.contains(this.root)) {
      this.container.removeChild(this.root);
    }
    this.root = null;
    this.container = null;
  }

  public setTargets(targets: TargetCompany[]): void {
    this.targets = targets;
    this.currentPage = 1;
    this.applyFilters();
    this.update();
  }

  public onViewTarget(callback: (company: string) => void): void {
    this.viewCallback = callback;
  }

  /* ── filtering / derived data ───────────────────────────────────── */

  private applyFilters(): void {
    let list = this.targets;

    if (this.filterSector) {
      list = list.filter(t => t.industry === this.filterSector);
    }
    if (this.filterTier) {
      const tier = Number(this.filterTier) as 1 | 2 | 3;
      list = list.filter(t => t.tier === tier);
    }
    if (this.filterStatus === 'Active') {
      const oneDayAgo = Date.now() - 86_400_000;
      list = list.filter(t => t.lastSignalTime.getTime() > oneDayAgo);
    } else if (this.filterStatus === 'Stale') {
      const oneDayAgo = Date.now() - 86_400_000;
      list = list.filter(t => t.lastSignalTime.getTime() <= oneDayAgo);
    }

    this.filtered = list;
  }

  private get totalPages(): number {
    return Math.max(1, Math.ceil(this.filtered.length / this.pageSize));
  }

  private get pageSlice(): TargetCompany[] {
    const start = (this.currentPage - 1) * this.pageSize;
    return this.filtered.slice(start, start + this.pageSize);
  }

  private get uniqueSectors(): string[] {
    return [...new Set(this.targets.map(t => t.industry))].sort();
  }

  /* ── aggregate stats ────────────────────────────────────────────── */

  private get totalCount(): number {
    return this.targets.length;
  }

  private get highIntentToday(): number {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    return this.targets.filter(t => t.signalHealth >= 80 && t.lastSignalTime >= todayStart).length;
  }

  private get averageHealth(): number {
    if (this.targets.length === 0) return 0;
    return Math.round(this.targets.reduce((sum, t) => sum + t.signalHealth, 0) / this.targets.length);
  }

  /* ── render helpers ─────────────────────────────────────────────── */

  private update(): void {
    if (!this.root) return;
    this.root.innerHTML = this.buildHTML();
    this.attachListeners();
  }

  private buildHTML(): string {
    return [
      this.buildHeader(),
      this.buildStats(),
      this.buildFilters(),
      this.buildTable(),
      this.buildPagination(),
    ].join('');
  }

  /* ── header ─────────────────────────────────────────────────────── */

  private buildHeader(): string {
    return `
      <div class="tp-header">
        <div>
          <h2 class="tp-title">My Targets</h2>
          <div class="tp-subtitle">Watchlist accounts and signal tracking</div>
        </div>
        <button class="tp-quick-add" data-action="quick-add">${ICON_PLUS} Quick Add</button>
      </div>`;
  }

  /* ── stats ──────────────────────────────────────────────────────── */

  private buildStats(): string {
    const trendPct = this.targets.length > 10 ? 12 : 0;
    const avgH = this.averageHealth;
    const healthLabel = avgH >= 60 ? 'Strong' : 'Weak';
    const healthBadgeClass = avgH >= 60 ? 'strong' : 'weak';

    return `
      <div class="tp-stats">
        <div class="tp-stat-card">
          <span class="tp-stat-label">Total Targets</span>
          <div class="tp-stat-value-row">
            <span class="tp-stat-value">${this.totalCount}</span>
            ${trendPct !== 0 ? `<span class="tp-stat-trend ${trendPct > 0 ? 'up' : 'down'}">${trendPct > 0 ? '&#9650;' : '&#9660;'} ${Math.abs(trendPct)}%</span>` : ''}
          </div>
        </div>
        <div class="tp-stat-card">
          <span class="tp-stat-label">High Intent Signals Today</span>
          <div class="tp-stat-value-row">
            <span class="tp-stat-value">${this.highIntentToday}</span>
            ${this.highIntentToday > 0 ? `<span class="tp-stat-badge new-badge">New</span>` : ''}
          </div>
        </div>
        <div class="tp-stat-card">
          <span class="tp-stat-label">Average Account Health</span>
          <div class="tp-stat-value-row">
            <span class="tp-stat-value">${avgH}%</span>
            <span class="tp-stat-badge ${healthBadgeClass}">${healthLabel}</span>
          </div>
        </div>
      </div>`;
  }

  /* ── filters ────────────────────────────────────────────────────── */

  private buildFilters(): string {
    const sectors = this.uniqueSectors;

    return `
      <div class="tp-filters">
        <select class="tp-filter-select" data-filter="sector">
          <option value="">All Sectors</option>
          ${sectors.map(s => `<option value="${escapeHtml(s)}"${this.filterSector === s ? ' selected' : ''}>${escapeHtml(s)}</option>`).join('')}
        </select>
        <select class="tp-filter-select" data-filter="tier">
          <option value="">All Tiers</option>
          <option value="1"${this.filterTier === '1' ? ' selected' : ''}>Tier 1</option>
          <option value="2"${this.filterTier === '2' ? ' selected' : ''}>Tier 2</option>
          <option value="3"${this.filterTier === '3' ? ' selected' : ''}>Tier 3</option>
        </select>
        <select class="tp-filter-select" data-filter="status">
          <option value="">All Signals</option>
          <option value="Active"${this.filterStatus === 'Active' ? ' selected' : ''}>Active</option>
          <option value="Stale"${this.filterStatus === 'Stale' ? ' selected' : ''}>Stale</option>
        </select>
        <button class="tp-filter-clear" data-action="clear-filters">Clear all filters</button>
      </div>`;
  }

  /* ── table ──────────────────────────────────────────────────────── */

  private buildTable(): string {
    const rows = this.pageSlice;

    if (this.targets.length === 0) {
      return `
        <div class="tp-table-wrap">
          <div class="tp-empty">
            <div class="tp-empty-icon">&#x1F3AF;</div>
            <div class="tp-empty-title">No targets yet</div>
            <div class="tp-empty-desc">Click "Quick Add" to start building your watchlist.</div>
          </div>
        </div>`;
    }

    if (rows.length === 0) {
      return `
        <div class="tp-table-wrap">
          <div class="tp-empty">
            <div class="tp-empty-icon">&#x1F50D;</div>
            <div class="tp-empty-title">No matches</div>
            <div class="tp-empty-desc">Try adjusting your filters to see more targets.</div>
          </div>
        </div>`;
    }

    return `
      <div class="tp-table-wrap">
        <table class="tp-table">
          <thead>
            <tr>
              <th>Company Name</th>
              <th>Tier</th>
              <th>Last Signal</th>
              <th>Signal Health</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            ${rows.map(t => this.buildRow(t)).join('')}
          </tbody>
        </table>
      </div>`;
  }

  private buildRow(t: TargetCompany): string {
    const initial = t.name.charAt(0).toUpperCase();
    const bg = avatarColor(t.name);
    const tc = tierColor(t.tier);
    const hc = healthColor(t.signalHealth);

    return `
      <tr>
        <td>
          <div class="tp-company-cell">
            <div class="tp-avatar" style="background:${bg}">${initial}</div>
            <div class="tp-company-info">
              <div class="tp-company-name">${escapeHtml(t.name)}</div>
              <div class="tp-company-industry">${escapeHtml(t.industry)}</div>
            </div>
          </div>
        </td>
        <td>
          <span class="tp-tier" style="background:${tc}20;color:${tc}">T${t.tier}</span>
        </td>
        <td>
          <div class="tp-signal-type">${escapeHtml(t.lastSignalType)}</div>
          <div class="tp-signal-time">${relativeTime(t.lastSignalTime)}</div>
        </td>
        <td>
          <div class="tp-health-wrap">
            <div class="tp-health-bar-bg">
              <div class="tp-health-bar-fill" style="width:${t.signalHealth}%;background:${hc}"></div>
            </div>
            <span class="tp-health-pct" style="color:${hc}">${t.signalHealth}%</span>
          </div>
        </td>
        <td>
          <div class="tp-actions-cell">
            <button class="tp-view-btn" data-company="${escapeHtml(t.name)}">View</button>
            <button class="tp-delete-btn" data-delete="${escapeHtml(t.name)}">${ICON_TRASH}</button>
          </div>
        </td>
      </tr>`;
  }

  /* ── pagination ─────────────────────────────────────────────────── */

  private buildPagination(): string {
    const total = this.filtered.length;
    if (total === 0) return '';

    const start = (this.currentPage - 1) * this.pageSize + 1;
    const end = Math.min(this.currentPage * this.pageSize, total);
    const pages = this.totalPages;

    return `
      <div class="tp-pagination">
        <span class="tp-page-info">Showing ${start} to ${end} of ${total} targets</span>
        <div class="tp-page-controls">
          <button class="tp-page-btn" data-page="prev" ${this.currentPage <= 1 ? 'disabled' : ''}>${ICON_CHEVRON_LEFT}</button>
          ${this.buildPageButtons(pages)}
          <button class="tp-page-btn" data-page="next" ${this.currentPage >= pages ? 'disabled' : ''}>${ICON_CHEVRON_RIGHT}</button>
        </div>
      </div>`;
  }

  private buildPageButtons(pages: number): string {
    if (pages <= 7) {
      return Array.from({ length: pages }, (_, i) => i + 1)
        .map(p => `<button class="tp-page-btn${p === this.currentPage ? ' active' : ''}" data-page="${p}">${p}</button>`)
        .join('');
    }

    const btns: string[] = [];
    const cur = this.currentPage;

    const add = (p: number) => {
      btns.push(`<button class="tp-page-btn${p === cur ? ' active' : ''}" data-page="${p}">${p}</button>`);
    };
    const ellipsis = () => {
      btns.push(`<span class="tp-page-ellipsis">&hellip;</span>`);
    };

    add(1);
    if (cur > 3) ellipsis();

    const lo = Math.max(2, cur - 1);
    const hi = Math.min(pages - 1, cur + 1);
    for (let p = lo; p <= hi; p++) add(p);

    if (cur < pages - 2) ellipsis();
    add(pages);

    return btns.join('');
  }

  /* ── event listeners ────────────────────────────────────────────── */

  private attachListeners(): void {
    if (!this.root) return;

    /* filters */
    this.root.querySelectorAll<HTMLSelectElement>('.tp-filter-select').forEach(sel => {
      sel.addEventListener('change', () => {
        const key = sel.dataset.filter;
        if (key === 'sector')  this.filterSector = sel.value;
        if (key === 'tier')    this.filterTier = sel.value;
        if (key === 'status')  this.filterStatus = sel.value;
        this.currentPage = 1;
        this.applyFilters();
        this.update();
      });
    });

    /* clear filters */
    this.root.querySelector('[data-action="clear-filters"]')?.addEventListener('click', () => {
      this.filterSector = '';
      this.filterTier = '';
      this.filterStatus = '';
      this.currentPage = 1;
      this.applyFilters();
      this.update();
    });

    /* pagination */
    this.root.querySelectorAll<HTMLButtonElement>('.tp-page-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const val = btn.dataset.page;
        if (!val) return;
        if (val === 'prev') this.currentPage = Math.max(1, this.currentPage - 1);
        else if (val === 'next') this.currentPage = Math.min(this.totalPages, this.currentPage + 1);
        else this.currentPage = Number(val);
        this.update();
      });
    });

    /* view buttons */
    this.root.querySelectorAll<HTMLButtonElement>('.tp-view-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const company = btn.dataset.company;
        if (company && this.viewCallback) this.viewCallback(company);
      });
    });

    /* delete buttons */
    this.root.querySelectorAll<HTMLButtonElement>('.tp-delete-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const name = btn.dataset.delete;
        if (!name) return;
        this.targets = this.targets.filter(t => t.name !== name);
        this.applyFilters();
        if (this.currentPage > this.totalPages) this.currentPage = this.totalPages;
        this.update();
      });
    });
  }
}
