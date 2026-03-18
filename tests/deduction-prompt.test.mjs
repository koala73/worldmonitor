import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildDeductionPrompt,
  inferDeductionMode,
  inferProviderLabel,
  postProcessDeductionOutput,
  splitDeductionContext,
} from '../server/worldmonitor/intelligence/v1/deduction-prompt.ts';
import { buildNewsContextFromItems } from '../src/utils/news-context.ts';

describe('inferDeductionMode', () => {
  it('selects brief mode for short convergence assessments', () => {
    assert.equal(
      inferDeductionMode('Analyze this convergence pattern and assess likelihood in 2-3 sentences.'),
      'brief',
    );
  });

  it('selects forecast mode for open-ended user forecasting', () => {
    assert.equal(
      inferDeductionMode('What will possibly happen in the next 72 hours in the Taiwan Strait?'),
      'forecast',
    );
  });

  it('ignores trigger phrases in geoContext — mode is query-only', () => {
    assert.equal(
      inferDeductionMode('What is the strategic outlook for the Gulf theater?'),
      'forecast',
    );
  });
});

describe('splitDeductionContext', () => {
  it('separates primary context from recent news lines', () => {
    const result = splitDeductionContext(
      'Theater: Levant.\n\nRecent News Signal Snapshot:\n- 2026-03-15T10:00:00.000Z | Reuters | tier-1 | Israel mobilizes reserves\n- 2026-03-15T09:00:00.000Z | AP | ceasefire talks stall',
    );

    assert.equal(result.primaryContext, 'Theater: Levant.');
    assert.equal(result.recentNews.length, 2);
    assert.match(result.recentNews[0], /Reuters/);
  });
});

describe('buildDeductionPrompt', () => {
  it('builds a structured forecast prompt for panel usage', () => {
    const { mode, systemPrompt, userPrompt } = buildDeductionPrompt({
      query: 'What is the expected strategic impact of the current military posture in the Gulf theater?',
      geoContext: 'Theater: Gulf.\n\nRecent News Signal Snapshot:\n- 2026-03-15T08:00:00.000Z | Reuters | naval deployment increases',
      now: new Date('2026-03-15T12:00:00Z'),
    });

    assert.equal(mode, 'forecast');
    assert.match(systemPrompt, /\*\*Most likely path \(next 24-72h\)\*\*/);
    assert.match(systemPrompt, /2026-03-15 UTC/);
    assert.match(userPrompt, /Recent News Signals/);
  });

  it('builds a terse brief prompt for correlation-card usage', () => {
    const { mode, systemPrompt } = buildDeductionPrompt({
      query: 'Assess likelihood and potential implications in 2-3 sentences.',
      geoContext: 'Countries: Taiwan, China',
      now: new Date('2026-03-15T12:00:00Z'),
    });

    assert.equal(mode, 'brief');
    assert.match(systemPrompt, /exactly 2 or 3 sentences/);
    assert.doesNotMatch(systemPrompt, /\*\*Bottom line\*\*/);
  });
});

describe('postProcessDeductionOutput', () => {
  it('removes think tags and flattens brief responses', () => {
    const output = postProcessDeductionOutput('<think>hidden</think> First line.\n\nSecond line.', 'brief');
    assert.equal(output, 'First line. Second line.');
  });
});

describe('inferProviderLabel', () => {
  it('maps known providers and falls back to hostname', () => {
    assert.equal(inferProviderLabel('https://api.groq.com/openai/v1/chat/completions'), 'groq');
    assert.equal(inferProviderLabel('https://example.internal/v1/chat/completions'), 'example.internal');
  });
});

describe('buildNewsContextFromItems', () => {
  it('deduplicates duplicate headlines and includes metadata', () => {
    const now = new Date('2026-03-15T12:00:00Z');
    const context = buildNewsContextFromItems([
      {
        source: 'Reuters',
        title: 'Markets fall after new tariff threat',
        link: 'https://example.com/1',
        pubDate: now,
        isAlert: true,
        tier: 1,
        locationName: 'Washington',
        threat: { level: 'high', category: 'economic', confidence: 0.9, source: 'ml' },
      },
      {
        source: 'AP',
        title: 'Markets fall after new tariff threat',
        link: 'https://example.com/2',
        pubDate: new Date('2026-03-15T11:30:00Z'),
        isAlert: false,
      },
    ]);

    assert.match(context, /Recent News Signal Snapshot/);
    assert.match(context, /Reuters/);
    assert.match(context, /tier-1/);
    assert.match(context, /Washington/);
    assert.equal((context.match(/Markets fall after new tariff threat/g) || []).length, 1);
  });
});
