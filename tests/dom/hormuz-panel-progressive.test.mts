import { beforeEach, describe, expect, it, vi } from 'vitest';

const serviceMocks = vi.hoisted(() => ({
  fetchTracker: vi.fn(),
  fetchDependencies: vi.fn(),
}));

const gateMocks = vi.hoisted(() => ({ isPro: true }));

const entitlementMocks = vi.hoisted(() => ({
  authListeners: new Set<() => void>(),
  entitlementListeners: new Set<() => void>(),
}));

vi.mock('@/services/auth-state', () => ({
  getAuthState: () => ({
    user: gateMocks.isPro ? { id: 'user-1', name: 'Pro User', email: 'pro@example.com', role: 'pro' } : null,
    isPending: false,
  }),
  subscribeAuthState: (listener: () => void) => {
    entitlementMocks.authListeners.add(listener);
    listener();
    return () => entitlementMocks.authListeners.delete(listener);
  },
}));

vi.mock('@/services/entitlements', () => ({
  onEntitlementChange: (listener: () => void) => {
    entitlementMocks.entitlementListeners.add(listener);
    return () => entitlementMocks.entitlementListeners.delete(listener);
  },
}));

vi.mock('@/services/panel-gating', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/services/panel-gating')>(),
  hasPremiumAccess: () => gateMocks.isPro,
}));

// The panel's English copy, interpolated, so the label test reads what a viewer reads.
// `catalogLoaded` false mimics first paint: only the eager en.shell.json subset resolves.
const i18nMocks = vi.hoisted(() => ({ catalogLoaded: true }));
vi.mock('@/services/i18n', async (importOriginal) => {
  const { readFileSync } = await import('node:fs');
  const en = JSON.parse(readFileSync('src/locales/en.json', 'utf8'));
  const shell = JSON.parse(readFileSync('src/locales/en.shell.json', 'utf8'));
  const lookupIn = (catalog: unknown, key: string): unknown => key.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown>)?.[part], catalog);
  return {
    ...await importOriginal<typeof import('@/services/i18n')>(),
    t: (key: string, params: Record<string, unknown> = {}) =>
      String(lookupIn(i18nMocks.catalogLoaded ? en : shell, key) ?? key)
        .replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(params[name] ?? '')),
  };
});

vi.mock('@/services/hormuz-tracker', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/services/hormuz-tracker')>(),
  fetchHormuzTracker: serviceMocks.fetchTracker,
}));

vi.mock('@/services/supply-chain', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/services/supply-chain')>(),
  fetchChokepointDependencies: serviceMocks.fetchDependencies,
}));

import { HormuzPanel } from '@/components/HormuzPanel';

const tracker = {
  fetchedAt: Date.parse('2026-08-30T00:00:00Z'),
  updatedDate: '2026-08-30',
  title: 'Hormuz tracker',
  summary: null,
  paragraphs: [],
  status: 'open' as const,
  charts: [{
    label: 'crude_oil',
    title: 'Crude oil transit',
    series: [{ date: '2026-08-30', value: 18_000 }],
  }],
  attribution: { source: 'EIA', url: 'https://www.eia.gov/' },
};

const dependencyResponse = {
  chokepointId: 'hormuz_strait',
  chokepoint: 'Strait of Hormuz',
  dependencies: [{
    countryIso2: 'AE',
    countryName: 'United Arab Emirates',
    commodityId: 'wheat',
    commodity: 'Wheat',
    transitShare: 0.4,
    weightedTransitShare: 0.4,
    score: 67,
    band: 'high',
    state: 'ok',
    reasons: [],
    methodologyVersion: 'supply-vulnerability-v2.0.0',
  }],
  generatedAt: '2026-08-30T00:00:00Z',
  methodologyVersion: 'supply-vulnerability-v2.0.0',
  upstreamUnavailable: false,
};

beforeEach(() => {
  i18nMocks.catalogLoaded = true;
  document.body.replaceChildren();
  localStorage.clear();
  gateMocks.isPro = true;
  serviceMocks.fetchTracker.mockReset();
  serviceMocks.fetchDependencies.mockReset();
  entitlementMocks.authListeners.clear();
  entitlementMocks.entitlementListeners.clear();
});

