// Gmail clips any message whose HTML is over ~102KB and hides the rest
// (footer included) behind "View entire message". These tests render the
// real digest email (cards + editorial synthesis + brief CTA) and measure
// its UTF-8 bytes against DIGEST_EMAIL_MAX_HTML_BYTES.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  DIGEST_EMAIL_MAX_HTML_BYTES,
  GMAIL_CLIP_BYTES,
  formatDigestHtml,
  injectBriefCta,
  renderDigestEmailHtml,
} from '../scripts/lib/digest-email-html.mjs';
import { injectEmailSummary } from '../scripts/lib/email-summary-html.mjs';

const NOW = Date.parse('2026-10-17T03:00:00Z');
const DESCRIPTION = 'Officials said on Friday that the situation along the border had deteriorated '
  + 'sharply overnight, with reports of artillery exchanges near several towns and thousands of '
  + 'residents moving toward shelters in the region now.';
const MAGAZINE_URL = `https://www.worldmonitor.app/brief/user_abc/2026-10-17-0700?t=${'x'.repeat(200)}`;
const SYNTHESIS = {
  lead: `${'Lead paragraph. '.repeat(60)}\n\n${'Second paragraph. '.repeat(35)}`,
  threads: Array.from({ length: 5 }, (_, i) => ({ tag: `Thread ${i}`, teaser: 'Teaser text. '.repeat(17) })),
  signals: Array.from({ length: 4 }, () => 'Signal to watch. '.repeat(10)),
};

function story(severity, i, linkLength = 110) {
  const slug = `some-long-article-slug-about-the-event-number-${i}-`.padEnd(linkLength, 'x');
  return {
    severity,
    phase: i % 3 ? 'developing' : 'breaking',
    title: `${severity} headline ${i}: ministers meet as tensions escalate over disputed maritime boundary`,
    link: `https://www.reuters.com/world/middle-east/${slug}`,
    description: DESCRIPTION,
    sources: ['Reuters', 'AP', 'Al Jazeera', 'BBC'],
  };
}

function pool(critical, high, medium, linkLength) {
  return [
    ...Array.from({ length: critical }, (_, i) => story('critical', i, linkLength)),
    ...Array.from({ length: high }, (_, i) => story('high', i, linkLength)),
    ...Array.from({ length: medium }, (_, i) => story('medium', i, linkLength)),
  ];
}

const bytes = (html) => Buffer.byteLength(html, 'utf8');

function assertWellFormed(html) {
  const opens = (html.match(/<div\b/g) ?? []).length;
  const closes = (html.match(/<\/div>/g) ?? []).length;
  assert.equal(opens, closes, 'every <div> is closed');
  assert.equal((html.match(/<a\b/g) ?? []).length, (html.match(/<\/a>/g) ?? []).length, 'every <a> is closed');
  assert.ok(html.trimEnd().endsWith('</div>'), 'ends on the wrapper close');
  assert.ok(html.includes('github.com/koala73/worldmonitor'), 'footer survives');
}

