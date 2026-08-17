/**
 * FX panel render behaviour (#6199, #6231).
 *
 * `tests/fx-panel-rows.test.mjs` covers the mappers in isolation. Nothing
 * joined them to the panel, so the decisions that only exist in `FxPanel` were
 * unproven: which tab is shown when one of its data sources is empty, and
 * whether the spot lists stay under separate, correctly-based headings.
 *
 * Both are silent-failure shapes. A panel left on a tab with nothing behind it
 * renders an empty body while data sits one click away, and merging the USD,
 * EUR and RUB lists would quote rows upside down without throwing anything.
 *
 * Raw seeded payloads are pushed through the REAL mappers into a REAL mounted
 * panel — no hand-built row objects — so a mapper change that breaks the panel
 * surfaces here rather than passing both suites separately.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { degradedSources, toEurSpotRows, toFxStressRows, toRubQuoteRows, toUsdSpotRows } from '@/services/economic/fx-rates';

import { initTestI18n, tt } from './helpers/i18n.mts';

const { mockGetFxPanelData } = vi.hoisted(() => ({ mockGetFxPanelData: vi.fn() }));

vi.mock('@/services/economic', () => ({
  getFxPanelData: mockGetFxPanelData,
}));

const { FxPanel } = await import('@/components/FxPanel');

/** The shape scripts/seed-fx-yoy.mjs publishes. */
const YOY_PAYLOAD = {
  rates: [
    { countryCode: 'CH', currency: 'CHF', yoyChange: 1.4, drawdown24m: -2.1, peakRate: 1.2, peakDate: '2025-01-01', troughRate: 1.1, troughDate: '2025-06-01', asOf: '2026-08-01' },
    { countryCode: 'AR', currency: 'ARS', yoyChange: -38.4, drawdown24m: -41.0, peakRate: 0.00117, peakDate: '2024-09-01', troughRate: 0.00069, troughDate: '2026-07-01', asOf: '2026-08-01' },
    { countryCode: 'TR', currency: 'TRY', yoyChange: -28.4, drawdown24m: -30.1, peakRate: 0.031, peakDate: '2024-08-01', troughRate: 0.022, troughDate: '2026-06-01', asOf: '2026-08-01' },
  ],
  fetchedAt: '2026-08-05T06:30:00.000Z',
};

/**
 * The flat map scripts/seed-fx-rates.mjs publishes.
 * LBP is the smallest real value in the feed (~1.12e-5) and inverts to ~89,000
 * — the only fixture that reaches formatRate's >=1000 grouping branch, which is
 * exactly the branch a collapsed currency renders through.
 */
const USD_PAYLOAD = { USD: 1, JPY: 0.0067, GBP: 1.27, LBP: 0.0000112 };

/** The rates array getEcbFxRatesData() returns. */
const ECB_RATES = [
  { pair: 'EURUSD', rate: 1.148, date: '2026-08-04', change1d: 0.12 },
  { pair: 'EURJPY', rate: 171.2, date: '2026-08-04', change1d: -0.31 },
];

/**
 * The map scripts/seed-cbr-rates.mjs:363 publishes — RUB per ONE unit of the
 * listed currency. JPY's rate (~0.52) is the differentiating case: it carries
 * CBR's per-100 Nominal, and appearing in a USD-or-EUR list would read as a
 * currency worth half a ruble rather than half a ruble per yen.
 */
const RUB_PAYLOAD = {
  quoteCurrency: 'RUB',
  rateUnit: 'RUB per 1 unit of the listed currency',
  effectiveDate: '2026-08-05',
  rates: {
    USD: { rate: 81.1291, valuePerNominal: 81.1291, nominal: 1, name: '', numCode: '840', id: '', change1d: 0.32 },
    JPY: { rate: 0.515171, valuePerNominal: 51.5171, nominal: 100, name: '', numCode: '392', id: '', change1d: 0.0012 },
    KZT: { rate: 0.17, valuePerNominal: 0.17, nominal: 1, name: '', numCode: '398', id: '', change1d: -0.01 },
  },
  keyRate: { rate: 14, observedAt: '2026-08-04', previousRate: 14, changedAt: '2026-07-24', change: 0 },
  updatedAt: '2026-08-05T06:30:00.000Z',
  seededAt: 1,
};

/**
 * Overrides are typed `unknown` on purpose: the mappers accept whatever the
 * cache hands them, and a test that can only pass a payload matching the happy
 * fixture cannot express "the seed came back empty" — the case these guards
 * exist for.
 */
