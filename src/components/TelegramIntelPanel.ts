import { Panel } from './Panel';
import { sanitizeUrl } from '@/utils/sanitize';
import { t } from '@/services/i18n';
import { h, replaceChildren } from '@/utils/dom-utils';
import {
  TELEGRAM_TOPICS,
  formatTelegramTime,
  type TelegramItem,
  type TelegramFeedResponse,
} from '@/services/telegram-intel';

export class TelegramIntelPanel extends Panel {
  private items: TelegramItem[] = [];
  private activeTopic = 'all';
  private tabsEl: HTMLElement | null = null;
  private relayEnabled = true;

  constructor() {
    super({
      id: 'telegram-intel',
      title: t('panels.telegramIntel'),
      showCount: true,
      trackActivity: true,
      infoTooltip: t('components.telegramIntel.infoTooltip'),
    });
    this.createTabs();
    this.showLoading(t('components.telegramIntel.loading'));
  }

  private createTabs(): void {
    this.tabsEl = h('div', { className: 'telegram-intel-tabs' },
      ...TELEGRAM_TOPICS.map(topic =>
        h('button', {
          className: `telegram-intel-tab ${topic.id === this.activeTopic ? 'active' : ''}`,
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

    this.tabsEl?.querySelectorAll('.telegram-intel-tab').forEach(tab => {
      tab.classList.toggle('active', (tab as HTMLElement).dataset.topicId === topicId);
    });

    this.renderItems();
  }

  public setData(response: TelegramFeedResponse): void {
    this.relayEnabled = response.enabled;
    this.items = response.items || [];

    if (!this.relayEnabled) {
      this.setCount(0);
      replaceChildren(this.content,
        h('div', { className: 'empty-state' }, t('components.telegramIntel.disabled')),
      );
      return;
    }

    this.renderItems();
  }

  private renderItems(): void {
    const filtered = this.activeTopic === 'all'
      ? this.items
      : this.items.filter(item => item.topic === this.activeTopic);

    this.setCount(filtered.length);

    if (filtered.length === 0) {
      replaceChildren(this.content,
        h('div', { className: 'empty-state' }, t('components.telegramIntel.empty')),
      );
      return;
    }

    replaceChildren(this.content,
      h('div', { className: 'telegram-intel-items' },
        ...filtered.map(item => this.buildItem(item)),
      ),
    );
  }

  private buildItem(item: TelegramItem): HTMLElement {
    const timeAgo = formatTelegramTime(item.ts);

    return h('a', {
      href: sanitizeUrl(item.url),
      target: '_blank',
      rel: 'noopener noreferrer',
      className: 'telegram-intel-item',
    },
      h('div', { className: 'telegram-intel-item-header' },
        h('span', { className: 'telegram-intel-channel' }, item.channelTitle || item.channel),
        h('span', { className: 'telegram-intel-topic' }, item.topic),
        h('span', { className: 'telegram-intel-time' }, timeAgo),
      ),
      h('div', { className: 'telegram-intel-text' }, item.text),
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
