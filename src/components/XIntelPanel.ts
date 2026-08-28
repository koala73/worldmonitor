import { Panel } from './Panel';
import { sanitizeUrl } from '@/utils/sanitize';
import { t } from '@/services/i18n';
import { h } from '@/utils/dom-utils';
import {
  X_TOPICS,
  formatXTime,
  type XItem,
  type XFeedResponse,
} from '@/services/x-intel';

const LIVE_THRESHOLD_MS = 600_000;

export class XIntelPanel extends Panel {
  private items: XItem[] = [];
  private activeTopic = 'all';
  private tabsEl: HTMLElement | null = null;
  private relayEnabled = true;
  private degraded = false;

  constructor() {
    super({
      id: 'x-intel',
      title: t('panels.xIntel'),
      showCount: true,
      trackActivity: true,
      defaultRowSpan: 2,
    });
    this.createTabs();
    this.showLoading(t('components.xIntel.loading'));
  }

  private createTabs(): void {
    this.tabsEl = h('div', { className: 'panel-tabs' },
      ...X_TOPICS.map(topic =>
        h('button', {
          className: `panel-tab ${topic.id === this.activeTopic ? 'active' : ''}`,
          dataset: { topicId: topic.id },
          onClick: () => this.selectTopic(topic.id),
        }, t(topic.labelKey)),
      ),
    );
    this.element.insertBefore(this.tabsEl, this.content);
  }

  private selectTopic(topicId: string): void {
    if (topicId === this.activeTopic) return;
    this.activeTopic = topicId;

    this.tabsEl?.querySelectorAll('.panel-tab').forEach(tab => {
      tab.classList.toggle('active', (tab as HTMLElement).dataset.topicId === topicId);
    });

    this.renderItems();
  }

  public setData(response: XFeedResponse & { error?: string }): void {
    this.relayEnabled = response.enabled !== false;
    this.degraded = response.degraded === true
      || ((response.coverage?.expected ?? 0) > 0 && response.coverage?.complete === false);
    // Clear items BEFORE the error branch. Assigning them first left stale
    // posts in `this.items` behind the error state, and a topic-tab click calls
    // renderItems() directly — repainting those stale posts over the error with
    // no indication the feed was unavailable. The relay can serve items with
    // `enabled: false` (startXPollLoop hydrates from Redis before the
    // X_ENABLED check), so this is reachable, not theoretical.
    if (!this.relayEnabled || response.error) {
      this.items = [];
      this.setCount(0);
      this.setContentNodes(
        h('div', { className: 'empty-state error' },
          response.error || t('components.xIntel.disabled'),
        ),
      );
      return;
    }

    this.items = (response.items || []).filter(item => item.contentState !== 'deleted');
    this.renderItems();
  }

  private renderItems(): void {
    const filtered = this.activeTopic === 'all'
      ? this.items
      : this.items.filter(item => item.topic === this.activeTopic);

    this.setCount(filtered.length);

    if (filtered.length === 0) {
      this.setContentNodes(
        this.degraded
          ? h('div', { className: 'x-intel-degraded', role: 'status' }, t('components.airlineIntel.degradedResults'))
          : null,
        h('div', { className: 'empty-state' }, t('components.xIntel.empty')),
      );
      return;
    }

    this.setContentNodes(
      this.degraded
        ? h('div', { className: 'x-intel-degraded', role: 'status' }, t('components.airlineIntel.degradedResults'))
        : null,
      h('div', { className: 'x-intel-items' }, ...filtered.map(item => this.buildItem(item))),
    );
  }

  private buildItem(item: XItem): HTMLElement {
    const timeAgo = formatXTime(item.ts);
    const itemDate = new Date(item.ts).getTime();
    const isLive = !Number.isNaN(itemDate) && (Date.now() - itemDate) < LIVE_THRESHOLD_MS;
    const text = (item.text || '').replace(/\s+/g, ' ').trim();

    return h('div', { className: `x-intel-item ${isLive ? 'is-live' : ''}` },
      h('div', { className: 'x-intel-item-header' },
        h('div', { className: 'x-intel-account-wrapper' },
          h('span', { className: 'x-intel-account' }, item.accountTitle || item.account),
          isLive ? h('span', { className: 'live-indicator' }, t('components.xIntel.live')) : null,
        ),
        h('div', { className: 'x-intel-meta' },
          h('span', { className: 'x-intel-topic' }, item.topic),
          h('span', { className: 'x-intel-time' }, timeAgo),
        ),
      ),
      text ? h('div', { className: 'x-intel-text' }, text) : null,
      h('div', { className: 'x-intel-item-actions' },
        h('a', {
          href: sanitizeUrl(item.url),
          target: '_blank',
          rel: 'noopener noreferrer',
          className: 'x-intel-follow-btn',
        }, t('components.xIntel.viewSource')),
      ),
    );
  }

  public async refresh(): Promise<void> {
    // Handled by DataLoader + RefreshScheduler
  }

  public destroy(): void {
    if (this.tabsEl) {
      this.tabsEl.remove();
      this.tabsEl = null;
    }
    super.destroy();
  }
}