function rows(overrides: { yoy?: unknown; usd?: unknown; ecb?: unknown; rub?: unknown } = {}) {
  const { yoy = YOY_PAYLOAD, usd = USD_PAYLOAD, ecb = ECB_RATES, rub = RUB_PAYLOAD } = overrides;
  const rowSet = {
    stress: toFxStressRows(yoy),
    usd: toUsdSpotRows(usd),
    eur: toEurSpotRows(ecb),
    rub: toRubQuoteRows(rub),
  };
  // The REAL function getFxPanelData uses — reimplementing it here would let the
  // panel tests pass against logic production does not run.
  return { ...rowSet, degraded: degradedSources(rowSet) };
}

let panel: InstanceType<typeof FxPanel>;

/**
 * `Panel.setContentHtml` debounces every render behind a 150ms timer
 * (`Panel.ts:142`), so nothing is in the DOM when `fetchData()` resolves.
 * Every test runs on fake timers and flushes past that window; without this the
 * whole file asserts against an empty panel and fails uniformly.
 */
const CONTENT_DEBOUNCE_MS = 150;

async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(CONTENT_DEBOUNCE_MS + 1);
}

/** Click a tab and flush the debounced re-render it triggers. */
async function clickTab(tab: string): Promise<void> {
  const el = tabs().find((t) => t.dataset.tab === tab);
  if (!el) throw new Error(`no "${tab}" tab rendered; got [${tabs().map((t) => t.dataset.tab).join(', ')}]`);
  el.click();
  await flush();
}

/** Re-run the loader against the SAME panel, as the 6h refresh tick does. */
async function reload(data: ReturnType<typeof rows>): Promise<void> {
  mockGetFxPanelData.mockResolvedValue(data);
  await panel.fetchData();
  await flush();
}

async function mount(data: ReturnType<typeof rows> | Error): Promise<void> {
  if (data instanceof Error) mockGetFxPanelData.mockRejectedValue(data);
  else mockGetFxPanelData.mockResolvedValue(data);
  panel = new FxPanel();
  document.body.appendChild(panel.getElement());
  await panel.fetchData();
  await flush();
}

const body = (): string => panel.getElement().textContent ?? '';
const tabs = (): HTMLElement[] => Array.from(panel.getElement().querySelectorAll('.panel-tab'));
const activeTab = (): HTMLElement | undefined => tabs().find((el) => el.classList.contains('active'));
const dataRows = (): HTMLElement[] => Array.from(panel.getElement().querySelectorAll('tbody tr'));

beforeAll(async () => {
  await initTestI18n();
  // The panel's own copy must resolve too — the shared probe only covers the
  // export-gate keys, so an unregistered `components.fx.*` block would leave
  // every assertion below comparing `undefined` to `undefined`.
  expect(tt('components.fx.tabs.stress')).toBe('FX Stress');
  expect(tt('panels.fx')).toBe('FX Rates');
});

