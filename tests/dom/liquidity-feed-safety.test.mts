import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { LiquidityShiftsPanel } from '@/components/LiquidityShiftsPanel';
import { initTestI18n } from './helpers/i18n.mts';
const hostile = '<img src=x onerror="alert(1)">';
const cot = vi.hoisted(() => ({ reportDate: '', name: '', available: true }));
vi.mock('@/generated/client/worldmonitor/market/v1/service_client', () => ({
  MarketServiceClient: class {
    async getCotPositioning() {
      return {
        reportDate: cot.reportDate,
        unavailable: !cot.available,
        instruments: cot.available ? [{ code: 'CL', name: cot.name, reportDate: cot.reportDate, assetManagerLong: 20, assetManagerShort: 10 }] : [],
      };
    }
    async listMarketQuotes() { return { quotes: [] }; }
  },
}));
beforeAll(initTestI18n);
afterEach(() => { vi.useRealTimers(); document.body.replaceChildren(); Object.assign(cot, { reportDate: '', name: '', available: true }); });
async function render(): Promise<{ panel: LiquidityShiftsPanel; ok: boolean }> {
  vi.useFakeTimers();
  const panel = new LiquidityShiftsPanel();
  document.body.replaceChildren(panel.getElement());
  const ok = await panel.fetchData();
  vi.advanceTimersByTime(150);
  return { panel, ok };
}
it('renders the COT report date and instrument name as text through the panel', async () => {
  Object.assign(cot, { reportDate: hostile, name: hostile });
  const { panel, ok } = await render();
  expect(ok).toBe(true);
  expect(panel.getElement().querySelector('img')).toBeNull();
  expect(panel.getElement().querySelector('.liquidity-report-date')!.textContent).toContain(hostile);
  panel.destroy();
});
it('shows report dates verbatim once, hides a missing date, and keeps missing data unavailable', async () => {
  // Exact text catches double escaping (`&amp;` shown to the reader) as well as injection.
  cot.reportDate = '<b data-cot-injected>bad & "date"</b>';
  let { panel, ok } = await render();
  expect(ok).toBe(true);
  expect(panel.getElement().querySelector('[data-cot-injected]')).toBeNull();
  expect(panel.getElement().querySelector('.liquidity-report-date')!.textContent).toBe(`COT report date: ${cot.reportDate}`);
  panel.destroy();

  cot.reportDate = '2026-08-04';
  ({ panel, ok } = await render());
  expect(ok).toBe(true);
  expect(panel.getElement().querySelector('.liquidity-report-date')!.textContent).toBe('COT report date: 2026-08-04');
  panel.destroy();

  cot.reportDate = '';
  ({ panel, ok } = await render());
  expect(ok).toBe(true);
  expect(panel.getElement().querySelector('.liquidity-report-date')).toBeNull();
  expect(panel.getElement().querySelectorAll('.liquidity-row')).toHaveLength(1);
  panel.destroy();

  cot.available = false;
  ({ panel, ok } = await render());
  expect(ok).toBe(false);
  expect(panel.getElement().querySelector('.liquidity-report-date')).toBeNull();
  expect(panel.getElement().textContent).toContain('unavailable');
  panel.destroy();
});
