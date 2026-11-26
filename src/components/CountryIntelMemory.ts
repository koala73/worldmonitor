import { t } from '@/services/i18n';
import {
  fetchIntelTimeline,
  fetchSimilarEvents,
  type IntelHistoryDomain,
  type IntelHistoryRecord,
} from '@/services/intel-history';
import { getRpcErrorStatusCode } from '@/services/rpc-client';
import { sanitizeUrl } from '@/utils/sanitize';

const DOMAINS: readonly IntelHistoryDomain[] = ['', 'conflict', 'military', 'energy'];
const TIMELINE_PAGE_LIMIT = 20;
const SIMILAR_LIMIT = 6;
const MIN_SITUATION_LENGTH = 10;
const MAX_SITUATION_LENGTH = 1000;
const SUMMARY_MAX_LENGTH = 220;

let instanceCounter = 0;

export interface CountryIntelMemoryDeps {
  fetchTimeline?: typeof fetchIntelTimeline;
  fetchSimilar?: typeof fetchSimilarEvents;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = '',
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function formatUtcDate(epochMs: number): string {
  if (!Number.isFinite(epochMs) || epochMs <= 0) return '—';
  const date = new Date(epochMs);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toISOString().slice(0, 10);
}

function truncateSummary(summary: string): string {
  const trimmed = summary.trim();
  if (trimmed.length <= SUMMARY_MAX_LENGTH) return trimmed;
  return `${trimmed.slice(0, SUMMARY_MAX_LENGTH - 1).trimEnd()}…`;
}

function safeExternalHttpUrl(raw: string | undefined): string {
  if (!raw) return '';
  const trimmed = raw.trim();
  if (!/^https?:\/\//i.test(trimmed)) return '';
  const sanitized = sanitizeUrl(trimmed);
  if (!sanitized || !/^https?:\/\//i.test(sanitized)) return '';
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.toString() : '';
  } catch {
    return '';
  }
}

export class CountryIntelMemory {
  private readonly fetchTimelineFn: typeof fetchIntelTimeline;
  private readonly fetchSimilarFn: typeof fetchSimilarEvents;
  private readonly countryCode: string;
  private readonly instanceId: number;

  private domain: IntelHistoryDomain = '';
  private records: IntelHistoryRecord[] = [];
  private nextCursor = '';
  private partial = false;
  private timelineState: 'loading' | 'ready' | 'unavailable' | 'locked' = 'loading';
  private loadingMore = false;
  private loadMoreError = false;
  private disposed = false;

  private timelineAbort: AbortController | null = null;
  private loadMoreAbort: AbortController | null = null;
  private similarAbort: AbortController | null = null;

  private rootEl!: HTMLElement;
  private filtersEl!: HTMLElement;
  private timelineEl!: HTMLElement;
  private similarInput!: HTMLInputElement;
  private similarSubmitBtn!: HTMLButtonElement;
  private similarPrefillBtn!: HTMLButtonElement;
  private similarResultsEl!: HTMLElement;

  private readonly onParentAbort = (): void => {
    this.destroy();
  };

  constructor(
    private readonly mount: HTMLElement,
    country: string,
    private readonly signal: AbortSignal,
    deps?: CountryIntelMemoryDeps,
  ) {
    this.countryCode = country.trim().toUpperCase();
    this.fetchTimelineFn = deps?.fetchTimeline ?? fetchIntelTimeline;
    this.fetchSimilarFn = deps?.fetchSimilar ?? fetchSimilarEvents;
    this.instanceId = ++instanceCounter;

    if (this.signal.aborted) {
      this.disposed = true;
      return;
    }

    this.signal.addEventListener('abort', this.onParentAbort, { once: true });
    this.buildShell();
    void this.loadTimeline();
  }

  public destroy(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.signal.removeEventListener('abort', this.onParentAbort);
    this.timelineAbort?.abort();
    this.loadMoreAbort?.abort();
    this.similarAbort?.abort();
    this.timelineAbort = null;
    this.loadMoreAbort = null;
    this.similarAbort = null;
  }

  private buildShell(): void {
    this.rootEl = el('div', 'country-intel-memory');

    this.filtersEl = el('div', 'country-intel-memory-filters');
    this.filtersEl.setAttribute('role', 'group');
    this.filtersEl.setAttribute('aria-label', t('countryBrief.intelMemory.domainFilterLabel'));
    for (const domain of DOMAINS) {
      const btn = el('button', 'country-intel-memory-pill', this.domainLabel(domain));
      btn.type = 'button';
      btn.dataset.domain = domain;
      btn.setAttribute('aria-pressed', String(domain === this.domain));
      btn.addEventListener('click', () => this.selectDomain(domain));
      this.filtersEl.append(btn);
    }

    this.timelineEl = el('div', 'country-intel-memory-timeline');

    const similarSection = el('div', 'country-intel-memory-similar');
    const similarHeader = el('div', 'country-intel-memory-similar-header');
    const inputId = `country-intel-memory-situation-${this.instanceId}`;
    const label = el('label', 'country-intel-memory-similar-label', t('countryBrief.intelMemory.similarTitle'));
    label.htmlFor = inputId;

    this.similarPrefillBtn = el(
      'button',
      'country-intel-memory-prefill-btn',
      t('countryBrief.intelMemory.useLatestHeadline'),
    );
    this.similarPrefillBtn.type = 'button';
    this.similarPrefillBtn.hidden = true;
    this.similarPrefillBtn.addEventListener('click', () => {
      const top = this.records[0];
      if (!top) return;
      this.similarInput.value = top.title.slice(0, MAX_SITUATION_LENGTH);
      this.similarInput.focus();
    });
    similarHeader.append(label, this.similarPrefillBtn);

    const form = el('form', 'country-intel-memory-similar-form');
    this.similarInput = el('input', 'country-intel-memory-input');
    this.similarInput.id = inputId;
    this.similarInput.type = 'text';
    this.similarInput.maxLength = MAX_SITUATION_LENGTH;
    this.similarInput.autocomplete = 'off';
    this.similarInput.placeholder = t('countryBrief.intelMemory.similarPlaceholder');

    this.similarSubmitBtn = el(
      'button',
      'cdp-action-btn country-intel-memory-similar-submit',
      t('countryBrief.intelMemory.findSimilar'),
    );
    this.similarSubmitBtn.type = 'submit';

    form.append(this.similarInput, this.similarSubmitBtn);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      void this.runSimilarSearch();
    });

    this.similarResultsEl = el('div', 'country-intel-memory-similar-results');
    this.similarResultsEl.setAttribute('aria-live', 'polite');

    similarSection.append(similarHeader, form, this.similarResultsEl);

    this.rootEl.append(this.filtersEl, this.timelineEl, similarSection);
    this.mount.replaceChildren(this.rootEl);
  }

