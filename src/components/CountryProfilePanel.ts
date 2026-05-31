import { Panel } from './Panel';
import { t } from '@/services/i18n';
import { escapeHtml } from '@/utils/sanitize';
import { toFlagEmoji } from '@/utils/country-flag';
import { getCountryNameByCode } from '@/services/country-geometry';
import type { AppContext } from '@/app/app-context';
import { safeHtml } from '@/utils/dom-utils';

export interface CountryProfileData {
  countryCode: string;
  countryName: string;
  riskScore?: number;
  recentEvents?: string[];
  militaryActivity?: number;
  economicIndicators?: Record<string, number | string>;
  energyStatus?: string;
  cyberThreats?: number;
  humanitarianSituation?: string;
}

/**
 * CountryProfilePanel displays aggregated country intelligence across all domains
 * Sources: Conflict data, Economic indicators, Military activity, Energy, Cyber threats, Health
 */
export class CountryProfilePanel extends Panel {
  private appContext: AppContext | null = null;
  private currentCountryCode: string | null = null;
  private countryData: CountryProfileData | null = null;

  constructor() {
    super({
      id: 'country-profile',
      title: t('panels.countryProfile'),
      infoTooltip: t('panels.countryProfile_tooltip'),
    });
  }

  public setAppContext(appContext: AppContext): void {
    this.appContext = appContext;
  }

  /**
   * Load and display data for a specific country
   */
  public async loadCountryData(countryCode: string): Promise<void> {
    this.currentCountryCode = countryCode;
    const countryName = getCountryNameByCode(countryCode) || countryCode;

    try {
      this.showLoading();

      // Build aggregated country profile
      this.countryData = await this.aggregateCountryData(countryCode, countryName);

      if (!this.element?.isConnected) return;
      this.renderCountryProfile(this.countryData);
    } catch (err) {
      if (this.isAbortError(err)) return;
      if (!this.element?.isConnected) return;
      this.showError(
        t('common.failedLoadingData'),
        () => void this.loadCountryData(countryCode)
      );
    }
  }

  private async aggregateCountryData(
    countryCode: string,
    countryName: string
  ): Promise<CountryProfileData> {
    const data: CountryProfileData = {
      countryCode,
      countryName,
    };

    if (!this.appContext) {
      return data;
    }

    // Aggregate military activity
    const militaryFlights = (this.appContext.intelligenceCache.military?.flights || []).filter(
      f => f.countryCode === countryCode
    ).length;

    const militaryVessels = (this.appContext.intelligenceCache.military?.vessels || []).filter(
      v => v.countryCode === countryCode
    ).length;

    data.militaryActivity = militaryFlights + militaryVessels;

    // Aggregate cyber threats
    const cyberThreats = (this.appContext.cyberThreatsCache || []).filter(
      ct => ct.countryCode === countryCode
    ).length;

    data.cyberThreats = cyberThreats;

    // Get risk score from country instability service if available
    // (This would be populated by the data-loader)
    const riskData = (window as any).__COUNTRY_RISK_SCORES?.[countryCode];
    if (riskData) {
      data.riskScore = riskData.score;
    }

    // Aggregate news events by country
    const countryNews = (window as any).__COUNTRY_PROFILE_NEWS || [];
    if (countryNews.length > 0) {
      data.recentEvents = countryNews
        .slice(0, 5)
        .map((n: any) => n.title || n.description || '');
    }

    return data;
  }

  private renderCountryProfile(data: CountryProfileData): void {
    const flag = toFlagEmoji(data.countryCode);
    const riskClass = data.riskScore
      ? data.riskScore > 0.7
        ? 'cp-risk-critical'
        : data.riskScore > 0.4
          ? 'cp-risk-high'
          : 'cp-risk-medium'
      : 'cp-risk-low';

    const riskLabel = data.riskScore
      ? `${(data.riskScore * 100).toFixed(0)}%`
      : 'N/A';

    let html = `
      <div class="country-profile-container">
        <div class="cp-header">
          <span class="cp-flag">${flag}</span>
          <div class="cp-title">
            <h2>${escapeHtml(data.countryName)}</h2>
            <span class="cp-code">${data.countryCode}</span>
          </div>
          <div class="cp-risk-badge ${riskClass}">
            <span class="cp-risk-label">${t('panels.riskScore')}:</span>
            <span class="cp-risk-value">${riskLabel}</span>
          </div>
        </div>

        <div class="cp-indicators">
          <div class="cp-indicator-card">
            <div class="cp-indicator-icon">🛡️</div>
            <div class="cp-indicator-content">
              <div class="cp-indicator-label">${t('panels.militaryActivity')}</div>
              <div class="cp-indicator-value">${data.militaryActivity || 0}</div>
              <div class="cp-indicator-detail">
                ${data.militaryActivity
                  ? t('panels.militaryActivityDetected')
                  : t('panels.noMilitaryActivity')}
              </div>
            </div>
          </div>

          <div class="cp-indicator-card">
            <div class="cp-indicator-icon">🔒</div>
            <div class="cp-indicator-content">
              <div class="cp-indicator-label">${t('panels.cyberThreats')}</div>
              <div class="cp-indicator-value">${data.cyberThreats || 0}</div>
              <div class="cp-indicator-detail">
                ${data.cyberThreats
                  ? t('panels.cyberThreatsDetected')
                  : t('panels.noCyberThreats')}
              </div>
            </div>
          </div>

          <div class="cp-indicator-card">
            <div class="cp-indicator-icon">📡</div>
            <div class="cp-indicator-content">
              <div class="cp-indicator-label">${t('panels.recentEvents')}</div>
              <div class="cp-indicator-value">${(data.recentEvents || []).length}</div>
              <div class="cp-indicator-detail">
                ${(data.recentEvents || []).length > 0
                  ? t('panels.eventsDetected')
                  : t('panels.noRecentEvents')}
              </div>
            </div>
          </div>
        </div>
    `;

    if ((data.recentEvents || []).length > 0) {
      html += `
        <div class="cp-recent-events">
          <h3>${t('panels.recentHeadlines')}</h3>
          <ul class="cp-event-list">
            ${data.recentEvents
              ?.slice(0, 5)
              .map(
                event => `<li class="cp-event-item">${escapeHtml(event.substring(0, 100))}</li>`
              )
              .join('')}
          </ul>
        </div>
      `;
    }

    html += `
      <div class="cp-footer">
        <p class="cp-footer-note">
          ${t('panels.countryProfileNote')}
        </p>
      </div>
    </div>
    `;

    this.setContent(html);

    // Inject CSS if not already present
    this.injectStyles();
  }

