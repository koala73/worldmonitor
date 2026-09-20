import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { LiquidityShiftsPanel } from '@/components/LiquidityShiftsPanel';
import { initTestI18n } from './helpers/i18n.mts';
const hostile = '<img src=x onerror="alert(1)">';
vi.mock('@/generated/client/worldmonitor/market/v1/service_client', () => ({
  MarketServiceClient: class {
    async getCotPositioning() { return { reportDate: hostile, instruments: [{ code: 'CL', name: hostile, assetManagerLong: 20, assetManagerShort: 10 }] }; }
    async listMarketQuotes() { return { quotes: [] }; }
  },
}));
beforeAll(initTestI18n);
afterEach(() => { vi.useRealTimers(); document.body.replaceChildren(); });
it('renders the COT report date and instrument name as text through the panel', async () => {
  vi.useFakeTimers();
  const panel = new LiquidityShiftsPanel();
  document.body.append(panel.getElement());
  expect(await panel.fetchData()).toBe(true);
  vi.advanceTimersByTime(150);
  expect(panel.getElement().querySelector('img')).toBeNull();
  expect(panel.getElement().querySelector('.liquidity-report-date')!.textContent).toContain(hostile);
  panel.destroy();
});
