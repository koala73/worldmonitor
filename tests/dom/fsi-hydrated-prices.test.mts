import { expect, it, vi } from 'vitest';

vi.mock('@/services/i18n', () => ({ t: (key: string) => key }));
vi.mock('@/services/bootstrap', () => ({
  getHydratedData: (key: string) => key === 'fearGreedIndex'
    ? { headerMetrics: { fsi: { value: 1.1, label: 'Low Stress', hygPrice: 82.5, tltPrice: 91.25 }, vix: { value: 20 }, hySpread: { value: 3.5 } } }
    : { latestValue: 0.2, latestDate: '2026-09-15', stale: false },
}));

it('uses the hydrated FSI metric prices before an RPC fallback', async () => {
  const { FSIPanel } = await import('@/components/FSIPanel');
  const render = vi.spyOn(FSIPanel.prototype as never, 'render' as never);
  const panel = new FSIPanel();

  await panel.fetchData();

  expect(render).toHaveBeenCalledWith(expect.objectContaining({ hygPrice: 82.5, tltPrice: 91.25 }), expect.anything());
});
