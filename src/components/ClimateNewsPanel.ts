import { Panel } from './Panel';
import { getCurrentLanguageTag, t } from '@/services/i18n';
import { joinSafeHtml, safeHtml, safeUrlAttr, type SafeHtml } from '@/utils/sanitize';
import { formatTime } from '@/utils';
import { getHydratedData } from '@/services/bootstrap';
import { createLazyClient, getRpcBaseUrl, rpcFetch } from '@/services/rpc-client';
import { translateText } from '@/services/summarization';
import { getAuthState, subscribeAuthState } from '@/services/auth-state';
import { onEntitlementChange } from '@/services/entitlements';
import { hasPremiumAccess } from '@/services/panel-gating';
import { subscribeRuntimeConfig } from '@/services/runtime-config';
import { subscribeWidgetAccess } from '@/services/widget-store';

import type { ListClimateNewsResponse, ClimateNewsItem } from '@/generated/client/worldmonitor/climate/v1/service_client';
import { ClimateServiceClient } from '@/services/generated-rpc-clients';

const getClimateClient = createLazyClient(() => new ClimateServiceClient(getRpcBaseUrl(), { fetch: rpcFetch }));

interface CardTranslation {
  originals: string[];
  result: 'pending' | 'unavailable' | string[] | null;
}

function truncateSummary(text: string, maxLen = 120): string {
  if (!text || text.length <= maxLen) return text || '';
  return text.slice(0, maxLen).replace(/\s+\S*$/, '') + '...';
}

function renderNewsCard(item: ClimateNewsItem, target: string, translatable: boolean): SafeHtml {
  const timeAgo = item.publishedAt ? formatTime(new Date(item.publishedAt)) : '';
  const summary = truncateSummary(item.summary);
  const safeUrl = safeUrlAttr(item.url);
  const key = translatable
    ? JSON.stringify([item.url, item.sourceName, item.publishedAt, item.title, item.summary, target])
    : '';

  const inner = safeHtml`<div class="climate-news-card__header">
      <span class="climate-news-card__source">${item.sourceName}</span>
      <span class="climate-news-card__time">${timeAgo}</span>
    </div>
    <div class="climate-news-card__title">${item.title}</div>
    ${summary ? safeHtml`<div class="climate-news-card__summary">${summary}</div>` : ''}`;
  const content = safeUrl.toString()
    ? safeHtml`<a class="climate-news-card__content" href="${safeUrl}" target="_blank" rel="noopener noreferrer">${inner}</a>`
    : safeHtml`<div class="climate-news-card__content">${inner}</div>`;

  const translateLabel = translatable ? t('components.climateNews.translate') : '';
  return safeHtml`<div class="climate-news-card" data-translation-key="${key}">${content}${translatable
    ? safeHtml`<button type="button" class="climate-news-card__translate" title="${translateLabel}" aria-label="${translateLabel}">文</button>
      <div class="climate-news-card__translation-status" role="status"></div>`
    : ''}</div>`;
}

function cardTextElements(card: HTMLElement): NodeListOf<HTMLElement> {
  return card.querySelectorAll('.climate-news-card__title, .climate-news-card__summary');
}

function showTranslation(card: HTMLElement, state: CardTranslation): void {
  const button = card.querySelector<HTMLButtonElement>('.climate-news-card__translate');
  const status = card.querySelector('.climate-news-card__translation-status');
  if (!button || !status) return;

  const translated = Array.isArray(state.result);
  const pending = state.result === 'pending';
  const label = t(translated ? 'components.climateNews.restoreOriginal' : 'components.climateNews.translate');
  const text = Array.isArray(state.result) ? state.result : state.originals;
  cardTextElements(card).forEach((el, index) => { el.textContent = text[index] ?? ''; });
  button.classList.toggle('translated', translated);
  button.setAttribute('aria-disabled', String(pending));
  button.setAttribute('aria-label', label);
  button.title = label;
  button.textContent = translated ? '✓' : pending ? '…' : '文';
  status.textContent = state.result === 'unavailable' ? t('components.newsPanel.translationUnavailable') : '';
}

export class ClimateNewsPanel extends Panel {
  private readonly translations = new Map<string, CardTranslation>();
  private readonly unsubscribers: Array<() => void> = [];
  private lastData: ListClimateNewsResponse | null = null;
  private translationAllowed = false;

