import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import {
  fetchDividendProfile,
  buildAnalysisResponse,
  buildTechnicalSnapshot,
  getFallbackOverlay,
  type AnalystData,
  type DividendProfile,
} from '../server/worldmonitor/market/v1/analyze-stock.ts';

const emptyAnalystData: AnalystData = {
  analystConsensus: { strongBuy: 0, buy: 0, hold: 0, sell: 0, strongSell: 0, total: 0, period: '' },
  priceTarget: { numberOfAnalysts: 0 },
  recentUpgrades: [],
};

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function makeDividendChartPayload(dividends: Record<string, { amount: number; date: number }>) {
  return {
    chart: {
      result: [
        {
          meta: { currency: 'USD' },
          timestamp: [1_700_000_000],
          events: { dividends },
          indicators: { quote: [{ open: [100], high: [101], low: [99], close: [100], volume: [1_000_000] }] },
        },
      ],
    },
  };
}

function makeQuarterlyDividends(): Record<string, { amount: number; date: number }> {
  const now = Math.floor(Date.now() / 1000);
  const oneYear = 365.25 * 24 * 3600;
  const divs: Record<string, { amount: number; date: number }> = {};
  for (let y = 0; y < 5; y++) {
    for (let q = 0; q < 4; q++) {
      const ts = Math.floor(now - (y * oneYear) + (q * oneYear / 4));
      const amount = 0.5 + y * 0.05;
      divs[String(ts)] = { amount, date: ts };
    }
  }
  return divs;
}