  private domainLabel(domain: string): string {
    switch (domain) {
      case '':
        return t('countryBrief.intelMemory.domains.all');
      case 'conflict':
        return t('countryBrief.intelMemory.domains.conflict');
      case 'military':
        return t('countryBrief.intelMemory.domains.military');
      case 'energy':
        return t('countryBrief.intelMemory.domains.energy');
      case 'unrest':
        return t('countryBrief.intelMemory.domains.unrest');
      case 'cyber':
        return t('countryBrief.intelMemory.domains.cyber');
      case 'maritime':
        return t('countryBrief.intelMemory.domains.maritime');
      case 'natural':
        return t('countryBrief.intelMemory.domains.natural');
      case 'aviation':
        return t('countryBrief.intelMemory.domains.aviation');
      default:
        return domain;
    }
  }

  private selectDomain(domain: IntelHistoryDomain): void {
    if (this.disposed) return;
    if (domain === this.domain && this.timelineState !== 'unavailable') return;
    this.domain = domain;
    for (const btn of this.filtersEl.querySelectorAll<HTMLButtonElement>('.country-intel-memory-pill')) {
      btn.setAttribute('aria-pressed', String((btn.dataset.domain ?? '') === domain));
    }
    this.similarAbort?.abort();
    this.similarAbort = null;
    this.similarSubmitBtn.disabled = false;
    this.similarResultsEl.setAttribute('aria-busy', 'false');
    this.similarResultsEl.replaceChildren();
    void this.loadTimeline();
  }

  private async loadTimeline(): Promise<void> {
    if (this.disposed) return;
    this.timelineAbort?.abort();
    this.loadMoreAbort?.abort();
    this.loadMoreAbort = null;

    const controller = new AbortController();
    this.timelineAbort = controller;

    this.records = [];
    this.nextCursor = '';
    this.partial = false;
    this.loadingMore = false;
    this.loadMoreError = false;
    this.timelineState = 'loading';
    this.syncPrefillVisibility();
    this.renderTimeline();

    try {
      const resp = await this.fetchTimelineFn(
        {
          country: this.countryCode,
          domain: this.domain,
          limit: TIMELINE_PAGE_LIMIT,
          cursor: '',
        },
        controller.signal,
      );
      if (this.disposed || controller.signal.aborted || this.timelineAbort !== controller) return;
      if (resp.upstreamUnavailable) {
        this.timelineState = 'unavailable';
        this.renderTimeline();
        return;
      }
      this.records = resp.records ?? [];
      this.nextCursor = resp.nextCursor ?? '';
      this.partial = resp.partial === true;
      this.timelineState = 'ready';
      this.syncPrefillVisibility();
      this.renderTimeline();
    } catch (error) {
      if (this.disposed || controller.signal.aborted || this.timelineAbort !== controller) return;
      const status = getRpcErrorStatusCode(error);
      if (status === 401 || status === 403) {
        this.timelineState = 'locked';
        this.renderLocked();
        return;
      }
      this.timelineState = 'unavailable';
      this.renderTimeline();
    }
  }