beforeEach(() => {
  document.body.replaceChildren();
  mockGetFxPanelData.mockReset();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe('FX stress tab', () => {
  it('opens on the stress tab and lists the worst drawdown first', async () => {
    await mount(rows());
    expect(activeTab()?.dataset.tab).toBe('stress');
    // Insertion order is CHF, ARS, TRY; display order must be by drawdown.
    expect(dataRows().map((r) => r.querySelector('.fx-ccy-code')?.textContent))
      .toEqual(['ARS', 'TRY', 'CHF']);
  });

  it('marks only the currencies past the -15% methodology threshold', async () => {
    await mount(rows());
    const stressed = dataRows()
      .filter((r) => r.classList.contains('fx-stressed'))
      .map((r) => r.querySelector('.fx-ccy-code')?.textContent);
    expect(stressed).toEqual(['ARS', 'TRY']);
  });

  it('renders depreciation as a negative, not an absolute value', async () => {
    await mount(rows());
    const [ars] = dataRows();
    expect(ars).toBeDefined();
    expect(ars?.textContent).toContain('-41.0%');
    expect(ars?.textContent).toContain('-38.4%');
    expect(ars?.querySelector('.change-negative')).not.toBeNull();
  });

  it('shows a zero drawdown unsigned and neutral, never as a green gain', async () => {
    // Live economic:fx:yoy:v1 carries AED at drawdown24m: 0 — the seeder seeds
    // worstDrawdown = 0 and only ever lowers it, so a currency that merely
    // appreciated publishes exactly 0. A "+0.0%" in green would show a gain in
    // a column that by construction can only be zero or negative.
    await mount(rows({
      yoy: { rates: [{ countryCode: 'AE', currency: 'AED', yoyChange: 0, drawdown24m: 0, asOf: '2026-08-01' }] },
    }));
    const [aed] = dataRows();
    expect(aed?.textContent).toContain('0.0%');
    expect(aed?.textContent).not.toContain('+0.0%');
    expect(aed?.querySelector('.change-positive')).toBeNull();
    expect(aed?.querySelector('.fx-flat')).not.toBeNull();
    expect(aed?.classList.contains('fx-stressed')).toBe(false);
  });

  it('shows the peak and trough RATES, not just their dates', async () => {
    // #6199 asks for "peak/trough with dates". The dates alone say when the
    // collapse happened but not how far it went — 0.00117 -> 0.00069 is the
    // magnitude the summary percentage only abbreviates.
    await mount(rows());
    const ars = dataRows().find((r) => r.querySelector('.fx-ccy-code')?.textContent === 'ARS');
    const window = ars?.querySelector('.fx-window-rates')?.textContent ?? '';
    expect(window).toContain('0.001170');
    expect(window).toContain('0.0006900');
    expect(ars?.querySelector('.fx-window-dates')?.textContent).toContain('2024-09-01');
    expect(ars?.querySelector('.fx-window-dates')?.textContent).toContain('2026-07-01');
  });

  it('shows a date span when rows disagree, not just the freshest date', async () => {
    // Each asOf is that currency's own newest Yahoo bar and the seeder skips a
    // failed currency rather than failing the run, so showing only the newest
    // would present the freshest row's date as the whole table's freshness and
    // hide a currency frozen a week earlier.
    await mount(rows({
      yoy: { rates: [
        { countryCode: 'AR', currency: 'ARS', yoyChange: -38, drawdown24m: -41, asOf: '2026-08-01' },
        { countryCode: 'TR', currency: 'TRY', yoyChange: -28, drawdown24m: -30, asOf: '2026-07-24' },
      ] },
    }));
    expect(body()).toContain('2026-07-24 → 2026-08-01');
  });

  it('shows a single date when every row agrees', async () => {
    await mount(rows());
    expect(body()).toContain('2026-08-01');
    expect(body()).not.toContain('→ 2026-08-01');
  });

  it('counts the stressed currencies against the full set', async () => {
    await mount(rows());
    expect(body()).toContain('2 of 3 currencies past -15%');
  });
});

describe('spot tab', () => {
  it('keeps the USD and EUR lists under separate, differently-based headings', async () => {
    await mount(rows());
    await clickTab('spot');

    const titles = Array.from(panel.getElement().querySelectorAll('.fx-section-title'))
      .map((el) => el.textContent?.trim());
    expect(titles).toEqual([tt('components.fx.usdBase'), tt('components.fx.eurBase')]);

    // Two tables, never one merged list — the bases are opposite.
    expect(panel.getElement().querySelectorAll('table').length).toBe(2);
  });

  it('quotes the yen the way a reader expects, with the raw direction beside it', async () => {
    await mount(rows());
    await clickTab('spot');

    const jpy = dataRows().find((r) => r.querySelector('.fx-ccy-code')?.textContent === 'JPY');
    // 1 USD = ~149 JPY, and the seeded value (USD per yen) is the small one.
    expect(jpy?.textContent).toContain('149.25');
    expect(jpy?.querySelector('.fx-inverse')?.textContent).toBe('0.006700');
  });

  it('renders a collapsed currency as a grouped whole number, not scientific notation', async () => {
    // The differentiating case: a currency worth ~1e-5 USD inverts to tens of
    // thousands per dollar. Rendering that as "89285.714285714" or "8.93e+4"
    // makes the panel's headline column unreadable.
    await mount(rows());
    await clickTab('spot');
    const lbp = dataRows().find((r) => r.querySelector('.fx-ccy-code')?.textContent === 'LBP');
    expect(lbp?.textContent).toContain('89,286');
    expect(lbp?.textContent).not.toMatch(/e[+-]\d/i);
    expect(lbp?.querySelector('.fx-inverse')?.textContent).toBe('0.00001120');
  });

  it('renders the ECB day change as an absolute delta, never a percentage', async () => {
    // seed-ecb-fx-rates.mjs:98 computes `+(rate - prev.value).toFixed(6)` — a
    // difference in rate units. Printing "%" here would report EURJPY's 0.85
    // move as "0.9%" when it is really 0.50%, and would flatten the five
    // sub-2.0 pairs to "0.0%". MarketPanel.ts:531 renders the same field
    // unsuffixed; the two surfaces must not disagree.
    await mount(rows({ ecb: [{ pair: 'EURJPY', rate: 171.2, change1d: 0.85 }] }));
    await clickTab('spot');
    expect(body()).toContain('EUR/JPY');
    expect(body()).toContain('+0.8500');
    expect(body()).not.toContain('+0.9%');
    expect(body()).not.toMatch(/[+-]?\d+\.\d%/);
  });

  it('shows a zero day change as unsigned and neutral, not a green gain', async () => {
    await mount(rows({ ecb: [{ pair: 'EURGBP', rate: 0.861, change1d: 0 }] }));
    await clickTab('spot');
    expect(body()).toContain('EUR/GBP');
    expect(body()).toContain('0.0000');
    expect(body()).not.toContain('+0.0000');
    expect(panel.getElement().querySelector('.change-positive')).toBeNull();
  });
});

describe('rub tab', () => {
  it('renders a RUB-base table with the direction named in the heading', async () => {
    await mount(rows());
    await clickTab('rub');

    // The one column a reader can silently misread: the heading must name the
    // direction, not leave it to an icon or column label alone.
    expect(body()).toContain(tt('components.fx.rubBase'));
    // USD reads ~81.13 RUB — the magnitude that inverts to "1 RUB buys 0.012 USD".
    const usd = dataRows().find((r) => r.querySelector('.fx-ccy-code')?.textContent === 'USD');
    expect(usd?.textContent).toContain('81.1291');
    // JPY is quoted per-100 by CBR; the mapped per-unit value (~0.5152) is what
    // must render, not the raw 51.5171.
    const jpy = dataRows().find((r) => r.querySelector('.fx-ccy-code')?.textContent === 'JPY');
    expect(jpy?.textContent).toContain('0.5152');
    expect(jpy?.textContent).not.toContain('51.5171');
  });

  it('renders the CBR day change as an absolute delta, never a percentage', async () => {
    // The seeder's change1d is `cleanFloat(rate - prior.rate)` in RUB per unit.
    // Printing it with a % would report USD's 0.32 RUB move as "0.3%" — a 0.4%
    // true move — and would flatten sub-1.0 pairs (KZT -0.01) to "0.0%".
    await mount(rows());
    await clickTab('rub');
    expect(body()).toContain('+0.3200');
    expect(body()).not.toMatch(/[+-]?\d+\.\d%/);
  });

  it('shows a zero rate change as unsigned and neutral, not a green gain', async () => {
    await mount(rows({
      rub: {
        ...RUB_PAYLOAD,
        rates: { USD: { rate: 81.1291, valuePerNominal: 81.1291, nominal: 1, name: '', numCode: '840', id: '', change1d: 0 } },
      },
    }));
    await clickTab('rub');
    expect(body()).toContain('0.0000');
    expect(body()).not.toContain('+0.0000');
    expect(panel.getElement().querySelector('.change-positive')).toBeNull();
  });

  it('renders a row with no change as a dash rather than dropping the rate', async () => {
    await mount(rows({
      rub: {
        ...RUB_PAYLOAD,
        rates: { USD: { rate: 81.1291, valuePerNominal: 81.1291, nominal: 1, name: '', numCode: '840', id: '' } },
      },
    }));
    await clickTab('rub');
    expect(body()).toContain('81.1291');
    expect(panel.getElement().querySelector('.fx-na')).not.toBeNull();
  });
});

describe('tab fallback when a source is empty', () => {
  it('opens on spot when the fx:yoy seed returned nothing', async () => {
    // Without this the panel opens on its default tab and renders an empty
    // body, while the spot rates sit one unmarked click away.
    await mount(rows({ yoy: { rates: [] } }));
    expect(activeTab()?.dataset.tab).toBe('spot');
    expect(tabs().map((el) => el.dataset.tab)).toEqual(['spot', 'rub']);
    expect(body()).toContain('EUR/USD');
  });

  it('leaves the spot tab when a later refresh drops both spot sources', async () => {
    // The mount-time case below cannot exercise this: `stress` is already the
    // default tab, so the spot->stress guard never runs. Only a user sitting on
    // the spot tab through a refresh that loses both spot sources reaches it,
    // and without the guard they are left staring at an empty body. With the
    // RUB table present the guard now lands on RUB, not straight back on
    // stress — the next surviving source by tab order.
    await mount(rows());
    await clickTab('spot');
    expect(activeTab()?.dataset.tab).toBe('spot');

    await reload(rows({ usd: {}, ecb: [] }));
    expect(activeTab()?.dataset.tab).toBe('rub');
    expect(dataRows().length).toBe(3);
  });

  it('opens on stress when both spot sources returned nothing', async () => {
    await mount(rows({ usd: {}, ecb: [] }));
    expect(activeTab()?.dataset.tab).toBe('stress');
    expect(tabs().map((el) => el.dataset.tab)).toEqual(['stress', 'rub']);
    expect(body()).toContain('ARS');
  });

  it('landing on RUB when stress and both spot sources all failed', async () => {
    // A chain of fallbacks: stress -> spot -> rub. Without RUB the panel would
    // bounce back to stress and render an empty body while the CBR table sat
    // one click off-screen.
    await mount(rows({ yoy: { rates: [] }, usd: {}, ecb: [] }));
    expect(activeTab()?.dataset.tab).toBe('rub');
    expect(tabs().map((el) => el.dataset.tab)).toEqual(['rub']);
    expect(body()).toContain('81.1291');
  });

  it('skips the RUB tab entirely when the CBR table returned nothing', async () => {
    // A dead cbrRates key must not strand the panel on an empty table; the
    // panel opens on stress (default) with the RUB tab absent.
    await mount(rows({ rub: {} }));
    expect(activeTab()?.dataset.tab).toBe('stress');
    expect(tabs().map((el) => el.dataset.tab)).toEqual(['stress', 'spot']);
    expect(body()).toContain('ARS');
  });

  it('still offers spot when only one of the two spot sources is empty', async () => {
    await mount(rows({ usd: {} }));
    await clickTab('spot');
    expect(panel.getElement().querySelectorAll('table').length).toBe(1);
    expect(body()).toContain(tt('components.fx.eurBase'));
    expect(body()).not.toContain(tt('components.fx.usdBase'));
  });

  it('treats all four sources coming back empty as an outage, not as "no data"', async () => {
    // ensureHydrated collapses fetch/timeout/JSON errors into undefined, so a
    // dead bootstrap looks exactly like a miss here. Claiming "No data" would
    // assert something we cannot know AND skip the retry that recovers it —
    // 45 currencies, 47 USD rates, 7 ECB pairs and 54 CBR pairs are never all
    // legitimately absent at once.
    vi.useFakeTimers();
    try {
      await mount(rows({ yoy: { rates: [] }, usd: {}, ecb: [], rub: {} }));
      expect(panel.getElement().querySelector('.panel-error-state')).not.toBeNull();
      expect(panel.getElement().querySelector('.panel-empty')).toBeNull();
      expect(tabs()).toHaveLength(0);

      // and it must actually retry, not just look broken
      expect(panel.getElement().querySelector('.panel-error-countdown')).not.toBeNull();
      mockGetFxPanelData.mockResolvedValue(rows());
      await vi.advanceTimersByTimeAsync(16_000);
      expect(dataRows()).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('partial outage', () => {
  it('names the dead source instead of dropping its table silently', async () => {
    // Without the notice, a dead fx:yoy seed is indistinguishable from a panel
    // that never had a stress tab — the tab guard even switches away from it,
    // so nothing looks wrong and the reader has no reason to suspect a gap.
    await mount(rows({ yoy: { rates: [] } }));
    const notice = panel.getElement().querySelector('.fx-degraded');
    expect(notice).not.toBeNull();
    expect(notice?.textContent).toContain(tt('components.fx.source.stress'));
    // ...and does not accuse the sources that are actually fine
    expect(notice?.textContent).not.toContain(tt('components.fx.source.eur'));
    expect(notice?.textContent).not.toContain(tt('components.fx.source.rub'));
  });

  it('names a dead CBR table as degraded, with its own source label', async () => {
    // RUB is the newest tab; a dead cbrRates key must be named, not left as a
    // tab that simply isn't there.
    await mount(rows({ rub: {} }));
    const notice = panel.getElement().querySelector('.fx-degraded');
    expect(notice).not.toBeNull();
    expect(notice?.textContent).toContain(tt('components.fx.source.rub'));
    expect(notice?.textContent).not.toContain(tt('components.fx.source.stress'));
  });

  it('does not show the notice when every source is healthy', async () => {
    await mount(rows());
    expect(panel.getElement().querySelector('.fx-degraded')).toBeNull();
  });

  it('retries a partial outage instead of waiting out the 6h refresh', async () => {
    // The all-empty case gets a retry from the error state. A partial outage
    // renders fine and would otherwise leave the dead source dead until the
    // next scheduled tick.
    await mount(rows({ yoy: { rates: [] } }));
    expect(mockGetFxPanelData).toHaveBeenCalledTimes(1);

    mockGetFxPanelData.mockResolvedValue(rows());
    await vi.advanceTimersByTimeAsync(61_000);
    expect(mockGetFxPanelData).toHaveBeenCalledTimes(2);
    expect(panel.getElement().querySelector('.fx-degraded')).toBeNull();
    // ...and lands the reader back on the tab the outage forced them off,
    // rather than leaving them parked on Spot with the recovered data hidden.
    expect(activeTab()?.dataset.tab).toBe('stress');
    expect(dataRows()).toHaveLength(3);
  });

  it('does not override a tab the user chose, even one they re-picked mid-outage', async () => {
    // This has to start from a FORCED tab, or it proves nothing: with healthy
    // data tabForced is already false, so the restore branch never runs and the
    // assertion holds no matter what handleClick does.
    await mount(rows({ yoy: { rates: [] } }));      // forced onto spot
    expect(activeTab()?.dataset.tab).toBe('spot');

    await clickTab('spot');                          // user deliberately picks it
    await reload(rows());                            // stress recovers

    // Their choice outranks the restore — they stay on Spot.
    expect(activeTab()?.dataset.tab).toBe('spot');
    expect(tabs()).toHaveLength(3);                  // and stress/rub are available again
  });

  it('stops retrying once the panel is destroyed', async () => {
    // A timer that outlives the panel is a leak that keeps refetching forever.
    await mount(rows({ yoy: { rates: [] } }));
    panel.destroy();
    await vi.advanceTimersByTimeAsync(61_000);
    expect(mockGetFxPanelData).toHaveBeenCalledTimes(1);
  });
});

describe('concurrency', () => {
  it('collapses overlapping fetches instead of running them in parallel', async () => {
    // The scheduler, the error countdown and the degraded retry can all fire
    // near each other; without the latch they race and the last to resolve wins.
    //
    // The load MUST be held open to prove anything. An immediately-resolving
    // mock lets each call finish before the next begins, so the calls never
    // actually overlap and the assertion passes with the latch deleted — this
    // test was vacuous until the deferred promise below was introduced.
    await mount(rows());
    expect(mockGetFxPanelData).toHaveBeenCalledTimes(1);

    let release!: (value: ReturnType<typeof rows>) => void;
    mockGetFxPanelData.mockImplementation(
      () => new Promise((resolve) => { release = resolve; }),
    );

    const first = panel.fetchData();
    // fetchData awaits a dynamic import before it reaches the loader, so a
    // single microtask is not enough to get it in flight.
    await vi.advanceTimersByTimeAsync(0);
    const second = panel.fetchData();   // starts while the first is still open
    const third = panel.fetchData();

    expect(mockGetFxPanelData).toHaveBeenCalledTimes(2);  // mount + first only

    release(rows());
    await Promise.all([first, second, third]);
    expect(mockGetFxPanelData).toHaveBeenCalledTimes(2);
  });

  it('releases the latch after a failure, so the panel can recover', async () => {
    // A latch left set on the error path would wedge the panel permanently —
    // the same shape as the refresh-scheduler in-flight bug this repo has hit.
    await mount(new Error('boom'));
    mockGetFxPanelData.mockResolvedValue(rows());
    await panel.fetchData();
    await flush();
    expect(dataRows()).toHaveLength(3);
  });
});

describe('failure', () => {
  it('shows an error state that auto-retries into the loader, not a blank panel', async () => {
    vi.useFakeTimers();
    try {
      await mount(new Error('bootstrap unreachable'));
      expect(panel.getElement().querySelector('.panel-error-state')).not.toBeNull();
      expect(panel.getElement().querySelector('tbody')).toBeNull();

      // Panel.showError only schedules a retry when a callback was passed. A
      // countdown-less error state is a dead panel until the 6h refresh tick.
      expect(panel.getElement().querySelector('.panel-error-countdown')).not.toBeNull();

      // First backoff is min(15 * 2**0, 180) = 15s.
      mockGetFxPanelData.mockResolvedValue(rows());
      await vi.advanceTimersByTimeAsync(16_000);
      expect(mockGetFxPanelData).toHaveBeenCalledTimes(2);
      expect(dataRows()).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });
});
