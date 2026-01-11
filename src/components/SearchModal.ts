import { escapeHtml } from '@/utils/sanitize';

export type SearchResultType = 'news' | 'hotspot' | 'market' | 'prediction' | 'conflict' | 'base' | 'pipeline' | 'cable' | 'datacenter' | 'earthquake' | 'outage' | 'nuclear' | 'irradiator';

export interface SearchResult {
  type: SearchResultType;
  id: string;
  title: string;
  subtitle?: string;
  data: unknown;
}

interface SearchableSource {
  type: SearchResultType;
  items: { id: string; title: string; subtitle?: string; data: unknown }[];
}

const RECENT_SEARCHES_KEY = 'worldmonitor_recent_searches';
const MAX_RECENT = 8;
const MAX_RESULTS = 12;

export class SearchModal {
  private container: HTMLElement;
  private overlay: HTMLElement | null = null;
  private input: HTMLInputElement | null = null;
  private resultsList: HTMLElement | null = null;
  private sources: SearchableSource[] = [];
  private results: SearchResult[] = [];
  private selectedIndex = 0;
  private recentSearches: string[] = [];
  private onSelect?: (result: SearchResult) => void;

  constructor(container: HTMLElement) {
    this.container = container;
    this.loadRecentSearches();
  }

  public registerSource(type: SearchResultType, items: SearchableSource['items']): void {
    const existingIndex = this.sources.findIndex(s => s.type === type);
    if (existingIndex >= 0) {
      this.sources[existingIndex] = { type, items };
    } else {
      this.sources.push({ type, items });
    }
  }

  public setOnSelect(callback: (result: SearchResult) => void): void {
    this.onSelect = callback;
  }

  public open(): void {
    if (this.overlay) return;
    this.createModal();
    this.input?.focus();
    this.showRecentOrEmpty();
  }

  public close(): void {
    if (this.overlay) {
      this.overlay.remove();
      this.overlay = null;
      this.input = null;
      this.resultsList = null;
      this.results = [];
      this.selectedIndex = 0;
    }
  }

  public isOpen(): boolean {
    return this.overlay !== null;
  }

  private createModal(): void {
    this.overlay = document.createElement('div');
    this.overlay.className = 'search-overlay';
    this.overlay.innerHTML = `
      <div class="search-modal">
        <div class="search-header">
          <span class="search-icon">⌘</span>
          <input type="text" class="search-input" placeholder="Search news, pipelines, bases, markets..." autofocus />
          <kbd class="search-kbd">ESC</kbd>
        </div>
        <div class="search-results"></div>
        <div class="search-footer">
          <span><kbd>↑↓</kbd> navigate</span>
          <span><kbd>↵</kbd> select</span>
          <span><kbd>esc</kbd> close</span>
        </div>
      </div>
    `;

    this.overlay.addEventListener('click', (e) => {
      if (e.target === this.overlay) this.close();
    });

    this.input = this.overlay.querySelector('.search-input');
    this.resultsList = this.overlay.querySelector('.search-results');

    this.input?.addEventListener('input', () => this.handleSearch());
    this.input?.addEventListener('keydown', (e) => this.handleKeydown(e));

    this.container.appendChild(this.overlay);
  }

  private handleSearch(): void {
    const query = this.input?.value.trim().toLowerCase() || '';

    if (!query) {
      this.showRecentOrEmpty();
      return;
    }

    this.results = [];

    for (const source of this.sources) {
      for (const item of source.items) {
        const titleLower = item.title.toLowerCase();
        const subtitleLower = item.subtitle?.toLowerCase() || '';

        if (titleLower.includes(query) || subtitleLower.includes(query)) {
          const isPrefix = titleLower.startsWith(query) || subtitleLower.startsWith(query);
          this.results.push({
            type: source.type,
            id: item.id,
            title: item.title,
            subtitle: item.subtitle,
            data: item.data,
            _score: isPrefix ? 2 : 1,
          } as SearchResult & { _score: number });
        }
      }
    }

    // Sort by score (prefix matches first), then limit
    this.results.sort((a, b) => ((b as any)._score || 0) - ((a as any)._score || 0));
    this.results = this.results.slice(0, MAX_RESULTS);

    this.selectedIndex = 0;
    this.renderResults();
  }

  private showRecentOrEmpty(): void {
    this.results = [];

    if (this.recentSearches.length > 0) {
      this.renderRecent();
    } else {
      this.renderEmpty();
    }
  }

