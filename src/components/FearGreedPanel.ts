import { Panel } from './Panel';
import { escapeHtml } from '@/utils/sanitize';
import { getApiBaseUrl } from '@/services/runtime';

interface FearGreedResponse {
  score: number;
  classification: string;
  history: Array<{ value: number; timestamp: string }>;
  updatedAt: number;
}

function scoreColor(score: number): string {
  if (score < 25) return '#f44336';
  if (score < 45) return '#ff9800';
  if (score < 56) return '#ffd700';
  if (score < 75) return '#8bc34a';
  return '#4caf50';
}

function buildSparkline(history: FearGreedResponse['history']): string {
  if (history.length < 2) return '';

  const points = [...history].reverse();
  const values = points.map(p => p.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;

  const W = 200;
  const H = 40;
  const step = W / (points.length - 1);

  const coords = values.map((v, i) => {
    const x = i * step;
    const y = H - ((v - min) / range) * H;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });

  return `<svg class="fear-greed-sparkline" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" style="display:block;margin:8px auto 0;">
    <polyline points="${coords.join(' ')}" fill="none" stroke="#888" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>
  </svg>`;
}

function formatUpdated(updatedAt: number): string {
  const diffMs = Date.now() - updatedAt * 1000;
  const diffMin = Math.round(diffMs / 60_000);
  if (diffMin < 1) return 'Updated just now';
  if (diffMin < 60) return `Updated ${diffMin} min ago`;
  const hrs = Math.round(diffMin / 60);
  return `Updated ${hrs}h ago`;
}

export class FearGreedPanel extends Panel {
  private data: FearGreedResponse | null = null;
  private loading = true;
  private error: string | null = null;

  constructor() {
    super({
      id: 'fear-greed',
      title: 'Fear & Greed Index',
      showCount: false,
      infoTooltip: 'Crypto market sentiment index (0–100). Below 25 = Extreme Fear, above 75 = Extreme Greed. Source: alternative.me',
    });
    void this.fetchData();
  }

  public async fetchData(): Promise<void> {
    this.loading = true;
    this.error = null;
    this.showLoading();

    try {
      const res = await fetch(`${getApiBaseUrl()}/api/fear-greed`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      this.data = await res.json() as FearGreedResponse;
      this.error = null;
    } catch (err) {
      if (this.isAbortError(err)) return;
      this.error = err instanceof Error ? err.message : 'Failed to fetch';
    }

    this.loading = false;
    this.renderPanel();
  }

  private renderPanel(): void {
    if (this.loading) {
      this.showLoading();
      return;
    }

    if (this.error || !this.data) {
      this.showError(this.error ?? 'No data');
      return;
    }

    const { score, classification, history, updatedAt } = this.data;
    const color = scoreColor(score);
    const sparkline = buildSparkline(history);
    const updated = formatUpdated(updatedAt);

    const html = `
      <div style="text-align:center;padding:12px 8px 8px;">
        <div class="fear-greed-score" style="font-size:3rem;font-weight:700;color:${escapeHtml(color)};line-height:1;">${score}</div>
        <div class="fear-greed-label" style="font-size:0.85rem;font-weight:600;color:${escapeHtml(color)};margin-top:4px;text-transform:uppercase;letter-spacing:0.05em;">${escapeHtml(classification)}</div>
        ${sparkline}
        <div style="font-size:0.7rem;color:#888;margin-top:8px;">${escapeHtml(updated)}</div>
      </div>
    `;

    this.setContent(html);
  }
}
