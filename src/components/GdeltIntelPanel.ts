import { Panel } from './Panel';
import { escapeHtml, sanitizeUrl } from '@/utils/sanitize';
import { t, getCurrentLanguage } from '@/services/i18n';
import { translateTextCached } from '@/services';
import {
  getIntelTopics,
  fetchTopicIntelligence,
  formatArticleDate,
  extractDomain,
  type GdeltArticle,
  type IntelTopic,
  type TopicIntelligence,
} from '@/services/gdelt-intel';

export class GdeltIntelPanel extends Panel {
  private activeTopic: IntelTopic = getIntelTopics()[0]!;
  private topicData = new Map<string, TopicIntelligence>();
  private tabsEl: HTMLElement | null = null;
  private autoTranslateRunId = 0;

  constructor() {
    super({
      id: 'gdelt-intel',
      title: t('panels.gdeltIntel'),
      showCount: true,
      trackActivity: true,
      infoTooltip: t('components.gdeltIntel.infoTooltip'),
    });
    this.createTabs();
    this.loadActiveTopic();
  }

  private createTabs(): void {
    this.tabsEl = document.createElement('div');
    this.tabsEl.className = 'gdelt-intel-tabs';

    getIntelTopics().forEach(topic => {
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
    this.bindTranslateEvents();
    this.queueAutoTranslateArticles();
  }

  private renderArticle(article: GdeltArticle): string {
    const domain = article.source || extractDomain(article.url);
    const timeAgo = formatArticleDate(article.date);
    const toneClass = article.tone ? (article.tone < -2 ? 'tone-negative' : article.tone > 2 ? 'tone-positive' : '') : '';
    const currentLang = getCurrentLanguage();
    const showTranslate = currentLang !== 'en';
    const translateTitle = currentLang === 'vi' ? 'Dịch' : 'Translate';

    return `
      <a href="${sanitizeUrl(article.url)}" target="_blank" rel="noopener" class="gdelt-intel-article ${toneClass}">
        <div class="article-header">
          <span class="article-source">${escapeHtml(domain)}</span>
          <span class="article-time-wrap">
            <span class="article-time">${escapeHtml(timeAgo)}</span>
            ${showTranslate ? `<button type="button" class="item-translate-btn gdelt-translate-btn" title="${translateTitle}" data-text="${escapeHtml(article.title)}">文</button>` : ''}
          </span>
        </div>
        <div class="article-title">${escapeHtml(article.title)}</div>
      </a>
    `;
  }

  private bindTranslateEvents(): void {
    const buttons = this.content.querySelectorAll<HTMLElement>('.gdelt-translate-btn');
    buttons.forEach((button) => {
      if (button.dataset.boundClick === '1') return;
      button.dataset.boundClick = '1';
      button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        const text = button.dataset.text;
        if (text) void this.handleTranslate(button, text);
      });
    });
  }

  private async handleTranslate(button: HTMLElement, text: string): Promise<void> {
    const currentLang = getCurrentLanguage();
    if (currentLang === 'en') return;

    const articleEl = button.closest('.gdelt-intel-article');
    const titleEl = articleEl?.querySelector('.article-title') as HTMLElement | null;
    if (!titleEl) return;

    const originalText = (titleEl.dataset.original || titleEl.textContent || text).trim();
    if (!originalText) return;
    button.innerHTML = '...';
    button.style.pointerEvents = 'none';

    try {
      const translated = await translateTextCached(originalText, currentLang);
      if (!translated) {
        button.innerHTML = '文';
        return;
      }

      titleEl.textContent = translated;
      titleEl.dataset.original = originalText;
      titleEl.dataset.translatedLang = currentLang;
      button.dataset.text = originalText;
      button.innerHTML = '✓';
      button.classList.add('translated');
      button.title = (currentLang === 'vi' ? 'Bản gốc: ' : 'Original: ') + originalText;
    } catch (error) {
      console.error('[GdeltIntelPanel] Translation failed:', error);
      button.innerHTML = '文';
    } finally {
      button.style.pointerEvents = 'auto';
    }
  }

  private queueAutoTranslateArticles(): void {
    const lang = getCurrentLanguage();
    if (lang === 'en') return;

    const runId = ++this.autoTranslateRunId;
    window.setTimeout(() => {
      if (runId !== this.autoTranslateRunId) return;
      void this.autoTranslateVisibleArticles(lang);
    }, 0);
  }

  private async autoTranslateVisibleArticles(lang: string): Promise<void> {
    const titleEls = Array.from(this.content.querySelectorAll<HTMLElement>('.gdelt-intel-article .article-title'));
    if (titleEls.length === 0) return;

    await Promise.allSettled(titleEls.map(async (titleEl) => {
      if (titleEl.dataset.translatedLang === lang) return;

      const sourceText = (titleEl.dataset.original || titleEl.textContent || '').trim();
      if (!sourceText) return;

      const translated = await translateTextCached(sourceText, lang);
      if (!translated) return;

      titleEl.dataset.original = sourceText;
      titleEl.dataset.translatedLang = lang;
      titleEl.textContent = translated;

      const button = titleEl.closest('.gdelt-intel-article')?.querySelector<HTMLElement>('.gdelt-translate-btn');
      if (!button) return;
      button.dataset.text = sourceText;
      button.innerHTML = '✓';
      button.classList.add('translated');
      button.title = (lang === 'vi' ? 'Bản gốc: ' : 'Original: ') + sourceText;
    }));
  }

  public async refresh(): Promise<void> {
    await this.loadActiveTopic();
  }

  public async refreshAll(): Promise<void> {
    this.topicData.clear();
    await this.loadActiveTopic();
  }
}
