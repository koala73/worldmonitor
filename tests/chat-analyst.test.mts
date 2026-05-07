import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildAnalystSystemPrompt } from '../server/worldmonitor/intelligence/v1/chat-analyst-prompt.ts';
import { buildActionEvents, VISUAL_INTENT_RE } from '../server/worldmonitor/intelligence/v1/chat-analyst-actions.ts';
import { postProcessAnalystHtml } from '../src/utils/analyst-markdown.ts';
import { extractKeywords } from '../server/worldmonitor/intelligence/v1/chat-analyst-context.ts';
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
    relevantArticles: '',
    energyExposure: '',
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
    relevantArticles: '',
    energyExposure: 'Energy Generation Mix — 2023 data:\nGas-dependent (% electricity from gas): Italy 46%, Netherlands 39%\nCoal-dependent: South Africa 88%, Poland 65%\n(Gas figures are total gas mix; LNG vs. pipeline split not in this dataset.)',
    activeSources: ['Brief', 'Risk', 'Signals', 'Forecasts', 'Markets', 'EnergyMix', 'Macro', 'Prediction', 'Country', 'Live'],
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
    assert.ok(prompt.includes('Energy Exposure'), 'should include energyExposure');
  });

  it('"market" domain excludes worldBrief and energyExposure but includes marketData and macroSignals', () => {
    const prompt = buildAnalystSystemPrompt(fullCtx(), 'market');
    assert.ok(!prompt.includes('Global tensions elevated'), 'should exclude worldBrief');
    assert.ok(!prompt.includes('Country Focus'), 'should exclude countryBrief');
    assert.ok(!prompt.includes('Energy Exposure'), 'should exclude energyExposure');
    assert.ok(prompt.includes('Market Data'), 'should include marketData');
    assert.ok(prompt.includes('Macro Signals'), 'should include macroSignals');
    assert.ok(prompt.includes('AI Market Signals'), 'should include marketImplications');
    assert.ok(prompt.includes('Latest Headlines'), 'should include liveHeadlines');
  });

  it('"geo" domain excludes marketData and macroSignals but includes worldBrief and energyExposure', () => {
    const prompt = buildAnalystSystemPrompt(fullCtx(), 'geo');
    assert.ok(prompt.includes('Global tensions elevated'), 'should include worldBrief');
    assert.ok(prompt.includes('Top Risk Countries'), 'should include riskScores');
    assert.ok(prompt.includes('Country Focus'), 'should include countryBrief');
    assert.ok(prompt.includes('Energy Exposure'), 'should include energyExposure');
    assert.ok(!prompt.includes('Market Data'), 'should exclude marketData');
    assert.ok(!prompt.includes('Macro Signals'), 'should exclude macroSignals');
    assert.ok(prompt.includes('Latest Headlines'), 'should include liveHeadlines');
  });

  it('"military" domain excludes marketData, marketImplications, and energyExposure but includes worldBrief', () => {
    const prompt = buildAnalystSystemPrompt(fullCtx(), 'military');
    assert.ok(prompt.includes('Global tensions elevated'), 'should include worldBrief');
    assert.ok(prompt.includes('Top Risk Countries'), 'should include riskScores');
    assert.ok(!prompt.includes('Market Data'), 'should exclude marketData');
    assert.ok(!prompt.includes('AI Market Signals'), 'should exclude marketImplications');
    assert.ok(!prompt.includes('Macro Signals'), 'should exclude macroSignals');
    assert.ok(!prompt.includes('Energy Exposure'), 'should exclude energyExposure');
    assert.ok(prompt.includes('Latest Headlines'), 'should include liveHeadlines');
  });

  it('"economic" domain excludes worldBrief and predictionMarkets but includes marketData and energyExposure', () => {
    const prompt = buildAnalystSystemPrompt(fullCtx(), 'economic');
    assert.ok(!prompt.includes('Global tensions elevated'), 'should exclude worldBrief');
    assert.ok(!prompt.includes('Prediction Markets'), 'should exclude predictionMarkets');
    assert.ok(prompt.includes('Market Data'), 'should include marketData');
    assert.ok(prompt.includes('Macro Signals'), 'should include macroSignals');
    assert.ok(prompt.includes('Top Risk Countries'), 'should include riskScores');
    assert.ok(prompt.includes('Energy Exposure'), 'should include energyExposure');
    assert.ok(prompt.includes('Latest Headlines'), 'should include liveHeadlines');
  });

  it('empty context produces no-live-data fallback', () => {
    const prompt = buildAnalystSystemPrompt(emptyCtx(), 'all');
    assert.ok(prompt.includes('No live context available'), 'should include fallback text when no context');
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

// ---------------------------------------------------------------------------
// buildActionEvents — visual intent detection
// ---------------------------------------------------------------------------

describe('buildActionEvents — visual intent detection', () => {
  it('returns suggest-widget action for chart price query', () => {
    const events = buildActionEvents('chart prices of oil vs gold');
    assert.equal(events.length, 1);
    assert.equal(events[0]?.type, 'suggest-widget');
    assert.equal(events[0]?.label, 'Create chart widget');
    assert.equal(events[0]?.prefill, 'chart prices of oil vs gold');
  });

  it('returns suggest-widget action for chart with intermediate subject noun', () => {
    const events = buildActionEvents('chart oil prices vs gold');
    assert.equal(events.length, 1);
    assert.equal(events[0]?.type, 'suggest-widget');
  });

  it('returns suggest-widget action for graph with intermediate subject noun', () => {
    const events = buildActionEvents('graph interest rates over time');
    assert.equal(events.length, 1);
    assert.equal(events[0]?.type, 'suggest-widget');
  });

  it('returns suggest-widget action for plot with intermediate subject noun', () => {
    const events = buildActionEvents('plot oil performance');
    assert.equal(events.length, 1);
    assert.equal(events[0]?.type, 'suggest-widget');
  });

  it('returns suggest-widget action for show me a chart', () => {
    const events = buildActionEvents('show me a chart of S&P 500 performance');
    assert.equal(events.length, 1);
    assert.equal(events[0]?.type, 'suggest-widget');
  });

  it('returns suggest-widget action for give me a chart', () => {
    const events = buildActionEvents('give me a chart of the gold over past 30 days');
    assert.equal(events.length, 1);
    assert.equal(events[0]?.type, 'suggest-widget');
  });

  it('returns suggest-widget action for get me a chart', () => {
    const events = buildActionEvents('get me a chart of oil prices');
    assert.equal(events.length, 1);
    assert.equal(events[0]?.type, 'suggest-widget');
  });

  it('returns suggest-widget action for price history query', () => {
    const events = buildActionEvents('What is the price history of crude oil?');
    assert.equal(events.length, 1);
    assert.equal(events[0]?.type, 'suggest-widget');
  });

  it('returns suggest-widget action for price comparison query', () => {
    const events = buildActionEvents('compare prices of gold and silver');
    assert.equal(events.length, 1);
    assert.equal(events[0]?.type, 'suggest-widget');
  });

  it('returns suggest-widget action for dashboard keyword', () => {
    const events = buildActionEvents('build me a dashboard');
    assert.equal(events.length, 1);
    assert.equal(events[0]?.type, 'suggest-widget');
  });

  it('returns empty for non-visual geopolitical query', () => {
    assert.deepEqual(buildActionEvents("What is happening in Ukraine?"), []);
  });

  it('returns empty for non-visual market summary query', () => {
    assert.deepEqual(buildActionEvents('Key market moves, macro signals, and commodity moves today'), []);
  });

  it('returns empty for Situation quick action', () => {
    assert.deepEqual(buildActionEvents("Summarize today's geopolitical situation"), []);
  });

  it('returns empty for Conflicts quick action', () => {
    assert.deepEqual(buildActionEvents('Top active conflicts and military developments'), []);
  });

  it('returns empty for Forecasts quick action', () => {
    assert.deepEqual(buildActionEvents('Active forecasts and prediction market outlook'), []);
  });

  it('returns empty for Risk quick action', () => {
    assert.deepEqual(buildActionEvents('Highest risk countries and instability hotspots'), []);
  });

  it('does NOT match bare "chart" in "UN Charter"', () => {
    assert.deepEqual(buildActionEvents('What does the UN Charter say about sovereignty?'), []);
  });

  it('does NOT match bare "chart" without a visual compound phrase', () => {
    assert.deepEqual(buildActionEvents('chart a course through the crisis'), []);
  });

  it('VISUAL_INTENT_RE is case-insensitive', () => {
    assert.ok(VISUAL_INTENT_RE.test('Chart oil Performance Over Time'));
    assert.ok(VISUAL_INTENT_RE.test('SHOW ME A GRAPH of inflation trends'));
    assert.ok(VISUAL_INTENT_RE.test('CHART OIL PRICES vs gold'));
  });
});

// ---------------------------------------------------------------------------
// postProcessAnalystHtml — section-header promotion
// ---------------------------------------------------------------------------

describe('postProcessAnalystHtml — section-header promotion', () => {
  it('converts bold ALL-CAPS paragraph to section-header div', () => {
    const out = postProcessAnalystHtml('<p><strong>SIGNAL</strong></p>');
    assert.equal(out, '<div class="chat-section-header">SIGNAL</div>');
  });

  it('converts plain ALL-CAPS paragraph (≥4 chars) to section-header div', () => {
    const out = postProcessAnalystHtml('<p>WATCH</p>');
    assert.equal(out, '<div class="chat-section-header">WATCH</div>');
  });

  it('converts SITUATION / ANALYSIS style slash-header', () => {
    const out = postProcessAnalystHtml('<p><strong>SITUATION / ANALYSIS</strong></p>');
    assert.equal(out, '<div class="chat-section-header">SITUATION / ANALYSIS</div>');
  });

  it('does NOT promote short acronyms (US, EU, GDP)', () => {
    assert.equal(postProcessAnalystHtml('<p>US</p>'), '<p>US</p>');
    assert.equal(postProcessAnalystHtml('<p>EU</p>'), '<p>EU</p>');
    assert.equal(postProcessAnalystHtml('<p>GDP</p>'), '<p>GDP</p>');
  });

  it('does NOT promote mixed-case paragraphs', () => {
    const input = '<p>Gold is trading at $4,595.</p>';
    assert.equal(postProcessAnalystHtml(input), input);
  });

  it('does NOT promote inline bold inside prose', () => {
    const input = '<p>The <strong>SIGNAL</strong> is bullish.</p>';
    assert.equal(postProcessAnalystHtml(input), input);
  });

  it('passes through table HTML unchanged', () => {
    const table = '<table><thead><tr><th>Date</th><th>Price</th></tr></thead></table>';
    assert.equal(postProcessAnalystHtml(table), table);
  });

  it('handles multiple headers in one string', () => {
    const input = '<p><strong>SIGNAL</strong></p><p>text</p><p><strong>THESIS</strong></p>';
    const out = postProcessAnalystHtml(input);
    assert.ok(out.includes('<div class="chat-section-header">SIGNAL</div>'));
    assert.ok(out.includes('<div class="chat-section-header">THESIS</div>'));
    assert.ok(out.includes('<p>text</p>'));
  });
});

// ---------------------------------------------------------------------------
// extractKeywords — keyword extraction edge cases
// ---------------------------------------------------------------------------

describe('extractKeywords', () => {
  it('lowercases and filters stopwords', () => {
    const kw = extractKeywords('What is happening in Ukraine');
    assert.ok(kw.includes('ukraine'), 'should keep ukraine');
    assert.ok(kw.includes('happening'), 'should keep happening');
    assert.ok(!kw.includes('what'), 'should drop "what" (stopword)');
    assert.ok(!kw.includes('is'), 'should drop "is" (stopword)');
    assert.ok(!kw.includes('in'), 'should drop "in" (stopword)');
  });

  it('deduplicates repeated words', () => {
    const kw = extractKeywords('energy energy crisis energy');
    assert.equal(kw.filter((k) => k === 'energy').length, 1, 'energy should appear only once');
  });

  it('caps output at 8 keywords', () => {
    const kw = extractKeywords('alpha bravo charlie delta echo foxtrot golf hotel india juliet');
    assert.ok(kw.length <= 8, `should cap at 8, got ${kw.length}`);
  });

  it('preserves known 2-char acronyms typed in lowercase', () => {
    const kw = extractKeywords('us sanctions on iran');
    assert.ok(kw.includes('us'), '"us" should be preserved as a known acronym');
    assert.ok(kw.includes('sanctions'), 'should keep "sanctions"');
    assert.ok(kw.includes('iran'), 'should keep "iran"');
  });

  it('preserves known 2-char acronyms typed in uppercase', () => {
    const kw = extractKeywords('US sanctions on Iran');
    assert.ok(kw.includes('us'), '"US" should be preserved and lowercased');
  });

  it('preserves uk, eu, un, ai regardless of case', () => {
    for (const acronym of ['uk', 'eu', 'un', 'ai']) {
      const lower = extractKeywords(`${acronym} policy`);
      assert.ok(lower.includes(acronym), `"${acronym}" (lowercase) should be preserved`);
      const upper = extractKeywords(`${acronym.toUpperCase()} policy`);
      assert.ok(upper.includes(acronym), `"${acronym.toUpperCase()}" (uppercase) should be preserved and lowercased`);
    }
  });

  it('drops non-acronym 2-char tokens', () => {
    const kw = extractKeywords('go to the market');
    assert.ok(!kw.includes('go'), '"go" is 2 chars and not a known acronym');
    assert.ok(!kw.includes('to'), '"to" is a stopword');
    assert.ok(kw.includes('market'), 'should keep "market"');
  });

  it('returns empty array when all tokens are stopwords or too short', () => {
    // "is", "this", "ok" — all either stopwords or 2-char non-acronyms
    const kw = extractKeywords('is this ok');
    assert.equal(kw.length, 0, 'should return empty when no meaningful keywords survive');
  });
});

// ---------------------------------------------------------------------------
// extractKeywords — retrieval priority ordering
// ---------------------------------------------------------------------------

describe('extractKeywords — retrieval priority (current turn first)', () => {
  it('current-turn pivot appears before prior-turn keywords when combined as query+prior', () => {
    // Simulates the retrieval query built in api/chat-analyst.ts:
    //   `${query} ${prevUserTurn}`
    // "What about Germany?" is the current turn, the prior is a long energy question.
    const currentQuery = 'What about Germany?';
    const prevTurn = 'which countries are reducing electricity and fuel consumption';
    const combined = `${currentQuery} ${prevTurn}`;
    const kw = extractKeywords(combined);

    // germany must appear before energy-topic words
    const germanyIdx = kw.indexOf('germany');
    assert.ok(germanyIdx !== -1, '"germany" must be in keywords');
    assert.equal(germanyIdx, 0, '"germany" must be first — current-turn pivot takes priority');
  });

  it('prior-turn keywords backfill remaining slots after current-turn fills first', () => {
    const currentQuery = 'Germany sanctions';
    const prevTurn = 'which countries are reducing electricity and fuel consumption';
    const kw = extractKeywords(`${currentQuery} ${prevTurn}`);

    // Both current-turn and prior-turn keywords should be present (slots remain)
    assert.ok(kw.includes('germany'), 'current-turn: germany');
    assert.ok(kw.includes('sanctions'), 'current-turn: sanctions');
    assert.ok(kw.includes('countries') || kw.includes('electricity') || kw.includes('consumption'),
      'prior-turn keywords should backfill remaining slots');
  });

  it('prior-turn does not crowd out current-turn pivot when prior is long', () => {
    // Prior turn has 8+ content words — without correct ordering it would fill the cap
    const currentQuery = 'What about Germany?';
    const longPrior = 'global shipping routes disrupted supply chains ports containers freight logistics maritime';
    const kw = extractKeywords(`${currentQuery} ${longPrior}`);

    assert.ok(kw.includes('germany'), '"germany" must survive even with a long prior turn');
  });
});
