import { t } from '@/services/i18n';
import { createFocusTrap } from '@/utils/focus-trap';
import { declareOverlay } from '@/utils/open-modal';
import { iso2ToCountryName } from '@/utils/country-codes';
import { SCOPE_ISO2_CODES, SCOPE_MAX_COUNTRIES, normalizeScope, type TabScope } from '../../shared/tab-scope';
import { focusCountryName } from './focus-format';

/**
 * The dialog that sets or edits a tab's focus (#10453). Loaded on demand by
 * `PanelLayoutManager` the first time someone opens it, so it costs the
 * dashboard entry nothing.
 *
 * The existing country chip picker (src/utils/country-chip-picker.ts) takes
 * typed ISO codes with a cap of 50 and English-only copy; a focus needs a
 * search over country names and a cap of 12, so this is its own control.
 */

export interface FocusDraft {
  countries: string[];
  neighbours: boolean;
  /** 'YYYY-MM-DD' from a date input, or '' when empty. */
  start: string;
  end: string;
}

export type FocusDraftResult = { scope: TabScope } | { error: string };

/** Validate the dialog's fields. `error` is a locale key. */
export function validateFocusDraft(draft: FocusDraft): FocusDraftResult {
  if (draft.countries.length === 0) return { error: 'focus.errorNoCountries' };
  if (draft.countries.length > SCOPE_MAX_COUNTRIES) return { error: 'focus.errorTooMany' };
  if (draft.start && draft.end && draft.start > draft.end) return { error: 'focus.errorDates' };
  const scope = normalizeScope({
    countries: draft.countries,
    neighbours: draft.neighbours,
    ...(draft.start ? { start: draft.start } : {}),
    ...(draft.end ? { end: draft.end } : {}),
  });
  return scope ? { scope } : { error: 'focus.errorNoCountries' };
}

export interface FocusEditorOptions {
  /** The tab's current focus, or null to start a new one. */
  initial: TabScope | null;
  onSave(scope: TabScope): void;
  onClear(): void;
  /** Called once when the dialog closes, however it closes (before onSave / onClear). */
  onClose?(): void;
}

export interface FocusEditorHandle {
  close(): void;
}

const MAX_RESULTS = 8;

