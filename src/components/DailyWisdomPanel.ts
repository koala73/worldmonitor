import { Panel } from './Panel';
import { escapeHtml } from '@/utils/sanitize';
import {
  STOIC_QUOTES,
  BIBLICAL_QUOTES,
  ALAN_WATTS_QUOTES,
  MCKENNA_QUOTES,
  type InspiringQuote,
} from '@/config/inspiration-quotes';

const ROTATION_MS = 60_000;
const PANEL_ID = 'daily-wisdom';

interface DailySlot {
  label: string;
  tone: string;
  quote: InspiringQuote;
}

export class DailyWisdomPanel extends Panel {
  private readonly slots: DailySlot[];
  private activeSlotIndex: number = 0;
  private rotationTimer: number | null = null;

  constructor() {
    super({
      id: PANEL_ID,
      title: 'Daily Wisdom',
      showCount: false,
      trackActivity: false,
      className: 'wisdom-panel wisdom-panel--daily',
    });
    this.slots = DailyWisdomPanel.loadSlots();
    this.renderSlot();
    this.startRotation();
  }

  private static todayString(): string {
    return new Date().toISOString().slice(0, 10);
  }

  private static dateSeededIndex(dateStr: string, salt: number, total: number): number {
    let hash = salt;
    for (let i = 0; i < dateStr.length; i++) {
      hash = (hash * 31 + dateStr.charCodeAt(i)) | 0;
    }
    return Math.abs(hash) % total;
  }

  private static buildSlots(indices: number[]): DailySlot[] {
    const [i0 = 0, i1 = 0, i2 = 0, i3 = 0] = indices;
    return [
      { label: 'Stoic', tone: 'stoic', quote: STOIC_QUOTES[i0 % STOIC_QUOTES.length]! },
      { label: 'Scripture', tone: 'biblical', quote: BIBLICAL_QUOTES[i1 % BIBLICAL_QUOTES.length]! },
      { label: 'Alan Watts', tone: 'watts', quote: ALAN_WATTS_QUOTES[i2 % ALAN_WATTS_QUOTES.length]! },
      { label: 'McKenna', tone: 'mckenna', quote: MCKENNA_QUOTES[i3 % MCKENNA_QUOTES.length]! },
    ];
  }

  private static loadSlots(): DailySlot[] {
    const today = DailyWisdomPanel.todayString();
    const storageKey = `worldmonitor-daily-wisdom-${today}`;
    try {
      const storedDate = localStorage.getItem('worldmonitor-daily-wisdom-date');
      if (storedDate === today) {
        const cached = localStorage.getItem(storageKey);
        if (cached) {
          const indices: number[] = JSON.parse(cached) as number[];
          if (Array.isArray(indices) && indices.length === 4) {
            return DailyWisdomPanel.buildSlots(indices);
          }
        }
      }
    } catch { /* ignore */ }

    const indices = [
      DailyWisdomPanel.dateSeededIndex(today, 1, STOIC_QUOTES.length),
      DailyWisdomPanel.dateSeededIndex(today, 2, BIBLICAL_QUOTES.length),
      DailyWisdomPanel.dateSeededIndex(today, 3, ALAN_WATTS_QUOTES.length),
      DailyWisdomPanel.dateSeededIndex(today, 4, MCKENNA_QUOTES.length),
    ];
    try {
      localStorage.setItem('worldmonitor-daily-wisdom-date', today);
      localStorage.setItem(storageKey, JSON.stringify(indices));
    } catch { /* ignore */ }
    return DailyWisdomPanel.buildSlots(indices);
  }

  private renderSlot(): void {
    const slot = this.slots[this.activeSlotIndex];
    if (!slot) return;
    this.content.innerHTML = DailyWisdomPanel.buildHtml(slot, this.activeSlotIndex, this.slots.length);
    this.content.addEventListener('click', this.handleClick, { once: true });
  }

  private static buildHtml(slot: DailySlot, activeIdx: number, total: number): string {
    const { label, tone, quote } = slot;
    const today = DailyWisdomPanel.todayString();
    const dots = Array.from({ length: total }, (_, i) =>
      `<span class="wisdom-daily-dot${i === activeIdx ? ' wisdom-daily-dot--active' : ''}"></span>`
    ).join('');
    const translation = quote.translation
      ? `<div class="wisdom-panel-translation">${escapeHtml(quote.translation)}</div>`
      : '';
    return `
      <div class="wisdom-panel-card wisdom-panel-card--${escapeHtml(tone)} wisdom-daily-card">
        <div class="wisdom-panel-topline">
          <span class="wisdom-daily-badge wisdom-daily-badge--${escapeHtml(tone)}">${escapeHtml(label)}</span>
          <span class="wisdom-panel-rotation">Rotates every 60s · ${escapeHtml(today)}</span>
        </div>
        <div class="wisdom-panel-quote-mark" aria-hidden="true">"</div>
        <blockquote class="wisdom-panel-quote">${escapeHtml(quote.text)}</blockquote>
        <div class="wisdom-panel-meta">
          <div class="wisdom-panel-attribution">
            <span class="wisdom-panel-author">${escapeHtml(quote.author)}</span>
            <span class="wisdom-panel-source">${escapeHtml(quote.source)} ${escapeHtml(quote.reference)}</span>
          </div>
        </div>
        ${translation}
        <div class="wisdom-daily-dots">${dots}</div>
        <div class="wisdom-panel-controls">
          <button type="button" class="wisdom-panel-btn" data-action="prev">Back</button>
          <button type="button" class="wisdom-panel-btn" data-action="next">Next</button>
        </div>
      </div>
    `;
  }

  private handleClick = (event: Event): void => {
    const target = event.target as HTMLElement | null;
    const button = target?.closest('[data-action]') as HTMLButtonElement | null;
    if (!button) return;
    const action = button.dataset.action;
    if (action === 'prev') {
      this.activeSlotIndex = (this.activeSlotIndex - 1 + this.slots.length) % this.slots.length;
    } else if (action === 'next') {
      this.activeSlotIndex = (this.activeSlotIndex + 1) % this.slots.length;
    } else {
      return;
    }
    this.renderSlot();
    this.startRotation();
  };

  private startRotation(): void {
    this.stopRotation();
    this.rotationTimer = window.setInterval(() => {
      this.activeSlotIndex = (this.activeSlotIndex + 1) % this.slots.length;
      this.renderSlot();
    }, ROTATION_MS);
  }

  private stopRotation(): void {
    if (this.rotationTimer !== null) {
      window.clearInterval(this.rotationTimer);
      this.rotationTimer = null;
    }
  }

  public destroy(): void {
    this.stopRotation();
    super.destroy();
  }
}
