import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildAnalystSystemPrompt } from '../server/worldmonitor/intelligence/v1/chat-analyst-prompt.ts';
import type { AnalystContext } from '../server/worldmonitor/intelligence/v1/chat-analyst-context.ts';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function emptyCtx(): AnalystContext {
  return {
    timestamp: 'Mon, 01 Jan 2026 00:00:00 GMT',
    worldBrief: '',
    riskScores: '',
    marketImplications: '',
    forecasts: '',
    marketData: '',
    macroSignals: '',
    predictionMarkets: '',
    countryBrief: '',
    liveHeadlines: '',
    activeSources: [],
    degraded: false,
  };
}

function fullCtx(): AnalystContext {
  return {
    timestamp: 'Mon, 01 Jan 2026 00:00:00 GMT',
    worldBrief: 'Global tensions elevated.',
    riskScores: 'Top Risk Countries:\n- Ukraine: 85.0',
    marketImplications: 'AI Market Signals:\n- GLD LONG (HIGH): Gold thesis',
    forecasts: 'Active Forecasts:\n- [Geopolitics] Ukraine ceasefire — 22%',
    marketData: 'Market Data:\nEquities: SPY $500.00 (+1.20%)',
    macroSignals: 'Macro Signals:\nRegime: RISK-OFF',
    predictionMarkets: 'Prediction Markets:\n- "Taiwan invasion" Yes: 12%',
    countryBrief: 'Country Focus — UA:\nAnalysis of Ukraine situation.',
    liveHeadlines: 'Latest Headlines:\n- Missile strikes reported',
    activeSources: ['Brief', 'Risk', 'Signals', 'Forecasts', 'Markets', 'Macro', 'Prediction', 'Country', 'Live'],
    degraded: false,
  };
}

// ---------------------------------------------------------------------------
// buildAnalystSystemPrompt — domain filtering
// ---------------------------------------------------------------------------

describe('buildAnalystSystemPrompt — domain filtering', () => {
  it('"all" domain includes all sections that have content', () => {
    const prompt = buildAnalystSystemPrompt(fullCtx(), 'all');
    assert.ok(prompt.includes('Global tensions elevated'), 'should include worldBrief');
    assert.ok(prompt.includes('Top Risk Countries'), 'should include riskScores');
    assert.ok(prompt.includes('AI Market Signals'), 'should include marketImplications');
    assert.ok(prompt.includes('Market Data'), 'should include marketData');
    assert.ok(prompt.includes('Macro Signals'), 'should include macroSignals');
    assert.ok(prompt.includes('Prediction Markets'), 'should include predictionMarkets');
    assert.ok(prompt.includes('Country Focus'), 'should include countryBrief');
    assert.ok(prompt.includes('Latest Headlines'), 'should include liveHeadlines');
  });

  it('"market" domain excludes worldBrief but includes marketData and macroSignals', () => {
    const prompt = buildAnalystSystemPrompt(fullCtx(), 'market');
    assert.ok(!prompt.includes('Global tensions elevated'), 'should exclude worldBrief');
    assert.ok(!prompt.includes('Country Focus'), 'should exclude countryBrief');
    assert.ok(prompt.includes('Market Data'), 'should include marketData');
    assert.ok(prompt.includes('Macro Signals'), 'should include macroSignals');
    assert.ok(prompt.includes('AI Market Signals'), 'should include marketImplications');
    assert.ok(prompt.includes('Latest Headlines'), 'should include liveHeadlines');
  });

  it('"geo" domain excludes marketData and macroSignals but includes worldBrief', () => {
    const prompt = buildAnalystSystemPrompt(fullCtx(), 'geo');
    assert.ok(prompt.includes('Global tensions elevated'), 'should include worldBrief');
    assert.ok(prompt.includes('Top Risk Countries'), 'should include riskScores');
    assert.ok(prompt.includes('Country Focus'), 'should include countryBrief');
    assert.ok(!prompt.includes('Market Data'), 'should exclude marketData');
    assert.ok(!prompt.includes('Macro Signals'), 'should exclude macroSignals');
    assert.ok(prompt.includes('Latest Headlines'), 'should include liveHeadlines');
  });

  it('"military" domain excludes marketData and marketImplications but includes worldBrief', () => {
    const prompt = buildAnalystSystemPrompt(fullCtx(), 'military');
    assert.ok(prompt.includes('Global tensions elevated'), 'should include worldBrief');
    assert.ok(prompt.includes('Top Risk Countries'), 'should include riskScores');
    assert.ok(!prompt.includes('Market Data'), 'should exclude marketData');
    assert.ok(!prompt.includes('AI Market Signals'), 'should exclude marketImplications');
    assert.ok(!prompt.includes('Macro Signals'), 'should exclude macroSignals');
    assert.ok(prompt.includes('Latest Headlines'), 'should include liveHeadlines');
  });

  it('"economic" domain excludes worldBrief and predictionMarkets but includes marketData', () => {
    const prompt = buildAnalystSystemPrompt(fullCtx(), 'economic');
    assert.ok(!prompt.includes('Global tensions elevated'), 'should exclude worldBrief');
    assert.ok(!prompt.includes('Prediction Markets'), 'should exclude predictionMarkets');
    assert.ok(prompt.includes('Market Data'), 'should include marketData');
    assert.ok(prompt.includes('Macro Signals'), 'should include macroSignals');
    assert.ok(prompt.includes('Top Risk Countries'), 'should include riskScores');
    assert.ok(prompt.includes('Latest Headlines'), 'should include liveHeadlines');
  });

  it('empty context produces no-live-data fallback', () => {
    const prompt = buildAnalystSystemPrompt(emptyCtx(), 'all');
    assert.ok(prompt.includes('No live data available'), 'should include fallback text when no context');
  });

  it('unknown domain falls back to all-inclusive behavior', () => {
    const prompt = buildAnalystSystemPrompt(fullCtx(), 'unknown-domain');
    assert.ok(prompt.includes('Global tensions elevated'), 'should include worldBrief for unknown domain');
    assert.ok(prompt.includes('Market Data'), 'should include marketData for unknown domain');
  });
});

