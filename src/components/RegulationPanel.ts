import { Panel } from './Panel';
import type { AIRegulation, RegulatoryAction, CountryRegulationProfile, RegulationDeadline } from '@/types';
import {
  AI_REGULATIONS,
  COUNTRY_REGULATION_PROFILES,
  getUpcomingDeadlines,
  getRecentActions,
  getLatestActions,
  getDeadlinesOutsideWindow,
  getLaterDeadlines,
  daysFromToday,
} from '@/config';
import { escapeHtml, sanitizeUrl } from '@/utils/sanitize';
import { t } from '@/services/i18n';
import { getCSSColor } from '@/utils';
import { setTrustedHtml, trustedHtml } from '@/utils/dom-utils';


export class RegulationPanel extends Panel {
  private viewMode: 'timeline' | 'deadlines' | 'regulations' | 'countries' = 'timeline';

  constructor(id: string) {
    super({ id, title: t('panels.regulation'), infoTooltip: t('components.regulation.infoTooltip') });
    this.render();
  }

  protected render(): void {
    setTrustedHtml(this.content, trustedHtml(`
      <div class="regulation-panel">
        <div class="regulation-header">
          <h3>${t('components.regulation.dashboard')}</h3>
          <div class="panel-tabs">
            <button class="panel-tab ${this.viewMode === 'timeline' ? 'active' : ''}" data-view="timeline">${t('components.regulation.timeline')}</button>
            <button class="panel-tab ${this.viewMode === 'deadlines' ? 'active' : ''}" data-view="deadlines">${t('components.regulation.deadlines')}</button>
            <button class="panel-tab ${this.viewMode === 'regulations' ? 'active' : ''}" data-view="regulations">${t('components.regulation.regulations')}</button>
            <button class="panel-tab ${this.viewMode === 'countries' ? 'active' : ''}" data-view="countries">${t('components.regulation.countries')}</button>
          </div>
        </div>
        <div class="regulation-content">
          ${this.renderContent()}
        </div>
      </div>
    `, "legacy direct innerHTML migration"));

    // Add event listeners for tabs
    this.content.querySelectorAll('.panel-tab').forEach(tab => {
      tab.addEventListener('click', (e) => {
        const target = e.target as HTMLElement;
        const view = target.dataset.view as typeof this.viewMode;
        if (view) {
          this.viewMode = view;
          this.render();
        }
      });
    });
  }

  private renderContent(): string {
    switch (this.viewMode) {
      case 'timeline':
        return this.renderTimeline();
      case 'deadlines':
        return this.renderDeadlines();
      case 'regulations':
        return this.renderRegulations();
      case 'countries':
        return this.renderCountries();
      default:
        return '';
    }
  }

  private renderTimeline(): string {
    const recentActions = getRecentActions(12); // Last 12 months
    const showingLatest = recentActions.length === 0;
    const actions = showingLatest ? getLatestActions() : recentActions;

    if (actions.length === 0) {
      return `<div class="empty-state">${t('components.regulation.emptyActions')}</div>`;
    }

    return `
      <div class="timeline-view">
        ${showingLatest ? `<p class="regulation-note">${t('components.regulation.emptyActions')}</p>` : ''}
        <div class="timeline-header">
          <h4>${t(showingLatest ? 'components.regulation.latestActions' : 'components.regulation.recentActions')}</h4>
          <span class="count">${t('components.regulation.actionsCount', { count: String(actions.length) })}</span>
        </div>
        <div class="timeline-list">
          ${actions.map(action => this.renderTimelineItem(action)).join('')}
        </div>
      </div>
    `;
  }

