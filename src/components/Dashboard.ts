/**
 * Dashboard -- Main SalesIntel dashboard page.
 *
 * Vanilla TypeScript DOM component. No framework dependencies.
 * Renders a hero search section, feature pills, and recent intelligence
 * report cards in a dark, glassmorphism-accented layout.
 */

const STYLE_ID = 'salesintel-dashboard-styles';

const STYLES = `
  .si-dashboard {
    font-family: Inter, system-ui, -apple-system, sans-serif;
    background: #0A0F1C;
    color: #e2e8f0;
    min-height: 100vh;
    padding: 48px 24px 64px;
    box-sizing: border-box;
  }

  .si-dashboard *,
  .si-dashboard *::before,
  .si-dashboard *::after {
    box-sizing: border-box;
  }

  /* ---- Hero Search ---- */

  .si-hero {
    max-width: 720px;
    margin: 0 auto 32px;
  }

  .si-search-card {
    background: rgba(15, 23, 42, 0.8);
    border: 1px solid #1E293B;
    border-radius: 16px;
    padding: 24px;
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
  }

  .si-search-row {
    display: flex;
    gap: 12px;
    align-items: stretch;
  }

  .si-search-input {
    flex: 1;
    min-width: 0;
    height: 44px;
    padding: 0 16px;
    background: #0A0F1C;
    border: 1px solid #1E293B;
    border-radius: 8px;
    color: #e2e8f0;
    font-family: inherit;
    font-size: 14px;
    outline: none;
    transition: border-color 0.15s;
  }

  .si-search-input::placeholder {
    color: #64748b;
  }

  .si-search-input:focus {
    border-color: #3B82F6;
  }

  .si-search-btn {
    flex-shrink: 0;
    height: 44px;
    padding: 0 20px;
    background: #3B82F6;
    color: #fff;
    border: none;
    border-radius: 8px;
    font-family: inherit;
    font-size: 14px;
    font-weight: 500;
    cursor: pointer;
    white-space: nowrap;
    transition: background 0.15s;
  }

  .si-search-btn:hover {
    background: #2563EB;
  }

  .si-search-btn:active {
    background: #1D4ED8;
  }

  /* ---- Feature Pills ---- */

  .si-pills {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    max-width: 720px;
    margin: 0 auto 48px;
    justify-content: center;
  }

  .si-pill {
    display: inline-block;
    padding: 4px 12px;
    background: rgba(30, 41, 59, 0.6);
    border: 1px solid #1E293B;
    border-radius: 100px;
    font-size: 12px;
    color: #94a3b8;
    line-height: 1.5;
    white-space: nowrap;
  }

  /* ---- Reports Section ---- */

  .si-reports {
    max-width: 720px;
    margin: 0 auto;
  }

  .si-reports-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 16px;
  }

  .si-reports-title {
    font-size: 16px;
    font-weight: 600;
    color: #e2e8f0;
    margin: 0;
  }

  .si-reports-link {
    font-size: 13px;
    color: #3B82F6;
    text-decoration: none;
    cursor: pointer;
  }

  .si-reports-link:hover {
    text-decoration: underline;
  }

  .si-reports-list {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  /* ---- Report Card ---- */

  .si-report-card {
    background: #0f172a;
    border: 1px solid #1E293B;
    border-radius: 12px;
    padding: 20px 24px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    transition: border-color 0.15s;
  }

  .si-report-card:hover {
    border-color: #334155;
  }

  .si-report-info {
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-width: 0;
  }

  .si-report-name {
    font-size: 15px;
    font-weight: 600;
    color: #e2e8f0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .si-report-time {
    font-size: 12px;
    color: #64748b;
  }

  .si-report-badges {
    display: flex;
    gap: 8px;
    flex-shrink: 0;
    align-items: center;
  }

  .si-badge {
    display: inline-flex;
    align-items: center;
    padding: 3px 10px;
    border-radius: 100px;
    font-size: 11px;
    font-weight: 500;
    line-height: 1.4;
    white-space: nowrap;
  }

  .si-badge--industry {
    background: rgba(59, 130, 246, 0.12);
    color: #60A5FA;
    border: 1px solid rgba(59, 130, 246, 0.2);
  }

  .si-badge--signals {
    background: rgba(16, 185, 129, 0.12);
    color: #34D399;
    border: 1px solid rgba(16, 185, 129, 0.2);
  }

  /* ---- Responsive ---- */

  @media (max-width: 600px) {
    .si-dashboard {
      padding: 32px 16px 48px;
    }

    .si-search-row {
      flex-direction: column;
    }

    .si-search-btn {
      width: 100%;
    }

    .si-report-card {
      flex-direction: column;
      align-items: flex-start;
    }
  }
`;

interface ReportItem {
  company: string;
  timeAgo: string;
  industry: string;
  signals: number;
}

const PLACEHOLDER_REPORTS: ReportItem[] = [
  { company: 'Meridian Systems', timeAgo: '12 min ago', industry: 'Enterprise SaaS', signals: 14 },
  { company: 'Arctura Holdings', timeAgo: '28 min ago', industry: 'Financial Services', signals: 9 },
  { company: 'Vectrix Labs', timeAgo: '1 hr ago', industry: 'AI / ML', signals: 22 },
  { company: 'Northvane Energy', timeAgo: '2 hr ago', industry: 'Clean Energy', signals: 7 },
  { company: 'Crestline Biotech', timeAgo: '3 hr ago', industry: 'Biotech', signals: 11 },
];