  private async loadMore(): Promise<void> {
    if (this.disposed || this.loadingMore || !this.nextCursor || this.timelineState !== 'ready') return;

    this.loadMoreAbort?.abort();
    const controller = new AbortController();
    this.loadMoreAbort = controller;
    const cursor = this.nextCursor;
    const domain = this.domain;

    this.loadingMore = true;
    this.loadMoreError = false;
    this.renderTimeline();

    try {
      const resp = await this.fetchTimelineFn(
        {
          country: this.countryCode,
          domain,
          limit: TIMELINE_PAGE_LIMIT,
          cursor,
        },
        controller.signal,
      );
      if (this.disposed || controller.signal.aborted || this.loadMoreAbort !== controller) return;
      this.loadingMore = false;
      if (resp.upstreamUnavailable) {
        this.loadMoreError = true;
        this.renderTimeline();
        return;
      }
      const seen = new Set(this.records.map((item) => item.id).filter(Boolean));
      for (const item of resp.records ?? []) {
        if (item.id && seen.has(item.id)) continue;
        if (item.id) seen.add(item.id);
        this.records.push(item);
      }
      this.nextCursor = resp.nextCursor ?? '';
      this.partial = this.partial || resp.partial === true;
      this.syncPrefillVisibility();
      this.renderTimeline();
    } catch {
      if (this.disposed || controller.signal.aborted || this.loadMoreAbort !== controller) return;
      this.loadingMore = false;
      this.loadMoreError = true;
      this.renderTimeline();
    }
  }

  private async runSimilarSearch(): Promise<void> {
    if (this.disposed) return;
    const situation = this.similarInput.value.trim();
    if (situation.length < MIN_SITUATION_LENGTH) {
      this.similarResultsEl.replaceChildren(
        el('p', 'country-intel-memory-hint', t('countryBrief.intelMemory.similarMinLength')),
      );
      return;
    }

    this.similarAbort?.abort();
    const controller = new AbortController();
    this.similarAbort = controller;

    this.similarSubmitBtn.disabled = true;
    this.similarResultsEl.setAttribute('aria-busy', 'true');
    this.similarResultsEl.replaceChildren(
      el('p', 'country-intel-memory-status', t('countryBrief.intelMemory.similarLoading')),
    );

    try {
      const resp = await this.fetchSimilarFn(
        {
          situation,
          country: this.countryCode,
          domain: this.domain,
          limit: SIMILAR_LIMIT,
        },
        controller.signal,
      );
      if (this.disposed || controller.signal.aborted || this.similarAbort !== controller) return;
      this.similarSubmitBtn.disabled = false;
      this.similarResultsEl.setAttribute('aria-busy', 'false');

      if (resp.upstreamUnavailable) {
        this.similarResultsEl.replaceChildren(
          el('p', 'country-intel-memory-notice', t('countryBrief.intelMemory.similarUnavailable')),
        );
        return;
      }

      const matches = resp.records ?? [];
      if (matches.length === 0) {
        this.similarResultsEl.replaceChildren(
          el('p', 'country-intel-memory-empty', t('countryBrief.intelMemory.similarEmpty')),
        );
        return;
      }

      const frag = document.createDocumentFragment();
      if (resp.partial) {
        const notice = el('p', 'country-intel-memory-notice', t('countryBrief.intelMemory.partial'));
        notice.setAttribute('role', 'status');
        frag.append(notice);
      }
      const list = el('ul', 'country-intel-memory-list country-intel-memory-similar-list');
      for (const record of matches) {
        list.append(this.renderRecordItem(record, true));
      }
      frag.append(list);
      this.similarResultsEl.replaceChildren(frag);
    } catch {
      if (this.disposed || controller.signal.aborted || this.similarAbort !== controller) return;
      this.similarSubmitBtn.disabled = false;
      this.similarResultsEl.setAttribute('aria-busy', 'false');
      this.similarResultsEl.replaceChildren(
        el('p', 'country-intel-memory-notice', t('countryBrief.intelMemory.similarUnavailable')),
      );
    }
  }

  private syncPrefillVisibility(): void {
    this.similarPrefillBtn.hidden = this.records.length === 0;
  }

