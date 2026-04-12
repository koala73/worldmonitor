/**
 * HS2 product chapter typeahead picker. Same keyboard model as CountryPicker.
 */

import { filterHs2, getAllHs2, type Hs2Entry } from './RouteExplorer.utils';

export interface Hs2PickerOptions {
  placeholder?: string;
  initialHs2?: string | null;
  onCommit: (hs2: string) => void;
  onCancel?: () => void;
}

export class Hs2Picker {
  public readonly element: HTMLDivElement;
  private input: HTMLInputElement;
  private list: HTMLUListElement;
  private results: Hs2Entry[] = [];
  private highlightIndex = 0;
  private opts: Hs2PickerOptions;

  constructor(opts: Hs2PickerOptions) {
    this.opts = opts;
    this.element = document.createElement('div');
    this.element.className = 're-picker re-picker--hs2';

    this.input = document.createElement('input');
    this.input.type = 'text';
    this.input.className = 're-picker__input';
    this.input.placeholder = opts.placeholder ?? 'Search products (HS code)';
    this.input.autocomplete = 'off';
    this.input.spellcheck = false;
    this.input.setAttribute('aria-label', opts.placeholder ?? 'Search products');

    this.list = document.createElement('ul');
    this.list.className = 're-picker__list';
    this.list.setAttribute('role', 'listbox');

    this.list.style.display = 'none';
    this.element.append(this.input, this.list);

    if (opts.initialHs2) {
      const initial = getAllHs2().find((e) => e.hs2 === opts.initialHs2);
      if (initial) this.input.value = `${initial.label} (HS ${initial.hs2})`;
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

  public setValue(hs2: string | null): void {
    if (!hs2) {
      this.input.value = '';
      this.refreshResults('');
      return;
    }
    const e = getAllHs2().find((x) => x.hs2 === hs2);
    if (e) {
      this.input.value = `${e.label} (HS ${e.hs2})`;
      this.refreshResults('');
    }
  }

  private refreshResults(query: string): void {
    this.results = filterHs2(query).slice(0, 50);
    this.highlightIndex = 0;
    this.renderList();
  }

  private renderList(): void {
    this.list.innerHTML = '';
    if (this.results.length === 0) {
      const empty = document.createElement('li');
      empty.className = 're-picker__empty';
      empty.textContent = 'No matching products';
      this.list.append(empty);
      return;
    }
    this.results.forEach((entry, idx) => {
      const li = document.createElement('li');
      li.className = 're-picker__item';
      li.setAttribute('role', 'option');
      li.dataset.hs2 = entry.hs2;
      li.dataset.idx = String(idx);
      if (idx === this.highlightIndex) {
        li.classList.add('re-picker__item--active');
        li.setAttribute('aria-selected', 'true');
      }
      li.innerHTML = `<span class="re-picker__code">HS ${entry.hs2}</span><span class="re-picker__name">${escapeHtml(entry.label)}</span>`;
      this.list.append(li);
    });
  }

  private commit(idx: number): void {
    const entry = this.results[idx];
    if (!entry) return;
    this.input.value = `${entry.label} (HS ${entry.hs2})`;
    this.hideList();
    this.input.blur();
    this.opts.onCommit(entry.hs2);
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
