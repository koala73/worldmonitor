import { Panel } from './Panel';
import { sanitizeUrl } from '@/utils/sanitize';
import { t } from '@/services/i18n';
import { h, replaceChildren, safeHtml } from '@/utils/dom-utils';
import {
  TELEGRAM_TOPICS,
  fetchTelegramChannelFeed,
  fetchTelegramChannelPreview,
  formatTelegramTime,
  type TelegramChannelPreview,
  type TelegramFeedResponse,
  type TelegramItem,
} from '@/services/telegram-intel';
import {
  getPrimarySourceProvenanceBadges,
  resolveRegisteredTelegramSourceName,
} from './news/source-provenance';
import {
  addTelegramWatchlistEntry,
  getTelegramWatchlistEntries,
  normalizeTelegramUsername,
  removeTelegramWatchlistEntry,
  subscribeTelegramWatchlistChange,
  TELEGRAM_WATCHLIST_MAX_ENTRIES,
  type TelegramWatchlistEntry,
} from '@/services/telegram-watchlist';

const LIVE_THRESHOLD_MS = 600_000;

// Collapsing every backend failure into one string told a user to fix their
// input when the real answer was "the relay is still starting, try shortly" —
// notably for the whole 120s window after a relay deploy. These reuse the
// panel's existing translated copy rather than introducing a string that would
// ship untranslated across 28 locales.
function describeTelegramLookupError(error: unknown): string {
  const status = (error as { status?: number } | null)?.status;
  if (status === 400) return t('components.telegramIntel.invalidUsername');
  // 429 (rate limited / flood cooldown), 503 (startup delay, client reset) and
  // 504 (lookup deadline) are all "come back shortly", not "bad input".
  if (status === 429 || status === 503 || status === 504) {
    return t('components.telegramIntel.disabled');
  }
  return t('components.telegramIntel.resolveFailed');
}
const WATCHLIST_PREVIEW_DEBOUNCE_MS = 800;
const WATCHLIST_BATCH_SIZE = 3;
const WATCHLIST_ITEM_LIMIT = 20;

type PreviewState = {
  channel: TelegramChannelPreview | null;
  error: string | null;
  loading: boolean;
  username: string;
};

// Dedup on a CASE-NORMALIZED handle, not on the raw id. The curated feed and a
// watchlist read can present the same post with differently-cased handles, and
// the id embeds the handle — so keying on the raw id shows the post twice.
// (tests/dom/telegram-intel-badges.test.mts pins exactly that case.) When the
// same post arrives from both sources, prefer the curated copy: it is the one
// carrying registry provenance, so the merged row keeps its trust badge and
// loses the "Custom" tag.
function mergeTelegramItems(...groups: TelegramItem[][]): TelegramItem[] {
  const itemsById = new Map<string, TelegramItem>();

  for (const group of groups) {
    for (const item of group) {
      if (!item?.id) continue;
      const separator = item.id.indexOf(':');
      const handle = separator > 0
        ? normalizeTelegramUsername(item.id.slice(0, separator))
        : '';
      const key = handle
        ? `${handle}:${item.id.slice(separator + 1)}`
        : item.id;
      const existing = itemsById.get(key);
      if (!existing || (existing.watchlist && !item.watchlist)) {
        itemsById.set(key, item);
      }
    }
  }

  return [...itemsById.values()].sort((a, b) => (b.ts || '').localeCompare(a.ts || ''));
}

export class TelegramIntelPanel extends Panel {
  private baseItems: TelegramItem[] = [];
  private watchlistItems: TelegramItem[] = [];
  private watchlistEntries: TelegramWatchlistEntry[] = getTelegramWatchlistEntries();
  private activeTopic = 'all';
  private tabsEl: HTMLElement | null = null;
  private controlsEl: HTMLElement | null = null;
  private watchlistPillsEl: HTMLElement | null = null;
  private previewEl: HTMLElement | null = null;
  private inputEl: HTMLInputElement | null = null;
  private relayEnabled = true;
  private previewState: PreviewState = { channel: null, error: null, loading: false, username: '' };
  private previewTimer: ReturnType<typeof setTimeout> | null = null;
  private previewRequestId = 0;
  private watchlistRequestId = 0;
  private unsubscribeWatchlist: (() => void) | null = null;

  constructor() {
    super({
      id: 'telegram-intel',
      title: t('panels.telegramIntel'),
      showCount: true,
      trackActivity: true,
      infoTooltip: t('components.telegramIntel.infoTooltip'),
      defaultRowSpan: 2,
    });
    this.createTabs();
    this.createControls();
    this.unsubscribeWatchlist = subscribeTelegramWatchlistChange(entries => {
      this.watchlistEntries = entries;
      this.renderWatchlistPills();
      this.renderPreview();
      void this.syncWatchlistFeed();
    });
    this.renderWatchlistPills();
    this.showLoading(t('components.telegramIntel.loading'));
  }

