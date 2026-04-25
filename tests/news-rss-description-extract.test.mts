// Characterization + unit tests for RSS/Atom description extraction in
// server/worldmonitor/news/v1/list-feed-digest.ts.
//
// The parser must carry a cleaned article description on every ParsedItem so
// downstream LLM surfaces (brief description card, whyMatters, SummarizeArticle,
// email digest, relay) can ground on real article context instead of hallucinating
// from headline metadata alone. See docs/plans/2026-04-24-001-fix-rss-description-end-to-end-plan.md.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  __testing__,
} from '../server/worldmonitor/news/v1/list-feed-digest';

const { extractDescription, parseRssXml } = __testing__;

const FEED = { url: 'https://example.com/rss', name: 'Example', lang: 'en' } as const;

function wrapRss(items: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel>${items}</channel></rss>`;
}

function wrapAtom(entries: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom">${entries}</feed>`;
}

describe('extractDescription — RSS', () => {
  it('extracts CDATA-wrapped <description> with embedded HTML', () => {
    const block = `
      <title>Iran's new supreme leader seriously wounded</title>
      <description><![CDATA[<p>Mojtaba Khamenei, 56, was seriously wounded in an attack and has delegated power to the Revolutionary Guards, according to News24 sources.</p>]]></description>
    `;
    const desc = extractDescription(block, false, "Iran's new supreme leader seriously wounded");
    assert.ok(desc.length > 0, 'description should be extracted');
    assert.ok(desc.includes('Mojtaba'), 'description should contain the real named actor');
    assert.ok(!desc.includes('<p>'), 'HTML tags must be stripped');
    assert.ok(!desc.includes('</p>'), 'HTML tags must be stripped');
    assert.ok(!desc.includes('&amp;'), 'entities must be decoded');
  });

  it('extracts plain (non-CDATA) <description>', () => {
    const block = `
      <title>News item title</title>
      <description>This is a plain description that is longer than forty characters to pass the minimum grounding gate.</description>
    `;
    const desc = extractDescription(block, false, 'News item title');
    assert.ok(desc.startsWith('This is a plain description'));
  });

  it('picks the LONGEST non-empty candidate across description + content:encoded', () => {
    const shortSentence = 'Short summary about a topic that still passes the minimum length gate for descriptions.';
    const longSentence = 'This is a considerably longer body that carries substantially more narrative detail about the story, including the named persons, their specific roles in the events, and the context that distinguishes this event from similar-looking stories in the headline stream.';
    const block = `
      <title>Some headline</title>
      <description>${shortSentence}</description>
      <content:encoded><![CDATA[<p>${longSentence}</p>]]></content:encoded>
    `;
    const desc = extractDescription(block, false, 'Some headline');
    assert.ok(desc.includes('considerably longer'), 'longer content:encoded should win over shorter description');
    assert.ok(!desc.includes('Short summary'), 'shorter description should not be chosen when a longer candidate exists');
  });

  it('returns empty string when description normalizes-equal to headline', () => {
    const block = `
      <title>Breaking: Market Closes At Record High</title>
      <description>Breaking:  Market   Closes at record high</description>
    `;
    const desc = extractDescription(block, false, 'Breaking: Market Closes At Record High');
    assert.strictEqual(desc, '', 'dup-of-headline must be rejected to avoid cache-key shift with no grounding value');
  });

  it('returns empty string when description is empty/whitespace', () => {
    const block = `
      <title>Headline</title>
      <description>   </description>
    `;
    const desc = extractDescription(block, false, 'Headline');
    assert.strictEqual(desc, '');
  });

  it('returns empty string when description after strip is <40 chars', () => {
    const block = `
      <title>Headline</title>
      <description>Too short to be useful.</description>
    `;
    const desc = extractDescription(block, false, 'Headline');
    assert.strictEqual(desc, '', 'descriptions shorter than MIN_DESCRIPTION_LEN must be rejected');
  });

  it('decodes HTML entities', () => {
    const block = `
      <title>Headline</title>
      <description>Europe&#8217;s gas storage levels are at record lows and winter hedging &amp; policy moves are under close watch.</description>
    `;
    const desc = extractDescription(block, false, 'Headline');
    assert.ok(desc.includes('Europe’s') || desc.includes("Europe's"), 'numeric entity &#8217; must decode');
    assert.ok(desc.includes('&'), 'named entity &amp; must decode to literal &');
    assert.ok(!desc.includes('&amp;'), 'raw &amp; must be gone after decode');
  });

  it('clips description to 400 chars', () => {
    const long = 'x'.repeat(600);
    const block = `
      <title>Headline</title>
      <description>${long}</description>
    `;
    const desc = extractDescription(block, false, 'Headline');
    assert.strictEqual(desc.length, 400, 'MAX_DESCRIPTION_LEN=400 must clip');
  });

  it('handles well-formed CDATA with punctuation content', () => {
    // Well-formed CDATA cannot contain a literal ]]> inside the body (XML
    // spec). This test asserts that a realistic body with heavy punctuation
    // (colons, semicolons) parses cleanly via the CDATA regex anchor.
    const block = `
      <title>Headline</title>
      <description><![CDATA[<p>Body containing typical punctuation: semicolons; colons: and lots of text that makes the body comfortably above the minimum grounding length.</p>]]></description>
    `;
    const desc = extractDescription(block, false, 'Headline');
    assert.ok(desc.includes('semicolons'));
    assert.ok(desc.includes('comfortably above'));
  });

  it('malformed CDATA with a premature ]]> sequence falls back to the plain regex', () => {
    // Feeds in the wild sometimes malform CDATA by embedding a literal ]]>
    // that is not the terminator (spec-violating). Our CDATA regex is
    // anchored to the closing tag, so it REJECTS this feed rather than
    // matching prematurely; the plain regex then captures the entire
    // <description> body including the CDATA wrapper markup. We then
    // HTML-strip + entity-decode + length-gate as usual, so the net
    // behaviour is "degraded but safe": we may keep some CDATA syntax
    // noise in the extracted text, but we never truncate the article body.
    const body = 'Mojtaba Khamenei was seriously wounded in an attack this week; multiple sources report the delegation of authority came ]]> before the attack was acknowledged publicly. Substantial body above the minimum grounding gate.';
    const block = `
      <title>Headline</title>
      <description><![CDATA[<p>${body}</p></description>
    `;
    const desc = extractDescription(block, false, 'Headline');
    // The plain regex returns the inner content between the tags, which
    // still contains the article body. CDATA wrapper characters (`<![CDATA[`
    // / `]]>`) may survive HTML-strip since they aren't inside angle brackets.
    assert.ok(desc.length > 0, 'malformed CDATA must not produce empty output');
    assert.ok(desc.includes('Mojtaba'), 'real article content survives the degraded match');
  });

  it('returns empty string when no description tag is present', () => {
    const block = `<title>Only a headline</title><link>https://example.com/</link>`;
    const desc = extractDescription(block, false, 'Only a headline');
    assert.strictEqual(desc, '');
  });
});

