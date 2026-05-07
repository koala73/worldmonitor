import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  pickBriefCluster,
  briefSystemPrompt,
  briefUserPrompt,
} from '../scripts/_insights-brief.mjs';

describe('pickBriefCluster', () => {
  it('returns null for empty/non-array input', () => {
    assert.equal(pickBriefCluster([]), null);
    assert.equal(pickBriefCluster(null), null);
    assert.equal(pickBriefCluster(undefined), null);
  });

  it('returns null when every cluster is single-source', () => {
    const top = [
      { sourceCount: 1, primaryTitle: 'A' },
      { sourceCount: 1, primaryTitle: 'B' },
    ];
    assert.equal(pickBriefCluster(top), null);
  });

  it('returns the first cluster with sourceCount >= 2', () => {
    const top = [
      { sourceCount: 1, primaryTitle: 'A' },
      { sourceCount: 3, primaryTitle: 'B' },
      { sourceCount: 2, primaryTitle: 'C' },
    ];
    assert.equal(pickBriefCluster(top).primaryTitle, 'B');
  });

  it('skips a higher-ranked single-source rumor for a lower-ranked multi-sourced lead (regression: News24 Iran supreme leader 2026-04-23)', () => {
    const top = [
      {
        sourceCount: 1,
        primaryTitle: 'Iran new supreme leader seriously wounded, delegates power to Revolutionary Guards',
        importanceScore: 350,
      },
      {
        sourceCount: 2,
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
      { sourceCount: 2, primaryTitle: 'B' },
    ];
    assert.equal(pickBriefCluster(top).primaryTitle, 'B');
  });

  it('tolerates a null/undefined entry without throwing', () => {
    const top = [null, undefined, { sourceCount: 2, primaryTitle: 'A' }];
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
