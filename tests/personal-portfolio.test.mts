import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

// Simulate a Japanese-language browser environment so `isJapanese()` returns true
// and JP branch assertions in the tests below remain valid.
globalThis.document = { documentElement: { lang: 'ja' } } as unknown as Document;

import {
  buildPortfolioImpactViewModel,
  fetchIdeaRadarEvaluationLog,
  fetchIdeaRadarReviewHistory,
  fetchPersonalPortfolioExport,
  getIdeaRadarEvaluationLogUrl,
  getIdeaRadarReviewHistoryUrl,
  getPersonalPortfolioExportUrl,
  persistIdeaRadarEvaluationLog,
  persistIdeaRadarReviewHistory,
  type PersonalPortfolioExport,
} from '../src/services/personal-portfolio.ts';

function samplePayload(): PersonalPortfolioExport {
  return {
    schema_version: 1,
    generated_at: '2026-05-28T10:00:00',
    source: 'AI_System.portfolio.db',
    detail: 'risk',
    privacy: {
      exact_amounts: false,
      exact_quantities: false,
      intended_use: 'portfolio-impact-analysis',
    },
    summary: {
      holding_count: 3,
      account_count: 2,
      total_gain_pct: 24.3,
      cached_prices: true,
    },
    accounts: [
      { account: 'SBI', holding_count: 2, weight_pct: 68.5 },
      { account: 'Webull', holding_count: 1, weight_pct: 31.5 },
    ],
    currency: [
      { currency: 'USD', weight_pct: 55.2 },
      { currency: 'JPY', weight_pct: 44.8 },
    ],
    holdings: [
      {
        ticker: 'NVDA',
        name: 'NVIDIA',
        account: 'Webull',
        currency: 'USD',
        weight_pct: 31.5,
        gain_pct: 44.2,
        priced: true,
      },
      {
        ticker: '7203.T',
        name: 'Toyota',
        account: 'SBI',
        currency: 'JPY',
        weight_pct: 24.4,
        gain_pct: 12.1,
        priced: true,
      },
      {
        ticker: 'IBIT',
        name: 'iShares Bitcoin Trust',
        account: 'SBI',
        currency: 'USD',
        weight_pct: 18.8,
        gain_pct: 9.4,
        priced: true,
      },
    ],
    risk_rules: [
      {
        rule_id: 'R1',
        name: '集中度アラート',
        ok: false,
        severity: 'alert',
        message: 'single holding exceeds threshold',
        detail_count: 1,
      },
      {
        rule_id: 'R2',
        name: '現金比率',
        ok: true,
        severity: 'info',
        message: 'cash ratio ok',
        detail_count: 0,
      },
    ],
  };
}

