/**
 * Search-first country typeahead for the Route Explorer query bar.
 * Keyboard-first: ↑/↓ to move, Enter to commit, Esc to close.
 */

import { filterCountries, getAllCountries, type CountryListEntry } from './RouteExplorer.utils';

export interface CountryPickerOptions {
  placeholder?: string;
  initialIso2?: string | null;
  /** Fired when the user commits a selection (Enter or click). */
  onCommit: (iso2: string) => void;
  /** Fired when the user presses Esc inside the picker. */
  onCancel?: () => void;
}

export class CountryPicker {
  public readonly element: HTMLDivElement;
  private input: HTMLInputElement;
  private list: HTMLUListElement;
  private results: CountryListEntry[] = [];
  private highlightIndex = 0;
  private opts: CountryPickerOptions;

  constructor(opts: CountryPickerOptions) {
    this.opts = opts;
    this.element = document.createElement('div');
    this.element.className = 're-picker re-picker--country';

    this.input = document.createElement('input');
    this.input.type = 'text';
    this.input.className = 're-picker__input';
    this.input.placeholder = opts.placeholder ?? 'Search countries';
    this.input.autocomplete = 'off';
    this.input.spellcheck = false;
    this.input.setAttribute('aria-label', opts.placeholder ?? 'Search countries');

    this.list = document.createElement('ul');
    this.list.className = 're-picker__list';
    this.list.setAttribute('role', 'listbox');

    this.list.style.display = 'none';
    this.element.append(this.input, this.list);

    if (opts.initialIso2) {
      const initial = getAllCountries().find((c) => c.iso2 === opts.initialIso2);
      if (initial) this.input.value = initial.name;
    }

    this.input.addEventListener('input', () => { this.showList(); this.refreshResults(this.input.value); });
    this.input.addEventListener('focus', () => { this.refreshResults(this.input.value); this.showList(); });
    this.input.addEventListener('blur', () => { setTimeout(() => this.hideList(), 150); });
    this.input.addEventListener('keydown', this.handleKeydown);
    this.list.addEventListener('click', this.handleClick);
  }

  private showList(): void { this.list.style.display = 'block'; }
  private hideList(): void { this.list.style.display = 'none'; }

  public focusInput(): void {
    this.input.focus();
    this.input.select();
  }

  public setValue(iso2: string | null): void {
    if (!iso2) {
      this.input.value = '';
      this.refreshResults('');
      return;
    }
    const c = getAllCountries().find((x) => x.iso2 === iso2);
    if (c) {
      this.input.value = c.name;
      this.refreshResults('');
    }
  }

  private refreshResults(query: string): void {
    this.results = filterCountries(query).slice(0, 50);
    this.highlightIndex = 0;
    this.renderList();
  }

  private renderList(): void {
    this.list.innerHTML = '';
    if (this.results.length === 0) {
      const empty = document.createElement('li');
      empty.className = 're-picker__empty';
      empty.textContent = 'No matching countries';
      this.list.append(empty);
      return;
    }
    this.results.forEach((entry, idx) => {
      const li = document.createElement('li');
      li.className = 're-picker__item';
      li.setAttribute('role', 'option');
      li.dataset.iso2 = entry.iso2;
      li.dataset.idx = String(idx);
      if (idx === this.highlightIndex) {
        li.classList.add('re-picker__item--active');
        li.setAttribute('aria-selected', 'true');
      }
      li.innerHTML = `<span class="re-picker__flag">${entry.flag}</span><span class="re-picker__name">${escapeHtml(entry.name)}</span><span class="re-picker__code">${entry.iso2}</span>`;
      this.list.append(li);
    });
  }

  private commit(idx: number): void {
    const entry = this.results[idx];
    if (!entry) return;
    this.input.value = entry.name;
    this.hideList();
    this.input.blur();
    this.opts.onCommit(entry.iso2);
  }

  private handleKeydown = (e: KeyboardEvent): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      this.highlightIndex = Math.min(this.highlightIndex + 1, this.results.length - 1);
      this.renderList();
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      this.highlightIndex = Math.max(this.highlightIndex - 1, 0);
      this.renderList();
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      this.commit(this.highlightIndex);
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      this.opts.onCancel?.();
      return;
    }
  };

  private handleClick = (e: MouseEvent): void => {
    const target = e.target as HTMLElement;
    const item = target.closest('.re-picker__item') as HTMLElement | null;
    if (!item || item.dataset.idx === undefined) return;
    const idx = Number.parseInt(item.dataset.idx, 10);
    this.commit(idx);
  };
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;',
  );
}
