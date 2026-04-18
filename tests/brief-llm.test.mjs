// Phase 3b: unit tests for brief-llm.mjs.
//
// Covers:
//   - Pure build/parse helpers (no IO)
//   - Cached generate* functions with an in-memory cache stub
//   - Full enrichBriefEnvelopeWithLLM envelope pass-through
//
// Every LLM call is stubbed; there is no network. The cache is a plain
// Map and the deps object is fabricated per-test. Tests assert both
// the happy path (LLM output adopted) and every failure mode the
// production code tolerates (null LLM, parse error, cache throw).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildWhyMattersPrompt,
  parseWhyMatters,
  generateWhyMatters,
  buildDigestPrompt,
  parseDigestProse,
  validateDigestProseShape,
  generateDigestProse,
  enrichBriefEnvelopeWithLLM,
  buildStoryDescriptionPrompt,
  parseStoryDescription,
  generateStoryDescription,
} from '../scripts/lib/brief-llm.mjs';
import { assertBriefEnvelope } from '../server/_shared/brief-render.js';
import { composeBriefFromDigestStories } from '../scripts/lib/brief-compose.mjs';

// ── Fixtures ───────────────────────────────────────────────────────────────

function story(overrides = {}) {
  return {
    category: 'Diplomacy',
    country: 'IR',
    threatLevel: 'critical',
    headline: 'Iran threatens to close Strait of Hormuz if US blockade continues',
    description: 'Iran threatens to close Strait of Hormuz if US blockade continues',
    source: 'Guardian',
    sourceUrl: 'https://example.com/hormuz',
    whyMatters: 'Story flagged by your sensitivity settings. Open for context.',
    ...overrides,
  };
}

function envelope(overrides = {}) {
  return {
    version: 2,
    issuedAt: 1_745_000_000_000,
    data: {
      user: { name: 'Reader', tz: 'UTC' },
      issue: '18.04',
      date: '2026-04-18',
      dateLong: '18 April 2026',
      digest: {
        greeting: 'Good afternoon.',
        lead: 'Today\'s brief surfaces 2 threads flagged by your sensitivity settings. Open any page to read the full editorial.',
        numbers: { clusters: 277, multiSource: 22, surfaced: 2 },
        threads: [{ tag: 'Diplomacy', teaser: '2 threads on the desk today.' }],
        signals: [],
      },
      stories: [story(), story({ headline: 'UNICEF outraged by Gaza water truck killings', country: 'PS', source: 'UN News', sourceUrl: 'https://example.com/unicef' })],
    },
    ...overrides,
  };
}

function makeCache() {
  const store = new Map();
  return {
    store,
    async cacheGet(key) { return store.has(key) ? store.get(key) : null; },
    async cacheSet(key, value) { store.set(key, value); },
  };
}

function makeLLM(responder) {
  const calls = [];
  return {
    calls,
    async callLLM(system, user, opts) {
      calls.push({ system, user, opts });
      return typeof responder === 'function' ? responder(system, user, opts) : responder;
    },
  };
}

// ── buildWhyMattersPrompt ──────────────────────────────────────────────────

describe('buildWhyMattersPrompt', () => {
  it('includes all story fields in the user prompt', () => {
    const { system, user } = buildWhyMattersPrompt(story());
    assert.match(system, /WorldMonitor Brief/);
    assert.match(system, /One sentence only/);
    assert.match(user, /Headline: Iran threatens/);
    assert.match(user, /Source: Guardian/);
    assert.match(user, /Severity: critical/);
    assert.match(user, /Category: Diplomacy/);
    assert.match(user, /Country: IR/);
  });
});

// ── parseWhyMatters ────────────────────────────────────────────────────────