  private createTabs(): void {
    this.tabsEl = h('div', { className: 'panel-tabs' },
      ...TELEGRAM_TOPICS.map(topic =>
        h('button', {
          className: `panel-tab ${topic.id === this.activeTopic ? 'active' : ''}`,
          dataset: { topicId: topic.id },
          onClick: () => this.selectTopic(topic.id),
        }, t(topic.labelKey)),
      ),
    );
    this.element.insertBefore(this.tabsEl, this.content);
  }

  private createControls(): void {
    this.inputEl = h('input', {
      className: 'telegram-intel-input',
      type: 'text',
      placeholder: t('components.telegramIntel.watchlistPlaceholder'),
      'aria-label': t('components.telegramIntel.watchlistPlaceholder'),
      autocomplete: 'off',
      spellcheck: 'false',
      onInput: () => this.queuePreviewResolve(),
      onKeydown: (event: KeyboardEvent) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          void this.addPreviewChannel();
        }
      },
    }) as HTMLInputElement;

    this.previewEl = h('div', { className: 'telegram-intel-preview' });
    this.watchlistPillsEl = h('div', { className: 'telegram-intel-watchlist-pills' });
    this.controlsEl = h('div', { className: 'telegram-intel-controls' },
      h('div', { className: 'telegram-intel-input-row' }, this.inputEl),
      this.previewEl,
      this.watchlistPillsEl,
    );

    this.element.insertBefore(this.controlsEl, this.content);
  }

  private selectTopic(topicId: string): void {
    if (topicId === this.activeTopic) return;
    this.activeTopic = topicId;

    this.tabsEl?.querySelectorAll('.panel-tab').forEach(tab => {
      tab.classList.toggle('active', (tab as HTMLElement).dataset.topicId === topicId);
    });

    this.renderItems();
  }

  public setData(response: TelegramFeedResponse & { error?: string }): void {
    this.relayEnabled = response.enabled !== false && !response.error;
    this.baseItems = response.items || [];

    if (this.inputEl) {
      this.inputEl.disabled = !this.relayEnabled;
    }

    if (!this.relayEnabled || response.error) {
      this.watchlistRequestId++;
      this.watchlistItems = [];
      this.cancelPreviewResolve();
      this.setCount(0);
      replaceChildren(this.content,
        h('div', { className: 'empty-state error' },
          response.error || t('components.telegramIntel.disabled')
        ),
      );
      return;
    }

    this.renderItems();
    void this.syncWatchlistFeed();
  }

  private queuePreviewResolve(): void {
    if (!this.inputEl) return;
    if (this.previewTimer) {
      clearTimeout(this.previewTimer);
      this.previewTimer = null;
    }

    if (!this.relayEnabled) {
      this.cancelPreviewResolve();
      return;
    }

    const raw = this.inputEl.value || '';
    const normalized = normalizeTelegramUsername(raw);
    const requestId = ++this.previewRequestId;

    if (!raw.trim()) {
      this.previewState = { channel: null, error: null, loading: false, username: '' };
      this.renderPreview();
      return;
    }

    this.previewState = { channel: null, error: null, loading: true, username: normalized || raw.trim() };
    this.renderPreview();

    this.previewTimer = setTimeout(async () => {
      this.previewTimer = null;
      if (requestId !== this.previewRequestId || !this.relayEnabled) return;

      if (!normalized) {
        this.previewState = {
          channel: null,
          error: t('components.telegramIntel.invalidUsername'),
          loading: false,
          username: raw.trim(),
        };
        this.renderPreview();
        return;
      }

      try {
        const channel = await fetchTelegramChannelPreview(normalized);
        if (requestId !== this.previewRequestId || !this.relayEnabled) return;
        this.previewState = { channel, error: null, loading: false, username: normalized };
      } catch (error) {
        if (requestId !== this.previewRequestId || !this.relayEnabled) return;
        this.previewState = {
          channel: null,
          error: describeTelegramLookupError(error),
          loading: false,
          username: normalized,
        };
      }
      this.renderPreview();
    }, WATCHLIST_PREVIEW_DEBOUNCE_MS);
  }

  private cancelPreviewResolve(): void {
    this.previewRequestId++;
    if (this.previewTimer) {
      clearTimeout(this.previewTimer);
      this.previewTimer = null;
    }
    this.previewState = { channel: null, error: null, loading: false, username: '' };
    this.renderPreview();
  }

  private showWatchlistSaveError(username: string): void {
    this.previewState = {
      ...this.previewState,
      error: t('modals.settingsWindow.failed', { error: t('common.error') }),
      loading: false,
      username,
    };
    this.renderPreview();
  }

  private renderPreview(): void {
    if (!this.previewEl) return;

    if (this.previewState.loading) {
      replaceChildren(this.previewEl,
        h('div', { className: 'telegram-intel-preview-card is-loading' },
          t('components.telegramIntel.resolving')
        ),
      );
      return;
    }

    if (this.previewState.error && !this.previewState.channel) {
      replaceChildren(this.previewEl,
        h('div', { className: 'telegram-intel-preview-card is-error' }, this.previewState.error),
      );
      return;
    }

    if (!this.previewState.channel) {
      replaceChildren(this.previewEl);
      return;
    }

    const channel = this.previewState.channel;
    const alreadyAdded = this.watchlistEntries.some(entry => entry.username === channel.username);
    const memberCopy = channel.memberCount == null
      ? ''
      : t('components.telegramIntel.previewMembers', {
        count: new Intl.NumberFormat().format(channel.memberCount),
      });

    replaceChildren(this.previewEl,
      this.previewState.error
        ? h('div', { className: 'telegram-intel-preview-card is-error' }, this.previewState.error)
        : null,
      h('div', { className: 'telegram-intel-preview-card' },
        h('div', { className: 'telegram-intel-preview-copy' },
          h('div', { className: 'telegram-intel-preview-title' }, channel.title),
          h('div', { className: 'telegram-intel-preview-meta' },
            `@${channel.username}`,
            memberCopy ? ` • ${memberCopy}` : '',
          ),
        ),
        alreadyAdded
          ? h('span', { className: 'telegram-intel-preview-status' }, t('components.telegramIntel.added'))
          : h('button', {
            type: 'button',
            className: 'telegram-follow-btn',
            onClick: () => void this.addPreviewChannel(),
          }, t('components.telegramIntel.addChannel')),
      ),
    );
  }

  private async addPreviewChannel(): Promise<void> {
    const channel = this.previewState.channel;
    if (!channel || !this.relayEnabled) return;

    const alreadyAdded = this.watchlistEntries.some(entry => entry.username === channel.username);
    if (!alreadyAdded && this.watchlistEntries.length >= TELEGRAM_WATCHLIST_MAX_ENTRIES) {
      this.previewState = {
        channel: null,
        error: t('components.telegramIntel.watchlistLimit', { count: TELEGRAM_WATCHLIST_MAX_ENTRIES }),
        loading: false,
        username: channel.username,
      };
      this.renderPreview();
      return;
    }

    try {
      addTelegramWatchlistEntry({ username: channel.username, title: channel.title });
    } catch {
      this.showWatchlistSaveError(channel.username);
      return;
    }

    if (this.inputEl) {
      this.inputEl.value = '';
    }
    this.previewState = { channel: null, error: null, loading: false, username: '' };
    this.renderPreview();
  }

  private renderWatchlistPills(): void {
    if (!this.watchlistPillsEl) return;

    if (this.watchlistEntries.length === 0) {
      this.watchlistPillsEl.classList.add('is-empty');
      replaceChildren(this.watchlistPillsEl);
      return;
    }

    this.watchlistPillsEl.classList.remove('is-empty');
    replaceChildren(this.watchlistPillsEl,
      ...this.watchlistEntries.map(entry =>
        h('button', {
          type: 'button',
          className: 'telegram-intel-pill',
          onClick: () => {
            try {
              removeTelegramWatchlistEntry(entry.username);
            } catch {
              this.showWatchlistSaveError(entry.username);
            }
          },
          title: `${t('components.telegramIntel.remove')} @${entry.username}`,
          'aria-label': `${t('components.telegramIntel.remove')} @${entry.username}`,
        },
        h('span', { className: 'telegram-intel-pill-label' }, `@${entry.username}`),
        h('span', { className: 'telegram-intel-pill-remove', 'aria-hidden': 'true' }, '×'),
        ),
      ),
    );
  }

  private async syncWatchlistFeed(): Promise<void> {
    const requestId = ++this.watchlistRequestId;

    if (!this.relayEnabled) {
      return;
    }

    if (this.watchlistEntries.length === 0) {
      this.watchlistItems = [];
      this.renderItems();
      return;
    }

    const items: TelegramItem[] = [];

    for (let index = 0; index < this.watchlistEntries.length; index += WATCHLIST_BATCH_SIZE) {
      const batch = this.watchlistEntries.slice(index, index + WATCHLIST_BATCH_SIZE);
      const results = await Promise.allSettled(
        batch.map(entry => fetchTelegramChannelFeed(entry.username, WATCHLIST_ITEM_LIMIT)),
      );

      if (requestId !== this.watchlistRequestId) return;

      for (const result of results) {
        if (result.status === 'fulfilled') {
          items.push(...result.value.items);
        } else {
          console.warn('[TelegramIntel] Watchlist channel fetch failed:', result.reason);
        }
      }

      // Publish after every batch. Holding everything until the final batch
      // meant a run superseded by the next 60s refresh threw away work it had
      // already completed, so under a slow relay the panel could keep
      // restarting and never show watchlist posts at all.
      this.watchlistItems = mergeTelegramItems(items);
      this.renderItems();
    }
  }

  private renderItems(): void {
    const mergedItems = mergeTelegramItems(this.watchlistItems, this.baseItems);
    const filtered = this.activeTopic === 'all'
      ? mergedItems
      : mergedItems.filter(item => item.topic === this.activeTopic);

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
    const itemDate = new Date(item.ts).getTime();
    const isLive = !Number.isNaN(itemDate) && (Date.now() - itemDate) < LIVE_THRESHOLD_MS;
    const raw = item.text || '';
    const escaped = raw
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
    const textHtml = escaped.replace(/\n/g, '<br>');

    // Handle-only lookup, deliberately: resolving through the channel TITLE
    // would let a user-added channel called "BBC News" inherit a curated
    // outlet's trust badge. An unregistered handle gets the explicit unreviewed
    // marker instead of no badge at all, so an unvetted channel stays visibly
    // unvetted rather than merely unlabelled.
    const sourceName = resolveRegisteredTelegramSourceName(item.channel);
    const provenance = sourceName
      ? getPrimarySourceProvenanceBadges(sourceName)
      : {
        risk: {
          className: 'propaganda-badge unknown',
          title: 'Provenance not yet reviewed',
          label: '? Unreviewed',
        },
        tier: null,
      };
    const riskBadge = provenance.risk
      ? h('span', { className: provenance.risk.className, title: provenance.risk.title }, provenance.risk.label)
      : null;
    const tierBadge = provenance.tier
      ? h('span', { className: provenance.tier.className, title: provenance.tier.title }, provenance.tier.label)
      : null;

    return h('div', { className: `telegram-intel-item ${isLive ? 'is-live' : ''}` },
      h('div', { className: 'telegram-intel-item-header' },
        h('div', { className: 'telegram-intel-channel-wrapper' },
          h('span', { className: 'telegram-intel-channel' }, item.channelTitle || item.channel),
          riskBadge,
          tierBadge,
          item.watchlist
            ? h('span', { className: 'telegram-intel-custom-tag' }, t('components.telegramIntel.custom'))
            : null,
          isLive ? h('span', { className: 'live-indicator' }, t('components.telegramIntel.live')) : null,
        ),
        h('div', { className: 'telegram-intel-meta' },
          h('span', { className: 'telegram-intel-topic' }, item.topic),
          h('span', { className: 'telegram-intel-time' }, timeAgo),
        ),
      ),
      h('div', { className: 'telegram-intel-text' }, safeHtml(textHtml)),
      item.mediaUrls && item.mediaUrls.length > 0 ? h('div', { className: 'telegram-intel-media-grid' },
        ...item.mediaUrls.map(url => {
          const isVideo = url.match(/\.(mp4|webm|mov)(\?.*)?$/i);
          if (isVideo) {
            return h('video', {
              className: 'telegram-intel-video',
              src: sanitizeUrl(url),
              controls: true,
              preload: 'metadata',
              playsinline: true,
            });
          }
          return h('img', {
            className: 'telegram-intel-image',
            src: sanitizeUrl(url),
            loading: 'lazy',
            onClick: () => window.open(sanitizeUrl(url), '_blank', 'noopener,noreferrer'),
          });
        })
      ) : null,
      h('div', { className: 'telegram-intel-item-actions' },
        h('a', {
          href: sanitizeUrl(item.url),
          target: '_blank',
          rel: 'noopener noreferrer',
          className: 'telegram-follow-btn',
        }, t('components.telegramIntel.viewSource')),
      ),
    );
  }

  public async refresh(): Promise<void> {
    // Handled by DataLoader + RefreshScheduler
  }

  public destroy(): void {
    this.previewRequestId++;
    this.watchlistRequestId++;
    if (this.previewTimer) {
      clearTimeout(this.previewTimer);
      this.previewTimer = null;
    }
    this.unsubscribeWatchlist?.();
    this.unsubscribeWatchlist = null;

    if (this.controlsEl) {
      this.controlsEl.remove();
      this.controlsEl = null;
    }
    if (this.tabsEl) {
      this.tabsEl.remove();
      this.tabsEl = null;
    }
    super.destroy();
  }
}
