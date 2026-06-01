import { Panel } from './Panel';
import { t } from '@/services/i18n';
import { joinSafeHtml, safeHtml, safeUrlAttr, type SafeHtml } from '@/utils/sanitize';
import { getHydratedData } from '@/services/bootstrap';
import { getRpcBaseUrl } from '@/services/rpc-client';
import { ClimateServiceClient } from '@/generated/client/worldmonitor/climate/v1/service_client';
import type { ListClimateNewsResponse, ClimateNewsItem } from '@/generated/client/worldmonitor/climate/v1/service_client';

const client = new ClimateServiceClient(getRpcBaseUrl(), { fetch: (...args: Parameters<typeof fetch>) => globalThis.fetch(...args) });

function formatTimeAgo(epochMs: number): string {
  const diffMs = Date.now() - epochMs;
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return '1d ago';
  return `${days}d ago`;
}

function truncateSummary(text: string, maxLen = 120): string {
  if (!text || text.length <= maxLen) return text || '';
  return text.slice(0, maxLen).replace(/\s+\S*$/, '') + '...';
}

function renderNewsCard(item: ClimateNewsItem): SafeHtml {
  const timeAgo = item.publishedAt ? formatTimeAgo(item.publishedAt) : '';
  const summary = truncateSummary(item.summary);
  const safeUrl = safeUrlAttr(item.url);

  const inner = safeHtml`<div class="climate-news-card__header">
      <span class="climate-news-card__source">${item.sourceName}</span>
      <span class="climate-news-card__time">${timeAgo}</span>
    </div>
    <div class="climate-news-card__title">${item.title}</div>
    ${summary ? safeHtml`<div class="climate-news-card__summary">${summary}</div>` : ''}`;

  if (!safeUrl.toString()) return safeHtml`<div class="climate-news-card">${inner}</div>`;
  return safeHtml`<a class="climate-news-card" href="${safeUrl}" target="_blank" rel="noopener noreferrer">${inner}</a>`;
}

export class ClimateNewsPanel extends Panel {
  constructor() {
    super({ id: 'climate-news', title: t('panels.climateNews'), infoTooltip: t('components.climateNews.infoTooltip') });
  }

  public async fetchData(): Promise<void> {
    try {
      const hydrated = getHydratedData('climateNews') as ListClimateNewsResponse | undefined;
      if (hydrated?.items?.length) {
        if (!this.element?.isConnected) return;
        this.renderNewsList(hydrated);
        void client.listClimateNews({}).then(data => {
          if (!this.element?.isConnected || !data.items?.length) return;
          this.renderNewsList(data);
        }).catch(() => {});
        return;
      }
      const data = await client.listClimateNews({});
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
