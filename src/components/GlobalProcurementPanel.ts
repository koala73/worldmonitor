import { Panel } from './Panel';
import type { GlobalTender, ListGlobalTendersResponse } from '@/generated/client/worldmonitor/economic/v1/service_client';
import type { GlobalTenderFilters } from '@/services/global-tenders';
import { escapeHtml, sanitizeUrl, unsafeRawHtml } from '@/utils/sanitize';

type RequestHandler = (filters: GlobalTenderFilters, append: boolean) => void;

const DEFAULT_FILTERS: GlobalTenderFilters = {
  query: '',
  buyer: '',
  country: '',
  source: '',
  sort: 'closing_soon',
  pageSize: 25,
  cursor: '',
  minAutomationScore: 0,
};

// Any evidence-backed keyword match (automationFit level "low" scores 30), so
// the toggle means "has technology-relevance evidence", nothing stronger.
const TECH_RELEVANCE_MIN_SCORE = 30;

const SOURCES = [
  ['', 'All sources'],
  ['sam', 'SAM.gov'],
  ['ted', 'TED'],
  ['contracts-finder', 'Contracts Finder'],
  ['canada-buys', 'CanadaBuys'],
  ['gets', 'GETS'],
  ['world-bank', 'World Bank'],
] as const;

const SORTS = [
  ['closing_soon', 'Closing soon'],
  ['newest', 'Newest'],
  ['estimated_value', 'Estimated value'],
  ['relevance', 'Technology relevance'],
] as const;

function selected(value: string | undefined, expected: string): string {
  return value === expected ? ' selected' : '';
}

