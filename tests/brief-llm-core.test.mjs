/**
 * Pinned regression tests for shared/brief-llm-core.js.
 *
 * The module replaces the pre-extract sync `hashBriefStory` (which used
 * `node:crypto.createHash`) with a Web Crypto `crypto.subtle.digest`
 * implementation. A drift in either the hash algorithm, the joining
 * delimiter ('||'), or the field ordering would silently invalidate
 * every cached `brief:llm:whymatters:*` entry at deploy time.
 *
 * These fixtures were captured from the pre-extract implementation and
 * pinned here so any future refactor must ship a cache-version bump
 * alongside.
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  WHY_MATTERS_SYSTEM,
  briefDateLine,
  buildWhyMattersUserPrompt,
  hashBriefStory,
  parseWhyMatters,
} from '../shared/brief-llm-core.js';

// Mirror impl (sync `node:crypto`) — kept inline so a drift between
// the Web Crypto implementation and this sentinel fails the parity
// test here first. Must include `description` to match v5 semantics.
function legacyHashBriefStory(story) {
  const material = [
    story.headline ?? '',
    story.source ?? '',
    story.threatLevel ?? '',
    story.category ?? '',
    story.country ?? '',
    story.description ?? '',
  ].join('||');
  return createHash('sha256').update(material).digest('hex').slice(0, 16);
}

const FIXTURE = {
  headline: 'Iran closes Strait of Hormuz',
  source: 'Reuters',
  threatLevel: 'critical',
  category: 'Geopolitical Risk',
  country: 'IR',
};

describe('hashBriefStory — Web Crypto parity with legacy node:crypto', () => {
  it('returns the exact hash the pre-extract implementation emitted', async () => {
    const expected = legacyHashBriefStory(FIXTURE);
    const actual = await hashBriefStory(FIXTURE);
    assert.equal(actual, expected);
  });

  it('is 16 hex chars, case-insensitive match', async () => {
    const h = await hashBriefStory(FIXTURE);
    assert.equal(h.length, 16);
    assert.match(h, /^[0-9a-f]{16}$/);
  });

  it('is stable across multiple invocations', async () => {
    const a = await hashBriefStory(FIXTURE);
    const b = await hashBriefStory(FIXTURE);
    const c = await hashBriefStory(FIXTURE);
    assert.equal(a, b);
    assert.equal(b, c);
  });

  it('differs when any hash-material field differs', async () => {
    const baseline = await hashBriefStory(FIXTURE);
    for (const field of ['headline', 'source', 'threatLevel', 'category', 'country']) {
      const mutated = { ...FIXTURE, [field]: `${FIXTURE[field]}!` };
      const h = await hashBriefStory(mutated);
      assert.notEqual(h, baseline, `${field} must be part of the cache identity`);
    }
  });

  it('description is part of cache identity (v5 regression guard)', async () => {
    // Pinned from PR #3269 review P1: adding `description` to the
    // analyst prompt without adding it to the hash caused same-story-
    // diff-description to collide on one cache entry, so callers got
    // prose grounded in a PREVIOUS caller's description.
    const withDescA = {
      ...FIXTURE,
      description: 'Tehran publicly reopened commercial shipping.',
    };
    const withDescB = {
      ...FIXTURE,
      description: 'Iran formally blockaded outbound tankers.',
    };
    const noDesc = { ...FIXTURE };

    const hashA = await hashBriefStory(withDescA);
    const hashB = await hashBriefStory(withDescB);
    const hashNone = await hashBriefStory(noDesc);

    assert.notEqual(hashA, hashB, 'different descriptions must produce different hashes');
    assert.notEqual(hashA, hashNone, 'description present vs absent must differ');
    assert.notEqual(hashB, hashNone);
  });

  it('treats missing fields as empty strings (backcompat)', async () => {
    const partial = { headline: FIXTURE.headline };
    const expected = legacyHashBriefStory(partial);
    const actual = await hashBriefStory(partial);
    assert.equal(actual, expected);
  });
});

describe('WHY_MATTERS_SYSTEM — pinned editorial voice', () => {
  it('is a non-empty string with the one-sentence contract wording', () => {
    assert.equal(typeof WHY_MATTERS_SYSTEM, 'string');
    assert.ok(WHY_MATTERS_SYSTEM.length > 100);
    assert.match(WHY_MATTERS_SYSTEM, /ONE concise sentence \(18–30 words\)/);
    assert.match(WHY_MATTERS_SYSTEM, /One sentence only\.$/);
  });
});

describe('briefDateLine — date-grounding instruction (plan F6)', () => {
  it('uses the injected ISO date verbatim', () => {
    const line = briefDateLine('2026-05-14');
    assert.match(line, /^Today is 2026-05-14\./);
    assert.match(line, /Do not state any year or date that contradicts/);
  });

  it('falls back to the current UTC date for missing / malformed input', () => {
    for (const bad of [undefined, null, '', 'not-a-date', '2026/05/14', 14]) {
      // `before`/`after` bracket each call so a UTC-midnight rollover
      // mid-test still matches one of the two valid dates — the date is
      // read inside briefDateLine, not captured once up front.
      const before = new Date().toISOString().slice(0, 10);
      const line = briefDateLine(bad);
      const after = new Date().toISOString().slice(0, 10);
      const m = line.match(/^Today is (\d{4}-\d{2}-\d{2})\./);
      assert.ok(m, `malformed input ${JSON.stringify(bad)} must still produce a dated line`);
      assert.ok(
        m[1] === before || m[1] === after,
        `malformed input ${JSON.stringify(bad)} must fall back to the current UTC date (got ${m[1]}, expected ${before} or ${after})`,
      );
    }
  });
});

describe('buildWhyMattersUserPrompt — shape', () => {
  it('emits the exact 5-line format pinned by the cache-identity contract', () => {
    // todayIso is injected so the system-prompt assertion is deterministic;
    // the USER prompt (the cache-identity contract) is unchanged by F6.
    const { system, user } = buildWhyMattersUserPrompt(FIXTURE, '2026-05-14');
    assert.equal(system, `${WHY_MATTERS_SYSTEM}\n${briefDateLine('2026-05-14')}`);
    assert.equal(
      user,
      [
        'Headline: Iran closes Strait of Hormuz',
        'Source: Reuters',
        'Severity: critical',
        'Category: Geopolitical Risk',
        'Country: IR',
        '',
        'One editorial sentence on why this matters:',
      ].join('\n'),
    );
  });
});

describe('parseWhyMatters — pure sentence validator', () => {
  it('rejects non-strings, empty, whitespace-only', () => {
    assert.equal(parseWhyMatters(null), null);
    assert.equal(parseWhyMatters(undefined), null);
    assert.equal(parseWhyMatters(42), null);
    assert.equal(parseWhyMatters(''), null);
    assert.equal(parseWhyMatters('   '), null);
  });

  it('rejects too-short (<30) and too-long (>400)', () => {
    assert.equal(parseWhyMatters('Too brief.'), null);
    assert.equal(parseWhyMatters('x'.repeat(401)), null);
  });

  it('strips smart-quotes and takes the first sentence', () => {
    const input = '"Closure would spike oil markets and force a naval response." Secondary clause.';
    const out = parseWhyMatters(input);
    assert.equal(out, 'Closure would spike oil markets and force a naval response.');
  });

  it('rejects the stub echo', () => {
    const stub = 'Story flagged by your sensitivity settings. Open for context.';
    assert.equal(parseWhyMatters(stub), null);
  });

  it('preserves a valid one-sentence output verbatim', () => {
    const s = 'Closure of the Strait of Hormuz would spike global oil prices and force a US naval response.';
    assert.equal(parseWhyMatters(s), s);
  });
});

describe('parseWhyMattersV2 — multi-sentence, analyst-path only', () => {
  it('lazy-loads', async () => {
    const mod = await import('../shared/brief-llm-core.js');
    assert.equal(typeof mod.parseWhyMattersV2, 'function');
  });

  it('accepts 2–3 sentences totalling 100–500 chars', async () => {
    const { parseWhyMattersV2 } = await import('../shared/brief-llm-core.js');
    const good =
      "Iran's closure of the Strait of Hormuz on April 21 halts roughly 20% of global seaborne oil. " +
      'The disruption forces an immediate repricing of sovereign risk across Gulf energy exporters. ' +
      'Watch IMF commentary in the next 48 hours for cascading guidance.';
    assert.ok(good.length >= 100 && good.length <= 500);
    assert.equal(parseWhyMattersV2(good), good);
  });

  it('rejects <100 chars (too terse for the analyst contract)', async () => {
    const { parseWhyMattersV2 } = await import('../shared/brief-llm-core.js');
    assert.equal(parseWhyMattersV2('Short.'), null);
    assert.equal(parseWhyMattersV2('x'.repeat(99)), null);
  });

  it('rejects >500 chars (runaway generation)', async () => {
    const { parseWhyMattersV2 } = await import('../shared/brief-llm-core.js');
    assert.equal(parseWhyMattersV2('a'.repeat(501)), null);
  });

  it('rejects preamble the system prompt banned', async () => {
    const { parseWhyMattersV2 } = await import('../shared/brief-llm-core.js');
    const cases = [
      'This matters because global energy markets depend on the Strait of Hormuz remaining open for transit and this is therefore a critical development.',
      'The importance of this development cannot be overstated given the potential for cascading economic impacts across multiple regions and industries.',
      'It is important to note that the ongoing situation in the Strait of Hormuz has implications that extend far beyond simple maritime concerns.',
      'Importantly, the developments in the Strait of Hormuz today signal a shift in regional dynamics that could reshape global energy markets for months.',
      'In summary, the current situation presents significant risks to global stability and requires careful monitoring of diplomatic and military channels.',
      'To summarize the situation, the Strait of Hormuz developments represent a critical juncture in regional power dynamics with broad implications.',
    ];
    for (const c of cases) {
      assert.ok(c.length >= 100 && c.length <= 500);
      assert.equal(parseWhyMattersV2(c), null, `should reject preamble: ${c.slice(0, 40)}…`);
    }
  });

  it('rejects markdown / leaked section labels the prompt told it to omit', async () => {
    const { parseWhyMattersV2 } = await import('../shared/brief-llm-core.js');
    const cases = [
      '# Situation\nIran closed the strait on April 21, halting 20% of seaborne oil. Analysis: sovereign risk repricing follows immediately for Gulf exporters.',
      '- Bullet one that should not open the response at all given the plain-prose rule in the system message.\n- Bullet two of the banned response.',
      '* Leading bullet with asterisk that should also trip the markdown rejection because analyst prose should be plain paragraphs across 2–3 sentences.',
      '1. Numbered point opening the response is equally banned by the system prompt requiring plain prose across two to three sentences with grounded references.',
      'SITUATION: Iran closed Hormuz today. ANALYSIS: cascading sovereign repricing follows. WATCH: IMF Gulf commentary in 48h. This mirrors the 2019 pattern.',
      'Analysis — the Strait closure triggers a cascading sovereign risk repricing across Gulf exporters with immediate effect on global markets and shipping lanes.',
    ];
    for (const c of cases) {
      assert.equal(parseWhyMattersV2(c), null, `should reject leaked label: ${c.slice(0, 40)}…`);
    }
  });

  it('still rejects the stub echo', async () => {
    const { parseWhyMattersV2 } = await import('../shared/brief-llm-core.js');
    const stub =
      'Story flagged by your sensitivity settings. Open for context. This stub is long enough to clear the 100-char floor but must still be rejected as non-enrichment output.';
    assert.equal(parseWhyMattersV2(stub), null);
  });

  it('strips surrounding smart-quotes before validation', async () => {
    const { parseWhyMattersV2 } = await import('../shared/brief-llm-core.js');
    const raw =
      '\u201CIran closed the Strait on April 21, halting 20% of seaborne oil. The disruption forces an immediate repricing of sovereign risk across Gulf exporters.\u201D';
    const out = parseWhyMattersV2(raw);
    assert.ok(out && !out.startsWith('\u201C'));
    assert.ok(out && !out.endsWith('\u201D'));
  });
});

describe('validateNoHallucinatedProperNouns — May 19 regression + class', () => {
  let validateNoHallucinatedProperNouns;
  let extractProperNounSequences;
  before(async () => {
    ({ validateNoHallucinatedProperNouns, extractProperNounSequences } = await import('../shared/brief-llm-core.js'));
  });

  // Captured fixture: the actual 2026-05-19 LLM hallucination.
  const MAY_19_LEBANON_HEADLINE =
    "Lebanese president vows to 'do the impossible' to end war with Israel as strikes continue despite ceasefire";
  const MAY_19_LEBANON_CAPTURED_SUMMARY =
    "Lebanese President Michel Aoun pledged to pursue all avenues to end the ongoing conflict with Israel, even as Israeli strikes continued despite a declared ceasefire.";

  it('REGRESSION (captured): "Michel Aoun" not in headline → flagged', () => {
    const r = validateNoHallucinatedProperNouns(MAY_19_LEBANON_CAPTURED_SUMMARY, MAY_19_LEBANON_HEADLINE);
    assert.equal(r.ok, false);
    assert.ok(r.hallucinated.includes('michel') || r.hallucinated.includes('aoun'),
      `expected hallucinated to include 'michel' or 'aoun'; got ${JSON.stringify(r.hallucinated)}`);
  });

  it('CLASS (synthesized variant 1): "President Michel Aoun reportedly stated..." → flagged', () => {
    const summary = "President Michel Aoun reportedly stated he would pursue all paths to end the war.";
    const r = validateNoHallucinatedProperNouns(summary, MAY_19_LEBANON_HEADLINE);
    assert.equal(r.ok, false, 'LLM non-determinism must not let a different phrasing slip through');
  });

  it('CLASS (synthesized variant 2): "Lebanese leader Aoun..." → flagged', () => {
    const summary = "Lebanese leader Aoun, who reportedly pledged action, faces ongoing strikes.";
    const r = validateNoHallucinatedProperNouns(summary, MAY_19_LEBANON_HEADLINE);
    assert.equal(r.ok, false);
  });

  it('CLASS (synthesized variant 3): "Aoun, the Lebanese president, said..." → flagged', () => {
    const summary = "Aoun, the Lebanese president, said the war with Israel must end.";
    const r = validateNoHallucinatedProperNouns(summary, MAY_19_LEBANON_HEADLINE);
    assert.equal(r.ok, false);
  });

  it('happy path: every summary proper noun grounded in headline', () => {
    // Note: the original draft of this test summary said "the planned US
    // strike against Iran" — "US" is NOT in the headline, so the
    // validator correctly flags that. Rewrite the summary to introduce
    // only proper nouns the headline contains. This is exactly the
    // contract: an LLM rewrite that ADDS a new entity ("US") gets
    // flagged; one that paraphrases without introducing entities passes.
    const headline = "Trump says Iran attack postponed at request of Gulf allies";
    const summary = "Trump revealed that the planned attack against Iran was postponed at the request of Gulf allies.";
    const r = validateNoHallucinatedProperNouns(summary, headline);
    assert.equal(r.ok, true, `unexpectedly flagged: ${JSON.stringify(r)}`);
  });

  it('hallucination by addition: summary adds entity not in headline → flagged', () => {
    // The "US" case from the failed draft test above — codified as its
    // own regression. A real test of the hallucination class.
    const headline = "Trump says Iran attack postponed at request of Gulf allies";
    const summary = "Trump revealed that the planned US strike against Iran was postponed.";
    const r = validateNoHallucinatedProperNouns(summary, headline);
    assert.equal(r.ok, false, 'summary introduced "US" not in headline — must flag');
  });

  it('title-prefix stop list: "former President Trump" passes when headline has "Trump"', () => {
    const headline = "Trump signs trade bill into law";
    const summary = "Former President Trump approved the legislation today.";
    const r = validateNoHallucinatedProperNouns(summary, headline);
    assert.equal(r.ok, true);
  });

  it('demonym rule: "Israeli" headline ↔ "Israel" summary equivalent', () => {
    const headline = "Israeli strikes hit Beirut suburbs";
    const summary = "Israel struck Beirut's southern suburbs in pre-dawn raids.";
    const r = validateNoHallucinatedProperNouns(summary, headline);
    assert.equal(r.ok, true);
  });

  it('demonym rule: "Iranian" headline ↔ "Iran" summary equivalent', () => {
    const headline = "Iranian officials confirm uranium enrichment progress";
    const summary = "Iran confirmed reaching weapons-grade enrichment thresholds today.";
    const r = validateNoHallucinatedProperNouns(summary, headline);
    assert.equal(r.ok, true);
  });

  it('acronym↔expansion: WHO headline ↔ "World Health Organization" summary', () => {
    const headline = "WHO declares Ebola emergency in DR Congo";
    const summary = "World Health Organization declared the Ebola outbreak in Democratic Republic of Congo a public health emergency.";
    const r = validateNoHallucinatedProperNouns(summary, headline);
    assert.equal(r.ok, true);
  });

  it('acronym↔expansion: reverse direction (expansion headline ↔ acronym summary)', () => {
    const headline = "United States imposes new sanctions on Cuba";
    const summary = "The US announced new sanctions targeting Cuban leadership today.";
    const r = validateNoHallucinatedProperNouns(summary, headline);
    assert.equal(r.ok, true);
  });

  it('multi-word with joiner: "Democratic Republic of Congo" → preserved as one sequence', () => {
    const seqs = extractProperNounSequences("The Democratic Republic of Congo declared an emergency.");
    // Should be one sequence containing all 4 tokens, not 2 separate sequences.
    const longest = seqs.reduce((max, s) => (s.length > max.length ? s : max), []);
    assert.ok(longest.includes('democratic') && longest.includes('republic') && longest.includes('congo'),
      `expected DRC tokens in one sequence; got ${JSON.stringify(seqs)}`);
  });

  it('sentence-start "The" not registered as a proper noun', () => {
    const seqs = extractProperNounSequences("The UN said the EU agreed.");
    // 'The' should not appear as a sequence; UN and EU should.
    const flat = seqs.flat();
    assert.ok(!flat.includes('the'));
    assert.ok(flat.includes('un'));
    assert.ok(flat.includes('eu'));
  });

  it('no proper nouns either side → ok', () => {
    const r = validateNoHallucinatedProperNouns("the situation continues to evolve", "no proper nouns here");
    assert.equal(r.ok, true);
  });

  it('out-of-scope: headline already contains a wrong name → validator does NOT fact-check', () => {
    // Source-level errors are explicitly out of scope (see plan Scope Boundaries).
    // The validator catches LLM invention only — if the headline ships the
    // wrong name from a wire-service typo, the summary using that name OKs.
    const headline = "Lebanese President Michel Aoun vows to end war"; // typo'd headline
    const summary = "Michel Aoun pledged action today.";
    const r = validateNoHallucinatedProperNouns(summary, headline);
    assert.equal(r.ok, true);
  });

  it('headline has "Trump", summary adds "Mar-a-Lago" not in headline → flagged', () => {
    const headline = "FBI raids Trump residence in Florida";
    const summary = "FBI agents conducted a raid on Mar-a-Lago today.";
    const r = validateNoHallucinatedProperNouns(summary, headline);
    assert.equal(r.ok, false);
  });

  it('REGRESSION (PR #3836 review): dotted-acronym summary against bare headline → ok', () => {
    // "U.S." tokenized as ['U', 'S'] — single-char tokens fail the
    // 2–6-char acronym rule. Preprocessing pass `normalizeDottedAcronyms`
    // collapses `U.S.` to `US` before tokenization so the existing
    // acronym↔expansion normalization can do its job.
    const headline = "US announces new sanctions on Iran";
    const summary = "The U.S. announced new sanctions against Iran today.";
    const r = validateNoHallucinatedProperNouns(summary, headline);
    assert.equal(r.ok, true, `dotted-acronym summary should match bare headline; got ${JSON.stringify(r)}`);
  });

  it('REGRESSION (PR #3836 review): dotted-acronym summary against expanded headline → ok', () => {
    const headline = "United States announces new sanctions on Iran";
    const summary = "The U.S. announced new sanctions against Iran today.";
    const r = validateNoHallucinatedProperNouns(summary, headline);
    assert.equal(r.ok, true, `"U.S." summary should match "United States" headline; got ${JSON.stringify(r)}`);
  });

  it('REGRESSION (PR #3836 review): three-letter dotted acronym U.S.A.', () => {
    const headline = "United States delegation arrives";
    const summary = "The U.S.A. delegation arrived today.";
    const r = validateNoHallucinatedProperNouns(summary, headline);
    assert.equal(r.ok, true);
  });

  it('dotted-acronym extractor: "U.S." extracts as ["us"] sequence', () => {
    const seqs = extractProperNounSequences("The U.S. announced sanctions.");
    const flat = seqs.flat();
    assert.ok(flat.includes('us'), `expected 'us' in extracted sequences; got ${JSON.stringify(seqs)}`);
  });

  it('dotted-acronym extractor does not false-positive on lowercase "i.e."', () => {
    // Lowercase dotted patterns (i.e., e.g., p.m., a.m.) must NOT collapse.
    const seqs = extractProperNounSequences("The result was, i.e., a postponement.");
    const flat = seqs.flat();
    // No proper noun expected from "i.e."; should not become "ie" and register.
    assert.ok(!flat.includes('ie'));
  });

  it('dotted-acronym single sentence-final initial does not over-collapse', () => {
    // "I had a meeting with J." — single capital-then-dot at sentence end
    // should NOT collapse (needs at least 2 letter-dot pairs to trigger).
    const seqs = extractProperNounSequences("I had a meeting with J.");
    const flat = seqs.flat();
    // 'j' alone shouldn't appear (single-char, not all-caps acronym ≥ 2).
    assert.ok(!flat.includes('j'));
  });

  it('defensive: malformed inputs return ok (do not throw)', () => {
    assert.doesNotThrow(() => validateNoHallucinatedProperNouns(undefined, "x"));
    assert.equal(validateNoHallucinatedProperNouns(undefined, "x").ok, true);
    assert.equal(validateNoHallucinatedProperNouns(null, "x").ok, true);
    assert.equal(validateNoHallucinatedProperNouns("", "x").ok, true);
    assert.equal(validateNoHallucinatedProperNouns("x", "").ok, true);
    assert.equal(validateNoHallucinatedProperNouns(42, "x").ok, true);
    assert.equal(validateNoHallucinatedProperNouns("<script>alert(1)</script>", "x").ok, true);
  });

  it('defensive: 10x-longer summaries do not crash extractor', () => {
    const headline = "Trump signs bill";
    const summary = "Trump ".repeat(2000) + "approved the legislation.";
    assert.doesNotThrow(() => validateNoHallucinatedProperNouns(summary, headline));
  });
});
