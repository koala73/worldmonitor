// Unit tests for the opinion/analysis classifier (F3, Phase 3).
//
// classifyOpinion is the single shared classifier — imported by the
// ingest path (list-feed-digest.ts, stamps `isOpinion` on the
// story:track:v1 row) and the read path (buildDigest, re-classifies
// residue). The brief is event-driven intelligence; an op-ed column
// is not an event. See docs/plans/2026-05-14-001-…-plan.md.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyOpinion } from '../server/_shared/opinion-classifier.js';

describe('classifyOpinion — STRONG signals (sufficient alone)', () => {
  it('URL path /opinion/ → opinion', () => {
    assert.equal(
      classifyOpinion({ title: 'A perfectly normal hard-news headline', link: 'https://example.com/opinion/2026/05/14/foo' }),
      true,
    );
  });

  it('URL path variants /views/ /commentary/ /editorial/ /op-ed/ /columnists/ → opinion', () => {
    for (const seg of ['/views/', '/commentary/', '/editorial/', '/op-ed/', '/columnists/', '/columns/']) {
      assert.equal(
        classifyOpinion({ title: 'Normal headline', link: `https://example.com${seg}article` }),
        true,
        `${seg} should classify as opinion`,
      );
    }
  });

  it('explicit "Opinion:" / "Analysis:" / "Commentary:" / "Op-Ed:" headline prefix → opinion', () => {
    for (const prefix of ['Opinion:', 'Analysis:', 'Commentary:', 'Op-Ed:', 'Op-ed:', 'Editorial:', 'Viewpoint:']) {
      assert.equal(
        classifyOpinion({ title: `${prefix} The case for sanctions`, link: 'https://example.com/world/article' }),
        true,
        `"${prefix}" prefix should classify as opinion`,
      );
    }
  });
});

describe('classifyOpinion — CORROBORATING signals (need a STRONG signal OR two CORROBORATING)', () => {
  it('REGRESSION (May 14): the Le Monde Gilles Paris column → opinion', () => {
    // The verbatim May 14 story: a fully quote-wrapped headline (1
    // corroborating) + "posits that" framing in the description (1
    // corroborating) = 2 → opinion. This shipped as story #1, tagged
    // Critical, ahead of a nuclear ICBM test.
    assert.equal(
      classifyOpinion({
        title: "'Russia's invasion of Ukraine could have warned Trump from the pitfalls he now faces in Iran'",
        link: 'https://www.lemonde.fr/en/international/article/2026/05/14/foo_123_4.html',
        description: "Le Monde's Gilles Paris posits that Trump's miscalculation regarding Iran mirrors Putin's Ukraine invasion, offering a cautionary tale for Xi Jinping's Taiwan ambitions.",
      }),
      true,
    );
  });

  it('two corroborating (quote-wrapped headline + /analysis/ URL) → opinion', () => {
    assert.equal(
      classifyOpinion({
        title: "'The west has misjudged this moment'",
        link: 'https://example.com/analysis/2026/foo',
        description: 'A straightforward report with no framing words.',
      }),
      true,
    );
  });

  it('ONE corroborating signal alone → NOT opinion (false-negative is safer than false-positive)', () => {
    // /analysis/ URL alone — many outlets file hard-news explainers there.
    assert.equal(
      classifyOpinion({ title: 'Sudan airstrike kills 100 at market', link: 'https://example.com/analysis/sudan-airstrike' }),
      false,
    );
    // A quote-wrapped headline alone — could be a quoted-statement lead.
    assert.equal(
      classifyOpinion({ title: "'We will respond decisively'", link: 'https://example.com/world/iran-statement', description: 'The foreign ministry issued a statement.' }),
      false,
    );
    // Description framing alone.
    assert.equal(
      classifyOpinion({ title: 'Minister addresses parliament', link: 'https://example.com/world/x', description: 'The minister argues that the budget must pass.' }),
      false,
    );
  });
});

describe('classifyOpinion — does NOT false-positive on hard news', () => {
  it('REGRESSION (A3): a hard-news story under /analysis/ with no other signal is NOT dropped', () => {
    assert.equal(
      classifyOpinion({
        title: 'What we know about the Strait of Hormuz closure',
        link: 'https://example.com/analysis/hormuz-closure-explainer',
        description: 'Shipping data shows a 40% drop in transits since Tuesday.',
      }),
      false,
    );
  });

  it('REGRESSION (A3): a hard-news headline that QUOTES a phrase (not whole-wrapped) is NOT dropped', () => {
    // "'on life support'" is a quoted phrase inside the headline — the
    // headline as a whole is not quote-wrapped.
    assert.equal(
      classifyOpinion({
        title: "Trump says Iran ceasefire is 'on life support' after he rejects Tehran's response",
        link: 'https://example.com/world/trump-iran-ceasefire',
        description: 'Former President Trump rejected the latest proposal.',
      }),
      false,
    );
  });

  it('a bare-noun headline starting with "Opinion" / "Analysis" (no colon) is NOT caught', () => {
    assert.equal(
      classifyOpinion({ title: 'Opinion polls tighten ahead of the election', link: 'https://example.com/world/polls' }),
      false,
    );
    assert.equal(
      classifyOpinion({ title: 'Analysis firm downgrades the bank', link: 'https://example.com/business/downgrade' }),
      false,
    );
  });

  it('REGRESSION (PR #3690 review): a hard-news slug containing "opinion-" is NOT a strong URL match', () => {
    // STRONG_URL_SEGMENTS entries are slash-delimited path segments,
    // not substrings. `/world/opinion-polls-tighten-election` is a
    // hard-news ARTICLE SLUG that merely starts with "opinion-" — it
    // must NOT classify as opinion. An unbounded `/opinion-` prefix
    // was removed from STRONG_URL_SEGMENTS for exactly this.
    assert.equal(
      classifyOpinion({
        title: 'Opinion polls tighten ahead of the election',
        link: 'https://example.com/world/opinion-polls-tighten-election',
        description: 'A new survey shows the race narrowing in three swing states.',
      }),
      false,
    );
    // A genuine /opinion/ SECTION (slash-delimited) is still caught.
    assert.equal(
      classifyOpinion({
        title: 'The election is closer than it looks',
        link: 'https://example.com/opinion/election-closer-than-it-looks',
      }),
      true,
    );
  });

  it('a plain hard-news event → NOT opinion', () => {
    assert.equal(
      classifyOpinion({
        title: 'Putin tests nuclear-capable Sarmat missile',
        link: 'https://example.com/world/russia-sarmat-test',
        description: 'Russia test-fired the intercontinental ballistic missile from Plesetsk.',
      }),
      false,
    );
  });
});

describe('classifyOpinion — input safety', () => {
  it('handles missing / non-string fields without throwing', () => {
    assert.equal(classifyOpinion({}), false);
    assert.equal(classifyOpinion({ title: 42, link: null, description: undefined }), false);
    // @ts-expect-error testing unexpected input
    assert.doesNotThrow(() => classifyOpinion(null));
    // @ts-expect-error testing unexpected input
    assert.equal(classifyOpinion(undefined), false);
  });
});
