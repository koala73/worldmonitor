import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  GlobalProcurementPanel,
  type ProcurementSearchToolResult,
} from '@/components/GlobalProcurementPanel';
import type { ListGlobalTendersResponse, TenderSourceStatus } from '@/generated/client/worldmonitor/economic/v1/service_client';
import type { GlobalTenderFilters } from '@/services/global-tenders';
import { PanelGateReason } from '@/services/panel-gating';

import { initTestI18n } from './helpers/i18n.mts';

const CONTENT_DEBOUNCE_MS = 150;
const DESKTOP_VIEWPORT_WIDTH = 1024;

type TestRequestHandler = (
  filters: GlobalTenderFilters,
  append: boolean,
  signal: AbortSignal,
) => void | Promise<void>;

function sourceStatus(index = 0, overrides: Partial<TenderSourceStatus> = {}): TenderSourceStatus {
  return {
    source: `source-${index}`,
    state: 'ok',
    recordCount: index + 1,
    fetchedAt: '2026-08-18T12:00:00.000Z',
    lastSuccessfulAt: '2026-08-18T12:00:00.000Z',
    stale: false,
    paced: false,
    ...overrides,
  };
}

function response(overrides: Partial<ListGlobalTendersResponse> = {}): ListGlobalTendersResponse {
  return {
    tenders: [],
    nextCursor: '',
    fetchedAt: '2026-08-18T12:00:00.000Z',
    dataAvailable: true,
    availability: 'available',
    sourceStatuses: [sourceStatus()],
    total: 0,
    appliedFilters: [],
    countryCoverage: 'not_requested',
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function form(panel: GlobalProcurementPanel): HTMLFormElement {
  const element = panel.getElement().querySelector<HTMLFormElement>('[data-procurement-filters]');
  if (!element) throw new Error('procurement form missing');
  return element;
}

function commitResponse(panel: GlobalProcurementPanel, data = response()): void {
  panel.update(data);
  vi.advanceTimersByTime(CONTENT_DEBOUNCE_MS);
}

function dispatchAgentSubmit(element: HTMLFormElement): {
  event: Event;
  response: Promise<ProcurementSearchToolResult>;
} {
  let agentResponse: Promise<ProcurementSearchToolResult> | undefined;
  const event = new Event('submit', { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    agentInvoked: { value: true },
    respondWith: {
      value: (pending: Promise<ProcurementSearchToolResult>) => {
        agentResponse = pending;
      },
    },
  });
  element.dispatchEvent(event);
  if (!agentResponse) throw new Error('respondWith was not called');
  return { event, response: agentResponse };
}

function dispatchToolEvent(type: string, toolName = 'search_procurement'): void {
  const event = new Event(type);
  Object.defineProperty(event, 'toolName', { value: toolName });
  window.dispatchEvent(event);
}

function resizeTo(width: number): void {
  Object.defineProperty(window, 'innerWidth', {
    configurable: true,
    value: width,
  });
  window.dispatchEvent(new Event('resize'));
}

async function expectRetryableFailure(
  promise: Promise<ProcurementSearchToolResult>,
  code: string,
) {
  const [settlement] = await Promise.allSettled([promise]);
  expect(settlement?.status).toBe('fulfilled');
  if (!settlement || settlement.status !== 'fulfilled') {
    throw new Error(`Expected ${code} to resolve as a structured tool result`);
  }
  expect(settlement.value).toMatchObject({ ok: false, code, retryable: true });
  expect(JSON.parse(JSON.stringify(settlement.value))).toEqual(settlement.value);
  if (settlement.value.ok) throw new Error(`Expected ${code} failure result`);
  return settlement.value;
}

function expectSignalAborted(signal: AbortSignal | null): void {
  expect(signal).not.toBeNull();
  if (!signal) throw new Error('Expected the request handler to receive an AbortSignal');
  expect(signal.aborted).toBe(true);
}

beforeAll(async () => {
  await initTestI18n();
});

describe('GlobalProcurementPanel declarative WebMCP tool', () => {
  let panels: GlobalProcurementPanel[];

  beforeEach(() => {
    vi.useFakeTimers();
    resizeTo(DESKTOP_VIEWPORT_WIDTH);
    panels = [];
  });

  afterEach(() => {
    for (const panel of panels) panel.destroy();
    vi.advanceTimersByTime(0);
    document.body.innerHTML = '';
    resizeTo(DESKTOP_VIEWPORT_WIDTH);
    vi.useRealTimers();
  });

  function mount(handler?: TestRequestHandler): GlobalProcurementPanel {
    const panel = new GlobalProcurementPanel();
    panels.push(panel);
    if (handler) panel.setRequestHandler(handler);
    document.body.appendChild(panel.getElement());
    return panel;
  }

  it('declares exactly one bounded read-only search form with the human filter contract', () => {
    const panel = mount(() => undefined);
    commitResponse(panel);

    const tools = panel.getElement().querySelectorAll<HTMLFormElement>('form[toolname]');
    expect(tools).toHaveLength(1);
    expect(tools[0]?.getAttribute('toolname')).toBe('search_procurement');
    expect(tools[0]?.getAttribute('tooldescription')).toBe(
      'Search official global procurement opportunities using visible filters.',
    );
    expect(tools[0]?.hasAttribute('toolautosubmit')).toBe(true);

    const parameterControls = tools[0]?.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[toolparamdescription]');
    expect(parameterControls).toHaveLength(6);
    expect([...parameterControls!].map((control) => control.name)).toEqual([
      'query',
      'buyer',
      'country',
      'source',
      'sort',
      'techRelevant',
    ]);
    expect([...parameterControls!].every((control) => !control.required)).toBe(true);

    const query = tools[0]?.elements.namedItem('query') as HTMLInputElement;
    const buyer = tools[0]?.elements.namedItem('buyer') as HTMLInputElement;
    expect(query.maxLength).toBe(160);
    expect(buyer.maxLength).toBe(160);
    const country = tools[0]?.elements.namedItem('country') as HTMLInputElement;
    expect(country.minLength).toBe(2);
    expect(country.maxLength).toBe(2);
    expect(country.pattern).toBe('^[A-Za-z]{2}$');
    expect(country.getAttribute('toolparamdescription')).toContain('ISO 3166-1 alpha-2');
    const technologyRelevant = tools[0]?.elements.namedItem('techRelevant') as HTMLInputElement;
    expect(technologyRelevant.type).toBe('checkbox');

    const source = tools[0]?.elements.namedItem('source') as HTMLSelectElement;
    expect([...source.options].map((option) => [option.value, option.textContent])).toEqual([
      ['', 'All sources'],
      ['sam', 'SAM.gov'],
      ['ted', 'TED'],
      ['contracts-finder', 'Contracts Finder'],
      ['canada-buys', 'CanadaBuys'],
      ['gets', 'GETS'],
      ['world-bank', 'World Bank'],
    ]);
    const sort = tools[0]?.elements.namedItem('sort') as HTMLSelectElement;
    expect([...sort.options].map((option) => option.value)).toEqual([
      'closing_soon',
      'newest',
      'estimated_value',
      'relevance',
    ]);
  });

  it('rejects invalid programmatic filter values before starting a request', async () => {
    const handler = vi.fn(() => new Promise<void>(() => undefined));
    const panel = mount(handler);
    commitResponse(panel);
    const currentForm = form(panel);
    const query = currentForm.elements.namedItem('query') as HTMLInputElement;
    const buyer = currentForm.elements.namedItem('buyer') as HTMLInputElement;
    const country = currentForm.elements.namedItem('country') as HTMLInputElement;

    const invalidValues = [
      () => { query.value = 'q'.repeat(161); },
      () => { query.value = '\ud83d\ude80'.repeat(81); },
      () => { buyer.value = 'b'.repeat(161); },
      () => { country.value = 'C'; },
      () => { country.value = 'CAN'; },
      () => { country.value = 'C1'; },
      () => { country.value = '\u00c7A'; },
    ];
    for (const setInvalidValue of invalidValues) {
      query.value = '';
      buyer.value = '';
      country.value = '';
      setInvalidValue();
      const invocation = dispatchAgentSubmit(currentForm);
      await expectRetryableFailure(invocation.response, 'invalid_arguments');
    }
    expect(handler).not.toHaveBeenCalled();

    country.value = 'CAN';
    currentForm.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    expect(handler).not.toHaveBeenCalled();

    query.value = 'q'.repeat(160);
    buyer.value = 'b'.repeat(160);
    country.value = 'ca';
    const validInvocation = dispatchAgentSubmit(currentForm);
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({
      query: 'q'.repeat(160),
      buyer: 'b'.repeat(160),
      country: 'CA',
    }), false, expect.any(AbortSignal));
    panel.update(response({ total: 1 }));
    await expect(validInvocation.response).resolves.toMatchObject({ ok: true, matchCount: 1 });
  });

  it('rejects injected source and sort options before starting a request', async () => {
    const handler = vi.fn(() => { throw new Error('off-enum filters must not start a request'); });
    const panel = mount(handler);
    commitResponse(panel);
    const currentForm = form(panel);
    const source = currentForm.elements.namedItem('source') as HTMLSelectElement;
    const sort = currentForm.elements.namedItem('sort') as HTMLSelectElement;

    for (const select of [source, sort]) {
      const injected = document.createElement('option');
      injected.value = 'injected-off-enum-value';
      select.appendChild(injected);
      select.value = injected.value;
      const invocation = dispatchAgentSubmit(currentForm);
      await expectRetryableFailure(invocation.response, 'invalid_arguments');
      injected.remove();
    }

    expect(handler).not.toHaveBeenCalled();
  });

  it('withholds the tool when the form is unusable, hidden, gated, unavailable, or destroyed', () => {
    const unmountedPanel = new GlobalProcurementPanel();
    panels.push(unmountedPanel);
    unmountedPanel.setRequestHandler(() => undefined);
    commitResponse(unmountedPanel);
    expect(form(unmountedPanel).hasAttribute('toolname')).toBe(false);
    document.body.appendChild(unmountedPanel.getElement());
    unmountedPanel.notifyConnected();
    expect(form(unmountedPanel).getAttribute('toolname')).toBe('search_procurement');

    const panel = mount();
    commitResponse(panel);
    expect(form(panel).hasAttribute('toolname')).toBe(false);

    panel.setRequestHandler(() => undefined);
    expect(form(panel).getAttribute('toolname')).toBe('search_procurement');

    panel.setLoading(true);
    expect(form(panel).hasAttribute('toolname')).toBe(false);
    expect(form(panel).getAttribute('aria-busy')).toBe('true');
    commitResponse(panel);
    expect(form(panel).getAttribute('toolname')).toBe('search_procurement');

    panel.update(response({ dataAvailable: false, availability: 'unavailable' }));
    expect(form(panel).hasAttribute('toolname')).toBe(false);
    vi.advanceTimersByTime(CONTENT_DEBOUNCE_MS);
    expect(form(panel).hasAttribute('toolname')).toBe(false);

    commitResponse(panel);
    panel.hide();
    expect(form(panel).hasAttribute('toolname')).toBe(false);
    panel.show();
    expect(form(panel).getAttribute('toolname')).toBe('search_procurement');
    vi.advanceTimersByTime(CONTENT_DEBOUNCE_MS);

    panel.showGatedCta(PanelGateReason.FREE_TIER, () => undefined);
    expect(panel.getElement().querySelector('form[toolname]')).toBeNull();
    panel.unlockPanel();
    expect(form(panel).getAttribute('toolname')).toBe('search_procurement');
    expect(form(panel).hasAttribute('toolautosubmit')).toBe(true);

    const destroyPanel = mount(() => undefined);
    commitResponse(destroyPanel);
    const destroyedForm = form(destroyPanel);
    destroyPanel.destroy();
    panels = panels.filter((candidate) => candidate !== destroyPanel);
    expect(destroyedForm.hasAttribute('toolname')).toBe(false);
  });

  it('fails closed when a stale agent submit targets an unavailable or detached form', async () => {
    const handler = vi.fn(() => undefined);
    const panel = mount(handler);
    commitResponse(panel, response({ dataAvailable: false, availability: 'unavailable' }));
    const unavailableForm = form(panel);
    expect(unavailableForm.hasAttribute('toolname')).toBe(false);

    const unavailableInvocation = dispatchAgentSubmit(unavailableForm);
    await expectRetryableFailure(unavailableInvocation.response, 'panel_unavailable');
    expect(handler).not.toHaveBeenCalled();

    commitResponse(panel);
    const detachedForm = form(panel);
    expect(detachedForm.getAttribute('toolname')).toBe('search_procurement');
    panel.getElement().remove();

    const detachedInvocation = dispatchAgentSubmit(detachedForm);
    await expectRetryableFailure(detachedInvocation.response, 'panel_unavailable');
    expect(handler).not.toHaveBeenCalled();
  });

  it('withholds mobile-category-hidden tools and restores the lingering class on desktop', async () => {
    let requestSignal: AbortSignal | null = null;
    const handler = vi.fn((_filters: GlobalTenderFilters, _append: boolean, signal: AbortSignal) => {
      requestSignal = signal;
      return new Promise<void>(() => undefined);
    });
    const panel = mount(handler);
    commitResponse(panel);
    const currentForm = form(panel);

    resizeTo(480);
    panel.getElement().classList.add('mobile-cat-hidden');
    window.dispatchEvent(new Event('resize'));
    expect(currentForm.hasAttribute('toolname')).toBe(false);

    // A stale browser-side descriptor must still fail closed at use time.
    const staleInvocation = dispatchAgentSubmit(currentForm);
    await expectRetryableFailure(staleInvocation.response, 'panel_unavailable');
    expect(handler).not.toHaveBeenCalled();
    vi.advanceTimersByTime(0);

    resizeTo(DESKTOP_VIEWPORT_WIDTH);
    expect(panel.getElement().classList.contains('mobile-cat-hidden')).toBe(true);
    expect(currentForm.getAttribute('toolname')).toBe('search_procurement');
    expect(currentForm.hasAttribute('toolautosubmit')).toBe(true);

    const pendingInvocation = dispatchAgentSubmit(currentForm);
    resizeTo(480);
    await expectRetryableFailure(pendingInvocation.response, 'panel_unavailable');
    expectSignalAborted(requestSignal);
    expect(currentForm.isConnected).toBe(true);
    expect(currentForm.getAttribute('toolname')).toBe('search_procurement');
    vi.advanceTimersByTime(0);
    expect(currentForm.hasAttribute('toolname')).toBe(false);

    resizeTo(DESKTOP_VIEWPORT_WIDTH);
    expect(currentForm.getAttribute('toolname')).toBe('search_procurement');
  });

  it('preserves the declaring form until visible results update and returns only a bounded terminal summary', async () => {
    const requestCompletion = deferred<void>();
    const handler = vi.fn(() => requestCompletion.promise);
    const panel = mount(handler);
    commitResponse(panel);

    const currentForm = form(panel);
    const currentResults = panel.getElement().querySelector<HTMLElement>('[data-procurement-results]');
    expect(currentResults).not.toBeNull();
    (currentForm.elements.namedItem('query') as HTMLInputElement).value = 'cloud';
    (currentForm.elements.namedItem('buyer') as HTMLInputElement).value = 'Ministry';
    (currentForm.elements.namedItem('country') as HTMLInputElement).value = 'us';
    (currentForm.elements.namedItem('source') as HTMLSelectElement).value = 'sam';
    (currentForm.elements.namedItem('sort') as HTMLSelectElement).value = 'relevance';
    (currentForm.elements.namedItem('techRelevant') as HTMLInputElement).checked = true;

    dispatchToolEvent('toolactivated');
    expect(currentForm.classList.contains('webmcp-tool-active')).toBe(true);
    const invocation = dispatchAgentSubmit(currentForm);
    expect(invocation.event.defaultPrevented).toBe(true);
    expect(handler).toHaveBeenCalledWith({
      query: 'cloud',
      buyer: 'Ministry',
      country: 'US',
      source: 'sam',
      sort: 'relevance',
      pageSize: 25,
      cursor: '',
      minAutomationScore: 30,
    }, false, expect.any(AbortSignal));

    // The production DataLoader re-enters loadGlobalTenders() and installs its
    // panel handler again before the request reaches the first await. That
    // setter must not unregister the exact form backing respondWith().
    panel.setRequestHandler(handler);
    expect(currentForm.getAttribute('toolname')).toBe('search_procurement');
    expect(currentForm.getAttribute('tooldescription')).toBe(
      'Search official global procurement opportunities using visible filters.',
    );
    expect(currentForm.hasAttribute('toolautosubmit')).toBe(true);
    expect(currentForm.classList.contains('webmcp-request-pending')).toBe(true);
    expect([...currentForm.elements].filter((control) => !control.matches('[data-procurement-reset]'))
      .every((control) => control.getAttribute('aria-disabled') === 'true')).toBe(true);
    expect(currentForm.querySelector('[data-procurement-reset]')?.hasAttribute('aria-disabled')).toBe(false);
    expect([...currentForm.elements].every((control) => !control.hasAttribute('disabled'))).toBe(true);

    let settled = false;
    let formAtSettlement: HTMLFormElement | null = null;
    void invocation.response.then(() => {
      settled = true;
      formAtSettlement = form(panel);
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(form(panel)).toBe(currentForm);
    expect(currentForm.getAttribute('aria-busy')).toBe('true');

    vi.advanceTimersByTime(CONTENT_DEBOUNCE_MS);
    expect(form(panel)).toBe(currentForm);

    // Programmatic input and keyboard submission can bypass pointer styling.
    // Preserve the filters owned by the active agent request.
    (currentForm.elements.namedItem('query') as HTMLInputElement).value = 'roads';
    (currentForm.elements.namedItem('query') as HTMLInputElement).dispatchEvent(
      new Event('input', { bubbles: true, cancelable: true }),
    );
    expect((currentForm.elements.namedItem('query') as HTMLInputElement).value).toBe('cloud');
    currentForm.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    expect(handler).toHaveBeenCalledTimes(1);

    const competingInvocation = dispatchAgentSubmit(currentForm);
    await expectRetryableFailure(competingInvocation.response, 'request_in_progress');
    expect(handler).toHaveBeenCalledTimes(1);

    panel.update(response({
      tenders: [{
        id: 'secret-tender',
        source: 'sam',
        sourceNoticeId: 'secret-tender',
        officialUrl: 'https://example.test/secret-tender',
        title: 'Sensitive tender title',
        description: 'Sensitive tender content must not enter the tool response.',
        status: 'open',
        categoryCodes: [],
        sectors: [],
        eligibilityRequirements: [],
        submissionUrls: [],
        participationMode: 'unknown',
      }],
      availability: 'partial',
      total: 42,
      countryCoverage: 'observed',
      appliedFilters: ['country', 'source', 'query', 'buyer', 'min_automation_score'],
      sourceStatuses: Array.from({ length: 10 }, (_, index) => sourceStatus(index, {
        state: index === 1 ? 'error' : 'ok',
      })),
    }));
    expect(form(panel)).toBe(currentForm);
    expect(panel.getElement().querySelector('[data-procurement-results]')).toBe(currentResults);
    expect(panel.getElement().textContent).toContain('Showing 1 of 42 matching opportunities');
    // The old debounced full-form render landed here and canceled Blink's
    // invocation. The exact declaring node must survive that historical window.
    vi.advanceTimersByTime(CONTENT_DEBOUNCE_MS);
    expect(form(panel)).toBe(currentForm);
    requestCompletion.resolve();

    const result = await invocation.response;
    expect(result).toEqual({
      ok: true,
      matchCount: 42,
      availability: 'partial',
      countryCoverage: 'observed',
      appliedFilters: ['country', 'source', 'query', 'buyer', 'min_automation_score'],
      appliedFiltersTruncated: false,
      sourceStatusSummary: Array.from({ length: 8 }, (_, index) => ({
        source: `source-${index}`,
        state: index === 1 ? 'error' : 'ok',
        recordCount: index + 1,
      })),
      sourceStatusesTruncated: true,
    });
    expect(JSON.stringify(result)).not.toContain('Sensitive tender');
    expect(settled).toBe(true);
    expect(formAtSettlement).toBe(currentForm);
    expect(form(panel)).toBe(currentForm);
    expect((form(panel).elements.namedItem('query') as HTMLInputElement).value).toBe('cloud');
    expect((form(panel).elements.namedItem('country') as HTMLInputElement).value).toBe('US');
    expect(form(panel).classList.contains('webmcp-tool-active')).toBe(false);
    expect(form(panel).classList.contains('webmcp-request-pending')).toBe(false);
    expect([...form(panel).elements].every((control) => !control.hasAttribute('aria-disabled'))).toBe(true);
  });

  it('defers synchronous terminal cleanup until the response promise is observable', async () => {
    let panel!: GlobalProcurementPanel;
    panel = mount(() => panel.clear());
    commitResponse(panel);
    const currentForm = form(panel);
    const invocation = dispatchAgentSubmit(currentForm);
    let formAtSettlement: HTMLFormElement | null = null;
    void invocation.response.then(() => {
      formAtSettlement = currentForm.isConnected ? currentForm : null;
    });
    panel.update(response({ total: 7 }));

    await expectRetryableFailure(invocation.response, 'panel_unavailable');
    expect(formAtSettlement).toBe(currentForm);
    expect(currentForm.isConnected).toBe(true);
    expect(currentForm.getAttribute('toolname')).toBe('search_procurement');

    vi.advanceTimersByTime(0);
    expect(currentForm.isConnected).toBe(false);
    expect(panel.getElement().textContent).toContain('Showing 0 of 7 matching opportunities');
  });

  it('does not let a same-turn gate preserve content cleared during settlement', async () => {
    const sensitiveTitle = 'Sensitive procurement result that must stay cleared';
    const panel = mount(() => new Promise<void>(() => undefined));
    commitResponse(panel, response({
      tenders: [{
        id: 'sensitive-result',
        source: 'sam',
        sourceNoticeId: 'sensitive-result',
        officialUrl: '',
        title: sensitiveTitle,
        description: '',
        status: 'open',
        categoryCodes: [],
        sectors: [],
        eligibilityRequirements: [],
        submissionUrls: [],
        participationMode: 'unknown',
      }],
      total: 1,
    }));
    expect(panel.getElement().textContent).toContain(sensitiveTitle);

    const invocation = dispatchAgentSubmit(form(panel));
    panel.clear();
    panel.showGatedCta(PanelGateReason.FREE_TIER, () => undefined);

    await expectRetryableFailure(invocation.response, 'panel_unavailable');
    vi.advanceTimersByTime(0);
    panel.unlockPanel();

    expect(panel.getElement().textContent).not.toContain(sensitiveTitle);
  });

  it('defers a superseding refresh repaint until the agent failure is observable', async () => {
    const panel = mount(() => new Promise<void>(() => undefined));
    commitResponse(panel);
    const currentForm = form(panel);
    const invocation = dispatchAgentSubmit(currentForm);
    let formAtSettlement: HTMLFormElement | null = null;
    void invocation.response.then(() => {
      formAtSettlement = currentForm.isConnected ? currentForm : null;
    });

    panel.setLoading(true);
    await expectRetryableFailure(invocation.response, 'superseded');
    expect(formAtSettlement).toBe(currentForm);
    expect(currentForm.isConnected).toBe(true);

    vi.advanceTimersByTime(0);
    expect(currentForm.isConnected).toBe(false);
  });

  it('preserves the declaring form across a same-turn hide and show', async () => {
    const panel = mount(() => new Promise<void>(() => undefined));
    commitResponse(panel);
    const currentForm = form(panel);
    const invocation = dispatchAgentSubmit(currentForm);
    let formAtSettlement: HTMLFormElement | null = null;
    void invocation.response.then(() => {
      formAtSettlement = currentForm.isConnected ? currentForm : null;
    });

    panel.hide();
    panel.show();

    await expectRetryableFailure(invocation.response, 'panel_unavailable');
    expect(formAtSettlement).toBe(currentForm);
    expect(form(panel)).toBe(currentForm);
    expect(currentForm.isConnected).toBe(true);

    vi.advanceTimersByTime(0);
    expect(form(panel)).toBe(currentForm);
    expect(currentForm.getAttribute('toolname')).toBe('search_procurement');
  });

  it('renders the latest settled data after same-turn visibility changes', async () => {
    const panel = mount(() => new Promise<void>(() => undefined));
    commitResponse(panel);
    const invocation = dispatchAgentSubmit(form(panel));

    panel.update(response({ total: 1 }));
    panel.update(response({ total: 2 }));
    panel.hide();
    panel.show();

    const result = await invocation.response;
    expect(result).toMatchObject({ ok: true, matchCount: 1 });
    expect(panel.getElement().textContent).toContain('Showing 0 of 1 matching opportunities');

    vi.advanceTimersByTime(0);
    expect(panel.getElement().textContent).toContain('Showing 0 of 2 matching opportunities');
  });

  it('invalidates a deferred gate when access is restored in the same tick', async () => {
    const panel = mount(() => new Promise<void>(() => undefined));
    commitResponse(panel);
    const currentForm = form(panel);
    const invocation = dispatchAgentSubmit(currentForm);

    panel.showGatedCta(PanelGateReason.FREE_TIER, () => undefined);
    panel.unlockPanel();
    await expectRetryableFailure(invocation.response, 'panel_unavailable');
    vi.advanceTimersByTime(0);

    expect(panel.getElement().classList.contains('panel-is-locked')).toBe(false);
    expect(currentForm.isConnected).toBe(true);
    expect(currentForm.getAttribute('toolname')).toBe('search_procurement');
  });

  it('always completes base teardown after a pending invocation settles', async () => {
    const panel = mount(() => new Promise<void>(() => undefined));
    commitResponse(panel);
    const lifecycleSignal = (panel as unknown as { signal: AbortSignal }).signal;
    const invocation = dispatchAgentSubmit(form(panel));

    panel.destroy();
    panel.showGatedCta(PanelGateReason.FREE_TIER, () => undefined);
    panel.unlockPanel();

    await expectRetryableFailure(invocation.response, 'panel_unavailable');
    expect(lifecycleSignal.aborted).toBe(false);
    vi.advanceTimersByTime(0);
    expect(lifecycleSignal.aborted).toBe(true);
  });

  it('preserves unknown country coverage on zero results and bounds applied filter names', async () => {
    const panel = mount(() => new Promise<void>(() => undefined));
    commitResponse(panel);

    const invocation = dispatchAgentSubmit(form(panel));
    const appliedFilters = [
      'country',
      ...Array.from({ length: 19 }, (_, index) => `filter-${index}-${'x'.repeat(40)}`),
    ];
    panel.update(response({
      total: 0,
      countryCoverage: 'unknown',
      appliedFilters,
    }));

    const result = await invocation.response;
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('Expected a successful zero-result summary');
    expect(result.matchCount).toBe(0);
    expect(result.countryCoverage).toBe('unknown');
    expect(result.appliedFilters).toHaveLength(16);
    expect(result.appliedFilters[0]).toBe('country');
    expect(result.appliedFilters.every((filter) => filter.length <= 32)).toBe(true);
    expect(result.appliedFiltersTruncated).toBe(true);
  });

  it('keeps the complete serialized tool result within the WebMCP response budget', async () => {
    const panel = mount(() => new Promise<void>(() => undefined));
    commitResponse(panel);
    const invocation = dispatchAgentSubmit(form(panel));
    const escapedText = String.fromCharCode(0).repeat(64);

    panel.update(response({
      total: Number.MAX_SAFE_INTEGER,
      availability: escapedText,
      appliedFilters: Array.from({ length: 16 }, () => escapedText),
      sourceStatuses: Array.from({ length: 8 }, (_, index) => sourceStatus(index, {
        source: escapedText,
        state: escapedText,
      })),
    }));

    const result = await invocation.response;
    expect(result.ok).toBe(true);
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(1_500);
    if (!result.ok) throw new Error('Expected a bounded success result');
    expect(result.appliedFiltersTruncated || result.sourceStatusesTruncated).toBe(true);
  });

  it('resolves cancellation and never lets a late request answer the canceled invocation', async () => {
    const requestCompletion = deferred<void>();
    let requestSignal: AbortSignal | null = null;
    let lateUpdateApplied = false;
    let panel!: GlobalProcurementPanel;
    panel = mount((_filters, _append, signal) => {
      requestSignal = signal;
      return requestCompletion.promise.then(() => {
        if (signal.aborted) return;
        lateUpdateApplied = true;
        panel.update(response({ total: 99 }));
      });
    });
    commitResponse(panel);

    const invocation = dispatchAgentSubmit(form(panel));
    dispatchToolEvent('toolcancel');
    await expectRetryableFailure(invocation.response, 'canceled');
    expectSignalAborted(requestSignal);

    requestCompletion.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(lateUpdateApplied).toBe(false);
    expect(panel.getElement().textContent).not.toContain('99 matching opportunities');
    expect(form(panel).classList.contains('webmcp-tool-active')).toBe(false);
    expect(form(panel).getAttribute('toolname')).toBe('search_procurement');
  });

  it('guards pending controls while keeping Reset available to abort the request', async () => {
    const requestCompletion = deferred<void>();
    let requestSignal: AbortSignal | null = null;
    const panel = mount((_filters, _append, signal) => {
      requestSignal = signal;
      return requestCompletion.promise;
    });
    commitResponse(panel);

    const currentForm = form(panel);
    const query = currentForm.elements.namedItem('query') as HTMLInputElement;
    query.value = 'cloud';
    const invocation = dispatchAgentSubmit(currentForm);

    let mousedownReachedPanel = false;
    panel.getElement().addEventListener('mousedown', () => {
      mousedownReachedPanel = true;
    });
    const mousedown = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    query.dispatchEvent(mousedown);
    expect(mousedown.defaultPrevented).toBe(true);
    expect(mousedownReachedPanel).toBe(false);

    const keydown = new KeyboardEvent('keydown', {
      key: 'x',
      bubbles: true,
      cancelable: true,
    });
    query.dispatchEvent(keydown);
    expect(keydown.defaultPrevented).toBe(true);
    const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    query.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(false);
    query.value = 'tampered';
    query.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
    expect(query.value).toBe('cloud');

    const reset = currentForm.querySelector<HTMLButtonElement>('[data-procurement-reset]');
    expect(reset?.hasAttribute('aria-disabled')).toBe(false);
    reset?.click();

    await expectRetryableFailure(invocation.response, 'canceled');
    expectSignalAborted(requestSignal);
    expect(currentForm.isConnected).toBe(true);
    vi.advanceTimersByTime(0);
    expect(currentForm.isConnected).toBe(false);
    expect((form(panel).elements.namedItem('query') as HTMLInputElement).value).toBe('');

    requestCompletion.resolve();
    await Promise.resolve();
    expect((form(panel).elements.namedItem('query') as HTMLInputElement).value).toBe('');
  });

  it('clears agent activation when the form reset algorithm runs', () => {
    const panel = mount(() => undefined);
    commitResponse(panel);
    const currentForm = form(panel);
    dispatchToolEvent('toolactivated');
    expect(currentForm.classList.contains('webmcp-tool-active')).toBe(true);

    currentForm.reset();
    expect(currentForm.classList.contains('webmcp-tool-active')).toBe(false);
    expect(currentForm.getAttribute('toolname')).toBe('search_procurement');
  });

  it('restores applied filters when lifecycle cancellation aborts a human request', () => {
    let requestSignal: AbortSignal | null = null;
    const panel = mount((_filters, _append, signal) => {
      requestSignal = signal;
      return new Promise<void>(() => undefined);
    });
    commitResponse(panel);
    const currentForm = form(panel);
    (currentForm.elements.namedItem('query') as HTMLInputElement).value = 'roads';
    currentForm.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

    panel.hide();
    panel.show();

    expectSignalAborted(requestSignal);
    expect((form(panel).elements.namedItem('query') as HTMLInputElement).value).toBe('');
    expect(panel.getElement().textContent).toContain('Showing 0 of 0 matching opportunities');
  });

  it('restores human filters before a gate snapshots and later unlocks the form', () => {
    let requestSignal: AbortSignal | null = null;
    const panel = mount((_filters, _append, signal) => {
      requestSignal = signal;
      return new Promise<void>(() => undefined);
    });
    commitResponse(panel);
    const currentForm = form(panel);
    (currentForm.elements.namedItem('query') as HTMLInputElement).value = 'roads';
    currentForm.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

    panel.showGatedCta(PanelGateReason.FREE_TIER, () => undefined);
    expectSignalAborted(requestSignal);
    panel.unlockPanel();

    const restoredForm = form(panel);
    expect((restoredForm.elements.namedItem('query') as HTMLInputElement).value).toBe('');
    expect([...restoredForm.elements].every((control) => !control.hasAttribute('disabled'))).toBe(true);
    expect(restoredForm.getAttribute('toolname')).toBe('search_procurement');
  });

  it('resolves unavailable and non-settling requests as explicit retryable failures', async () => {
    const unavailableCompletion = deferred<void>();
    const unavailablePanel = mount(() => unavailableCompletion.promise);
    commitResponse(unavailablePanel);
    const unavailableInvocation = dispatchAgentSubmit(form(unavailablePanel));
    unavailablePanel.update(response({ dataAvailable: false, availability: 'unavailable' }));
    unavailableCompletion.resolve();
    vi.advanceTimersByTime(CONTENT_DEBOUNCE_MS);
    await expectRetryableFailure(unavailableInvocation.response, 'procurement_unavailable');
    expect(form(unavailablePanel).hasAttribute('toolname')).toBe(false);

    const nonSettlingPanel = mount(async () => undefined);
    commitResponse(nonSettlingPanel);
    const nonSettlingInvocation = dispatchAgentSubmit(form(nonSettlingPanel));
    await expectRetryableFailure(nonSettlingInvocation.response, 'request_did_not_settle');
    vi.advanceTimersByTime(CONTENT_DEBOUNCE_MS);
    expect(form(nonSettlingPanel).getAttribute('toolname')).toBe('search_procurement');
  });

  it('keeps human submit, reset, and load-more behavior on the shared request path', () => {
    const handler = vi.fn(() => new Promise<void>(() => undefined));
    const panel = mount(handler);
    commitResponse(panel, response({ nextCursor: '25', total: 50 }));

    const currentForm = form(panel);
    (currentForm.elements.namedItem('query') as HTMLInputElement).value = 'roads';
    currentForm.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    expect(handler).toHaveBeenLastCalledWith(
      expect.objectContaining({ query: 'roads', cursor: '' }),
      false,
      expect.any(AbortSignal),
    );

    panel.update(response({ nextCursor: '25', total: 50 }));
    vi.advanceTimersByTime(CONTENT_DEBOUNCE_MS);
    panel.getElement().querySelector<HTMLButtonElement>('[data-procurement-load-more]')?.click();
    expect(handler).toHaveBeenLastCalledWith(
      expect.objectContaining({ query: 'roads', cursor: '25' }),
      true,
      expect.any(AbortSignal),
    );

    panel.update(response());
    vi.advanceTimersByTime(CONTENT_DEBOUNCE_MS);
    panel.getElement().querySelector<HTMLButtonElement>('[data-procurement-reset]')?.click();
    expect(handler).toHaveBeenLastCalledWith(expect.objectContaining({
      query: '',
      buyer: '',
      country: '',
      source: '',
      sort: 'closing_soon',
      cursor: '',
      minAutomationScore: 0,
    }), false, expect.any(AbortSignal));
  });
});
