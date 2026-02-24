import { Panel } from './Panel';
import { t } from '@/services/i18n';
import type { TechHubActivity } from '@/services/tech-activity';
import { escapeHtml, sanitizeUrl } from '@/utils/sanitize';
import { getCSSColor } from '@/utils';

const COUNTRY_FLAGS: Record<string, string> = {
  'USA': '🇺🇸', 'United States': '🇺🇸',
  'UK': '🇬🇧', 'United Kingdom': '🇬🇧',
  'China': '🇨🇳',
  'India': '🇮🇳',
  'Israel': '🇮🇱',
  'Germany': '🇩🇪',
  'France': '🇫🇷',
  'Canada': '🇨🇦',
  'Japan': '🇯🇵',
  'South Korea': '🇰🇷',
  'Singapore': '🇸🇬',
  'Australia': '🇦🇺',
  'Netherlands': '🇳🇱',
  'Sweden': '🇸🇪',
  'Switzerland': '🇨🇭',
  'Brazil': '🇧🇷',
  'Indonesia': '🇮🇩',
  'UAE': '🇦🇪',
  'Estonia': '🇪🇪',
  'Ireland': '🇮🇪',
  'Finland': '🇫🇮',
  'Spain': '🇪🇸',
  'Italy': '🇮🇹',
  'Poland': '🇵🇱',
  'Mexico': '🇲🇽',
  'Argentina': '🇦🇷',
  'Chile': '🇨🇱',
  'Colombia': '🇨🇴',
  'Nigeria': '🇳🇬',
  'Kenya': '🇰🇪',
  'South Africa': '🇿🇦',
  'Egypt': '🇪🇬',
  'Taiwan': '🇹🇼',
  'Vietnam': '🇻🇳',
  'Thailand': '🇹🇭',
  'Malaysia': '🇲🇾',
  'Philippines': '🇵🇭',
  'New Zealand': '🇳🇿',
  'Austria': '🇦🇹',
  'Belgium': '🇧🇪',
  'Denmark': '🇩🇰',
  'Norway': '🇳🇴',
  'Portugal': '🇵🇹',
  'Czech Republic': '🇨🇿',
  'Romania': '🇷🇴',
  'Ukraine': '🇺🇦',
  'Russia': '🇷🇺',
  'Turkey': '🇹🇷',
  'Saudi Arabia': '🇸🇦',
  'Qatar': '🇶🇦',
  'Pakistan': '🇵🇰',
  'Bangladesh': '🇧🇩',
};

export class TechHubsPanel extends Panel {
  private activities: TechHubActivity[] = [];
  private onHubClick?: (hub: TechHubActivity) => void;

  constructor() {
    super({
      id: 'tech-hubs',
      title: t('panels.techHubs'),
      showCount: true,
      infoTooltip: t('components.techHubs.infoTooltip', {
        highColor: getCSSColor('--semantic-normal'),
        elevatedColor: getCSSColor('--semantic-elevated'),
        lowColor: getCSSColor('--text-dim'),
      }),
    });
  }

  public setOnHubClick(handler: (hub: TechHubActivity) => void): void {
    this.onHubClick = handler;
  }

  public setActivities(activities: TechHubActivity[]): void {
    this.activities = activities.slice(0, 10);
    this.setCount(this.activities.length);
    this.render();
  }

  private getFlag(country: string): string {
    return COUNTRY_FLAGS[country] || '🌐';
  }

  private render(): void {
    if (this.activities.length === 0) {
      this.showError(t('common.noActiveTechHubs'));
      return;
    }

    const html = this.activities.map((hub, index) => {
      const trendIcon = hub.trend === 'rising' ? '↑' : hub.trend === 'falling' ? '↓' : '';
      const breakingTag = hub.hasBreaking ? '<span class="hub-breaking">ALERT</span>' : '';
      const topStory = hub.topStories[0];

      return `
        <div class="tech-hub-item ${hub.activityLevel}" data-hub-id="${escapeHtml(hub.hubId)}" data-index="${index}">
          <div class="hub-rank">${index + 1}</div>
          <span class="hub-indicator ${hub.activityLevel}"></span>
          <div class="hub-info">
            <div class="hub-header">
              <span class="hub-name">${escapeHtml(hub.city)}</span>
              <span class="hub-flag">${this.getFlag(hub.country)}</span>
              ${breakingTag}
            </div>
            <div class="hub-meta">
              <span class="hub-news-count">${hub.newsCount} ${hub.newsCount === 1 ? 'story' : 'stories'}</span>
              ${trendIcon ? `<span class="hub-trend ${hub.trend}">${trendIcon}</span>` : ''}
              <span class="hub-tier">${hub.tier}</span>
            </div>
          </div>
          <div class="hub-score">${Math.round(hub.score)}</div>
        </div>
        ${topStory ? `
          <a class="hub-top-story" href="${sanitizeUrl(topStory.link)}" target="_blank" rel="noopener" data-hub-id="${escapeHtml(hub.hubId)}">
            ${escapeHtml(topStory.title.length > 80 ? topStory.title.slice(0, 77) + '...' : topStory.title)}
          </a>
        ` : ''}
      `;
    }).join('');

    this.setContent(html);
    this.bindEvents();
  }

  private bindEvents(): void {
    const items = this.content.querySelectorAll<HTMLDivElement>('.tech-hub-item');
    items.forEach((item) => {
      item.addEventListener('click', () => {
        const hubId = item.dataset.hubId;
        const hub = this.activities.find(a => a.hubId === hubId);
        if (hub && this.onHubClick) {
          this.onHubClick(hub);
        }
      });
    });
  }
}
