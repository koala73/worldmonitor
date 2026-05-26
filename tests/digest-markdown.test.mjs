import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  escapeHtml,
  escapeTelegramHtml,
  escapeSlackMrkdwn,
  markdownToEmailHtml,
  markdownToTelegramHtml,
  markdownToSlackMrkdwn,
  markdownToDiscord,
} from '../scripts/_digest-markdown.mjs';

// Representative AI summary that exercises every feature: section headers,
// bullet lists (twice), inline bold, inline italic, paragraph breaks, and
// characters that must be escaped per channel.
const REALISTIC_SUMMARY = `Assessment: Regional escalation in the Levant.

* Israeli strikes killed 25 people in **Lebanon**
* Hezbollah response expected within *48 hours*
* Situation is <unknown> & still developing

Signals to watch:

* IDF troop movements
* Diplomatic cables from Beirut`;

// ── escapeHtml ───────────────────────────────────────────────────────────────

describe('escapeHtml', () => {
  it('escapes &, <, >, "', () => {
    assert.equal(escapeHtml('a & b <c> "d"'), 'a &amp; b &lt;c&gt; &quot;d&quot;');
  });

  it('coerces non-strings', () => {
    assert.equal(escapeHtml(null), 'null');
    assert.equal(escapeHtml(42), '42');
  });
});

// ── Email HTML ───────────────────────────────────────────────────────────────

