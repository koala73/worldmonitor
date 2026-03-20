import { escapeHtml } from '@/utils/sanitize';

export interface BriefResponse {
  date?: string;
  summary?: string;
  sourceCount?: number;
  generatedAt?: string;
}

export interface BriefViewModel {
  dateLabel: string;
  points: string[];
  sourceCount: number;
}

export function parseBriefPoints(summary: string): string[] {
  if (!summary) return [];

  // 兼容 markdown 列表与纯文本段落。
  const rows = summary
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/^[-*]\s+/, '').trim())
    .filter(Boolean);

  return rows.slice(0, 5);
}

export function toBriefViewModel(payload: BriefResponse): BriefViewModel {
  const dateLabel = payload.date || payload.generatedAt?.slice(0, 10) || new Date().toISOString().slice(0, 10);
  const points = parseBriefPoints(payload.summary || '');
  const sourceCount = Number.isFinite(payload.sourceCount) ? Number(payload.sourceCount) : 0;
  return { dateLabel, points, sourceCount };
}

export class DailyBrief {
  private readonly container: HTMLElement;
  private readonly triggerButton: HTMLElement;
  private readonly onBackdropClick: EventListener;
  private readonly onOpenClick: EventListener;

  constructor(container: HTMLElement, triggerButton: HTMLElement) {
    this.container = container;
    this.triggerButton = triggerButton;
    this.onBackdropClick = (event: Event) => {
      const target = event.target as HTMLElement | null;
      if (!target) return;
      if (target.id === 'dailyBriefOverlay' || target.id === 'dailyBriefCloseBtn') this.close();
    };
    this.onOpenClick = () => {
      void this.open();
    };
  }

  public mount(): void {
    this.renderShell();
    this.triggerButton.addEventListener('click', this.onOpenClick);
    this.container.addEventListener('click', this.onBackdropClick);
  }

  public destroy(): void {
    this.triggerButton.removeEventListener('click', this.onOpenClick);
    this.container.removeEventListener('click', this.onBackdropClick);
  }

  public async open(): Promise<void> {
    const overlay = this.container.querySelector<HTMLElement>('#dailyBriefOverlay');
    const content = this.container.querySelector<HTMLElement>('#dailyBriefContent');
    if (!overlay || !content) return;

    overlay.classList.add('open');
    content.innerHTML = '<div class="daily-brief-state">Loading today\'s highlights...</div>';
    window.dispatchEvent(new CustomEvent('daily-brief:open'));

    try {
      const response = await fetch('/api/brief');
      if (!response.ok) throw new Error(`HTTP_${response.status}`);
      const payload = (await response.json()) as BriefResponse;
      const vm = toBriefViewModel(payload);
      content.innerHTML = this.renderBody(vm);
    } catch {
      content.innerHTML = `
        <div class="daily-brief-state daily-brief-error">
          Failed to load today's brief. <button id="dailyBriefRetryBtn" class="daily-brief-retry">Retry</button>
        </div>
      `;
      this.container.querySelector('#dailyBriefRetryBtn')?.addEventListener('click', () => {
        void this.open();
      }, { once: true });
    }
  }

  public close(): void {
    const overlay = this.container.querySelector<HTMLElement>('#dailyBriefOverlay');
    if (!overlay) return;
    overlay.classList.remove('open');
    window.dispatchEvent(new CustomEvent('daily-brief:close'));
  }

  private renderShell(): void {
    this.container.innerHTML = `
      <div class="daily-brief-overlay" id="dailyBriefOverlay" aria-hidden="true">
        <section class="daily-brief-panel" role="dialog" aria-modal="true" aria-label="Today's Irish Tech Brief">
          <header class="daily-brief-header">
            <h2>📰 Today's Irish Tech Brief</h2>
            <button id="dailyBriefCloseBtn" class="daily-brief-close" aria-label="Close">×</button>
          </header>
          <div id="dailyBriefContent" class="daily-brief-content"></div>
        </section>
      </div>
    `;
  }

  private renderBody(vm: BriefViewModel): string {
    const pointsHtml = vm.points.length > 0
      ? `<ul class="daily-brief-points">${vm.points.map((p) => `<li>${escapeHtml(p)}</li>`).join('')}</ul>`
      : '<div class="daily-brief-state">No highlights available for today.</div>';

    return `
      <div class="daily-brief-date">${escapeHtml(vm.dateLabel)}</div>
      ${pointsHtml}
      <div class="daily-brief-meta">Based on ${vm.sourceCount} sources</div>
    `;
  }
}
