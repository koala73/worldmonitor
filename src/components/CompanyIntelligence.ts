/**
 * CompanyIntelligence -- Full intelligence dossier detail page for a single company.
 *
 * Part of the SalesIntel module. Renders company header, C-level executive cards,
 * active triggers, engagement opportunities, activity timeline, and quick
 * recommendations. Vanilla TypeScript with direct DOM manipulation.
 */

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

export interface Executive {
  name: string;
  title: string;
  quote?: string;
  quoteSource?: string;
  photoUrl?: string;
}

export interface Trigger {
  label: string;
  type: 'new' | 'detected';
  description: string;
  actionText?: string;
  actionLink?: string;
}

export interface SocialPost {
  author: string;
  authorTitle?: string;
  preview: string;
  likes: number;
  comments: number;
  shares: number;
  timestamp?: string;
}

export interface TimelineEvent {
  date: string;
  title: string;
  description: string;
}

export interface CompanyIntelData {
  name: string;
  domain?: string;
  category: string;
  location: string;
  employeeRange: string;
  fundingStage: string;
  website?: string;
  executives: Executive[];
  triggers: Trigger[];
  socialPosts: SocialPost[];
  icebreakers: string[];
  timeline: TimelineEvent[];
  accountHealthScore: number;
}

// ---------------------------------------------------------------------------
// Palette
// ---------------------------------------------------------------------------

const C = {
  pageBg:     '#0A0F1C',
  cardBg:     '#0f172a',
  nestedBg:   '#111827',
  border:     '#1E293B',
  text:       '#e2e8f0',
  secondary:  '#94a3b8',
  muted:      '#64748b',
  accent:     '#3B82F6',
  accentHov:  '#2563EB',
  green:      '#22C55E',
  greenDim:   '#166534',
  blueDim:    '#1e3a5f',
} as const;

// ---------------------------------------------------------------------------
// Style injection
// ---------------------------------------------------------------------------

const STYLE_ID = 'ci-intelligence-styles';

function injectStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
/* ── Page wrapper ──────────────────────────────────────────────────────── */
.ci-page {
  background: ${C.pageBg};
  color: ${C.text};
  font-family: -apple-system, BlinkMacSystemFont, 'Inter', 'Segoe UI', Roboto, sans-serif;
  padding: 32px 40px;
  min-height: 100vh;
  box-sizing: border-box;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}
.ci-page *, .ci-page *::before, .ci-page *::after { box-sizing: border-box; }

/* ── Section titles ────────────────────────────────────────────────────── */
.ci-section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 16px;
}
.ci-section-title {
  font-size: 16px;
  font-weight: 600;
  color: ${C.text};
  letter-spacing: 0.01em;
}
.ci-section-link {
  font-size: 12px;
  color: ${C.accent};
  cursor: pointer;
  text-decoration: none;
  font-weight: 500;
  transition: color 0.15s;
}
.ci-section-link:hover { color: ${C.accentHov}; }
.ci-section { margin-bottom: 32px; }

