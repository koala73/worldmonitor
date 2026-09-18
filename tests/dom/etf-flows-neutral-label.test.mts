import { afterEach, expect, it, vi } from 'vitest';

vi.mock('@/services/i18n', () => ({ t: (key: string) => key }));
vi.mock('@/services/bootstrap', () => ({
  getHydratedData: () => ({
    etfs: [{ ticker: 'TEST', issuer: 'Test', direction: 'neutral', estFlow: 0, volume: 0, priceChange: 0 }],
    summary: { etfCount: 1, totalVolume: 0, totalEstFlow: 0, netDirection: 'NEUTRAL', inflowCount: 0, outflowCount: 0 },
  }),
}));

afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
});

it('does not label neutral ETF flow as an outflow', async () => {
  vi.useFakeTimers();
  const { ETFFlowsPanel } = await import('@/components/ETFFlowsPanel');
  const panel = new ETFFlowsPanel();
  document.body.append(panel.getElement());
  await panel.fetchData();
  await vi.advanceTimersByTimeAsync(150);

  const summary = panel.getElement().querySelector('.etf-summary-value')!;
  expect(summary.classList).toContain('flow-neutral');
  expect(summary.textContent).toBe('components.etfFlows.netFlow');
});