  private renderRecent(): void {
    if (!this.resultsList) return;

    this.resultsList.innerHTML = `
      <div class="search-section-header">Recent Searches</div>
      ${this.recentSearches.map((term, i) => `
        <div class="search-result-item recent ${i === this.selectedIndex ? 'selected' : ''}" data-recent="${term}">
          <span class="search-result-icon">🕐</span>
          <span class="search-result-title">${term}</span>
        </div>
      `).join('')}
    `;

    this.resultsList.querySelectorAll('.search-result-item.recent').forEach((el) => {
      el.addEventListener('click', () => {
        const term = (el as HTMLElement).dataset.recent || '';
        if (this.input) this.input.value = term;
        this.handleSearch();
      });
    });
  }

  private renderEmpty(): void {
    if (!this.resultsList) return;

    this.resultsList.innerHTML = `
      <div class="search-empty">
        <div class="search-empty-icon">🔍</div>
        <div>Search across all data sources</div>
        <div class="search-empty-hint">News • Pipelines • Bases • Cables • Datacenters • Markets</div>
      </div>
    `;
  }

  private renderResults(): void {
    if (!this.resultsList) return;

    if (this.results.length === 0) {
      this.resultsList.innerHTML = `
        <div class="search-empty">
          <div class="search-empty-icon">∅</div>
          <div>No results found</div>
        </div>
      `;
      return;
    }

    const icons: Record<SearchResultType, string> = {
      news: '📰',
      hotspot: '📍',
      market: '📈',
      prediction: '🎯',
      conflict: '⚔️',
      base: '🏛️',
      pipeline: '🛢',
      cable: '🌐',
      datacenter: '🖥️',
      earthquake: '🌍',
      outage: '📡',
      nuclear: '☢️',
      irradiator: '⚛️',
    };

    this.resultsList.innerHTML = this.results.map((result, i) => `
      <div class="search-result-item ${i === this.selectedIndex ? 'selected' : ''}" data-index="${i}">
        <span class="search-result-icon">${icons[result.type]}</span>
        <div class="search-result-content">
          <div class="search-result-title">${this.highlightMatch(result.title)}</div>
          ${result.subtitle ? `<div class="search-result-subtitle">${escapeHtml(result.subtitle)}</div>` : ''}
        </div>
        <span class="search-result-type">${escapeHtml(result.type)}</span>
      </div>
    `).join('');

    this.resultsList.querySelectorAll('.search-result-item').forEach((el) => {
      el.addEventListener('click', () => {
        const index = parseInt((el as HTMLElement).dataset.index || '0');
        this.selectResult(index);
      });
    });
  }

  private highlightMatch(text: string): string {
    const query = this.input?.value.trim() || '';
    const escapedText = escapeHtml(text);
    if (!query) return escapedText;

    const escapedQuery = escapeHtml(query);
    const regex = new RegExp(`(${escapedQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
    return escapedText.replace(regex, '<mark>$1</mark>');
  }

  private handleKeydown(e: KeyboardEvent): void {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        this.moveSelection(1);
        break;
      case 'ArrowUp':
        e.preventDefault();
        this.moveSelection(-1);
        break;
      case 'Enter':
        e.preventDefault();
        this.selectResult(this.selectedIndex);
        break;
      case 'Escape':
        e.preventDefault();
        this.close();
        break;
    }
  }

  private moveSelection(delta: number): void {
    const max = this.results.length || this.recentSearches.length;
    if (max === 0) return;

    this.selectedIndex = (this.selectedIndex + delta + max) % max;
    this.updateSelection();
  }

  private updateSelection(): void {
    if (!this.resultsList) return;

    this.resultsList.querySelectorAll('.search-result-item').forEach((el, i) => {
      el.classList.toggle('selected', i === this.selectedIndex);
    });

    const selected = this.resultsList.querySelector('.selected');
    selected?.scrollIntoView({ block: 'nearest' });
  }

  private selectResult(index: number): void {
    // If showing recent searches
    if (this.results.length === 0 && this.recentSearches.length > 0) {
      const term = this.recentSearches[index];
      if (term && this.input) {
        this.input.value = term;
        this.handleSearch();
      }
      return;
    }

    const result = this.results[index];
    if (!result) return;

    // Save to recent searches
    this.saveRecentSearch(this.input?.value.trim() || '');

    this.close();
    this.onSelect?.(result);
  }

  private loadRecentSearches(): void {
    try {
      const stored = localStorage.getItem(RECENT_SEARCHES_KEY);
      this.recentSearches = stored ? JSON.parse(stored) : [];
    } catch {
      this.recentSearches = [];
    }
  }

  private saveRecentSearch(term: string): void {
    if (!term || term.length < 2) return;

    this.recentSearches = [
      term,
      ...this.recentSearches.filter(t => t !== term)
    ].slice(0, MAX_RECENT);

    try {
      localStorage.setItem(RECENT_SEARCHES_KEY, JSON.stringify(this.recentSearches));
    } catch {
      // Storage full, ignore
    }
  }
}
