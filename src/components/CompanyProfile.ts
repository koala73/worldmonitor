/**
 * Company Profile Component
 *
 * Full-screen overlay displaying detailed company information.
 * Accessed via /company/:id URL or View Company Profile button.
 */

import { escapeHtml, sanitizeUrl } from '@/utils/sanitize';
import { IRELAND_COMPANIES } from '@/data/ireland-companies';
import { IRISH_UNICORNS, type IrishUnicorn } from '@/config/variants/ireland/data/unicorns';
import { IRELAND_TECH_HQS, type IrelandTechHQ } from '@/config/variants/ireland/data/tech-hqs';
import { IRELAND_DATA_CENTERS, type IrelandDataCenter } from '@/config/variants/ireland/data/data-centers';
import { IRELAND_AI_COMPANIES, type IrelandAICompany } from '@/config/variants/ireland/data/ai-companies';
import { IRELAND_UNIVERSITIES, type IrelandUniversity } from '@/config/variants/ireland/data/universities';
import type { Company, CompanyIndustry, EmployeeRange, CompanyTag } from '@/types/company';
import { renderLogo } from '@/utils/logoFallback';

/**
 * Company Profile Manager
 *
 * Handles showing/hiding company profile overlay and URL routing.
 */
export class CompanyProfile {
  private container: HTMLElement | null = null;
  private isOpen = false;
  private popstateHandler: (() => void) | null = null;

  constructor() {
    this.checkInitialRoute();
    this.setupPopstateListener();
  }

  /**
   * Check URL on page load for /company/:id route
   */
  private checkInitialRoute(): void {
    const match = window.location.pathname.match(/^\/company\/([^/]+)$/);
    if (match && match[1]) {
      const companyId = decodeURIComponent(match[1]);
      this.show(companyId, false); // Don't push state on initial load
    }
  }

  /**
   * Listen for browser back/forward navigation
   */
  private setupPopstateListener(): void {
    this.popstateHandler = () => {
      const match = window.location.pathname.match(/^\/company\/([^/]+)$/);
      if (match && match[1]) {
        const companyId = decodeURIComponent(match[1]);
        this.show(companyId, false);
      } else {
        this.hide(false);
      }
    };
    window.addEventListener('popstate', this.popstateHandler);
  }

  /**
   * Show company profile for given ID
   */
  public show(companyId: string, pushState = true): void {
    const company = this.findCompany(companyId);

    // Create container if needed
    if (!this.container) {
      this.container = document.createElement('div');
      this.container.className = 'company-profile-overlay';
      document.body.appendChild(this.container);
    }

    // Render content
    this.container.innerHTML = company
      ? this.renderProfile(company)
      : this.renderNotFound(companyId);

    // Show overlay
    this.container.classList.add('open');
    this.isOpen = true;

    // Prevent body scroll
    document.body.style.overflow = 'hidden';

    // Update URL
    if (pushState) {
      window.history.pushState({ companyId }, '', `/company/${encodeURIComponent(companyId)}`);
    }

    // Setup close handlers
    this.setupCloseHandlers();
  }

  /**
   * Hide company profile
   */
  public hide(pushState = true): void {
    if (!this.container || !this.isOpen) return;

    this.container.classList.remove('open');
    this.isOpen = false;

    // Restore body scroll
    document.body.style.overflow = '';

    // Update URL back to map
    if (pushState) {
      window.history.pushState({}, '', '/');
    }
  }

  /**
   * Find company by ID or slug
   * Searches across multiple data sources:
   * 1. IRELAND_COMPANIES (detailed company profiles)
   * 2. IRISH_UNICORNS (unicorn/high-growth companies)
   * 3. IRELAND_TECH_HQS (multinational tech HQs)
   * 4. IRELAND_DATA_CENTERS (data center facilities)
   */
  private findCompany(id: string): Company | undefined {
    const lowerId = id.toLowerCase();

    // 1. Check main company database first
    const company = IRELAND_COMPANIES.find(
      c => c.id.toLowerCase() === lowerId || c.slug.toLowerCase() === lowerId
    );
    if (company) return company;

    // 2. Check Irish Unicorns and convert to Company type
    const unicorn = IRISH_UNICORNS.find(u => u.id.toLowerCase() === lowerId);
    if (unicorn) return this.convertUnicornToCompany(unicorn);

    // 3. Check Tech HQs and convert to Company type
    const techHQ = IRELAND_TECH_HQS.find(h => h.id.toLowerCase() === lowerId);
    if (techHQ) return this.convertTechHQToCompany(techHQ);

    // 4. Check Data Centers and convert to Company type
    const dataCenter = IRELAND_DATA_CENTERS.find(d => d.id.toLowerCase() === lowerId);
    if (dataCenter) return this.convertDataCenterToCompany(dataCenter);

    // 5. Check AI Companies and convert to Company type
    const aiCompany = IRELAND_AI_COMPANIES.find(a => a.id.toLowerCase() === lowerId);
    if (aiCompany) return this.convertAICompanyToCompany(aiCompany);

    // 6. Check Universities and convert to Company type
    const university = IRELAND_UNIVERSITIES.find(u => u.id.toLowerCase() === lowerId);
    if (university) return this.convertUniversityToCompany(university);

    return undefined;
  }