  private injectStyles(): void {
    if (document.head.querySelector('style[data-cp-panel]')) {
      return;
    }

    const style = document.createElement('style');
    style.setAttribute('data-cp-panel', 'true');
    style.textContent = `
      .country-profile-container {
        padding: 16px;
        color: var(--text-primary, #fff);
      }

      .cp-header {
        display: flex;
        align-items: center;
        gap: 12px;
        margin-bottom: 20px;
        padding-bottom: 16px;
        border-bottom: 1px solid var(--border-color, #333);
      }

      .cp-flag {
        font-size: 40px;
        line-height: 1;
      }

      .cp-title {
        flex: 1;
      }

      .cp-title h2 {
        margin: 0;
        font-size: 20px;
        font-weight: 600;
      }

      .cp-code {
        font-size: 12px;
        color: var(--text-secondary, #999);
        font-family: monospace;
        text-transform: uppercase;
      }

      .cp-risk-badge {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 4px;
        padding: 8px 12px;
        border-radius: 6px;
        font-size: 12px;
        font-weight: 600;
      }

      .cp-risk-critical {
        background: rgba(255, 0, 0, 0.15);
        color: #ff4444;
        border: 1px solid #ff4444;
      }

      .cp-risk-high {
        background: rgba(255, 165, 0, 0.15);
        color: #ffa500;
        border: 1px solid #ffa500;
      }

      .cp-risk-medium {
        background: rgba(255, 255, 0, 0.15);
        color: #ffff00;
        border: 1px solid #ffff00;
      }

      .cp-risk-low {
        background: rgba(0, 255, 0, 0.15);
        color: #00ff00;
        border: 1px solid #00ff00;
      }

      .cp-risk-label {
        opacity: 0.8;
      }

      .cp-risk-value {
        font-size: 16px;
      }

      .cp-indicators {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
        gap: 12px;
        margin-bottom: 20px;
      }

      .cp-indicator-card {
        display: flex;
        gap: 12px;
        padding: 12px;
        background: var(--bg-secondary, #2a2a2a);
        border: 1px solid var(--border-color, #333);
        border-radius: 6px;
      }

      .cp-indicator-icon {
        font-size: 24px;
        flex-shrink: 0;
      }

      .cp-indicator-content {
        flex: 1;
      }

      .cp-indicator-label {
        font-size: 11px;
        font-weight: 600;
        color: var(--text-secondary, #999);
        text-transform: uppercase;
        letter-spacing: 0.5px;
        margin-bottom: 4px;
      }

      .cp-indicator-value {
        font-size: 20px;
        font-weight: 700;
        color: var(--accent-color, #00aaff);
        margin-bottom: 4px;
      }

      .cp-indicator-detail {
        font-size: 11px;
        color: var(--text-secondary, #999);
        line-height: 1.3;
      }

      .cp-recent-events {
        margin-bottom: 16px;
      }

      .cp-recent-events h3 {
        margin: 0 0 12px 0;
        font-size: 13px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.5px;
        color: var(--text-secondary, #999);
      }

      .cp-event-list {
        list-style: none;
        margin: 0;
        padding: 0;
      }

      .cp-event-item {
        padding: 8px;
        margin-bottom: 6px;
        background: var(--bg-secondary, #2a2a2a);
        border-left: 3px solid var(--accent-color, #00aaff);
        border-radius: 3px;
        font-size: 12px;
        line-height: 1.4;
      }

      .cp-footer {
        padding-top: 12px;
        border-top: 1px solid var(--border-color, #333);
      }

      .cp-footer-note {
        margin: 0;
        font-size: 11px;
        color: var(--text-secondary, #999);
        font-style: italic;
      }
    `;

    document.head.appendChild(style);
  }

  public async fetchData(): Promise<void> {
    // This panel is driven by external country selection
    // Default behavior: show a prompt to select a country
    if (!this.currentCountryCode) {
      const html = `
        <div style="padding: 24px; text-align: center; color: var(--text-secondary, #999);">
          <p>${t('panels.countryProfilePlaceholder', 'Select a country to view its profile')}</p>
        </div>
      `;
      this.setContent(html);
    }
  }
}