  private renderTimelineItem(action: RegulatoryAction): string {
    const date = new Date(action.date);
    const formattedDate = date.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      timeZone: 'UTC',
    });

    const typeIcons: Record<RegulatoryAction['type'], string> = {
      'law-passed': '📜',
      'executive-order': '🏛️',
      'guideline': '📋',
      'enforcement': '⚖️',
      'consultation': '💬',
    };

    return `
      <div class="timeline-item impact-${action.impact}">
        <div class="timeline-marker">
          <span class="timeline-icon">${typeIcons[action.type]}</span>
          <div class="timeline-line"></div>
        </div>
        <div class="timeline-content">
          <div class="timeline-header-row">
            <span class="timeline-date">${formattedDate}</span>
            <span class="timeline-country">${escapeHtml(action.country)}</span>
            <span class="timeline-impact">${action.impact.toUpperCase()}</span>
          </div>
          <h5>${escapeHtml(action.title)}</h5>
          <p>${escapeHtml(action.description)}</p>
          <span class="timeline-source">${t('components.regulation.source')}: ${this.renderSourceLink(action.sourceUrl, action.source ?? action.sourceUrl)}</span>
        </div>
      </div>
    `;
  }

  private renderDeadlines(): string {
    const upcomingDeadlines = getUpcomingDeadlines();
    const showingOther = upcomingDeadlines.length === 0;
    const deadlines = showingOther ? getDeadlinesOutsideWindow() : upcomingDeadlines;
    const laterDeadlines = showingOther ? [] : getLaterDeadlines();

    if (deadlines.length === 0) {
      return `<div class="empty-state">${t('components.regulation.emptyDeadlines')}</div>`;
    }

    return `
      <div class="deadlines-view">
        ${showingOther ? `<p class="regulation-note">${t('components.regulation.emptyDeadlines')}</p>` : ''}
        <div class="deadlines-header">
          <h4>${t(showingOther ? 'components.regulation.otherDeadlines' : 'components.regulation.upcomingDeadlines')}</h4>
          <span class="count">${t('components.regulation.deadlinesCount', { count: String(deadlines.length) })}</span>
        </div>
        <div class="deadlines-list">
          ${deadlines.map(entry => this.renderDeadlineItem(entry)).join('')}
        </div>
        ${laterDeadlines.length > 0 ? `
        <div class="deadlines-header">
          <h4>${t('components.regulation.otherDeadlines')}</h4>
          <span class="count">${t('components.regulation.deadlinesCount', { count: String(laterDeadlines.length) })}</span>
        </div>
        <div class="deadlines-list">
          ${laterDeadlines.map(entry => this.renderDeadlineItem(entry)).join('')}
        </div>` : ''}
      </div>
    `;
  }

  private renderDeadlineItem({ regulation, deadline }: RegulationDeadline): string {
    const date = new Date(deadline.date);
    const daysUntil = daysFromToday(deadline.date);
    const passed = daysUntil < 0;

    const formattedDate = date.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      timeZone: 'UTC',
    });

    const urgencyClass = passed ? 'passed' : daysUntil < 90 ? 'urgent' : daysUntil < 180 ? 'warning' : 'normal';

    return `
      <div class="deadline-item ${urgencyClass}">
        <div class="deadline-countdown">
          <div class="days-until">${Math.abs(daysUntil)}</div>
          <div class="days-label">${t(passed ? 'components.regulation.daysAgo' : 'components.regulation.days')}</div>
        </div>
        <div class="deadline-content">
          <h5>${escapeHtml(regulation.shortName)}</h5>
          <p class="deadline-name">${escapeHtml(deadline.label)}</p>
          <div class="deadline-meta">
            <span class="deadline-date">📅 ${formattedDate}</span>
            <span class="deadline-country">🌍 ${escapeHtml(regulation.country)}</span>
            <span class="deadline-source">${this.renderSourceLink(deadline.source, t('components.regulation.source'))}</span>
          </div>
        </div>
      </div>
    `;
  }

  private renderRegulations(): string {
    const activeRegulations = AI_REGULATIONS.filter(r => r.status === 'active');
    const proposedRegulations = AI_REGULATIONS.filter(r => r.status === 'proposed');
    const revokedRegulations = AI_REGULATIONS.filter(r => r.status === 'revoked');
    const lapsedRegulations = AI_REGULATIONS.filter(r => r.status === 'lapsed');

    return `
      <div class="regulations-view">
        <div class="regulations-section">
          <h4>${t('components.regulation.activeCount', { count: String(activeRegulations.length) })}</h4>
          <div class="regulations-list">
            ${activeRegulations.map(reg => this.renderRegulationCard(reg)).join('')}
          </div>
        </div>
        <div class="regulations-section">
          <h4>${t('components.regulation.proposedCount', { count: String(proposedRegulations.length) })}</h4>
          <div class="regulations-list">
            ${proposedRegulations.map(reg => this.renderRegulationCard(reg)).join('')}
          </div>
        </div>
        ${revokedRegulations.length > 0 ? `
        <div class="regulations-section">
          <h4>${t('components.regulation.revokedCount', { count: String(revokedRegulations.length) })}</h4>
          <div class="regulations-list">
            ${revokedRegulations.map(reg => this.renderRegulationCard(reg)).join('')}
          </div>
        </div>` : ''}
        ${lapsedRegulations.length > 0 ? `
        <div class="regulations-section">
          <h4>${t('components.regulation.lapsedCount', { count: String(lapsedRegulations.length) })}</h4>
          <div class="regulations-list">
            ${lapsedRegulations.map(reg => this.renderRegulationCard(reg)).join('')}
          </div>
        </div>` : ''}
      </div>
    `;
  }

  private renderSourceLink(url: string, label: string): string {
    const href = sanitizeUrl(url);
    if (!href) return escapeHtml(label);
    return `<a href="${href}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`;
  }

  private renderRegulationCard(regulation: AIRegulation): string {
    const effectiveDate = regulation.effectiveDate
      ? new Date(regulation.effectiveDate).toLocaleDateString('en-US', { year: 'numeric', month: 'short', timeZone: 'UTC' })
      : 'TBD';
    const regulationLink = regulation.link ? sanitizeUrl(regulation.link) : '';

    return `
      <div class="regulation-card">
        <div class="regulation-card-header">
          <h5>${escapeHtml(regulation.shortName)}</h5>
          <span class="regulation-type type-${regulation.type}">${regulation.type}</span>
        </div>
        <p class="regulation-full-name">${escapeHtml(regulation.name)}</p>
        <div class="regulation-meta">
          <span>🌍 ${escapeHtml(regulation.country)}</span>
          <span>📅 ${effectiveDate}</span>
          <span class="status-badge status-${regulation.status}">${regulation.status}</span>
        </div>
        ${regulation.description ? `<p class="regulation-description">${escapeHtml(regulation.description)}</p>` : ''}
        <div class="regulation-provisions">
          <strong>${t('components.regulation.keyProvisions')}:</strong>
          <ul>
            ${regulation.keyProvisions.slice(0, 3).map(p => `<li>${escapeHtml(p)}</li>`).join('')}
            ${regulation.keyProvisions.length > 3 ? `<li class="more-provisions">${t('components.regulation.moreProvisions', { count: String(regulation.keyProvisions.length - 3) })}</li>` : ''}
          </ul>
        </div>
        <div class="regulation-scope">
          ${regulation.scope.map(s => `<span class="scope-tag">${escapeHtml(s)}</span>`).join('')}
        </div>
        ${regulationLink ? `<a href="${regulationLink}" target="_blank" rel="noopener noreferrer" class="regulation-link">${t('components.regulation.learnMore')} →</a>` : ''}
      </div>
    `;
  }

  private renderCountries(): string {
    const profiles = COUNTRY_REGULATION_PROFILES.sort((a, b) => {
      const stanceOrder: Record<CountryRegulationProfile['stance'], number> = {
        strict: 0,
        moderate: 1,
        permissive: 2,
        undefined: 3,
      };
      return stanceOrder[a.stance] - stanceOrder[b.stance];
    });

    return `
      <div class="countries-view">
        <div class="countries-header">
          <h4>${t('components.regulation.globalLandscape')}</h4>
          <div class="stance-legend">
            <span class="legend-item"><span class="color-box strict"></span> ${t('components.regulation.stances.strict')}</span>
            <span class="legend-item"><span class="color-box moderate"></span> ${t('components.regulation.stances.moderate')}</span>
            <span class="legend-item"><span class="color-box permissive"></span> ${t('components.regulation.stances.permissive')}</span>
            <span class="legend-item"><span class="color-box undefined"></span> ${t('components.regulation.stances.undefined')}</span>
          </div>
        </div>
        <div class="countries-list">
          ${profiles.map(profile => this.renderCountryCard(profile)).join('')}
        </div>
      </div>
    `;
  }

  private renderCountryCard(profile: CountryRegulationProfile): string {
    const stanceColors: Record<CountryRegulationProfile['stance'], string> = {
      strict: getCSSColor('--semantic-critical'),
      moderate: getCSSColor('--semantic-elevated'),
      permissive: getCSSColor('--semantic-normal'),
      undefined: getCSSColor('--text-muted'),
    };

    const activeCount = profile.activeRegulations.length;
    const proposedCount = profile.proposedRegulations.length;

    return `
      <div class="country-card stance-${profile.stance}">
        <div class="country-card-header" style="--stance-color: ${stanceColors[profile.stance]}">
          <h5>${escapeHtml(profile.country)}</h5>
          <span class="stance-badge">${profile.stance.toUpperCase()}</span>
        </div>
        <p class="country-summary">${escapeHtml(profile.summary)}</p>
        <div class="country-stats">
          <div class="stat">
            <span class="stat-value">${activeCount}</span>
            <span class="stat-label">${t('components.regulation.active')}</span>
          </div>
          <div class="stat">
            <span class="stat-value">${proposedCount}</span>
            <span class="stat-label">${t('components.regulation.proposed')}</span>
          </div>
          <div class="stat">
            <span class="stat-value">${new Date(profile.lastUpdated).toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' })}</span>
            <span class="stat-label">${t('components.regulation.updated')}</span>
          </div>
        </div>
      </div>
    `;
  }

  public updateData(): void {
    this.render();
  }

  public setView(view: 'timeline' | 'deadlines' | 'regulations' | 'countries'): void {
    this.viewMode = view;
    this.render();
  }
}
