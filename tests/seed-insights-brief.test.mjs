import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  pickBriefCluster,
  briefSystemPrompt,
  briefUserPrompt,
  composeSynthesizedBrief,
} from '../scripts/_insights-brief.mjs';

describe('pickBriefCluster', () => {
  it('returns null for empty/non-array input', () => {
    assert.equal(pickBriefCluster([]), null);
    assert.equal(pickBriefCluster(null), null);
    assert.equal(pickBriefCluster(undefined), null);
  });

  it('returns null when every cluster is single-source', () => {
    const top = [
      { sourceCount: 3, sources: ['Reuters'], primaryTitle: 'A' },
      { sourceCount: 1, sources: ['AP News'], primaryTitle: 'B' },
    ];
    assert.equal(pickBriefCluster(top), null);
  });

  it('returns the first cluster with at least two unique sources', () => {
    const top = [
      { sourceCount: 3, sources: ['Reuters'], primaryTitle: 'A' },
      { sourceCount: 3, sources: ['Reuters', 'AP News'], primaryTitle: 'B' },
      { sourceCount: 2, sources: ['BBC World', 'Axios'], primaryTitle: 'C' },
    ];
    assert.equal(pickBriefCluster(top).primaryTitle, 'B');
  });

  it('accepts a single-cluster source when entity corroboration was established across related clusters', () => {
    const top = [
      { sourceCount: 1, sources: ['Reuters'], entityCorroboration: true, primaryTitle: 'US and Iran close deal' },
    ];
    assert.equal(pickBriefCluster(top).primaryTitle, 'US and Iran close deal');
  });

  it('skips a higher-ranked single-source rumor for a lower-ranked multi-sourced lead (regression: News24 Iran supreme leader 2026-04-23)', () => {
    const top = [
      {
        sourceCount: 1,
        sources: ['News24'],
        primaryTitle: 'Iran new supreme leader seriously wounded, delegates power to Revolutionary Guards',
        importanceScore: 350,
      },
      {
        sourceCount: 2,
        sources: ['Reuters', 'AP News'],
        primaryTitle: 'Lebanon leaders accuse Israel of war crime after journalist killed',
        importanceScore: 300,
      },
    ];
    const picked = pickBriefCluster(top);
    assert.ok(picked, 'expected a multi-source cluster to be picked');
    assert.match(picked.primaryTitle, /Lebanon/);
    assert.doesNotMatch(picked.primaryTitle, /supreme leader/);
  });

  it('treats a missing sourceCount as 1 (safe default — do not brief on unknown corroboration)', () => {
    const top = [
      { primaryTitle: 'A' }, // no sourceCount field
      { sourceCount: 2, sources: ['Reuters', 'AP News'], primaryTitle: 'B' },
    ];
    assert.equal(pickBriefCluster(top).primaryTitle, 'B');
  });

  it('tolerates a null/undefined entry without throwing', () => {
    const top = [null, undefined, { sourceCount: 2, sources: ['Reuters', 'AP News'], primaryTitle: 'A' }];
    assert.equal(pickBriefCluster(top).primaryTitle, 'A');
  });
});

describe('briefSystemPrompt', () => {
  const prompt = briefSystemPrompt('2026-04-24');

  it('includes the injected date', () => {
    assert.match(prompt, /2026-04-24/);
  });

  it('forbids inventing facts absent from the headline', () => {
    assert.match(prompt, /Use ONLY facts present/);
    assert.match(prompt, /Do not invent proper nouns/);
  });

  it('makes location conditional — no unconditional "WHERE" directive', () => {
    // Regression: P2 review finding. "Lead with WHAT happened and WHERE" + "use ONLY facts"
    // conflicted for headlines with no location, pushing the model to confabulate one.
    assert.doesNotMatch(prompt, /Lead with WHAT happened and WHERE/);
    assert.match(prompt, /ONLY if it appears in the headline/);
  });

  it('does not ask the LLM to rank/pick from multiple headlines', () => {
    // Regression: the original prompt said "Pick the ONE most significant headline".
    // Ranking is now done by pickBriefCluster upstream.
    assert.doesNotMatch(prompt, /Pick the ONE most significant/);
    assert.doesNotMatch(prompt, /Each numbered headline/i);
    assert.doesNotMatch(prompt, /summarize ONLY that story/i);
  });
});

