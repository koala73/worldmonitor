// Forecast narrative cache identity (#4914).
//
// The combined/scenario narrative caches (forecast:llm-combined:{hash},
// forecast:llm-scenarios:{hash}) previously hashed raw prediction values the
// prompt never renders — probability floats (the prompt shows integer
// percents), every newsContext entry (the prompt shows the top 3), cascade
// probability floats. Hourly drift minted a fresh key for a byte-identical
// prompt, so the seeder paid a full narrative generation every run.
//
// The fix keys the cache on the exact prompt text (system + user) — the same
// pattern as the regional narrative cache (#4911): byte-identical prompt →
// cache hit; any prompt-visible change → new key.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildUserPrompt,
  buildNarrativeCacheHash,
} from '../scripts/seed-forecasts.mjs';

function makePred(overrides = {}) {
  return {
    id: 'pred-1',
    title: 'Hormuz shipping disruption escalates',
    domain: 'energy',
    region: 'Middle East',
    probability: 0.521,
    confidence: 0.68,
    trend: 'rising',
    timeHorizon: '7d',
    signals: [{ value: 'Tanker reroutings up 40% week-over-week' }],
    newsContext: ['Strait transit volumes fall', 'Insurers raise war-risk premiums', 'Naval escorts expand'],
    ...overrides,
  };
}

describe('buildNarrativeCacheHash (#4914)', () => {
  const SYSTEM = 'You are a senior geopolitical intelligence analyst.';

  it('probability drift within the same rendered integer percent keeps the same key', () => {
    // 0.521 and 0.524 both render as "52%" — the prompt is byte-identical,
    // so the cache identity must be too.
    const a = buildNarrativeCacheHash(SYSTEM, buildUserPrompt([makePred({ probability: 0.521 })]));
    const b = buildNarrativeCacheHash(SYSTEM, buildUserPrompt([makePred({ probability: 0.524 })]));
    assert.equal(a, b, 'sub-percent probability drift must not bust the narrative cache');
  });

  it('a material probability change produces a different key', () => {
    const a = buildNarrativeCacheHash(SYSTEM, buildUserPrompt([makePred({ probability: 0.52 })]));
    const b = buildNarrativeCacheHash(SYSTEM, buildUserPrompt([makePred({ probability: 0.57 })]));
    assert.notEqual(a, b);
  });

  it('newsContext entries beyond the prompt-rendered top-3 do not shift the key', () => {
    const top3 = ['Strait transit volumes fall', 'Insurers raise war-risk premiums', 'Naval escorts expand'];
    const a = buildNarrativeCacheHash(SYSTEM, buildUserPrompt([makePred({ newsContext: top3 })]));
    const b = buildNarrativeCacheHash(SYSTEM, buildUserPrompt([makePred({ newsContext: [...top3, 'A fourth headline the prompt never sees'] })]));
    assert.equal(a, b, 'the prompt renders newsContext.slice(0, 3) — invisible tail entries must not bust the cache');
  });

  it('a different system prompt produces a different key (deploy-time prompt changes self-invalidate)', () => {
    const user = buildUserPrompt([makePred()]);
    assert.notEqual(
      buildNarrativeCacheHash(SYSTEM, user),
      buildNarrativeCacheHash(`${SYSTEM} Write in bullet points.`, user),
    );
  });

  it('a changed signal value (prompt-visible) produces a different key', () => {
    const a = buildNarrativeCacheHash(SYSTEM, buildUserPrompt([makePred()]));
    const b = buildNarrativeCacheHash(SYSTEM, buildUserPrompt([makePred({ signals: [{ value: 'Tanker reroutings up 60% week-over-week' }] })]));
    assert.notEqual(a, b);
  });
});
