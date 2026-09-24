// whyMatters lines had no status-qualifier gate. scripts/eval-brief-model.mjs (PR #8546)
// caught deepseek-v4-flash, the model the whyMatters endpoint already runs, writing
// "Former President Trump's return to the UN..." in 2/2 samples for the Sep 20 story,
// and both parsers passed it. The line is repaired, not rejected: dropping the invented
// qualifier keeps a correct sentence, while rejecting would stub most Trump stories.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseWhyMatters,
  parseWhyMattersV2,
  repairStatusQualifiers,
  whyMattersGround,
} from '../shared/brief-llm-core.js';
import { generateWhyMatters } from '../scripts/lib/brief-llm.mjs';

const TRUMP_STORY = {
  headline: 'Trump Returns to UN as Iran War Spreads Across Shipping Chokepoints',
  source: 'gCaptain',
  threatLevel: 'critical',
  category: 'Geopolitics',
  country: 'United States',
};
const GROUND = TRUMP_STORY.headline;

// Verbatim from the captured deepseek-v4-flash run (tests/fixtures/brief-model-eval.json).
const CAPTURED =
  'Former President Trump’s return to the UN stage amid an escalating Iran-linked conflict disrupting critical maritime chokepoints threatens to unravel global trade stability and trigger a broader regional war.';
const REPAIRED =
  'President Trump’s return to the UN stage amid an escalating Iran-linked conflict disrupting critical maritime chokepoints threatens to unravel global trade stability and trigger a broader regional war.';

describe('repairStatusQualifiers', () => {
  it('drops the invented qualifier from the captured line and keeps the sentence', () => {
    assert.deepEqual(repairStatusQualifiers(CAPTURED, GROUND), { text: REPAIRED, removed: ['Former'] });
  });

  it('drops a mid-sentence qualifier and the space after it', () => {
    const r = repairStatusQualifiers('Markets moved as former US President Trump returned to the UN.', GROUND);
    assert.equal(r.text, 'Markets moved as US President Trump returned to the UN.');
  });

  it('capitalises the next word when the qualifier opened the sentence', () => {
    const r = repairStatusQualifiers('Talks stalled. former president Trump returned to the UN.', GROUND);
    assert.equal(r.text, 'Talks stalled. President Trump returned to the UN.');
  });

  it('drops the hyphenated then- form', () => {
    assert.equal(repairStatusQualifiers('The then-President Trump returned to the UN.', GROUND).text, 'The President Trump returned to the UN.');
  });

  it('leaves a qualifier the story carries', () => {
    const line = 'Former President Trump returned to the UN.';
    assert.deepEqual(repairStatusQualifiers(line, 'Former President Trump returns to UN'), { text: line, removed: [] });
  });

  it('leaves text with no titled person alone', () => {
    const line = 'Former officials said the deal was near.';
    assert.deepEqual(repairStatusQualifiers(line, GROUND), { text: line, removed: [] });
  });
});

describe('whyMatters parsers repair against the story', () => {
  it('parseWhyMatters repairs when given the story ground', () => {
    assert.equal(parseWhyMatters(CAPTURED, whyMattersGround(TRUMP_STORY)), REPAIRED);
  });

  it('parseWhyMatters without a ground keeps its old contract', () => {
    assert.equal(parseWhyMatters(CAPTURED), CAPTURED);
  });

  it('parseWhyMattersV2 repairs against publicStory', () => {
    const analyst = `${CAPTURED} Watch whether shipping insurers widen war-risk zones across the Gulf this week.`;
    const out = parseWhyMattersV2(analyst, { publicStory: { headline: TRUMP_STORY.headline, source: TRUMP_STORY.source } });
    assert.ok(out, 'repaired analyst prose must still pass');
    assert.ok(out.startsWith('President Trump’s return'), out);
  });

  it('whyMattersGround joins headline and description', () => {
    assert.equal(whyMattersGround({ headline: 'H', description: 'D' }), 'H D');
    assert.equal(whyMattersGround({ headline: 'H' }), 'H');
  });
});

describe('cron whyMatters paths', () => {
  const noCache = { cacheGet: async () => null, cacheSet: async () => {} };

  it('the direct-LLM fallback repairs the captured line', async () => {
    const out = await generateWhyMatters(TRUMP_STORY, { ...noCache, callLLM: async () => CAPTURED });
    assert.equal(out, REPAIRED);
  });

  it('an endpoint answer from a pre-fix deploy is repaired too', async () => {
    const out = await generateWhyMatters(TRUMP_STORY, { ...noCache, callAnalystWhyMatters: async () => CAPTURED, callLLM: async () => { throw new Error('must not fall back'); } });
    assert.equal(out, REPAIRED);
  });

  it('a cached fallback row written before the fix is repaired on read', async () => {
    const out = await generateWhyMatters(TRUMP_STORY, {
      cacheGet: async (key) => (key.startsWith('brief:llm:whymatters:v7:') ? CAPTURED : null),
      cacheSet: async () => {},
      callLLM: async () => { throw new Error('a repaired hit must not regenerate'); },
    });
    assert.equal(out, REPAIRED);
  });
});