describe('briefUserPrompt', () => {
  it('passes the headline verbatim', () => {
    const headline = 'Iran launches missile strikes on targets in Syria';
    const out = briefUserPrompt(headline);
    assert.ok(out.includes(headline));
  });

  it('instructs using only facts from the provided headline', () => {
    assert.match(briefUserPrompt('X'), /only facts from this headline/i);
  });
});

// #5947 (second failure mode): the lead's own sentence splitter used a bare
// /(?<=[.!?])\s+/, so a dotted acronym broke the lead mid-clause. Production
// leads citing "U.S. embassies" split into a fragment ending at "U.S.", which
// then carried the WRONG citation set and was flagged for the proper noun
// "us" — rejecting the whole brief. brief-llm-core already normalizes dotted
// acronyms before tokenizing for exactly this hazard (PR #3836); the lead
// gate has to do the same before it decides where sentences end.
describe('composeSynthesizedBrief lead sentence boundaries (#5947)', () => {
  const topStories = [
    {
      primaryTitle: 'GCC condemns Iranian attacks on Kuwait',
      primarySource: 'The National',
      primaryLink: 'http://gcc',
      sources: ['The National', 'Reuters'],
      memberTitles: ['GCC condemns Iranian attacks on Kuwait'],
    },
    {
      primaryTitle: 'U.S. embassies urge citizens to consider leaving the region',
      primarySource: 'The Hindu',
      primaryLink: 'http://embassies',
      sources: ['The Hindu', 'AP News'],
      memberTitles: ['U.S. embassies urge citizens to consider leaving the region'],
    },
  ];
  const raw = JSON.stringify({
    lead: 'The GCC condemned Iranian attacks on Kuwait [1], while U.S. embassies urged citizens to consider leaving the region [2].',
    lines: [
      { n: 1, text: 'GCC condemns Iranian attacks on Kuwait [1]' },
      { n: 2, text: 'U.S. embassies urge citizens to consider leaving the region [2]' },
    ],
  });

  it('does not split the lead inside a dotted acronym', () => {
    const composed = composeSynthesizedBrief(raw, topStories, { validatorMode: 'enforce' });
    assert.notEqual(composed, null, 'a grounded lead citing "U.S." must not be rejected');
    assert.match(composed.lead, /U\.S\. embassies/, 'the published lead keeps its original text');
  });

  it('still rejects a genuinely uncited lead sentence', () => {
    const uncited = JSON.stringify({
      lead: 'The GCC condemned Iranian attacks on Kuwait [1]. Analysts expect further escalation soon.',
      lines: [
        { n: 1, text: 'GCC condemns Iranian attacks on Kuwait [1]' },
        { n: 2, text: 'U.S. embassies urge citizens to consider leaving the region [2]' },
      ],
    });
    assert.equal(composeSynthesizedBrief(uncited, topStories, { validatorMode: 'enforce' }), null);
  });

  it('still rejects a hallucinated proper noun in a cited sentence', () => {
    const halluc = JSON.stringify({
      lead: 'The GCC condemned Venezuelan attacks on Montevideo [1], while U.S. embassies urged citizens to consider leaving the region [2].',
      lines: [
        { n: 1, text: 'GCC condemns Iranian attacks on Kuwait [1]' },
        { n: 2, text: 'U.S. embassies urge citizens to consider leaving the region [2]' },
      ],
    });
    assert.equal(composeSynthesizedBrief(halluc, topStories, { validatorMode: 'enforce' }), null);
  });

  it('keeps citation scoping per sentence rather than pooling the whole lead', () => {
    // Story 2's proper nouns must NOT ground a claim that only cites [1].
    const crossed = JSON.stringify({
      lead: 'The GCC condemned attacks on Kuwait [1]. Kuwait embassies urged citizens to leave [1].',
      lines: [
        { n: 1, text: 'GCC condemns Iranian attacks on Kuwait [1]' },
        { n: 2, text: 'U.S. embassies urge citizens to consider leaving the region [2]' },
      ],
    });
    const composed = composeSynthesizedBrief(crossed, topStories, { validatorMode: 'enforce' });
    assert.notEqual(composed, null, 'both sentences cite [1] and use only story 1 nouns');
  });
});
