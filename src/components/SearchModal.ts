import { escapeHtml } from '@/utils/sanitize';
import { t } from '@/services/i18n';
import { trackSearchUsed } from '@/services/analytics';

export type SearchResultType = 'country' | 'news' | 'hotspot' | 'market' | 'prediction' | 'conflict' | 'base' | 'pipeline' | 'cable' | 'datacenter' | 'earthquake' | 'outage' | 'nuclear' | 'irradiator' | 'techcompany' | 'ailab' | 'startup' | 'techevent' | 'techhq' | 'accelerator' | 'exchange' | 'financialcenter' | 'centralbank' | 'commodityhub';

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
const MAX_RESULTS = 24;

interface SearchModalOptions {
  placeholder?: string;
  hint?: string;
}

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
  private placeholder: string;
  private hint: string;

  constructor(container: HTMLElement, options?: SearchModalOptions) {
    this.container = container;
    this.placeholder = options?.placeholder || t('modals.search.placeholder');
    this.hint = options?.hint || t('modals.search.hint');
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
          <input type="text" class="search-input" placeholder="${this.placeholder}" autofocus />
          <kbd class="search-kbd">ESC</kbd>
        </div>
        <div class="search-results"></div>
        <div class="search-footer">
          <span><kbd>↑↓</kbd> ${t('modals.search.navigate')}</span>
          <span><kbd>↵</kbd> ${t('modals.search.select')}</span>
          <span><kbd>esc</kbd> ${t('modals.search.close')}</span>
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

    // Collect matches grouped by type
    const byType = new Map<SearchResultType, (SearchResult & { _score: number })[]>();

    for (const source of this.sources) {
      for (const item of source.items) {
        const titleLower = item.title.toLowerCase();
        const subtitleLower = item.subtitle?.toLowerCase() || '';

        if (titleLower.includes(query) || subtitleLower.includes(query)) {
          const isPrefix = titleLower.startsWith(query) || subtitleLower.startsWith(query);
          const result = {
            type: source.type,
            id: item.id,
            title: item.title,
            subtitle: item.subtitle,
            data: item.data,
            _score: isPrefix ? 2 : 1,
          } as SearchResult & { _score: number };

          if (!byType.has(source.type)) byType.set(source.type, []);
          byType.get(source.type)!.push(result);
        }
      }
    }

    // Prioritize: news first, then other dynamic data, then static infrastructure
    const priority: SearchResultType[] = [
      'news', 'prediction', 'market', 'earthquake', 'outage',  // Dynamic/timely
      'conflict', 'hotspot', 'country',  // Current events + countries
      'base', 'pipeline', 'cable', 'datacenter', 'nuclear', 'irradiator',  // Infrastructure
      'techcompany', 'ailab', 'startup', 'techevent', 'techhq', 'accelerator'  // Tech
    ];

    // Take top matches from each type, news gets more slots
    this.results = [];
    for (const type of priority) {
      const matches = byType.get(type) || [];
      matches.sort((a, b) => b._score - a._score);
      const limit = type === 'news' ? 6 : type === 'country' ? 4 : 3;
      this.results.push(...matches.slice(0, limit));
      if (this.results.length >= MAX_RESULTS) break;
    }
    this.results = this.results.slice(0, MAX_RESULTS);

    trackSearchUsed(query.length, this.results.length);
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

    this.resultsList.innerHTML = `<div class="search-section-header">${t('modals.search.recent')}</div>`;

    this.recentSearches.forEach((term, i) => {
      const item = document.createElement('div');
      item.className = `search-result-item recent${i === this.selectedIndex ? ' selected' : ''}`;
      item.dataset.recent = term;

      const icon = document.createElement('span');
      icon.className = 'search-result-icon';
      icon.textContent = '🕐';

      const title = document.createElement('span');
      title.className = 'search-result-title';
      title.textContent = term;

      item.appendChild(icon);
      item.appendChild(title);

      item.addEventListener('click', () => {
        if (this.input) this.input.value = term;
        this.handleSearch();
      });

      this.resultsList!.appendChild(item);
    });
  }

  private renderEmpty(): void {
    if (!this.resultsList) return;

    this.resultsList.innerHTML = `
      <div class="search-empty">
        <div class="search-empty-icon">🔍</div>
        <div>${t('modals.search.empty')}</div>
        <div class="search-empty-hint">${this.hint}</div>
      </div>
    `;
  }

  private renderResults(): void {
    if (!this.resultsList) return;

    if (this.results.length === 0) {
      this.resultsList.innerHTML = `
        <div class="search-empty">
          <div class="search-empty-icon">∅</div>
          <div>${t('modals.search.noResults')}</div>
        </div>
      `;
      return;
    }

    const icons: Record<SearchResultType, string> = {
      country: '🏳️',
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
      techcompany: '🏢',
      ailab: '🧠',
      startup: '🚀',
      techevent: '📅',
      techhq: '🦄',
      accelerator: '🚀',
      exchange: '🏛️',
      financialcenter: '💰',
      centralbank: '🏦',
      commodityhub: '📦',
    };

    this.resultsList.innerHTML = this.results.map((result, i) => `
      <div class="search-result-item ${i === this.selectedIndex ? 'selected' : ''}" data-index="${i}">
        <span class="search-result-icon">${icons[result.type]}</span>
        <div class="search-result-content">
          <div class="search-result-title">${this.highlightMatch(result.title)}</div>
          ${result.subtitle ? `<div class="search-result-subtitle">${escapeHtml(result.subtitle)}</div>` : ''}
        </div>
        <span class="search-result-type">${escapeHtml(t(`modals.search.types.${result.type}`) || result.type)}</span>
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
