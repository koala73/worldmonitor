import { Panel } from './Panel';
import {
  WEBMCP_PROCUREMENT_COUNTRY_CODE_CHARS,
  WEBMCP_PROCUREMENT_COUNTRY_CODE_PATTERN,
  WEBMCP_PROCUREMENT_TEXT_MAX_CHARS,
  WEBMCP_PROCUREMENT_TOOL_NAME,
} from '@/config/webmcp';
import type { GlobalTender, ListGlobalTendersResponse } from '@/generated/client/worldmonitor/economic/v1/service_client';
import type { GlobalTenderFilters } from '@/services/global-tenders';
import { PanelGateReason } from '@/services/panel-gating';
import { isMobileDevice } from '@/utils';
import { setTrustedHtml, trustedHtml } from '@/utils/dom-utils';
import { escapeHtml, sanitizeUrl } from '@/utils/sanitize';

type RequestHandler = (
  filters: GlobalTenderFilters,
  append: boolean,
  signal: AbortSignal,
) => void | Promise<void>;

type DeclarativeSubmitEvent = SubmitEvent & {
  readonly agentInvoked?: boolean;
  respondWith?: (response: Promise<unknown>) => void;
};

type DeclarativeToolEvent = Event & {
  readonly toolName?: string;
};

interface PendingAgentInvocation {
  id: number;
  form: HTMLFormElement;
  previousFilters: GlobalTenderFilters;
  promise: Promise<ProcurementSearchToolResult>;
  resolve: (result: ProcurementSearchToolResult) => void;
}

export interface ProcurementSearchToolSuccess {
  ok: true;
  matchCount: number;
  availability: string;
  countryCoverage: 'observed' | 'unknown' | 'not_requested';
  appliedFilters: string[];
  appliedFiltersTruncated: boolean;
  sourceStatusSummary: Array<{
    source: string;
    state: string;
    recordCount: number;
  }>;
  sourceStatusesTruncated: boolean;
}

export interface ProcurementSearchToolFailure {
  ok: false;
  code: string;
  message: string;
  retryable: true;
}

export type ProcurementSearchToolResult = ProcurementSearchToolSuccess | ProcurementSearchToolFailure;

class RetryableProcurementSearchError extends Error {
  public readonly retryable = true;

  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'RetryableProcurementSearchError';
  }
}