const FEATURE_PILLS: string[] = [
  'Pro Tip: Search by domain for instant enrichment',
  'C-Level Mapping available for Enterprise accounts',
  'Signal Boost: Track 10+ signals for convergence alerts',
];

export class Dashboard {
  private root: HTMLElement;
  private companyInput: HTMLInputElement;
  private emailInput: HTMLInputElement;
  private searchBtn: HTMLButtonElement;
  private searchCallback: ((company: string, email: string) => void) | null = null;
  private styleElement: HTMLStyleElement | null = null;

  constructor() {
    // ---- Root ----
    this.root = document.createElement('div');
    this.root.className = 'si-dashboard';

    // ---- Inject styles ----
    this.injectStyles();

    // ---- Hero Search ----
    const hero = document.createElement('section');
    hero.className = 'si-hero';

    const searchCard = document.createElement('div');
    searchCard.className = 'si-search-card';

    const searchRow = document.createElement('div');
    searchRow.className = 'si-search-row';

    this.companyInput = document.createElement('input');
    this.companyInput.type = 'text';
    this.companyInput.className = 'si-search-input';
    this.companyInput.placeholder = 'Company name...';

    this.emailInput = document.createElement('input');
    this.emailInput.type = 'text';
    this.emailInput.className = 'si-search-input';
    this.emailInput.placeholder = 'Contact email...';

    this.searchBtn = document.createElement('button');
    this.searchBtn.type = 'button';
    this.searchBtn.className = 'si-search-btn';
    this.searchBtn.textContent = 'Search Intelligence';

    this.searchBtn.addEventListener('click', () => this.handleSearch());

    // Allow Enter key from either input to trigger search
    const onEnter = (e: KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.handleSearch();
      }
    };
    this.companyInput.addEventListener('keydown', onEnter);
    this.emailInput.addEventListener('keydown', onEnter);

    searchRow.appendChild(this.companyInput);
    searchRow.appendChild(this.emailInput);
    searchRow.appendChild(this.searchBtn);
    searchCard.appendChild(searchRow);
    hero.appendChild(searchCard);
    this.root.appendChild(hero);

    // ---- Feature Pills ----
    const pills = document.createElement('div');
    pills.className = 'si-pills';
    for (const text of FEATURE_PILLS) {
      const pill = document.createElement('span');
      pill.className = 'si-pill';
      pill.textContent = text;
      pills.appendChild(pill);
    }
    this.root.appendChild(pills);

    // ---- Recent Intelligence Reports ----
    const reports = document.createElement('section');
    reports.className = 'si-reports';

    const reportsHeader = document.createElement('div');
    reportsHeader.className = 'si-reports-header';

    const reportsTitle = document.createElement('h2');
    reportsTitle.className = 'si-reports-title';
    reportsTitle.textContent = 'Recent Intelligence Reports';

    const viewAll = document.createElement('a');
    viewAll.className = 'si-reports-link';
    viewAll.textContent = 'View All';
    viewAll.href = '#';
    viewAll.addEventListener('click', (e) => e.preventDefault());

    reportsHeader.appendChild(reportsTitle);
    reportsHeader.appendChild(viewAll);
    reports.appendChild(reportsHeader);

    const reportsList = document.createElement('div');
    reportsList.className = 'si-reports-list';

    for (const item of PLACEHOLDER_REPORTS) {
      reportsList.appendChild(this.createReportCard(item));
    }

    reports.appendChild(reportsList);
    this.root.appendChild(reports);
  }

  /**
   * Register a callback that fires when the user clicks "Search Intelligence"
   * or presses Enter in either input field.
   */
  public onSearch(callback: (company: string, email: string) => void): void {
    this.searchCallback = callback;
  }

  /**
   * Mount the dashboard into a container element.
   */
  public render(container: HTMLElement): void {
    container.appendChild(this.root);
  }

  /**
   * Remove the dashboard from the DOM and clean up injected styles.
   */
  public destroy(): void {
    this.root.remove();
    if (this.styleElement && this.styleElement.parentNode) {
      this.styleElement.remove();
      this.styleElement = null;
    }
    this.searchCallback = null;
  }

  // ---- Private helpers ----

  private handleSearch(): void {
    const company = this.companyInput.value.trim();
    const email = this.emailInput.value.trim();
    if (this.searchCallback) {
      this.searchCallback(company, email);
    }
  }

  private injectStyles(): void {
    if (document.getElementById(STYLE_ID)) return;
    this.styleElement = document.createElement('style');
    this.styleElement.id = STYLE_ID;
    this.styleElement.textContent = STYLES;
    document.head.appendChild(this.styleElement);
  }

  private createReportCard(item: ReportItem): HTMLElement {
    const card = document.createElement('div');
    card.className = 'si-report-card';

    const info = document.createElement('div');
    info.className = 'si-report-info';

    const name = document.createElement('div');
    name.className = 'si-report-name';
    name.textContent = item.company;

    const time = document.createElement('div');
    time.className = 'si-report-time';
    time.textContent = item.timeAgo;

    info.appendChild(name);
    info.appendChild(time);

    const badges = document.createElement('div');
    badges.className = 'si-report-badges';

    const industryBadge = document.createElement('span');
    industryBadge.className = 'si-badge si-badge--industry';
    industryBadge.textContent = item.industry;

    const signalBadge = document.createElement('span');
    signalBadge.className = 'si-badge si-badge--signals';
    signalBadge.textContent = `${item.signals} signals`;

    badges.appendChild(industryBadge);
    badges.appendChild(signalBadge);

    card.appendChild(info);
    card.appendChild(badges);

    return card;
  }
}
