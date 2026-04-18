// Shape tests for the deterministic brief magazine renderer.
//
// The renderer is pure — same envelope in, same HTML out. These tests
// pin down the page-sequence rules that the rest of the pipeline
// (edge route, dashboard panel, email teaser, carousel, Tauri reader)
// depends on. If one of these breaks, every consumer gets confused.
//
// The forbidden-field guard protects the invariant that the renderer
// only ever interpolates `envelope.data.*` fields. We prove this two
// ways: (1) assert known field-name TOKENS (JSON keys like
// `"importanceScore":`) never appear in the output, and (2) inject
// sentinels into non-`data` locations of the envelope and assert the
// sentinels are absent. The earlier version of this test matched bare
// substrings like "openai" / "claude" / "gemini", which false-fails
// on any legitimate story covering those companies.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { renderBriefMagazine } from '../server/_shared/brief-render.js';
import { BRIEF_ENVELOPE_VERSION } from '../shared/brief-envelope.js';

/**
 * @typedef {import('../shared/brief-envelope.js').BriefEnvelope} BriefEnvelope
 * @typedef {import('../shared/brief-envelope.js').BriefStory} BriefStory
 * @typedef {import('../shared/brief-envelope.js').BriefThread} BriefThread
 */

// ── Fixtures ─────────────────────────────────────────────────────────────────

/** @returns {BriefStory} */
function story(overrides = {}) {
  return {
    category: 'Energy',
    country: 'IR',
    threatLevel: 'high',
    headline: 'Iran declares Strait of Hormuz open. Oil drops more than 9%.',
    description:
      'Tehran publicly reopened the Strait of Hormuz to commercial shipping today.',
    source: 'Multiple wires',
    sourceUrl: 'https://example.com/hormuz-open',
    whyMatters:
      'Hormuz is roughly a fifth of global seaborne oil — a 9% move in a single session is a repricing, not a wobble.',
    ...overrides,
  };
}

/** @returns {BriefThread} */
function thread(tag, teaser) {
  return { tag, teaser };
}

/**
 * @param {Partial<import('../shared/brief-envelope.js').BriefData>} overrides
 * @returns {BriefEnvelope}
 */
