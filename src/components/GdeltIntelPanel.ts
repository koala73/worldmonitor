import { Panel } from './Panel';
import { sanitizeUrl } from '@/utils/sanitize';
import { t } from '@/services/i18n';
import { h, replaceChildren } from '@/utils/dom-utils';
import { miniSparkline } from '@/utils/sparkline';
import {
  getIntelTopics,
  fetchTopicIntelligence,
  fetchTopicTimeline,
  formatArticleDate,
  extractDomain,
  type GdeltArticle,
  type IntelTopic,
  type TopicIntelligence,
  type TopicTimeline,
} from '@/services/gdelt-intel';

export class GdeltIntelPanel extends Panel {
  private activeTopic: IntelTopic = getIntelTopics()[0]!;
  private topicData = new Map<string, TopicIntelligence>();
  private timelineData = new Map<string, TopicTimeline>();
  private tabsEl: HTMLElement | null = null;
  private summaryEl: HTMLElement | null = null;

  constructor() {
    super({
      id: 'gdelt-intel',
      title: t('panels.gdeltIntel'),
      showCount: true,
      trackActivity: true,
      infoTooltip: t('components.gdeltIntel.infoTooltip'),
      defaultRowSpan: 2,
    });
    this.createTabs();
    this.loadActiveTopic();
  }

  private createTabs(): void {
    this.tabsEl = h('div', { className: 'panel-tabs' },
      ...getIntelTopics().map(topic =>
        h('button', {
          className: `panel-tab ${topic.id === this.activeTopic.id ? 'active' : ''}`,
          dataset: { topicId: topic.id },
          title: topic.description,
          onClick: () => this.selectTopic(topic),
        },
          h('span', { className: 'tab-icon' }, topic.icon),
          h('span', { className: 'tab-label' }, topic.name),
        ),
      ),
    );

    this.element.insertBefore(this.tabsEl, this.content);
  }

  private selectTopic(topic: IntelTopic): void {
    if (topic.id === this.activeTopic.id) return;

    this.activeTopic = topic;

    this.tabsEl?.querySelectorAll('.panel-tab').forEach(tab => {
      tab.classList.toggle('active', (tab as HTMLElement).dataset.topicId === topic.id);
    });

    const cached = this.topicData.get(topic.id);
    if (cached && Date.now() - cached.fetchedAt.getTime() < 5 * 60 * 1000) {
      this.renderTopicSummary(this.timelineData.get(topic.id) ?? null);
      this.renderArticles(cached.articles);
    } else {
      this.loadActiveTopic();
    }
  }

  private async loadActiveTopic(): Promise<void> {
    const topic = this.activeTopic;
    this.showLoading();

    try {
      const [data, timeline] = await Promise.all([
        fetchTopicIntelligence(topic),
        fetchTopicTimeline(topic.id),
      ]);
      if (!this.element?.isConnected || topic.id !== this.activeTopic.id) return;
      this.topicData.set(topic.id, data);
      if (timeline) this.timelineData.set(topic.id, timeline);
      this.renderTopicSummary(timeline);
      this.renderArticles(data.articles ?? []);
      this.setCount(data.articles?.length ?? 0);
    } catch (error) {
      if (this.isAbortError(error)) return;
      if (!this.element?.isConnected || topic.id !== this.activeTopic.id) return;
      console.error('[GdeltIntelPanel] Load error:', error);
      this.showError(t('common.failedIntelFeed'), () => this.loadActiveTopic());
    }
  }

  private renderTopicSummary(timeline: TopicTimeline | null | undefined): void {
    this.summaryEl?.remove();
    this.summaryEl = null;
    if (!timeline || (timeline.tone.length < 2 && timeline.vol.length < 2)) return;

    const toneVals = timeline.tone.map(p => p.value);
    const volVals = timeline.vol.map(p => p.value);
    const lastTone = toneVals[toneVals.length - 1] ?? 0;
    const toneChange = lastTone >= 0 ? 1 : -1;
    const toneBadgeClass = lastTone < -1.5 ? 'negative' : lastTone > 1.5 ? 'positive' : '';
    const tonePrefix = lastTone < -1.5 ? '▼ ' : lastTone > 1.5 ? '▲ ' : '';

    const toneGroup = h('div', { className: 'gdelt-trend-group' });
    toneGroup.innerHTML = miniSparkline(toneVals, toneChange, 60, 18);
    toneGroup.appendChild(h('span', { className: `gdelt-trend-value ${toneBadgeClass}`.trim() }, `${tonePrefix}${lastTone.toFixed(1)}`));
    toneGroup.appendChild(h('span', { className: 'gdelt-trend-label' }, 'Tone'));

    const volGroup = h('div', { className: 'gdelt-trend-group' });
    if (volVals.length >= 2) {
      volGroup.innerHTML = miniSparkline(volVals, 1, 60, 18);
      const lastVol = volVals[volVals.length - 1] ?? 0;
      volGroup.appendChild(h('span', { className: 'gdelt-trend-value' }, String(Math.round(lastVol))));
      volGroup.appendChild(h('span', { className: 'gdelt-trend-label' }, 'Volume'));
    }

    this.summaryEl = h('div', { className: 'gdelt-topic-summary' }, toneGroup, volGroup);
    this.content.insertAdjacentElement('beforebegin', this.summaryEl);
  }

  private renderArticles(articles: GdeltArticle[]): void {
    this.setErrorState(false);
    if (articles.length === 0) {
      replaceChildren(this.content, h('div', { className: 'empty-state' }, t('components.gdelt.empty')));
      return;
    }

    replaceChildren(this.content,
      h('div', { className: 'gdelt-intel-articles' },
        ...articles.map(article => this.buildArticle(article)),
      ),
    );
  }

  private buildArticle(article: GdeltArticle): HTMLElement {
    const domain = article.source || extractDomain(article.url);
    const timeAgo = formatArticleDate(article.date);
    const toneClass = article.tone ? (article.tone < -2 ? 'tone-negative' : article.tone > 2 ? 'tone-positive' : '') : '';

    return h('a', {
      href: sanitizeUrl(article.url),
      target: '_blank',
      rel: 'noopener',
      className: `gdelt-intel-article ${toneClass}`.trim(),
    },
      h('div', { className: 'article-header' },
        h('span', { className: 'article-source' }, domain),
        h('span', { className: 'article-time' }, timeAgo),
      ),
      h('div', { className: 'article-title' }, article.title),
    );
  }

  public async refresh(): Promise<void> {
    await this.loadActiveTopic();
  }

  public async refreshAll(): Promise<void> {
    this.topicData.clear();
    this.timelineData.clear();
    await this.loadActiveTopic();
  }
}