  private renderLocked(): void {
    const wrap = el('div', 'cdp-pro-locked');
    wrap.dataset.briefState = 'locked';
    wrap.append(
      el('span', 'cdp-pro-lock-icon', '\uD83D\uDD12'),
      el('span', 'cdp-pro-lock-text', t('countryBrief.intelMemory.proLocked')),
    );
    this.mount.replaceChildren(wrap);
  }

  private renderTimeline(): void {
    if (this.timelineState === 'loading') {
      const loading = el('div', 'cdp-loading-inline');
      loading.append(
        el('div', 'cdp-loading-line'),
        el('div', 'cdp-loading-line cdp-loading-line-short'),
        el('span', 'cdp-loading-text', t('countryBrief.intelMemory.loading')),
      );
      this.timelineEl.replaceChildren(loading);
      return;
    }

    if (this.timelineState === 'unavailable') {
      const wrap = el('div', 'country-intel-memory-error');
      const notice = el('div', 'cdp-empty', t('countryBrief.intelMemory.unavailable'));
      notice.dataset.briefState = 'unavailable';
      const retryBtn = el('button', 'cdp-action-btn', t('countryBrief.intelMemory.retry'));
      retryBtn.type = 'button';
      retryBtn.addEventListener('click', () => void this.loadTimeline());
      wrap.append(notice, retryBtn);
      this.timelineEl.replaceChildren(wrap);
      return;
    }

    const frag = document.createDocumentFragment();
    if (this.partial) {
      const notice = el('p', 'country-intel-memory-notice', t('countryBrief.intelMemory.partial'));
      notice.setAttribute('role', 'status');
      frag.append(notice);
    }

    if (this.records.length === 0) {
      frag.append(el('p', 'country-intel-memory-empty', t('countryBrief.intelMemory.empty')));
    } else {
      const list = el('ul', 'country-intel-memory-list');
      for (const record of this.records) {
        list.append(this.renderRecordItem(record, false));
      }
      frag.append(list);
    }

    if (this.loadMoreError) {
      const err = el('p', 'country-intel-memory-notice', t('countryBrief.intelMemory.loadMoreError'));
      err.setAttribute('role', 'status');
      frag.append(err);
    }

    if (this.nextCursor) {
      const actions = el('div', 'country-intel-memory-actions');
      const loadMoreBtn = el(
        'button',
        'cdp-action-btn country-intel-memory-load-more',
        this.loadingMore
          ? t('countryBrief.intelMemory.loadingMore')
          : t('countryBrief.intelMemory.loadMore'),
      );
      loadMoreBtn.type = 'button';
      loadMoreBtn.disabled = this.loadingMore;
      loadMoreBtn.addEventListener('click', () => void this.loadMore());
      actions.append(loadMoreBtn);
      frag.append(actions);
    }

    this.timelineEl.replaceChildren(frag);
  }

  private renderRecordItem(record: IntelHistoryRecord, showScore: boolean): HTMLLIElement {
    const item = el('li', 'country-intel-memory-item');

    const meta = el('div', 'country-intel-memory-meta');
    const dateStr = formatUtcDate(record.occurredAt);
    const timeEl = el('time', 'country-intel-memory-date', dateStr);
    if (dateStr !== '—') timeEl.dateTime = dateStr;
    meta.append(timeEl);

    if (record.domain) {
      const domainBadge = el(
        'span',
        'country-intel-memory-badge country-intel-memory-domain',
        this.domainLabel(record.domain),
      );
      domainBadge.dataset.domain = record.domain;
      meta.append(domainBadge);
    }

    if (record.category) {
      meta.append(
        el('span', 'country-intel-memory-badge country-intel-memory-category', record.category),
      );
    }

    if (showScore && Number.isFinite(record.score)) {
      const pct = `${Math.round(record.score * 100)}%`;
      meta.append(el('span', 'country-intel-memory-score', pct));
    }

    item.append(meta);

    const title = el('div', 'country-intel-memory-title', record.title);
    item.append(title);

    const summaryText = truncateSummary(record.summary ?? '');
    if (summaryText) {
      item.append(el('p', 'country-intel-memory-summary', summaryText));
    }

    const safeHref = safeExternalHttpUrl(record.sourceUrl);
    if (record.resource || safeHref) {
      const footer = el('div', 'country-intel-memory-footer');
      if (record.resource) {
        footer.append(el('span', 'country-intel-memory-resource', record.resource));
      }
      if (safeHref) {
        const link = el('a', 'country-intel-memory-source', t('countryBrief.intelMemory.sourceLink'));
        link.href = safeHref;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        footer.append(link);
      }
      item.append(footer);
    }

    return item;
  }
}
