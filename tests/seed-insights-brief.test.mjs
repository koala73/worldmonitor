import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  pickBriefCluster,
  briefSystemPrompt,
  briefUserPrompt,
  synthesisSystemPrompt,
  maskAttributedSources,
  composeSynthesizedBrief,
  composeSynthesizedBriefResult,
  BRIEF_REJECTIONS,
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

describe('synthesis attribution contract', () => {
  it('tells the model to copy exact outlet labels and use canonical attribution forms', () => {
    const prompt = synthesisSystemPrompt('2026-08-18');
    assert.match(prompt, /copy its label exactly \(including capitalization\)/);
    assert.match(prompt, /reported\/reports\/said\/says\/wrote\/writes/);
    assert.match(prompt, /According to <outlet>/);
  });

  it('masks the longer prefix-related label regardless of source order', () => {
    const text = 'ABC News Australia reported port workers extended the walkout.';
    const expected = ' reported port workers extended the walkout.';

    assert.equal(maskAttributedSources(text, ['ABC News', 'ABC News Australia']), expected);
    assert.equal(maskAttributedSources(text, ['ABC News Australia', 'ABC News']), expected);
  });

  it('matches labels exactly by case, so WHO does not consume lowercase who', () => {
    const pronoun = 'Officials who monitored the outbreak issued guidance.';
    assert.equal(maskAttributedSources(pronoun, ['WHO']), pronoun);
    assert.equal(maskAttributedSources('WHO reported new guidance.', ['WHO']), ' reported new guidance.');
  });

  it('accepts the canonical According-to form', () => {
    assert.equal(
      maskAttributedSources('According to Reuters, prices rose.', ['Reuters']),
      ', prices rose.',
    );
  });

  it('escapes special source labels and permits flexible whitespace', () => {
    const fixtures = [
      ['+972   Magazine reported unrest spread.', '+972 Magazine', ' reported unrest spread.'],
      ['24.hu said talks resumed.', '24.hu', ' said talks resumed.'],
      ['CAC (China) wrote that rules changed.', 'CAC (China)', ' wrote that rules changed.'],
    ];

    for (const [text, source, expected] of fixtures) {
      assert.equal(maskAttributedSources(text, [source]), expected, source);
    }
  });

  it('does not mask special source labels used outside an attribution', () => {
    for (const [text, source] of [
      ['The +972 Magazine office expanded.', '+972 Magazine'],
      ['24.hu launched a service.', '24.hu'],
      ['CAC (China) deployed inspectors.', 'CAC (China)'],
    ]) {
      assert.equal(maskAttributedSources(text, [source]), text, source);
    }
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

// #5947: the producer reported one opaque INSIGHTS_SYNTHESIS_GATE for every
// editorial gate, so a repeating rejection could only be attributed by
// snapshotting the live digest and replaying it through an offline harness —
// which both the #6019 and #6119 investigations had to build from scratch.
// Each rejection now names its own gate.
//
// Every case here drives the REAL composer with a fixture that reaches the gate
// under test: an assertion that only pinned the map's shape would still pass
// with the reasons wired to the wrong return points.
describe('composeSynthesizedBriefResult names which gate rejected (#5947)', () => {
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
  const compose = (lead) =>
    composeSynthesizedBriefResult(JSON.stringify({ lead, lines }), topStories, { validatorMode: 'enforce' });

  it('composes with no rejection when the lead is grounded and cited', () => {
    const out = compose('Prices rose sharply in Chile last quarter [1].');
    assert.equal(out.rejection, null);
    assert.ok(out.brief, 'a composed brief must be returned alongside the null rejection');
    assert.match(out.brief.lead, /Chile/);
  });

  it('accepts a lead naming the outlet the prompt showed it', () => {
    // synthesisUserPrompt renders each story as
    //   `N. <primaryTitle> (<primarySource>, K sources)`
    // and the system prompt says "Use ONLY facts present in the numbered story
    // text". primarySource is IN that text, so naming the outlet obeys the
    // prompt — yet the ground text omitted it, and the sentence was rejected as
    // a hallucinated proper noun.
    //
    // Cost of the omission: on 2026-08-18 newsInsights alarmed 13 times in
    // 10.5h, every one INSIGHTS_SYNTHESIS_LEAD_PROPER_NOUN, with the provider
    // chain falling past the PAID model to a free one because that loop
    // advances on gate rejection. A frontier model failing routinely is the
    // gate over-rejecting, not the model hallucinating.
    const out = compose('Reuters reported apple prices rose sharply in Chile last quarter [1].');
    assert.equal(
      out.rejection,
      null,
      'a proper noun the prompt itself supplied must ground, or the gate rejects obedience',
    );
    assert.ok(out.brief, 'the brief must compose rather than fall back');
    assert.match(out.brief.lead, /Reuters/);
    assert.equal(out.brief.sourceAttributions, 1, 'the accept side must report that the lead named its outlet');
  });

  it('accepts an According-to attribution naming the outlet', () => {
    const out = compose('According to Reuters, apple prices rose sharply in Chile last quarter [1].');
    assert.equal(out.rejection, null);
    assert.ok(out.brief);
    assert.equal(out.brief.sourceAttributions, 1);
  });

  it('still rejects a proper noun in NEITHER the headline nor the source', () => {
    // Bounded: an outlet the model was never given is still a hallucination.
    // NOTE this case alone cannot detect a WIDENING — it rejects identically
    // before and after any change to what grounds. The three tests below are
    // the ones that actually bound it.
    const out = compose('Bloomberg reported apple prices rose sharply in Chile last quarter [1].');
    assert.equal(out.brief, null);
    assert.equal(out.rejection, BRIEF_REJECTIONS.LEAD_PROPER_NOUN);
  });

  it('names the proper noun it rejected, not just the gate', () => {
    // Production could say a lead was rejected but never WHAT tripped it, so
    // deciding whether a rejection was a real hallucination or a grounding
    // false-positive meant guessing. The validator has always returned the
    // offending sequence; the gate discarded it. The sibling summary gate has
    // logged `invented "talks" not in headline` since #6109 — same field.
    const out = compose('Bloomberg reported apple prices rose sharply in Chile last quarter [1].');
    assert.equal(out.rejection, BRIEF_REJECTIONS.LEAD_PROPER_NOUN);
    assert.equal(
      out.rejectionDetail,
      'bloomberg',
      'the rejection must carry the offending sequence so the log can name it',
    );
  });

  it('carries no detail when the brief is accepted', () => {
    // Shape stability: a caller reading rejectionDetail must not have to guard
    // against it being stale from a previous compose.
    const out = compose('According to Reuters, apple prices rose sharply in Chile last quarter [1].');
    assert.equal(out.rejection, null);
    assert.equal(out.rejectionDetail, null);
  });

  it('still rejects a corroborating source the prompt never showed', () => {
    // The fixture's `sources` carries 'AP News', but synthesisUserPrompt renders
    // only primarySource plus a publisher COUNT. Grounding the rest of the
    // cluster would widen past what the model was shown — and unlike the
    // Bloomberg case above, a label that IS on the story object is what
    // distinguishes a primarySource-scoped implementation from a sources[]-wide
    // one. Without this, that mutant passes the whole file.
    const out = compose('AP News reported apple prices rose sharply in Chile last quarter [1].');
    assert.equal(out.brief, null);
    assert.equal(out.rejection, BRIEF_REJECTIONS.LEAD_PROPER_NOUN);
  });

  it('lets a multi-word outlet attribute without donating its tokens', () => {
    // The ground text is TOKENISED, so folding a label into it would let
    // 'Iran International' ground a lead asserting that *Iran* acted — the swap
    // the system prompt forbids ("write 'US', not 'Washington'"). 40+ of the 416
    // labels in source-tiers.json carry a country/capital/institution token.
    // Naming the outlet must pass; mining a token out of it must not.
    const iranStory = [{
      primaryTitle: 'Fuel protests spread in Mashhad as queues lengthen at stations',
      primarySource: 'Iran International',
      primaryLink: 'http://fuel',
      sources: ['Iran International', 'AFP'],
      memberTitles: ['Fuel protests spread in Mashhad as queues lengthen at stations'],
    }];
    const composeIran = (lead) => composeSynthesizedBriefResult(
      JSON.stringify({ lead, lines: [{ n: 1, text: 'Fuel protests spread in Mashhad [1]' }] }),
      iranStory,
      { validatorMode: 'enforce' },
    );

    const attributed = composeIran('Iran International reported fuel protests spread in Mashhad [1].');
    assert.equal(attributed.rejection, null, 'a multi-word outlet must still be nameable');
    assert.match(attributed.brief.lead, /Iran International/);

    const outletAsActor = composeIran(
      'Fuel protests spread in Mashhad, and Iran International deployed security forces [1].',
    );
    assert.equal(outletAsActor.brief, null, 'an outlet label outside an attribution must stay gated');
    assert.equal(outletAsActor.rejection, BRIEF_REJECTIONS.LEAD_PROPER_NOUN);

    const mined = composeIran('Fuel protests spread in Mashhad, and Iran deployed security forces [1].');
    assert.equal(mined.brief, null, 'the outlet label must not ground an actor the story never names');
    assert.equal(mined.rejection, BRIEF_REJECTIONS.LEAD_PROPER_NOUN);
  });

  it('does not count a lowercase relative pronoun as a WHO attribution', () => {
    const whoStory = [{
      primaryTitle: 'Vaccination rates increased in Kenya as health officials monitored the campaign',
      primarySource: 'WHO',
      primaryLink: 'http://vaccination',
      sources: ['WHO', 'Reuters'],
      memberTitles: ['Vaccination rates increased in Kenya as health officials monitored the campaign'],
    }];
    const composeWho = (lead) => composeSynthesizedBriefResult(
      JSON.stringify({ lead, lines: [{ n: 1, text: 'Vaccination rates increased in Kenya [1]' }] }),
      whoStory,
      { validatorMode: 'enforce' },
    );

    const pronoun = composeWho('Vaccination rates increased in Kenya as officials who monitored the campaign reported [1].');
    assert.equal(pronoun.rejection, null);
    assert.equal(pronoun.brief.sourceAttributions, 0, 'lowercase who is not the uppercase outlet label');

    const attributed = composeWho('WHO reported vaccination rates increased in Kenya [1].');
    assert.equal(attributed.rejection, null);
    assert.equal(attributed.brief.sourceAttributions, 1);
  });

  it('does not let digits in an outlet label ground a fabricated number', () => {
    // storyGroundText also feeds validateNoHallucinatedFacts. extractNumericFacts
    // reads any digit run not adjacent to a word character, so a label like
    // 'France 24' (a live source here, five feeds) would ground a fabricated
    // casualty count — digits that are a brand-name artefact, not a story fact.
    const franceStory = [{
      primaryTitle: 'Deadly strike hits a market in the northern district of the city',
      primarySource: 'France 24',
      primaryLink: 'http://strike',
      sources: ['France 24', 'AFP'],
      memberTitles: ['Deadly strike hits a market in the northern district of the city'],
    }];
    const composeFrance = (lead) => composeSynthesizedBriefResult(
      JSON.stringify({ lead, lines: [{ n: 1, text: 'A deadly strike hit a market [1]' }] }),
      franceStory,
      { validatorMode: 'enforce' },
    );

    const fabricated = composeFrance('A deadly strike hit a market in the northern district, and 24 people were killed [1].');
    assert.equal(fabricated.brief, null, "'France 24' must not ground the number 24");
    assert.equal(fabricated.rejection, BRIEF_REJECTIONS.LEAD_NUMERIC_FACT);

    const attributed = composeFrance('France 24 reported a deadly strike hit a market in the northern district [1].');
    assert.equal(attributed.rejection, null, 'naming the outlet must still be allowed');
  });

  it('accepts a per-story LINE naming the outlet, and still gates one that mines it', () => {
    // storyGroundText's THIRD call site. A line that falsely passes is published
    // verbatim instead of degrading to its headline, and stops incrementing
    // hallucinatedLines — so this path needs its own coverage, not the lead's.
    const withSourceLine = composeSynthesizedBriefResult(
      JSON.stringify({
        lead: 'Prices rose sharply in Chile last quarter [1].',
        lines: [{ n: 1, text: 'Reuters reported apple prices rose sharply in Chile [1]' }],
      }),
      topStories,
      { validatorMode: 'enforce' },
    );
    assert.equal(withSourceLine.rejection, null);
    assert.equal(withSourceLine.brief.hallucinatedLines, 0, 'naming the outlet is not a line hallucination');
    assert.match(withSourceLine.brief.lines[0].text, /Reuters/);

    const minedLine = composeSynthesizedBriefResult(
      JSON.stringify({
        lead: 'Prices rose sharply in Chile last quarter [1].',
        lines: [{ n: 1, text: 'Venezuela apple prices rose sharply [1]' }],
      }),
      topStories,
      { validatorMode: 'enforce' },
    );
    assert.equal(minedLine.brief.hallucinatedLines, 1, 'an ungrounded proper noun on a line still counts');
    assert.match(minedLine.brief.lines[0].text, /Regional apple prices/, 'and the line degrades to its headline');
  });

  it('degrades a story line that uses its outlet label as an actor', () => {
    const iranStory = [{
      primaryTitle: 'Fuel protests spread in Mashhad as queues lengthen at stations',
      primarySource: 'Iran International',
      primaryLink: 'http://fuel',
      sources: ['Iran International', 'AFP'],
      memberTitles: ['Fuel protests spread in Mashhad as queues lengthen at stations'],
    }];
    const out = composeSynthesizedBriefResult(
      JSON.stringify({
        lead: 'Fuel protests spread in Mashhad as queues lengthened [1].',
        lines: [{ n: 1, text: 'Iran International deployed security forces in Mashhad [1]' }],
      }),
      iranStory,
      { validatorMode: 'enforce' },
    );

    assert.equal(out.rejection, null);
    assert.equal(out.brief.hallucinatedLines, 1);
    assert.equal(
      out.brief.lines[0].text,
      'Fuel protests spread in Mashhad as queues lengthen at stations [1]',
    );
  });

  it('scopes the outlet allowance to the stories the sentence cites', () => {
    // The attribution allowance must be citation-SCOPED like the ground text
    // itself (#4928), or story 2's outlet licenses a name in a claim about
    // story 1 — shape-valid misattribution wearing an outlet's clothes.
    const twoStories = [
      {
        primaryTitle: 'Regional apple prices rose sharply in Chile last quarter, growers say',
        primarySource: 'Reuters',
        primaryLink: 'http://apple',
        sources: ['Reuters', 'AFP'],
        memberTitles: ['Regional apple prices rose sharply in Chile last quarter, growers say'],
      },
      {
        primaryTitle: 'Port workers extend the walkout at the container terminal',
        primarySource: 'Kyodo News',
        primaryLink: 'http://port',
        sources: ['Kyodo News', 'AFP'],
        memberTitles: ['Port workers extend the walkout at the container terminal'],
      },
    ];
    const out = composeSynthesizedBriefResult(
      JSON.stringify({
        lead: 'Kyodo News reported apple prices rose sharply in Chile last quarter [1].',
        lines: [
          { n: 1, text: 'Regional apple prices rose sharply in Chile [1]' },
          { n: 2, text: 'Port workers extend the walkout [2]' },
        ],
      }),
      twoStories,
      { validatorMode: 'enforce' },
    );
    assert.equal(out.brief, null, "story 2's outlet must not ground a sentence citing only [1]");
    assert.equal(out.rejection, BRIEF_REJECTIONS.LEAD_PROPER_NOUN);
  });

  it('masks the outlet as a whole word, not as a prefix', () => {
    // A substring mask would eat 'Reuters' out of 'Reutersville' and leave a
    // lowercase remainder that no longer reads as a proper noun — laundering an
    // invented place through the outlet's own name.
    const out = compose('Reutersville officials confirmed apple prices rose sharply in Chile [1].');
    assert.equal(out.brief, null);
    assert.equal(out.rejection, BRIEF_REJECTIONS.LEAD_PROPER_NOUN);
  });

  it('fails CLOSED when a cited story has no ground text at all', () => {
    // Both validators return ok:true for an empty ground string, so an untitled
    // cluster would accept every proper noun and every number in the lead — a
    // dead gate indistinguishable from a healthy one.
    // briefCluster/parsedSynthesis are the composer's own seams — used here so
    // the empty-ground gate is what the assertion isolates, not the cluster gate
    // or the parser (which would reject this fixture first).
    const untitled = composeSynthesizedBriefResult(
      '',
      [{ primaryTitle: '', primarySource: '', primaryLink: 'http://x', sources: ['A', 'B'], memberTitles: [] }],
      {
        validatorMode: 'enforce',
        briefCluster: {},
        parsedSynthesis: {
          lead: 'Bloomberg reported Venezuela seized 12 refineries [1].',
          lines: [{ n: 1, text: 'Something happened [1]' }],
        },
      },
    );
    assert.equal(untitled.brief, null);
    assert.equal(untitled.rejection, BRIEF_REJECTIONS.LEAD_GROUNDING);
  });

  it('names an uncited lead sentence', () => {
    const out = compose('Prices rose sharply in Chile last quarter [1]. Analysts expect more increases ahead.');
    assert.equal(out.brief, null);
    assert.equal(out.rejection, BRIEF_REJECTIONS.LEAD_UNCITED);
  });

  it('names a hallucinated proper noun', () => {
    const out = compose('Prices rose sharply in Venezuela last quarter [1].');
    assert.equal(out.brief, null);
    assert.equal(out.rejection, BRIEF_REJECTIONS.LEAD_PROPER_NOUN);
  });

  it('names a hallucinated numeric fact', () => {
    // Separate from the proper-noun gate on purpose: an invented NUMBER and an
    // invented NAME are different editorial failures with different fixes, and
    // the pre-#5947 GATE code made them indistinguishable in production.
    const out = compose('Prices rose sharply in Chile by 42 percent last quarter [1].');
    assert.equal(out.brief, null);
    assert.equal(out.rejection, BRIEF_REJECTIONS.LEAD_NUMERIC_FACT);
  });

  it('names an ungrounded lead that carries no hallucinated noun of its own', () => {
    // Passes the per-sentence proper-noun gate (it invents nothing) but shares
    // no anchor with any headline, so only checkLeadGrounding can catch it.
    const out = compose('Growers reported a sharp rise in seasonal fruit costs across the region last quarter [1].');
    assert.equal(out.brief, null);
    assert.equal(out.rejection, BRIEF_REJECTIONS.LEAD_GROUNDING);
  });

  it('names a lead left with no sentences after out-of-range citations are stripped', () => {
    const out = compose('[999] [998] [997] [996] [995] [994] [993] [992]');
    assert.equal(out.brief, null);
    assert.equal(out.rejection, BRIEF_REJECTIONS.LEAD_EMPTY);
  });

  it('names a parse failure', () => {
    const out = composeSynthesizedBriefResult('not parseable at all', topStories, { validatorMode: 'enforce' });
    assert.equal(out.brief, null);
    assert.equal(out.rejection, BRIEF_REJECTIONS.PARSE);
  });

  it('names a corpus with no corroborated cluster to lead with', () => {
    const singleSource = [{ primaryTitle: 'A lone report', primarySource: 'Reuters', sources: ['Reuters'] }];
    const out = composeSynthesizedBriefResult('{}', singleSource, { validatorMode: 'enforce' });
    assert.equal(out.brief, null);
    assert.equal(out.rejection, BRIEF_REJECTIONS.MISSING_CLUSTER);
  });

  it('names an empty story list', () => {
    const out = composeSynthesizedBriefResult('{}', [], { validatorMode: 'enforce' });
    assert.equal(out.brief, null);
    assert.equal(out.rejection, BRIEF_REJECTIONS.NO_TOP_STORIES);
  });

  it('keeps every reason distinct — a shared label would erase the diagnostic', () => {
    const reasons = Object.values(BRIEF_REJECTIONS);
    assert.equal(new Set(reasons).size, reasons.length);
  });

  it('reports reasons that carry no prompt, model output, or offending text', () => {
    // These land in seed-meta, health and Railway logs, where the payload may
    // be sensitive intelligence. Bounded literals only.
    for (const reason of Object.values(BRIEF_REJECTIONS)) {
      assert.match(reason, /^[a-z-]{1,40}$/, `${reason} must stay a bounded literal`);
    }
  });

  it('leaves composeSynthesizedBrief returning the brief itself', () => {
    // The wrapper's `null | brief` shape must not change even though the seeder
    // itself has moved to composeSynthesizedBriefResult; the test corpus above
    // is its remaining consumer and pins the composer's decisions through it.
    const raw = JSON.stringify({ lead: 'Prices rose sharply in Chile last quarter [1].', lines });
    const brief = composeSynthesizedBrief(raw, topStories, { validatorMode: 'enforce' });
    assert.ok(brief);
    assert.equal(brief.lead, compose('Prices rose sharply in Chile last quarter [1].').brief.lead);
    assert.equal(composeSynthesizedBrief('nope', topStories, { validatorMode: 'enforce' }), null);
  });
});

describe('coordinating and is grammar in the composer (AE2, AE4, AE7)', () => {
  const story = (primaryTitle, extras = {}) => ({
    primaryTitle,
    primarySource: extras.primarySource || 'Reuters',
    primaryLink: extras.primaryLink || 'http://example',
    sources: extras.sources || ['Reuters', 'AP News'],
    memberTitles: extras.memberTitles || [primaryTitle],
  });

  const compose = (lead, topStories, lineEntries) =>
    composeSynthesizedBriefResult(
      JSON.stringify({ lead, lines: lineEntries }),
      topStories,
      { validatorMode: 'enforce', briefCluster: topStories[0] },
    );

  it('AE2 lead: Israel and Hezbollah against a headline that names both accepts', () => {
    const topStories = [
      story('Israel vows to go after Hezbollah'),
    ];
    const lead = 'Israel and Hezbollah clashed overnight along the northern border [1]';
    const out = compose(lead, topStories, [
      { n: 1, text: 'Israel vows to go after Hezbollah in the north' },
    ]);
    assert.equal(out.rejection, null);
    assert.ok(out.brief);
    assert.match(out.brief.lead, /Israel and Hezbollah/);
  });

  it('AE2 story line: coordinated names stay on the line and are not replaced by the headline', () => {
    const headline = 'Israel vows to go after Hezbollah';
    const lineText = 'Israel and Hezbollah clashed overnight along the northern border';
    const topStories = [story(headline)];
    const lead = 'Israel and Hezbollah clashed overnight along the northern border [1]';
    const out = compose(lead, topStories, [{ n: 1, text: lineText }]);
    assert.equal(out.rejection, null);
    assert.equal(out.brief.lines[0].text, `${lineText} [1]`);
  });

  it('AE4: Hezbollah against a story that does not name it still rejects', () => {
    const topStories = [
      story('Iran and Israel exchanged fire near the Strait of Hormuz and Lebanon'),
    ];
    const lead = 'Israel targeted Hezbollah positions across southern Lebanon [1]';
    const out = compose(lead, topStories, [
      { n: 1, text: 'Iran and Israel exchanged fire near Hormuz' },
    ]);
    assert.equal(out.brief, null);
    assert.equal(out.rejection, BRIEF_REJECTIONS.LEAD_PROPER_NOUN);
  });

  it('AE7: Ukraine and Russia [1] rejects when only Russia is in story 1', () => {
    const topStories = [
      story('Russia reports overnight aerial attacks on border regions'),
      story('Chile apple prices rose last quarter, growers say', { sources: ['Reuters'] }),
      story('Ukraine launches one of its largest aerial attacks of the war', { sources: ['AP News'] }),
    ];
    const lines = [
      { n: 1, text: 'Russia reports overnight aerial attacks on border regions' },
      { n: 3, text: 'Ukraine launches one of its largest aerial attacks of the war' },
    ];
    const out = compose(
      'Ukraine and Russia traded overnight aerial attacks across the border [1]',
      topStories,
      lines,
    );
    assert.equal(out.brief, null);
    assert.equal(out.rejection, BRIEF_REJECTIONS.LEAD_PROPER_NOUN);
  });

  it('AE7: Ukraine and Russia [1][3] accepts from the citation union', () => {
    const topStories = [
      story('Russia reports overnight aerial attacks on border regions'),
      story('Chile apple prices rose last quarter, growers say', { sources: ['Reuters'] }),
      story('Ukraine launches one of its largest aerial attacks of the war', { sources: ['AP News'] }),
    ];
    const lines = [
      { n: 1, text: 'Russia reports overnight aerial attacks on border regions' },
      { n: 3, text: 'Ukraine launches one of its largest aerial attacks of the war' },
    ];
    const out = compose(
      'Ukraine and Russia traded overnight aerial attacks across the border [1][3]',
      topStories,
      lines,
    );
    assert.equal(out.rejection, null);
    assert.ok(out.brief);
  });

  it('AE7: citation between the names still accepts', () => {
    const topStories = [
      story('Russia reports overnight aerial attacks on border regions'),
      story('Chile apple prices rose last quarter, growers say', { sources: ['Reuters'] }),
      story('Ukraine launches one of its largest aerial attacks of the war', { sources: ['AP News'] }),
    ];
    const lines = [
      { n: 1, text: 'Russia reports overnight aerial attacks on border regions' },
      { n: 3, text: 'Ukraine launches one of its largest aerial attacks of the war' },
    ];
    const out = compose(
      'fatalities in both Russia [1] and Ukraine [3]',
      topStories,
      lines,
    );
    assert.equal(out.rejection, null);
    assert.ok(out.brief);
  });

  it('rejects a repeated-name entity grounded by only one cited surname', () => {
    const topStories = [
      story('Prime Minister Boris Johnson halted talks'),
    ];
    const out = compose(
      'Johnson and Johnson halted vaccine production [1]',
      topStories,
      [{ n: 1, text: 'Prime Minister Boris Johnson halted talks' }],
    );
    assert.equal(out.brief, null);
    assert.equal(out.rejection, BRIEF_REJECTIONS.LEAD_PROPER_NOUN);
  });
});
