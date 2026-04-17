// Shape tests for the deterministic brief magazine renderer.
//
// The renderer is pure — same envelope in, same HTML out. These tests
// pin down the page-sequence rules that the rest of the pipeline
// (edge route, dashboard panel, email teaser, carousel, Tauri reader)
// depends on. If one of these breaks, every consumer gets confused.
//
// The forbidden-field guard below is belt-and-suspenders protection
// against the regression that caused PR #3143 (importance scores
// leaking into notification payloads). The renderer never reads those
// fields from the typed envelope, but the test re-asserts the
// invariant against the raw HTML string, so a future bug that
// accidentally interpolates envelope internals would surface here.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { renderBriefMagazine } from '../shared/render-brief-magazine.js';
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
    stories: [story(), story({ country: 'IL', category: 'Diplomacy' }), story({ country: 'US', category: 'Maritime' }), story({ country: 'MM', category: 'Humanitarian' })],
    ...overrides,
  };
  return {
    _seed: { version: BRIEF_ENVELOPE_VERSION, fetchedAt: Date.now(), recordCount: data.stories.length },
    data,
  };
}

// ── Page-count helper ────────────────────────────────────────────────────────

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
  it('cover + back cover + each digest running-head embed the WorldMonitor logo', () => {
    const env = envelope();
    const html = renderBriefMagazine(env);
    const logoOccurrences = (html.match(/aria-label="WorldMonitor"/g) || []).length;
    // 1 cover + 4 digest pages + N story chromes + 1 back cover
    const expected = 1 + 4 + env.data.stories.length + 1;
    assert.equal(logoOccurrences, expected);
  });

  it('every page is full-bleed (100vw / 100vh declared in the shared stylesheet)', () => {
    const html = renderBriefMagazine(envelope());
    // Shared declaration — matched once in the style block. The renderer
    // must not produce per-page width overrides.
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
});

describe('renderBriefMagazine — forbidden fields never leak into HTML', () => {
  // Regression guard against the pattern that motivated PR #3143
  // (importanceScore leaking to /api/notify) and the broader rule that
  // the magazine chrome must never print internal signals, AI
  // model/provider names, or cache timestamps to the reader.
  const FORBIDDEN = [
    'importanceScore',
    'primaryLink',
    'pubDate',
    'generatedAt',
    'briefModel',
    'briefProvider',
    'fetchedAt',
    'recordCount',
    '_seed',
    'gemini',
    'claude',
    'openrouter',
    'openai',
  ];

  for (const token of FORBIDDEN) {
    it(`rendered HTML does not contain \`${token}\``, () => {
      const env = envelope();
      const html = renderBriefMagazine(env);
      assert.ok(
        !html.toLowerCase().includes(token.toLowerCase()),
        `forbidden token "${token}" appeared in rendered HTML`,
      );
    });
  }

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
    // The escaped form must appear instead
    assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  });
});

describe('renderBriefMagazine — validation', () => {
  it('throws when envelope.data is missing', () => {
    assert.throws(() => renderBriefMagazine(/** @type {any} */ ({})));
    assert.throws(() => renderBriefMagazine(/** @type {any} */ (null)));
  });

  it('throws when stories is empty', () => {
    assert.throws(() =>
      renderBriefMagazine({
        _seed: { version: BRIEF_ENVELOPE_VERSION, fetchedAt: 0, recordCount: 0 },
        data: { ...envelope().data, stories: [] },
      }),
    );
  });
});

describe('BRIEF_ENVELOPE_VERSION', () => {
  it('is the literal 1 (bump requires cross-producer coordination)', () => {
    assert.equal(BRIEF_ENVELOPE_VERSION, 1);
  });
});
