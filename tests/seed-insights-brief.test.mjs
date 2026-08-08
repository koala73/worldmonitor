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

  // NOTE: this asserts the acronym fix does not over-reject a lead whose
  // sentences all cite the same story. It does NOT prove citation scoping —
  // mutation-testing showed it stays green when grounding is pooled across all
  // stories. The scoping guarantee is pinned by "rejects a claim whose proper
  // nouns come from a story it does not cite" below.
  it('accepts a multi-sentence lead that cites one story throughout', () => {
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

// #5947 review (adversarial + correctness, independently): collapsing EVERY
// dotted acronym before splitting removed real sentence boundaries too, merging
// two sentences into one validation unit whose citation set is the UNION of
// both. That re-opens the shape-valid misattribution #4928 closed, and lets an
// uncited sentence ride along inside a cited one. Only an acronym followed by a
// lowercase word is provably mid-sentence; anything else must stay a boundary.
describe('composeSynthesizedBrief acronym boundaries fail closed (#5947 review)', () => {
  const topStories = [
    {
      primaryTitle: 'GCC condemns Iranian attacks on Kuwait',
      primarySource: 'The National',
      primaryLink: 'http://gcc',
      sources: ['The National', 'Reuters'],
      memberTitles: ['GCC condemns Iranian attacks on Kuwait'],
    },
    {
      primaryTitle: 'U.S. Embassies Urge Citizens to Consider Leaving the Region',
      primarySource: 'The Hindu',
      primaryLink: 'http://embassies',
      sources: ['The Hindu', 'AP News'],
      memberTitles: ['U.S. Embassies Urge Citizens to Consider Leaving the Region'],
    },
  ];
  const lines = [
    { n: 1, text: 'GCC condemns Iranian attacks on Kuwait [1]' },
    { n: 2, text: 'U.S. Embassies urge citizens to consider leaving the region [2]' },
  ];

  it('rejects a claim whose proper nouns come from a story it does not cite', () => {
    // "the U.S." is attributed to [1], which never mentions the US. A merged
    // validation unit would let it ground against [2] instead.
    const misattributed = JSON.stringify({
      lead: 'GCC states condemned Iranian attacks on Kuwait [1], and warnings were issued by the U.S. Embassies urged citizens to leave the region [2].',
      lines,
    });
    assert.equal(composeSynthesizedBrief(misattributed, topStories, { validatorMode: 'enforce' }), null);
  });

  it('rejects an uncited sentence that follows an acronym-terminated sentence', () => {
    const uncitedMiddle = JSON.stringify({
      lead: 'GCC states condemned Iranian attacks on Kuwait [1]. Meanwhile pressure mounted on the U.S. Embassies urged citizens to leave the region [2].',
      lines,
    });
    assert.equal(composeSynthesizedBrief(uncitedMiddle, topStories, { validatorMode: 'enforce' }), null);
  });

  it('keeps a genuine sentence boundary after a terminal acronym', () => {
    // Capitalized continuation = real boundary. The second sentence is uncited,
    // so a correct gate rejects; a gate that merged them would publish.
    const terminalAcronym = JSON.stringify({
      lead: 'Citizens were urged to leave the region by the U.S. Embassies remain open for now.',
      lines,
    });
    assert.equal(composeSynthesizedBrief(terminalAcronym, topStories, { validatorMode: 'enforce' }), null);
  });
});

// #5947 (still degraded after #6019/#6030): a clause ENDING in a dotted acronym
// carries its citation after the acronym — "not with the U.S. [2]." — which is
// how the model writes it whenever the acronym is the object of the sentence.
// The lowercase-only lookahead did not fire (the follower is '['), so the split
// cut at the acronym, stranding an uncited fragment AND orphaning "[2]." into a
// pseudo-sentence of its own. Measured against the live 2026-08-03T12:33Z
// digest: 4 of 5 gate rejections in a 12-sample run had exactly this shape.
//
// A citation marker cannot begin a sentence, so this is provably mid-clause —
// the same class of proof as the lowercase rule, NOT a relaxation of the
// fail-closed policy above. Merging is also citation-neutral here: the fragment
// is joined to its OWN trailing citation, never to another sentence's, so the
// #4928 union hazard is not re-opened.
describe('composeSynthesizedBrief acronym followed by its citation (#5947)', () => {
  const topStories = [
    {
      primaryTitle: 'GCC condemns Iranian attacks on Kuwait',
      primarySource: 'The National',
      primaryLink: 'http://gcc',
      sources: ['The National', 'Reuters'],
      memberTitles: ['GCC condemns Iranian attacks on Kuwait'],
    },
    {
      primaryTitle: 'U.S. Embassies Urge Citizens to Consider Leaving the Region',
      primarySource: 'The Hindu',
      primaryLink: 'http://embassies',
      sources: ['The Hindu', 'AP News'],
      memberTitles: ['U.S. Embassies Urge Citizens to Consider Leaving the Region'],
    },
  ];
  const lines = [
    { n: 1, text: 'GCC condemns Iranian attacks on Kuwait [1]' },
    { n: 2, text: 'U.S. Embassies urge citizens to consider leaving the region [2]' },
  ];

  it('accepts a sentence whose citation follows a terminal dotted acronym', () => {
    const citedAcronym = JSON.stringify({
      lead: 'GCC states condemned Iranian attacks on Kuwait [1]. Citizens were urged to leave the region by the U.S. [2].',
      lines,
    });
    const composed = composeSynthesizedBrief(citedAcronym, topStories, { validatorMode: 'enforce' });
    assert.notEqual(composed, null, 'the clause owns the [2] that follows its acronym — it is not uncited');
    assert.match(composed.lead, /U\.S\. \[2\]/, 'the published lead keeps its original punctuation');
  });

  it('still rejects an uncited sentence after an acronym that carries its citation', () => {
    // The merge must join the fragment to its OWN citation only. A following
    // sentence with no citation of its own stays a separate unit and rejects.
    const trailingUncited = JSON.stringify({
      lead: 'GCC states condemned Iranian attacks on Kuwait [1]. Citizens were urged to leave by the U.S. [2]. Analysts expect further escalation soon.',
      lines,
    });
    assert.equal(composeSynthesizedBrief(trailingUncited, topStories, { validatorMode: 'enforce' }), null);
  });

  // Scoping must be pinned by a DISCRIMINATING pair, not a lone rejection.
  // The first version of this test led with "Citizens were urged to leave…",
  // and review showed it rejected on the sentence-initial "Citizens" — deleting
  // the acronym entirely still rejected, so it never tested acronym scoping at
  // all. Here "The" is a sentence-start stopword and "region" is lowercase, so
  // the acronym is the ONLY proper noun in that sentence: the citation index is
  // the sole variable and the verdict flips with it.
  it('scopes the collapsed acronym to the story it cites (negative)', () => {
    const misattributed = JSON.stringify({
      lead: 'GCC states condemned Iranian attacks on Kuwait [1]. The region was pressured by the U.S. [1].',
      lines,
    });
    assert.equal(
      composeSynthesizedBrief(misattributed, topStories, { validatorMode: 'enforce' }),
      null,
      'story 1 never mentions the US — collapsing must not let it ground against story 2',
    );
  });

  it('scopes the collapsed acronym to the story it cites (positive)', () => {
    const grounded = JSON.stringify({
      lead: 'GCC states condemned Iranian attacks on Kuwait [1]. The region was pressured by the U.S. [2].',
      lines,
    });
    assert.notEqual(
      composeSynthesizedBrief(grounded, topStories, { validatorMode: 'enforce' }),
      null,
      'identical text citing [2] must pass — only the citation index differs',
    );
  });

  // Cross-model adversarial review (Codex) broke the first version of this fix,
  // which matched a bare "[n]" with no requirement that it CLOSE the sentence.
  // "…the U.S. [1] GCC condemned…[2]." then collapsed with no sentence
  // terminator anywhere, so the split produced ONE unit citing {1,2} and each
  // claim validated against the other's story — the #4928 misattribution this
  // whole gate exists to prevent, re-opened by the fix meant to preserve it.
  // These pin the fail-closed direction of the citation branch specifically:
  // both go green under the old lowercase-only regex too, but they are the only
  // tests that RED the over-permissive bare-marker version.
  it('does not merge two sentences when the citation run does not close the first', () => {
    const unioned = JSON.stringify({
      lead: 'Citizens were urged to leave the region by the U.S. [1] GCC states condemned Iranian attacks on Kuwait [2].',
      lines,
    });
    assert.equal(
      composeSynthesizedBrief(unioned, topStories, { validatorMode: 'enforce' }),
      null,
      'a bare marker mid-lead must stay a boundary — merging would union {1,2}',
    );
  });

  it('does not merge on an adjacent citation run that does not close the sentence', () => {
    const adjacentUnioned = JSON.stringify({
      lead: 'Citizens were urged to leave the region by the U.S. [1][2] GCC states condemned Iranian attacks on Kuwait [2].',
      lines,
    });
    assert.equal(composeSynthesizedBrief(adjacentUnioned, topStories, { validatorMode: 'enforce' }), null);
  });

  it('accepts an adjacent citation run that does close the sentence', () => {
    // The multi-citation shape the system prompt explicitly asks for ("[3][7]"),
    // terminated — collapsing here joins the clause to citations it already owned.
    const adjacentClosed = JSON.stringify({
      lead: 'GCC states condemned Iranian attacks on Kuwait [1]. Citizens were urged to leave the region by the U.S. [1][2].',
      lines,
    });
    assert.notEqual(composeSynthesizedBrief(adjacentClosed, topStories, { validatorMode: 'enforce' }), null);
  });

  it('accepts a citation run that closes the lead with no trailing punctuation', () => {
    const endOfLead = JSON.stringify({
      lead: 'GCC states condemned Iranian attacks on Kuwait [1]. Citizens were urged to leave the region by the U.S. [2]',
      lines,
    });
    assert.notEqual(composeSynthesizedBrief(endOfLead, topStories, { validatorMode: 'enforce' }), null);
  });

  // #6109 adversarial review: the sentence-initial amnesty was reachable
  // MID-CLAUSE by manufacturing a boundary the validator's own splitter honors
  // but the caller's does not. The validator splits on /[.!?]+\s+|\n+/, so a
  // bare newline (or a lowercase abbreviation like "vs.") turns an arbitrary
  // capital into a "sentence-initial" token and hands it the amnesty. The
  // reviewer published "Apple cut its regional orders" grounded only by
  // "apple prices" this way — defeating the very guard the unit tests pin.
  // Fixed by requiring the FIRST sentence, not merely a sentence start.
  // These run through the real composer because that is where it published.
  describe('#6109 amnesty is not reachable via a synthetic sentence boundary', () => {
    const topStories = [
      {
        primaryTitle: 'Regional apple prices rose sharply in Chile last quarter, growers say',
        primarySource: 'Reuters',
        primaryLink: 'http://apple',
        sources: ['Reuters', 'AP News'],
        memberTitles: ['Regional apple prices rose sharply in Chile last quarter, growers say'],
      },
    ];
    const lines = [{ n: 1, text: 'Regional apple prices rose sharply in Chile [1]' }];

    it('rejects a lead smuggling a capital past a bare newline', () => {
      const smuggled = JSON.stringify({
        lead: 'Chile reported grower losses [1].\nApple cut its regional orders [1].',
        lines,
      });
      assert.equal(
        composeSynthesizedBrief(smuggled, topStories, { validatorMode: 'enforce' }),
        null,
        '"apple" the fruit must not license "Apple" the company via a newline',
      );
    });

    it('rejects a lead smuggling a capital past a lowercase abbreviation', () => {
      const smuggled = JSON.stringify({
        lead: 'Chile grower losses mounted vs. Apple regional orders [1].',
        lines,
      });
      assert.equal(composeSynthesizedBrief(smuggled, topStories, { validatorMode: 'enforce' }), null);
    });

    it('still composes the legitimate sentence-initial case end-to-end', () => {
      const legit = JSON.stringify({
        lead: 'Prices rose sharply in Chile last quarter [1].',
        lines,
      });
      assert.notEqual(composeSynthesizedBrief(legit, topStories, { validatorMode: 'enforce' }), null);
    });
  });

  it('treats a bracketed year after the acronym as prose, not a citation', () => {
    // verifyCitationIndexes deliberately leaves 4-digit brackets as prose, and
    // \d{1,3} cannot match one — so "[2026]" must not license a collapse. The
    // fragment stays uncited and fails closed.
    const bracketedYear = JSON.stringify({
      lead: 'GCC states condemned Iranian attacks on Kuwait [1]. The region was pressured by the U.S. [2026].',
      lines,
    });
    assert.equal(composeSynthesizedBrief(bracketedYear, topStories, { validatorMode: 'enforce' }), null);
  });

  it('stays closed when an out-of-range marker is stripped down to a bare one', () => {
    // verifyCitationIndexes strips [999] BEFORE the split, so the gate sees
    // "U.S. [2] GCC…" — a bare marker that must not collapse.
    const strippedToBare = JSON.stringify({
      lead: 'Citizens were urged to leave the region by the U.S. [999] [2] GCC states condemned Iranian attacks on Kuwait [1].',
      lines,
    });
    assert.equal(composeSynthesizedBrief(strippedToBare, topStories, { validatorMode: 'enforce' }), null);
  });
});
