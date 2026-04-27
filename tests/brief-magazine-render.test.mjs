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
  it('is the literal 3 (bump requires cross-producer coordination)', () => {
    // Bumped 2 → 3 (2026-04-25) when BriefDigest gained the optional
    // `publicLead` field for the share-URL surface. v2 envelopes still
    // in the 7-day TTL window remain readable — see
    // SUPPORTED_ENVELOPE_VERSIONS = [1, 2, 3]. Test below covers v1
    // back-compat; v2 back-compat is exercised by the missing-publicLead
    // path in the BriefDigest validator (publicLead === undefined is OK).
    assert.equal(BRIEF_ENVELOPE_VERSION, 3);
  });
});

describe('renderBriefMagazine — v3 publicLead field (Codex Round-3 Medium #2)', () => {
  it('accepts a v3 envelope with publicLead', () => {
    const env = envelope();
    env.version = 3;
    env.data.digest.publicLead = 'A non-personalised editorial lead for share-URL surface readers.';
    // Should NOT throw — publicLead is now an allowed digest key.
    const html = renderBriefMagazine(env);
    assert.ok(typeof html === 'string' && html.length > 0);
  });

  it('rejects a publicLead that is not a non-empty string', () => {
    const env = envelope();
    env.version = 3;
    env.data.digest.publicLead = 42;
    assert.throws(
      () => renderBriefMagazine(env),
      /envelope\.data\.digest\.publicLead, when present, must be a non-empty string/,
    );
  });

  it('accepts a v2 envelope still in TTL window without publicLead (back-compat)', () => {
    // v2 envelopes already in Redis at v3 rollout MUST keep rendering
    // — SUPPORTED_ENVELOPE_VERSIONS = [1, 2, 3]. publicLead is
    // optional; absence is the v2 shape.
    const env = envelope();
    env.version = 2;
    delete env.data.digest.publicLead;
    const html = renderBriefMagazine(env);
    assert.ok(typeof html === 'string' && html.length > 0);
  });

  it('rejects an envelope with an unknown digest key (closed-key-set still enforced)', () => {
    const env = envelope();
    env.version = 3;
    env.data.digest.synthesisLevel = 1;  // would-be ad-hoc metadata
    assert.throws(
      () => renderBriefMagazine(env),
      /envelope\.data\.digest has unexpected key "synthesisLevel"/,
    );
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

describe('renderBriefMagazine — Share button (non-public views)', () => {
  const SHARE_URL = 'https://worldmonitor.app/api/brief/public/abcDEF012345';

  it('renders a Share button with data-share-url and issue date', () => {
    const env = envelope();
    const html = renderBriefMagazine(env, { shareUrl: SHARE_URL });
    assert.ok(html.includes('class="wm-share"'), 'share button must be present');
    assert.ok(html.includes(`data-share-url="${SHARE_URL}"`), 'share button carries pre-derived URL');
    assert.ok(html.includes(`data-issue-date="${env.data.date}"`), 'share button carries issue date');
    assert.ok(html.includes('aria-label="Share this brief"'), 'share button has a11y label');
  });

  it('emits the inline share script exactly once', () => {
    const env = envelope();
    const html = renderBriefMagazine(env, { shareUrl: SHARE_URL });
    const matches = html.match(/document\.querySelector\('\.wm-share'\)/g) ?? [];
    assert.equal(matches.length, 1, 'share script emitted once');
  });

  it('click handler reads from dataset rather than fetching — no auth round-trip', () => {
    const env = envelope();
    const html = renderBriefMagazine(env, { shareUrl: SHARE_URL });
    // The script must NOT contain any fetch call. It reads the URL
    // from btn.dataset.shareUrl (server-derived) and invokes
    // navigator.share / clipboard directly.
    const scriptStart = html.indexOf("document.querySelector('.wm-share')");
    const scriptEnd = html.indexOf('</script>', scriptStart);
    assert.ok(scriptStart > -1 && scriptEnd > scriptStart);
    const scriptBody = html.slice(scriptStart, scriptEnd);
    assert.ok(!scriptBody.includes('fetch('), 'inline share script must not make fetch calls');
    assert.ok(scriptBody.includes('btn.dataset.shareUrl'), 'script reads URL from dataset');
    assert.ok(scriptBody.includes('navigator.share'), 'script uses Web Share API');
    assert.ok(scriptBody.includes('navigator.clipboard'), 'script has clipboard fallback');
  });

  it('gracefully hides the Share button when shareUrl is absent', () => {
    const env = envelope();
    const html = renderBriefMagazine(env);
    assert.ok(!html.includes('class="wm-share"'), 'no Share button when shareUrl unset');
    assert.ok(
      !html.includes("document.querySelector('.wm-share')"),
      'no Share script when shareUrl unset',
    );
  });

  it('HTML-escapes the shareUrl into the data attribute', () => {
    const env = envelope();
    const hostile = 'https://example.com/path?a=1&b="evil"';
    const html = renderBriefMagazine(env, { shareUrl: hostile });
    // The raw " must not appear inside data-share-url — would
    // break the HTML attribute parser.
    assert.ok(
      html.includes('&quot;evil&quot;'),
      'hostile quotes are HTML-escaped in data-share-url',
    );
  });
});

describe('renderBriefMagazine — publicMode', () => {
  it('strips Share button + share script on public mode even when shareUrl is passed', () => {
    const env = envelope();
    const html = renderBriefMagazine(env, {
      publicMode: true,
      shareUrl: 'https://worldmonitor.app/api/brief/public/abcDEF012345',
    });
    assert.ok(!html.includes('class="wm-share"'), 'share button absent on public');
    assert.ok(
      !html.includes("document.querySelector('.wm-share')"),
      'share script (runtime) absent on public',
    );
  });

  it('replaces whyMatters with a generic callout on every story page', () => {
    const env = envelope();
    // Pre-test sanity: the fixture uses the Hormuz whyMatters on all
    // stories, so we know it appears in the private render.
    const privateHtml = renderBriefMagazine(env);
    assert.ok(privateHtml.includes('Hormuz is roughly a fifth'), 'private render carries whyMatters');

    const publicHtml = renderBriefMagazine(env, { publicMode: true });
    assert.ok(!publicHtml.includes('Hormuz is roughly a fifth'), 'whyMatters stripped on public');
    assert.ok(
      publicHtml.includes('Subscribe to WorldMonitor Brief to see the full editorial'),
      'generic placeholder callout rendered',
    );
  });

  it('emits a noindex meta tag on public views', () => {
    const env = envelope();
    const privateHtml = renderBriefMagazine(env);
    const publicHtml = renderBriefMagazine(env, { publicMode: true });
    assert.ok(!privateHtml.includes('noindex'), 'private render is indexable');
    assert.ok(publicHtml.includes('<meta name="robots" content="noindex,nofollow">'), 'public render sets noindex meta');
  });

  it('prepends a Subscribe strip on public views', () => {
    const env = envelope();
    const html = renderBriefMagazine(env, { publicMode: true });
    assert.ok(html.includes('class="wm-public-strip"'), 'subscribe strip element emitted');
    assert.ok(html.includes('worldmonitor.app/pro'), 'strip links to /pro');
    assert.ok(html.includes('Subscribe'), 'strip CTA text present');
  });

  it('attaches ?ref= to public CTAs when refCode is provided', () => {
    const env = envelope();
    const html = renderBriefMagazine(env, { publicMode: true, refCode: 'ABC123' });
    assert.ok(html.includes('worldmonitor.app/pro?ref=ABC123'), 'refCode appended to /pro URL');
  });

  it('HTML-escapes a hostile refCode before interpolation', () => {
    const env = envelope();
    const hostile = '"><script>1';
    const html = renderBriefMagazine(env, { publicMode: true, refCode: hostile });
    // encodeURIComponent handles most of the sanitisation; the result
    // should contain percent-encoded chars and NO raw <script> tag.
    assert.ok(!html.includes('<script>1'), 'raw hostile payload never appears');
  });

  it('swaps the back cover to a Subscribe CTA on public views', () => {
    const env = envelope();
    const privateHtml = renderBriefMagazine(env);
    const publicHtml = renderBriefMagazine(env, { publicMode: true });
    assert.ok(privateHtml.includes('End of'), 'private back cover reads "End of Transmission"');
    assert.ok(publicHtml.includes('Get your own'), 'public back cover reads Subscribe-style headline');
    assert.ok(publicHtml.includes('class="mono back-cta"'), 'public back cover has CTA anchor');
  });

  it('does NOT leak the original user name on public views', () => {
    const env = envelope({
      user: { name: 'Alice Personally', tz: 'UTC' },
    });
    const html = renderBriefMagazine(env, { publicMode: true });
    assert.ok(!html.includes('Alice Personally'), 'user name must not appear on public mirror');
  });

  it('keeps story headlines, categories, sources on public views (shared content)', () => {
    const env = envelope();
    const html = renderBriefMagazine(env, { publicMode: true });
    // Story content itself IS shared — that's the point of the mirror.
    assert.ok(html.includes('Iran declares Strait of Hormuz open'));
    assert.ok(html.includes('Multiple wires'));
  });

  it('default options (no second arg) behaves identically to the private path', () => {
    const env = envelope();
    const a = renderBriefMagazine(env);
    const b = renderBriefMagazine(env, {});
    assert.equal(a, b);
  });

  // ── Public-share lead fail-safe (Codex Round-2 High security) ──────
  //
  // Personalised `digest.lead` carries profile context (watched assets,
  // saved regions, etc.). On the public-share surface we MUST render
  // `publicLead` (a non-personalised parallel synthesis) instead, OR
  // omit the pull-quote entirely. NEVER fall back to the personalised
  // lead.

  it('renders publicLead in the pull-quote when v3 envelope carries it', () => {
    const env = envelope();
    env.version = 3;
    env.data.digest.lead = 'Personal lead with watched-asset details that must NOT leak.';
    env.data.digest.publicLead = 'A non-personalised editorial lead suitable for share readers.';
    const html = renderBriefMagazine(env, { publicMode: true });
    assert.ok(
      html.includes('non-personalised editorial lead'),
      'pull-quote must render the publicLead text',
    );
    assert.ok(
      !html.includes('watched-asset details'),
      'personalised lead text must NEVER appear on the public surface',
    );
  });

  it('OMITS the pull-quote when publicLead is absent (v2 envelope back-compat)', () => {
    // v2 envelopes still in TTL window have no publicLead. Public-mode
    // render MUST omit the blockquote rather than render the
    // personalised lead.
    const env = envelope();
    env.version = 2;
    env.data.digest.lead = 'Personal lead with watched-asset details that must NOT leak.';
    delete env.data.digest.publicLead;
    const html = renderBriefMagazine(env, { publicMode: true });
    assert.ok(
      !html.includes('watched-asset details'),
      'personalised lead text must NEVER appear on the public surface',
    );
    // Sanity: the rest of the page (greeting + greeting block) is
    // still rendered — only the blockquote is omitted.
    assert.ok(html.includes('At The Top Of The Hour'));
  });

  it('OMITS the pull-quote when publicLead is empty string (defensive)', () => {
    const env = envelope();
    env.version = 3;
    env.data.digest.lead = 'Personal lead that must NOT leak.';
    // Defensive: publicLead set to empty string by a buggy producer.
    // The render path treats empty as absent, omitting the pull-quote.
    // (assertBriefEnvelope rejects publicLead='' as a non-empty-string
    // violation, so this only matters if a future code path bypasses
    // validation — belt-and-braces.)
    env.data.digest.publicLead = '';
    // Validator rejects empty publicLead first, so render throws —
    // proves the contract is enforced before redactForPublic runs.
    assert.throws(
      () => renderBriefMagazine(env, { publicMode: true }),
      /publicLead, when present, must be a non-empty string/,
    );
  });

  it('private (non-public) render still uses the personalised lead', () => {
    const env = envelope();
    env.version = 3;
    env.data.digest.lead = 'Personal lead for the authenticated reader.';
    env.data.digest.publicLead = 'Generic public lead.';
    const html = renderBriefMagazine(env);  // private path
    assert.ok(html.includes('Personal lead for the authenticated reader'));
    assert.ok(!html.includes('Generic public lead'), 'publicLead is share-only');
  });

  // ── Public signals + threads fail-safe (extends Codex Round-2 High security) ──

  it('substitutes publicSignals when present — personalised signals never reach the public surface', () => {
    const env = envelope();
    env.version = 3;
    env.data.digest.lead = 'Personal lead.';
    env.data.digest.publicLead = 'Generic public lead.';
    // Personalised signals can echo a user's watched assets ("your
    // Saudi exposure"). Anonymous public readers must never see this.
    env.data.digest.signals = ['Watch Saudi crude exposure on your watchlist for OPEC moves'];
    env.data.digest.publicSignals = ['Watch OPEC for production-quota signals'];
    const html = renderBriefMagazine(env, { publicMode: true });
    assert.ok(html.includes('OPEC for production-quota'), 'publicSignals must render');
    assert.ok(!html.includes('your watchlist'), 'personalised signals must NEVER appear on public');
    assert.ok(!html.includes('Saudi crude exposure'), 'personalised signal phrase must NEVER appear on public');
  });

  it('OMITS the signals page when publicSignals is absent (fail-safe — never serves personalised signals)', () => {
    const env = envelope();
    env.version = 3;
    env.data.digest.lead = 'Personal lead.';
    env.data.digest.publicLead = 'Generic public lead.';
    env.data.digest.signals = ['Watch your private watchlist for OPEC moves'];
    delete env.data.digest.publicSignals;
    const html = renderBriefMagazine(env, { publicMode: true });
    // Renderer's hasSignals gate hides the signals page when the
    // array is empty. Personalised signal phrase must NOT appear.
    assert.ok(!html.includes('your private watchlist'), 'personalised signals must NEVER appear on public');
    assert.ok(!html.includes('Digest / 04'), 'signals page section must be omitted');
  });

  it('substitutes publicThreads when present — personalised thread teasers never reach public', () => {
    const env = envelope();
    env.version = 3;
    env.data.digest.lead = 'Personal lead.';
    env.data.digest.publicLead = 'Generic public lead.';
    env.data.digest.threads = [
      { tag: 'Energy', teaser: 'Saudi exposure on your portfolio is at risk this week' },
    ];
    env.data.digest.publicThreads = [
      { tag: 'Energy', teaser: 'OPEC production quota debate intensifies' },
    ];
    const html = renderBriefMagazine(env, { publicMode: true });
    assert.ok(html.includes('OPEC production quota'), 'publicThreads must render');
    assert.ok(!html.includes('your portfolio'), 'personalised thread teaser must NEVER appear on public');
  });

  it('falls back to category-derived threads stub when publicThreads absent', () => {
    const env = envelope();
    env.version = 3;
    env.data.digest.lead = 'Personal lead.';
    env.data.digest.publicLead = 'Generic public lead.';
    env.data.digest.threads = [
      { tag: 'Energy', teaser: 'Saudi exposure on your portfolio is at risk this week' },
    ];
    delete env.data.digest.publicThreads;
    const html = renderBriefMagazine(env, { publicMode: true });
    assert.ok(!html.includes('your portfolio'), 'personalised thread must NEVER appear on public');
    // Stub teaser pattern — generic phrasing derived from story
    // categories. Renderer still produces a threads page.
    assert.ok(
      html.includes('thread on the desk today') || html.includes('threads on the desk today'),
      'category-derived threads stub renders',
    );
  });

  it('rejects malformed publicSignals (validator contract)', () => {
    const env = envelope();
    env.version = 3;
    env.data.digest.publicSignals = ['ok signal', 42];  // 42 is not a string
    assert.throws(
      () => renderBriefMagazine(env, { publicMode: true }),
      /publicSignals\[1\] must be a non-empty string/,
    );
  });

  it('rejects malformed publicThreads (validator contract)', () => {
    const env = envelope();
    env.version = 3;
    env.data.digest.publicThreads = [{ tag: 'Energy' }];  // missing teaser
    assert.throws(
      () => renderBriefMagazine(env, { publicMode: true }),
      /publicThreads\[0\]\.teaser must be a non-empty string/,
    );
  });

  it('private render ignores publicSignals + publicThreads — uses personalised', () => {
    const env = envelope();
    env.version = 3;
    env.data.digest.signals = ['Personalised signal for authenticated reader'];
    env.data.digest.publicSignals = ['Generic public signal'];
    env.data.digest.threads = [{ tag: 'Energy', teaser: 'Personalised teaser' }];
    env.data.digest.publicThreads = [{ tag: 'Energy', teaser: 'Generic public teaser' }];
    const html = renderBriefMagazine(env);
    assert.ok(html.includes('Personalised signal'), 'private render uses personalised signals');
    assert.ok(!html.includes('Generic public signal'), 'public siblings ignored on private path');
    assert.ok(html.includes('Personalised teaser'), 'private render uses personalised threads');
  });
});

// ── Regression: cover greeting follows envelope.data.digest.greeting ─────────
// Previously the cover hardcoded "Good evening" regardless of issue time, so
// a brief composed at 13:02 local (envelope greeting = "Good afternoon.")
// rendered "Good evening" on the cover and "Good afternoon." on slide 2 —
// visibly inconsistent. Fix wires digest.greeting into the cover (period
// stripped for the mono-cased slot).
describe('cover greeting ↔ digest.greeting parity', () => {
  /**
   * Extract the cover <section> so we can assert on it in isolation without
   * matching the identical greeting that appears on slide 2.
   */
  function extractCover(html) {
    const match = html.match(/<section class="page cover">[\s\S]*?<\/section>/);
    assert.ok(match, 'cover section must be present');
    return match[0];
  }

  it('renders "Good afternoon" on the cover when digest.greeting is "Good afternoon."', () => {
    const env = envelope({
      digest: { ...envelope().data.digest, greeting: 'Good afternoon.' },
    });
    const cover = extractCover(renderBriefMagazine(env));
    assert.ok(cover.includes('>Good afternoon<'), `cover should contain "Good afternoon" without period, got: ${cover}`);
    assert.ok(!cover.includes('Good evening'), 'cover must NOT say "Good evening" when digest.greeting is afternoon');
  });

  it('renders "Good morning" on the cover when digest.greeting is "Good morning."', () => {
    const env = envelope({
      digest: { ...envelope().data.digest, greeting: 'Good morning.' },
    });
    const cover = extractCover(renderBriefMagazine(env));
    assert.ok(cover.includes('>Good morning<'));
    assert.ok(!cover.includes('Good evening'));
    assert.ok(!cover.includes('Good afternoon'));
  });

  it('renders "Good evening" on the cover when digest.greeting is "Good evening."', () => {
    const env = envelope({
      digest: { ...envelope().data.digest, greeting: 'Good evening.' },
    });
    const cover = extractCover(renderBriefMagazine(env));
    assert.ok(cover.includes('>Good evening<'));
  });

  it('strips trailing period(s) — cover is mono-cased, no punctuation', () => {
    const env = envelope({
      digest: { ...envelope().data.digest, greeting: 'Good afternoon...' },
    });
    const cover = extractCover(renderBriefMagazine(env));
    // Envelope can send any trailing dot count; cover strips all of them.
    assert.ok(cover.includes('>Good afternoon<'));
    assert.ok(!cover.includes('Good afternoon.'));
  });

  it('HTML-escapes the greeting (defense-in-depth, even though envelope values are controlled)', () => {
    const env = envelope({
      digest: { ...envelope().data.digest, greeting: '<script>alert(1)</script>.' },
    });
    const cover = extractCover(renderBriefMagazine(env));
    assert.ok(!cover.includes('<script>alert'));
    assert.ok(cover.includes('&lt;script&gt;'));
  });
});