describe('parseWhyMatters', () => {
  it('returns null for non-string / empty input', () => {
    assert.equal(parseWhyMatters(null), null);
    assert.equal(parseWhyMatters(undefined), null);
    assert.equal(parseWhyMatters(''), null);
    assert.equal(parseWhyMatters('   '), null);
    assert.equal(parseWhyMatters(42), null);
  });

  it('returns null when the sentence is too short', () => {
    assert.equal(parseWhyMatters('Too brief.'), null);
  });

  it('returns null when the sentence is too long (likely reasoning)', () => {
    const long = 'A '.repeat(250) + '.';
    assert.equal(parseWhyMatters(long), null);
  });

  it('takes the first sentence only when the model returns multiple', () => {
    const text = 'Closure would spike oil markets and force a naval response. A second sentence here.';
    const out = parseWhyMatters(text);
    assert.equal(out, 'Closure would spike oil markets and force a naval response.');
  });

  it('strips surrounding quotes (smart and straight)', () => {
    const out = parseWhyMatters('\u201CClosure would spike oil markets and force a naval response.\u201D');
    assert.equal(out, 'Closure would spike oil markets and force a naval response.');
  });

  it('rejects the stub sentence itself so we never cache it', () => {
    assert.equal(parseWhyMatters('Story flagged by your sensitivity settings. Open for context.'), null);
  });

  it('accepts a single clean editorial sentence', () => {
    const out = parseWhyMatters('Closure of the Strait of Hormuz would spike global oil prices and force a US naval response.');
    assert.match(out, /^Closure of the Strait/);
    assert.ok(out.endsWith('.'));
  });
});

// ── generateWhyMatters ─────────────────────────────────────────────────────

describe('generateWhyMatters', () => {
  it('returns the cached value without calling the LLM when cache hits', async () => {
    const cache = makeCache();
    const llm = makeLLM(() => 'should not be called');
    cache.store.set(
      // Hash matches hashStory(story()) deterministically via same inputs.
      // We just pre-populate via the real key by calling once and peeking.
      // Easier: call generate first to populate, then flip responder.
      'placeholder', null,
    );

    // First call: real responder populates cache
    llm.calls.length = 0;
    const real = makeLLM('Closure would freeze a fifth of seaborne crude within days.');
    const first = await generateWhyMatters(story(), { ...cache, callLLM: real.callLLM });
    assert.ok(first);
    const cachedKey = [...cache.store.keys()].find((k) => k.startsWith('brief:llm:whymatters:v2:'));
    assert.ok(cachedKey, 'expected a whymatters cache entry under the v2 key');

    // Second call: responder throws — cache must prevent the call
    llm.calls.length = 0;
    const throwing = makeLLM(() => { throw new Error('should not be called'); });
    const second = await generateWhyMatters(story(), { ...cache, callLLM: throwing.callLLM });
    assert.equal(second, first);
    assert.equal(throwing.calls.length, 0);
  });

  it('returns null when the LLM returns null', async () => {
    const cache = makeCache();
    const llm = makeLLM(null);
    const out = await generateWhyMatters(story(), { ...cache, callLLM: llm.callLLM });
    assert.equal(out, null);
    assert.equal(cache.store.size, 0, 'nothing should be cached on a null LLM response');
  });

  it('returns null when the LLM throws', async () => {
    const cache = makeCache();
    const llm = makeLLM(() => { throw new Error('provider down'); });
    const out = await generateWhyMatters(story(), { ...cache, callLLM: llm.callLLM });
    assert.equal(out, null);
  });

  it('returns null when the LLM output fails parse validation', async () => {
    const cache = makeCache();
    const llm = makeLLM('too short');
    const out = await generateWhyMatters(story(), { ...cache, callLLM: llm.callLLM });
    assert.equal(out, null);
  });

  it('pins the provider chain to openrouter (skipProviders=ollama,groq)', async () => {
    const cache = makeCache();
    const llm = makeLLM('Closure of the Strait of Hormuz would spike oil prices globally.');
    await generateWhyMatters(story(), { ...cache, callLLM: llm.callLLM });
    assert.ok(llm.calls[0]);
    assert.deepEqual(llm.calls[0].opts.skipProviders, ['ollama', 'groq']);
  });

  it('caches shared story-hash across users (no per-user key)', async () => {
    const cache = makeCache();
    const llm = makeLLM('Closure of the Strait of Hormuz would spike oil prices globally.');
    await generateWhyMatters(story(), { ...cache, callLLM: llm.callLLM });
    // Different user requesting same story — cache should hit, LLM not called again
    const llm2 = makeLLM(() => { throw new Error('would not be called'); });
    const out = await generateWhyMatters(story(), { ...cache, callLLM: llm2.callLLM });
    assert.ok(out);
    assert.equal(llm2.calls.length, 0);
  });
});

// ── buildDigestPrompt ──────────────────────────────────────────────────────