  constructor() {
    super({ id: 'climate-news', title: t('panels.climateNews'), infoTooltip: t('components.climateNews.infoTooltip') });
    this.content.addEventListener('click', (event) => {
      const button = (event.target as HTMLElement | null)?.closest('.climate-news-card__translate');
      const card = button?.closest<HTMLElement>('.climate-news-card');
      if (card) void this.toggleTranslation(card);
    });
    // Translation is a Pro feature. hasPremiumAccess also counts a tester key
    // and the desktop API key, so re-check on each of its signals.
    const recheck = () => this.syncTranslationAccess();
    this.unsubscribers.push(
      subscribeAuthState(recheck),
      onEntitlementChange(recheck),
      subscribeWidgetAccess(recheck),
      subscribeRuntimeConfig(recheck),
    );
  }

  private syncTranslationAccess(): void {
    const allowed = hasPremiumAccess(getAuthState());
    if (allowed === this.translationAllowed) return;
    this.translationAllowed = allowed;
    if (!allowed) this.translations.clear();
    // Commit a revocation at once: a debounced one could be cancelled by a
    // restored render whose HTML matches the translated cards still on screen.
    if (this.lastData) this.renderNewsList(this.lastData, !allowed);
  }

  private async toggleTranslation(card: HTMLElement): Promise<void> {
    const key = card.dataset.translationKey;
    if (!key || !hasPremiumAccess(getAuthState())) return;

    const previous = this.translations.get(key);
    if (previous?.result === 'pending') return;
    if (previous && Array.isArray(previous.result)) {
      this.updateTranslationCards(key, { ...previous, result: null });
      this.translations.delete(key);
      return;
    }

    const target = getCurrentLanguageTag();
    const originals = Array.from(cardTextElements(card), (el) => el.textContent ?? '');
    const state: CardTranslation = { originals, result: 'pending' };
    this.translations.set(key, state);
    this.updateTranslationCards(key, state);

    try {
      const translations = await Promise.all(originals.map((text) => translateText(text, target)));
      state.result = translations.every((text): text is string => !!text) ? translations : 'unavailable';
    } catch {
      state.result = 'unavailable';
    }
    if (this.translations.get(key) !== state || !this.element.isConnected) return;

    this.updateTranslationCards(key, state);
  }

  private updateTranslationCards(key: string, state: CardTranslation): void {
    for (const card of this.translationCards()) {
      if (card.dataset.translationKey === key) showTranslation(card, state);
    }
  }

  private translationCards(): NodeListOf<HTMLElement> {
    return this.content.querySelectorAll('.climate-news-card[data-translation-key]:not([data-translation-key=""])');
  }

  public async fetchData(): Promise<void> {
    try {
      const hydrated = getHydratedData('climateNews') as ListClimateNewsResponse | undefined;
      if (hydrated?.items?.length) {
        if (!this.element?.isConnected) return;
        this.renderNewsList(hydrated);
        void getClimateClient().listClimateNews({}).then(data => {
          if (!this.element?.isConnected || !data.items?.length) return;
          this.renderNewsList(data);
        }).catch(() => {});
        return;
      }
      const data = await getClimateClient().listClimateNews({});
      if (!this.element?.isConnected) return;
      this.renderNewsList(data);
    } catch (err) {
      if (this.isAbortError(err)) return;
      if (!this.element?.isConnected) return;
      this.showError(t('components.climateNews.loadError'), () => void this.fetchData());
    }
  }

  private renderNewsList(data: ListClimateNewsResponse, immediate = false): void {
    if (!data.items?.length) {
      this.showError(t('components.climateNews.loadError'), () => void this.fetchData());
      return;
    }

    this.lastData = data;
    this.translationAllowed = hasPremiumAccess(getAuthState());
    if (!this.translationAllowed) this.translations.clear();
    const target = getCurrentLanguageTag();
    const translatable = this.translationAllowed && target !== 'en';
    const cards = joinSafeHtml(data.items.map((item) => renderNewsCard(item, target, translatable)));
    const commit = immediate ? this.setSafeContentImmediate.bind(this) : this.setSafeContent.bind(this);
    commit(safeHtml`<div class="climate-news-list">${cards}</div>`, () => {
      const visibleKeys = new Set<string>();
      for (const card of this.translationCards()) {
        const key = card.dataset.translationKey;
        if (!key) continue;
        visibleKeys.add(key);
        const state = this.translations.get(key);
        if (state) showTranslation(card, state);
      }
      for (const key of this.translations.keys()) {
        if (!visibleKeys.has(key)) this.translations.delete(key);
      }
    });
  }

  public override destroy(): void {
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
    super.destroy();
  }
}
