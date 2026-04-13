import { Panel } from './Panel';
import type { Feed, NewsItem } from '@/types';
import { fetchCategoryFeeds } from '@/services';
import { rssProxyUrl } from '@/utils';
import { escapeHtml, sanitizeUrl } from '@/utils/sanitize';

const TRANSFER_FEEDS: Feed[] = [
  { name: 'Football Transfers', url: rssProxyUrl('https://news.google.com/rss/search?q=((football+OR+soccer)+transfer+OR+loan+OR+signing)+-%22transfer+portal%22+-college+-NCAA+when:7d&hl=en-US&gl=US&ceid=US:en') },
  { name: 'BBC Football', url: rssProxyUrl('https://feeds.bbci.co.uk/sport/football/rss.xml?edition=uk') },
  { name: 'ESPN Soccer', url: rssProxyUrl('https://www.espn.com/espn/rss/soccer/news') },
  { name: 'Guardian Football', url: rssProxyUrl('https://www.theguardian.com/football/rss') },
];

const TRANSFER_KEYWORDS = [
  'transfer',
  'loan',
  'signing',
  'signs',
  'signed',
  'joins',
  'joined',
  'bid',
  'bids',
  'deal',
  'move',
  'moves',
  'medical',
  'clause',
  'window',
  'rumor',
  'rumour',
];

function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

function dedupeNews(items: NewsItem[]): NewsItem[] {
  const seen = new Set<string>();
  const result: NewsItem[] = [];
  for (const item of items) {
    const key = `${item.link}|${item.title}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

function isTransferHeadline(item: NewsItem): boolean {
  const title = normalize(item.title);
  return TRANSFER_KEYWORDS.some((keyword) => title.includes(keyword));
}

function countFreshNews(items: NewsItem[]): number {
  const cutoff = Date.now() - (36 * 60 * 60 * 1000);
  return items.filter((item) => item.pubDate.getTime() >= cutoff).length;
}

function isFreshNews(item: NewsItem): boolean {
  return item.pubDate.getTime() >= Date.now() - (36 * 60 * 60 * 1000);
}

export class SportsTransferNewsPanel extends Panel {
  private items: NewsItem[] = [];

  constructor() {
    super({
      id: 'sports-transfers',
      title: 'Transfer News',
      showCount: true,
      infoTooltip: 'Football transfer headlines aggregated from BBC, ESPN, and Google News football transfer feeds.',
    });
  }

  public async fetchData(): Promise<boolean> {
    this.showLoading('Loading transfer news...');
    try {
      const fetched = await fetchCategoryFeeds(TRANSFER_FEEDS, { batchSize: 2 });
      const deduped = dedupeNews(fetched);
      const filtered = deduped.filter(isTransferHeadline);
      this.items = (filtered.length ? filtered : deduped).slice(0, 10);

      if (this.items.length === 0) {
        this.showError('No transfer headlines available right now.', () => void this.fetchData());
        return false;
      }

      this.setCount(this.items.length);
      const freshCount = countFreshNews(this.items);
      this.setNewBadge(freshCount, freshCount > 0);
      this.renderPanel();
      return true;
    } catch (error) {
      if (this.isAbortError(error)) return false;
      this.showError('Failed to load transfer news.', () => void this.fetchData());
      return false;
    }
  }

  private renderPanel(): void {
    const html = `
      <div style="display:grid;gap:10px;padding:2px 2px 8px;">
        <section style="border:1px solid rgba(255,255,255,0.08);border-radius:10px;padding:10px 12px;background:rgba(255,255,255,0.02);">
          <div style="font-size:12px;line-height:1.6;color:rgba(255,255,255,0.72);">
            Latest football moves, bids, loans, and transfer-window headlines aggregated from BBC, ESPN, and Google News transfer searches.
          </div>
        </section>
        <section style="display:grid;gap:8px;">
          ${this.items.map((item) => `
            <a href="${sanitizeUrl(item.link)}" target="_blank" rel="noopener" style="display:grid;gap:5px;padding:10px 12px;border-radius:10px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.06);text-decoration:none;color:inherit;">
              <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px;">
                <span style="font-size:13px;font-weight:600;line-height:1.45;">${escapeHtml(item.title)}</span>
                ${isFreshNews(item) ? '<span style="display:inline-flex;align-items:center;padding:2px 6px;border-radius:999px;background:rgba(59,130,246,0.18);color:#93c5fd;font-size:10px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;">New</span>' : ''}
              </div>
              <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:10px;color:rgba(255,255,255,0.46);">
                <span>${escapeHtml(item.source)}</span>
                <span>${escapeHtml(item.pubDate.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }))}</span>
              </div>
            </a>
          `).join('')}
        </section>
      </div>
    `;

    this.setContent(html);
  }
}
