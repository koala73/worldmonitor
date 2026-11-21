import { Panel } from './Panel';
import { getCurrentLanguage, getCurrentLanguageTag, t } from '@/services/i18n';
import { joinSafeHtml, safeHtml, safeUrlAttr, type SafeHtml } from '@/utils/sanitize';
import { formatTime } from '@/utils';
import { getHydratedData } from '@/services/bootstrap';
import { createLazyClient, getRpcBaseUrl, rpcFetch } from '@/services/rpc-client';
import { translateText } from '@/services/summarization';

import type { ListClimateNewsResponse, ClimateNewsItem } from '@/generated/client/worldmonitor/climate/v1/service_client';
import { ClimateServiceClient } from '@/services/generated-rpc-clients';

const getClimateClient = createLazyClient(() => new ClimateServiceClient(getRpcBaseUrl(), { fetch: rpcFetch }));

// The same labels NewsPanel's translate control uses. Deliberately not new
// locale keys: the app catalogues are translated in a separate pass
// (scripts/translate-locales.mjs) and tests/app-locale-freshness.test.mjs
// rejects bulk English placeholder copies, so shipping 28 of them to add one
// tooltip would be worse than matching the control the reader already knows.
const TRANSLATE_LABEL = 'Translate';
const ORIGINAL_LABEL_PREFIX = 'Original: ';

function truncateSummary(text: string, maxLen = 120): string {
  if (!text || text.length <= maxLen) return text || '';
  return text.slice(0, maxLen).replace(/\s+\S*$/, '') + '...';
}

function renderNewsCard(item: ClimateNewsItem): SafeHtml {
  // Localized relative time through the shared formatter, which the news
  // panels already use. The hand-rolled version here emitted English
  // ("2h ago") into every locale.
  const timeAgo = item.publishedAt ? formatTime(new Date(item.publishedAt)) : '';
  const summary = truncateSummary(item.summary);
  const safeUrl = safeUrlAttr(item.url);
  // Same rule as NewsPanel: offer the control only when the reader's UI is not
  // English, because these feeds publish in English.
  const translatable = getCurrentLanguage() !== 'en';

  const inner = safeHtml`<div class="climate-news-card__header">
      <span class="climate-news-card__source">${item.sourceName}</span>
      <span class="climate-news-card__time">${timeAgo}</span>
      ${translatable
        ? safeHtml`<button type="button" class="climate-news-card__translate" title="${TRANSLATE_LABEL}" aria-label="${TRANSLATE_LABEL}">文</button>`
        : ''}
    </div>
    <div class="climate-news-card__title">${item.title}</div>
    ${summary ? safeHtml`<div class="climate-news-card__summary">${summary}</div>` : ''}`;

  if (!safeUrl.toString()) return safeHtml`<div class="climate-news-card">${inner}</div>`;
  return safeHtml`<a class="climate-news-card" href="${safeUrl}" target="_blank" rel="noopener noreferrer">${inner}</a>`;
}

export class ClimateNewsPanel extends Panel {
  constructor() {
    super({ id: 'climate-news', title: t('panels.climateNews'), infoTooltip: t('components.climateNews.infoTooltip') });
    this.content.addEventListener('click', (event) => {
      const button = (event.target as HTMLElement | null)?.closest<HTMLElement>('.climate-news-card__translate');
      if (!button) return;
      // The card is an <a> when the item has a URL, so the click must not
      // follow the link or bubble into the card's own handling.
      event.preventDefault();
      event.stopPropagation();
      void this.toggleTranslation(button);
    });
  }

  /**
   * Translate a card's title and summary on demand, and put the originals back
   * on a second press. Nothing is translated up front: these feeds are
   * English, the reader may not want a machine rendering, and each call spends
   * a provider request.
   */
  private async toggleTranslation(button: HTMLElement): Promise<void> {
    const card = button.closest('.climate-news-card');
    if (!card || button.hasAttribute('disabled')) return;

    const parts = ['title', 'summary']
      .map((part) => card.querySelector<HTMLElement>(`.climate-news-card__${part}`))
      .filter((el): el is HTMLElement => el !== null);
    if (!parts.length) return;

    // Second press: restore what the source published.
    if (button.classList.contains('translated')) {
      for (const el of parts) {
        if (el.dataset.original !== undefined) el.textContent = el.dataset.original;
        delete el.dataset.original;
      }
      button.classList.remove('translated');
      button.textContent = '文';
      button.title = TRANSLATE_LABEL;
      return;
    }

    // Region matters: zh renders as Simplified unless the full tag is passed.
    const target = getCurrentLanguageTag();
    button.setAttribute('disabled', '');
    button.textContent = '…';
    try {
      const originals = parts.map((el) => el.textContent ?? '');
      const translations = await Promise.all(originals.map((text) => translateText(text, target)));
      if (!this.element?.isConnected || !card.isConnected) return;
      // All or nothing: a half-translated card reads as a source that mixed
      // languages rather than a translation that partly failed.
      if (translations.some((value) => !value)) {
        button.textContent = '文';
        button.title = t('components.newsPanel.translationUnavailable');
        return;
      }
      parts.forEach((el, index) => {
        el.dataset.original = originals[index];
        el.textContent = translations[index] as string;
      });
      button.classList.add('translated');
      button.textContent = '✓';
      button.title = ORIGINAL_LABEL_PREFIX + originals[0];
    } catch {
      if (!this.element?.isConnected) return;
      button.textContent = '文';
      button.title = t('components.newsPanel.translationUnavailable');
    } finally {
      button.removeAttribute('disabled');
    }
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

  private renderNewsList(data: ListClimateNewsResponse): void {
    if (!data.items?.length) {
      this.showError(t('components.climateNews.loadError'), () => void this.fetchData());
      return;
    }

    const cards = joinSafeHtml(data.items.map(renderNewsCard));
    this.setSafeContent(safeHtml`<div class="climate-news-list">${cards}</div>`);
  }
}
