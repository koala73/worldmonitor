// The in-app Word/PDF export of the travel risk assessment (#10451, phase 2)
// converts the draft's Markdown to HTML on the server. The Markdown is our own
// closed grammar over feed text that cleanText has already neutralised, so the
// converter has to do two things: keep the document's structure, and never let
// feed text become live markup. Both are pinned here against the real
// assembler, not a hand-written Markdown sample.

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { buildTravelRiskResult, type TravelRiskSources, type SourceSnapshot, TRAVEL_RISK_FEEDS } from '../api/mcp/registry/_travel-risk-document';
import { parseTravelRiskArgs } from '../api/mcp/registry/travel-risk-tool';
import { renderTravelRiskHtml } from '../server/_shared/travel-risk-html';

const NOW = Date.parse('2026-11-10T12:00:00.000Z');
const UPDATED = '2026-11-10T11:30:00.000Z';

const ok = (value: unknown): SourceSnapshot => ({ status: 'ok', value, reason: null, updatedAt: UPDATED, stale: false });
const down = (reason: string): SourceSnapshot => ({ status: 'unavailable', value: null, reason, updatedAt: null, stale: true });

function sources(unrestTitle: string): TravelRiskSources {
  const feeds = Object.fromEntries(TRAVEL_RISK_FEEDS.map((feed) => [feed.id, down('the source snapshot is not in the cache')])) as TravelRiskSources['feeds'];
  feeds.unrest = ok({ events: [
    { title: unrestTitle, city: 'Bangkok', country: 'Thailand', occurredAt: NOW - 86_400_000, sources: ['Bangkok Post'], sourceUrls: ['https://www.bangkokpost.com/x'] },
  ] });
  return { feeds, cii: {}, hotspots: down('the hotspot model could not run') };
}

function build(unrestTitle = 'Protest outside parliament') {
  const trip = parseTravelRiskArgs({
    countries: [{ country_code: 'TH', cities: ['Bangkok'], arrive: '2026-12-01', depart: '2026-12-05' }],
    date_from: '2026-12-01',
    date_to: '2026-12-05',
    task_label: 'Regional site visits',
  });
  return buildTravelRiskResult(trip, sources(unrestTitle), NOW);
}

describe('renderTravelRiskHtml: structure', () => {
  const { markdown } = build();
  const html = renderTravelRiskHtml(markdown);

  it('is a complete document with a title and a print stylesheet', () => {
    assert.match(html, /^<!doctype html>/i);
    assert.match(html, /<html lang="en">/);
    assert.match(html, /<meta charset="utf-8">/);
    assert.match(html, /<title>Travel risk assessment draft<\/title>/);
    assert.match(html, /@media print/);
  });

  it('keeps all nine numbered sections as h2 headings, in order', () => {
    const headings = [...html.matchAll(/<h2>([^<]*)<\/h2>/g)].map((m) => m[1]);
    assert.deepEqual(headings, [
      '1. Summary',
      '2. Government travel advice',
      '3. Security',
      '4. Natural hazards',
      '5. Health',
      '6. Getting in and out',
      '7. Communications and infrastructure',
      '8. What this draft does not cover',
      '9. Sources and capture time',
    ]);
  });

  it('renders the five analyst sections as empty, labelled headings', () => {
    for (const heading of ['Street crime', 'Medical facilities', 'Local laws and customs', 'Emergency contacts', 'Venue-specific risks']) {
      assert.match(html, new RegExp(`<h3>${heading}</h3>\\s*<p>Analyst to complete\\.</p>`));
    }
  });

  it('renders the sources as a real table with a header row', () => {
    assert.match(html, /<table>\s*<thead>\s*<tr><th>Source<\/th><th>Data updated<\/th><th>Status<\/th><\/tr>/);
    assert.match(html, /<tbody>[\s\S]*<td>[^<]+<\/td>[\s\S]*<\/tbody>/);
  });

  it('renders the itinerary as an ordered list and findings as bullets with their source and link', () => {
    assert.match(html, /<ol>\s*<li>Thailand \(TH\)\./);
    assert.match(html, /<li>Unverified media signal: &quot;Protest outside parliament&quot;[^<]*Source: World Monitor unrest feed, reported by Bangkok Post, 2026-11-09\. <a href="https:\/\/www\.bangkokpost\.com\/x">https:\/\/www\.bangkokpost\.com\/x<\/a><\/li>/);
  });

  it('keeps the task label and the capture time in the opening paragraphs', () => {
    assert.match(html, /<p>Task: Regional site visits<\/p>/);
    assert.match(html, /<p>Retrieved by World Monitor at 2026-11-10 12:00 UTC\./);
  });

  it('bolds the block topic and the overall rating', () => {
    assert.match(html, /<strong>Overall rating\.<\/strong>/);
    assert.match(html, /<p><strong>Unrest signals\.<\/strong> 1 unverified media signal/);
  });
});