function envelope(overrides = {}) {
  const data = {
    user: { name: 'Elie', tz: 'UTC' },
    issue: '17.04',
    date: '2026-04-17',
    dateLong: '17 April 2026',
    digest: {
      greeting: 'Good evening.',
      lead: 'The most impactful development today is the reopening of the Strait of Hormuz.',
      numbers: { clusters: 278, multiSource: 21, surfaced: 4 },
      threads: [
        thread('Energy', 'Iran reopens the Strait of Hormuz.'),
        thread('Diplomacy', 'Israel\u2013Lebanon ceasefire takes effect.'),
        thread('Maritime', 'US military expands posture against Iran-linked shipping.'),
        thread('Humanitarian', 'A record year at sea for Rohingya refugees.'),
      ],
      signals: [
        'Adherence to the Israel\u2013Lebanon ceasefire in the first 72 hours.',
        'Long-term stability of commercial shipping through Hormuz.',
      ],
    },
    stories: [
      story(),
      story({ country: 'IL', category: 'Diplomacy' }),
      story({ country: 'US', category: 'Maritime', threatLevel: 'critical' }),
      story({ country: 'MM', category: 'Humanitarian' }),
    ],
    ...overrides,
  };
  return {
    version: BRIEF_ENVELOPE_VERSION,
    issuedAt: 1_700_000_000_000,
    data,
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** @param {string} html */
function pageCount(html) {
  const matches = html.match(/<section class="page/g);
  return matches ? matches.length : 0;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('renderBriefMagazine — page sequence', () => {
  it('default case: cover + 4 digest pages + N stories + back cover = N + 6', () => {
    const env = envelope();
    const html = renderBriefMagazine(env);
    assert.equal(pageCount(html), env.data.stories.length + 6);
  });

  it('omits the Signals page when signals is empty', () => {
    const env = envelope({
      digest: {
        ...envelope().data.digest,
        signals: [],
      },
    });
    const html = renderBriefMagazine(env);
    // cover + greeting + numbers + threads + N stories + back = N + 5
    assert.equal(pageCount(html), env.data.stories.length + 5);
    assert.ok(!html.includes('Digest / 04'), 'Signals page label should not appear');
    assert.ok(!html.includes('Signals To Watch'), 'Signals heading should not appear');
  });

  it('splits On The Desk into 03a + 03b when threads.length > 6', () => {
    const manyThreads = Array.from({ length: 8 }, (_, i) =>
      thread(`Tag${i}`, `Teaser number ${i}.`),
    );
    const env = envelope({
      digest: { ...envelope().data.digest, threads: manyThreads },
    });
    const html = renderBriefMagazine(env);
    assert.ok(html.includes('Digest / 03a'), 'must emit 03a label');
    assert.ok(html.includes('Digest / 03b'), 'must emit 03b label');
    assert.ok(!html.includes('Digest / 03 \u2014 On The Desk'), 'must not emit the single-page label');
    // cover + greeting + numbers + 03a + 03b + signals + N stories + back = N + 7
    assert.equal(pageCount(html), env.data.stories.length + 7);
  });

  it('splits On The Desk even when signals is empty (still two threads pages)', () => {
    const manyThreads = Array.from({ length: 10 }, (_, i) =>
      thread(`Tag${i}`, `Teaser ${i}.`),
    );
    const env = envelope({
      digest: { ...envelope().data.digest, threads: manyThreads, signals: [] },
    });
    const html = renderBriefMagazine(env);
    // cover + greeting + numbers + 03a + 03b + N stories + back = N + 6
    assert.equal(pageCount(html), env.data.stories.length + 6);
    assert.ok(html.includes('03a'));
    assert.ok(html.includes('03b'));
  });

  it('alternates story palette starting with light', () => {
    const env = envelope();
    const html = renderBriefMagazine(env);
    const storyMatches = [...html.matchAll(/<section class="page story (light|dark)"/g)];
    assert.equal(storyMatches.length, env.data.stories.length);
    storyMatches.forEach((m, i) => {
      const expected = i % 2 === 0 ? 'light' : 'dark';
      assert.equal(m[1], expected, `story ${i + 1} palette`);
    });
  });

  it('zero-pads the surfaced stat and story rank numbers', () => {
    const env = envelope({
      digest: { ...envelope().data.digest, numbers: { clusters: 5, multiSource: 2, surfaced: 4 } },
    });
    const html = renderBriefMagazine(env);
    assert.ok(html.includes('<div class="stat-num">04</div>'));
    assert.ok(html.includes('<div class="rank-ghost">01</div>'));
    assert.ok(html.includes('<div class="rank-ghost">04</div>'));
  });
});

describe('renderBriefMagazine — chrome invariants', () => {
  it('logo symbol is emitted exactly once; all placements reference it via <use>', () => {
    const env = envelope();
    const html = renderBriefMagazine(env);
    const symbolDefs = html.match(/<symbol id="wm-logo-core"/g) || [];
    assert.equal(symbolDefs.length, 1, 'exactly one symbol definition');

    // 1 cover + 4 digest pages + N story chromes + 1 back cover = N + 6 logo references
    const useRefs = html.match(/<use href="#wm-logo-core"\s*\/>/g) || [];
    const expected = 1 + 4 + env.data.stories.length + 1;
    assert.equal(useRefs.length, expected);

    // Every reference still carries the aria label for a11y.
    const ariaLabels = html.match(/aria-label="WorldMonitor"/g) || [];
    assert.equal(ariaLabels.length, expected);
  });

  it('every page is full-bleed (100vw / 100vh declared in the shared stylesheet)', () => {
    const html = renderBriefMagazine(envelope());
    assert.ok(/\.page\s*\{[^}]*flex:\s*0\s*0\s*100vw/.test(html));
    assert.ok(/\.page\s*\{[^}]*height:\s*100vh/.test(html));
  });

  it('emits the dot-navigation container and digest-index dataset', () => {
    const html = renderBriefMagazine(envelope());
    assert.ok(html.includes('id="navDots"'));
    const m = html.match(/data-digest-indexes='(\[[^']+\])'/);
    assert.ok(m, 'deck must expose digest indexes to nav script');
    const arr = JSON.parse(m[1]);
    assert.ok(Array.isArray(arr));
    assert.equal(arr.length, 4, 'default envelope has 4 digest pages');
    assert.ok(arr.every((n) => typeof n === 'number'), 'digest indexes are numbers only');
  });

  it('each story page has a three-tag row (category, country, threat level)', () => {
    const env = envelope();
    const html = renderBriefMagazine(env);
    const tagRows = html.match(/<div class="tag-row">([\s\S]*?)<\/div>\s*<h3/g) || [];
    assert.equal(tagRows.length, env.data.stories.length);
    for (const row of tagRows) {
      const tags = row.match(/<span class="tag[^"]*">/g) || [];
      assert.equal(tags.length, 3, `expected 3 tags, got ${tags.length} in ${row}`);
    }
  });

  it('page numbers are 1-indexed and count up to the total', () => {
    const env = envelope();
    const html = renderBriefMagazine(env);
    const total = pageCount(html);
    const nums = [...html.matchAll(/<div class="page-number mono">(\d{2}) \/ (\d{2})<\/div>/g)];
    assert.equal(nums.length, total);
    nums.forEach((m, i) => {
      assert.equal(Number(m[1]), i + 1);
      assert.equal(Number(m[2]), total);
    });
  });

  it('applies .crit highlight to critical and high threat levels only', () => {
    const env = envelope({
      stories: [
        story({ threatLevel: 'critical' }),
        story({ threatLevel: 'high' }),
        story({ threatLevel: 'medium' }),
        story({ threatLevel: 'low' }),
      ],
    });
    const html = renderBriefMagazine(env);
    // "Critical" and "High" tags get the .crit class; "Medium" and "Low" do not.
    assert.ok(html.includes('<span class="tag crit">Critical</span>'));
    assert.ok(html.includes('<span class="tag crit">High</span>'));
    assert.ok(html.includes('<span class="tag">Medium</span>'));
    assert.ok(html.includes('<span class="tag">Low</span>'));
  });
});

describe('renderBriefMagazine — envelope internals never leak into HTML', () => {
  // Structural invariant: the renderer only reads `envelope.data.*`.
  // We verify this two ways: (1) field-name tokens that only appear in
  // upstream seed data (importanceScore, etc.) never leak; (2) sentinel
  // values injected into non-data envelope locations are absent from
  // the output.

  it('does not emit upstream seed field-name tokens as JSON keys or bare names', () => {
    const env = envelope();
    const html = renderBriefMagazine(env);
    // Field-name tokens — these are structural keys that would only
    // appear if the renderer accidentally interpolated an envelope
    // object (e.g. JSON.stringify(envelope)). Free-text content
    // cannot plausibly emit `"importanceScore":` or `_seed`.
    const forbiddenKeys = [
      '"importanceScore"',
      '"primaryLink"',
      '"pubDate"',
      '"generatedAt"',
      '"briefModel"',
      '"briefProvider"',
      '"fetchedAt"',
      '"recordCount"',
      '"_seed"',
    ];
    for (const token of forbiddenKeys) {
      assert.ok(!html.includes(token), `forbidden token ${token} appeared in HTML`);
    }
  });

  it('validator rejects extension fields on envelope root (importanceScore, _seed, etc.)', () => {
    // Stricter than "renderer does not interpolate them". Forbidden
    // fields must be impossible to PERSIST in the envelope at all —
    // the renderer runs after they are already written to Redis, so
    // the only place the invariant can live is the validator at
    // write + read time.
    const env = /** @type {any} */ ({
      ...envelope(),
      importanceScore: 999,
      primaryLink: 'https://example.com',
      pubDate: 123,
      _seed: { version: 1, fetchedAt: 0 },
    });
    assert.throws(() => renderBriefMagazine(env), /envelope has unexpected key/);
  });

  it('HTML-escapes user-provided content (no raw angle brackets from stories)', () => {
    const env = envelope({
      stories: [
        story({
          headline: 'Something with <script>alert(1)</script> in it',
          whyMatters: 'Why matters with <img src=x> attempt',
        }),
        ...envelope().data.stories.slice(1),
      ],
    });
    const html = renderBriefMagazine(env);
    assert.ok(!html.includes('<script>alert(1)</script>'));
    assert.ok(!html.includes('<img src=x>'));
    assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  });
});

describe('renderBriefMagazine — envelope validation', () => {
  it('throws when envelope is not an object', () => {
    assert.throws(() => renderBriefMagazine(/** @type {any} */ (null)), /must be an object/);
    assert.throws(() => renderBriefMagazine(/** @type {any} */ ('string')), /must be an object/);
  });

  it('throws when version is outside the supported set', () => {
    const env = /** @type {any} */ ({ ...envelope(), version: 99 });
    assert.throws(
      () => renderBriefMagazine(env),
      /is not in supported set/,
    );
  });

  it('throws when issuedAt is missing or non-finite', () => {
    const env = /** @type {any} */ ({ ...envelope() });
    delete env.issuedAt;
    assert.throws(() => renderBriefMagazine(env), /issuedAt/);
  });

  it('throws when envelope.data is missing', () => {
    const env = /** @type {any} */ ({ version: BRIEF_ENVELOPE_VERSION, issuedAt: 0 });
    assert.throws(() => renderBriefMagazine(env), /envelope\.data is required/);
  });

  it('throws when envelope.data.date is not YYYY-MM-DD', () => {
    const env = envelope();
    env.data.date = '04/17/2026';
    assert.throws(() => renderBriefMagazine(env), /YYYY-MM-DD/);
  });

  it('throws when digest.signals is missing', () => {
    const env = /** @type {any} */ (envelope());
    delete env.data.digest.signals;
    assert.throws(() => renderBriefMagazine(env), /digest\.signals must be an array/);
  });

  it('throws when digest.threads is missing', () => {
    const env = /** @type {any} */ (envelope());
    delete env.data.digest.threads;
    assert.throws(() => renderBriefMagazine(env), /digest\.threads must be an array/);
  });

  it('throws when digest.numbers.clusters is missing', () => {
    const env = /** @type {any} */ (envelope());
    delete env.data.digest.numbers.clusters;
    assert.throws(() => renderBriefMagazine(env), /digest\.numbers\.clusters/);
  });

  it('throws when a story has an invalid threatLevel', () => {
    const env = envelope();
    /** @type {any} */ (env.data.stories[0]).threatLevel = 'moderate';
    assert.throws(
      () => renderBriefMagazine(env),
      /threatLevel must be one of critical\|high\|medium\|low/,
    );
  });

  it('throws when stories is empty', () => {
    const env = envelope({ stories: [] });
    assert.throws(() => renderBriefMagazine(env), /stories must be a non-empty array/);
  });

  it('throws when a story carries an extension field (importanceScore, etc.)', () => {
    const env = envelope();
    /** @type {any} */ (env.data.stories[0]).importanceScore = 999;
    assert.throws(
      () => renderBriefMagazine(env),
      /envelope\.data\.stories\[0\] has unexpected key "importanceScore"/,
    );
  });

  it('throws when envelope.data carries an extra key', () => {
    const env = /** @type {any} */ (envelope());
    env.data.primaryLink = 'https://leak.example/story';
    assert.throws(
      () => renderBriefMagazine(env),
      /envelope\.data has unexpected key "primaryLink"/,
    );
  });

  it('throws when digest.numbers carries an extra key', () => {
    const env = /** @type {any} */ (envelope());
    env.data.digest.numbers.fetchedAt = Date.now();
    assert.throws(
      () => renderBriefMagazine(env),
      /envelope\.data\.digest\.numbers has unexpected key "fetchedAt"/,
    );
  });

  it('throws when digest.numbers.surfaced does not equal stories.length', () => {
    // Cover copy ("N threads that shaped the world today") and the
    // at-a-glance stat both surface this count; the validator must
    // keep them in lockstep so no brief can ship a self-contradictory
    // number.
    const env = envelope();
    env.data.digest.numbers.surfaced = 99;
    assert.throws(
      () => renderBriefMagazine(env),
      /surfaced=99 must equal.*stories\.length=4/,
    );
  });
});

describe('BRIEF_ENVELOPE_VERSION', () => {
  it('is the literal 2 (bump requires cross-producer coordination)', () => {
    assert.equal(BRIEF_ENVELOPE_VERSION, 2);
  });
});

describe('renderBriefMagazine — v1 envelopes (back-compat window)', () => {
  /**
   * Build a v1-shaped envelope: version=1 and stories carry no
   * sourceUrl. Emulates what's still resident in Redis under the 7-day
   * TTL at the moment the v2 renderer deploys — the renderer must
   * degrade gracefully instead of 404ing the still-live link.
   */
  function v1Envelope() {
    const v2 = envelope();
    const stories = v2.data.stories.map(({ sourceUrl: _ignore, ...rest }) => rest);
    return /** @type {any} */ ({ ...v2, version: 1, data: { ...v2.data, stories } });
  }

  it('accepts version=1 without sourceUrl and renders plain source line (no anchor)', () => {
    const env = v1Envelope();
    const html = renderBriefMagazine(env);
    // No source-link anchors at all — v1 degrades to plain text.
    assert.equal((html.match(/<a class="source-link"/g) ?? []).length, 0);
    // The source label itself is still emitted for every story.
    const labelCount = (html.match(/<div class="source">Source · /g) ?? []).length;
    assert.equal(labelCount, env.data.stories.length);
  });

  it('still validates every v1 story field except sourceUrl', () => {
    const env = v1Envelope();
    env.data.stories[0].headline = '';
    assert.throws(
      () => renderBriefMagazine(env),
      /envelope\.data\.stories\[0\]\.headline must be a non-empty string/,
    );
  });

  it('does not accept v1 with a malformed sourceUrl (defence-in-depth)', () => {
    const env = v1Envelope();
    env.data.stories[0].sourceUrl = 'javascript:alert(1)';
    assert.throws(
      () => renderBriefMagazine(env),
      /sourceUrl .* is not allowed \(http\/https only\)/,
    );
  });
});

describe('renderBriefMagazine — source link (v2)', () => {
  it('wraps every story source in an outgoing anchor with UTM params', () => {
    const env = envelope();
    const html = renderBriefMagazine(env);
    // N stories → N source anchors.
    const anchorCount = (html.match(/<a class="source-link"/g) ?? []).length;
    assert.equal(anchorCount, env.data.stories.length);
    // target=_blank + rel=noopener noreferrer are both present on each
    // anchor. We match the literal attribute string the renderer emits.
    assert.ok(html.includes('target="_blank" rel="noopener noreferrer"'));
    // UTM params on every tracked href — check by presence of the
    // four params at least once, plus the issueDate as utm_campaign.
    assert.ok(html.includes('utm_source=worldmonitor'));
    assert.ok(html.includes('utm_medium=brief'));
    assert.ok(html.includes(`utm_campaign=${env.data.date}`));
    assert.ok(html.includes('utm_content=story-01'));
    assert.ok(html.includes('utm_content=story-02'));
  });

  it('escapes ampersands inside source URL query strings', () => {
    // A real URL with multiple query params contains raw "&" characters
    // that MUST be escaped to "&amp;" when interpolated into an href
    // attribute — otherwise the HTML parser can terminate the href
    // early on certain entity-like sequences (e.g. &copy=...).
    const env = envelope({
      stories: [
        story({ sourceUrl: 'https://example.com/path?a=1&copy=2&b=3' }),
        ...envelope().data.stories.slice(1),
      ],
    });
    const html = renderBriefMagazine(env);
    // The emitted href must contain escaped ampersands.
    assert.ok(html.includes('?a=1&amp;copy=2&amp;b=3'), 'href ampersands must be escaped');
    // Raw ampersand sequences (without the &amp;) must NOT appear in
    // the emitted href for this story.
    assert.ok(!/href="[^"]*?a=1&copy=/.test(html), 'raw ampersand leaked into href');
  });

  it('preserves pre-existing UTM tags on the upstream URL', () => {
    const env = envelope({
      stories: [
        story({ sourceUrl: 'https://example.com/path?utm_source=publisher&utm_campaign=oem' }),
        ...envelope().data.stories.slice(1),
      ],
    });
    const html = renderBriefMagazine(env);
    assert.ok(html.includes('utm_source=publisher'), 'publisher utm_source kept');
    assert.ok(html.includes('utm_campaign=oem'), 'publisher utm_campaign kept');
    // Ours still appended for the fields the publisher didn't set.
    assert.ok(html.includes('utm_medium=brief'));
  });

  it('throws when sourceUrl is missing', () => {
    const env = envelope();
    /** @type {any} */ (env.data.stories[0]).sourceUrl = '';
    assert.throws(
      () => renderBriefMagazine(env),
      /envelope\.data\.stories\[0\]\.sourceUrl must be a non-empty string/,
    );
  });

  it('throws when sourceUrl is not a parseable URL', () => {
    const env = envelope();
    /** @type {any} */ (env.data.stories[0]).sourceUrl = 'not a url';
    assert.throws(
      () => renderBriefMagazine(env),
      /sourceUrl must be a parseable absolute URL/,
    );
  });

  it('throws when sourceUrl uses a disallowed scheme', () => {
    const env = envelope();
    /** @type {any} */ (env.data.stories[0]).sourceUrl = 'javascript:alert(1)';
    assert.throws(
      () => renderBriefMagazine(env),
      /sourceUrl .* is not allowed \(http\/https only\)/,
    );
  });

  it('throws when sourceUrl carries userinfo credentials', () => {
    const env = envelope();
    /** @type {any} */ (env.data.stories[0]).sourceUrl = 'https://user:pass@example.com/x';
    assert.throws(
      () => renderBriefMagazine(env),
      /sourceUrl must not include userinfo credentials/,
    );
  });
});
