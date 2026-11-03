import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppContext } from '@/app/app-context';
import type { ListGlobalTendersResponse } from '@/generated/client/worldmonitor/economic/v1/service_client';

import { initTestI18n } from './helpers/i18n.mts';

// Stub the network layer under the real global-tenders service rather than the
// service itself: the service is reached through dynamic import() calls, and
// this path runs overlapping ones, which vi.mock factories do not reliably
// intercept (the concurrent import can resolve to the real module).
const server = vi.hoisted(() => ({
  requests: [] as URL[],
  defaultTitle: 'baseline',
}));

vi.mock('@/services/premium-fetch', () => ({
  premiumFetch: vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://localhost');
    server.requests.push(url);
    const query = url.searchParams.get('query');
    const title = query ? `result-for-${query}` : server.defaultTitle;
    return new Response(JSON.stringify(response(title)), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }),
}));

vi.mock('@/services/panel-gating', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/services/panel-gating')>(),
  hasPremiumAccess: () => true,
}));

const { DataLoaderManager } = await import('@/app/data-loader');
const { GlobalProcurementPanel } = await import('@/components/GlobalProcurementPanel');

const CONTENT_DEBOUNCE_MS = 150;

function response(title: string): ListGlobalTendersResponse {
  return {
    tenders: [{
      id: `tender-${title}`,
      source: 'sam',
      sourceNoticeId: `notice-${title}`,
      officialUrl: 'https://example.com/tender',
      title,
      status: 'open',
      categoryCodes: [],
      sectors: [],
      eligibilityRequirements: [],
      submissionUrls: [],
      participationMode: '',
    }],
    nextCursor: '',
    fetchedAt: '2026-08-18T12:00:00.000Z',
    dataAvailable: true,
    availability: 'available',
    sourceStatuses: [],
    total: 1,
    appliedFilters: [],
    countryCoverage: 'not_requested',
  };
}

function panelText(panel: InstanceType<typeof GlobalProcurementPanel>): string {
  return panel.getElement().textContent ?? '';
}

beforeAll(async () => {
  await initTestI18n();
});

describe('Global procurement across a Pro -> Pro account switch', () => {
  let panel: InstanceType<typeof GlobalProcurementPanel>;
  let loader: InstanceType<typeof DataLoaderManager>;

  beforeEach(() => {
    vi.useFakeTimers();
    server.requests.length = 0;
    server.defaultTitle = 'baseline';
    panel = new GlobalProcurementPanel();
    document.body.appendChild(panel.getElement());
    const ctx = {
      panels: { 'global-procurement': panel },
      statusPanel: { updateApi: vi.fn() },
    } as unknown as AppContext;
    loader = new DataLoaderManager(ctx, {
      renderCriticalBanner: () => undefined,
      refreshOpenCountryBrief: () => undefined,
    });
  });

  afterEach(() => {
    loader.destroy();
    panel.destroy();
    document.body.innerHTML = '';
    vi.useRealTimers();
  });

  it('account B does not inherit account A filters or results', async () => {
    panel.bindContentPrincipal('user-a');
    panel.unlockPanel();

    // Account A loads the default view, then searches for a private query.
    await loader.loadGlobalTenders();
    await vi.waitFor(() => expect(panelText(panel)).toContain('baseline'));
    const form = panel.getElement().querySelector<HTMLFormElement>('[data-procurement-filters]');
    if (!form) throw new Error('procurement form missing');
    (form.elements.namedItem('query') as HTMLInputElement).value = 'alpha-secret';
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(panelText(panel)).toContain('result-for-alpha-secret'));

    // Switch to account B, both Pro. App fires the premium loaders for the
    // account transition first, then panel gating resets the panel for the
    // new principal (subscription order in App.init).
    server.defaultTitle = 'bravo-default';
    const requestsBeforeSwitch = server.requests.length;
    const transitionLoad = loader.loadGlobalTenders();
    panel.clearSensitiveContent();
    panel.bindContentPrincipal('user-b');
    panel.unlockPanel();
    await transitionLoad;
    await vi.waitFor(() => expect(panelText(panel)).toContain('bravo-default'));
    await vi.advanceTimersByTimeAsync(CONTENT_DEBOUNCE_MS);

    expect(panelText(panel)).not.toContain('alpha-secret');
    expect(panel.getElement().querySelector<HTMLInputElement>('[data-procurement-query]')?.value).toBe('');
    const afterSwitch = server.requests.slice(requestsBeforeSwitch);
    expect(afterSwitch.length).toBeGreaterThan(0);
    expect(afterSwitch.every((url) => url.searchParams.get('query') !== 'alpha-secret')).toBe(true);

    // A later unscoped refresh for B must not resurrect A's query either.
    const requestsBeforeRefresh = server.requests.length;
    await loader.loadGlobalTenders();
    await vi.advanceTimersByTimeAsync(CONTENT_DEBOUNCE_MS);
    for (const url of server.requests.slice(requestsBeforeRefresh)) {
      expect(url.searchParams.get('query')).not.toBe('alpha-secret');
    }
    expect(panelText(panel)).not.toContain('alpha-secret');
  });
});
