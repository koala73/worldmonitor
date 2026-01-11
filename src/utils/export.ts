import type { NewsItem, ClusteredEvent, MarketData, PredictionMarket } from '@/types';

type ExportFormat = 'json' | 'csv';

interface ExportData {
  news?: NewsItem[] | ClusteredEvent[];
  markets?: MarketData[];
  predictions?: PredictionMarket[];
  signals?: unknown[];
  timestamp: number;
}

export function exportToJSON(data: ExportData, filename = 'worldmonitor-export'): void {
  const jsonStr = JSON.stringify(data, null, 2);
  downloadFile(jsonStr, `${filename}.json`, 'application/json');
}

export function exportToCSV(data: ExportData, filename = 'worldmonitor-export'): void {
  const lines: string[] = [];

  if (data.news && data.news.length > 0) {
    lines.push('=== NEWS ===');
    lines.push('Title,Source,Link,Published,IsAlert');
    data.news.forEach(item => {
      if ('primaryTitle' in item) {
        const cluster = item as ClusteredEvent;
        lines.push(csvRow([
          cluster.primaryTitle,
          cluster.primarySource,
          cluster.primaryLink,
          cluster.lastUpdated.toISOString(),
          String(cluster.isAlert),
        ]));
      } else {
        const news = item as NewsItem;
        lines.push(csvRow([
          news.title,
          news.source,
          news.link,
          news.pubDate?.toISOString() || '',
          String(news.isAlert),
        ]));
      }
    });
    lines.push('');
  }

  if (data.markets && data.markets.length > 0) {
    lines.push('=== MARKETS ===');
    lines.push('Symbol,Name,Price,Change');
    data.markets.forEach(m => {
      lines.push(csvRow([m.symbol, m.name, String(m.price ?? ''), String(m.change ?? '')]));
    });
    lines.push('');
  }

  if (data.predictions && data.predictions.length > 0) {
    lines.push('=== PREDICTIONS ===');
    lines.push('Title,Yes Price,Volume');
    data.predictions.forEach(p => {
      lines.push(csvRow([p.title, String(p.yesPrice), String(p.volume ?? '')]));
    });
    lines.push('');
  }

  downloadFile(lines.join('\n'), `${filename}.csv`, 'text/csv');
}

function csvRow(values: string[]): string {
  return values.map(v => `"${(v || '').replace(/"/g, '""')}"`).join(',');
}

function downloadFile(content: string, filename: string, mimeType: string): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

export class ExportPanel {
  private element: HTMLElement;
  private isOpen = false;
  private getData: () => ExportData;

  constructor(getDataFn: () => ExportData) {
    this.getData = getDataFn;
    this.element = document.createElement('div');
    this.element.className = 'export-panel-container';
    this.element.innerHTML = `
      <button class="export-btn" title="Export Data">⬇</button>
      <div class="export-menu hidden">
        <button class="export-option" data-format="csv">Export CSV</button>
        <button class="export-option" data-format="json">Export JSON</button>
      </div>
    `;

    this.setupEventListeners();
  }

  private setupEventListeners(): void {
    const btn = this.element.querySelector('.export-btn')!;
    const menu = this.element.querySelector('.export-menu')!;

    btn.addEventListener('click', () => {
      this.isOpen = !this.isOpen;
      menu.classList.toggle('hidden', !this.isOpen);
    });

    document.addEventListener('click', (e) => {
      if (!this.element.contains(e.target as Node)) {
        this.isOpen = false;
        menu.classList.add('hidden');
      }
    });

    this.element.querySelectorAll('.export-option').forEach(option => {
      option.addEventListener('click', () => {
        const format = (option as HTMLElement).dataset.format as ExportFormat;
        this.export(format);
        this.isOpen = false;
        menu.classList.add('hidden');
      });
    });
  }

  private export(format: ExportFormat): void {
    const data = this.getData();
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `worldmonitor-${timestamp}`;

    if (format === 'json') {
      exportToJSON(data, filename);
    } else {
      exportToCSV(data, filename);
    }
  }

  public getElement(): HTMLElement {
    return this.element;
  }
}