describe('fetchDividendProfile', () => {
  it('returns empty profile when no dividend events', async () => {
    globalThis.fetch = (async () => {
      return new Response(JSON.stringify({ chart: { result: [{ meta: {}, events: {} }] } }), { status: 200 });
    }) as typeof fetch;
    const profile = await fetchDividendProfile('GOOG', 170);
    assert.equal(profile.dividendYield, 0);
    assert.equal(profile.dividendFrequency, '');
    assert.equal(profile.dividendCagr, 0);
  });

  it('returns empty profile on fetch failure', async () => {
    globalThis.fetch = (async () => {
      return new Response('', { status: 500 });
    }) as typeof fetch;
    const profile = await fetchDividendProfile('FAIL', 100);
    assert.equal(profile.dividendYield, 0);
  });

  it('computes yield, frequency, and CAGR from quarterly dividends', async () => {
    const divs = makeQuarterlyDividends();
    globalThis.fetch = (async () => {
      return new Response(JSON.stringify(makeDividendChartPayload(divs)), { status: 200 });
    }) as typeof fetch;
    const profile = await fetchDividendProfile('JNJ', 160);
    assert.ok(profile.dividendYield > 0, 'yield should be positive');
    assert.equal(profile.dividendFrequency, 'Quarterly');
    assert.ok(profile.exDividendDate > 0, 'ex-dividend date should be set');
    assert.ok(profile.trailingAnnualDividendRate > 0, 'trailing rate should be positive');
  });

  it('produces a non-zero CAGR for a quarterly payer with several full calendar years', async () => {
    // Build quarterly dividends anchored at known, past calendar years.
    // Month-count gating (pre-fix) discarded years with < 10 distinct
    // months, which dropped every non-monthly payer's first/last full
    // year and collapsed CAGR to 0.
    const currentYear = new Date().getFullYear();
    const divs: Record<string, { amount: number; date: number }> = {};
    // Four fully completed prior calendar years, growing 0.50 -> 0.65.
    const startYear = currentYear - 4;
    for (let yearIndex = 0; yearIndex < 4; yearIndex++) {
      const year = startYear + yearIndex;
      const amount = 0.50 + yearIndex * 0.05;
      for (let q = 0; q < 4; q++) {
        const month = q * 3;
        const ts = Math.floor(Date.UTC(year, month, 15) / 1000);
        divs[String(ts)] = { amount, date: ts };
      }
    }
    globalThis.fetch = (async () => {
      return new Response(JSON.stringify(makeDividendChartPayload(divs)), { status: 200 });
    }) as typeof fetch;
    const profile = await fetchDividendProfile('KO', 100);
    assert.equal(profile.dividendFrequency, 'Quarterly');
    assert.ok(
      profile.dividendCagr > 0,
      `quarterly payer should have non-zero CAGR; got ${profile.dividendCagr}`,
    );
    // (0.65 / 0.50) ^ (1/3) - 1 ~= 9.14% — round to 1dp.
    assert.ok(
      profile.dividendCagr > 8 && profile.dividendCagr < 10,
      `CAGR should be roughly 9%; got ${profile.dividendCagr}`,
    );
  });

  it('produces a non-zero CAGR for an annual payer with several full calendar years', async () => {
    // Annual payer = 1 distinct month per year. The pre-fix CAGR gate
    // required 10 distinct months per year, so annual payers always
    // collapsed to 0. Post-fix we only care about calendar position.
    const currentYear = new Date().getFullYear();
    const divs: Record<string, { amount: number; date: number }> = {};
    for (let yearIndex = 0; yearIndex < 5; yearIndex++) {
      const year = currentYear - 5 + yearIndex;
      const amount = 2.0 + yearIndex * 0.25;
      const ts = Math.floor(Date.UTC(year, 5, 15) / 1000);
      divs[String(ts)] = { amount, date: ts };
    }
    globalThis.fetch = (async () => {
      return new Response(JSON.stringify(makeDividendChartPayload(divs)), { status: 200 });
    }) as typeof fetch;
    const profile = await fetchDividendProfile('EU', 50);
    assert.equal(profile.dividendFrequency, 'Annual');
    assert.ok(
      profile.dividendCagr > 0,
      `annual payer should have non-zero CAGR; got ${profile.dividendCagr}`,
    );
  });

  it('identifies monthly frequency', async () => {
    const now = Math.floor(Date.now() / 1000);
    const divs: Record<string, { amount: number; date: number }> = {};
    for (let m = 0; m < 12; m++) {
      const ts = now - (m * 30 * 24 * 3600);
      divs[String(ts)] = { amount: 0.10, date: ts };
    }
    globalThis.fetch = (async () => {
      return new Response(JSON.stringify(makeDividendChartPayload(divs)), { status: 200 });
    }) as typeof fetch;
    const profile = await fetchDividendProfile('MAIN', 40);
    assert.equal(profile.dividendFrequency, 'Monthly');
  });

  it('identifies annual frequency', async () => {
    const now = Math.floor(Date.now() / 1000);
    const divs: Record<string, { amount: number; date: number }> = {};
    for (let y = 0; y < 5; y++) {
      const ts = now - (y * 366 * 24 * 3600);
      divs[String(ts)] = { amount: 2.00, date: ts };
    }
    globalThis.fetch = (async () => {
      return new Response(JSON.stringify(makeDividendChartPayload(divs)), { status: 200 });
    }) as typeof fetch;
    const profile = await fetchDividendProfile('EU', 50);
    assert.equal(profile.dividendFrequency, 'Annual');
  });

  it('filters out zero-amount dividends', async () => {
    const now = Math.floor(Date.now() / 1000);
    const divs: Record<string, { amount: number; date: number }> = {
      [String(now)]: { amount: 0, date: now },
      [String(now - 100)]: { amount: 0, date: now - 100 },
    };
    globalThis.fetch = (async () => {
      return new Response(JSON.stringify(makeDividendChartPayload(divs)), { status: 200 });
    }) as typeof fetch;
    const profile = await fetchDividendProfile('ZERO', 100);
    assert.equal(profile.dividendYield, 0);
  });

  it('populates payoutRatio from the quoteSummary summaryDetail module', async () => {
    const divs = makeQuarterlyDividends();
    const chartPayload = makeDividendChartPayload(divs);
    const summaryPayload = {
      quoteSummary: {
        result: [
          { summaryDetail: { payoutRatio: { raw: 0.42 } } },
        ],
      },
    };
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('/v10/finance/quoteSummary/')) {
        return new Response(JSON.stringify(summaryPayload), { status: 200 });
      }
      return new Response(JSON.stringify(chartPayload), { status: 200 });
    }) as typeof fetch;
    const profile = await fetchDividendProfile('JNJ', 160);
    assert.equal(profile.payoutRatio, 0.42);
  });

  it('leaves payoutRatio undefined when summaryDetail fetch fails', async () => {
    const divs = makeQuarterlyDividends();
    const chartPayload = makeDividendChartPayload(divs);
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('/v10/finance/quoteSummary/')) {
        return new Response('', { status: 500 });
      }
      return new Response(JSON.stringify(chartPayload), { status: 200 });
    }) as typeof fetch;
    const profile = await fetchDividendProfile('JNJ', 160);
    assert.equal(profile.payoutRatio, undefined);
    assert.ok(profile.dividendYield > 0, 'dividend yield should still be computed even if payoutRatio fetch failed');
  });

  it('treats non-positive raw payoutRatio as missing', async () => {
    const divs = makeQuarterlyDividends();
    const chartPayload = makeDividendChartPayload(divs);
    const summaryPayload = {
      quoteSummary: {
        result: [
          { summaryDetail: { payoutRatio: { raw: 0 } } },
        ],
      },
    };
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('/v10/finance/quoteSummary/')) {
        return new Response(JSON.stringify(summaryPayload), { status: 200 });
      }
      return new Response(JSON.stringify(chartPayload), { status: 200 });
    }) as typeof fetch;
    const profile = await fetchDividendProfile('JNJ', 160);
    assert.equal(profile.payoutRatio, undefined);
  });
});

