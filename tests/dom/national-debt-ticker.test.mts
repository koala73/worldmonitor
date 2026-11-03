/**
 * National Debt Clock — ticking math and formatting through the real panel.
 *
 * `getCurrentDebt` and `formatDebt` are private to NationalDebtPanel, so the
 * honest seam is the rendered row: seed entries, control the clock, and read
 * the `.debt-ticker` cells the panel writes. The file this replaced kept
 * local copies of both functions and passed with no production file present
 * (#7770); the copy had also drifted (it took `nowMs` as an argument, the
 * panel reads `Date.now()` and guards a missing baseline).
 *
 * Lives under tests/dom/ because `Panel` needs a DOM and the i18n module
 * graph, both unreachable from the `tsx --test` profile.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { GetNationalDebtResponse, NationalDebtEntry } from '@/generated/client/worldmonitor/economic/v1/service_client';

import { initTestI18n } from './helpers/i18n.mts';

const { mockGetNationalDebtData } = vi.hoisted(() => ({
  mockGetNationalDebtData: vi.fn(),
}));

vi.mock('@/services/economic', () => ({
  getNationalDebtData: mockGetNationalDebtData,
}));

import { NationalDebtPanel } from '@/components/NationalDebtPanel';

const CONTENT_DEBOUNCE_MS = 150;
const TICK_MS = 1000;
const BASELINE = Date.UTC(2024, 0, 1);

function entry(overrides: Partial<NationalDebtEntry> & { iso3: string; debtUsd: number }): NationalDebtEntry {
  return {
    gdpUsd: 0,
    debtToGdp: 0,
    annualGrowth: 0,
    perSecondRate: 0,
    perDayRate: 0,
    baselineTs: String(BASELINE),
    source: 'IMF WEO 2026',
    ...overrides,
  };
}

function response(entries: NationalDebtEntry[]): GetNationalDebtResponse {
  return { entries, seededAt: new Date(BASELINE).toISOString(), unavailable: false };
}

beforeAll(async () => {
  await initTestI18n();
});

let panel: NationalDebtPanel;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(BASELINE);
  mockGetNationalDebtData.mockReset();
  panel = new NationalDebtPanel();
  document.body.appendChild(panel.getElement());
});

afterEach(() => {
  panel.destroy();
  document.body.innerHTML = '';
  vi.useRealTimers();
});

async function load(entries: NationalDebtEntry[]): Promise<void> {
  mockGetNationalDebtData.mockResolvedValueOnce(response(entries));
  await panel.refresh();
  vi.advanceTimersByTime(CONTENT_DEBOUNCE_MS);
}

function tickerText(iso3: string): string {
  const cell = panel.getElement().querySelector<HTMLElement>(`.debt-ticker[data-iso3="${iso3}"]`);
  expect(cell, `row for ${iso3}`).not.toBeNull();
  return cell!.textContent?.trim() ?? '';
}

function globalTickerText(): string {
  return panel.getElement().querySelector<HTMLElement>('.debt-global-ticker')?.textContent?.trim() ?? '';
}

function rowOrder(): string[] {
  return [...panel.getElement().querySelectorAll<HTMLElement>('.debt-row')].map((row) => row.dataset.iso3 ?? '');
}

describe('NationalDebtPanel debt math', () => {
  it('renders the anchored debt at the baseline instant and formats T, B and M bands', async () => {
    await load([
      entry({ iso3: 'USA', debtUsd: 33_600_000_000_000, perSecondRate: 50_000 }),
      entry({ iso3: 'DEU', debtUsd: 913_200_000_000 }),
      entry({ iso3: 'TON', debtUsd: 12_300_000 }),
    ]);
    expect(tickerText('USA')).toBe('$33.6T');
    expect(tickerText('DEU')).toBe('$913.2B');
    expect(tickerText('TON')).toBe('$12.3M');
    expect(globalTickerText()).toBe('$34.5T');
  });

  it('accrues perSecondRate against the wall clock since the baseline', async () => {
    vi.setSystemTime(BASELINE + 3600 * 1000);
    await load([entry({ iso3: 'USA', debtUsd: 33_600_000_000_000, perSecondRate: 100_000_000 })]);
    // 100M/s for one hour is +360B, which rounds the display up a decimal.
    expect(tickerText('USA')).toBe('$34.0T');
  });

  it('keeps a zero-rate entry flat and treats a missing baseline or rate as the anchored figure', async () => {
    vi.setSystemTime(BASELINE + 86_400 * 1000);
    await load([
      entry({ iso3: 'CHE', debtUsd: 1_000_000_000_000 }),
      entry({ iso3: 'NOR', debtUsd: 500_000_000_000, perSecondRate: 1_000_000, baselineTs: '' }),
    ]);
    expect(tickerText('CHE')).toBe('$1.0T');
    expect(tickerText('NOR')).toBe('$500.0B');
  });

  it('ranks by the current debt, so a fast accruer overtakes a larger anchored figure', async () => {
    vi.setSystemTime(BASELINE + 200 * 1000);
    await load([
      entry({ iso3: 'AAA', debtUsd: 1_000_000_000_000 }),
      entry({ iso3: 'BBB', debtUsd: 900_000_000_000, perSecondRate: 1_000_000_000 }),
    ]);
    expect(rowOrder()).toEqual(['BBB', 'AAA']);
    expect(tickerText('BBB')).toBe('$1.1T');
  });

  it('ticks the rendered cells every second without a re-render', async () => {
    await load([entry({ iso3: 'TCK', debtUsd: 999_500_000_000, perSecondRate: 1_000_000_000 })]);
    expect(tickerText('TCK')).toBe('$999.5B');
    vi.advanceTimersByTime(TICK_MS);
    expect(tickerText('TCK')).toBe('$1.0T');
    expect(globalTickerText()).toBe('$1.0T');
  });

  it('shows $0 for a non-positive figure instead of a negative string', async () => {
    await load([entry({ iso3: 'ZZZ', debtUsd: 0 }), entry({ iso3: 'NEG', debtUsd: -5 })]);
    expect(tickerText('ZZZ')).toBe('$0');
    expect(tickerText('NEG')).toBe('$0');
  });
});