type ProcurementFilterParseResult =
  | { ok: true; filters: GlobalTenderFilters }
  | { ok: false; error: RetryableProcurementSearchError };

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
const DECLARATIVE_TOOL_DESCRIPTION = 'Search official global procurement opportunities using visible filters.';
const MAX_AGENT_SOURCE_STATUSES = 8;
const MAX_AGENT_APPLIED_FILTERS = 16;
const MAX_AGENT_FILTER_NAME_LENGTH = 32;
const MAX_AGENT_RESULT_JSON_LENGTH = 1_500;
const PROCUREMENT_COUNTRY_CODE = new RegExp(WEBMCP_PROCUREMENT_COUNTRY_CODE_PATTERN);

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
  private pendingAgentInvocation: PendingAgentInvocation | null = null;
  private settlingAgentForm: HTMLFormElement | null = null;
  private nextAgentInvocationId = 0;
  private agentToolActive = false;
  private requestStarting = false;
  private activeRequestController: AbortController | null = null;
  private activeRequestPreviousFilters: GlobalTenderFilters | null = null;
  private lifecycleEpoch = 0;
  private contentRevision = 0;
  private disposed = false;

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

    for (const eventName of ['pointerdown', 'mousedown', 'click', 'beforeinput', 'keydown']) {
      this.content.addEventListener(eventName, (event) => this.guardPendingFormInteraction(event), { capture: true });
    }
    for (const eventName of ['input', 'change']) {
      this.content.addEventListener(eventName, (event) => this.restorePendingFormValues(event), { capture: true });
    }

    this.content.addEventListener('submit', (event) => {
      const form = (event.target as HTMLElement).closest<HTMLFormElement>('[data-procurement-filters]');
      if (!form) return;
      event.preventDefault();
      const submitEvent = event as DeclarativeSubmitEvent;
      if (submitEvent.agentInvoked !== true) {
        // The exact declaring form must stay mounted while Chrome owns its
        // respondWith() promise. Its controls intentionally remain part of the
        // declarative schema, so ignore a keyboard-generated human submit
        // instead of letting it replace the filters for the in-flight result.
        if (this.loading || this.pendingAgentInvocation !== null || this.settlingAgentForm !== null) return;
        const parsedFilters = this.readFilters(form);
        if (!parsedFilters.ok) {
          form.reportValidity();
          return;
        }
        const previousFilters = { ...this.filters };
        this.filters = parsedFilters.filters;
        this.setAgentToolActive(false);
        this.request({ ...this.filters, cursor: '' }, false, previousFilters);
        return;
      }

      if (typeof submitEvent.respondWith !== 'function') return;
      if (this.loading || this.pendingAgentInvocation !== null || this.settlingAgentForm !== null) {
        this.respondWithRetryableFailure(submitEvent, new RetryableProcurementSearchError(
          'request_in_progress',
          'A procurement search is already in progress. Retry after the visible results finish updating.',
        ));
        return;
      }
      if (!this.canDeclareTool() || form.getAttribute('toolname') !== WEBMCP_PROCUREMENT_TOOL_NAME) {
        this.respondWithRetryableFailure(submitEvent, new RetryableProcurementSearchError(
          'panel_unavailable',
          'The procurement search form is not currently available. Retry after the panel is visible and its data is ready.',
        ));
        return;
      }

      const parsedFilters = this.readFilters(form);
      if (!parsedFilters.ok) {
        this.respondWithRetryableFailure(submitEvent, parsedFilters.error);
        return;
      }
      const previousFilters = { ...this.filters };
      this.filters = parsedFilters.filters;
      const pending = this.beginAgentInvocation(form, previousFilters);
      try {
        submitEvent.respondWith(pending.promise);
      } catch {
        this.filters = { ...pending.previousFilters };
        this.failAgentInvocation(pending.id, new RetryableProcurementSearchError(
          'response_channel_unavailable',
          'The procurement search response channel was unavailable. Retry the search.',
        ));
        return;
      }

      this.setAgentToolActive(true);
      if (!this.request({ ...this.filters, cursor: '' }, false, pending.previousFilters)) {
        this.filters = { ...pending.previousFilters };
        this.failAgentInvocation(pending.id, new RetryableProcurementSearchError(
          'request_not_started',
          'The procurement search could not start because the panel is not ready. Retry when the form is available.',
        ));
      }
    });

    this.content.addEventListener('click', (event) => {
      const target = event.target as HTMLElement;
      if (target.closest('[data-procurement-load-more]')) {
        if (this.loading || this.pendingAgentInvocation !== null || this.settlingAgentForm !== null) return;
        const cursor = this.data?.nextCursor;
        if (cursor) this.request({ ...this.filters, cursor }, true);
        return;
      }
      if (target.closest('[data-procurement-reset]')) {
        if (this.pendingAgentInvocation !== null) {
          this.cancelAgentOperation();
          return;
        }
        if (this.loading || this.settlingAgentForm !== null) return;
        this.cancelAgentOperation();
        const previousFilters = { ...this.filters };
        this.filters = { ...DEFAULT_FILTERS };
        this.request({ ...this.filters }, false, previousFilters);
      }
    });

    this.content.addEventListener('reset', (event) => {
      const form = (event.target as HTMLElement).closest<HTMLFormElement>('[data-procurement-filters]');
      if (!form) return;
      this.cancelAgentOperation();
    });

    if (typeof window !== 'undefined') {
      window.addEventListener('toolactivated', (event) => {
        const toolEvent = event as DeclarativeToolEvent;
        if (toolEvent.toolName !== WEBMCP_PROCUREMENT_TOOL_NAME || !this.canDeclareTool()) return;
        this.setAgentToolActive(true);
      }, { signal: this.signal });
      window.addEventListener('toolcancel', (event) => {
        const toolEvent = event as DeclarativeToolEvent;
        if (toolEvent.toolName !== WEBMCP_PROCUREMENT_TOOL_NAME) return;
        this.cancelAgentOperation();
      }, { signal: this.signal });
      window.addEventListener('resize', () => this.handlePanelVisibilityChange(), { signal: this.signal });
    }

  }

  public setRequestHandler(handler: RequestHandler): void {
    this.requestHandler = handler;
    if (this.pendingAgentInvocation !== null || this.settlingAgentForm !== null) {
      // DataLoader re-enters loadGlobalTenders() for every form request and
      // installs the same handler again. Re-registering while loading would
      // remove the declaring attributes and cancel Chrome's active response.
      this.syncAgentFormVisualState();
      return;
    }
    this.syncDeclarativeToolState();
  }

  public setLoading(loading: boolean, append = false): void {
    const contentRevision = ++this.contentRevision;
    const supersededInvocation = loading && !this.requestStarting
      ? this.pendingAgentInvocation
      : null;
    if (supersededInvocation) {
      this.abortActiveRequest();
      this.failAgentInvocation(supersededInvocation.id, new RetryableProcurementSearchError(
        'superseded',
        'The procurement search was superseded by a newer refresh. Retry the search.',
      ));
      this.loading = loading;
      this.syncAgentFormVisualState();
      this.deferAfterAgentSettlement(() => {
        if (
          this.pendingAgentInvocation !== null
          || this.settlingAgentForm !== null
          || this.disposed
          || this.contentRevision !== contentRevision
        ) return;
        if (loading && !append && !this.data) {
          this.showLoading('Loading procurement opportunities…');
          return;
        }
        this.render();
      });
      return;
    }
    this.loading = loading;
    if (this.pendingAgentInvocation !== null || this.settlingAgentForm !== null) {
      // Changing the declarative form or its registration while respondWith()
      // is pending cancels the browser invocation. Keep that exact form node
      // mounted and update only non-schema visual state until it settles.
      this.syncAgentFormVisualState();
      if (this.pendingAgentInvocation === null) {
        this.deferAfterAgentSettlement(() => {
          if (
            this.settlingAgentForm !== null
            || this.disposed
            || this.contentRevision !== contentRevision
          ) return;
          if (loading && !append && !this.data) {
            this.showLoading('Loading procurement opportunities…');
            return;
          }
          this.render();
        });
      }
      return;
    }
    this.syncDeclarativeToolState();
    if (loading && !append && !this.data) {
      this.showLoading('Loading procurement opportunities…');
      return;
    }
    this.render();
  }

  public update(data: ListGlobalTendersResponse, append = false): void {
    if (this.disposed) return;
    const contentRevision = ++this.contentRevision;
    this.activeRequestPreviousFilters = null;
    this.loading = false;
    if (append && this.data) {
      const tenders = new Map(this.data.tenders.map((tender) => [tender.id, tender]));
      data.tenders.forEach((tender) => tenders.set(tender.id, tender));
      this.data = { ...data, tenders: [...tenders.values()] };
    } else {
      this.data = data;
    }
    this.setCount(this.data.total);
    const invocationId = this.pendingAgentInvocation?.id;
    if (invocationId !== undefined) {
      if (!this.renderAgentTerminalResult()) {
        this.failAgentInvocation(invocationId, new RetryableProcurementSearchError(
          'response_target_unavailable',
          'The procurement results view was replaced before the search completed. Retry on the current panel.',
        ));
        return;
      }
      if (!data.dataAvailable) {
        this.failAgentInvocation(invocationId, new RetryableProcurementSearchError(
          'procurement_unavailable',
          'Procurement sources are currently unavailable, so the search could not return a reliable result. Retry later.',
        ));
        return;
      }
      this.resolveAgentInvocation(invocationId, this.agentResult(data));
      return;
    }

    if (this.settlingAgentForm !== null) {
      this.deferAfterAgentSettlement(() => {
        if (
          this.settlingAgentForm !== null
          || this.disposed
          || this.contentRevision !== contentRevision
        ) return;
        this.render();
      });
      return;
    }

    this.syncDeclarativeToolState();
    this.render();
  }

  public showUnavailable(): void {
    if (this.disposed) return;
    const contentRevision = ++this.contentRevision;
    this.activeRequestPreviousFilters = null;
    this.loading = false;
    this.data = null;
    this.setCount(0);
    const invocationId = this.pendingAgentInvocation?.id;
    if (invocationId !== undefined) {
      this.renderAgentTerminalError('Procurement opportunities are currently unavailable.');
      this.failAgentInvocation(invocationId, new RetryableProcurementSearchError(
        'procurement_unavailable',
        'Procurement sources are currently unavailable, so the search did not complete. Retry later.',
      ));
      this.deferAfterAgentSettlement(() => {
        if (
          this.disposed
          || this.pendingAgentInvocation !== null
          || this.settlingAgentForm !== null
          || this.contentRevision !== contentRevision
        ) return;
        this.showError('Procurement opportunities are currently unavailable.', () => this.request({ ...this.filters }, false), 60);
      });
      return;
    }
    if (this.settlingAgentForm !== null) {
      this.deferAfterAgentSettlement(() => {
        if (
          this.settlingAgentForm !== null
          || this.disposed
          || this.contentRevision !== contentRevision
        ) return;
        this.showError('Procurement opportunities are currently unavailable.', () => this.request({ ...this.filters }, false), 60);
      });
      return;
    }
    this.showError('Procurement opportunities are currently unavailable.', () => this.request({ ...this.filters }, false), 60);
  }

  public clear(): void {
    this.contentRevision += 1;
    this.abortActiveRequest();
    const pending = this.pendingAgentInvocation;
    const preservesAgentForm = pending !== null || this.settlingAgentForm !== null;
    if (pending) {
      this.failAgentInvocation(pending.id, new RetryableProcurementSearchError(
        'panel_unavailable',
        'The procurement panel became unavailable before the search completed. Retry after access is restored.',
      ));
    }
    this.data = null;
    this.filters = { ...DEFAULT_FILTERS };
    this.loading = false;
    this.setCount(0);
    if (preservesAgentForm) {
      this.deferAfterAgentSettlement(() => {
        if (
          this.settlingAgentForm !== null
          || this.disposed
          || this.data !== null
        ) return;
        this.clearSensitiveContent();
      });
      return;
    }
    this.clearSensitiveContent();
  }

  public override showGatedCta(reason: PanelGateReason, onAction: () => void): void {
    const lifecycleEpoch = ++this.lifecycleEpoch;
    const hadPendingInvocation = this.pendingAgentInvocation !== null || this.settlingAgentForm !== null;
    this.cancelForUnavailablePanel();
    if (hadPendingInvocation) {
      this.deferAfterAgentSettlement(() => {
        if (!this.disposed && this.lifecycleEpoch === lifecycleEpoch) super.showGatedCta(reason, onAction);
      });
      return;
    }
    super.showGatedCta(reason, onAction);
  }

  public override showLocked(features: string[] = []): void {
    const lifecycleEpoch = ++this.lifecycleEpoch;
    const hadPendingInvocation = this.pendingAgentInvocation !== null || this.settlingAgentForm !== null;
    this.cancelForUnavailablePanel();
    if (hadPendingInvocation) {
      this.deferAfterAgentSettlement(() => {
        if (!this.disposed && this.lifecycleEpoch === lifecycleEpoch) super.showLocked(features);
      });
      return;
    }
    super.showLocked(features);
  }

  public override unlockPanel(): void {
    this.lifecycleEpoch += 1;
    const wasLocked = this.isLocked;
    super.unlockPanel();
    if (wasLocked) this.syncDeclarativeToolState();
  }

  public override hide(): void {
    const hadPendingInvocation = this.pendingAgentInvocation !== null || this.settlingAgentForm !== null;
    super.hide();
    this.cancelForUnavailablePanel();
    if (!hadPendingInvocation && this.data && !this.isLocked) this.render();
  }

  public override show(): void {
    super.show();
    this.syncDeclarativeToolState();
    if (this.data && !this.isLocked) this.render();
  }

  public override notifyConnected(): void {
    super.notifyConnected();
    this.syncDeclarativeToolState();
    if (this.data && !this.isLocked) this.render();
  }

  public override destroy(): void {
    if (this.disposed) return;
    const hadPendingInvocation = this.pendingAgentInvocation !== null || this.settlingAgentForm !== null;
    this.lifecycleEpoch += 1;
    this.disposed = true;
    this.cancelForUnavailablePanel();
    if (hadPendingInvocation) {
      this.deferAfterAgentSettlement(() => {
        super.destroy();
      });
      return;
    }
    super.destroy();
  }

  private request(
    filters: GlobalTenderFilters,
    append: boolean,
    previousFilters: GlobalTenderFilters = this.filters,
  ): boolean {
    if (
      !this.requestHandler
      || this.loading
      || this.disposed
      || this.isLocked
      || !this.isPanelToolVisible()
    ) return false;
    this.abortActiveRequest();
    const controller = new AbortController();
    this.activeRequestController = controller;
    this.activeRequestPreviousFilters = { ...previousFilters };
    this.filters = { ...filters, cursor: '' };
    const invocationId = this.pendingAgentInvocation?.id ?? null;
    let completion: void | Promise<void>;
    this.requestStarting = true;
    try {
      this.setLoading(true, append);
      completion = this.requestHandler(filters, append, controller.signal);
    } catch {
      controller.abort();
      if (this.activeRequestController === controller) this.activeRequestController = null;
      if (this.activeRequestPreviousFilters) this.filters = { ...this.activeRequestPreviousFilters };
      this.activeRequestPreviousFilters = null;
      this.loading = false;
      if (invocationId === null) {
        this.render();
      } else {
        this.syncAgentFormVisualState();
      }
      return false;
    } finally {
      this.requestStarting = false;
    }
    void Promise.resolve(completion).then(
      () => {
        const wasActiveRequest = this.activeRequestController === controller;
        if (wasActiveRequest) this.activeRequestController = null;
        this.handleRequestHandlerSettled(invocationId, controller.signal);
        if (wasActiveRequest) this.activeRequestPreviousFilters = null;
      },
      () => {
        const wasActiveRequest = this.activeRequestController === controller;
        if (wasActiveRequest) this.activeRequestController = null;
        if (!this.disposed && !controller.signal.aborted) this.showUnavailable();
        if (wasActiveRequest) this.activeRequestPreviousFilters = null;
      },
    );
    return true;
  }

  private readFilters(form: HTMLFormElement): ProcurementFilterParseResult {
    const formData = new FormData(form);
    const query = String(formData.get('query') ?? '');
    const buyer = String(formData.get('buyer') ?? '');
    const country = String(formData.get('country') ?? '');
    if (
      query.length > WEBMCP_PROCUREMENT_TEXT_MAX_CHARS
      || buyer.length > WEBMCP_PROCUREMENT_TEXT_MAX_CHARS
    ) {
      return {
        ok: false,
        error: new RetryableProcurementSearchError(
          'invalid_arguments',
          `Procurement query and buyer filters must be at most ${WEBMCP_PROCUREMENT_TEXT_MAX_CHARS} characters.`,
        ),
      };
    }
    if (country && !PROCUREMENT_COUNTRY_CODE.test(country)) {
      return {
        ok: false,
        error: new RetryableProcurementSearchError(
          'invalid_arguments',
          'The procurement country filter must be exactly two ASCII letters.',
        ),
      };
    }
    return {
      ok: true,
      filters: {
        query: query.trim(),
        buyer: buyer.trim(),
        country: country.toUpperCase(),
        source: String(formData.get('source') || ''),
        sort: String(formData.get('sort') || 'closing_soon'),
        pageSize: 25,
        cursor: '',
        minAutomationScore: formData.get('techRelevant') ? TECH_RELEVANCE_MIN_SCORE : 0,
      },
    };
  }

  private render(): void {
    if (this.pendingAgentInvocation !== null || this.settlingAgentForm !== null) {
      this.syncAgentFormVisualState();
      return;
    }
    const controls = this.renderControls();
    this.setTrustedContent(trustedHtml(`
      ${controls}
      <div data-procurement-results>${this.renderResultsMarkup()}</div>
    `, 'escaped global procurement controls and results'));
  }

  private renderResultsMarkup(): string {
    const data = this.data;
    if (!data) return '<div class="economic-empty">No procurement snapshot is available yet.</div>';
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

    return `
      ${availability}
      <div class="global-procurement-summary">Showing ${visible.toLocaleString()} of ${data.total.toLocaleString()} matching opportunities</div>
      ${cards ? `<div class="spending-list global-procurement-list">${cards}</div>` : ''}
      ${loadMore}
      <div class="economic-footer"><span class="economic-source">${escapeHtml(sourceSummary)}${data.fetchedAt ? ` · snapshot ${escapeHtml(new Date(data.fetchedAt).toLocaleString())}` : ''}</span></div>
    `;
  }

  private renderControls(): string {
    const declareTool = this.canDeclareTool();
    const toolAttributes = declareTool
      ? ` toolname="${WEBMCP_PROCUREMENT_TOOL_NAME}" tooldescription="${DECLARATIVE_TOOL_DESCRIPTION}" toolautosubmit`
      : '';
    const activeClass = this.agentToolActive || this.pendingAgentInvocation ? ' webmcp-tool-active' : '';
    return `<form class="global-procurement-controls${activeClass}" data-procurement-filters aria-busy="${this.loading}"${toolAttributes}>
      <input class="global-procurement-input" name="query" data-procurement-query type="search" maxlength="${WEBMCP_PROCUREMENT_TEXT_MAX_CHARS}" value="${escapeHtml(String(this.filters.query || ''))}" placeholder="Search title or description" aria-label="Search procurement opportunities" toolparamdescription="Words to match in opportunity titles or descriptions.">
      <input class="global-procurement-input" name="buyer" type="search" maxlength="${WEBMCP_PROCUREMENT_TEXT_MAX_CHARS}" value="${escapeHtml(String(this.filters.buyer || ''))}" placeholder="Buyer" aria-label="Filter by buyer" toolparamdescription="Buyer or contracting authority name to match.">
      <input class="global-procurement-input global-procurement-country" name="country" data-procurement-country type="text" minlength="${WEBMCP_PROCUREMENT_COUNTRY_CODE_CHARS}" maxlength="${WEBMCP_PROCUREMENT_COUNTRY_CODE_CHARS}" pattern="${WEBMCP_PROCUREMENT_COUNTRY_CODE_PATTERN}" value="${escapeHtml(String(this.filters.country || ''))}" placeholder="Country" aria-label="Filter by ISO country code" toolparamdescription="Optional two-letter ISO 3166-1 alpha-2 country code; normalized to uppercase.">
      <select class="global-procurement-select" name="source" data-procurement-source aria-label="Filter by source" toolparamdescription="Official procurement source to search; select All sources to search every source.">
        ${SOURCES.map(([value, label]) => `<option value="${value}"${selected(this.filters.source, value)}>${label}</option>`).join('')}
      </select>
      <select class="global-procurement-select" name="sort" data-procurement-sort aria-label="Sort opportunities" toolparamdescription="Ordering for matching procurement opportunities.">
        ${SORTS.map(([value, label]) => `<option value="${value}"${selected(this.filters.sort, value)}>${label}</option>`).join('')}
      </select>
      <label class="global-procurement-toggle" title="Shows only opportunities whose title, description, or categories matched technology keywords. Keyword relevance evidence only — not an indication of bidding eligibility.">
        <input type="checkbox" name="techRelevant" data-procurement-tech-relevant toolparamdescription="Whether to show only opportunities with technology-relevance keyword evidence."${(this.filters.minAutomationScore || 0) > 0 ? ' checked' : ''}${this.loading ? ' disabled' : ''}>
        Technology relevant only
      </label>
      <button type="submit" class="global-procurement-apply"${this.loading ? ' disabled' : ''}>Apply</button>
      <button type="button" class="global-procurement-reset" data-procurement-reset aria-label="Reset filters or cancel the active search" title="Reset filters or cancel the active search"${this.loading ? ' disabled' : ''}>Reset</button>
    </form>`;
  }

  private canDeclareTool(): boolean {
    return !this.disposed
      && !this.isLocked
      && this.element.isConnected
      && this.isPanelToolVisible()
      && this.requestHandler !== null
      && this.data?.dataAvailable === true
      && !this.loading
      && this.settlingAgentForm === null;
  }

  private isPanelToolVisible(): boolean {
    if (this.element.classList.contains('hidden')) return false;
    return !(typeof window !== 'undefined'
      && isMobileDevice()
      && this.element.classList.contains('mobile-cat-hidden'));
  }

  private respondWithRetryableFailure(
    event: DeclarativeSubmitEvent,
    error: RetryableProcurementSearchError,
  ): void {
    try {
      event.respondWith?.(Promise.resolve(this.failureResult(error)));
    } catch {
      // There is no live invocation state to clean up when the browser rejects
      // this already-busy response channel synchronously.
    }
  }

  private beginAgentInvocation(
    form: HTMLFormElement,
    previousFilters: GlobalTenderFilters,
  ): PendingAgentInvocation {
    const previousId = this.pendingAgentInvocation?.id;
    if (previousId !== undefined) {
      this.failAgentInvocation(previousId, new RetryableProcurementSearchError(
        'superseded',
        'The procurement search was superseded by a newer agent request. Retry the earlier search if it is still needed.',
      ));
    }

    const id = ++this.nextAgentInvocationId;
    let resolve!: (result: ProcurementSearchToolResult) => void;
    const promise = new Promise<ProcurementSearchToolResult>((onResolve) => {
      resolve = onResolve;
    });
    const pending = { id, form, previousFilters, promise, resolve };
    this.pendingAgentInvocation = pending;
    return pending;
  }

  private resolveAgentInvocation(id: number, result: ProcurementSearchToolResult): void {
    const pending = this.pendingAgentInvocation;
    if (!pending || pending.id !== id) return;
    this.pendingAgentInvocation = null;
    this.settlingAgentForm = pending.form;
    this.setAgentToolActive(false);
    pending.resolve(result);
    this.syncDeclarativeToolStateAfterSettlement(pending.form);
  }

  private failAgentInvocation(id: number, error: RetryableProcurementSearchError): void {
    this.resolveAgentInvocation(id, this.failureResult(error));
  }

  private failureResult(error: RetryableProcurementSearchError): ProcurementSearchToolFailure {
    return {
      ok: false,
      code: String(error.code || 'request_failed').slice(0, 64),
      message: String(error.message || 'The procurement search failed. Retry later.').slice(0, 320),
      retryable: true,
    };
  }

  private handleRequestHandlerSettled(invocationId: number | null, signal: AbortSignal): void {
    if (
      signal.aborted
      || invocationId === null
      || this.pendingAgentInvocation?.id !== invocationId
      || !this.loading
    ) return;
    const contentRevision = ++this.contentRevision;
    this.loading = false;
    this.failAgentInvocation(invocationId, new RetryableProcurementSearchError(
      'request_did_not_settle',
      'The procurement search ended without a terminal result. Retry the search.',
    ));
    this.deferAfterAgentSettlement(() => {
      if (
        this.pendingAgentInvocation === null
        && this.settlingAgentForm === null
        && this.data
        && !this.isLocked
        && !this.disposed
        && this.contentRevision === contentRevision
      ) this.render();
    });
  }

  private agentResult(data: ListGlobalTendersResponse): ProcurementSearchToolResult {
    const countryCoverage = data.countryCoverage === 'observed' || data.countryCoverage === 'not_requested'
      ? data.countryCoverage
      : 'unknown';
    const appliedFilters = Array.isArray(data.appliedFilters) ? data.appliedFilters : [];
    const result: ProcurementSearchToolSuccess = {
      ok: true,
      matchCount: Math.max(0, Number.isSafeInteger(data.total) ? data.total : 0),
      availability: String(data.availability || 'available').slice(0, 32),
      countryCoverage,
      appliedFilters: appliedFilters.slice(0, MAX_AGENT_APPLIED_FILTERS).map((filter) => (
        String(filter).slice(0, MAX_AGENT_FILTER_NAME_LENGTH)
      )),
      appliedFiltersTruncated: appliedFilters.length > MAX_AGENT_APPLIED_FILTERS
        || appliedFilters.some((filter) => String(filter).length > MAX_AGENT_FILTER_NAME_LENGTH),
      sourceStatusSummary: data.sourceStatuses.slice(0, MAX_AGENT_SOURCE_STATUSES).map((source) => ({
        source: String(source.source || 'unknown').slice(0, 48),
        state: String(source.state || 'unknown').slice(0, 32),
        recordCount: Math.max(0, Number.isSafeInteger(source.recordCount) ? source.recordCount : 0),
      })),
      sourceStatusesTruncated: data.sourceStatuses.length > MAX_AGENT_SOURCE_STATUSES,
    };
    while (JSON.stringify(result).length > MAX_AGENT_RESULT_JSON_LENGTH) {
      const lastSourceStatus = result.sourceStatusSummary[result.sourceStatusSummary.length - 1];
      const lastAppliedFilter = result.appliedFilters[result.appliedFilters.length - 1];
      if (lastSourceStatus && (
        !lastAppliedFilter
        || JSON.stringify(lastSourceStatus).length >= JSON.stringify(lastAppliedFilter).length
      )) {
        result.sourceStatusSummary.pop();
        result.sourceStatusesTruncated = true;
        continue;
      }
      if (lastAppliedFilter) {
        result.appliedFilters.pop();
        result.appliedFiltersTruncated = true;
        continue;
      }
      break;
    }
    return result;
  }

  private setAgentToolActive(active: boolean): void {
    this.agentToolActive = active;
    this.syncAgentFormVisualState();
  }

  private syncAgentFormVisualState(): void {
    const pendingInvocation = this.pendingAgentInvocation;
    const form = pendingInvocation?.form
      ?? this.content.querySelector<HTMLFormElement>('[data-procurement-filters]');
    if (!form) return;
    const pending = pendingInvocation !== null;
    form.classList.toggle('webmcp-tool-active', this.agentToolActive || pending);
    form.classList.toggle('webmcp-request-pending', pending);
    form.setAttribute('aria-busy', String(this.loading));
    for (const control of form.querySelectorAll<HTMLElement>('input, select, button')) {
      if (pending && !control.matches('[data-procurement-reset]')) control.setAttribute('aria-disabled', 'true');
      else control.removeAttribute('aria-disabled');
    }
  }

  private syncDeclarativeToolStateAfterSettlement(settlingForm: HTMLFormElement): void {
    // Let the browser observe the respondWith() promise settlement before any
    // unavailable/loading transition removes registration attributes.
    this.deferAfterAgentSettlement(() => {
      if (this.settlingAgentForm === settlingForm) this.settlingAgentForm = null;
      if (this.pendingAgentInvocation !== null) return;
      const form = this.content.querySelector<HTMLFormElement>('[data-procurement-filters]');
      if (form) this.syncRenderedFilters(form, true);
      this.syncDeclarativeToolState();
    });
  }

  private renderAgentTerminalResult(): boolean {
    const form = this.pendingAgentInvocation?.form;
    const results = this.content.querySelector<HTMLElement>('[data-procurement-results]');
    if (
      !form
      || !results
      || !form.isConnected
      || !results.isConnected
      || !this.content.contains(form)
    ) return false;

    this.syncRenderedFilters(form, false);
    form.setAttribute('aria-busy', 'false');
    setTrustedHtml(results, trustedHtml(this.renderResultsMarkup(), 'escaped global procurement terminal results'));
    return true;
  }

  private renderAgentTerminalError(message: string): void {
    const results = this.content.querySelector<HTMLElement>('[data-procurement-results]');
    const form = this.pendingAgentInvocation?.form;
    form?.setAttribute('aria-busy', 'false');
    if (!results) return;
    setTrustedHtml(results, trustedHtml(
      `<div class="economic-warning">${escapeHtml(message)}</div>`,
      'escaped global procurement terminal error',
    ));
  }

  private syncRenderedFilters(form: HTMLFormElement, updateDefaults: boolean): void {
    const query = form.elements.namedItem('query') as HTMLInputElement | null;
    const buyer = form.elements.namedItem('buyer') as HTMLInputElement | null;
    const country = form.elements.namedItem('country') as HTMLInputElement | null;
    const source = form.elements.namedItem('source') as HTMLSelectElement | null;
    const sort = form.elements.namedItem('sort') as HTMLSelectElement | null;
    const techRelevant = form.elements.namedItem('techRelevant') as HTMLInputElement | null;
    if (query) {
      query.value = String(this.filters.query || '');
      if (updateDefaults) query.defaultValue = query.value;
    }
    if (buyer) {
      buyer.value = String(this.filters.buyer || '');
      if (updateDefaults) buyer.defaultValue = buyer.value;
    }
    if (country) {
      country.value = String(this.filters.country || '');
      if (updateDefaults) country.defaultValue = country.value;
    }
    if (source) {
      source.value = String(this.filters.source || '');
      if (updateDefaults) {
        for (const option of source.options) option.defaultSelected = option.selected;
      }
    }
    if (sort) {
      sort.value = String(this.filters.sort || 'closing_soon');
      if (updateDefaults) {
        for (const option of sort.options) option.defaultSelected = option.selected;
      }
    }
    if (techRelevant) {
      techRelevant.checked = (this.filters.minAutomationScore || 0) > 0;
      if (updateDefaults) techRelevant.defaultChecked = techRelevant.checked;
    }
  }

  private guardPendingFormInteraction(event: Event): void {
    const pending = this.pendingAgentInvocation;
    const target = event.target instanceof Element ? event.target : null;
    if (!pending || !target || !pending.form.contains(target)) return;
    if (event instanceof KeyboardEvent && event.key === 'Tab') return;
    if (target.closest('[data-procurement-reset]')) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  private restorePendingFormValues(event: Event): void {
    const pending = this.pendingAgentInvocation;
    const target = event.target instanceof Element ? event.target : null;
    if (!pending || !target || !pending.form.contains(target)) return;
    event.stopImmediatePropagation();
    this.syncRenderedFilters(pending.form, false);
  }

  private syncDeclarativeToolState(): void {
    if (this.pendingAgentInvocation !== null || this.settlingAgentForm !== null) {
      this.syncAgentFormVisualState();
      return;
    }
    const form = this.content.querySelector<HTMLFormElement>('[data-procurement-filters]');
    if (!form) return;
    if (this.canDeclareTool()) {
      form.setAttribute('toolname', WEBMCP_PROCUREMENT_TOOL_NAME);
      form.setAttribute('tooldescription', DECLARATIVE_TOOL_DESCRIPTION);
      form.setAttribute('toolautosubmit', '');
    } else {
      form.removeAttribute('toolname');
      form.removeAttribute('tooldescription');
      form.removeAttribute('toolautosubmit');
    }
    this.syncAgentFormVisualState();
  }

  private removeDeclarativeToolAttributes(): void {
    if (this.settlingAgentForm !== null) return;
    const form = this.content.querySelector<HTMLFormElement>('[data-procurement-filters]');
    if (!form) return;
    form.removeAttribute('toolname');
    form.removeAttribute('tooldescription');
    form.removeAttribute('toolautosubmit');
    form.classList.remove('webmcp-tool-active', 'webmcp-request-pending');
    form.setAttribute('aria-busy', String(this.loading));
    for (const control of form.querySelectorAll<HTMLElement>('input, select, button')) {
      control.removeAttribute('aria-disabled');
    }
  }

  private handlePanelVisibilityChange(): void {
    if (this.disposed) return;
    if (!this.isPanelToolVisible()) {
      if (this.pendingAgentInvocation !== null) this.cancelForUnavailablePanel();
      else this.removeDeclarativeToolAttributes();
      return;
    }
    this.syncDeclarativeToolState();
  }

  private deferAfterAgentSettlement(callback: () => void): void {
    // Blink attaches its respondWith() reaction after the submit dispatch
    // returns. A task boundary guarantees that reaction observes the fulfilled
    // result before registration attributes or the declaring form can change.
    setTimeout(callback, 0);
  }

  private abortActiveRequest(restoreFilters = false): boolean {
    const controller = this.activeRequestController;
    this.activeRequestController = null;
    const previousFilters = this.activeRequestPreviousFilters;
    this.activeRequestPreviousFilters = null;
    const restoredFilters = restoreFilters && previousFilters !== null;
    if (restoredFilters) this.filters = { ...previousFilters };
    controller?.abort();
    return restoredFilters;
  }

  private cancelForUnavailablePanel(): void {
    const wasLoading = this.loading;
    const pending = this.pendingAgentInvocation;
    const restoredRequestFilters = this.abortActiveRequest(true);
    this.loading = false;
    if (wasLoading || restoredRequestFilters || pending !== null) this.contentRevision += 1;
    if (pending) {
      this.filters = { ...pending.previousFilters };
      this.failAgentInvocation(pending.id, new RetryableProcurementSearchError(
        'panel_unavailable',
        'The procurement panel became unavailable before the search completed. Retry after it is restored.',
      ));
      this.agentToolActive = false;
      return;
    }
    this.agentToolActive = false;
    if (restoredRequestFilters && this.settlingAgentForm === null && !this.disposed) this.render();
    this.removeDeclarativeToolAttributes();
  }

  private cancelAgentOperation(): void {
    const pending = this.pendingAgentInvocation;
    this.setAgentToolActive(false);
    if (!pending) return;
    const contentRevision = ++this.contentRevision;
    this.abortActiveRequest();
    this.loading = false;
    this.filters = { ...pending.previousFilters };
    this.syncRenderedFilters(pending.form, false);
    this.failAgentInvocation(pending.id, new RetryableProcurementSearchError(
      'canceled',
      'The procurement search was canceled before it completed. Retry if results are still needed.',
    ));
    this.deferAfterAgentSettlement(() => {
      if (
        this.pendingAgentInvocation === null
        && this.settlingAgentForm === null
        && this.data
        && !this.isLocked
        && !this.disposed
        && this.contentRevision === contentRevision
      ) this.render();
    });
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
