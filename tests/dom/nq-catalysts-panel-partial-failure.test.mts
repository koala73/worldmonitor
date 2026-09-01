/**
 * NQ Catalysts mixed-settle fetch: one rejected RPC must not blank the
 * surviving section or mark both sources unavailable.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { initTestI18n } from './helpers/i18n.mts';
import { addLocalDays, localYmd } from '@/utils/local-date';
import {
  NQ_EARNINGS_EMPTY,
  NQ_MACRO_EMPTY,
  NQ_SECTION_UNAVAILABLE,
} from '@/components/nq-catalysts-content';

const { mockGetEconomicCalendar, mockListEarningsCalendar } = vi.hoisted(() => ({
  mockGetEconomicCalendar: vi.fn(),
  mockListEarningsCalendar: vi.fn(),
}));

vi.mock('@/generated/client/worldmonitor/economic/v1/service_client', () => ({
  EconomicServiceClient: class {
    getEconomicCalendar = mockGetEconomicCalendar;
  },
}));

vi.mock('@/generated/client/worldmonitor/market/v1/service_client', () => ({
  MarketServiceClient: class {
    listEarningsCalendar = mockListEarningsCalendar;
  },
}));

import { NqCatalystsPanel } from '@/components/NqCatalystsPanel';

const CONTENT_DEBOUNCE_MS = 150;
const NOW = '2026-08-31T18:05:00.000Z';

function inWindowDates(): { macroDate: string; earningsDate: string } {
  const now = new Date(NOW);
  return {
    macroDate: localYmd(addLocalDays(now, 1)),
    earningsDate: localYmd(addLocalDays(now, 2)),
  };
}

function macroOk() {
  const { macroDate } = inWindowDates();
  return {
    events: [{ event: 'CPI', country: 'US', date: macroDate, impact: 'High' }],
    unavailable: false,
    asOf: '2026-08-31T12:00:00.000Z',
  };
}

function earningsOk() {
  const { earningsDate } = inWindowDates();
  return {
    earnings: [{ symbol: 'AAPL', company: 'Apple', date: earningsDate, hour: 'bmo' }],
    unavailable: false,
    asOf: '2026-08-31T13:00:00.000Z',
  };
}

function mount(panel: NqCatalystsPanel): void {
  document.body.appendChild(panel.getElement());
}

function section(panel: NqCatalystsPanel, heading: string): HTMLElement {
  const headings = [...panel.getElement().querySelectorAll('h3')];
  const match = headings.find((node) => node.textContent === heading);
  const host = match?.closest('.nq-catalysts-section');
  if (!(host instanceof HTMLElement)) {
    throw new Error(`missing NQ catalysts section: ${heading}`);
  }
  return host;
}

async function settle(pending: Promise<unknown>): Promise<boolean> {
  const result = await pending;
  vi.advanceTimersByTime(CONTENT_DEBOUNCE_MS);
  return result === true;
}

beforeAll(async () => {
  await initTestI18n();
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
  mockGetEconomicCalendar.mockReset();
  mockListEarningsCalendar.mockReset();
});

afterEach(() => {
  document.body.innerHTML = '';
  vi.useRealTimers();
});

describe('NqCatalystsPanel partial fetch failures', () => {
  it('keeps influence earnings when the macro calendar rejects', async () => {
    mockGetEconomicCalendar.mockRejectedValueOnce(new Error('macro timeout'));
    mockListEarningsCalendar.mockResolvedValueOnce(earningsOk());

    const panel = new NqCatalystsPanel();
    mount(panel);
    expect(await settle(panel.fetchData())).toBe(true);

    const macro = section(panel, 'US macro');
    const earnings = section(panel, 'NQ influence earnings');
    expect(macro.textContent).toContain(NQ_SECTION_UNAVAILABLE);
    expect(macro.textContent).not.toContain('CPI');
    expect(macro.textContent).not.toContain(NQ_MACRO_EMPTY);
    expect(earnings.textContent).toContain('AAPL');
    expect(earnings.textContent).toContain('Apple');
    expect(earnings.textContent).not.toContain(NQ_SECTION_UNAVAILABLE);
    expect(earnings.textContent).not.toContain(NQ_EARNINGS_EMPTY);
    expect(panel.getElement().querySelector('.panel-error-state')).toBeNull();
    panel.destroy();
  });

  it('keeps US macro when the earnings calendar rejects', async () => {
    mockGetEconomicCalendar.mockResolvedValueOnce(macroOk());
    mockListEarningsCalendar.mockRejectedValueOnce(new Error('earnings timeout'));

    const panel = new NqCatalystsPanel();
    mount(panel);
    expect(await settle(panel.fetchData())).toBe(true);

    const macro = section(panel, 'US macro');
    const earnings = section(panel, 'NQ influence earnings');
    expect(macro.textContent).toContain('CPI');
    expect(macro.textContent).not.toContain(NQ_SECTION_UNAVAILABLE);
    expect(macro.textContent).not.toContain(NQ_MACRO_EMPTY);
    expect(earnings.textContent).toContain(NQ_SECTION_UNAVAILABLE);
    expect(earnings.textContent).not.toContain('AAPL');
    expect(earnings.textContent).not.toContain(NQ_EARNINGS_EMPTY);
    expect(panel.getElement().querySelector('.panel-error-state')).toBeNull();
    panel.destroy();
  });
});
