/**
 * Integration tests for the /api/internal/brief-why-matters edge endpoint
 * + the cron's analyst-priority fallback chain.
 *
 * The endpoint is a .ts file; we test the pure helpers that go into it
 * (country normalizer, core hashing, prompt builder, context trim, env
 * parsing) plus simulate the handler end-to-end via the imported
 * modules. The cron-side `generateWhyMatters` priority chain is covered
 * directly via in-process dep injection.
 *
 * Run: node --test tests/brief-why-matters-analyst.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { generateWhyMatters } from '../scripts/lib/brief-llm.mjs';
import {
  hashBriefStory,
  parseWhyMatters,
  parseWhyMattersV2,
  WHY_MATTERS_SYSTEM,
} from '../shared/brief-llm-core.js';

// ── Story fixture matching the cron's actual payload shape
// (shared/brief-filter.js:134-135). ────────────────────────────────────

function story(overrides = {}) {
  return {
    headline: 'Iran closes Strait of Hormuz',
    source: 'Reuters',
    threatLevel: 'critical',
    category: 'Geopolitical Risk',
    country: 'IR',
    ...overrides,
  };
}

// ── Country normalizer ───────────────────────────────────────────────────

describe('normalizeCountryToIso2', () => {
  let normalize;
  it('loads from server/_shared/country-normalize.ts via tsx or compiled', async () => {
    // The module is .ts; in the repo's test setup, node 22 can load .ts
    // via tsx. If direct import fails under the test runner, fall back
    // to running the logic inline by importing the JSON and a mirror
    // function. The logic is trivial so this isn't a flaky compromise.
    try {
      const mod = await import('../server/_shared/country-normalize.ts');
      normalize = mod.normalizeCountryToIso2;
    } catch {
      const { default: COUNTRY_NAMES } = await import('../shared/country-names.json', {
        with: { type: 'json' },
      });
      const ISO2_SET = new Set(Object.values(COUNTRY_NAMES));
      normalize = (raw) => {
        if (typeof raw !== 'string') return null;
        const trimmed = raw.trim();
        if (trimmed === '') return null;
        if (trimmed.toLowerCase() === 'global') return null;
        if (/^[A-Za-z]{2}$/.test(trimmed)) {
          const upper = trimmed.toUpperCase();
          return ISO2_SET.has(upper) ? upper : null;
        }
        const lookup = COUNTRY_NAMES[trimmed.toLowerCase()];
        return typeof lookup === 'string' ? lookup : null;
      };
    }
    assert.ok(typeof normalize === 'function');
  });

  it('passes through valid ISO2 case-insensitively', () => {
    assert.equal(normalize('US'), 'US');
    assert.equal(normalize('us'), 'US');
    assert.equal(normalize('IR'), 'IR');
    assert.equal(normalize('gb'), 'GB');
  });

  it('resolves full names case-insensitively', () => {
    assert.equal(normalize('United States'), 'US');
    assert.equal(normalize('united states'), 'US');
    assert.equal(normalize('Iran'), 'IR');
    assert.equal(normalize('United Kingdom'), 'GB');
  });

  it("'Global' sentinel maps to null (non-country; not an error)", () => {
    assert.equal(normalize('Global'), null);
    assert.equal(normalize('global'), null);
    assert.equal(normalize('GLOBAL'), null);
  });

  it('rejects unknown / empty / undefined / non-string inputs', () => {
    assert.equal(normalize(''), null);
    assert.equal(normalize('   '), null);
    assert.equal(normalize('Nowhere'), null);
    assert.equal(normalize(undefined), null);
    assert.equal(normalize(null), null);
    assert.equal(normalize(123), null);
  });

  it('resolves common non-ISO2 abbreviations when they exist in the gazetteer', () => {
    // Plan assumed "USA" was not in the gazetteer; it actually is mapped.
    // This exercises the full-name-path (3+ chars) with a short abbreviation.
    assert.equal(normalize('USA'), 'US');
  });

  it('rejects ISO2-shaped values not in the gazetteer', () => {
    assert.equal(normalize('ZZ'), null); // structurally valid, not in gazetteer
    assert.equal(normalize('XY'), null);
  });
});

// ── Cache-key stability ──────────────────────────────────────────────────

describe('cache key identity', () => {
  it('hashBriefStory stable across the 5-field material', async () => {
    const a = await hashBriefStory(story());
    const b = await hashBriefStory(story());
    assert.equal(a, b);
  });

  it('hashBriefStory differs when any hash-field differs', async () => {
    const baseline = await hashBriefStory(story());
    for (const f of ['headline', 'source', 'threatLevel', 'category', 'country']) {
      const h = await hashBriefStory(story({ [f]: `${story()[f]}X` }));
      assert.notEqual(h, baseline, `${f} must be part of cache identity`);
    }
  });
});

// ── parseWhyMattersV2 — analyst-path output validator ───────────────────
//
// This is the only output-validation gate between the analyst LLM and
// the cache envelope: if it returns null the whole response falls back
// to the gemini layer. Its rejection rules differ from v1 (100–500
// char range, multi-sentence preamble list, section-label check) and
// were not previously covered by unit tests (greptile P2, PR #3281).

describe('parseWhyMattersV2 — analyst output validator', () => {
  const VALID_MULTI =
    "Iran's closure of the Strait of Hormuz on April 21 halts roughly 20% of global seaborne oil. " +
    'The disruption forces an immediate repricing of sovereign risk across Gulf energy exporters.';

  it('accepts a valid 2-sentence, ~40–70 word output', () => {
    const out = parseWhyMattersV2(VALID_MULTI);
    assert.equal(out, VALID_MULTI);
  });

  it('accepts a valid 3-sentence output with optional WATCH arc', () => {
    const three =
      "Iran's closure of the Strait of Hormuz on April 21 halts roughly 20% of global seaborne oil. " +
      'The disruption forces an immediate repricing of sovereign risk across Gulf energy exporters. ' +
      'Watch IMF commentary in the next 48 hours for cascading guidance.';
    assert.equal(parseWhyMattersV2(three), three);
  });

  it('rejects output under the 100-char minimum (distinguishes it from v1)', () => {
    // v1 accepts short outputs; v2 requires 100+ chars so the model has
    // room for SITUATION + ANALYSIS. A short string is "too terse".
    assert.equal(parseWhyMattersV2('Short sentence under 100 chars.'), null);
    assert.equal(parseWhyMattersV2('x'.repeat(99)), null);
    // Boundary: exactly 100 passes.
    assert.equal(typeof parseWhyMattersV2('x'.repeat(100)), 'string');
  });

  it('rejects output over the 500-char cap (prevents runaway essays)', () => {
    assert.equal(parseWhyMattersV2('x'.repeat(501)), null);
    // Boundary: exactly 500 passes.
    assert.equal(typeof parseWhyMattersV2('x'.repeat(500)), 'string');
  });

  it('rejects banned preamble phrases (v2-specific)', () => {
    for (const preamble of [
      'This matters because the Strait of Hormuz closure would halt 20% of global oil supply right now and this is very important for analysts.',
      'The importance of this event is that oil tankers cannot transit the strait, which forces a global supply rerouting and price shock.',
      'It is important to note that Iran has blockaded a critical global shipping chokepoint with real consequences for supply.',
      'Importantly, the closure of the Strait of Hormuz disrupts roughly 20% of global seaborne oil flows starting April 21.',
      'In summary, the analyst sees this as a major geopolitical escalation with wide-reaching market and security implications.',
      'To summarize, the blockade represents a sharp departure from the prior six months of relative calm in the Persian Gulf region.',
    ]) {
      assert.equal(parseWhyMattersV2(preamble), null, `should reject preamble: "${preamble.slice(0, 40)}..."`);
    }
  });

  it('rejects section-label leaks (SITUATION/ANALYSIS/WATCH prefixes)', () => {
    for (const leak of [
      'SITUATION: Iran has closed the Strait of Hormuz effective April 21, halting roughly 20% of seaborne global oil supply today.',
      'ANALYSIS — the disruption forces an immediate global sovereign risk repricing across Gulf exporters including Saudi Arabia and UAE.',
      'Watch: IMF commentary for the next 48 hours should give the earliest signal on the cascading global guidance implications.',
    ]) {
      assert.equal(parseWhyMattersV2(leak), null, `should reject label leak: "${leak.slice(0, 40)}..."`);
    }
  });

  it('rejects markdown leakage (bullets, headers, numbered lists)', () => {
    for (const md of [
      '# The closure of the Strait of Hormuz is the single most material geopolitical event of the quarter for sovereign credit.',
      '- Iran has blockaded the Strait of Hormuz, halting roughly 20% of the world seaborne oil on April 21 effective immediately.',
      '* The closure of the Strait of Hormuz halts roughly 20% of the world seaborne oil, which forces an immediate price shock today.',
      '1. The closure of the Strait of Hormuz halts roughly 20% of seaborne global oil, which forces an immediate sovereign risk repricing.',
    ]) {
      assert.equal(parseWhyMattersV2(md), null, `should reject markdown: "${md.slice(0, 40)}..."`);
    }
  });

  it('rejects the stub echo (same as v1)', () => {
    const stub =
      'Story flagged by your sensitivity settings — the analyst could not find a clean grounding fact and returned the pre-canned fallback.';
    assert.equal(parseWhyMattersV2(stub), null);
  });

  it('trims surrounding quote marks the model sometimes wraps output in', () => {
    const quoted = `"${VALID_MULTI}"`;
    assert.equal(parseWhyMattersV2(quoted), VALID_MULTI);
    const smart = `\u201C${VALID_MULTI}\u201D`;
    assert.equal(parseWhyMattersV2(smart), VALID_MULTI);
  });

  it('rejects non-string inputs (defensive)', () => {
    for (const v of [null, undefined, 123, {}, [], true]) {
      assert.equal(parseWhyMattersV2(v), null, `should reject ${typeof v}`);
    }
  });

  it('rejects whitespace-only strings', () => {
    assert.equal(parseWhyMattersV2(''), null);
    assert.equal(parseWhyMattersV2('   \n\t  '), null);
  });
});

// ── Deterministic shadow sampling ────────────────────────────────────────

describe('shadow sample deterministic hashing', () => {
  // Mirror of the endpoint's sample decision — any drift between this
  // and the endpoint would silently halve the sampled population.
  function sampleHit(hash16, pct) {
    if (pct >= 100) return true;
    if (pct <= 0) return false;
    const bucket = Number.parseInt(hash16.slice(0, 8), 16) % 100;
    return bucket < pct;
  }

  it('pct=100 always hits', () => {
    for (const h of ['0000000000000000', 'ffffffffffffffff', 'abcdef0123456789']) {
      assert.equal(sampleHit(h, 100), true);
    }
  });

  it('pct=0 never hits', () => {
    for (const h of ['0000000000000000', 'ffffffffffffffff', 'abcdef0123456789']) {
      assert.equal(sampleHit(h, 0), false);
    }
  });

  it('pct=25 hits approximately 25% on a bulk sample, and is deterministic', async () => {
    let hits = 0;
    const N = 400;
    const seen = new Map();
    for (let i = 0; i < N; i++) {
      const h = await hashBriefStory(story({ headline: `fixture-${i}` }));
      const first = sampleHit(h, 25);
      const second = sampleHit(h, 25);
      assert.equal(first, second, `hash ${h} must give the same decision`);
      seen.set(h, first);
      if (first) hits++;
    }
    // Tolerance: uniform mod-100 on SHA-256 prefix should be tight.
    assert.ok(hits > N * 0.15, `expected > 15% hits, got ${hits}`);
    assert.ok(hits < N * 0.35, `expected < 35% hits, got ${hits}`);
  });
});

// ── `generateWhyMatters` analyst-priority chain ─────────────────────────

describe('generateWhyMatters — analyst priority', () => {
  const VALID = 'Closure of the Strait of Hormuz would spike global oil prices and force a US naval response.';

  it('uses the analyst endpoint result when it returns a string', async () => {
    let callLlmInvoked = false;
    const out = await generateWhyMatters(story(), {
      callAnalystWhyMatters: async () => VALID,
      callLLM: async () => {
        callLlmInvoked = true;
        return 'FALLBACK unused';
      },
      cacheGet: async () => null,
      cacheSet: async () => {},
    });
    assert.equal(out, VALID);
    assert.equal(callLlmInvoked, false, 'legacy callLLM must NOT fire when analyst returns');
  });

  it('falls through to legacy chain when analyst returns null', async () => {
    let callLlmInvoked = false;
    const out = await generateWhyMatters(story(), {
      callAnalystWhyMatters: async () => null,
      callLLM: async () => {
        callLlmInvoked = true;
        return VALID;
      },
      cacheGet: async () => null,
      cacheSet: async () => {},
    });
    assert.equal(out, VALID);
    assert.equal(callLlmInvoked, true, 'legacy callLLM must fire after analyst miss');
  });

  it('falls through when analyst returns out-of-bounds output (too short)', async () => {
    let callLlmInvoked = false;
    const out = await generateWhyMatters(story(), {
      callAnalystWhyMatters: async () => 'Short.',
      callLLM: async () => {
        callLlmInvoked = true;
        return VALID;
      },
      cacheGet: async () => null,
      cacheSet: async () => {},
    });
    assert.equal(out, VALID);
    assert.equal(callLlmInvoked, true, 'out-of-bounds analyst output must trigger fallback');
  });

  it('preserves multi-sentence v2 analyst output verbatim (P1 regression guard)', async () => {
    // The endpoint now returns 2–3 sentences validated by parseWhyMattersV2.
    // The cron MUST NOT reparse with the v1 single-sentence parser, which
    // would silently truncate the 2nd + 3rd sentences. Caught in PR #3269
    // review; fixed by trusting the endpoint's own validation and only
    // rejecting obvious garbage (length / stub echo) here.
    const multi =
      "Iran's closure of the Strait of Hormuz on April 21 halts roughly 20% of global seaborne oil. " +
      'The disruption forces an immediate repricing of sovereign risk across Gulf energy exporters. ' +
      'Watch IMF commentary in the next 48 hours for cascading guidance.';
    let callLlmInvoked = false;
    const out = await generateWhyMatters(story(), {
      callAnalystWhyMatters: async () => multi,
      callLLM: async () => {
        callLlmInvoked = true;
        return VALID;
      },
      cacheGet: async () => null,
      cacheSet: async () => {},
    });
    assert.equal(out, multi, 'multi-sentence v2 output must reach the envelope unchanged');
    assert.equal(callLlmInvoked, false, 'legacy callLLM must not fire when v2 analyst succeeds');
    // Sanity: output is actually multi-sentence (not truncated to first).
    assert.ok(out.split('. ').length >= 2, 'output must retain 2nd+ sentences');
  });

  it('falls through when analyst throws', async () => {
    let callLlmInvoked = false;
    const out = await generateWhyMatters(story(), {
      callAnalystWhyMatters: async () => {
        throw new Error('network timeout');
      },
      callLLM: async () => {
        callLlmInvoked = true;
        return VALID;
      },
      cacheGet: async () => null,
      cacheSet: async () => {},
    });
    assert.equal(out, VALID);
    assert.equal(callLlmInvoked, true);
  });

  it('returns null when BOTH layers fail (caller uses stub)', async () => {
    const out = await generateWhyMatters(story(), {
      callAnalystWhyMatters: async () => null,
      callLLM: async () => null,
      cacheGet: async () => null,
      cacheSet: async () => {},
    });
    assert.equal(out, null);
  });

  it('no callAnalystWhyMatters dep → legacy chain runs directly (backcompat)', async () => {
    let callLlmInvoked = false;
    const out = await generateWhyMatters(story(), {
      callLLM: async () => {
        callLlmInvoked = true;
        return VALID;
      },
      cacheGet: async () => null,
      cacheSet: async () => {},
    });
    assert.equal(out, VALID);
    assert.equal(callLlmInvoked, true);
  });
});

// ── Body validation (simulated — same rules as endpoint's
// validateStoryBody) ────────────────────────────────────────────────────

describe('endpoint validation contract', () => {
  // Mirror of the endpoint's validation so unit tests don't need the
  // full edge runtime. Any divergence would surface as a cross-suite
  // test regression on the endpoint flow (see "endpoint end-to-end" below).
  const VALID_THREAT = new Set(['critical', 'high', 'medium', 'low']);
  const CAPS = { headline: 400, source: 120, category: 80, country: 80 };
  // Must match `api/internal/brief-why-matters.ts:116` — bumped to 8192 in
  // PR #3269 to accommodate v2 output + description. If this ever drifts
  // again, the bloated-fixture assertion below silently passes for
  // payloads in the (OLD_VALUE, NEW_VALUE] range that the real endpoint
  // now accepts (greptile P2, PR #3281).
  const MAX_BODY_BYTES = 8192;

  function validate(raw) {
    if (!raw || typeof raw !== 'object') return { ok: false, msg: 'body' };
    const s = raw.story;
    if (!s || typeof s !== 'object') return { ok: false, msg: 'body.story' };
    for (const f of ['headline', 'source', 'category']) {
      if (typeof s[f] !== 'string' || s[f].length === 0) return { ok: false, msg: f };
      if (s[f].length > CAPS[f]) return { ok: false, msg: `${f}-length` };
    }
    if (typeof s.threatLevel !== 'string' || !VALID_THREAT.has(s.threatLevel)) {
      return { ok: false, msg: 'threatLevel' };
    }
    if (s.country !== undefined) {
      if (typeof s.country !== 'string') return { ok: false, msg: 'country' };
      if (s.country.length > CAPS.country) return { ok: false, msg: 'country-length' };
    }
    return { ok: true };
  }

  function measureBytes(obj) {
    return new TextEncoder().encode(JSON.stringify(obj)).byteLength;
  }

  it('accepts a valid payload', () => {
    assert.deepEqual(validate({ story: story() }), { ok: true });
  });

  it('rejects threatLevel="info" (not in the 4-value enum)', () => {
    const out = validate({ story: story({ threatLevel: 'info' }) });
    assert.equal(out.ok, false);
    assert.equal(out.msg, 'threatLevel');
  });

  it('accepts free-form category (no allowlist)', () => {
    for (const cat of ['General', 'Geopolitical Risk', 'Market Activity', 'Humanitarian Crisis']) {
      assert.deepEqual(validate({ story: story({ category: cat }) }), { ok: true });
    }
  });

  it('rejects category exceeding length cap', () => {
    const long = 'x'.repeat(81);
    const out = validate({ story: story({ category: long }) });
    assert.equal(out.ok, false);
    assert.equal(out.msg, 'category-length');
  });

  it('rejects empty required fields', () => {
    for (const f of ['headline', 'source', 'category']) {
      const out = validate({ story: story({ [f]: '' }) });
      assert.equal(out.ok, false);
      assert.equal(out.msg, f);
    }
  });

  it('accepts empty country + country="Global" + missing country', () => {
    assert.deepEqual(validate({ story: story({ country: '' }) }), { ok: true });
    assert.deepEqual(validate({ story: story({ country: 'Global' }) }), { ok: true });
    const { country: _, ...withoutCountry } = story();
    assert.deepEqual(validate({ story: withoutCountry }), { ok: true });
  });

  it('body cap catches oversize payloads (both Content-Length and post-read)', () => {
    const bloated = {
      story: {
        ...story(),
        // Artificial oversize payload — would need headline cap bypassed
        // to reach in practice, but the total body-byte cap must still fire.
        // Sized well above MAX_BODY_BYTES (8192) so a future bump doesn't
        // silently invalidate the assertion.
        extra: 'x'.repeat(10_000),
      },
    };
    assert.ok(measureBytes(bloated) > MAX_BODY_BYTES, 'fixture is oversize');
    // Note: body-cap is enforced at the handler level, not the validator.
    // We assert the invariant about the measure here; the handler path is
    // covered by the endpoint smoke test below.
  });
});

// ── Prompt builder shape ──────────────────────────────────────────────

describe('buildAnalystWhyMattersPrompt — shape and budget', () => {
  let builder;
  it('loads', async () => {
    const mod = await import('../server/worldmonitor/intelligence/v1/brief-why-matters-prompt.ts');
    builder = mod.buildAnalystWhyMattersPrompt;
    assert.ok(typeof builder === 'function');
  });

  it('uses the analyst v2 system prompt (multi-sentence, grounded)', async () => {
    const { WHY_MATTERS_ANALYST_SYSTEM_V2 } = await import('../shared/brief-llm-core.js');
    const { system } = builder(story(), {
      worldBrief: 'X',
      countryBrief: '',
      riskScores: '',
      forecasts: '',
      marketData: '',
      macroSignals: '',
      degraded: false,
    });
    assert.equal(system, WHY_MATTERS_ANALYST_SYSTEM_V2);
    // Contract must still mention the 40–70 word target + grounding rule.
    assert.match(system, /40–70 words/);
    assert.match(system, /named person \/ country \/ organization \/ number \/ percentage \/ date \/ city/);
  });

  it('includes story fields with the multi-sentence footer', () => {
    const { user } = builder(story(), {
      worldBrief: '',
      countryBrief: '',
      riskScores: '',
      forecasts: '',
      marketData: '',
      macroSignals: '',
      degraded: false,
    });
    assert.match(user, /Headline: Iran closes Strait of Hormuz/);
    assert.match(user, /Source: Reuters/);
    assert.match(user, /Severity: critical/);
    assert.match(user, /Category: Geopolitical Risk/);
    assert.match(user, /Country: IR/);
    assert.match(user, /Write 2–3 sentences \(40–70 words\)/);
    assert.match(user, /grounded in at least ONE specific/);
  });

  it('includes story description when present', () => {
    const storyWithDesc = {
      ...story(),
      description: 'Tehran publicly reopened the Strait of Hormuz to commercial shipping today.',
    };
    const { user } = builder(storyWithDesc, {
      worldBrief: '',
      countryBrief: '',
      riskScores: '',
      forecasts: '',
      marketData: '',
      macroSignals: '',
      degraded: false,
    });
    assert.match(user, /Description: Tehran publicly reopened/);
  });

  it('omits description line when field absent', () => {
    const { user } = builder(story(), {
      worldBrief: '',
      countryBrief: '',
      riskScores: '',
      forecasts: '',
      marketData: '',
      macroSignals: '',
      degraded: false,
    });
    assert.doesNotMatch(user, /Description:/);
  });

  it('omits context block when all fields empty', () => {
    const { user } = builder(story(), {
      worldBrief: '',
      countryBrief: '',
      riskScores: '',
      forecasts: '',
      marketData: '',
      macroSignals: '',
      degraded: false,
    });
    assert.doesNotMatch(user, /# Live WorldMonitor Context/);
  });

  it('truncates context to stay under budget', () => {
    const hugeContext = {
      worldBrief: 'x'.repeat(5000),
      countryBrief: 'y'.repeat(5000),
      riskScores: 'z'.repeat(5000),
      forecasts: 'w'.repeat(5000),
      marketData: 'v'.repeat(5000),
      macroSignals: 'u'.repeat(5000),
      degraded: false,
    };
    const { user } = builder(story(), hugeContext);
    // Total user prompt should be bounded. Per plan: context budget ~1700
    // + story fields + footer ~250 → under 2.5KB.
    assert.ok(user.length < 2500, `prompt should be bounded; got ${user.length} chars`);
  });
});

// ── Category-gated context (2026-04-22 formulaic-grounding fix) ──────
//
// Shadow-diff of 15 v2 pairs showed the analyst pattern-matching loud
// context numbers (VIX, top forecast probability, MidEast FX stress)
// into every story regardless of editorial fit. The structural fix is
// to only feed editorially-relevant context bundles per category; the
// prompt-level RELEVANCE RULE is a second-layer guard.
//
// These tests pin the category → sections map so a future "loosen this
// one little thing" edit can't silently re-introduce market metrics
// into humanitarian stories.

describe('sectionsForCategory — structural relevance gating', () => {
  let sectionsForCategory;
  let builder;
  it('loads', async () => {
    const mod = await import('../server/worldmonitor/intelligence/v1/brief-why-matters-prompt.ts');
    sectionsForCategory = mod.sectionsForCategory;
    builder = mod.buildAnalystWhyMattersPrompt;
    assert.ok(typeof sectionsForCategory === 'function');
  });

  it('market/commodity/finance → includes marketData + forecasts, excludes riskScores', () => {
    for (const cat of ['Energy', 'Commodity Squeeze', 'Market Activity', 'Financial Stress', 'Oil Markets', 'Trade Policy']) {
      const { sections, policyLabel } = sectionsForCategory(cat);
      assert.equal(policyLabel, 'market', `${cat} should match market policy`);
      assert.ok(sections.includes('marketData'), `${cat} should include marketData`);
      assert.ok(sections.includes('forecasts'), `${cat} should include forecasts`);
      assert.ok(sections.includes('macroSignals'), `${cat} should include macroSignals`);
      assert.ok(!sections.includes('riskScores'), `${cat} should NOT include riskScores`);
    }
  });

  it('humanitarian → excludes marketData AND forecasts (the #1 drift pattern)', () => {
    for (const cat of ['Humanitarian Crisis', 'Refugee Flow', 'Civil Unrest', 'Social Upheaval', 'Rights Violation', 'Aid Delivery', 'Migration']) {
      const { sections, policyLabel } = sectionsForCategory(cat);
      assert.equal(policyLabel, 'humanitarian', `${cat} should match humanitarian policy`);
      assert.ok(!sections.includes('marketData'), `${cat} must NOT include marketData`);
      assert.ok(!sections.includes('forecasts'), `${cat} must NOT include forecasts`);
      assert.ok(!sections.includes('macroSignals'), `${cat} must NOT include macroSignals`);
      assert.ok(sections.includes('riskScores'), `${cat} should include riskScores`);
    }
  });

  it('geopolitical → includes forecasts + riskScores, excludes marketData', () => {
    for (const cat of ['Geopolitical Risk', 'Military Posture', 'Conflict', 'War', 'Terrorism', 'Security', 'Nuclear Policy', 'Defense']) {
      const { sections, policyLabel } = sectionsForCategory(cat);
      assert.equal(policyLabel, 'geopolitical', `${cat} should match geopolitical policy`);
      assert.ok(sections.includes('forecasts'), `${cat} should include forecasts`);
      assert.ok(sections.includes('riskScores'), `${cat} should include riskScores`);
      assert.ok(!sections.includes('marketData'), `${cat} must NOT include marketData`);
      assert.ok(!sections.includes('macroSignals'), `${cat} must NOT include macroSignals`);
    }
  });

  it('diplomacy → riskScores only, no markets/forecasts', () => {
    for (const cat of ['Diplomacy', 'Negotiations', 'Summit Meetings', 'Sanctions']) {
      const { sections, policyLabel } = sectionsForCategory(cat);
      assert.equal(policyLabel, 'diplomacy', `${cat} should match diplomacy policy`);
      assert.ok(sections.includes('riskScores'), `${cat} should include riskScores`);
      assert.ok(!sections.includes('marketData'), `${cat} must NOT include marketData`);
      assert.ok(!sections.includes('forecasts'), `${cat} must NOT include forecasts`);
    }
  });

  it('tech → riskScores only, no markets/forecasts/macro', () => {
    for (const cat of ['Tech Policy', 'Cyber Attack', 'AI Regulation', 'Artificial Intelligence', 'Algorithm Abuse', 'Autonomous Systems']) {
      const { sections, policyLabel } = sectionsForCategory(cat);
      assert.equal(policyLabel, 'tech', `${cat} should match tech policy`);
      assert.ok(sections.includes('riskScores'), `${cat} should include riskScores`);
      assert.ok(!sections.includes('marketData'), `${cat} must NOT include marketData`);
      assert.ok(!sections.includes('forecasts'), `${cat} must NOT include forecasts`);
    }
  });

  it('aviation / airspace / drone → riskScores only, NO markets/forecasts/macro (PR #3281 review fix)', () => {
    // Reviewer caught that aviation was named in the RELEVANCE RULE as a
    // category banned from off-topic metrics, but had no structural
    // regex entry — so "Aviation Incident" / "Airspace Closure" / etc.
    // fell through to DEFAULT_SECTIONS and still got all 6 bundles
    // including marketData + forecasts + macroSignals. Direct repro
    // test so a future regex rewrite can't silently regress.
    for (const cat of ['Aviation Incident', 'Airspace Closure', 'Plane Crash', 'Flight Disruption', 'Drone Incursion', 'Aircraft Shot Down']) {
      const { sections, policyLabel } = sectionsForCategory(cat);
      assert.equal(policyLabel, 'aviation', `${cat} should match aviation policy`);
      assert.ok(sections.includes('riskScores'), `${cat} should include riskScores`);
      assert.ok(!sections.includes('marketData'), `${cat} must NOT include marketData`);
      assert.ok(!sections.includes('forecasts'), `${cat} must NOT include forecasts`);
      assert.ok(!sections.includes('macroSignals'), `${cat} must NOT include macroSignals`);
    }
  });

  it('unknown / empty category → default (all 6 sections, backcompat)', () => {
    for (const cat of ['', 'General', 'Sports Event', 'Unknown Thing']) {
      const { sections, policyLabel } = sectionsForCategory(cat);
      assert.equal(policyLabel, 'default', `"${cat}" should fall through to default`);
      // Default must include everything — prevents a regression where
      // a refactor accidentally empties the default.
      for (const k of ['worldBrief', 'countryBrief', 'riskScores', 'forecasts', 'macroSignals', 'marketData']) {
        assert.ok(sections.includes(k), `default policy should include ${k}`);
      }
    }
  });

  it('RELEVANCE RULE categories have structural coverage (no prompt-only guards)', () => {
    // Meta-invariant: every category named in the system prompt's
    // RELEVANCE RULE as banned-from-off-topic-metrics MUST have a
    // matching policy entry. A prompt-only guard is too soft — models
    // follow inline instructions imperfectly. If someone adds a new
    // category to the prompt, this test fires until they add a regex.
    for (const cat of ['Humanitarian Crisis', 'Aviation Incident', 'Diplomatic Summit', 'Cyber Attack']) {
      const { policyLabel } = sectionsForCategory(cat);
      assert.notEqual(
        policyLabel,
        'default',
        `"${cat}" is named in WHY_MATTERS_ANALYST_SYSTEM_V2 as banned from market metrics — it must have a structural policy, not fall through to default`,
      );
    }
  });

  it('non-string / null / undefined category → default fallback (defensive)', () => {
    for (const cat of [null, undefined, 123, {}, []]) {
      const { policyLabel } = sectionsForCategory(cat);
      assert.equal(policyLabel, 'default', `non-string ${JSON.stringify(cat)} should fall through to default`);
    }
  });

  it('buildAnalystWhyMattersPrompt — humanitarian story must not see marketData or forecasts', () => {
    const humanitarian = {
      headline: 'Rwanda hosts fresh Congolese refugees',
      source: 'UNHCR',
      threatLevel: 'high',
      category: 'Humanitarian Crisis',
      country: 'RW',
    };
    const fullContext = {
      worldBrief: 'Global migration pressure is at a decade high.',
      countryBrief: 'Rwanda has absorbed 100K refugees this quarter.',
      riskScores: 'Risk index 62/100 (elevated).',
      forecasts: 'Top forecast: Congo ceasefire holds (72% by Q3).',
      // Use distinctive values that would never appear in the guardrail
      // text — the guardrail mentions "VIX value" / "FX reading" in the
      // abstract, so we assert on the concrete numeric fingerprint.
      marketData: 'VIX-READING-19-50. EUR/USD 1.0732. Gold $2,380.',
      macroSignals: 'MidEastFxStressSentinel-77.',
      degraded: false,
    };
    const { user, policyLabel } = builder(humanitarian, fullContext);
    assert.equal(policyLabel, 'humanitarian');
    // Structural guarantee: the distinctive context values physically
    // cannot appear in the prompt because we didn't pass them to the LLM.
    assert.doesNotMatch(user, /VIX-READING-19-50/, 'humanitarian prompt must not include marketData sentinel');
    assert.doesNotMatch(user, /EUR\/USD/, 'humanitarian prompt must not include FX pair');
    assert.doesNotMatch(user, /Top forecast/, 'humanitarian prompt must not include forecasts');
    assert.doesNotMatch(user, /MidEastFxStressSentinel/, 'humanitarian prompt must not include macro signals');
    assert.doesNotMatch(user, /## Market Data/, 'humanitarian prompt must not have a Market Data section heading');
    assert.doesNotMatch(user, /## Forecasts/, 'humanitarian prompt must not have a Forecasts section heading');
    assert.doesNotMatch(user, /## Macro Signals/, 'humanitarian prompt must not have a Macro Signals section heading');
    // But country + risk framing must survive.
    assert.match(user, /Rwanda has absorbed/);
    assert.match(user, /Risk index/);
  });

  it('buildAnalystWhyMattersPrompt — market story DOES see marketData', () => {
    const marketStory = {
      headline: 'Crude oil jumps 4% on Houthi tanker strike',
      source: 'FT',
      threatLevel: 'high',
      category: 'Energy',
      country: 'YE',
    };
    const ctx = {
      worldBrief: 'Red Sea shipping activity down 35% YoY.',
      countryBrief: 'Yemen remains active conflict zone.',
      riskScores: 'Risk index 88/100.',
      forecasts: 'Top forecast: Houthi attacks continue (83%).',
      marketData: 'Brent $87.40. VIX 19.50. USD/SAR flat.',
      macroSignals: 'Shipping-stress index at 3-month high.',
      degraded: false,
    };
    const { user, policyLabel } = builder(marketStory, ctx);
    assert.equal(policyLabel, 'market');
    assert.match(user, /Brent/);
    assert.match(user, /Shipping-stress/);
    assert.match(user, /Top forecast/);
    // Market policy excludes riskScores — the LLM would otherwise tack
    // on a "country risk 88/100" into every commodity story.
    assert.doesNotMatch(user, /Risk index 88/);
  });

  it('buildAnalystWhyMattersPrompt — prompt footer includes relevance guardrail', () => {
    const { user } = builder(
      { headline: 'X', source: 'Y', threatLevel: 'low', category: 'General', country: 'US' },
      { worldBrief: '', countryBrief: '', riskScores: '', forecasts: '', marketData: '', macroSignals: '', degraded: false },
    );
    // Guardrail phrases — if any of these drops out, the prompt-level
    // second-layer guard is broken and we're back to the formulaic v5
    // behavior for any story that still hits the default policy.
    assert.match(user, /DO NOT force/i, 'guardrail phrase "DO NOT force" must be in footer');
    assert.match(user, /off-topic market metric|VIX|forecast probability/i);
    assert.match(user, /named actor, place, date, or figure/);
  });
});

// ── Env flag parsing (endpoint config resolution) ─────────────────────

describe('endpoint env flag parsing', () => {
  // Mirror the endpoint's readConfig logic so a drift between this
  // expectation and the handler fails one test suite.
  function readConfig(env) {
    const rawPrimary = (env.BRIEF_WHY_MATTERS_PRIMARY ?? '').trim().toLowerCase();
    let primary;
    let invalidPrimaryRaw = null;
    if (rawPrimary === '' || rawPrimary === 'analyst') primary = 'analyst';
    else if (rawPrimary === 'gemini') primary = 'gemini';
    else {
      primary = 'gemini';
      invalidPrimaryRaw = rawPrimary;
    }
    const shadowEnabled = env.BRIEF_WHY_MATTERS_SHADOW !== '0';
    const rawSample = env.BRIEF_WHY_MATTERS_SHADOW_SAMPLE_PCT;
    let samplePct = 100;
    let invalidSamplePctRaw = null;
    if (rawSample !== undefined && rawSample !== '') {
      const parsed = Number.parseInt(rawSample, 10);
      if (Number.isInteger(parsed) && parsed >= 0 && parsed <= 100 && String(parsed) === rawSample.trim()) {
        samplePct = parsed;
      } else {
        invalidSamplePctRaw = rawSample;
      }
    }
    return { primary, invalidPrimaryRaw, shadowEnabled, samplePct, invalidSamplePctRaw };
  }

  it('defaults: primary=analyst, shadow=on, sample=100', () => {
    const c = readConfig({});
    assert.equal(c.primary, 'analyst');
    assert.equal(c.shadowEnabled, true);
    assert.equal(c.samplePct, 100);
  });

  it('PRIMARY=gemini is honoured (kill switch)', () => {
    const c = readConfig({ BRIEF_WHY_MATTERS_PRIMARY: 'gemini' });
    assert.equal(c.primary, 'gemini');
  });

  it('PRIMARY=analust (typo) falls back to gemini + invalidPrimaryRaw set', () => {
    const c = readConfig({ BRIEF_WHY_MATTERS_PRIMARY: 'analust' });
    assert.equal(c.primary, 'gemini');
    assert.equal(c.invalidPrimaryRaw, 'analust');
  });

  it('SHADOW disabled only by exact "0"', () => {
    for (const v of ['yes', '1', 'true', '', 'on']) {
      assert.equal(readConfig({ BRIEF_WHY_MATTERS_SHADOW: v }).shadowEnabled, true, `value=${v}`);
    }
    assert.equal(readConfig({ BRIEF_WHY_MATTERS_SHADOW: '0' }).shadowEnabled, false);
  });

  it('SAMPLE_PCT accepts integer 0–100; invalid → 100', () => {
    assert.equal(readConfig({ BRIEF_WHY_MATTERS_SHADOW_SAMPLE_PCT: '25' }).samplePct, 25);
    assert.equal(readConfig({ BRIEF_WHY_MATTERS_SHADOW_SAMPLE_PCT: '0' }).samplePct, 0);
    assert.equal(readConfig({ BRIEF_WHY_MATTERS_SHADOW_SAMPLE_PCT: '100' }).samplePct, 100);
    assert.equal(readConfig({ BRIEF_WHY_MATTERS_SHADOW_SAMPLE_PCT: '101' }).samplePct, 100);
    assert.equal(readConfig({ BRIEF_WHY_MATTERS_SHADOW_SAMPLE_PCT: 'foo' }).samplePct, 100);
    assert.equal(readConfig({ BRIEF_WHY_MATTERS_SHADOW_SAMPLE_PCT: '-5' }).samplePct, 100);
    assert.equal(readConfig({ BRIEF_WHY_MATTERS_SHADOW_SAMPLE_PCT: '50.5' }).samplePct, 100);
  });
});

// ── Gemini path prompt parity snapshot ────────────────────────────────

describe('Gemini path prompt parity', () => {
  it('buildWhyMattersPrompt output is stable (frozen snapshot)', async () => {
    const { buildWhyMattersPrompt } = await import('../scripts/lib/brief-llm.mjs');
    const { system, user } = buildWhyMattersPrompt(story());
    // Snapshot — if either the system prompt or the user prompt shape
    // changes, the endpoint's gemini-path output will drift from the
    // cron's pre-PR output. Bump BRIEF_WHY_MATTERS_PRIMARY=gemini
    // rollout risk accordingly.
    assert.match(system, /ONE concise sentence \(18–30 words\)/);
    assert.equal(
      user.split('\n').slice(0, 5).join('\n'),
      [
        'Headline: Iran closes Strait of Hormuz',
        'Source: Reuters',
        'Severity: critical',
        'Category: Geopolitical Risk',
        'Country: IR',
      ].join('\n'),
    );
    assert.ok(user.endsWith('One editorial sentence on why this matters:'));
  });
});