/* ── Company Header Card ──────────────────────────────────────────────── */
.ci-header-card {
  background: ${C.cardBg};
  border: 1px solid ${C.border};
  border-radius: 14px;
  padding: 28px 32px;
  margin-bottom: 32px;
  display: flex;
  align-items: flex-start;
  gap: 24px;
}
.ci-logo {
  width: 64px;
  height: 64px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 26px;
  font-weight: 700;
  color: #fff;
  flex-shrink: 0;
  letter-spacing: -0.02em;
}
.ci-header-info { flex: 1; min-width: 0; }
.ci-company-name {
  font-size: 24px;
  font-weight: 600;
  color: ${C.text};
  margin: 0 0 8px;
  line-height: 1.2;
}
.ci-badges { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 10px; }
.ci-badge {
  display: inline-flex;
  align-items: center;
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  padding: 3px 10px;
  border-radius: 999px;
  line-height: 1.4;
}
.ci-badge--category { background: ${C.accent}; color: #fff; }
.ci-badge--funding { background: ${C.blueDim}; color: ${C.accent}; border: 1px solid ${C.accent}33; }
.ci-meta-line {
  font-size: 14px;
  color: ${C.secondary};
  margin: 2px 0;
  line-height: 1.5;
}
.ci-header-actions {
  display: flex;
  gap: 10px;
  flex-shrink: 0;
  align-self: center;
}
.ci-btn {
  font-size: 13px;
  font-weight: 500;
  padding: 9px 18px;
  border-radius: 8px;
  cursor: pointer;
  border: none;
  transition: background 0.15s, border-color 0.15s, transform 0.1s;
  white-space: nowrap;
  letter-spacing: 0.01em;
}
.ci-btn:active { transform: scale(0.97); }
.ci-btn--outline {
  background: transparent;
  border: 1px solid ${C.border};
  color: ${C.text};
}
.ci-btn--outline:hover { border-color: ${C.secondary}; }
.ci-btn--filled {
  background: ${C.accent};
  color: #fff;
}
.ci-btn--filled:hover { background: ${C.accentHov}; }

/* ── C-Level Cards ─────────────────────────────────────────────────────── */
.ci-exec-scroll {
  display: flex;
  gap: 14px;
  overflow-x: auto;
  padding-bottom: 6px;
  scrollbar-width: thin;
  scrollbar-color: ${C.border} transparent;
}
.ci-exec-scroll::-webkit-scrollbar { height: 6px; }
.ci-exec-scroll::-webkit-scrollbar-thumb { background: ${C.border}; border-radius: 3px; }
.ci-exec-scroll::-webkit-scrollbar-track { background: transparent; }
.ci-exec-card {
  background: ${C.nestedBg};
  border: 1px solid ${C.border};
  border-radius: 12px;
  padding: 18px 20px;
  min-width: 270px;
  max-width: 310px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
  transition: border-color 0.15s;
}
.ci-exec-card:hover { border-color: ${C.accent}44; }
.ci-exec-top { display: flex; align-items: center; gap: 12px; }
.ci-exec-photo {
  width: 48px;
  height: 48px;
  border-radius: 50%;
  background: ${C.border};
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 18px;
  font-weight: 600;
  color: ${C.secondary};
  flex-shrink: 0;
}
.ci-exec-name { font-size: 14px; font-weight: 700; color: ${C.text}; line-height: 1.3; }
.ci-exec-title { font-size: 12px; color: ${C.muted}; line-height: 1.4; }
.ci-exec-quote {
  font-size: 13px;
  font-style: italic;
  color: #cbd5e1;
  line-height: 1.5;
  border-left: 2px solid ${C.accent}44;
  padding-left: 10px;
  margin: 0;
}
.ci-exec-source {
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: ${C.muted};
  padding: 2px 8px;
  background: ${C.pageBg};
  border-radius: 4px;
  align-self: flex-start;
}

/* ── Triggers ──────────────────────────────────────────────────────────── */
.ci-triggers-row { display: flex; gap: 14px; flex-wrap: wrap; }
.ci-trigger-card {
  background: ${C.nestedBg};
  border: 1px solid ${C.border};
  border-radius: 12px;
  padding: 18px 20px;
  flex: 1 1 260px;
  max-width: 380px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  transition: border-color 0.15s;
}
.ci-trigger-card:hover { border-color: ${C.accent}44; }
.ci-trigger-badge {
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  padding: 3px 10px;
  border-radius: 999px;
  align-self: flex-start;
}
.ci-trigger-badge--new { background: ${C.greenDim}; color: ${C.green}; }
.ci-trigger-badge--detected { background: ${C.blueDim}; color: ${C.accent}; }
.ci-trigger-desc { font-size: 14px; color: ${C.text}; line-height: 1.55; }
.ci-trigger-action {
  font-size: 12px;
  font-weight: 600;
  color: ${C.accent};
  cursor: pointer;
  text-decoration: none;
  transition: color 0.15s;
  align-self: flex-start;
}
.ci-trigger-action:hover { color: ${C.accentHov}; }

/* ── Engagement ────────────────────────────────────────────────────────── */
.ci-engagement-grid { display: flex; gap: 20px; flex-wrap: wrap; }
.ci-social-card {
  background: ${C.nestedBg};
  border: 1px solid ${C.border};
  border-radius: 12px;
  padding: 20px 22px;
  flex: 1 1 320px;
  max-width: 480px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.ci-social-author { font-size: 14px; font-weight: 600; color: ${C.text}; }
.ci-social-author-title { font-size: 12px; color: ${C.muted}; margin-top: 1px; }
.ci-social-preview {
  font-size: 13px;
  color: ${C.secondary};
  line-height: 1.55;
  border-left: 2px solid ${C.border};
  padding-left: 12px;
}
.ci-social-metrics {
  display: flex;
  gap: 16px;
  font-size: 12px;
  color: ${C.muted};
}
.ci-social-metric {
  display: flex;
  align-items: center;
  gap: 5px;
}
.ci-social-metric svg { width: 14px; height: 14px; fill: none; stroke: ${C.muted}; stroke-width: 1.8; }
.ci-icebreakers-card {
  background: ${C.nestedBg};
  border: 1px solid ${C.border};
  border-radius: 12px;
  padding: 20px 22px;
  flex: 1 1 280px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.ci-icebreaker-label {
  font-size: 13px;
  font-weight: 600;
  color: ${C.text};
  letter-spacing: 0.01em;
}
.ci-icebreaker-block {
  font-size: 13px;
  color: ${C.secondary};
  line-height: 1.55;
  background: ${C.pageBg};
  border-radius: 8px;
  padding: 12px 14px;
  border-left: 3px solid ${C.accent}66;
}
.ci-btn--draft { margin-top: 4px; align-self: flex-start; }

/* ── Timeline ──────────────────────────────────────────────────────────── */
.ci-timeline { position: relative; padding-left: 28px; }
.ci-timeline::before {
  content: '';
  position: absolute;
  left: 7px;
  top: 6px;
  bottom: 24px;
  width: 2px;
  background: ${C.border};
  border-radius: 1px;
}
.ci-timeline-entry {
  position: relative;
  padding-bottom: 22px;
}
.ci-timeline-entry:last-child { padding-bottom: 0; }
.ci-timeline-dot {
  position: absolute;
  left: -24px;
  top: 5px;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: ${C.accent};
  border: 2px solid ${C.pageBg};
  box-shadow: 0 0 0 2px ${C.accent}44;
}
.ci-timeline-date {
  font-size: 11px;
  color: ${C.muted};
  margin-bottom: 3px;
  letter-spacing: 0.02em;
}
.ci-timeline-title {
  font-size: 14px;
  font-weight: 600;
  color: ${C.text};
  margin-bottom: 2px;
  line-height: 1.35;
}
.ci-timeline-desc {
  font-size: 13px;
  color: ${C.secondary};
  line-height: 1.5;
}
.ci-timeline-more {
  margin-top: 14px;
  padding-left: 0;
}

/* ── Quick Recommendations ─────────────────────────────────────────────── */
.ci-recs { display: flex; gap: 12px; flex-wrap: wrap; }
.ci-rec-card {
  background: ${C.nestedBg};
  border: 1px solid ${C.border};
  border-radius: 10px;
  padding: 14px 18px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  cursor: pointer;
  flex: 1 1 220px;
  max-width: 320px;
  transition: border-color 0.15s, background 0.15s;
}
.ci-rec-card:hover { border-color: ${C.accent}66; background: ${C.cardBg}; }
.ci-rec-label { font-size: 13px; font-weight: 500; color: ${C.text}; }
.ci-rec-arrow {
  width: 18px;
  height: 18px;
  flex-shrink: 0;
  stroke: ${C.accent};
  fill: none;
  stroke-width: 2;
}

/* ── Responsive ────────────────────────────────────────────────────────── */
@media (max-width: 720px) {
  .ci-page { padding: 20px 16px; }
  .ci-header-card { flex-direction: column; gap: 16px; }
  .ci-header-actions { align-self: flex-start; }
  .ci-engagement-grid { flex-direction: column; }
  .ci-triggers-row { flex-direction: column; }
  .ci-trigger-card, .ci-social-card { max-width: 100%; }
}
`;
  document.head.appendChild(style);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function esc(str: string): string {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

function initialColor(name: string): string {
  const colors = ['#3B82F6', '#8B5CF6', '#EC4899', '#F59E0B', '#10B981', '#EF4444', '#6366F1'];
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return colors[Math.abs(hash) % colors.length];
}

function svgHeart(): string {
  return `<svg viewBox="0 0 24 24"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 1 0-7.78 7.78L12 21.23l8.84-8.84a5.5 5.5 0 0 0 0-7.78z"/></svg>`;
}

function svgComment(): string {
  return `<svg viewBox="0 0 24 24"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`;
}

function svgShare(): string {
  return `<svg viewBox="0 0 24 24"><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/></svg>`;
}

function svgArrow(): string {
  return `<svg class="ci-rec-arrow" viewBox="0 0 24 24"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>`;
}

// ---------------------------------------------------------------------------
// Default data
// ---------------------------------------------------------------------------

function defaultData(): CompanyIntelData {
  return {
    name: 'Acme Corp',
    category: 'ENTERPRISE SAAS',
    location: 'San Francisco, CA',
    employeeRange: '1,000 - 5,000 employees',
    fundingStage: 'Series C',
    executives: [
      {
        name: 'Sarah Chen',
        title: 'Chief Executive Officer',
        quote: 'We are doubling down on our enterprise cloud strategy this quarter across all EMEA markets.',
        quoteSource: 'MENTIONED IN EARNINGS CALL',
      },
      {
        name: 'James Rodriguez',
        title: 'Chief Technology Officer',
        quote: 'Our migration to a microservices architecture is 80% complete and ahead of schedule.',
        quoteSource: 'POSTED 2H AGO',
      },
      {
        name: 'Emily Nakamura',
        title: 'Chief Revenue Officer',
        quote: 'We are seeing 40% YoY growth in mid-market and plan to expand the SDR team by Q3.',
        quoteSource: 'MENTIONED IN EARNINGS CALL',
      },
      {
        name: 'David Park',
        title: 'Chief Financial Officer',
        quote: 'Path to profitability is clear with current unit economics. Targeting break-even by Q4.',
        quoteSource: 'POSTED 5H AGO',
      },
    ],
    triggers: [
      {
        label: 'New',
        type: 'new',
        description: 'Company announced expansion into EMEA markets with a new London office opening Q2.',
        actionText: 'EMEA CLOUD PLAY \u2192',
      },
      {
        label: 'Detected',
        type: 'detected',
        description: 'Job postings indicate adoption of Kubernetes and migration away from legacy infrastructure.',
        actionText: 'VIEW TECH STACK \u2192',
      },
      {
        label: 'New',
        type: 'new',
        description: 'Recent patent filing for AI-powered analytics platform targeting financial services.',
        actionText: 'VIEW PATENT \u2192',
      },
    ],
    socialPosts: [
      {
        author: 'Sarah Chen',
        authorTitle: 'CEO at Acme Corp',
        preview:
          'Thrilled to announce our Series C! This funding will accelerate our mission to transform enterprise workflows with AI-first tools. Huge thanks to our incredible team and customers who made this possible.',
        likes: 1243,
        comments: 87,
        shares: 312,
        timestamp: '2h ago',
      },
    ],
    icebreakers: [
      'Congrats on the Series C, Sarah! Your comments about the EMEA expansion caught my eye \u2014 we have helped several companies navigate that exact cloud migration journey. Would love to share some insights over a quick call.',
      'Hi Sarah \u2014 saw your post about AI-first enterprise tools. We have been working on something adjacent and I think there could be a strong synergy. Happy to share a brief case study from a similar deployment.',
    ],
    timeline: [
      {
        date: 'Mar 1, 2026',
        title: 'Series C Announced',
        description: '$120M round led by Sequoia Capital at $1.2B valuation.',
      },
      {
        date: 'Feb 18, 2026',
        title: 'EMEA Office Opening',
        description: 'New London office to serve European enterprise clients.',
      },
      {
        date: 'Feb 3, 2026',
        title: 'Product Launch',
        description: 'Released AI Analytics Suite v3.0 with real-time dashboards.',
      },
      {
        date: 'Jan 15, 2026',
        title: 'Key Hire',
        description: 'Emily Nakamura joined as CRO from Salesforce.',
      },
      {
        date: 'Dec 20, 2025',
        title: 'Partnership',
        description: 'Strategic alliance with AWS for co-sell program.',
      },
    ],
    accountHealthScore: 82,
    domain: 'acmecorp.io',
    website: 'https://acmecorp.io',
  };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export class CompanyIntelligence {
  private container: HTMLElement | null = null;
  private root: HTMLElement | null = null;
  private data: CompanyIntelData;

  constructor() {
    this.data = defaultData();
  }

  // ── Public API ──────────────────────────────────────────────────────────

  public setCompanyData(data: CompanyIntelData): void {
    this.data = data;
    if (this.container) {
      this.renderContent();
    }
  }

  public render(container: HTMLElement): void {
    injectStyles();
    this.container = container;
    this.renderContent();
  }

  public destroy(): void {
    if (this.root && this.container) {
      this.container.removeChild(this.root);
    }
    this.root = null;
    this.container = null;
  }

  // ── Internal rendering ──────────────────────────────────────────────────

  private renderContent(): void {
    if (!this.container) return;

    if (this.root) {
      this.container.removeChild(this.root);
    }

    const page = document.createElement('div');
    page.className = 'ci-page';
    this.root = page;

    page.innerHTML = [
      this.buildHeader(),
      this.buildCLevel(),
      this.buildTriggers(),
      this.buildEngagement(),
      this.buildTimeline(),
      this.buildRecommendations(),
    ].join('');

    this.container.appendChild(page);
    this.attachListeners();
  }

  // ── 1. Company Header ──────────────────────────────────────────────────

  private buildHeader(): string {
    const d = this.data;
    const initial = d.name.charAt(0).toUpperCase();
    const color = initialColor(d.name);

    return `
<div class="ci-header-card">
  <div class="ci-logo" style="background:${color}">${esc(initial)}</div>
  <div class="ci-header-info">
    <h1 class="ci-company-name">${esc(d.name)}</h1>
    <div class="ci-badges">
      <span class="ci-badge ci-badge--category">${esc(d.category)}</span>
      <span class="ci-badge ci-badge--funding">${esc(d.fundingStage)}</span>
    </div>
    <div class="ci-meta-line">${esc(d.location)}</div>
    <div class="ci-meta-line">${esc(d.employeeRange)}</div>
  </div>
  <div class="ci-header-actions">
    <button class="ci-btn ci-btn--outline" data-action="watchlist">Add to Watchlist</button>
    <button class="ci-btn ci-btn--filled" data-action="export-crm">Export CRM Data</button>
  </div>
</div>`;
  }

  // ── 2. C-Level Intelligence ─────────────────────────────────────────────

  private buildCLevel(): string {
    const cards = this.data.executives
      .map((ex) => {
        const initial = ex.name.charAt(0).toUpperCase();
        const quoteHtml = ex.quote
          ? `<p class="ci-exec-quote">\u201C${esc(ex.quote)}\u201D</p>`
          : '';
        const sourceHtml = ex.quoteSource
          ? `<span class="ci-exec-source">${esc(ex.quoteSource)}</span>`
          : '';

        return `
<div class="ci-exec-card">
  <div class="ci-exec-top">
    <div class="ci-exec-photo">${esc(initial)}</div>
    <div>
      <div class="ci-exec-name">${esc(ex.name)}</div>
      <div class="ci-exec-title">${esc(ex.title)}</div>
    </div>
  </div>
  ${quoteHtml}
  ${sourceHtml}
</div>`;
      })
      .join('');

    return `
<div class="ci-section">
  <div class="ci-section-header">
    <span class="ci-section-title">C-Level Intelligence</span>
    <a class="ci-section-link" data-action="org-chart">View Org Chart</a>
  </div>
  <div class="ci-exec-scroll">${cards}</div>
</div>`;
  }

  // ── 3. Active Triggers ──────────────────────────────────────────────────

  private buildTriggers(): string {
    const cards = this.data.triggers
      .map((tr) => {
        const badgeClass =
          tr.type === 'new' ? 'ci-trigger-badge--new' : 'ci-trigger-badge--detected';
        const label = tr.type === 'new' ? 'NEW' : 'DETECTED';
        const actionHtml = tr.actionText
          ? `<a class="ci-trigger-action">${esc(tr.actionText)}</a>`
          : '';

        return `
<div class="ci-trigger-card">
  <span class="ci-trigger-badge ${badgeClass}">${label}</span>
  <div class="ci-trigger-desc">${esc(tr.description)}</div>
  ${actionHtml}
</div>`;
      })
      .join('');

    return `
<div class="ci-section">
  <div class="ci-section-header">
    <span class="ci-section-title">Active Triggers</span>
  </div>
  <div class="ci-triggers-row">${cards}</div>
</div>`;
  }

  // ── 4. Engagement Opportunities ─────────────────────────────────────────

  private buildEngagement(): string {
    const post = this.data.socialPosts[0];
    const postHtml = post
      ? `
<div class="ci-social-card">
  <div>
    <div class="ci-social-author">${esc(post.author)}</div>
    ${post.authorTitle ? `<div class="ci-social-author-title">${esc(post.authorTitle)}</div>` : ''}
  </div>
  <div class="ci-social-preview">${esc(post.preview)}</div>
  <div class="ci-social-metrics">
    <span class="ci-social-metric">${svgHeart()} ${post.likes.toLocaleString()}</span>
    <span class="ci-social-metric">${svgComment()} ${post.comments.toLocaleString()}</span>
    <span class="ci-social-metric">${svgShare()} ${post.shares.toLocaleString()}</span>
  </div>
</div>`
      : '';

    const icebreakersHtml = this.data.icebreakers
      .map((ib) => `<div class="ci-icebreaker-block">${esc(ib)}</div>`)
      .join('');

    return `
<div class="ci-section">
  <div class="ci-section-header">
    <span class="ci-section-title">Engagement Opportunities</span>
  </div>
  <div class="ci-engagement-grid">
    ${postHtml}
    <div class="ci-icebreakers-card">
      <span class="ci-icebreaker-label">AI Icebreakers</span>
      ${icebreakersHtml}
      <button class="ci-btn ci-btn--filled ci-btn--draft" data-action="draft-email">Draft Custom Email</button>
    </div>
  </div>
</div>`;
  }

  // ── 5. Timeline of Activity ─────────────────────────────────────────────

  private buildTimeline(): string {
    const entries = this.data.timeline
      .map(
        (ev) => `
<div class="ci-timeline-entry">
  <div class="ci-timeline-dot"></div>
  <div class="ci-timeline-date">${esc(ev.date)}</div>
  <div class="ci-timeline-title">${esc(ev.title)}</div>
  <div class="ci-timeline-desc">${esc(ev.description)}</div>
</div>`
      )
      .join('');

    return `
<div class="ci-section">
  <div class="ci-section-header">
    <span class="ci-section-title">Timeline of Activity</span>
  </div>
  <div class="ci-timeline">
    ${entries}
  </div>
  <a class="ci-section-link ci-timeline-more" data-action="full-history">View Full History</a>
</div>`;
  }

  // ── 6. Quick Recommendations ────────────────────────────────────────────

  private buildRecommendations(): string {
    const recs = [
      'Find SDRs at this company',
      'Request Case Study',
      'Compare with Competitors',
      'Schedule Intro Meeting',
    ];

    const cards = recs
      .map(
        (r) => `
<div class="ci-rec-card" data-action="rec" data-rec="${esc(r)}">
  <span class="ci-rec-label">${esc(r)}</span>
  ${svgArrow()}
</div>`
      )
      .join('');

    return `
<div class="ci-section">
  <div class="ci-section-header">
    <span class="ci-section-title">Quick Recommendations</span>
  </div>
  <div class="ci-recs">${cards}</div>
</div>`;
  }

  // ── Event wiring ────────────────────────────────────────────────────────

  private attachListeners(): void {
    if (!this.root) return;

    this.root.addEventListener('click', (e: Event) => {
      const target = e.target as HTMLElement;
      const actionEl = target.closest<HTMLElement>('[data-action]');
      if (!actionEl) return;

      const action = actionEl.dataset.action;
      switch (action) {
        case 'watchlist':
          actionEl.textContent = 'Added';
          actionEl.classList.remove('ci-btn--outline');
          actionEl.classList.add('ci-btn--filled');
          (actionEl as HTMLButtonElement).disabled = true;
          break;
        case 'export-crm':
          actionEl.textContent = 'Exporting\u2026';
          (actionEl as HTMLButtonElement).disabled = true;
          setTimeout(() => {
            actionEl.textContent = 'Exported';
          }, 1200);
          break;
        case 'draft-email':
          actionEl.textContent = 'Opening Editor\u2026';
          (actionEl as HTMLButtonElement).disabled = true;
          break;
        default:
          break;
      }
    });
  }
}
