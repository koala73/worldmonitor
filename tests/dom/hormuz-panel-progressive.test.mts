import { beforeEach, describe, expect, it, vi } from 'vitest';

const serviceMocks = vi.hoisted(() => ({
  fetchTracker: vi.fn(),
  fetchDependencies: vi.fn(),
}));

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
  document.body.replaceChildren();
  localStorage.clear();
  serviceMocks.fetchTracker.mockReset();
  serviceMocks.fetchDependencies.mockReset();
});

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
    resolveDependencies(dependencyResponse);
    await vi.waitFor(() => {
      expect(panel.getElement().textContent).toContain('United Arab Emirates');
    });
  });
});
