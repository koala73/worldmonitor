import { Panel } from './Panel';
import { escapeHtml, sanitizeUrl } from '@/utils/sanitize';
import { t } from '@/services/i18n';
import {
  INTEL_TOPICS,
  fetchTopicIntelligence,
  formatArticleDate,
  extractDomain,
  type GdeltArticle,
  type IntelTopic,
  type TopicIntelligence,
} from '@/services/gdelt-intel';

export class GdeltIntelPanel extends Panel {
  private activeTopic: IntelTopic = INTEL_TOPICS[0]!;
  private topicData = new Map<string, TopicIntelligence>();
  private tabsEl: HTMLElement | null = null;

  constructor() {
    super({
      id: 'gdelt-intel',
      title: t('panels.gdeltIntel'),
      showCount: true,
      trackActivity: true,
      infoTooltip: `<strong>GDELT Intelligence</strong>
        Real-time global news monitoring:
        <ul>
          <li>Curated topic categories (conflicts, cyber, etc.)</li>
          <li>Articles from 100+ languages translated</li>
          <li>Updates every 15 minutes</li>
        </ul>
        Source: GDELT Project (gdeltproject.org)`,
    });
    this.createTabs();
    this.loadActiveTopic();
  }

  private createTabs(): void {
    this.tabsEl = document.createElement('div');
    this.tabsEl.className = 'gdelt-intel-tabs';

    INTEL_TOPICS.forEach(topic => {
      const tab = document.createElement('button');
      tab.className = `gdelt-intel-tab ${topic.id === this.activeTopic.id ? 'active' : ''}`;
      tab.dataset.topicId = topic.id;
      tab.title = topic.description;
      tab.innerHTML = `<span class="tab-icon">${topic.icon}</span><span class="tab-label">${escapeHtml(topic.name)}</span>`;

      tab.addEventListener('click', () => this.selectTopic(topic));
      this.tabsEl!.appendChild(tab);
    });

    this.element.insertBefore(this.tabsEl, this.content);
  }

  private selectTopic(topic: IntelTopic): void {
    if (topic.id === this.activeTopic.id) return;

    this.activeTopic = topic;

    this.tabsEl?.querySelectorAll('.gdelt-intel-tab').forEach(tab => {
      tab.classList.toggle('active', (tab as HTMLElement).dataset.topicId === topic.id);
    });

    const cached = this.topicData.get(topic.id);
    if (cached && Date.now() - cached.fetchedAt.getTime() < 5 * 60 * 1000) {
      this.renderArticles(cached.articles);
    } else {
      this.loadActiveTopic();
    }
  }

  private async loadActiveTopic(): Promise<void> {
    this.showLoading();

    try {
      const data = await fetchTopicIntelligence(this.activeTopic);
      this.topicData.set(this.activeTopic.id, data);
      this.renderArticles(data.articles);
      this.setCount(data.articles.length);
    } catch (error) {
      console.error('[GdeltIntelPanel] Load error:', error);
      this.showError(t('common.failedIntelFeed'));
    }
  }

  private renderArticles(articles: GdeltArticle[]): void {
    if (articles.length === 0) {
      this.content.innerHTML = `<div class="empty-state">${t('components.gdelt.empty')}</div>`;
      return;
    }

    const html = articles.map(article => this.renderArticle(article)).join('');
    this.content.innerHTML = `<div class="gdelt-intel-articles">${html}</div>`;
  }

  private renderArticle(article: GdeltArticle): string {
    const domain = article.source || extractDomain(article.url);
    const timeAgo = formatArticleDate(article.date);
    const toneClass = article.tone ? (article.tone < -2 ? 'tone-negative' : article.tone > 2 ? 'tone-positive' : '') : '';

    return `
      <a href="${sanitizeUrl(article.url)}" target="_blank" rel="noopener" class="gdelt-intel-article ${toneClass}">
        <div class="article-header">
          <span class="article-source">${escapeHtml(domain)}</span>
          <span class="article-time">${escapeHtml(timeAgo)}</span>
        </div>
        <div class="article-title">${escapeHtml(article.title)}</div>
      </a>
    `;
  }

  public async refresh(): Promise<void> {
    await this.loadActiveTopic();
  }

  public async refreshAll(): Promise<void> {
    this.topicData.clear();
    await this.loadActiveTopic();
  }
}
