import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { CountryBriefController } from '@/components/CountryBriefController';
import { CountryDeepDivePanel } from '@/components/CountryDeepDivePanel';
import { CountryIntelMemory } from '@/components/CountryIntelMemory';
import type { CountryBriefSource } from '@/services/country-brief-source';
import * as intelHistoryService from '@/services/intel-history';
import type {
  GetIntelTimelineResponse,
  GetSimilarEventsResponse,
  IntelHistoryRecord,
} from '@/services/intel-history';
import * as panelGating from '@/services/panel-gating';
import { initTestI18n } from './helpers/i18n.mts';

beforeAll(async () => {
  await initTestI18n();
});

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

function makeRecord(overrides: Partial<IntelHistoryRecord> = {}): IntelHistoryRecord {
  return {
    id: 'rec-1',
    domain: 'conflict',
    resource: 'acled-events',
    country: 'UA',
    category: 'battle',
    title: 'Artillery exchange reported near eastern front',
    summary: 'Heavy shelling reported overnight along contested positions.',
    sourceUrl: 'https://example.com/report?id=42&ref=feed',
    occurredAt: Date.UTC(2026, 9, 14, 15, 30, 0),
    ingestedAt: Date.UTC(2026, 9, 14, 16, 0, 0),
    score: 0,
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks(turns = 6): Promise<void> {
  for (let i = 0; i < turns; i += 1) {
    await Promise.resolve();
  }
}

describe('CountryIntelMemory', () => {
  it('renders timeline records strictly via textContent and neutralizes hostile HTML and unsafe URLs', async () => {
    const mount = document.createElement('div');
    document.body.append(mount);
    const parentAbort = new AbortController();

    const hostileTitle = '<img src=x onerror=alert(1)> Ceasefire breach';
    const hostileSummary = `<script>alert('xss')</script> ${'A'.repeat(250)}`;

    const fetchTimeline = vi.fn(async (): Promise<GetIntelTimelineResponse> => ({
      records: [
        makeRecord({
          id: 'rec-hostile',
          title: hostileTitle,
          summary: hostileSummary,
          sourceUrl: 'javascript:alert(1)',
        }),
        makeRecord({
          id: 'rec-safe',
          domain: 'energy',
          category: 'pipeline',
          resource: 'energy-rss',
          title: 'Grid substation repair completed',
          summary: 'Transmission restored across two districts.',
          sourceUrl: 'https://example.com/energy?a=1&b=2',
          occurredAt: Date.UTC(2026, 8, 5, 0, 0, 0),
        }),
      ],
      partial: true,
      upstreamUnavailable: false,
      nextCursor: '',
    }));
    const fetchSimilar = vi.fn();

    const component = new CountryIntelMemory(mount, 'ua', parentAbort.signal, {
      fetchTimeline,
      fetchSimilar,
    });
    await flushMicrotasks();

    expect(fetchTimeline).toHaveBeenCalledTimes(1);
    expect(fetchTimeline).toHaveBeenCalledWith(
      { country: 'UA', domain: '', limit: 20, cursor: '' },
      expect.any(AbortSignal),
    );
    expect(fetchSimilar).not.toHaveBeenCalled();

    // Hostile HTML must be plain text — zero injected elements
    expect(mount.querySelectorAll('img')).toHaveLength(0);
    expect(mount.querySelectorAll('script')).toHaveLength(0);

    const items = mount.querySelectorAll('.country-intel-memory-item');
    expect(items).toHaveLength(2);

    const first = items[0]!;
    expect(first.querySelector('.country-intel-memory-date')?.textContent).toBe('2026-10-14');
    expect(first.querySelector('.country-intel-memory-title')?.textContent).toBe(hostileTitle);
    const firstSummary = first.querySelector('.country-intel-memory-summary')?.textContent ?? '';
    expect(firstSummary).toContain("<script>alert('xss')</script>");
    expect(firstSummary.length).toBeLessThanOrEqual(220);
    expect(firstSummary.endsWith('…')).toBe(true);
    // javascript: URL must produce no anchor
    expect(first.querySelector('a')).toBeNull();

    const second = items[1]!;
    expect(second.querySelector('.country-intel-memory-date')?.textContent).toBe('2026-09-05');
    const link = second.querySelector<HTMLAnchorElement>('a.country-intel-memory-source');
    expect(link).not.toBeNull();
    expect(link?.href).toBe('https://example.com/energy?a=1&b=2');
    expect(link?.target).toBe('_blank');
    expect(link?.rel).toBe('noopener noreferrer');

    // Partial coverage banner rendered
    expect(mount.querySelector('.country-intel-memory-notice')?.textContent).toContain('partial');

    component.destroy();
  });

  it('labels records from every history domain on the unfiltered timeline (#11245)', async () => {
    const mount = document.createElement('div');
    document.body.append(mount);
    const parentAbort = new AbortController();
    const expected: Record<string, string> = {
      unrest: 'Unrest',
      cyber: 'Cyber',
      maritime: 'Maritime',
      natural: 'Natural hazards',
      aviation: 'Aviation',
    };

    const fetchTimeline = vi.fn(async (): Promise<GetIntelTimelineResponse> => ({
      records: Object.keys(expected).map((domain) => makeRecord({ id: `rec-${domain}`, domain })),
      partial: false,
      upstreamUnavailable: false,
      nextCursor: '',
    }));

    const component = new CountryIntelMemory(mount, 'ua', parentAbort.signal, {
      fetchTimeline,
      fetchSimilar: vi.fn(),
    });
    await flushMicrotasks();

    const badges = [...mount.querySelectorAll<HTMLElement>('.country-intel-memory-domain')];
    expect(badges.map((badge) => [badge.dataset.domain, badge.textContent])).toEqual(
      Object.entries(expected),
    );
    // A missing locale key renders its path; a missing switch case renders the raw id.
    for (const badge of badges) {
      expect(badge.textContent).not.toContain('countryBrief.');
    }

    component.destroy();
  });

  it('aborts in-flight timeline fetch on domain switch and triggers a fresh request', async () => {
    const mount = document.createElement('div');
    document.body.append(mount);
    const parentAbort = new AbortController();

    const firstReq = deferred<GetIntelTimelineResponse>();
    const secondReq = deferred<GetIntelTimelineResponse>();
    const signals: AbortSignal[] = [];

    const fetchTimeline = vi.fn((params, signal?: AbortSignal) => {
      if (signal) signals.push(signal);
      return params.domain === '' ? firstReq.promise : secondReq.promise;
    });

    const component = new CountryIntelMemory(mount, 'UA', parentAbort.signal, {
      fetchTimeline,
      fetchSimilar: vi.fn(),
    });

    expect(signals).toHaveLength(1);
    expect(signals[0]!.aborted).toBe(false);

    // Switch domain while first request is still in-flight
    const energyBtn = mount.querySelector<HTMLButtonElement>('.country-intel-memory-pill[data-domain="energy"]')!;
    energyBtn.click();

    expect(signals[0]!.aborted).toBe(true);
    expect(fetchTimeline).toHaveBeenCalledTimes(2);
    expect(fetchTimeline).toHaveBeenLastCalledWith(
      { country: 'UA', domain: 'energy', limit: 20, cursor: '' },
      expect.any(AbortSignal),
    );
    expect(energyBtn.getAttribute('aria-pressed')).toBe('true');
    expect(
      mount.querySelector('.country-intel-memory-pill[data-domain=""]')?.getAttribute('aria-pressed'),
    ).toBe('false');

    // Late resolution of first (aborted) request must not overwrite DOM
    firstReq.resolve({
      records: [makeRecord({ id: 'stale-all', title: 'Stale All-domain event' })],
      partial: false,
      upstreamUnavailable: false,
      nextCursor: '',
    });
    await flushMicrotasks();
    expect(mount.textContent).not.toContain('Stale All-domain event');

    // Resolve the active energy request
    secondReq.resolve({
      records: [makeRecord({ id: 'fresh-energy', domain: 'energy', title: 'Refinery outage alert' })],
      partial: false,
      upstreamUnavailable: false,
      nextCursor: '',
    });
    await flushMicrotasks();

    expect(mount.textContent).toContain('Refinery outage alert');
    expect(mount.textContent).not.toContain('Stale All-domain event');

    component.destroy();
  });

  it('paginates with nextCursor via Load more and appends records without duplicates', async () => {
    const mount = document.createElement('div');
    document.body.append(mount);
    const parentAbort = new AbortController();

    const page2 = deferred<GetIntelTimelineResponse>();
    const fetchTimeline = vi.fn((params) => {
      if (!params.cursor) {
        return Promise.resolve({
          records: [makeRecord({ id: 'rec-1', title: 'First page event' })],
          partial: false,
          upstreamUnavailable: false,
          nextCursor: 'cursor-page-2',
        });
      }
      return page2.promise;
    });

    const component = new CountryIntelMemory(mount, 'UA', parentAbort.signal, {
      fetchTimeline,
      fetchSimilar: vi.fn(),
    });
    await flushMicrotasks();

    const loadMoreBtn = mount.querySelector<HTMLButtonElement>('.country-intel-memory-load-more')!;
    expect(loadMoreBtn).not.toBeNull();
    expect(loadMoreBtn.disabled).toBe(false);

    // Click twice rapidly — second click must be ignored while in flight
    loadMoreBtn.click();
    mount.querySelector<HTMLButtonElement>('.country-intel-memory-load-more')?.click();

    expect(fetchTimeline).toHaveBeenCalledTimes(2);
    expect(fetchTimeline).toHaveBeenLastCalledWith(
      { country: 'UA', domain: '', limit: 20, cursor: 'cursor-page-2' },
      expect.any(AbortSignal),
    );

    page2.resolve({
      records: [
        makeRecord({ id: 'rec-1', title: 'First page event' }),
        makeRecord({ id: 'rec-2', title: 'Second page event' }),
      ],
      partial: false,
      upstreamUnavailable: false,
      nextCursor: '',
    });
    await flushMicrotasks();

    const titles = Array.from(mount.querySelectorAll('.country-intel-memory-title')).map((el) => el.textContent);
    expect(titles).toEqual(['First page event', 'Second page event']);
    expect(mount.querySelector('.country-intel-memory-load-more')).toBeNull();

    component.destroy();
  });

  it('does not call getSimilarEvents on mount and runs precedent search only on valid submission', async () => {
    const mount = document.createElement('div');
    document.body.append(mount);
    const parentAbort = new AbortController();

    const fetchTimeline = vi.fn(async (): Promise<GetIntelTimelineResponse> => ({
      records: [makeRecord({ id: 'top-1', title: 'Drone strike disrupts coastal port operations' })],
      partial: false,
      upstreamUnavailable: false,
      nextCursor: '',
    }));
    const fetchSimilar = vi.fn(async (): Promise<GetSimilarEventsResponse> => ({
      situation: 'Drone strike disrupts coastal port operations',
      records: [
        makeRecord({
          id: 'sim-1',
          domain: 'military',
          title: '<img src=x onerror=alert(1)> Prior maritime drone strike',
          summary: 'Port loading paused for 48 hours after UAV attack.',
          sourceUrl: 'https://example.com/precedent',
          occurredAt: Date.UTC(2026, 6, 3, 12, 0, 0),
          score: 0.874,
        }),
      ],
      partial: false,
      upstreamUnavailable: false,
    }));

    const component = new CountryIntelMemory(mount, 'UA', parentAbort.signal, {
      fetchTimeline,
      fetchSimilar,
    });
    await flushMicrotasks();

    expect(fetchSimilar).not.toHaveBeenCalled();

    const input = mount.querySelector<HTMLInputElement>('.country-intel-memory-input')!;
    const form = mount.querySelector<HTMLFormElement>('.country-intel-memory-similar-form')!;

    // Too short (< 10 chars) must show validation hint and skip RPC
    input.value = 'short';
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await flushMicrotasks();
    expect(fetchSimilar).not.toHaveBeenCalled();
    expect(mount.querySelector('.country-intel-memory-hint')?.textContent).toContain('10 characters');

    // Quick-fill from top headline then submit
    const prefillBtn = mount.querySelector<HTMLButtonElement>('.country-intel-memory-prefill-btn')!;
    expect(prefillBtn.hidden).toBe(false);
    prefillBtn.click();
    expect(input.value).toBe('Drone strike disrupts coastal port operations');

    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await flushMicrotasks();

    expect(fetchSimilar).toHaveBeenCalledTimes(1);
    expect(fetchSimilar).toHaveBeenCalledWith(
      {
        situation: 'Drone strike disrupts coastal port operations',
        country: 'UA',
        domain: '',
        limit: 6,
      },
      expect.any(AbortSignal),
    );

    const similarItems = mount.querySelectorAll('.country-intel-memory-similar-list .country-intel-memory-item');
    expect(similarItems).toHaveLength(1);
    expect(similarItems[0]!.querySelector('.country-intel-memory-score')?.textContent).toBe('87%');
    expect(similarItems[0]!.querySelector('.country-intel-memory-date')?.textContent).toBe('2026-07-03');
    expect(similarItems[0]!.querySelector('img')).toBeNull();
    expect(similarItems[0]!.querySelector('.country-intel-memory-title')?.textContent).toContain(
      '<img src=x onerror=alert(1)>',
    );

    component.destroy();
  });

  it('keeps Load more available when a scanned page returns zero records with a nextCursor', async () => {
    const mount = document.createElement('div');
    document.body.append(mount);
    const parentAbort = new AbortController();

    const fetchTimeline = vi.fn(async (params: { cursor?: string }): Promise<GetIntelTimelineResponse> => {
      if (!params.cursor) {
        return { records: [], partial: false, upstreamUnavailable: false, nextCursor: 'older-page-cursor' };
      }
      return {
        records: [makeRecord({ id: 'older-1', title: 'Older matching archive event' })],
        partial: false,
        upstreamUnavailable: false,
        nextCursor: '',
      };
    });

    const component = new CountryIntelMemory(mount, 'UA', parentAbort.signal, {
      fetchTimeline,
      fetchSimilar: vi.fn(),
    });
    await flushMicrotasks();

    const loadMoreBtn = mount.querySelector<HTMLButtonElement>('.country-intel-memory-load-more');
    expect(loadMoreBtn).not.toBeNull();
    loadMoreBtn!.click();
    await flushMicrotasks();

    expect(fetchTimeline).toHaveBeenCalledTimes(2);
    expect(fetchTimeline).toHaveBeenLastCalledWith(
      { country: 'UA', domain: '', limit: 20, cursor: 'older-page-cursor' },
      expect.any(AbortSignal),
    );
    expect(mount.querySelectorAll('.country-intel-memory-timeline .country-intel-memory-item')).toHaveLength(1);
    expect(mount.querySelector('.country-intel-memory-title')?.textContent).toBe('Older matching archive event');
    expect(mount.querySelector('.country-intel-memory-load-more')).toBeNull();

    component.destroy();
  });

  it('cancels in-flight precedent search and clears similar results when switching domain pills', async () => {
    const mount = document.createElement('div');
    document.body.append(mount);
    const parentAbort = new AbortController();

    const fetchTimeline = vi.fn(async (): Promise<GetIntelTimelineResponse> => ({
      records: [makeRecord({ id: 'evt-1', domain: 'conflict', title: 'Artillery barrage near logistics hub' })],
      partial: false,
      upstreamUnavailable: false,
      nextCursor: '',
    }));

    let resolvePendingSimilar: ((value: GetSimilarEventsResponse) => void) | null = null;
    const similarSignals: AbortSignal[] = [];
    const fetchSimilar = vi.fn(
      (_params: unknown, signal?: AbortSignal) => new Promise<GetSimilarEventsResponse>((resolve) => {
        if (signal) similarSignals.push(signal);
        resolvePendingSimilar = resolve;
      }),
    );

    const component = new CountryIntelMemory(mount, 'UA', parentAbort.signal, {
      fetchTimeline,
      fetchSimilar,
    });
    await flushMicrotasks();

    // Start a similar search under default domain, then switch to energy before it settles
    const input = mount.querySelector<HTMLInputElement>('.country-intel-memory-input')!;
    const form = mount.querySelector<HTMLFormElement>('.country-intel-memory-similar-form')!;
    const submitBtn = mount.querySelector<HTMLButtonElement>('.country-intel-memory-similar-submit')!;
    input.value = 'Artillery barrage near logistics hub';
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await flushMicrotasks();

    expect(fetchSimilar).toHaveBeenCalledTimes(1);
    expect(submitBtn.disabled).toBe(true);
    expect(similarSignals[0]!.aborted).toBe(false);

    const energyPill = mount.querySelector<HTMLButtonElement>('.country-intel-memory-pill[data-domain="energy"]')!;
    energyPill.click();
    await flushMicrotasks();

    expect(similarSignals[0]!.aborted).toBe(true);
    expect(submitBtn.disabled).toBe(false);
    expect(mount.querySelector('.country-intel-memory-similar-results')?.childNodes.length).toBe(0);

    // Late resolution of the aborted search must not paint stale results
    resolvePendingSimilar!({
      situation: 'Artillery barrage near logistics hub',
      records: [makeRecord({ id: 'stale-sim', domain: 'conflict', title: 'Stale conflict match', score: 0.9 })],
      partial: false,
      upstreamUnavailable: false,
    });
    await flushMicrotasks();
    expect(mount.querySelector('.country-intel-memory-similar-results')?.childNodes.length).toBe(0);

    component.destroy();
  });

  it('renders honest unavailable and empty states and prevents late mutation after destroy()', async () => {
    const mount = document.createElement('div');
    document.body.append(mount);
    const parentAbort = new AbortController();

    let call = 0;
    const lateReq = deferred<GetIntelTimelineResponse>();
    const fetchTimeline = vi.fn((): Promise<GetIntelTimelineResponse> => {
      call += 1;
      if (call === 1) {
        return Promise.resolve({
          records: [],
          partial: false,
          upstreamUnavailable: true,
          nextCursor: '',
        });
      }
      if (call === 2) {
        return Promise.resolve({
          records: [],
          partial: false,
          upstreamUnavailable: false,
          nextCursor: '',
        });
      }
      return lateReq.promise;
    });

    const component = new CountryIntelMemory(mount, 'LS', parentAbort.signal, {
      fetchTimeline,
      fetchSimilar: vi.fn(),
    });
    await flushMicrotasks();

    // Unavailable state + Retry button
    const unavailable = mount.querySelector<HTMLElement>('.cdp-empty[data-brief-state="unavailable"]');
    expect(unavailable).not.toBeNull();
    const retryBtn = mount.querySelector<HTMLButtonElement>('.country-intel-memory-error button')!;
    expect(retryBtn).not.toBeNull();

    // Retry -> honest empty state
    retryBtn.click();
    await flushMicrotasks();
    expect(mount.querySelector('.cdp-empty[data-brief-state="unavailable"]')).toBeNull();
    expect(mount.querySelector('.country-intel-memory-empty')?.textContent).toContain('180-day');

    // Trigger a third request (switch domain), then destroy before it resolves
    mount.querySelector<HTMLButtonElement>('.country-intel-memory-pill[data-domain="conflict"]')!.click();
    const snapshotHtml = mount.innerHTML;
    component.destroy();

    lateReq.resolve({
      records: [makeRecord({ id: 'after-destroy', title: 'Should never render' })],
      partial: false,
      upstreamUnavailable: false,
      nextCursor: '',
    });
    await flushMicrotasks();

    expect(mount.textContent).not.toContain('Should never render');
    expect(mount.innerHTML).toBe(snapshotHtml);
  });
});

describe('CountryDeepDivePanel & CountryBriefController intelMemory wiring', () => {
  afterEach(() => {
    document.getElementById('deep-dive-close')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    document.getElementById('country-deep-dive-panel')?.remove();
  });

  it('renders #cdp-section-intelMemory as locked for free users and omits it in host mode', () => {
    vi.spyOn(panelGating, 'hasPremiumAccess').mockReturnValue(false);
    const panel = new CountryDeepDivePanel();
    panel.show('Ukraine', 'UA', null, null);

    const section = document.querySelector<HTMLElement>('#cdp-section-intelMemory');
    expect(section).not.toBeNull();
    expect(section?.dataset.loadState).toBe('locked');
    expect(section?.querySelector('.cdp-pro-locked')).not.toBeNull();
    panel.hide();
    document.getElementById('country-deep-dive-panel')?.remove();

    const never = () => new Promise(() => {});
    const hostSource = {
      mode: 'host',
      canRequestPremium: () => true,
      supply: {
        listPipelines: never,
        listStorageFacilities: never,
        listFuelShortages: never,
      },
      atlas: () => ({
        getPipelineDetail: never,
        getStorageFacilityDetail: never,
        getFuelShortageDetail: never,
        listEnergyDisruptions: never,
      }),
      food: never,
      demographics: never,
      factors: never,
      resilience: never,
      fetch: never,
      reservoirLevels: never,
    } as unknown as CountryBriefSource;
    const hostPanel = new CountryDeepDivePanel(null, hostSource);
    hostPanel.show('Ukraine', 'UA', null, null);
    expect(document.querySelector('#cdp-section-intelMemory')).toBeNull();
    hostPanel.hide();
  });

  it('mounts CountryIntelMemory on Pro refreshPremium and destroys/locks it on downgrade', async () => {
    let isPro = true;
    vi.spyOn(panelGating, 'hasPremiumAccess').mockImplementation(() => isPro);

    const pending = deferred<GetIntelTimelineResponse>();
    let capturedSignal: AbortSignal | undefined;
    const timelineSpy = vi.spyOn(intelHistoryService, 'fetchIntelTimeline').mockImplementation((_params, signal) => {
      capturedSignal = signal;
      return pending.promise;
    });

    const never = () => new Promise(() => {});
    const websiteSource = {
      mode: 'website',
      canRequestPremium: () => isPro,
      fetch: never,
      food: never,
      demographics: never,
      factors: never,
      resilience: never,
      market: { getCountryStockIndex: never },
      intelligence: {
        getCountryFacts: never,
        getCountryEnergyProfile: never,
        getCountryPortActivity: never,
        getCountryRisk: never,
      },
      economic: { getNo2Activity: never, getNationalDebt: never },
      military: { getDefenseIndustrialBase: never },
      supply: { getCountryVulnerabilities: never, getCountryProducts: never },
      trade: { listComtradeFlows: never, getTariffTrends: never },
      prediction: { listPredictionMarkets: never },
      exposure: never,
      reservoirLevels: never,
    } as unknown as CountryBriefSource;

    const panel = new CountryDeepDivePanel(null, websiteSource);
    panel.show('Ukraine', 'UA', null, null);
    const controller = new CountryBriefController(websiteSource, panel);

    vi.spyOn(await import('@/services/imf-country-data'), 'getImfCountryBundle').mockImplementation(never as never);
    vi.spyOn(await import('@/services/prediction'), 'fetchCountryMarkets').mockImplementation(never as never);

    controller.hydrate('UA', 'Ukraine');
    await flushMicrotasks();

    expect(timelineSpy).toHaveBeenCalledTimes(1);
    expect(capturedSignal?.aborted).toBe(false);

    // Downgrade Pro -> Free: must abort in-flight fetch and lock section immediately
    isPro = false;
    panel.syncCountryPremiumSectionsAccess(false);
    controller.refreshPremium();

    expect(capturedSignal?.aborted).toBe(true);
    const section = document.querySelector<HTMLElement>('#cdp-section-intelMemory');
    expect(section?.querySelector('.cdp-pro-locked')).not.toBeNull();

    // Late resolution of aborted request must not leak Pro content into locked card
    pending.resolve({
      records: [makeRecord({ id: 'leaked', title: 'Leaked Pro event' })],
      partial: false,
      upstreamUnavailable: false,
      nextCursor: '',
    });
    await flushMicrotasks();
    expect(section?.textContent).not.toContain('Leaked Pro event');

    controller.dispose();
    panel.hide();
  });
});