  /**
   * Convert IrishUnicorn to Company type
   */
  private convertUnicornToCompany(unicorn: IrishUnicorn): Company {
    // Map employee count to EmployeeRange
    const employeeRange = unicorn.employees
      ? this.mapEmployeeCount(unicorn.employees)
      : undefined;

    // Map category to tags
    const tags: CompanyTag[] = [];
    if (unicorn.category === 'unicorn') tags.push('unicorn');
    tags.push('irish-founded');

    return {
      id: unicorn.id,
      slug: unicorn.id,
      name: unicorn.name,
      description: unicorn.description,
      founded: unicorn.founded,
      headquarters: `${unicorn.location}, Ireland`,
      industry: this.mapSectorToIndustry(unicorn.sector),
      employeeCount: employeeRange,
      website: unicorn.website,
      tags,
      coordinates: [unicorn.lng, unicorn.lat],
      funding: unicorn.valuation ? { total: unicorn.valuation } : undefined,
    };
  }

  /**
   * Convert IrelandTechHQ to Company type
   */
  private convertTechHQToCompany(hq: IrelandTechHQ): Company {
    const employeeRange = hq.employees
      ? this.mapEmployeeCount(hq.employees)
      : undefined;

    return {
      id: hq.id,
      slug: hq.id,
      name: hq.company,
      description: hq.description,
      founded: hq.founded,
      headquarters: `${hq.location}, Ireland`,
      industry: 'Enterprise',
      employeeCount: employeeRange,
      website: hq.website,
      tags: ['tech-hq', 'multinational'],
      coordinates: [hq.lng, hq.lat],
      address: hq.address,
    };
  }

  /**
   * Convert IrelandDataCenter to Company type
   */
  private convertDataCenterToCompany(dc: IrelandDataCenter): Company {
    return {
      id: dc.id,
      slug: dc.id,
      name: dc.name,
      description: dc.description,
      headquarters: `${dc.location}, Ireland`,
      industry: 'Data Center',
      website: dc.website,
      tags: ['data-center'],
      coordinates: [dc.lng, dc.lat],
    };
  }

  /**
   * Convert IrelandAICompany to Company type
   */
  private convertAICompanyToCompany(ai: IrelandAICompany): Company {
    const employeeRange = ai.employees
      ? this.mapEmployeeCount(ai.employees)
      : undefined;

    return {
      id: ai.id,
      slug: ai.id,
      name: ai.name,
      description: ai.description,
      founded: ai.founded,
      headquarters: `${ai.location}, Ireland`,
      industry: 'AI/ML',
      employeeCount: employeeRange,
      website: ai.website,
      tags: ['ai-company'],
      coordinates: [ai.lng, ai.lat],
      address: ai.address,
    };
  }

  /**
   * Convert IrelandUniversity to Company type
   */
  private convertUniversityToCompany(uni: IrelandUniversity): Company {
    const employeeRange = uni.students
      ? this.mapEmployeeCount(uni.students)
      : undefined;

    return {
      id: uni.id,
      slug: uni.id,
      name: uni.name,
      description: uni.description,
      founded: uni.founded,
      headquarters: `${uni.location}, Ireland`,
      industry: 'Other',
      employeeCount: employeeRange,
      website: uni.website,
      tags: ['university' as CompanyTag],
      coordinates: [uni.lng, uni.lat],
    };
  }

  /**
   * Map employee count number to EmployeeRange
   */
  private mapEmployeeCount(count: number): EmployeeRange {
    if (count <= 10) return '1-10';
    if (count <= 50) return '11-50';
    if (count <= 200) return '51-200';
    if (count <= 500) return '201-500';
    if (count <= 1000) return '501-1000';
    if (count <= 5000) return '1001-5000';
    if (count <= 10000) return '5001-10000';
    return '10000+';
  }