function fold(value: string): string {
  return value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

interface CatalogEntry {
  code: string;
  name: string;
  keys: string[];
}

let catalog: CatalogEntry[] | null = null;

function countryCatalog(): CatalogEntry[] {
  // Built once per open language: names follow the UI language, and the
  // English name stays searchable for analysts who type it.
  if (!catalog || catalog[0]?.name !== focusCountryName(catalog[0]!.code)) {
    catalog = SCOPE_ISO2_CODES.map((code) => {
      const name = focusCountryName(code);
      return { code, name, keys: [fold(name), fold(iso2ToCountryName(code))] };
    });
  }
  return catalog;
}

function search(query: string, exclude: ReadonlySet<string>): CatalogEntry[] {
  const q = fold(query.trim());
  if (!q) return [];
  const upper = query.trim().toUpperCase();
  const scored: Array<{ entry: CatalogEntry; rank: number }> = [];
  for (const entry of countryCatalog()) {
    if (exclude.has(entry.code)) continue;
    let rank = -1;
    if (entry.code === upper) rank = 0;
    else if (entry.keys.some((k) => k.startsWith(q))) rank = 1;
    else if (entry.keys.some((k) => k.includes(q))) rank = 2;
    if (rank >= 0) scored.push({ entry, rank });
  }
  scored.sort((a, b) => a.rank - b.rank || a.entry.name.localeCompare(b.entry.name));
  return scored.slice(0, MAX_RESULTS).map((s) => s.entry);
}

let nextId = 0;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function openFocusEditor(options: FocusEditorOptions): FocusEditorHandle {
  const id = `focus-editor-${++nextId}`;
  const countries: string[] = options.initial ? [...options.initial.countries] : [];

  const overlay = el('div', 'modal-overlay active focus-editor-overlay');
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-labelledby', `${id}-title`);
  // A form: a reload would throw away the countries and dates being picked.
  declareOverlay(overlay, { reload: 'blocking' });

  const modal = el('div', 'modal focus-editor');

  const header = el('div', 'modal-header');
  const title = el('h2', 'modal-title', t(options.initial ? 'focus.editTitle' : 'focus.newTitle'));
  title.id = `${id}-title`;
  const closeBtn = el('button', 'modal-close', '×');
  closeBtn.type = 'button';
  closeBtn.setAttribute('aria-label', t('focus.cancel'));
  header.append(title, closeBtn);

  const intro = el('p', 'focus-editor-intro', t('focus.intro'));

  // Countries
  const countriesHead = el('div', 'focus-editor-field-head');
  const searchLabel = el('label', 'focus-editor-label', t('focus.countriesLabel'));
  searchLabel.htmlFor = `${id}-search`;
  const count = el('span', 'focus-editor-count');
  count.setAttribute('aria-live', 'polite');
  countriesHead.append(searchLabel, count);

  const chipList = el('ul', 'focus-editor-chips');
  chipList.setAttribute('aria-label', t('focus.chosenLabel'));

  const searchInput = el('input', 'focus-editor-search');
  searchInput.type = 'search';
  searchInput.id = `${id}-search`;
  searchInput.autocomplete = 'off';
  searchInput.spellcheck = false;
  searchInput.placeholder = t('focus.searchPlaceholder');
  searchInput.setAttribute('aria-controls', `${id}-results`);

  const results = el('ul', 'focus-editor-results');
  results.id = `${id}-results`;
  results.setAttribute('aria-label', t('focus.resultsLabel'));

  const limit = el('p', 'focus-editor-limit', t('focus.limitReached', { max: SCOPE_MAX_COUNTRIES }));

  // Neighbours
  const neighboursRow = el('label', 'focus-editor-check');
  const neighbours = el('input', 'focus-editor-neighbours');
  neighbours.type = 'checkbox';
  neighbours.checked = options.initial?.neighbours ?? true;
  neighbours.setAttribute('aria-describedby', `${id}-neighbours-hint`);
  neighboursRow.append(neighbours, el('span', '', t('focus.includeNeighbours')));
  const neighboursHint = el('p', 'focus-editor-hint', t('focus.neighboursHint', { max: SCOPE_MAX_COUNTRIES }));
  neighboursHint.id = `${id}-neighbours-hint`;

  // Dates
  const dates = el('div', 'focus-editor-dates');
  const dateField = (cls: string, label: string, value: string | undefined): HTMLInputElement => {
    const wrap = el('div', 'focus-editor-date');
    const input = el('input', cls);
    input.type = 'date';
    input.id = `${id}-${cls}`;
    input.value = value ?? '';
    const lab = el('label', 'focus-editor-label', label);
    lab.htmlFor = input.id;
    wrap.append(lab, input);
    dates.append(wrap);
    return input;
  };
  const startInput = dateField('focus-editor-start', t('focus.startLabel'), options.initial?.start);
  const endInput = dateField('focus-editor-end', t('focus.endLabel'), options.initial?.end);
  const datesHint = el('p', 'focus-editor-hint', t('focus.datesHint'));

  const error = el('p', 'focus-editor-error');
  error.setAttribute('role', 'alert');
  error.hidden = true;

  // Footer
  const footer = el('div', 'focus-editor-footer');
  const clearBtn = options.initial ? el('button', 'focus-editor-btn focus-editor-clear', t('focus.clearFocus')) : null;
  const cancelBtn = el('button', 'focus-editor-btn focus-editor-cancel', t('focus.cancel'));
  const saveBtn = el('button', 'focus-editor-btn primary focus-editor-save', t('focus.save'));
  for (const btn of [clearBtn, cancelBtn, saveBtn]) if (btn) btn.type = 'button';
  if (clearBtn) footer.append(clearBtn);
  footer.append(cancelBtn, saveBtn);

  modal.append(
    header, intro,
    countriesHead, chipList, searchInput, results, limit,
    neighboursRow, neighboursHint,
    dates, datesHint,
    error, footer,
  );
  overlay.append(modal);

  const showError = (key: string | null): void => {
    error.hidden = key === null;
    error.textContent = key ? t(key, { max: SCOPE_MAX_COUNTRIES }) : '';
  };

  const renderResults = (): void => {
    const full = countries.length >= SCOPE_MAX_COUNTRIES;
    const matches = full ? [] : search(searchInput.value, new Set(countries));
    results.replaceChildren(...matches.map((entry) => {
      const item = el('li', 'focus-editor-result-item');
      const btn = el('button', 'focus-editor-result', entry.name);
      btn.type = 'button';
      btn.dataset.code = entry.code;
      btn.addEventListener('click', () => add(entry.code));
      item.append(btn);
      return item;
    }));
    results.hidden = matches.length === 0;
  };

  const renderChips = (): void => {
    const full = countries.length >= SCOPE_MAX_COUNTRIES;
    count.textContent = t('focus.count', { n: countries.length, max: SCOPE_MAX_COUNTRIES });
    count.classList.toggle('full', full);
    chipList.replaceChildren(...countries.map((code) => {
      const name = focusCountryName(code);
      const chip = el('li', 'focus-editor-chip');
      chip.dataset.code = code;
      const remove = el('button', 'focus-editor-chip-remove', '×');
      remove.type = 'button';
      remove.setAttribute('aria-label', t('focus.removeCountry', { name }));
      remove.addEventListener('click', () => removeCode(code));
      chip.append(el('span', 'focus-editor-chip-name', name), remove);
      return chip;
    }));
    chipList.hidden = countries.length === 0;
    searchInput.disabled = full;
    limit.hidden = !full;
    renderResults();
  };

  function add(code: string): void {
    if (countries.includes(code) || countries.length >= SCOPE_MAX_COUNTRIES) return;
    countries.push(code);
    searchInput.value = '';
    showError(null);
    renderChips();
    if (!searchInput.disabled) searchInput.focus();
  }

  function removeCode(code: string): void {
    const index = countries.indexOf(code);
    if (index === -1) return;
    countries.splice(index, 1);
    renderChips();
    // The removed chip's button is gone; keep focus in the dialog.
    (chipList.querySelectorAll<HTMLButtonElement>('.focus-editor-chip-remove')[Math.min(index, countries.length - 1)]
      ?? searchInput).focus();
  }

  let closed = false;
  const trap = createFocusTrap(overlay, {
    onEscape: () => close(),
    initialFocus: () => (searchInput.disabled ? null : searchInput),
  });

  function close(): void {
    if (closed) return;
    closed = true;
    trap.deactivate();
    overlay.remove();
    options.onClose?.();
  }

  searchInput.addEventListener('input', renderResults);
  searchInput.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    const first = results.querySelector<HTMLButtonElement>('.focus-editor-result');
    if (first?.dataset.code) add(first.dataset.code);
  });
  overlay.addEventListener('mousedown', (event) => {
    if (event.target === overlay) close();
  });
  closeBtn.addEventListener('click', close);
  cancelBtn.addEventListener('click', close);
  clearBtn?.addEventListener('click', () => {
    close();
    options.onClear();
  });
  saveBtn.addEventListener('click', () => {
    const result = validateFocusDraft({
      countries,
      neighbours: neighbours.checked,
      start: startInput.value,
      end: endInput.value,
    });
    if ('error' in result) {
      showError(result.error);
      return;
    }
    close();
    options.onSave(result.scope);
  });

  renderChips();
  document.body.append(overlay);
  trap.activate();
  return { close };
}
