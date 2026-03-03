// ---------------------------------------------------------------------------
// SignalAlertsPanel  -  Signal Alerts page for SalesIntel
// Vanilla TypeScript / direct DOM manipulation. No framework dependencies.
// ---------------------------------------------------------------------------

export interface SignalAlert {
  id: string;
  company: string;
  companyDomain?: string;
  signalType:
    | 'executive_hire'
    | 'funding'
    | 'expansion'
    | 'tech_stack'
    | 'earnings'
    | 'hiring_surge'
    | 'partnership';
  title: string;
  summary: string;
  source: string;
  sourceTier: number;
  timestamp: Date;
  tags: string[];
  strength: 'critical' | 'high' | 'medium' | 'low';
  dismissed: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

type FilterTab = 'all' | 'high_priority' | 'new_hires' | 'funding' | 'tech_stack';

interface FilterDef {
  key: FilterTab;
  label: string;
}

const FILTER_TABS: FilterDef[] = [
  { key: 'all', label: 'All Alerts' },
  { key: 'high_priority', label: 'High Priority' },
  { key: 'new_hires', label: 'New Hires' },
  { key: 'funding', label: 'Funding' },
  { key: 'tech_stack', label: 'Tech Stack' },
];

interface BadgeConfig {
  label: string;
  bg: string;
  fg: string;
}

const SIGNAL_BADGE_MAP: Record<SignalAlert['signalType'], BadgeConfig> = {
  executive_hire: { label: 'NEW EXECUTIVE HIRE', bg: '#166534', fg: '#bbf7d0' },
  funding: { label: 'SERIES D FUNDING', bg: '#1e40af', fg: '#bfdbfe' },
  expansion: { label: 'EXPANSION SIGNAL', bg: '#6b21a8', fg: '#e9d5ff' },
  tech_stack: { label: 'TECH STACK CHANGE', bg: '#92400e', fg: '#fde68a' },
  earnings: { label: 'NEGATIVE SENTIMENT (EARNINGS)', bg: '#991b1b', fg: '#fecaca' },
  hiring_surge: { label: 'HIRING SURGE', bg: '#166534', fg: '#bbf7d0' },
  partnership: { label: 'NEW PARTNERSHIP', bg: '#1e40af', fg: '#bfdbfe' },
};

const STRENGTH_COLORS: Record<SignalAlert['strength'], string> = {
  critical: '#ef4444',
  high: '#f97316',
  medium: '#eab308',
  low: '#94a3b8',
};

// ---------------------------------------------------------------------------
// Styles  (injected once into <head>)
// ---------------------------------------------------------------------------

const STYLE_ID = 'signal-alerts-panel-styles';

function injectStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
/* -----------------------------------------------------------------------
   SignalAlertsPanel  -  Scoped under .sap-root
   ----------------------------------------------------------------------- */
.sap-root {
  --sap-bg: #0A0F1C;
  --sap-card: #0f172a;
  --sap-border: #1E293B;
  --sap-text: #e2e8f0;
  --sap-muted: #94a3b8;
  --sap-accent: #3B82F6;
  --sap-tag-bg: #1e293b;

  display: flex;
  gap: 24px;
  width: 100%;
  min-height: 100%;
  background: var(--sap-bg);
  color: var(--sap-text);
  font-family: -apple-system, BlinkMacSystemFont, 'Inter', 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  box-sizing: border-box;
  padding: 24px;
}

.sap-root *, .sap-root *::before, .sap-root *::after {
  box-sizing: border-box;
}

/* ---- Layout columns ---- */
.sap-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.sap-sidebar {
  width: 300px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: 20px;
}

/* ---- Filter tabs ---- */
.sap-filters {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.sap-filter-tab {
  appearance: none;
  border: none;
  outline: none;
  cursor: pointer;
  padding: 7px 16px;
  border-radius: 9999px;
  font-size: 13px;
  font-weight: 500;
  letter-spacing: 0.01em;
  line-height: 1;
  background: transparent;
  color: var(--sap-muted);
  transition: background 0.15s ease, color 0.15s ease;
}

.sap-filter-tab:hover {
  background: rgba(59, 130, 246, 0.08);
  color: var(--sap-text);
}

.sap-filter-tab[data-active="true"] {
  background: var(--sap-accent);
  color: #fff;
}

/* ---- Signal card list ---- */
.sap-card-list {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

/* ---- Signal card ---- */
.sap-card {
  background: var(--sap-card);
  border: 1px solid var(--sap-border);
  border-radius: 12px;
  padding: 20px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}

.sap-card:hover {
  border-color: rgba(59, 130, 246, 0.25);
  box-shadow: 0 0 0 1px rgba(59, 130, 246, 0.08);
}

.sap-card[data-dismissed="true"] {
  opacity: 0.45;
  pointer-events: none;
}

/* card header row */
.sap-card-header {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.sap-company {
  font-size: 16px;
  font-weight: 600;
  color: var(--sap-text);
  white-space: nowrap;
}

.sap-signal-badge {
  display: inline-flex;
  align-items: center;
  padding: 3px 8px;
  border-radius: 4px;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.04em;
  line-height: 1.2;
  white-space: nowrap;
}

.sap-strength-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
  margin-left: auto;
}

/* timestamp */
.sap-timestamp {
  font-size: 12px;
  color: var(--sap-muted);
  margin-top: -4px;
}

/* summary */
.sap-summary {
  font-size: 14px;
  line-height: 1.55;
  color: #cbd5e1;
}

/* source */
.sap-source {
  font-size: 12px;
  color: var(--sap-muted);
  display: flex;
  align-items: center;
  gap: 6px;
}

.sap-source-tier {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  font-size: 10px;
  font-weight: 700;
  line-height: 1;
}

.sap-tier-1 { background: #166534; color: #bbf7d0; }
.sap-tier-2 { background: #1e40af; color: #bfdbfe; }
.sap-tier-3 { background: #92400e; color: #fde68a; }

/* tags */
.sap-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.sap-tag {
  padding: 3px 10px;
  border-radius: 9999px;
  font-size: 11px;
  font-weight: 500;
  background: var(--sap-tag-bg);
  color: var(--sap-muted);
  line-height: 1.3;
}

/* action buttons row */
.sap-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 2px;
}

.sap-btn {
  appearance: none;
  border: none;
  outline: none;
  cursor: pointer;
  font-family: inherit;
  font-size: 13px;
  font-weight: 500;
  border-radius: 6px;
  padding: 7px 14px;
  line-height: 1;
  transition: background 0.12s ease, color 0.12s ease, opacity 0.12s ease;
}

.sap-btn-ghost {
  background: transparent;
  color: var(--sap-muted);
}
.sap-btn-ghost:hover {
  background: rgba(148, 163, 184, 0.08);
  color: var(--sap-text);
}

.sap-btn-primary {
  background: var(--sap-accent);
  color: #fff;
}
.sap-btn-primary:hover {
  background: #2563eb;
}

/* ---- Sidebar sections ---- */
.sap-sidebar-section {
  background: var(--sap-card);
  border: 1px solid var(--sap-border);
  border-radius: 12px;
  padding: 20px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.sap-sidebar-title {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--sap-muted);
}

/* trend items */
.sap-trend-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
}

.sap-trend-label {
  font-size: 13px;
  color: var(--sap-text);
}

.sap-trend-value {
  font-size: 20px;
  font-weight: 700;
  color: var(--sap-text);
}

.sap-trend-delta {
  font-size: 12px;
  font-weight: 600;
  margin-left: 6px;
}

.sap-trend-up { color: #22c55e; }
.sap-trend-down { color: #ef4444; }

/* intent matches */
.sap-intent-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.sap-intent-company {
  font-size: 13px;
  font-weight: 600;
  color: var(--sap-text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}

.sap-intent-type {
  font-size: 11px;
  color: var(--sap-muted);
  white-space: nowrap;
}

.sap-intent-score {
  font-size: 13px;
  font-weight: 700;
  color: var(--sap-accent);
  white-space: nowrap;
}

/* toggle switches */
.sap-toggle-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.sap-toggle-label {
  font-size: 13px;
  color: var(--sap-text);
}

.sap-toggle {
  position: relative;
  width: 38px;
  height: 22px;
  flex-shrink: 0;
  cursor: pointer;
}

.sap-toggle input {
  position: absolute;
  opacity: 0;
  width: 0;
  height: 0;
}

.sap-toggle-track {
  position: absolute;
  inset: 0;
  border-radius: 11px;
  background: #334155;
  transition: background 0.15s ease;
}

.sap-toggle input:checked + .sap-toggle-track {
  background: var(--sap-accent);
}

.sap-toggle-thumb {
  position: absolute;
  top: 3px;
  left: 3px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: #fff;
  transition: transform 0.15s ease;
  pointer-events: none;
}

.sap-toggle input:checked ~ .sap-toggle-thumb {
  transform: translateX(16px);
}

/* ---- Empty state ---- */
.sap-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 48px 24px;
  color: var(--sap-muted);
  font-size: 14px;
  text-align: center;
}

.sap-empty-icon {
  font-size: 32px;
  opacity: 0.5;
  margin-bottom: 4px;
}

/* ---- Responsive ---- */
@media (max-width: 900px) {
  .sap-root {
    flex-direction: column;
    padding: 16px;
  }
  .sap-sidebar {
    width: 100%;
  }
}
`;
  document.head.appendChild(style);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function esc(text: string): string {
  const el = document.createElement('span');
  el.textContent = text;
  return el.innerHTML;
}

function relativeTime(date: Date): string {
  const now = Date.now();
  const diff = now - date.getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days}d ago`;
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function tierLabel(tier: number): string {
  if (tier <= 1) return 'T1';
  if (tier === 2) return 'T2';
  return 'T3';
}

function tierClass(tier: number): string {
  if (tier <= 1) return 'sap-tier-1';
  if (tier === 2) return 'sap-tier-2';
  return 'sap-tier-3';
}

function ctaForSignal(type: SignalAlert['signalType']): string {
  switch (type) {
    case 'executive_hire':
    case 'hiring_surge':
      return 'Draft Icebreaker';
    default:
      return 'View Full Detail';
  }
}

function ctaActionKey(type: SignalAlert['signalType']): string {
  switch (type) {
    case 'executive_hire':
    case 'hiring_surge':
      return 'draft_icebreaker';
    default:
      return 'view_detail';
  }
}

// ---------------------------------------------------------------------------
// SignalAlertsPanel
// ---------------------------------------------------------------------------

export class SignalAlertsPanel {
  private container: HTMLElement | null = null;
  private root: HTMLElement | null = null;
  private signals: SignalAlert[] = [];
  private activeFilter: FilterTab = 'all';
  private actionCallback: ((action: string, signalId: string) => void) | null = null;

  // Sidebar settings state
  private settings = {
    newHireEmail: true,
    fundingPush: true,
    weeklySummary: false,
  };

  constructor() {
    injectStyles();
  }

  // ---- Public API ----------------------------------------------------------

  public render(container: HTMLElement): void {
    this.container = container;
    this.root = document.createElement('div');
    this.root.className = 'sap-root';
    this.container.appendChild(this.root);
    this.update();
  }

  public destroy(): void {
    if (this.root && this.container?.contains(this.root)) {
      this.container.removeChild(this.root);
    }
    this.root = null;
    this.container = null;
    this.actionCallback = null;
  }

  public setSignals(signals: SignalAlert[]): void {
    this.signals = signals;
    this.update();
  }

  public onAction(callback: (action: string, signalId: string) => void): void {
    this.actionCallback = callback;
  }

  // ---- Internal rendering --------------------------------------------------

  private update(): void {
    if (!this.root) return;
    this.root.innerHTML = '';

    // Main column
    const main = document.createElement('div');
    main.className = 'sap-main';
    main.appendChild(this.buildFilterTabs());
    main.appendChild(this.buildCardList());
    this.root.appendChild(main);

    // Sidebar
    this.root.appendChild(this.buildSidebar());
  }

  // ---- Filter tabs ---------------------------------------------------------

  private buildFilterTabs(): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'sap-filters';

    for (const tab of FILTER_TABS) {
      const btn = document.createElement('button');
      btn.className = 'sap-filter-tab';
      btn.textContent = tab.label;
      btn.dataset.active = String(tab.key === this.activeFilter);
      btn.addEventListener('click', () => {
        this.activeFilter = tab.key;
        this.update();
      });
      wrap.appendChild(btn);
    }

    return wrap;
  }

  // ---- Card list -----------------------------------------------------------

  private filteredSignals(): SignalAlert[] {
    const list = this.signals.filter((s) => !s.dismissed);
    switch (this.activeFilter) {
      case 'high_priority':
        return list.filter((s) => s.strength === 'critical' || s.strength === 'high');
      case 'new_hires':
        return list.filter((s) => s.signalType === 'executive_hire' || s.signalType === 'hiring_surge');
      case 'funding':
        return list.filter((s) => s.signalType === 'funding');
      case 'tech_stack':
        return list.filter((s) => s.signalType === 'tech_stack');
      default:
        return list;
    }
  }

  private buildCardList(): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'sap-card-list';

    const visible = this.filteredSignals();

    if (visible.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'sap-empty';
      empty.innerHTML = `
        <div class="sap-empty-icon">&#x26A1;</div>
        <div>No signals match this filter.</div>
        <div style="font-size:12px;">Signals will appear here as new intelligence is detected.</div>
      `;
      wrap.appendChild(empty);
      return wrap;
    }

    for (const signal of visible) {
      wrap.appendChild(this.buildCard(signal));
    }

    return wrap;
  }

  private buildCard(signal: SignalAlert): HTMLElement {
    const card = document.createElement('div');
    card.className = 'sap-card';
    card.dataset.dismissed = String(signal.dismissed);

    const badge = SIGNAL_BADGE_MAP[signal.signalType] ?? {
      label: signal.signalType.toUpperCase().replace(/_/g, ' '),
      bg: '#334155',
      fg: '#e2e8f0',
    };

    // Header row: company + badge + strength dot
    const header = document.createElement('div');
    header.className = 'sap-card-header';
    header.innerHTML = `
      <span class="sap-company">${esc(signal.company)}</span>
      <span class="sap-signal-badge" style="background:${badge.bg};color:${badge.fg};">${esc(badge.label)}</span>
      <span class="sap-strength-dot" style="background:${STRENGTH_COLORS[signal.strength]}" title="${esc(signal.strength)}"></span>
    `;
    card.appendChild(header);

    // Timestamp
    const ts = document.createElement('div');
    ts.className = 'sap-timestamp';
    ts.textContent = relativeTime(signal.timestamp);
    card.appendChild(ts);

    // Summary
    const summary = document.createElement('div');
    summary.className = 'sap-summary';
    summary.textContent = signal.summary;
    card.appendChild(summary);

    // Source + tier
    const source = document.createElement('div');
    source.className = 'sap-source';
    source.innerHTML = `
      via ${esc(signal.source)}
      <span class="sap-source-tier ${tierClass(signal.sourceTier)}">${tierLabel(signal.sourceTier)}</span>
    `;
    card.appendChild(source);

    // Tags
    if (signal.tags.length > 0) {
      const tags = document.createElement('div');
      tags.className = 'sap-tags';
      for (const t of signal.tags) {
        const tag = document.createElement('span');
        tag.className = 'sap-tag';
        tag.textContent = t.startsWith('#') ? t : `#${t}`;
        tags.appendChild(tag);
      }
      card.appendChild(tags);
    }

    // Action buttons
    const actions = document.createElement('div');
    actions.className = 'sap-actions';

    const dismissBtn = document.createElement('button');
    dismissBtn.className = 'sap-btn sap-btn-ghost';
    dismissBtn.textContent = 'Dismiss';
    dismissBtn.addEventListener('click', () => {
      signal.dismissed = true;
      this.actionCallback?.('dismiss', signal.id);
      this.update();
    });
    actions.appendChild(dismissBtn);

    const ctaBtn = document.createElement('button');
    ctaBtn.className = 'sap-btn sap-btn-primary';
    ctaBtn.textContent = ctaForSignal(signal.signalType);
    ctaBtn.addEventListener('click', () => {
      this.actionCallback?.(ctaActionKey(signal.signalType), signal.id);
    });
    actions.appendChild(ctaBtn);

    card.appendChild(actions);

    return card;
  }

  // ---- Sidebar -------------------------------------------------------------

  private buildSidebar(): HTMLElement {
    const sidebar = document.createElement('div');
    sidebar.className = 'sap-sidebar';
    sidebar.appendChild(this.buildTrendsSection());
    sidebar.appendChild(this.buildIntentSection());
    sidebar.appendChild(this.buildSettingsSection());
    return sidebar;
  }

  private buildTrendsSection(): HTMLElement {
    const section = document.createElement('div');
    section.className = 'sap-sidebar-section';

    // Compute live counts from actual signals
    const hireCount = this.signals.filter(
      (s) => s.signalType === 'executive_hire' || s.signalType === 'hiring_surge',
    ).length;
    const fundingCount = this.signals.filter((s) => s.signalType === 'funding').length;

    section.innerHTML = `
      <div class="sap-sidebar-title">Alert Trends</div>
      <div class="sap-trend-row">
        <div>
          <div class="sap-trend-label">Hiring Signals</div>
        </div>
        <div>
          <span class="sap-trend-value">${hireCount}</span>
          <span class="sap-trend-delta sap-trend-up">+12%</span>
        </div>
      </div>
      <div class="sap-trend-row">
        <div>
          <div class="sap-trend-label">Funding Rounds</div>
        </div>
        <div>
          <span class="sap-trend-value">${fundingCount}</span>
          <span class="sap-trend-delta sap-trend-up">+8%</span>
        </div>
      </div>
    `;
    return section;
  }

  private buildIntentSection(): HTMLElement {
    const section = document.createElement('div');
    section.className = 'sap-sidebar-section';

    // Derive high-intent matches from the top 3 critical/high signals
    const topSignals = this.signals
      .filter((s) => !s.dismissed && (s.strength === 'critical' || s.strength === 'high'))
      .slice(0, 3);

    let matchesHtml = '';
    if (topSignals.length === 0) {
      matchesHtml = '<div style="font-size:12px;color:var(--sap-muted);">No high-intent matches yet.</div>';
    } else {
      matchesHtml = topSignals
        .map((s, i) => {
          const scores = [92, 87, 78];
          const score = scores[i] ?? 70;
          const intentType =
            s.signalType === 'executive_hire' || s.signalType === 'hiring_surge'
              ? 'Hiring'
              : s.signalType === 'funding'
                ? 'Funding'
                : s.signalType === 'expansion'
                  ? 'Expansion'
                  : s.signalType === 'tech_stack'
                    ? 'Tech Stack'
                    : 'Activity';
          return `
          <div class="sap-intent-row">
            <span class="sap-intent-company">${esc(s.company)}</span>
            <span class="sap-intent-type">${esc(intentType)}</span>
            <span class="sap-intent-score">${score}%</span>
          </div>
        `;
        })
        .join('');
    }

    section.innerHTML = `
      <div class="sap-sidebar-title">High-Intent Matches</div>
      ${matchesHtml}
    `;
    return section;
  }

  private buildSettingsSection(): HTMLElement {
    const section = document.createElement('div');
    section.className = 'sap-sidebar-section';

    const title = document.createElement('div');
    title.className = 'sap-sidebar-title';
    title.textContent = 'Signal Settings';
    section.appendChild(title);

    const toggles: Array<{ label: string; key: keyof typeof this.settings }> = [
      { label: 'New Hire Email Alerts', key: 'newHireEmail' },
      { label: 'Funding Push Notifications', key: 'fundingPush' },
      { label: 'Weekly Summary PDF', key: 'weeklySummary' },
    ];

    for (const toggle of toggles) {
      const row = document.createElement('div');
      row.className = 'sap-toggle-row';

      const label = document.createElement('span');
      label.className = 'sap-toggle-label';
      label.textContent = toggle.label;
      row.appendChild(label);

      const switchEl = document.createElement('label');
      switchEl.className = 'sap-toggle';

      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = this.settings[toggle.key];
      input.addEventListener('change', () => {
        this.settings[toggle.key] = input.checked;
      });

      const track = document.createElement('span');
      track.className = 'sap-toggle-track';

      const thumb = document.createElement('span');
      thumb.className = 'sap-toggle-thumb';

      switchEl.appendChild(input);
      switchEl.appendChild(track);
      switchEl.appendChild(thumb);
      row.appendChild(switchEl);

      section.appendChild(row);
    }

    return section;
  }
}