describe('buildDigestPrompt', () => {
  it('includes reader sensitivity and ranked story lines', () => {
    const { system, user } = buildDigestPrompt([story(), story({ headline: 'Second', country: 'PS' })], 'critical');
    assert.match(system, /chief editor of WorldMonitor Brief/);
    assert.match(user, /Reader sensitivity level: critical/);
    assert.match(user, /01\. \[critical\] Iran threatens/);
    assert.match(user, /02\. \[critical\] Second/);
  });

  it('caps at 12 stories', () => {
    const many = Array.from({ length: 30 }, (_, i) => story({ headline: `H${i}` }));
    const { user } = buildDigestPrompt(many, 'all');
    const lines = user.split('\n').filter((l) => /^\d{2}\. /.test(l));
    assert.equal(lines.length, 12);
  });
});

// ── parseDigestProse ───────────────────────────────────────────────────────

describe('parseDigestProse', () => {
  const good = JSON.stringify({
    lead: 'The most impactful development today is Iran\'s repeated threats to close the Strait of Hormuz, a move with significant global economic repercussions.',
    threads: [
      { tag: 'Energy', teaser: 'Hormuz closure threats have reopened global oil volatility.' },
      { tag: 'Humanitarian', teaser: 'Gaza water truck killings drew UNICEF condemnation.' },
    ],
    signals: ['Watch for US naval redeployment in the Gulf.'],
  });

  it('parses a valid JSON payload', () => {
    const out = parseDigestProse(good);
    assert.ok(out);
    assert.match(out.lead, /Strait of Hormuz/);
    assert.equal(out.threads.length, 2);
    assert.equal(out.signals.length, 1);
  });

  it('strips ```json fences the model occasionally emits', () => {
    const fenced = '```json\n' + good + '\n```';
    const out = parseDigestProse(fenced);
    assert.ok(out);
    assert.match(out.lead, /Strait of Hormuz/);
  });

  it('returns null on malformed JSON', () => {
    assert.equal(parseDigestProse('not json {'), null);
    assert.equal(parseDigestProse('[]'), null);
    assert.equal(parseDigestProse(''), null);
    assert.equal(parseDigestProse(null), null);
  });

  it('returns null when lead is too short or missing', () => {
    assert.equal(parseDigestProse(JSON.stringify({ lead: 'too short', threads: [{ tag: 'A', teaser: 'b' }], signals: [] })), null);
    assert.equal(parseDigestProse(JSON.stringify({ threads: [{ tag: 'A', teaser: 'b' }] })), null);
  });

  it('returns null when threads are empty — renderer needs at least one', () => {
    const obj = JSON.parse(good);
    obj.threads = [];
    assert.equal(parseDigestProse(JSON.stringify(obj)), null);
  });

  it('caps threads at 6 and signals at 6', () => {
    const obj = JSON.parse(good);
    obj.threads = Array.from({ length: 12 }, (_, i) => ({ tag: `T${i}`, teaser: `teaser ${i}` }));
    obj.signals = Array.from({ length: 12 }, (_, i) => `signal ${i}`);
    const out = parseDigestProse(JSON.stringify(obj));
    assert.equal(out.threads.length, 6);
    assert.equal(out.signals.length, 6);
  });

  it('drops signals that exceed the prompt\'s 14-word cap (with small margin)', () => {
    // REGRESSION: previously the validator only capped by byte length
    // (< 220 chars), so a 30+ word signal paragraph could slip through
    // despite the prompt explicitly saying "<=14 words, forward-looking
    // imperative phrase". Validator now checks word count too.
    const obj = JSON.parse(good);
    obj.signals = [
      'Watch for US naval redeployment.',                        // 5 words — keep
      Array.from({ length: 22 }, (_, i) => `w${i}`).join(' '),    // 22 words — drop
      Array.from({ length: 30 }, (_, i) => `w${i}`).join(' '),    // 30 words — drop
    ];
    const out = parseDigestProse(JSON.stringify(obj));
    assert.equal(out.signals.length, 1);
    assert.match(out.signals[0], /naval redeployment/);
  });

  it('filters out malformed thread entries without rejecting the whole payload', () => {
    const obj = JSON.parse(good);
    obj.threads = [
      { tag: 'Energy', teaser: 'Hormuz closure threats.' },
      { tag: '' /* empty, drop */, teaser: 'should not appear' },
      { teaser: 'no tag, drop' },
      null,
      'not-an-object',
    ];
    const out = parseDigestProse(JSON.stringify(obj));
    assert.equal(out.threads.length, 1);
    assert.equal(out.threads[0].tag, 'Energy');
  });
});