function emitAuthChange(): void {
  for (const listener of [...entitlementMocks.authListeners]) listener();
}

function emitEntitlementChange(): void {
  for (const listener of [...entitlementMocks.entitlementListeners]) listener();
}

describe('HormuzPanel progressive vulnerability loading', () => {
  it('renders the primary tracker before optional dependencies settle', async () => {
    let resolveDependencies!: (value: typeof dependencyResponse) => void;
    const pendingDependencies = new Promise<typeof dependencyResponse>((resolve) => {
      resolveDependencies = resolve;
    });
    serviceMocks.fetchTracker.mockResolvedValue(tracker);
    serviceMocks.fetchDependencies.mockReturnValue(pendingDependencies);

    const panel = new HormuzPanel();
    document.body.append(panel.getElement());
    const fetchPromise = panel.fetchData();
    const firstResult = await Promise.race([
      fetchPromise.then(() => 'rendered'),
      new Promise<'blocked'>((resolve) => setTimeout(() => resolve('blocked'), 0)),
    ]);

    await fetchPromise;
    expect(firstResult).toBe('rendered');
    await vi.waitFor(() => {
      expect(panel.getElement().textContent).toContain('Crude oil transit');
    });
    expect(panel.getElement().querySelector('.hz-dependencies')?.getAttribute('data-state')).toBe('loading');
    resolveDependencies(dependencyResponse);
    await vi.waitFor(() => {
      expect(panel.getElement().textContent).toContain('United Arab Emirates');
    });
  });

  it('ignores an older dependency response after a newer fetch generation renders', async () => {
    let resolveFirst!: (value: typeof dependencyResponse) => void;
    const firstDependencies = new Promise<typeof dependencyResponse>((resolve) => {
      resolveFirst = resolve;
    });
    const newerResponse = {
      ...dependencyResponse,
      dependencies: [{
        ...dependencyResponse.dependencies[0],
        countryIso2: 'JP',
        countryName: 'Japan',
      }],
    };
    serviceMocks.fetchTracker.mockResolvedValue(tracker);
    serviceMocks.fetchDependencies
      .mockReturnValueOnce(firstDependencies)
      .mockResolvedValueOnce(newerResponse);

    const panel = new HormuzPanel();
    document.body.append(panel.getElement());
    await panel.fetchData();
    await panel.fetchData();
    await vi.waitFor(() => {
      expect(panel.getElement().textContent).toContain('Japan');
    });

    resolveFirst(dependencyResponse);
    await Promise.resolve();
    expect(panel.getElement().textContent).toContain('Japan');
    expect(panel.getElement().textContent).not.toContain('United Arab Emirates');
  });

  it('aborts dependency loading and ignores settlement after destroy', async () => {
    let resolveDependencies!: (value: typeof dependencyResponse) => void;
    const pendingDependencies = new Promise<typeof dependencyResponse>((resolve) => {
      resolveDependencies = resolve;
    });
    serviceMocks.fetchTracker.mockResolvedValue(tracker);
    serviceMocks.fetchDependencies.mockReturnValue(pendingDependencies);

    const panel = new HormuzPanel();
    const renderPanel = vi.spyOn(panel as unknown as { renderPanel: () => void }, 'renderPanel');
    document.body.append(panel.getElement());
    await panel.fetchData();

    const requestOptions = serviceMocks.fetchDependencies.mock.calls[0]?.[2] as
      | { signal?: AbortSignal }
      | undefined;
    expect(requestOptions?.signal?.aborted).toBe(false);
    expect(renderPanel).toHaveBeenCalledTimes(1);

    panel.destroy();
    expect(requestOptions?.signal?.aborted).toBe(true);
    resolveDependencies(dependencyResponse);
    await Promise.resolve();
    await Promise.resolve();

    expect(renderPanel).toHaveBeenCalledTimes(1);
  });

  it('keeps the tracker but locks the dependency block for a free viewer (#6449)', async () => {
    gateMocks.isPro = false;
    serviceMocks.fetchTracker.mockResolvedValue(tracker);
    serviceMocks.fetchDependencies.mockResolvedValue(dependencyResponse);

    const panel = new HormuzPanel();
    document.body.append(panel.getElement());
    await panel.fetchData();

    await vi.waitFor(() => {
      expect(panel.getElement().textContent).toContain('Crude oil transit');
    });

    expect(serviceMocks.fetchDependencies).not.toHaveBeenCalled();

    const dependencies = panel.getElement().querySelector('.hz-dependencies');
    expect(dependencies?.getAttribute('data-state')).toBe('pro-locked');
    expect(dependencies?.textContent).not.toContain('United Arab Emirates');
  });

  it('dedupes Clerk and Convex unlock events into one dependency fetch', async () => {
    gateMocks.isPro = false;
    serviceMocks.fetchTracker.mockResolvedValue(tracker);
    serviceMocks.fetchDependencies.mockResolvedValue(dependencyResponse);

    const panel = new HormuzPanel();
    document.body.append(panel.getElement());
    await panel.fetchData();
    expect(serviceMocks.fetchDependencies).not.toHaveBeenCalled();

    gateMocks.isPro = true;
    emitAuthChange();
    emitEntitlementChange();

    await vi.waitFor(() => {
      expect(serviceMocks.fetchDependencies).toHaveBeenCalledTimes(1);
      expect(panel.getElement().textContent).toContain('United Arab Emirates');
    });
  });

  it('clears Pro dependencies immediately on downgrade while retaining the tracker', async () => {
    let resolveDependencies!: (value: typeof dependencyResponse) => void;
    const pendingDependencies = new Promise<typeof dependencyResponse>((resolve) => {
      resolveDependencies = resolve;
    });
    serviceMocks.fetchTracker.mockResolvedValue(tracker);
    serviceMocks.fetchDependencies.mockReturnValue(pendingDependencies);

    const panel = new HormuzPanel();
    document.body.append(panel.getElement());
    await panel.fetchData();
    await vi.waitFor(() => expect(panel.getElement().textContent).toContain('Crude oil transit'));
    const requestOptions = serviceMocks.fetchDependencies.mock.calls[0]?.[2] as { signal?: AbortSignal };

    gateMocks.isPro = false;
    emitEntitlementChange();

    expect(requestOptions.signal?.aborted).toBe(true);
    expect(panel.getElement().textContent).toContain('Crude oil transit');
    await vi.waitFor(() => {
      expect(panel.getElement().querySelector('.hz-dependencies')?.getAttribute('data-state')).toBe('pro-locked');
    });
    resolveDependencies(dependencyResponse);
    await Promise.resolve();
    expect(panel.getElement().textContent).not.toContain('United Arab Emirates');
  });

  it('ignores a stale dependency completion after a downgrade and re-upgrade', async () => {
    let resolveStale!: (value: typeof dependencyResponse) => void;
    const staleDependencies = new Promise<typeof dependencyResponse>((resolve) => {
      resolveStale = resolve;
    });
    serviceMocks.fetchTracker.mockResolvedValue(tracker);
    serviceMocks.fetchDependencies
      .mockReturnValueOnce(staleDependencies)
      .mockResolvedValueOnce(dependencyResponse);

    const panel = new HormuzPanel();
    document.body.append(panel.getElement());
    await panel.fetchData();

    gateMocks.isPro = false;
    emitAuthChange();
    gateMocks.isPro = true;
    emitEntitlementChange();
    await vi.waitFor(() => expect(serviceMocks.fetchDependencies).toHaveBeenCalledTimes(2));

    resolveStale(dependencyResponse);
    await Promise.resolve();
    expect(panel.getElement().textContent).not.toContain('United Arab Emirates');
    await vi.waitFor(() => expect(panel.getElement().textContent).toContain('United Arab Emirates'));
  });

  it('unsubscribes auth listeners and aborts dependencies on destroy', async () => {
    let resolveDependencies!: (value: typeof dependencyResponse) => void;
    const pendingDependencies = new Promise<typeof dependencyResponse>((resolve) => {
      resolveDependencies = resolve;
    });
    serviceMocks.fetchTracker.mockResolvedValue(tracker);
    serviceMocks.fetchDependencies.mockReturnValue(pendingDependencies);

    const panel = new HormuzPanel();
    document.body.append(panel.getElement());
    await panel.fetchData();
    const requestOptions = serviceMocks.fetchDependencies.mock.calls[0]?.[2] as { signal?: AbortSignal };
    expect(entitlementMocks.authListeners.size).toBe(1);
    expect(entitlementMocks.entitlementListeners.size).toBe(1);

    panel.destroy();

    expect(entitlementMocks.authListeners.size).toBe(0);
    expect(entitlementMocks.entitlementListeners.size).toBe(0);
    expect(requestOptions.signal?.aborted).toBe(true);
    resolveDependencies(dependencyResponse);
    await Promise.resolve();
    await Promise.resolve();
  });
});

