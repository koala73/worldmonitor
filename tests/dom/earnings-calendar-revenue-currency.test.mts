/**
 * #11269: Finnhub's earnings calendar carries no currency or company name.
 * Revenue must not be labelled in dollars unless the reporting currency is
 * USD, and a row whose company is only the ticker must not print it twice.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { initTestI18n } from './helpers/i18n.mts';

const { mockListEarningsCalendar } = vi.hoisted(() => ({ mockListEarningsCalendar: vi.fn() }));

vi.mock('@/services/generated-rpc-clients', () => ({
  MarketServiceClient: class {
    listEarningsCalendar = mockListEarningsCalendar;
  },
}));

const { EarningsCalendarPanel } = await import('@/components/EarningsCalendarPanel');

function entry(symbol: string, company: string, revenueEstimate: number, revenueCurrency: string) {
  return {
    symbol, company, date: '2026-12-01', hour: 'bmo',
    epsEstimate: -0.35, revenueEstimate, epsActual: 0, revenueActual: 0,
    hasActuals: false, surpriseDirection: '', revenueCurrency,
  };
}

beforeAll(async () => {
  await initTestI18n();
});
beforeEach(() => {
  document.body.replaceChildren();
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe('earnings calendar revenue currency and names', () => {
  it('labels revenue in its reporting currency and prints a bare ticker once', async () => {
    mockListEarningsCalendar.mockResolvedValue({
      earnings: [
        entry('NIO', 'NIO Inc.', 33_668_882_128, 'CNY'),
        entry('AAPL', 'Apple Inc.', 124_000_000_000, 'USD'),
        entry('DIDIY', 'DIDIY', 66_724_743_120, ''),
      ],
      unavailable: false,
    });
    const panel = new EarningsCalendarPanel();
    document.body.appendChild(panel.getElement());
    await panel.fetchData();
    await vi.advanceTimersByTimeAsync(151);
    const text = panel.getElement().textContent!.replace(/\s+/g, ' ');

    expect(text).toContain('NIO Inc.');
    expect(text).toContain('CNY 33.7B est');
    expect(text).toContain('$124.0B est');
    expect(text).toMatch(/[^$]66\.7B est/);
    expect(text).not.toContain('$33.7B');
    expect(text).not.toContain('$66.7B');
    expect(text.match(/DIDIY/g)).toHaveLength(1);
  });
});
