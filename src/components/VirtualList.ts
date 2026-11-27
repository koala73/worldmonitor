import { setTrustedHtml, trustedHtml } from '@/utils/dom-utils';

/**
 * Windowed rendering for variable-height items.
 * Uses CSS containment and renders chunks of items.
 */
export interface WindowedListOptions {
  /** Container element */
  container: HTMLElement;
  /** Chunk size - number of items to render at once */
  chunkSize?: number;
  /** Buffer chunks above/below viewport */
  bufferChunks?: number;
}

export class WindowedList<T> {
  private container: HTMLElement;
  private chunkSize: number;
  private bufferChunks: number;
  private items: T[] = [];
  private renderItem: (item: T, index: number) => string;
  private onRendered?: () => void;

  private renderedChunks = new Set<number>();
  private chunkElements = new Map<number, HTMLElement>();
  private scrollRAF: number | null = null;

  constructor(
    options: WindowedListOptions,
    renderItem: (item: T, index: number) => string,
    onRendered?: () => void
  ) {
    this.container = options.container;
    this.chunkSize = options.chunkSize ?? 10;
    this.bufferChunks = options.bufferChunks ?? 1;
    this.renderItem = renderItem;
    this.onRendered = onRendered;

    this.container.classList.add('windowed-list');
    this.container.addEventListener('scroll', this.handleScroll, { passive: true });
  }

  /**
   * Set items and render initial chunks
   */
  setItems(items: T[]): void {
    this.items = items;
    this.renderedChunks.clear();

    // Clear existing chunk elements
    for (const el of this.chunkElements.values()) {
      el.remove();
    }
    this.chunkElements.clear();

    // Create container structure
    setTrustedHtml(this.container, trustedHtml('', "legacy direct innerHTML migration"));

    if (items.length === 0) {
      return;
    }

    // Calculate chunks
    const totalChunks = Math.ceil(items.length / this.chunkSize);

    // Create placeholder for each chunk
    for (let i = 0; i < totalChunks; i++) {
      const placeholder = document.createElement('div');
      placeholder.className = 'windowed-chunk';
      placeholder.dataset.chunk = String(i);
      this.container.appendChild(placeholder);
      this.chunkElements.set(i, placeholder);
    }

    // Render visible chunks
    this.updateVisibleChunks();
  }

  /**
   * Force refresh of rendered chunks
   */
  refresh(): void {
    const visibleChunks = this.getVisibleChunks();
    for (const chunkIndex of visibleChunks) {
      this.renderChunk(chunkIndex);
    }
    this.onRendered?.();
  }

  private handleScroll = (): void => {
    if (this.scrollRAF !== null) return;

    this.scrollRAF = requestAnimationFrame(() => {
      this.scrollRAF = null;
      this.updateVisibleChunks();
    });
  };

  private getVisibleChunks(): number[] {
    const scrollTop = this.container.scrollTop;
    const viewportHeight = this.container.clientHeight;
    const chunks: number[] = [];

    for (const [index, element] of this.chunkElements) {
      const rect = element.getBoundingClientRect();
      const containerRect = this.container.getBoundingClientRect();
      const relativeTop = rect.top - containerRect.top + scrollTop;
      const relativeBottom = relativeTop + rect.height;

      // Check if chunk is in viewport (with buffer)
      const bufferPx = viewportHeight * this.bufferChunks;
      if (relativeBottom >= scrollTop - bufferPx &&
          relativeTop <= scrollTop + viewportHeight + bufferPx) {
        chunks.push(index);
      }
    }

    return chunks;
  }

  private updateVisibleChunks(): void {
    const visibleChunks = this.getVisibleChunks();

    // Render chunks that aren't rendered yet
    let needsCallback = false;
    for (const chunkIndex of visibleChunks) {
      if (!this.renderedChunks.has(chunkIndex)) {
        this.renderChunk(chunkIndex);
        needsCallback = true;
      }
    }

    if (needsCallback) {
      this.onRendered?.();
    }
  }

  private renderChunk(chunkIndex: number): void {
    const element = this.chunkElements.get(chunkIndex);
    if (!element) return;

    const startIdx = chunkIndex * this.chunkSize;
    const endIdx = Math.min(startIdx + this.chunkSize, this.items.length);
    const chunkItems = this.items.slice(startIdx, endIdx);

    const html = chunkItems
      .map((item, i) => this.renderItem(item, startIdx + i))
      .join('');

    setTrustedHtml(element, trustedHtml(html, "legacy direct innerHTML migration"));
    element.classList.add('rendered');
    this.renderedChunks.add(chunkIndex);
  }

  /**
   * Scroll to the first item matching the predicate, rendering its chunk if needed.
   * Returns true if found.
   */
  scrollToItem(predicate: (item: T) => boolean): boolean {
    const index = this.items.findIndex(predicate);
    if (index === -1) return false;

    const chunkIndex = Math.floor(index / this.chunkSize);
    const chunkEl = this.chunkElements.get(chunkIndex);
    if (!chunkEl) return false;

    if (!this.renderedChunks.has(chunkIndex)) {
      this.renderChunk(chunkIndex);
      this.onRendered?.();
    }

    chunkEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return true;
  }

  /**
   * Clean up resources
   */
  destroy(): void {
    if (this.scrollRAF !== null) {
      cancelAnimationFrame(this.scrollRAF);
      this.scrollRAF = null;
    }
    this.container.removeEventListener('scroll', this.handleScroll);
    this.chunkElements.clear();
    this.renderedChunks.clear();
    this.items = [];
  }
}