describe('extractDescription — Atom', () => {
  it('extracts Atom <summary>', () => {
    const block = `
      <title>Atom entry title</title>
      <summary>Atom summary body that carries enough context to pass the minimum grounding gate.</summary>
    `;
    const desc = extractDescription(block, true, 'Atom entry title');
    assert.ok(desc.startsWith('Atom summary body'));
  });

  it('picks longest between <summary> and <content>', () => {
    const block = `
      <title>Atom entry</title>
      <summary>Short summary that just clears the minimum length bar for descriptions.</summary>
      <content type="html"><![CDATA[<div>A considerably longer Atom &lt;content&gt; payload carrying richer narrative detail about the event, named actors, and context that makes this story distinct from its headline.</div>]]></content>
    `;
    const desc = extractDescription(block, true, 'Atom entry');
    assert.ok(desc.includes('considerably longer'), 'longer <content> should beat shorter <summary>');
  });
});

describe('parseRssXml — integration with description', () => {
  it('every ParsedItem carries a description field (string, possibly empty)', () => {
    const xml = wrapRss(`
      <item>
        <title>With description</title>
        <link>https://news.example.com/a</link>
        <pubDate>Thu, 24 Apr 2026 08:01:00 GMT</pubDate>
        <description><![CDATA[<p>A substantive article body that passes every length gate and carries real grounding context for downstream LLM surfaces.</p>]]></description>
      </item>
      <item>
        <title>Without description</title>
        <link>https://news.example.com/b</link>
        <pubDate>Thu, 24 Apr 2026 08:02:00 GMT</pubDate>
      </item>
    `);
    const result = parseRssXml(xml, FEED, 'full');
    assert.ok(result, 'parseRssXml returns non-null for populated feed');
    const items = result!.items;
    assert.strictEqual(items.length, 2);
    assert.ok(items[0]!.description.length > 0, 'first item has a real description');
    assert.ok(items[0]!.description.includes('substantive'));
    assert.strictEqual(items[1]!.description, '', 'second item falls back to empty string');
  });

  it('Atom feed ParsedItems carry a description field from <summary>/<content>', () => {
    const xml = wrapAtom(`
      <entry>
        <title>Atom entry A</title>
        <link href="https://atom.example.com/a"/>
        <published>2026-04-24T08:00:00Z</published>
        <summary>An Atom summary body long enough to pass the minimum grounding gate for descriptions.</summary>
      </entry>
    `);
    const result = parseRssXml(xml, FEED, 'full');
    assert.ok(result);
    const items = result!.items;
    assert.strictEqual(items.length, 1);
    assert.ok(items[0]!.description.startsWith('An Atom summary'));
  });

  it('News24 Iran-leader reproduction: description contains the article-named actor, not the parametric one', () => {
    // Reproduction of the 2026-04-24 bug: headline uses role label ("Iran's new
    // supreme leader"); the article body names Mojtaba Khamenei. The description
    // must carry the article's named actor so downstream LLM grounding stops
    // substituting Gemini's parametric prior ("Ali Khamenei").
    const xml = wrapRss(`
      <item>
        <title>Iran's new supreme leader seriously wounded, delegates power to Revolutionary Guards</title>
        <link>https://www.news24.com/news24/irans-new-supreme-leader-seriously-wounded-delegates-power-to-revolutionary-guards-20260423-1008</link>
        <pubDate>Wed, 23 Apr 2026 19:00:00 GMT</pubDate>
        <description><![CDATA[<p>Mojtaba Khamenei, 56, was seriously wounded in an attack this week, and has delegated operational authority to the Revolutionary Guards, multiple regional sources told News24.</p>]]></description>
      </item>
    `);
    const result = parseRssXml(xml, FEED, 'full');
    assert.ok(result);
    const items = result!.items;
    assert.strictEqual(items.length, 1);
    const desc = items[0]!.description;
    assert.ok(desc.includes('Mojtaba'), 'grounding requires the article-named actor');
    assert.ok(!desc.toLowerCase().includes('ali khamenei'), 'description must not contain the parametric/hallucinated name');
  });
});