describe('HormuzPanel dates from a tracker payload stored before the ISO seeder fix', () => {
  const storedPayload = {
    ...tracker,
    updatedDate: '21.09.2026',
    charts: [
      {
        label: 'crude_oil_outbound',
        title: 'Crude Oil Outbound Shipments',
        series: [
          { date: 'November-01-2026', value: 4 },
          { date: 'October-30-2026', value: 12 },
          { date: 'October-31-2026', value: 7 },
        ],
      },
      {
        label: 'agriculture_inbound',
        title: 'Agriculture Inbound Shipments',
        series: [
          { date: '2026-November-01', value: 0 },
          { date: '2026-November-02', value: 5 },
          { date: '2026-October-30', value: 164 },
          { date: '2026-October-31', value: 82 },
        ],
      },
    ],
  };

  async function serveFromRedis(stored: unknown): Promise<unknown> {
    vi.stubEnv('UPSTASH_REDIS_REST_URL', 'https://redis.test');
    vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', 'test-token');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ result: JSON.stringify(stored) }), { status: 200 })));
    try {
      // @ts-expect-error api/ edge handlers are plain JS without declaration files.
      const { default: handler } = await import('../../api/supply-chain/hormuz-tracker.js');
      const response: Response = await handler(new Request('https://www.worldmonitor.app/api/supply-chain/hormuz-tracker'));
      expect(response.status).toBe(200);
      return await response.json();
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  }

  it('labels each chart with the latest day as MM-DD and draws bars oldest first', async () => {
    gateMocks.isPro = false;
    serviceMocks.fetchTracker.mockResolvedValue(await serveFromRedis(storedPayload));

    const panel = new HormuzPanel();
    document.body.append(panel.getElement());
    await panel.fetchData();

    await vi.waitFor(() => {
      expect(panel.getElement().querySelectorAll('.hz-chart')).toHaveLength(2);
    });
    const charts = [...panel.getElement().querySelectorAll('.hz-chart')];
    const latestLabels = charts.map((chart) => chart.querySelector(':scope > div > span:last-child')?.textContent?.split('·').pop()?.trim());
    expect(latestLabels).toEqual(['11-01', '11-02']);
    const barDates = charts.map((chart) => [...chart.querySelectorAll('rect.hbar')].map((bar) => bar.getAttribute('data-date')));
    expect(barDates).toEqual([
      ['2026-10-30', '2026-10-31', '2026-11-01'],
      ['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02'],
    ]);
  });
});

describe('HormuzPanel shipment index labels', () => {
  it('labels the WTO series as a Jan–Mar 2025-based index and dates the WTO analysis', async () => {
    serviceMocks.fetchTracker.mockResolvedValue({
      ...tracker,
      updatedDate: '2026-09-21',
      status: 'disrupted' as const,
      charts: [
        { label: 'crude_oil_outbound', title: 'Crude Oil Outbound Shipments', series: [{ date: '2026-11-01', value: 0 }] },
        { label: 'lng_outbound', title: 'LNG Outbound Shipments', series: [{ date: '2026-11-01', value: 0 }] },
      ],
    });
    serviceMocks.fetchDependencies.mockResolvedValue(dependencyResponse);

    const panel = new HormuzPanel();
    document.body.append(panel.getElement());
    await panel.fetchData();

    await vi.waitFor(() => expect(panel.getElement().textContent).toContain('Crude Oil Outbound Shipments'));
    const text = panel.getElement().textContent ?? '';
    expect(text, 'the WTO series are an index, not tonnage').not.toMatch(/kt\/day|\bunits\b/);
    expect(text, 'WTO bases the index on January–March 2025').toContain('Jan–Mar 2025 average = 100');
    expect(text).toContain('WTO analysis 2026-09-21');
  });

  it('relabels the tracker when the full English catalog lands after it rendered', async () => {
    const { I18N_RESOURCES_LOADED_EVENT } = await import('@/services/i18n');
    i18nMocks.catalogLoaded = false;
    serviceMocks.fetchTracker.mockResolvedValue({
      ...tracker,
      updatedDate: '2026-09-21',
      charts: [{ label: 'lng_outbound', title: 'LNG Outbound Shipments', series: [{ date: '2026-11-01', value: 0 }] }],
    });
    serviceMocks.fetchDependencies.mockResolvedValue(dependencyResponse);

    const panel = new HormuzPanel();
    document.body.append(panel.getElement());
    await panel.fetchData();
    await vi.waitFor(() => expect(panel.getElement().textContent).toContain('components.hormuzTracker.analysisDate'));

    i18nMocks.catalogLoaded = true;
    window.dispatchEvent(new CustomEvent(I18N_RESOURCES_LOADED_EVENT, { detail: { language: 'en' } }));

    await vi.waitFor(() => expect(panel.getElement().textContent).toContain('WTO analysis 2026-09-21'));
    expect(panel.getElement().textContent).not.toContain('components.hormuzTracker.');
    panel.destroy();
  });

  it('keeps the error and its retry when the catalog lands after a failed refresh', async () => {
    const { I18N_RESOURCES_LOADED_EVENT } = await import('@/services/i18n');
    serviceMocks.fetchTracker.mockResolvedValueOnce({
      ...tracker,
      charts: [{ label: 'lng_outbound', title: 'LNG Outbound Shipments', series: [{ date: '2026-11-01', value: 0 }] }],
    }).mockResolvedValueOnce(null);
    serviceMocks.fetchDependencies.mockResolvedValue(dependencyResponse);

    const panel = new HormuzPanel();
    document.body.append(panel.getElement());
    await panel.fetchData();
    await vi.waitFor(() => expect(panel.getElement().textContent).toContain('LNG Outbound Shipments'));
    expect(await panel.fetchData()).toBe(false);
    await vi.waitFor(() => expect(panel.getElement().textContent).toContain('Hormuz data unavailable'));

    window.dispatchEvent(new CustomEvent(I18N_RESOURCES_LOADED_EVENT, { detail: { language: 'en' } }));
    // Panel content writes commit after a 150ms debounce; let any redraw land.
    await new Promise((resolve) => setTimeout(resolve, 300));

    const text = panel.getElement().textContent ?? '';
    expect(text, 'the failed refresh stays visible').toContain('Hormuz data unavailable');
    expect(text, 'the old snapshot is not shown as current').not.toContain('LNG Outbound Shipments');
    panel.destroy();
  });

  it('leaves an in-flight refresh loading when the catalog lands', async () => {
    const { I18N_RESOURCES_LOADED_EVENT } = await import('@/services/i18n');
    const fresh = {
      ...tracker,
      charts: [{ label: 'lng_outbound', title: 'LNG Fresh Shipments', series: [{ date: '2026-11-02', value: 3 }] }],
    };
    let resolveRefresh: (value: typeof fresh) => void = () => undefined;
    serviceMocks.fetchTracker.mockResolvedValueOnce({
      ...tracker,
      charts: [{ label: 'lng_outbound', title: 'LNG Outbound Shipments', series: [{ date: '2026-11-01', value: 0 }] }],
    }).mockImplementationOnce(() => new Promise((resolve) => { resolveRefresh = resolve; }));
    serviceMocks.fetchDependencies.mockResolvedValue(dependencyResponse);

    const panel = new HormuzPanel();
    document.body.append(panel.getElement());
    await panel.fetchData();
    await vi.waitFor(() => expect(panel.getElement().textContent).toContain('LNG Outbound Shipments'));
    const refresh = panel.fetchData();

    window.dispatchEvent(new CustomEvent(I18N_RESOURCES_LOADED_EVENT, { detail: { language: 'en' } }));
    // Panel content writes commit after a 150ms debounce; let any redraw land.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(panel.getElement().textContent, 'the old snapshot does not replace the loading state').not.toContain('LNG Outbound Shipments');

    resolveRefresh(fresh);
    expect(await refresh).toBe(true);
    await vi.waitFor(() => expect(panel.getElement().textContent).toContain('LNG Fresh Shipments'));
    panel.destroy();
  });
});
