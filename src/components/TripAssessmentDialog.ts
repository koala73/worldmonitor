import { t } from '@/services/i18n';
import { createFocusTrap } from '@/utils/focus-trap';
import { declareOverlay } from '@/utils/open-modal';
import { attemptWebCountryDownload, type CountryTextDownload } from '@/utils/country-text-download';
import {
  TRIP_MAX_CITIES,
  TRIP_MAX_COUNTRIES,
  requestTripAssessment,
  validateTripDraft,
  type TripDraft,
  type TripExportResult,
  type TripFetch,
  type TripFormat,
} from '@/services/travel-risk-export';
import { focusCountryName } from './focus-format';
import { searchFocusCountries } from './FocusEditor';

/**
 * The "Trip assessment" dialog (#10451, phase 2): countries in travel order,
 * optional cities and dates, a task label, and three ways to take the draft
 * away: Markdown, HTML that Word opens, or the browser's print dialog for PDF.
 *
 * Loaded on demand from the focus bar's action, so it is not in the dashboard
 * entry. The server is the gate and builds the document; the dialog holds the
 * inputs while it is open and stores nothing. Each download is a fresh read of
 * the sources and carries its own capture time.
 */

export interface TripAssessmentOptions {
  initial: TripDraft;
  /** Focus countries that did not fit in a trip, shown so none is dropped silently. */
  omitted?: string[];
  /** Puts the request for an AI assistant on the clipboard. Omit to hide the link. */
  onCopyRequest?(draft: TripDraft): void;
  /** Called once when the dialog closes. */
  onClose?(): void;
  /** Test seams. */
  fetcher?: TripFetch;
  deliver?: CountryTextDownload;
  print?: (html: string) => void;
}

export interface TripAssessmentHandle {
  close(): void;
}

let nextId = 0;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * Prints HTML through a hidden iframe that cannot run script: the document is
 * built from feed text, so it gets no more than it needs to be laid out.
 */
export function printHtmlDocument(html: string): void {
  const frame = el('iframe', 'trip-assessment-print-frame');
  frame.setAttribute('sandbox', 'allow-same-origin allow-modals');
  frame.setAttribute('aria-hidden', 'true');
  frame.tabIndex = -1;
  frame.addEventListener('load', () => {
    try {
      frame.contentWindow?.focus();
      frame.contentWindow?.print();
    } finally {
      // The print dialog keeps its own copy; the frame can go.
      setTimeout(() => frame.remove(), 60_000);
    }
  }, { once: true });
  frame.srcdoc = html;
  document.body.append(frame);
}

const FAILURE_KEYS: Record<Exclude<Extract<TripExportResult, { ok: false }>['reason'], 'invalid'>, string> = {
  auth: 'tripAssessment.errAuth',
  upgrade: 'tripAssessment.errUpgrade',
  busy: 'tripAssessment.errBusy',
  unavailable: 'tripAssessment.errUnavailable',
  error: 'tripAssessment.errGeneric',
};