describe('markdownToEmailHtml', () => {
  it('produces only sibling <p>/<ul> blocks — no mis-nesting', () => {
    const html = markdownToEmailHtml(REALISTIC_SUMMARY);
    // Tempered quantifiers: capture exactly what's between a block and its
    // own closing tag without crossing into adjacent blocks.
    const pBlockRe = /<p[^>]*>((?:(?!<\/p>)[\s\S])*)<\/p>/g;
    const ulBlockRe = /<ul[^>]*>((?:(?!<\/ul>)[\s\S])*)<\/ul>/g;
    for (const [, inside] of html.matchAll(pBlockRe)) {
      assert.doesNotMatch(inside, /<p[\s>]/, '<p> must not contain another <p>');
      assert.doesNotMatch(inside, /<ul[\s>]/, '<p> must not contain a <ul>');
    }
    for (const [, inside] of html.matchAll(ulBlockRe)) {
      assert.doesNotMatch(inside, /<p[\s>]/, '<ul> must not contain a <p>');
    }
    // Opening and closing tags balance 1:1
    const pOpens = (html.match(/<p[\s>]/g) ?? []).length;
    const pCloses = (html.match(/<\/p>/g) ?? []).length;
    const ulOpens = (html.match(/<ul[\s>]/g) ?? []).length;
    const ulCloses = (html.match(/<\/ul>/g) ?? []).length;
    assert.equal(pOpens, pCloses, '<p> opens must equal </p> closes');
    assert.equal(ulOpens, ulCloses, '<ul> opens must equal </ul> closes');
    assert.equal(ulOpens, 2, 'realistic sample should produce exactly 2 lists');
    // Every top-level block should be <p>...</p> or <ul>...</ul>; the
    // concatenation of matched block lengths should equal the whole string.
    const topLevel = /<(p|ul)[^>]*>(?:(?!<\/\1>)[\s\S])*<\/\1>/g;
    const consumed = [...html.matchAll(topLevel)].reduce((n, m) => n + m[0].length, 0);
    assert.equal(consumed, html.length, 'HTML must be a flat sequence of <p>/<ul> blocks');
  });

  it('styles both section headers (Assessment, Signals to watch)', () => {
    const html = markdownToEmailHtml(REALISTIC_SUMMARY);
    const headerColorMatches = html.match(/color:#4ade80/g) ?? [];
    assert.equal(headerColorMatches.length, 2);
    assert.match(html, /Assessment:<\/strong>/);
    assert.match(html, /Signals to watch:<\/strong>/);
  });

  it('renders bold inside a bullet without leaking tags', () => {
    const html = markdownToEmailHtml('* Killed 25 in **Lebanon**');
    assert.match(html, /<li[^>]*>Killed 25 in <strong[^>]*>Lebanon<\/strong><\/li>/);
  });

  it('renders italic inside a bullet', () => {
    const html = markdownToEmailHtml('* within *48 hours*');
    assert.match(html, /<em>48 hours<\/em>/);
  });

  it('escapes HTML-unsafe characters before applying markdown', () => {
    const html = markdownToEmailHtml('* Status: <unknown> & still <script>alert(1)</script>');
    assert.match(html, /&lt;unknown&gt;/);
    assert.match(html, /&amp;/);
    assert.match(html, /&lt;script&gt;/);
    assert.doesNotMatch(html, /<script>/);
  });

  it('treats blank line as block boundary', () => {
    const html = markdownToEmailHtml('line one\n\nline two');
    const pCount = (html.match(/<p[\s>]/g) ?? []).length;
    assert.equal(pCount, 2);
  });

  it('joins consecutive non-blank non-bullet lines with <br/>', () => {
    const html = markdownToEmailHtml('line one\nline two\nline three');
    assert.match(html, /line one<br\/>line two<br\/>line three/);
  });

  it('handles a header-only paragraph', () => {
    const html = markdownToEmailHtml('Signals to watch:');
    assert.match(html, /<p[^>]*><strong[^>]*>Signals to watch:<\/strong>/);
  });

  it('handles lists prefixed with - instead of *', () => {
    const html = markdownToEmailHtml('- item one\n- item two');
    assert.match(html, /<ul[^>]*><li[^>]*>item one<\/li><li[^>]*>item two<\/li><\/ul>/);
  });

  it('returns empty string for empty input', () => {
    assert.equal(markdownToEmailHtml(''), '');
  });
});

// ── Telegram HTML ────────────────────────────────────────────────────────────

describe('escapeTelegramHtml', () => {
  it('escapes only &, <, > (not " or \')', () => {
    assert.equal(escapeTelegramHtml('a & <b> "c" \'d\''), 'a &amp; &lt;b&gt; "c" \'d\'');
  });
});

describe('markdownToTelegramHtml', () => {
  it('converts bold to <b> and italic to <i>', () => {
    const out = markdownToTelegramHtml('This is **bold** and *italic*.');
    assert.equal(out, 'This is <b>bold</b> and <i>italic</i>.');
  });

  it('converts bullets to • char (Telegram HTML has no list tags)', () => {
    const out = markdownToTelegramHtml('* one\n* two\n- three');
    assert.equal(out, '• one\n• two\n• three');
  });

  it('preserves bullet followed by bold marker', () => {
    const out = markdownToTelegramHtml('* **Lebanon** is impacted');
    assert.equal(out, '• <b>Lebanon</b> is impacted');
  });

  it('bolds section headers at line start', () => {
    const out = markdownToTelegramHtml('Assessment: escalating\nbody');
    assert.match(out, /^<b>Assessment:<\/b> escalating/);
  });

  it('escapes &, <, > before inserting tags', () => {
    const out = markdownToTelegramHtml('a <script>alert("xss")</script> & **bold**');
    assert.match(out, /&lt;script&gt;/);
    assert.match(out, /&amp;/);
    assert.match(out, /<b>bold<\/b>/);
    // The injected <b> tag must not itself be escaped
    assert.doesNotMatch(out, /&lt;b&gt;bold/);
  });

  it('does not convert bullets inside a bold span to italics', () => {
    // `**a**` should become `<b>a</b>`; intervening single `*` should not match italic
    const out = markdownToTelegramHtml('prefix **Lebanon** suffix');
    assert.equal(out, 'prefix <b>Lebanon</b> suffix');
  });
});

// ── Slack mrkdwn ─────────────────────────────────────────────────────────────

describe('escapeSlackMrkdwn', () => {
  it('escapes only &, <, >', () => {
    assert.equal(escapeSlackMrkdwn('a & <b> "c"'), 'a &amp; &lt;b&gt; "c"');
  });
});

describe('markdownToSlackMrkdwn', () => {
  it('converts **bold** to Slack single-asterisk *bold*', () => {
    const out = markdownToSlackMrkdwn('the **Lebanon** region');
    assert.equal(out, 'the *Lebanon* region');
  });

  it('converts *italic* to Slack _italic_', () => {
    const out = markdownToSlackMrkdwn('within *48 hours*');
    assert.equal(out, 'within _48 hours_');
  });

  it('handles bold and italic together on one line', () => {
    const out = markdownToSlackMrkdwn('This is **bold** and *italic*.');
    assert.equal(out, 'This is *bold* and _italic_.');
  });

  it('converts bullets to • (Slack has no list primitive)', () => {
    const out = markdownToSlackMrkdwn('* one\n* two\n- three');
    assert.equal(out, '• one\n• two\n• three');
  });

  it('bolds section headers via Slack single-asterisk', () => {
    const out = markdownToSlackMrkdwn('Assessment: escalating\nbody');
    assert.match(out, /^\*Assessment:\* escalating/);
  });

  it('escapes &, <, > before conversion', () => {
    const out = markdownToSlackMrkdwn('<html> & **tag**');
    assert.match(out, /&lt;html&gt;/);
    assert.match(out, /&amp;/);
    assert.match(out, /\*tag\*/);
  });

  it('bold placeholder does not leak \\u0001 into output', () => {
    const out = markdownToSlackMrkdwn('**one** and **two**');
    assert.doesNotMatch(out, /\u0001/);
    assert.equal(out, '*one* and *two*');
  });

  it('bullet then bold does not collapse into italic', () => {
    // The * at line start would otherwise also be a potential italic opener
    const out = markdownToSlackMrkdwn('* **Lebanon** strikes');
    assert.equal(out, '• *Lebanon* strikes');
  });
});

// ── Discord CommonMark ───────────────────────────────────────────────────────

describe('markdownToDiscord', () => {
  it('normalizes * bullets to - (Discord lists only accept -)', () => {
    const out = markdownToDiscord('* one\n* two');
    assert.equal(out, '- one\n- two');
  });

  it('leaves - bullets untouched', () => {
    const out = markdownToDiscord('- one\n- two');
    assert.equal(out, '- one\n- two');
  });

  it('wraps section headers in **bold**', () => {
    const out = markdownToDiscord('Assessment: escalating');
    assert.equal(out, '**Assessment:** escalating');
  });

  it('leaves **bold** and *italic* untouched (Discord parses CommonMark natively)', () => {
    const out = markdownToDiscord('the **Lebanon** region is *critical*');
    assert.equal(out, 'the **Lebanon** region is *critical*');
  });

  it('converts a realistic summary end-to-end', () => {
    const out = markdownToDiscord(REALISTIC_SUMMARY);
    assert.match(out, /^\*\*Assessment:\*\* Regional/);
    assert.match(out, /^- Israeli strikes killed 25 people in \*\*Lebanon\*\*/m);
    assert.match(out, /^\*\*Signals to watch:\*\*/m);
  });
});

// ── Full integration: realistic summary on all channels ─────────────────────

describe('realistic AI summary — cross-channel smoke test', () => {
  it('email output is well-formed with 2 lists and 2 headers', () => {
    const html = markdownToEmailHtml(REALISTIC_SUMMARY);
    assert.equal((html.match(/<ul[\s>]/g) ?? []).length, 2);
    assert.equal((html.match(/<\/ul>/g) ?? []).length, 2);
    assert.equal((html.match(/color:#4ade80/g) ?? []).length, 2);
  });

  it('telegram output has bold tags, bullet chars, and escaped entities', () => {
    const out = markdownToTelegramHtml(REALISTIC_SUMMARY);
    assert.match(out, /<b>Lebanon<\/b>/);
    assert.match(out, /<b>Assessment:<\/b>/);
    assert.match(out, /<b>Signals to watch:<\/b>/);
    assert.match(out, /^• Israeli/m);
    assert.match(out, /&lt;unknown&gt;/);
    assert.match(out, /&amp;/);
  });

  it('slack output uses single-asterisk bold, underscore italic, bullet chars', () => {
    const out = markdownToSlackMrkdwn(REALISTIC_SUMMARY);
    assert.match(out, /\*Lebanon\*/);
    assert.match(out, /_48 hours_/);
    assert.match(out, /^\*Assessment:\*/m);
    assert.match(out, /^\*Signals to watch:\*/m);
    assert.match(out, /^• Israeli/m);
    assert.match(out, /&lt;unknown&gt;/);
  });

  it('discord output uses - bullets, **bold** headers, and CommonMark-native emphasis', () => {
    const out = markdownToDiscord(REALISTIC_SUMMARY);
    assert.match(out, /^\*\*Assessment:\*\*/m);
    assert.match(out, /^\*\*Signals to watch:\*\*/m);
    assert.match(out, /^- Israeli strikes killed 25 people in \*\*Lebanon\*\*/m);
    // Discord is told the raw markdown — it should NOT have the escaped entities
    assert.match(out, /<unknown>/);
    assert.match(out, / & still/);
  });
});