describe('personal portfolio service', () => {
  it('uses the local AI_System default endpoint when no env override is present', () => {
    assert.equal(
      getPersonalPortfolioExportUrl(),
      'http://127.0.0.1:8080/api/finance/portfolio-export?detail=risk',
    );
  });

  it('keeps the dev proxy base in source for Vite sessions', async () => {
    const fs = await import('node:fs/promises');
    const source = await fs.readFile(new URL('../src/services/personal-portfolio.ts', import.meta.url), 'utf8');
    assert.match(source, /const DEV_AI_SYSTEM_PORTFOLIO_API_BASE_URL = '\/api\/ai-system';/);
    assert.match(source, /if \(ENV\.DEV\) return DEV_AI_SYSTEM_PORTFOLIO_API_BASE_URL;/);
  });

  it('fetches the portfolio export through the injected fetch implementation', async () => {
    let requestedUrl = '';
    const payload = samplePayload();
    const result = await fetchPersonalPortfolioExport('risk', {
      fetchImpl: async (input) => {
        requestedUrl = String(input);
        return new Response(JSON.stringify(payload), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      },
    });

    assert.equal(requestedUrl, getPersonalPortfolioExportUrl('risk'));
    assert.equal(result.summary.holding_count, 3);
  });

  it('loads and persists idea radar review history through the AI_System endpoint', async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), method: String(init?.method || 'GET') });
      return new Response(JSON.stringify({
        schema_version: 1,
        updated_at: '2026-05-29T10:00:00',
        history: {
          AVGO: { count: 2, firstSeenAt: '2026-05-28T10:00:00', lastSeenAt: '2026-05-29T10:00:00', lastScore: 77 },
        },
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const loaded = await fetchIdeaRadarReviewHistory({ fetchImpl });
    const saved = await persistIdeaRadarReviewHistory({
      AVGO: { count: 3, firstSeenAt: '2026-05-28T10:00:00', lastSeenAt: '2026-05-29T10:05:00', lastScore: 79 },
    }, { fetchImpl });

    assert.equal(calls[0]?.url, getIdeaRadarReviewHistoryUrl());
    assert.equal(calls[0]?.method, 'GET');
    assert.equal(calls[1]?.url, getIdeaRadarReviewHistoryUrl());
    assert.equal(calls[1]?.method, 'POST');
    assert.equal(loaded?.history.AVGO?.count, 2);
    assert.equal(saved?.history.AVGO?.count, 2);
  });

  it('loads and persists idea radar evaluation log through the AI_System endpoint', async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), method: String(init?.method || 'GET') });
      return new Response(JSON.stringify({
        schema_version: 1,
        updated_at: '2026-05-29T10:00:00',
        entries: [
          {
            loggedAt: '2026-05-29T10:00:00',
            generatedAt: '2026-05-29T10:00:00',
            symbol: 'AVGO',
            name: 'Broadcom',
            assetType: 'equity',
            horizon: '1w',
            stance: 'research',
            score: 81,
            priceAtLog: 231.4,
            latestPrice: 238.2,
            latestReturnPct: 2.9,
            outcomeStatus: 'positive',
            evaluatedAt: '2026-05-30T10:00:00',
          },
        ],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const loaded = await fetchIdeaRadarEvaluationLog({ fetchImpl });
    const saved = await persistIdeaRadarEvaluationLog([
      {
        loggedAt: '2026-05-29T10:05:00',
        generatedAt: '2026-05-29T10:05:00',
        symbol: 'NVDA',
        name: 'NVIDIA',
        assetType: 'equity',
        horizon: '1d',
        stance: 'watch',
        score: 72,
        priceAtLog: 120.1,
        latestPrice: 121.8,
        latestReturnPct: 1.4,
        outcomeStatus: 'positive',
        evaluatedAt: '2026-05-30T10:05:00',
      },
    ], { fetchImpl });

    assert.equal(calls[0]?.url, getIdeaRadarEvaluationLogUrl());
    assert.equal(calls[0]?.method, 'GET');
    assert.equal(calls[1]?.url, getIdeaRadarEvaluationLogUrl());
    assert.equal(calls[1]?.method, 'POST');
    assert.equal(loaded?.entries[0]?.symbol, 'AVGO');
    assert.equal(loaded?.entries[0]?.latestReturnPct, 2.9);
    assert.equal(saved?.entries[0]?.symbol, 'AVGO');
  });

  it('builds portfolio actions and themes from risk-only portfolio data', () => {
    const model = buildPortfolioImpactViewModel(samplePayload());

    assert.equal(model.actions.length, 3);
    assert.equal(model.actions[0]?.title, '集中度アラート');
    assert.match(model.actions[1]?.title ?? '', /NVDA 集中リスク/);
    assert.match(model.actions[2]?.title ?? '', /USD比率が高水準/);

    const themeIds = model.themes.map((theme) => theme.id);
    assert.deepEqual(themeIds, ['semiconductors', 'crypto', 'usd', 'protect-gains']);
    assert.equal(model.topHoldings[0]?.ticker, 'NVDA');
    assert.equal(model.activeRules.length, 1);
  });
});
