import { Panel } from './Panel';
import type { GulfMarketItem } from '@/services/gulf-markets';
import { escapeHtml } from '@/utils/sanitize';

type GulfTab = 'markets' | 'currencies' | 'oil';

function miniSparkline(data: number[], change: number | null, w = 50, h = 16): string {
  if (!data || data.length < 2) return '';
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const color = change != null && change >= 0 ? 'var(--green)' : 'var(--red)';
  const points = data
    .map((v, i) => {
      const x = (i / (data.length - 1)) * w;
      const y = h - ((v - min) / range) * (h - 2) - 1;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" class="mini-sparkline"><polyline points="${points}" fill="none" stroke="${color}" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

function formatChange(change: number | null): string {
  if (change === null) return '—';
  const sign = change >= 0 ? '+' : '';
  return `${sign}${change.toFixed(2)}%`;
}

function formatPrice(price: number | null, type: GulfMarketItem['type']): string {
  if (price === null) return '—';
  if (type === 'currency') return price.toFixed(4);
  if (type === 'oil') return `$${price.toFixed(2)}`;
  return price.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function changeClass(change: number | null): string {
  if (change === null) return '';
  return change >= 0 ? 'positive' : 'negative';
}

export class GulfEconomyPanel extends Panel {
  private data: GulfMarketItem[] = [];
  private activeTab: GulfTab = 'markets';
  private lastUpdate: Date | null = null;

  constructor() {
    super({ id: 'gulf-economy', title: 'Gulf Economies' });
  }

  public update(data: GulfMarketItem[]): void {
    this.data = data;
    this.lastUpdate = new Date();
    this.render();
  }

  private render(): void {
    const indices    = this.data.filter(d => d.type === 'index');
    const currencies = this.data.filter(d => d.type === 'currency');
    const oil        = this.data.filter(d => d.type === 'oil');

    const tabs: Array<{ id: GulfTab; label: string; count: number }> = [
      { id: 'markets',    label: '📈 Markets',    count: indices.length },
      { id: 'currencies', label: '💱 Currencies', count: currencies.length },
      { id: 'oil',        label: '🛢️ Oil',         count: oil.length },
    ];

    const tabsHtml = `
      <div class="economic-tabs">
        ${tabs.map(t => `
          <button class="economic-tab ${this.activeTab === t.id ? 'active' : ''}" data-tab="${t.id}">
            ${t.label}
          </button>
        `).join('')}
      </div>
    `;

    let contentHtml = '';
    switch (this.activeTab) {
      case 'markets':    contentHtml = this.renderList(indices);    break;
      case 'currencies': contentHtml = this.renderList(currencies); break;
      case 'oil':        contentHtml = this.renderList(oil);        break;
    }

    const updateTime = this.lastUpdate
      ? this.lastUpdate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : '';

    this.setContent(`
      ${tabsHtml}
      <div class="economic-content">
        ${contentHtml}
      </div>
      <div class="economic-footer">
        <span class="economic-source">Yahoo Finance • ${escapeHtml(updateTime)}</span>
      </div>
    `);

    this.content.querySelectorAll('.economic-tab').forEach(tab => {
      tab.addEventListener('click', (e) => {
        const tabId = (e.target as HTMLElement).dataset.tab as GulfTab;
        if (tabId) {
          this.activeTab = tabId;
          this.render();
        }
      });
    });
  }

  private renderList(items: GulfMarketItem[]): string {
    if (items.length === 0) {
      return '<div class="economic-empty">No data available</div>';
    }

    return `
      <div class="gulf-economy-list">
        ${items.map(item => {
          const cc = changeClass(item.change);
          const arrow = item.change === null ? '' : item.change >= 0 ? '▲' : '▼';
          return `
            <div class="market-item">
              <div class="market-info">
                <span class="market-name">${escapeHtml(item.flag)} ${escapeHtml(item.name)}</span>
                <span class="market-symbol">${escapeHtml(item.country)}</span>
              </div>
              <div class="market-data">
                ${miniSparkline(item.sparkline, item.change)}
                <span class="market-price">${escapeHtml(formatPrice(item.price, item.type))}</span>
                <span class="market-change ${escapeHtml(cc)}">${escapeHtml(arrow)} ${escapeHtml(formatChange(item.change))}</span>
              </div>
            </div>
          `;
        }).join('')}
      </div>
    `;
  }
}