// ── generateDigestProse ────────────────────────────────────────────────────

describe('generateDigestProse', () => {
  const stories = [story(), story({ headline: 'Second story on Gaza', country: 'PS' })];
  const validJson = JSON.stringify({
    lead: 'The most impactful development today is Iran\'s threats to close the Strait of Hormuz, with significant global oil-market implications.',
    threads: [{ tag: 'Energy', teaser: 'Hormuz closure threats.' }],
    signals: ['Watch for US naval redeployment.'],
  });

  it('cache hit skips the LLM', async () => {
    const cache = makeCache();
    const llm1 = makeLLM(validJson);
    await generateDigestProse('user_abc', stories, 'critical', { ...cache, callLLM: llm1.callLLM });

    const llm2 = makeLLM(() => { throw new Error('would not be called'); });
    const out = await generateDigestProse('user_abc', stories, 'critical', { ...cache, callLLM: llm2.callLLM });
    assert.ok(out);
    assert.equal(llm2.calls.length, 0);
  });

  it('returns null when the LLM output fails parse validation', async () => {
    const cache = makeCache();
    const llm = makeLLM('not json');
    const out = await generateDigestProse('user_abc', stories, 'all', { ...cache, callLLM: llm.callLLM });
    assert.equal(out, null);
    assert.equal(cache.store.size, 0);
  });

  it('different users do NOT share the digest cache even when the story pool is identical', async () => {
    // The cache key is {userId}:{sensitivity}:{poolHash} — userId is
    // part of the key precisely because the digest prose addresses
    // the reader directly ("your brief surfaces ...") and we never
    // want one user's prose showing up in another user's envelope.
    // Assertion: user_a's fresh fetch doesn't prevent user_b from
    // hitting the LLM.
    const cache = makeCache();
    const llm1 = makeLLM(validJson);
    await generateDigestProse('user_a', stories, 'all', { ...cache, callLLM: llm1.callLLM });
    const llm2 = makeLLM(validJson);
    await generateDigestProse('user_b', stories, 'all', { ...cache, callLLM: llm2.callLLM });
    assert.equal(llm1.calls.length, 1);
    assert.equal(llm2.calls.length, 1, 'digest prose cache is per-user, not per-story-pool');
  });

  // REGRESSION: pre-v2 the digest hash was order-insensitive (sort +
  // headline|severity only) as a cache-hit-rate optimisation. The
  // review on PR #3172 called that out as a correctness bug: the
  // LLM prompt includes ranked order AND category/country/source,
  // so serving pre-computed prose for a different ranking = serving
  // stale editorial for a different input. The v2 hash now covers
  // the full prompt, so reordering MUST miss the cache.
  it('story pool reordering invalidates the cache (hash covers ranked order)', async () => {
    const cache = makeCache();
    const llm1 = makeLLM(validJson);
    await generateDigestProse('user_a', [stories[0], stories[1]], 'all', { ...cache, callLLM: llm1.callLLM });
    const llm2 = makeLLM(validJson);
    await generateDigestProse('user_a', [stories[1], stories[0]], 'all', { ...cache, callLLM: llm2.callLLM });
    assert.equal(llm2.calls.length, 1, 'reordered pool is a different prompt — must re-LLM');
  });

  it('changing a story category invalidates the cache (hash covers all prompt fields)', async () => {
    const cache = makeCache();
    const llm1 = makeLLM(validJson);
    await generateDigestProse('user_a', stories, 'all', { ...cache, callLLM: llm1.callLLM });
    const reclassified = [
      { ...stories[0], category: 'Energy' }, // was 'Diplomacy'
      stories[1],
    ];
    const llm2 = makeLLM(validJson);
    await generateDigestProse('user_a', reclassified, 'all', { ...cache, callLLM: llm2.callLLM });
    assert.equal(llm2.calls.length, 1, 'category change re-keys the cache');
  });

  it('malformed cached row is rejected on hit and re-LLM is called', async () => {
    const cache = makeCache();
    // Seed a bad cached row that would poison the envelope: missing
    // `threads`, which the renderer's assertBriefEnvelope requires.
    const llm1 = makeLLM(validJson);
    await generateDigestProse('user_a', stories, 'all', { ...cache, callLLM: llm1.callLLM });
    // Corrupt the stored row in place
    const badKey = [...cache.store.keys()].find((k) => k.startsWith('brief:llm:digest:v2:'));
    assert.ok(badKey, 'expected a digest prose cache entry');
    cache.store.set(badKey, { lead: 'short', /* missing threads + signals */ });
    const llm2 = makeLLM(validJson);
    const out = await generateDigestProse('user_a', stories, 'all', { ...cache, callLLM: llm2.callLLM });
    assert.ok(out, 'shape-failed hit must fall through to LLM');
    assert.equal(llm2.calls.length, 1, 'bad cache row treated as miss');
  });
});