function validDate(value: string | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

export class GlobalProcurementPanel extends Panel {
  private data: ListGlobalTendersResponse | null = null;
  private filters: GlobalTenderFilters = { ...DEFAULT_FILTERS };
  private requestHandler: RequestHandler | null = null;
  private loading = false;

  constructor() {
    super({
      id: 'global-procurement',
      title: 'Global Procurement',
      defaultRowSpan: 2,
      showCount: true,
      premium: 'locked',
      infoTooltip: 'Search active official procurement opportunities. Results are seed-backed and source health is reported explicitly.',
    });
    this.showLoading('Loading procurement opportunities…');

    this.content.addEventListener('submit', (event) => {
      const form = (event.target as HTMLElement).closest<HTMLFormElement>('[data-procurement-filters]');
      if (!form) return;
      event.preventDefault();
      this.filters = this.readFilters(form);
      this.request({ ...this.filters, cursor: '' }, false);
    });

    this.content.addEventListener('click', (event) => {
      const target = event.target as HTMLElement;
      if (target.closest('[data-procurement-load-more]')) {
        const cursor = this.data?.nextCursor;
        if (cursor) this.request({ ...this.filters, cursor }, true);
        return;
      }
      if (target.closest('[data-procurement-reset]')) {
        this.filters = { ...DEFAULT_FILTERS };
        this.request({ ...this.filters }, false);
      }
    });
  }

  public setRequestHandler(handler: RequestHandler): void {
    this.requestHandler = handler;
  }

  public setLoading(loading: boolean, append = false): void {
    this.loading = loading;
    if (loading && !append && !this.data) {
      this.showLoading('Loading procurement opportunities…');
      return;
    }
    this.render();
  }

  public update(data: ListGlobalTendersResponse, append = false): void {
    this.loading = false;
    if (append && this.data) {
      const tenders = new Map(this.data.tenders.map((tender) => [tender.id, tender]));
      data.tenders.forEach((tender) => tenders.set(tender.id, tender));
      this.data = { ...data, tenders: [...tenders.values()] };
    } else {
      this.data = data;
    }
    this.setCount(this.data.total);
    this.render();
  }

  public showUnavailable(): void {
    this.loading = false;
    this.data = null;
    this.setCount(0);
    this.showError('Procurement opportunities are currently unavailable.', () => this.request({ ...this.filters }, false), 60);
  }

  public clear(): void {
    this.data = null;
    this.filters = { ...DEFAULT_FILTERS };
    this.loading = false;
    this.setCount(0);
    this.clearSensitiveContent();
  }

  private request(filters: GlobalTenderFilters, append: boolean): void {
    if (!this.requestHandler || this.loading) return;
    this.filters = { ...filters, cursor: '' };
    this.setLoading(true, append);
    this.requestHandler(filters, append);
  }

  private readFilters(form: HTMLFormElement): GlobalTenderFilters {
    const formData = new FormData(form);
    return {
      query: String(formData.get('query') || '').trim(),
      buyer: String(formData.get('buyer') || '').trim(),
      country: String(formData.get('country') || '').trim().toUpperCase().slice(0, 2),
      source: String(formData.get('source') || ''),
      sort: String(formData.get('sort') || 'closing_soon'),
      pageSize: 25,
      cursor: '',
      minAutomationScore: formData.get('techRelevant') ? TECH_RELEVANCE_MIN_SCORE : 0,
    };
  }

  private render(): void {
    const data = this.data;
    const controls = this.renderControls();
    if (!data) {
      this.setSafeContent(unsafeRawHtml(`${controls}<div class="economic-empty">No procurement snapshot is available yet.</div>`, 'global procurement controls'));
      return;
    }

    const sourceSummary = data.sourceStatuses.map((source) => {
      const lastSuccess = source.lastSuccessfulAt ? ` · last success ${new Date(source.lastSuccessfulAt).toLocaleString()}` : '';
      return `${source.source}: ${source.state} (${source.recordCount})${lastSuccess}`;
    }).join(' · ');
    const availability = data.availability === 'partial'
      ? '<div class="economic-warning">Partial coverage — healthy sources remain visible while one or more sources are unavailable.</div>'
      : data.availability === 'stale'
        ? '<div class="economic-warning">Showing stale last-good opportunities while all source refreshes are failing.</div>'
        : data.availability === 'empty'
          ? '<div class="economic-empty">Official sources returned no matching open opportunities.</div>'
          : !data.dataAvailable
            ? '<div class="economic-warning">The canonical procurement snapshot is unavailable.</div>'
            : '';
    const cards = data.tenders.map((tender) => this.renderTenderCard(tender)).join('');
    const visible = data.tenders.length;
    const loadMore = data.nextCursor
      ? `<button type="button" class="debt-load-more" data-procurement-load-more${this.loading ? ' disabled' : ''}>${this.loading ? 'Loading…' : 'Load more'} <span class="debt-load-more-count">(${Math.max(0, data.total - visible)} remaining)</span></button>`
      : '';

    this.setSafeContent(unsafeRawHtml(`
      ${controls}
      ${availability}
      <div class="global-procurement-summary">Showing ${visible.toLocaleString()} of ${data.total.toLocaleString()} matching opportunities</div>
      ${cards ? `<div class="spending-list global-procurement-list">${cards}</div>` : ''}
      ${loadMore}
      <div class="economic-footer"><span class="economic-source">${escapeHtml(sourceSummary)}${data.fetchedAt ? ` · snapshot ${escapeHtml(new Date(data.fetchedAt).toLocaleString())}` : ''}</span></div>
    `, 'global procurement results'));
  }

  private renderControls(): string {
    return `<form class="global-procurement-controls" data-procurement-filters>
      <input class="global-procurement-input" name="query" data-procurement-query type="search" value="${escapeHtml(String(this.filters.query || ''))}" placeholder="Search title or description" aria-label="Search procurement opportunities">
      <input class="global-procurement-input" name="buyer" type="search" value="${escapeHtml(String(this.filters.buyer || ''))}" placeholder="Buyer" aria-label="Filter by buyer">
      <input class="global-procurement-input global-procurement-country" name="country" data-procurement-country type="text" maxlength="2" value="${escapeHtml(String(this.filters.country || ''))}" placeholder="Country" aria-label="Filter by ISO country code">
      <select class="global-procurement-select" name="source" data-procurement-source aria-label="Filter by source">
        ${SOURCES.map(([value, label]) => `<option value="${value}"${selected(this.filters.source, value)}>${label}</option>`).join('')}
      </select>
      <select class="global-procurement-select" name="sort" data-procurement-sort aria-label="Sort opportunities">
        ${SORTS.map(([value, label]) => `<option value="${value}"${selected(this.filters.sort, value)}>${label}</option>`).join('')}
      </select>
      <label class="global-procurement-toggle" title="Shows only opportunities whose title, description, or categories matched technology keywords. Keyword relevance evidence only — not an indication of bidding eligibility.">
        <input type="checkbox" name="techRelevant" data-procurement-tech-relevant${(this.filters.minAutomationScore || 0) > 0 ? ' checked' : ''}${this.loading ? ' disabled' : ''}>
        Technology relevant only
      </label>
      <button type="submit" class="global-procurement-apply"${this.loading ? ' disabled' : ''}>Apply</button>
      <button type="button" class="global-procurement-reset" data-procurement-reset${this.loading ? ' disabled' : ''}>Reset</button>
    </form>`;
  }

  private renderTenderCard(tender: GlobalTender): string {
    const safeUrl = sanitizeUrl(tender.officialUrl);
    const deadline = validDate(tender.deadline);
    const daysUntilDeadline = deadline ? Math.ceil((deadline.getTime() - Date.now()) / 86_400_000) : null;
    const closingSoon = daysUntilDeadline !== null && daysUntilDeadline >= 0 && daysUntilDeadline <= 3;
    const amount = tender.money?.amount && tender.money.amount > 0
      ? `${tender.money.currency || ''} ${tender.money.amount.toLocaleString()}`.trim()
      : '';
    const meta = [tender.source, tender.buyer, tender.countryCode, amount, deadline ? `Closes ${deadline.toLocaleDateString()}` : '', closingSoon ? 'CLOSING SOON' : '']
      .filter((value): value is string => Boolean(value))
      .map((value) => escapeHtml(value))
      .join(' · ');
    const relevance = tender.automationFit?.matchReasons?.length
      ? `<div class="award-agency">Technology relevance (keyword evidence, not bidding eligibility): ${escapeHtml(tender.automationFit.matchReasons.join(', '))}</div>`
      : '';
    return `<article class="spending-award global-procurement-card">
      <div class="award-header"><span class="award-amount">${escapeHtml(tender.status.toUpperCase())}</span><span class="award-icon">${closingSoon ? '⏰' : '📄'}</span></div>
      <div class="award-recipient">${escapeHtml(tender.title)}</div>
      <div class="award-agency">${meta}</div>
      ${tender.description ? `<div class="award-desc">${escapeHtml(tender.description.slice(0, 240))}${tender.description.length > 240 ? '…' : ''}</div>` : ''}
      ${relevance}
      ${safeUrl ? `<a href="${safeUrl}" target="_blank" rel="noopener noreferrer nofollow" class="award-agency">Official notice ↗</a>` : ''}
    </article>`;
  }
}