describe('buildAnalysisResponse with dividend', () => {
  const candles = Array.from({ length: 80 }, (_, i) => ({
    timestamp: 1_700_000_000_000 + i * 86_400_000,
    open: 100 + i * 0.4,
    high: 101 + i * 0.4,
    low: 99 + i * 0.4,
    close: 100 + i * 0.4,
    volume: 1_000_000 + i * 5_000,
  }));
  const technical = buildTechnicalSnapshot(candles);
  const overlay = getFallbackOverlay('Test', technical, []);

  it('includes dividend fields when profile provided', () => {
    const dividend: DividendProfile = {
      dividendYield: 2.3,
      trailingAnnualDividendRate: 1.92,
      exDividendDate: 1_700_000_000_000,
      payoutRatio: 0.35,
      dividendFrequency: 'Quarterly',
      dividendCagr: 8.2,
    };
    const resp = buildAnalysisResponse({
      symbol: 'KO',
      name: 'Coca-Cola',
      currency: 'USD',
      technical,
      headlines: [],
      overlay,
      analystData: emptyAnalystData,
      includeNews: false,
      analysisAt: Date.now(),
      generatedAt: new Date().toISOString(),
      dividend,
    });
    assert.equal(resp.dividendYield, 2.3);
    assert.equal(resp.trailingAnnualDividendRate, 1.92);
    assert.equal(resp.exDividendDate, 1_700_000_000_000);
    assert.equal(resp.payoutRatio, 0.35);
    assert.equal(resp.dividendFrequency, 'Quarterly');
    assert.equal(resp.dividendCagr, 8.2);
    assert.ok(!('fiveYearAvgDividendYield' in resp), 'fiveYearAvgDividendYield should be removed from the response shape');
  });

  it('omits payoutRatio entirely when the dividend profile lacks it', () => {
    const dividend: DividendProfile = {
      dividendYield: 1.4,
      trailingAnnualDividendRate: 0.96,
      exDividendDate: 1_700_000_000_000,
      dividendFrequency: 'Quarterly',
      dividendCagr: 5.0,
    };
    const resp = buildAnalysisResponse({
      symbol: 'NVDA',
      name: 'NVIDIA',
      currency: 'USD',
      technical,
      headlines: [],
      overlay,
      analystData: emptyAnalystData,
      includeNews: false,
      analysisAt: Date.now(),
      generatedAt: new Date().toISOString(),
      dividend,
    });
    assert.equal(resp.payoutRatio, undefined);
  });

  it('defaults dividend fields to zero when no profile', () => {
    const resp = buildAnalysisResponse({
      symbol: 'GOOG',
      name: 'Alphabet',
      currency: 'USD',
      technical,
      headlines: [],
      overlay,
      analystData: emptyAnalystData,
      includeNews: false,
      analysisAt: Date.now(),
      generatedAt: new Date().toISOString(),
    });
    assert.equal(resp.dividendYield, 0);
    assert.equal(resp.trailingAnnualDividendRate, 0);
    assert.equal(resp.dividendFrequency, '');
    assert.equal(resp.dividendCagr, 0);
    assert.equal(resp.payoutRatio, undefined);
  });
});