describe('validateDigestProseShape', () => {
  // Extracted helper — the same strictness runs on fresh LLM output
  // AND on cache hits, so a bad row written under older buggy code
  // can't sneak past.
  const good = {
    lead: 'A long-enough executive lead about Hormuz and the Gaza humanitarian crisis, written in editorial tone.',
    threads: [{ tag: 'Energy', teaser: 'Hormuz closure threats resurface.' }],
    signals: ['Watch for US naval redeployment.'],
  };

  it('accepts a well-formed object and returns a normalised copy', () => {
    const out = validateDigestProseShape(good);
    assert.ok(out);
    assert.notEqual(out, good, 'must not return the caller object by reference');
    assert.equal(out.threads.length, 1);
  });

  it('rejects missing threads', () => {
    assert.equal(validateDigestProseShape({ ...good, threads: [] }), null);
    assert.equal(validateDigestProseShape({ lead: good.lead }), null);
  });

  it('rejects short lead', () => {
    assert.equal(validateDigestProseShape({ ...good, lead: 'too short' }), null);
  });

  it('rejects non-object / array / null input', () => {
    assert.equal(validateDigestProseShape(null), null);
    assert.equal(validateDigestProseShape(undefined), null);
    assert.equal(validateDigestProseShape([good]), null);
    assert.equal(validateDigestProseShape('string'), null);
  });
});

describe('buildStoryDescriptionPrompt', () => {
  it('includes all story fields, distinct from whyMatters instruction', () => {
    const { system, user } = buildStoryDescriptionPrompt(story());
    assert.match(system, /describes the development itself/);
    assert.match(system, /One sentence only/);
    assert.match(user, /Headline: Iran threatens/);
    assert.match(user, /Severity: critical/);
  });
});

describe('parseStoryDescription', () => {
  it('returns null for empty / non-string input', () => {
    assert.equal(parseStoryDescription(null), null);
    assert.equal(parseStoryDescription(''), null);
    assert.equal(parseStoryDescription('   '), null);
  });

  it('returns null for a short fragment (<40 chars)', () => {
    assert.equal(parseStoryDescription('Short.'), null);
  });

  it('returns null for a >400-char blob', () => {
    const big = `${'x'.repeat(420)}.`;
    assert.equal(parseStoryDescription(big), null);
  });

  it('strips leading/trailing smart quotes and keeps first sentence', () => {
    const raw = '"Tehran reopened the Strait of Hormuz to commercial shipping today, easing market pressure on crude." Additional sentence here.';
    const out = parseStoryDescription(raw);
    assert.equal(
      out,
      'Tehran reopened the Strait of Hormuz to commercial shipping today, easing market pressure on crude.',
    );
  });

  it('rejects output that is a verbatim echo of the headline', () => {
    const headline = 'Iran threatens to close Strait of Hormuz if US blockade continues';
    assert.equal(parseStoryDescription(headline, headline), null);
    // Whitespace / case variation still counts as an echo.
    assert.equal(parseStoryDescription(`  ${headline.toUpperCase()}  `, headline), null);
  });

  it('accepts a clearly distinct sentence even if it shares noun phrases with the headline', () => {
    const headline = 'Iran threatens to close Strait of Hormuz';
    const out = parseStoryDescription(
      'Tehran issued a rare public warning to tanker traffic, citing Western naval pressure.',
      headline,
    );
    assert.ok(out && out.length > 0);
  });
});