// ---------------------------------------------------------------------------
// buildAnalystSystemPrompt — prompt instructions
// ---------------------------------------------------------------------------

describe('buildAnalystSystemPrompt — formatting instructions', () => {
  it('includes 350-word limit instruction', () => {
    const prompt = buildAnalystSystemPrompt(fullCtx(), 'all');
    assert.ok(prompt.includes('350 words'), 'should include 350-word limit');
  });

  it('includes bold headers instruction', () => {
    const prompt = buildAnalystSystemPrompt(fullCtx(), 'all');
    assert.ok(prompt.includes('bold'), 'should include bold headers instruction');
  });

  it('includes SITUATION / ANALYSIS / WATCH format instruction', () => {
    const prompt = buildAnalystSystemPrompt(fullCtx(), 'all');
    assert.ok(prompt.includes('SITUATION'), 'should include SITUATION format');
    assert.ok(prompt.includes('ANALYSIS'), 'should include ANALYSIS format');
    assert.ok(prompt.includes('WATCH'), 'should include WATCH format');
  });

  it('includes SIGNAL / THESIS / RISK format instruction', () => {
    const prompt = buildAnalystSystemPrompt(fullCtx(), 'all');
    assert.ok(prompt.includes('SIGNAL'), 'should include SIGNAL format');
    assert.ok(prompt.includes('THESIS'), 'should include THESIS format');
    assert.ok(prompt.includes('RISK'), 'should include RISK format');
  });

  it('"market" domain includes market emphasis instruction', () => {
    const prompt = buildAnalystSystemPrompt(fullCtx(), 'market');
    assert.ok(
      prompt.toLowerCase().includes('market') && prompt.includes('SIGNAL'),
      'should include market-specific emphasis',
    );
  });

  it('timestamp is embedded in system prompt', () => {
    const ctx = fullCtx();
    const prompt = buildAnalystSystemPrompt(ctx, 'all');
    assert.ok(prompt.includes(ctx.timestamp), 'should embed timestamp in prompt');
  });

  it('does not include speculate instruction', () => {
    const prompt = buildAnalystSystemPrompt(fullCtx(), 'all');
    assert.ok(prompt.includes('speculate'), 'should include no-speculation instruction');
  });
});

// ---------------------------------------------------------------------------
// Domain config alignment — VALID_DOMAINS, GDELT_TOPICS, DOMAIN_SECTIONS
// ---------------------------------------------------------------------------

describe('domain config alignment', () => {
  const EXPECTED_DOMAINS = ['geo', 'market', 'military', 'economic'] as const;

  it('all non-all domains have distinct market filtering (market includes marketData, geo excludes it)', () => {
    const market = buildAnalystSystemPrompt(fullCtx(), 'market');
    const geo = buildAnalystSystemPrompt(fullCtx(), 'geo');
    assert.ok(market.includes('Market Data'), 'market domain must include marketData');
    assert.ok(!geo.includes('Market Data'), 'geo domain must exclude marketData');
  });

  it('all 4 non-all domains produce different prompts from each other', () => {
    const prompts = EXPECTED_DOMAINS.map((d) => buildAnalystSystemPrompt(fullCtx(), d));
    const unique = new Set(prompts);
    assert.equal(unique.size, 4, 'each domain should produce a distinct prompt');
  });

  it('each non-all domain prompt is shorter than the all-domain prompt', () => {
    const allPrompt = buildAnalystSystemPrompt(fullCtx(), 'all');
    for (const domain of EXPECTED_DOMAINS) {
      const domainPrompt = buildAnalystSystemPrompt(fullCtx(), domain);
      assert.ok(
        domainPrompt.length < allPrompt.length,
        `"${domain}" prompt (${domainPrompt.length}) should be shorter than "all" prompt (${allPrompt.length})`,
      );
    }
  });

  it('liveHeadlines section is included in all 4 non-all domains', () => {
    for (const domain of EXPECTED_DOMAINS) {
      const prompt = buildAnalystSystemPrompt(fullCtx(), domain);
      assert.ok(
        prompt.includes('Latest Headlines'),
        `"${domain}" domain should include liveHeadlines`,
      );
    }
  });
});