export function openTripAssessment(options: TripAssessmentOptions): TripAssessmentHandle {
  const id = `trip-assessment-${++nextId}`;
  const draft: TripDraft = {
    ...options.initial,
    countries: options.initial.countries.slice(0, TRIP_MAX_COUNTRIES).map((country) => ({ ...country })),
  };
  const deliver = options.deliver ?? attemptWebCountryDownload;
  const print = options.print ?? printHtmlDocument;
  const abort = new AbortController();
  let busy = false;
  let closed = false;

  const overlay = el('div', 'modal-overlay active focus-editor-overlay');
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-labelledby', `${id}-title`);
  // A form: a reload would throw away the trip being entered.
  declareOverlay(overlay, { reload: 'blocking' });

  const modal = el('div', 'modal focus-editor trip-assessment');

  const header = el('div', 'modal-header');
  const title = el('h2', 'modal-title', t('tripAssessment.heading'));
  title.id = `${id}-title`;
  const closeBtn = el('button', 'modal-close', '×');
  closeBtn.type = 'button';
  closeBtn.setAttribute('aria-label', t('tripAssessment.close'));
  header.append(title, closeBtn);

  const intro = el('p', 'focus-editor-intro', t('tripAssessment.intro'));
  const privacy = el('p', 'focus-editor-hint', t('tripAssessment.privacy'));

  // Task label
  const labelField = el('div', 'trip-assessment-field');
  const labelLabel = el('label', 'focus-editor-label', t('tripAssessment.taskLabel'));
  labelLabel.htmlFor = `${id}-label`;
  const labelInput = el('input', 'focus-editor-search trip-assessment-label');
  labelInput.type = 'text';
  labelInput.id = `${id}-label`;
  labelInput.maxLength = 120;
  labelInput.autocomplete = 'off';
  labelInput.placeholder = t('tripAssessment.taskLabelPlaceholder');
  labelInput.value = draft.taskLabel;
  labelInput.addEventListener('input', () => { draft.taskLabel = labelInput.value; });
  labelField.append(labelLabel, labelInput);

  // Trip window
  const dates = el('div', 'focus-editor-dates');
  const dateField = (cls: string, label: string, value: string, set: (v: string) => void): HTMLInputElement => {
    const wrap = el('div', 'focus-editor-date');
    const input = el('input', cls);
    input.type = 'date';
    input.id = `${id}-${cls}`;
    input.value = value;
    input.addEventListener('input', () => set(input.value));
    const lab = el('label', 'focus-editor-label', label);
    lab.htmlFor = input.id;
    wrap.append(lab, input);
    dates.append(wrap);
    return input;
  };
  const fromInput = dateField('trip-assessment-from', t('tripAssessment.windowStart'), draft.dateFrom, (v) => { draft.dateFrom = v; });
  const toInput = dateField('trip-assessment-to', t('tripAssessment.windowEnd'), draft.dateTo, (v) => { draft.dateTo = v; });

  // Countries
  const countriesHead = el('div', 'focus-editor-field-head');
  const countriesLabel = el('span', 'focus-editor-label', t('tripAssessment.countriesLabel'));
  const count = el('span', 'focus-editor-count');
  count.setAttribute('aria-live', 'polite');
  countriesHead.append(countriesLabel, count);

  const list = el('ol', 'trip-assessment-list');
  list.setAttribute('aria-label', t('tripAssessment.countriesLabel'));

  const searchInput = el('input', 'focus-editor-search trip-assessment-search');
  searchInput.type = 'search';
  searchInput.id = `${id}-search`;
  searchInput.autocomplete = 'off';
  searchInput.spellcheck = false;
  searchInput.placeholder = t('tripAssessment.searchPlaceholder');
  searchInput.setAttribute('aria-label', t('tripAssessment.addCountry'));
  searchInput.setAttribute('aria-controls', `${id}-results`);
  const results = el('ul', 'focus-editor-results');
  results.id = `${id}-results`;
  const limit = el('p', 'focus-editor-limit', t('tripAssessment.limit', { max: TRIP_MAX_COUNTRIES }));

  const omitted = options.omitted ?? [];
  const omittedNote = omitted.length > 0
    ? el('p', 'focus-editor-hint', t('tripAssessment.omitted', {
      max: TRIP_MAX_COUNTRIES,
      names: omitted.map(focusCountryName).join(', '),
    }))
    : null;

  const error = el('p', 'focus-editor-error');
  error.setAttribute('role', 'alert');
  error.hidden = true;
  const status = el('p', 'focus-editor-hint trip-assessment-status');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  const detail = el('ul', 'trip-assessment-violations');
  detail.hidden = true;

  // Footer
  const footer = el('div', 'focus-editor-footer');
  const copyBtn = options.onCopyRequest ? el('button', 'focus-editor-btn trip-assessment-copy', t('tripAssessment.copyRequest')) : null;
  const markdownBtn = el('button', 'focus-editor-btn trip-assessment-markdown', t('tripAssessment.downloadMarkdown'));
  const wordBtn = el('button', 'focus-editor-btn primary trip-assessment-word', t('tripAssessment.downloadWord'));
  const printBtn = el('button', 'focus-editor-btn trip-assessment-print', t('tripAssessment.print'));
  const actions = [markdownBtn, wordBtn, printBtn];
  for (const btn of [copyBtn, ...actions]) if (btn) btn.type = 'button';
  if (copyBtn) footer.append(copyBtn);
  footer.append(...actions);

  // The messages and the actions stay in view while a long trip scrolls.
  const foot = el('div', 'trip-assessment-foot');
  foot.append(error, detail, status, footer);

  modal.append(
    header, intro, privacy,
    labelField, dates,
    countriesHead, list, searchInput, results, limit,
    ...(omittedNote ? [omittedNote] : []),
    foot,
  );
  overlay.append(modal);

  const showError = (key: string | null, params?: Record<string, string | number>): void => {
    error.hidden = key === null;
    error.textContent = key ? t(key, params) : '';
  };

  // While a draft is being built the form is read-only, so the file that comes
  // back is always the trip the person is looking at, not an earlier version.
  const setBusy = (value: boolean): void => {
    busy = value;
    for (const btn of actions) btn.disabled = value;
    for (const input of [labelInput, fromInput, toInput]) input.disabled = value;
    modal.setAttribute('aria-busy', String(value));
    renderList();
  };

  function renderResults(): void {
    const full = draft.countries.length >= TRIP_MAX_COUNTRIES;
    const matches = full || busy ? [] : searchFocusCountries(searchInput.value, new Set(draft.countries.map((c) => c.code)));
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
  }

  function renderList(focus?: { code: string; action: 'up' | 'down' | 'remove' }): void {
    const full = draft.countries.length >= TRIP_MAX_COUNTRIES;
    count.textContent = t('tripAssessment.count', { n: draft.countries.length, max: TRIP_MAX_COUNTRIES });
    count.classList.toggle('full', full);
    list.replaceChildren(...draft.countries.map((country, index) => {
      const name = focusCountryName(country.code);
      const row = el('li', 'trip-assessment-row');
      row.dataset.code = country.code;

      const head = el('div', 'trip-assessment-row-head');
      head.append(el('span', 'trip-assessment-row-name', `${index + 1}. ${name}`));
      const controls = el('span', 'trip-assessment-row-controls');
      const control = (action: 'up' | 'down' | 'remove', glyph: string, label: string, disabled: boolean, run: () => void) => {
        const btn = el('button', `trip-assessment-row-btn trip-assessment-${action}`, glyph);
        btn.type = 'button';
        btn.dataset.action = action;
        btn.setAttribute('aria-label', label);
        btn.disabled = disabled;
        btn.addEventListener('click', run);
        controls.append(btn);
      };
      control('up', '↑', t('tripAssessment.moveEarlier', { name }), busy || index === 0, () => move(country.code, -1));
      control('down', '↓', t('tripAssessment.moveLater', { name }), busy || index === draft.countries.length - 1, () => move(country.code, 1));
      control('remove', '×', t('tripAssessment.remove', { name }), busy, () => remove(country.code));
      head.append(controls);

      const fields = el('div', 'trip-assessment-row-fields');
      const field = (cls: string, label: string, type: 'text' | 'date', value: string, set: (v: string) => void, extra?: (input: HTMLInputElement) => void) => {
        const wrap = el('div', `focus-editor-date ${cls}-wrap`);
        const input = el('input', `${cls} trip-assessment-input`);
        input.type = type;
        input.id = `${id}-${country.code}-${cls}`;
        input.value = value;
        input.disabled = busy;
        input.addEventListener('input', () => set(input.value));
        extra?.(input);
        const lab = el('label', 'focus-editor-label', label);
        lab.htmlFor = input.id;
        wrap.append(lab, input);
        fields.append(wrap);
      };
      field('trip-assessment-cities', t('tripAssessment.cities', { max: TRIP_MAX_CITIES }), 'text', country.cities, (v) => { country.cities = v; }, (input) => {
        input.autocomplete = 'off';
        input.maxLength = 400;
      });
      field('trip-assessment-arrive', t('tripAssessment.arrive'), 'date', country.arrive, (v) => { country.arrive = v; });
      field('trip-assessment-depart', t('tripAssessment.depart'), 'date', country.depart, (v) => { country.depart = v; });

      row.append(head, fields);
      return row;
    }));
    list.hidden = draft.countries.length === 0;
    searchInput.disabled = full || busy;
    limit.hidden = !full;
    renderResults();
    if (focus) {
      const row = list.querySelector<HTMLElement>(`[data-code="${focus.code}"]`);
      const wanted = row?.querySelector<HTMLButtonElement>(`[data-action="${focus.action}"]`);
      const fallback = row?.querySelector<HTMLButtonElement>('[data-action="up"]:not(:disabled), [data-action="down"]:not(:disabled), [data-action="remove"]');
      (wanted && !wanted.disabled ? wanted : fallback)?.focus();
    }
  }

  function add(code: string): void {
    if (draft.countries.some((c) => c.code === code) || draft.countries.length >= TRIP_MAX_COUNTRIES) return;
    draft.countries.push({ code, cities: '', arrive: '', depart: '' });
    searchInput.value = '';
    showError(null);
    renderList();
    if (!searchInput.disabled) searchInput.focus();
  }

  function remove(code: string): void {
    const index = draft.countries.findIndex((c) => c.code === code);
    if (index === -1) return;
    draft.countries.splice(index, 1);
    renderList();
    const next = draft.countries[Math.min(index, draft.countries.length - 1)];
    if (next) list.querySelector<HTMLButtonElement>(`[data-code="${next.code}"] [data-action="remove"]`)?.focus();
    else searchInput.focus();
  }

  function move(code: string, delta: -1 | 1): void {
    const index = draft.countries.findIndex((c) => c.code === code);
    const target = index + delta;
    if (index === -1 || target < 0 || target >= draft.countries.length) return;
    const [moved] = draft.countries.splice(index, 1);
    draft.countries.splice(target, 0, moved!);
    renderList({ code, action: delta < 0 ? 'up' : 'down' });
  }

  /**
   * The server names a field by its request path. A person reads the country
   * and the label on the form instead: "Vietnam · Arrive: ...".
   */
  function describeViolation(field: string, description: string, sent: readonly string[]): string {
    const country = /^countries\.(\d+)(?:\.(\w+))?/.exec(field);
    if (country) {
      const code = sent[Number(country[1])];
      const name = code ? focusCountryName(code) : null;
      const label = country[2] === 'arrive' ? t('tripAssessment.arrive') : country[2] === 'depart' ? t('tripAssessment.depart') : null;
      if (name) return `${name}${label ? ` · ${label}` : ''}: ${description}`;
    }
    const labels: Record<string, string> = {
      date_from: t('tripAssessment.windowStart'),
      date_to: t('tripAssessment.windowEnd'),
      task_label: t('tripAssessment.taskLabel'),
    };
    return `${labels[field] ?? field}: ${description}`;
  }

  function showFailure(result: Extract<TripExportResult, { ok: false }>, sent: readonly string[]): void {
    detail.replaceChildren();
    detail.hidden = true;
    if (result.reason === 'invalid') {
      showError('tripAssessment.errInvalid');
      detail.replaceChildren(...result.violations.map((v) => el('li', '', describeViolation(v.field, v.description, sent))));
      detail.hidden = detail.childElementCount === 0;
      return;
    }
    showError(FAILURE_KEYS[result.reason]);
  }

  async function run(format: TripFormat, then: 'download' | 'print'): Promise<void> {
    if (busy || closed) return;
    showError(null);
    detail.hidden = true;
    status.textContent = '';
    const invalid = validateTripDraft(draft, focusCountryName);
    if (invalid) {
      showError(invalid.key, invalid.params);
      return;
    }
    // Disabling the pressed button drops focus to the page; remember where it was.
    const returnFocusTo = document.activeElement;
    setBusy(true);
    status.textContent = t('tripAssessment.building');
    // The order the server will number its violations by.
    const sent = draft.countries.map((c) => c.code);
    try {
      const result = await requestTripAssessment(draft, format, { fetcher: options.fetcher, signal: abort.signal });
      if (closed) return;
      if (!result.ok) {
        status.textContent = '';
        showFailure(result, sent);
        return;
      }
      if (then === 'print') {
        print(result.content);
        status.textContent = t('tripAssessment.printOpened');
        return;
      }
      const delivered = await deliver({ filename: result.filename, mimeType: result.mimeType, content: result.content }, abort.signal);
      if (closed) return;
      status.textContent = delivered.state === 'error' || delivered.state === 'unsupported'
        ? ''
        : t('tripAssessment.downloaded', { file: result.filename });
      if (delivered.state === 'error' || delivered.state === 'unsupported') showError('tripAssessment.errDownload');
    } catch {
      // The browser can refuse the file (object URL, click) or the print frame;
      // the delivery dependency can reject too. Say so instead of leaving
      // "Building..." on screen.
      if (!closed) {
        status.textContent = '';
        showError(then === 'print' ? 'tripAssessment.errGeneric' : 'tripAssessment.errDownload');
      }
    } finally {
      if (!closed) {
        setBusy(false);
        if (returnFocusTo instanceof HTMLElement && modal.contains(returnFocusTo)) returnFocusTo.focus();
      }
    }
  }

  const trap = createFocusTrap(overlay, {
    onEscape: () => close(),
    initialFocus: () => (draft.countries.length === 0 && !searchInput.disabled ? searchInput : labelInput),
  });

  function close(): void {
    if (closed) return;
    closed = true;
    abort.abort();
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
  markdownBtn.addEventListener('click', () => { void run('markdown', 'download'); });
  wordBtn.addEventListener('click', () => { void run('html', 'download'); });
  printBtn.addEventListener('click', () => { void run('html', 'print'); });
  copyBtn?.addEventListener('click', () => options.onCopyRequest?.(draft));

  renderList();
  document.body.append(overlay);
  trap.activate();
  return { close };
}