describe('generateStoryDescription', () => {
  it('cache hit: returns cached value, skips the LLM', async () => {
    const good = 'Tehran issued a rare public warning to tanker traffic, citing Western naval pressure on tanker transit.';
    const cache = makeCache();
    // Pre-seed cache with a value under the v1 key (use same hash
    // inputs as story()).
    const llm = makeLLM(() => { throw new Error('should not be called'); });
    await generateStoryDescription(story(), { ...cache, callLLM: llm.callLLM });
    // First call populates cache via the real codepath; re-call uses cache.
    // Reset LLM responder to something that would be rejected:
    const llm2 = makeLLM(() => 'bad');
    cache.store.clear();
    cache.store.set(
      // The real key is private to the module — we can't reconstruct
      // it from the outside. Instead, prime by calling with a working
      // responder first:
      null, null,
    );
    // Simpler, clearer cache-hit assertion:
    const cache2 = makeCache();
    let llm2calls = 0;
    const okLLM = makeLLM((_s, _u, _o) => { llm2calls++; return good; });
    await generateStoryDescription(story(), { ...cache2, callLLM: okLLM.callLLM });
    assert.equal(llm2calls, 1);
    const second = await generateStoryDescription(story(), { ...cache2, callLLM: okLLM.callLLM });
    assert.equal(llm2calls, 1, 'cache hit must NOT re-call LLM');
    assert.equal(second, good);
  });

  it('returns null when LLM throws', async () => {
    const cache = makeCache();
    const llm = makeLLM(() => { throw new Error('provider down'); });
    const out = await generateStoryDescription(story(), { ...cache, callLLM: llm.callLLM });
    assert.equal(out, null);
  });

  it('returns null when LLM output is invalid (too short, echo, etc.)', async () => {
    const cache = makeCache();
    const llm = makeLLM(() => 'no');
    const out = await generateStoryDescription(story(), { ...cache, callLLM: llm.callLLM });
    assert.equal(out, null);
    // Invalid output was NOT cached (we'd otherwise serve it on next call).
    assert.equal(cache.store.size, 0);
  });

  it('revalidates cache hits — a pre-fix bad row is re-LLMd, not served', async () => {
    const cache = makeCache();
    // Compute the key by running a good call first, then tamper with it.
    const good = 'Tehran reopened the Strait of Hormuz to commercial shipping, easing pressure on crude markets today.';
    const okLLM = makeLLM(() => good);
    await generateStoryDescription(story(), { ...cache, callLLM: okLLM.callLLM });
    const keys = [...cache.store.keys()];
    assert.equal(keys.length, 1, 'good call should have written one cache entry');
    // Overwrite with a too-short value (shouldn't pass validator).
    cache.store.set(keys[0], 'too short');
    // Next call should detect the bad cache, re-LLM, overwrite.
    const better = 'The Strait of Hormuz reopened to commercial shipping under Tehran\'s revised guidance, calming tanker traffic.';
    const retryLLM = makeLLM(() => better);
    const out = await generateStoryDescription(story(), { ...cache, callLLM: retryLLM.callLLM });
    assert.equal(out, better);
    assert.equal(cache.store.get(keys[0]), better);
  });

  it('writes to cache with 24h TTL on success', async () => {
    const setCalls = [];
    const cache = {
      async cacheGet() { return null; },
      async cacheSet(key, value, ttlSec) { setCalls.push({ key, value, ttlSec }); },
    };
    const good = 'Tehran issued new guidance to tanker traffic, easing concerns that had spiked Brent intraday.';
    const llm = makeLLM(() => good);
    await generateStoryDescription(story(), { ...cache, callLLM: llm.callLLM });
    assert.equal(setCalls.length, 1);
    assert.equal(setCalls[0].ttlSec, 24 * 60 * 60);
    assert.equal(setCalls[0].value, good);
    assert.match(setCalls[0].key, /^brief:llm:description:v1:/);
  });
});