  /**
   * Map sector string to CompanyIndustry type
   */
  private mapSectorToIndustry(sector: string): CompanyIndustry {
    const sectorMap: Record<string, CompanyIndustry> = {
      'SaaS': 'SaaS',
      'Fintech': 'Fintech',
      'FinTech': 'Fintech',
      'FoodTech': 'E-commerce',
      'Healthcare': 'Healthcare',
      'Gaming': 'Gaming',
      'Semiconductor': 'Semiconductor',
      'Data Center': 'Data Center',
      'Cybersecurity': 'Cybersecurity',
      'Cloud': 'Cloud',
      'Enterprise': 'Enterprise',
      'Consumer': 'Consumer',
      'AI': 'AI/ML',
      'AI/ML': 'AI/ML',
      'Tech': 'Other',
    };
    return sectorMap[sector] || 'Other';
  }

  /**
   * Setup close button and overlay click handlers
   */
  private setupCloseHandlers(): void {
    if (!this.container) return;

    // Close button
    const closeBtn = this.container.querySelector<HTMLElement>('.profile-close');
    closeBtn?.addEventListener('click', () => this.hide());

    // Back to map button
    const backBtn = this.container.querySelector<HTMLElement>('.profile-back-btn');
    backBtn?.addEventListener('click', () => this.hide());

    // Escape key
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && this.isOpen) {
        this.hide();
        document.removeEventListener('keydown', handleEscape);
      }
    };
    document.addEventListener('keydown', handleEscape);

    // Click overlay background to close
    this.container.addEventListener('click', (e) => {
      if (e.target === this.container) {
        this.hide();
      }
    });
  }

  /**
   * Render company profile content
   */
  private renderProfile(company: Company): string {
    const logoHtml = renderLogo(company.logo, company.name, 64);

    return `
      <div class="profile-panel">
        <button class="profile-close" aria-label="Close">×</button>

        <header class="profile-header">
          <div class="profile-logo">${logoHtml}</div>
          <div class="profile-header-content">
            <h1 class="profile-name">${escapeHtml(company.name)}</h1>
            ${company.tags?.length ? `
              <div class="profile-tags">
                ${company.tags.map(tag => `<span class="profile-tag profile-tag-${escapeHtml(tag)}">${this.formatTag(tag)}</span>`).join('')}
              </div>
            ` : ''}
          </div>
        </header>

        <div class="profile-content">
          ${company.description ? `
            <section class="profile-section">
              <h2>About</h2>
              <p class="profile-description">${escapeHtml(company.description)}</p>
            </section>
          ` : ''}

          <section class="profile-section">
            <h2>Details</h2>
            <div class="profile-details-grid">
              ${company.industry ? `
                <div class="profile-detail">
                  <span class="detail-icon">🏢</span>
                  <div class="detail-content">
                    <span class="detail-label">Industry</span>
                    <span class="detail-value">${escapeHtml(company.industry)}</span>
                  </div>
                </div>
              ` : ''}
              ${company.founded ? `
                <div class="profile-detail">
                  <span class="detail-icon">📅</span>
                  <div class="detail-content">
                    <span class="detail-label">Founded</span>
                    <span class="detail-value">${company.founded}</span>
                  </div>
                </div>
              ` : ''}
              ${company.headquarters ? `
                <div class="profile-detail">
                  <span class="detail-icon">📍</span>
                  <div class="detail-content">
                    <span class="detail-label">Headquarters</span>
                    <span class="detail-value">${escapeHtml(company.headquarters)}</span>
                  </div>
                </div>
              ` : ''}
              ${company.employeeCount ? `
                <div class="profile-detail">
                  <span class="detail-icon">👥</span>
                  <div class="detail-content">
                    <span class="detail-label">Employees</span>
                    <span class="detail-value">${escapeHtml(company.employeeCount)}</span>
                  </div>
                </div>
              ` : ''}
              ${company.address ? `
                <div class="profile-detail">
                  <span class="detail-icon">🏠</span>
                  <div class="detail-content">
                    <span class="detail-label">Irish Office</span>
                    <span class="detail-value">${escapeHtml(company.address)}</span>
                  </div>
                </div>
              ` : ''}
            </div>
          </section>

          ${company.funding ? this.renderFundingSection(company.funding) : ''}

          ${company.people?.length ? this.renderPeopleSection(company.people) : ''}

          <section class="profile-section profile-links">
            <h2>Links</h2>
            <div class="profile-link-grid">
              ${company.website ? `
                <a class="profile-link" href="${sanitizeUrl(company.website)}" target="_blank" rel="noopener">
                  <span class="link-icon">🌐</span>
                  <span>Website</span>
                </a>
              ` : ''}
              ${company.linkedin ? `
                <a class="profile-link" href="${sanitizeUrl(company.linkedin)}" target="_blank" rel="noopener">
                  <span class="link-icon">💼</span>
                  <span>LinkedIn</span>
                </a>
              ` : ''}
              ${company.twitter ? `
                <a class="profile-link" href="https://twitter.com/${escapeHtml(company.twitter)}" target="_blank" rel="noopener">
                  <span class="link-icon">𝕏</span>
                  <span>Twitter</span>
                </a>
              ` : ''}
            </div>
          </section>
        </div>

        <footer class="profile-footer">
          <button class="profile-back-btn">
            ← Back to Map
          </button>
          ${company.updatedAt ? `
            <span class="profile-updated">Last updated: ${escapeHtml(company.updatedAt)}</span>
          ` : ''}
        </footer>
      </div>
    `;
  }

  /**
   * Render funding section
   */
  private renderFundingSection(funding: Company['funding']): string {
    if (!funding) return '';
    return `
      <section class="profile-section">
        <h2>Funding</h2>
        <div class="profile-details-grid">
          <div class="profile-detail">
            <span class="detail-icon">💰</span>
            <div class="detail-content">
              <span class="detail-label">Total Raised</span>
              <span class="detail-value">${escapeHtml(funding.total)}</span>
            </div>
          </div>
          ${funding.lastRound ? `
            <div class="profile-detail">
              <span class="detail-icon">📊</span>
              <div class="detail-content">
                <span class="detail-label">Last Round</span>
                <span class="detail-value">${escapeHtml(funding.lastRound)}${funding.lastRoundDate ? ` (${escapeHtml(funding.lastRoundDate)})` : ''}</span>
              </div>
            </div>
          ` : ''}
          ${funding.investors?.length ? `
            <div class="profile-detail profile-detail-wide">
              <span class="detail-icon">🏛️</span>
              <div class="detail-content">
                <span class="detail-label">Notable Investors</span>
                <span class="detail-value">${funding.investors.map(i => escapeHtml(i)).join(', ')}</span>
              </div>
            </div>
          ` : ''}
        </div>
      </section>
    `;
  }

  /**
   * Render people/leadership section
   */
  private renderPeopleSection(people: Company['people']): string {
    if (!people?.length) return '';
    return `
      <section class="profile-section">
        <h2>Leadership</h2>
        <div class="profile-people-grid">
          ${people.slice(0, 4).map(person => `
            <div class="profile-person">
              <div class="person-avatar">${this.getInitials(person.name)}</div>
              <div class="person-info">
                <span class="person-name">${escapeHtml(person.name)}</span>
                <span class="person-title">${escapeHtml(person.title)}</span>
              </div>
              ${person.linkedin ? `
                <a class="person-linkedin" href="${sanitizeUrl(person.linkedin)}" target="_blank" rel="noopener" title="LinkedIn">
                  💼
                </a>
              ` : ''}
            </div>
          `).join('')}
        </div>
      </section>
    `;
  }

  /**
   * Render not found page
   */
  private renderNotFound(companyId: string): string {
    return `
      <div class="profile-panel profile-not-found">
        <button class="profile-close" aria-label="Close">×</button>

        <div class="not-found-content">
          <div class="not-found-icon">🔍</div>
          <h1>Company Not Found</h1>
          <p>We couldn't find a company with ID "${escapeHtml(companyId)}".</p>
          <button class="profile-back-btn">
            ← Back to Map
          </button>
        </div>
      </div>
    `;
  }

  /**
   * Format tag for display
   */
  private formatTag(tag: string): string {
    const tagLabels: Record<string, string> = {
      'unicorn': '🦄 Unicorn',
      'tech-hq': '🏢 Tech HQ',
      'data-center': '🖥️ Data Center',
      'semiconductor': '💎 Semiconductor',
      'startup': '🚀 Startup',
      'multinational': '🌍 Multinational',
      'irish-founded': '☘️ Irish Founded',
    };
    return tagLabels[tag] || tag;
  }

  /**
   * Get initials from name
   */
  private getInitials(name: string): string {
    return name
      .split(' ')
      .map(part => part[0])
      .join('')
      .toUpperCase()
      .slice(0, 2);
  }

  /**
   * Clean up event listeners
   */
  public destroy(): void {
    if (this.popstateHandler) {
      window.removeEventListener('popstate', this.popstateHandler);
    }
    if (this.container) {
      this.container.remove();
      this.container = null;
    }
  }
}

// Singleton instance
let companyProfileInstance: CompanyProfile | null = null;

/**
 * Get or create the CompanyProfile singleton
 */
export function getCompanyProfile(): CompanyProfile {
  if (!companyProfileInstance) {
    companyProfileInstance = new CompanyProfile();
  }
  return companyProfileInstance;
}

/**
 * Show company profile for given ID
 */
export function showCompanyProfile(companyId: string): void {
  getCompanyProfile().show(companyId);
}

/**
 * Hide company profile
 */
export function hideCompanyProfile(): void {
  getCompanyProfile().hide();
}