describe('digest email size cap', () => {
  it('leaves at least 10KB of headroom under the Gmail clip', () => {
    assert.ok(DIGEST_EMAIL_MAX_HTML_BYTES <= GMAIL_CLIP_BYTES - 10_000);
  });

  it('is byte-identical to the uncapped render on a typical day', () => {
    const stories = pool(6, 25, 20);
    const nowMs = new Date(2026, 9, 17, 12).getTime();
    const result = renderDigestEmailHtml({ stories, nowMs, synthesis: SYNTHESIS, magazineUrl: MAGAZINE_URL });
    const legacy = injectBriefCta(injectEmailSummary(formatDigestHtml(stories, nowMs), SYNTHESIS), MAGAZINE_URL);
    assert.equal(result.truncated, false);
    // Captured from the pre-extraction renderer at 2ffd43fd3da1e66e0f37357e9645da773d2436c7.
    assert.equal(createHash('sha256').update(result.html).digest('hex'), '8c4fb966d3ff78833ebc35e6c36358da3a5ccbaf4c7bc602dc57fed96887af38');
    assert.equal(result.html, legacy);
    assert.equal(result.bytes, bytes(legacy));
    assert.equal(result.shownStories, 6 + 15 + 10);
    assert.ok(!result.html.includes('shortened to fit'));
  });

  it('keeps a production-max pool (30 stories, long links) under the cap', () => {
    // buildDigest slices the raw pool to DIGEST_MAX_ITEMS = 30.
    const stories = pool(30, 0, 0, 400);
    const result = renderDigestEmailHtml({ stories, nowMs: NOW, synthesis: SYNTHESIS, magazineUrl: MAGAZINE_URL });
    assert.ok(result.bytes <= DIGEST_EMAIL_MAX_HTML_BYTES, `${result.bytes} bytes`);
    assertWellFormed(result.html);
  });

  it('drops cards and links the full brief when the render would clip', () => {
    const stories = pool(120, 40, 30);
    const uncapped = injectBriefCta(injectEmailSummary(formatDigestHtml(stories, NOW), SYNTHESIS), MAGAZINE_URL);
    assert.ok(bytes(uncapped) > GMAIL_CLIP_BYTES, 'fixture really is over the clip limit');

    const result = renderDigestEmailHtml({ stories, nowMs: NOW, synthesis: SYNTHESIS, magazineUrl: MAGAZINE_URL });
    assert.equal(result.truncated, true);
    assert.equal(result.bytes, bytes(result.html));
    assert.ok(result.bytes <= DIGEST_EMAIL_MAX_HTML_BYTES, `${result.bytes} bytes`);
    assert.ok(result.bytes < GMAIL_CLIP_BYTES);
    assertWellFormed(result.html);

    // Graceful: a notice plus a link to the full brief, and the per-section
    // "... and N more" lines account for every dropped card.
    assert.ok(result.html.includes('This email was shortened to fit your inbox.'));
    assert.ok(result.html.includes('Read the full brief &rarr;'));
    assert.ok(result.html.includes(`href="${MAGAZINE_URL}"`));
    assert.ok(result.html.includes(`... and ${120 - result.shownStories} more`));
    // Criticals fill the budget first, so high and medium are summarised.
    assert.ok(result.html.includes('... and 15 more') || result.html.includes('... and 40 more'));
    assert.ok(result.html.includes('... and 30 more'));
    // The editorial synthesis is kept.
    assert.ok(result.html.includes('Lead paragraph.'));
    // The search found the largest budget that fits: one more card (~1.3KB)
    // would not fit.
    assert.ok(DIGEST_EMAIL_MAX_HTML_BYTES - result.bytes < 3000);
  });

  it('drops medium before high and high before critical', () => {
    const stories = pool(10, 15, 10);
    const full = renderDigestEmailHtml({ stories, nowMs: NOW, maxBytes: Infinity });
    // Leave room for about 18 cards: all 10 critical, part of high, no medium.
    const capped = renderDigestEmailHtml({ stories, nowMs: NOW, maxBytes: full.bytes - 17 * 1100 });
    assert.equal(capped.truncated, true);
    assert.ok(capped.shownStories >= 10 && capped.shownStories < 25, `${capped.shownStories}`);
    assert.ok(capped.html.includes('critical headline 9:'));
    assert.ok(!capped.html.includes('medium headline 0:'));
    assert.ok(capped.html.includes('... and 10 more'), 'all medium cards summarised');
  });

  it('links the dashboard on the compose-miss fallback path (no brief, no synthesis)', () => {
    const stories = pool(120, 0, 0);
    const result = renderDigestEmailHtml({ stories, nowMs: NOW, synthesis: null, magazineUrl: null });
    assert.equal(result.truncated, true);
    assert.ok(result.bytes <= DIGEST_EMAIL_MAX_HTML_BYTES);
    assert.ok(result.html.includes('href="https://worldmonitor.app/dashboard"'));
    assert.ok(result.html.includes('See all 120 stories on the dashboard &rarr;'));
    assertWellFormed(result.html);
  });

  it('drops an oversized editorial block rather than clipping', () => {
    const huge = { lead: 'Very long lead. '.repeat(8000), threads: [], signals: [] };
    const result = renderDigestEmailHtml({ stories: pool(5, 5, 5), nowMs: NOW, synthesis: huge, magazineUrl: MAGAZINE_URL });
    assert.equal(result.truncated, true);
    assert.ok(result.bytes <= DIGEST_EMAIL_MAX_HTML_BYTES);
    assert.ok(!result.html.includes('Very long lead.'));
    // Dropping the synthesis frees enough room for every card.
    assert.equal(result.shownStories, 15);
    assert.ok(!result.html.includes(' more</p>'), 'no card was summarised away');
    assert.ok(result.html.includes('Read the full brief &rarr;'));
    assertWellFormed(result.html);
  });

  it('returns null html for an empty pool, like formatDigestHtml', () => {
    assert.deepEqual(
      renderDigestEmailHtml({ stories: [], nowMs: NOW }),
      { html: null, bytes: 0, truncated: false, shownStories: 0 },
    );
  });
});