describe('generateWhyMatters — cache key covers all prompt fields', () => {
  // REGRESSION: pre-v2 whyMatters keyed only on (headline, source,
  // severity), leaving category + country unhashed. If upstream
  // classification or geocoding changed while those three fields
  // stayed the same, cached prose was served for a materially
  // different prompt.
  it('category change busts the cache', async () => {
    const llm1 = {
      calls: 0,
      async callLLM(_s, _u, _opts) {
        this.calls += 1;
        return 'Closure of the Strait of Hormuz would force a coordinated naval response within days.';
      },
    };
    const cache = makeCache();
    const s1 = { category: 'Diplomacy', country: 'IR', threatLevel: 'critical', headline: 'Hormuz closure threat', description: '', source: 'Reuters', whyMatters: '' };
    await generateWhyMatters(s1, { ...cache, callLLM: (sys, u, o) => llm1.callLLM(sys, u, o) });
    const s2 = { ...s1, category: 'Energy' }; // reclassified
    await generateWhyMatters(s2, { ...cache, callLLM: (sys, u, o) => llm1.callLLM(sys, u, o) });
    assert.equal(llm1.calls, 2, 'category change must re-LLM');
  });

  it('country change busts the cache', async () => {
    const llm1 = {
      calls: 0,
      async callLLM() { this.calls += 1; return 'Closure of the Strait of Hormuz would spike oil prices across global markets.'; },
    };
    const cache = makeCache();
    const s1 = { category: 'Diplomacy', country: 'IR', threatLevel: 'critical', headline: 'Hormuz', description: '', source: 'Reuters', whyMatters: '' };
    await generateWhyMatters(s1, { ...cache, callLLM: (sys, u, o) => llm1.callLLM(sys, u, o) });
    const s2 = { ...s1, country: 'OM' }; // re-geocoded
    await generateWhyMatters(s2, { ...cache, callLLM: (sys, u, o) => llm1.callLLM(sys, u, o) });
    assert.equal(llm1.calls, 2, 'country change must re-LLM');
  });
});

// ── enrichBriefEnvelopeWithLLM ─────────────────────────────────────────────

