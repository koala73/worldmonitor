import { beforeEach, expect, it, vi } from 'vitest';
import { WsbTickerScannerPanel } from '@/components/WsbTickerScannerPanel';
import { fetchWsbTickers } from '@/services/wsb-tickers';

vi.mock('@/services/wsb-tickers', () => ({ fetchWsbTickers: vi.fn() }));
const tickers = [{ symbol: 'SYNTH', mentionCount: 12, totalScore: 40, subreddits: ['synthetic'], velocityScore: 25 }];
const flush = () => new Promise(resolve => setTimeout(resolve, 200));
beforeEach(() => { document.body.innerHTML = ''; vi.resetAllMocks(); });

it('shows a cold failure, renders recovery, and preserves rows on an empty refresh', async () => {
  const panel = new WsbTickerScannerPanel();
  document.body.append(panel.getElement());
  vi.mocked(fetchWsbTickers).mockResolvedValueOnce([]).mockResolvedValueOnce(tickers).mockResolvedValueOnce([]);
  expect(await panel.fetchData()).toBe(false);
  expect(panel.getElement().textContent).toContain('No ticker data available yet');
  expect(await panel.fetchData()).toBe(true);
  await flush();
  expect(panel.getElement().textContent).toContain('SYNTH');
  expect(await panel.fetchData()).toBe(false);
  expect(panel.getElement().textContent).toContain('SYNTH');
  expect(panel.getElement().textContent).not.toContain('No ticker data available yet');
  panel.destroy();
});