describe('renderTravelRiskHtml: feed text never becomes markup', () => {
  const hostile = [
    '<script>alert(1)</script>',
    '<img src=x onerror=alert(1)>',
    '"><svg onload=alert(1)>',
    '[click](javascript:alert(1))',
    '**bold** and _em_ and `code`',
    '</td></tr></table><h1>forged</h1>',
    '&lt;b&gt; &amp; &#60;',
  ];
  for (const title of hostile) {
    it(`escapes ${JSON.stringify(title)}`, () => {
      const html = renderTravelRiskHtml(build(title).markdown);
      assert.doesNotMatch(html, /<script/i);
      assert.doesNotMatch(html, /<img/i);
      assert.doesNotMatch(html, /<svg/i);
      assert.doesNotMatch(html, /<h1>forged/);
      // Event-handler text may appear as escaped text; it must never sit inside a tag.
      assert.doesNotMatch(html, /<[^>]*\son\w+\s*=/i);
      assert.doesNotMatch(html, /href="(?!https:\/\/)/i);
      // The only anchors are https links the assembler emitted.
      for (const [, href] of html.matchAll(/<a href="([^"]*)"/g)) assert.match(href!, /^https:\/\/[^\s"<>]+$/);
      // One h1 only: the title.
      assert.equal((html.match(/<h1>/g) ?? []).length, 1);
    });
  }

  it('shows the hostile text as text, so the analyst sees what the feed said', () => {
    const html = renderTravelRiskHtml(build('<b>x</b> & [y](z)').markdown);
    assert.match(html, /&lt;b&gt;x&lt;\/b&gt; &amp; \[y\]\(z\)/);
  });

  it('does not let a stray unescaped angle bracket start a tag', () => {
    const html = renderTravelRiskHtml('# T\n\nA < B and C > D and <b>bold</b> and <http://insecure.example/x>\n');
    assert.doesNotMatch(html, /<b>/);
    assert.doesNotMatch(html, /<a /);
    assert.match(html, /A &lt; B and C &gt; D/);
  });

  it('only links https URLs', () => {
    const html = renderTravelRiskHtml('# T\n\n- item <https://ok.example/a?x=1&y=2> and <javascript:alert(1)> and <http://nope.example>\n');
    assert.equal((html.match(/<a /g) ?? []).length, 1);
    assert.match(html, /href="https:\/\/ok\.example\/a\?x=1&amp;y=2"/);
  });

  it('escapes the document title', () => {
    const html = renderTravelRiskHtml('# <b>T</b> & co\n');
    assert.match(html, /<title>&lt;b&gt;T&lt;\/b&gt; &amp; co<\/title>/);
    assert.match(html, /<h1>&lt;b&gt;T&lt;\/b&gt; &amp; co<\/h1>/);
  });
});

describe('renderTravelRiskHtml: print and Word', () => {
  const html = renderTravelRiskHtml(build().markdown);

  it('fixes the table layout so wide cells wrap instead of clipping', () => {
    assert.match(html, /table-layout:\s*fixed/);
    assert.match(html, /word-wrap:\s*break-word|overflow-wrap:\s*anywhere/);
    assert.match(html, /tr\s*\{[^}]*page-break-inside:\s*avoid/);
  });

  it('uses no script, no external resource and no feature Word cannot read', () => {
    assert.doesNotMatch(html, /<script|<link|@import|url\(|var\(--|display:\s*(flex|grid)/i);
  });
});

describe('renderTravelRiskHtml: input that is built to be slow', () => {
  // The converter is only fed the assembler's Markdown, but it is a pure
  // function of its input, so its cost has to be linear on any input. The bound
  // is far above the measured 10 to 35 ms for 250 KB so it never flakes, and far
  // below what a quadratic path would take.
  const N = 250_000;
  const patterns: Record<string, string> = {
    'bare angle brackets': '<'.repeat(N),
    'unterminated autolinks': '<https://a'.repeat(N / 10),
    'doubled stars': '**'.repeat(N / 2),
    'unclosed bold openers': '**a '.repeat(N / 4),
    'backslashes': '\\'.repeat(N),
    'escaped brackets': '\\<'.repeat(N / 2),
    'a list item per line': '- a\n'.repeat(N / 4),
    'a table row per line': '| a | b |\n'.repeat(N / 10),
  };
  for (const [name, body] of Object.entries(patterns)) {
    it(`renders ${name} in linear time`, () => {
      const started = performance.now();
      const html = renderTravelRiskHtml(`# T\n\n${body}\n`);
      assert.ok(performance.now() - started < 1500, `${name} took ${Math.round(performance.now() - started)} ms`);
      assert.doesNotMatch(html, /<(?!\/?(?:!doctype|html|head|body|meta|title|style|h[1-3]|p|ul|ol|li|a|strong|table|thead|tbody|tr|th|td)[\s>\/])/i, 'no tag other than the ones the converter writes');
    });
  }
});