describe('enrichBriefEnvelopeWithLLM', () => {
  const goodWhy = 'Closure of the Strait of Hormuz would spike global oil prices and force a US naval response within 72 hours.';
  const goodProse = JSON.stringify({
    lead: 'Iran\'s threats over the Strait of Hormuz dominate today, alongside the widening Gaza humanitarian crisis and South Sudan famine warnings.',
    threads: [
      { tag: 'Energy', teaser: 'Hormuz closure would disrupt a fifth of seaborne crude.' },
      { tag: 'Humanitarian', teaser: 'UNICEF condemns Gaza water truck killings.' },
    ],
    signals: ['Watch for US naval redeployment in the Gulf.'],
  });

  it('happy path: whyMatters per story + lead/threads/signals substituted', async () => {
    const cache = makeCache();
    let call = 0;
    const llm = makeLLM((_sys, user) => {
      call++;
      if (user.includes('Reader sensitivity level')) return goodProse;
      return goodWhy;
    });
    const env = envelope();
    const out = await enrichBriefEnvelopeWithLLM(env, { userId: 'user_a', sensitivity: 'critical' }, {
      ...cache, callLLM: llm.callLLM,
    });
    for (const s of out.data.stories) {
      assert.equal(s.whyMatters, goodWhy, 'every story gets enriched whyMatters');
    }
    assert.match(out.data.digest.lead, /Strait of Hormuz/);
    assert.equal(out.data.digest.threads.length, 2);
    assert.equal(out.data.digest.signals.length, 1);
    // Numbers / stories count must NOT be touched
    assert.equal(out.data.digest.numbers.surfaced, env.data.digest.numbers.surfaced);
    assert.equal(out.data.stories.length, env.data.stories.length);
  });

  it('LLM down everywhere: envelope returns unchanged stubs', async () => {
    const cache = makeCache();
    const llm = makeLLM(() => { throw new Error('provider down'); });
    const env = envelope();
    const out = await enrichBriefEnvelopeWithLLM(env, { userId: 'user_a', sensitivity: 'all' }, {
      ...cache, callLLM: llm.callLLM,
    });
    // Stories keep their stubbed whyMatters
    assert.equal(out.data.stories[0].whyMatters, env.data.stories[0].whyMatters);
    // Digest prose stays as the stub lead/threads/signals
    assert.equal(out.data.digest.lead, env.data.digest.lead);
    assert.deepEqual(out.data.digest.threads, env.data.digest.threads);
    assert.deepEqual(out.data.digest.signals, env.data.digest.signals);
  });

  it('partial failure: whyMatters OK, digest prose fails — per-story still enriched', async () => {
    const cache = makeCache();
    const llm = makeLLM((_sys, user) => {
      if (user.includes('Reader sensitivity level')) return 'not valid json';
      return goodWhy;
    });
    const env = envelope();
    const out = await enrichBriefEnvelopeWithLLM(env, { userId: 'user_a', sensitivity: 'all' }, {
      ...cache, callLLM: llm.callLLM,
    });
    for (const s of out.data.stories) {
      assert.equal(s.whyMatters, goodWhy);
    }
    // Digest falls back to the stub
    assert.equal(out.data.digest.lead, env.data.digest.lead);
  });

  it('preserves envelope shape: version, issuedAt, user, date unchanged', async () => {
    const cache = makeCache();
    const llm = makeLLM(goodWhy);
    const env = envelope();
    const out = await enrichBriefEnvelopeWithLLM(env, { userId: 'user_a', sensitivity: 'all' }, {
      ...cache, callLLM: llm.callLLM,
    });
    assert.equal(out.version, env.version);
    assert.equal(out.issuedAt, env.issuedAt);
    assert.deepEqual(out.data.user, env.data.user);
    assert.equal(out.data.date, env.data.date);
    assert.equal(out.data.dateLong, env.data.dateLong);
    assert.equal(out.data.issue, env.data.issue);
  });

  it('returns envelope untouched if data or stories are missing', async () => {
    const cache = makeCache();
    const llm = makeLLM(goodWhy);
    const out = await enrichBriefEnvelopeWithLLM({ version: 1, issuedAt: 0 }, { userId: 'user_a' }, {
      ...cache, callLLM: llm.callLLM,
    });
    assert.deepEqual(out, { version: 1, issuedAt: 0 });
    assert.equal(llm.calls.length, 0);
  });

  it('integration: composed + enriched envelope still passes assertBriefEnvelope', async () => {
    // Mirrors the production path: compose from digest stories, then
    // enrich. The output MUST validate — otherwise the SETEX would
    // land a key the api/brief route refuses to render.
    const rule = { userId: 'user_abc', variant: 'full', sensitivity: 'all', digestTimezone: 'UTC' };
    const digestStories = [
      {
        hash: 'a1', title: 'Iran threatens Strait of Hormuz closure', link: 'https://x/1',
        severity: 'critical', currentScore: 100, mentionCount: 5, phase: 'developing',
        sources: ['Guardian'],
      },
      {
        hash: 'a2', title: 'UNICEF outraged by Gaza water truck killings', link: 'https://x/2',
        severity: 'critical', currentScore: 90, mentionCount: 3, phase: 'developing',
        sources: ['UN News'],
      },
    ];
    const composed = composeBriefFromDigestStories(rule, digestStories, { clusters: 277, multiSource: 22 }, { nowMs: 1_745_000_000_000 });
    assert.ok(composed);
    const llm = makeLLM((_sys, user) => {
      if (user.includes('Reader sensitivity level')) {
        return JSON.stringify({
          lead: 'Iran\'s Hormuz threats dominate the wire today, with the Gaza humanitarian crisis deepening on a parallel axis.',
          threads: [
            { tag: 'Energy', teaser: 'Hormuz closure threats resurface.' },
            { tag: 'Humanitarian', teaser: 'Gaza water infrastructure under attack.' },
          ],
          signals: ['Watch for US naval redeployment.'],
        });
      }
      return 'The stakes here extend far beyond the immediate actors and reshape the week ahead.';
    });
    const enriched = await enrichBriefEnvelopeWithLLM(composed, rule, { ...makeCache(), callLLM: llm.callLLM });
    // Must not throw — the renderer's strict validator is the live
    // gate between composer and api/brief.
    assertBriefEnvelope(enriched);
  });

  it('cache write failure does not break enrichment', async () => {
    const llm = makeLLM(goodWhy);
    const env = envelope();
    const brokenCache = {
      async cacheGet() { return null; },
      async cacheSet() { throw new Error('upstash down'); },
    };
    const out = await enrichBriefEnvelopeWithLLM(env, { userId: 'user_a', sensitivity: 'all' }, {
      ...brokenCache, callLLM: llm.callLLM,
    });
    // whyMatters still enriched even though the cache write threw
    for (const s of out.data.stories) {
      assert.equal(s.whyMatters, goodWhy);
    }
  });
});
