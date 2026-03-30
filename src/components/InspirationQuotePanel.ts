import { Panel } from './Panel';
import { escapeHtml } from '@/utils/sanitize';
import {
  BIBLICAL_QUOTES,
  STOIC_QUOTES,
  getInitialQuoteIndex,
  type InspiringQuote,
} from '@/config/inspiration-quotes';

const QUOTE_ROTATION_MS = 45_000;

type InspirationTone = 'stoic' | 'biblical';

interface InspirationQuotePanelOptions {
  id: string;
  title: string;
  tone: InspirationTone;
  quotes: readonly InspiringQuote[];
  eyebrow: string;
}

export class InspirationQuotePanel extends Panel {
  private readonly quotes: readonly InspiringQuote[];
  private readonly tone: InspirationTone;
  private readonly eyebrow: string;
  private currentIndex: number;
  private rotationTimer: number | null = null;

  constructor(options: InspirationQuotePanelOptions) {
    super({
      id: options.id,
      title: options.title,
      showCount: true,
      className: `wisdom-panel wisdom-panel--${options.tone}`,
      trackActivity: false,
    });

    this.quotes = options.quotes;
    this.tone = options.tone;
    this.eyebrow = options.eyebrow;
    this.currentIndex = getInitialQuoteIndex(options.id, options.quotes.length);
    this.setCount(options.quotes.length);
    this.content.addEventListener('click', this.handleContentClick);
    this.renderQuote();
    this.startRotation();
  }

  private startRotation(): void {
    this.stopRotation();
    this.rotationTimer = window.setInterval(() => {
      this.stepQuote(1);
    }, QUOTE_ROTATION_MS);
  }

  private stopRotation(): void {
    if (this.rotationTimer !== null) {
      window.clearInterval(this.rotationTimer);
      this.rotationTimer = null;
    }
  }

  private stepQuote(step: number): void {
    if (this.quotes.length === 0) return;
    this.currentIndex = (this.currentIndex + step + this.quotes.length) % this.quotes.length;
    this.renderQuote();
  }

  private shuffleQuote(): void {
    if (this.quotes.length <= 1) return;
    let nextIndex = (Date.now() + this.currentIndex * 17) % this.quotes.length;
    if (nextIndex === this.currentIndex) {
      nextIndex = (nextIndex + 1) % this.quotes.length;
    }
    this.currentIndex = nextIndex;
    this.renderQuote();
  }

  private renderQuote(): void {
    const quote = this.quotes[this.currentIndex];
    if (!quote) {
      this.showError('No quote available right now.');
      return;
    }

    const tagsHtml = quote.tags
      .map((tag) => `<span class="wisdom-panel-tag">${escapeHtml(tag)}</span>`)
      .join('');
    const translationHtml = quote.translation
      ? `<span class="wisdom-panel-translation">${escapeHtml(quote.translation)}</span>`
      : '';
    const position = `${this.currentIndex + 1} / ${this.quotes.length}`;

    this.content.innerHTML = `
      <div class="wisdom-panel-card wisdom-panel-card--${this.tone}">
        <div class="wisdom-panel-topline">
          <span class="wisdom-panel-eyebrow">${escapeHtml(this.eyebrow)}</span>
          <span class="wisdom-panel-rotation">Rotates every 45s</span>
        </div>
        <div class="wisdom-panel-quote-mark" aria-hidden="true">"</div>
        <blockquote class="wisdom-panel-quote">${escapeHtml(quote.text)}</blockquote>
        <div class="wisdom-panel-meta">
          <div class="wisdom-panel-attribution">
            <span class="wisdom-panel-author">${escapeHtml(quote.author)}</span>
            <span class="wisdom-panel-source">${escapeHtml(quote.source)} ${escapeHtml(quote.reference)}</span>
          </div>
          <div class="wisdom-panel-position">${escapeHtml(position)}</div>
        </div>
        <div class="wisdom-panel-tags">
          ${translationHtml}
          ${tagsHtml}
        </div>
        <div class="wisdom-panel-controls">
          <button type="button" class="wisdom-panel-btn" data-action="prev">Back</button>
          <button type="button" class="wisdom-panel-btn" data-action="shuffle">Shuffle</button>
          <button type="button" class="wisdom-panel-btn" data-action="next">Next</button>
        </div>
      </div>
    `;
  }

  private handleContentClick = (event: Event): void => {
    const target = event.target as HTMLElement | null;
    const button = target?.closest('[data-action]') as HTMLButtonElement | null;
    if (!button) return;

    const action = button.dataset.action;
    if (action === 'prev') {
      this.stepQuote(-1);
    } else if (action === 'next') {
      this.stepQuote(1);
    } else if (action === 'shuffle') {
      this.shuffleQuote();
    }
    this.startRotation();
  };

  public destroy(): void {
    this.stopRotation();
    this.content.removeEventListener('click', this.handleContentClick);
    super.destroy();
  }
}

export class StoicQuotePanel extends InspirationQuotePanel {
  constructor() {
    super({
      id: 'stoic-reflections',
      title: 'Stoic Reflections',
      tone: 'stoic',
      quotes: STOIC_QUOTES,
      eyebrow: 'Stoic sources',
    });
  }
}

export class BiblicalQuotePanel extends InspirationQuotePanel {
  constructor() {
    super({
      id: 'biblical-encouragement',
      title: 'Biblical Encouragement',
      tone: 'biblical',
      quotes: BIBLICAL_QUOTES,
      eyebrow: 'King James rotation',
    });
  }
}
