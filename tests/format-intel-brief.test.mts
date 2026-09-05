import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { formatIntelBrief } from '../src/utils/format-intel-brief';

describe('formatIntelBrief citations', () => {
  it('links bracket citations to source URLs when a source list is provided', () => {
    const html = formatIntelBrief('SITUATION NOW\nClaim one [1]. Claim two [2].', {
      sources: [
        { title: 'First source', url: 'https://example.com/first' },
        { title: 'Second source', url: 'https://example.com/second' },
      ],
    });

    assert.match(html, /href="https:\/\/example\.com\/first"/);
    assert.match(html, /href="https:\/\/example\.com\/second"/);
    assert.doesNotMatch(html, /href="#cb-news-2"/);
  });

  it('falls back to headline anchors only when no source list is provided', () => {
    const html = formatIntelBrief('SITUATION NOW\nClaim [2].', { count: 3, hrefPrefix: '#cb-news-' });

    assert.match(html, /href="#cb-news-2"/);
  });
});

describe('formatIntelBrief markdown and ISO headings', () => {
  it('converts emphasis markers inside bullets, not just paragraphs', () => {
    const html = formatIntelBrief(
      'WHAT THIS MEANS FOR NO\n• **Norges Bank Investment Management (NBIM)**: sale [1].',
      { sources: [{ title: 'CNBC', url: 'https://example.com/nbim' }] },
      'Norway',
    );
    assert.match(html, /<strong>Norges Bank Investment Management \(NBIM\)<\/strong>/);
    assert.doesNotMatch(html, /\*\*/);
  });

  it('rewrites ISO-code section titles to the country name', () => {
    const html = formatIntelBrief(
      'WHAT THIS MEANS FOR NO\nNamed infrastructure impact.',
      undefined,
      'Norway',
    );
    assert.match(html, /What this means for Norway/);
    assert.doesNotMatch(html, /\bFOR NO\b/);
  });

  it('recognizes section titles wrapped in markdown emphasis', () => {
    const html = formatIntelBrief(
      '**WHAT THIS MEANS FOR GE**\nNamed infrastructure impact.',
      undefined,
      'Georgia',
    );
    assert.match(html, /What this means for Georgia/);
    assert.doesNotMatch(html, /\bFOR GE\b/);
  });

  it('strips markdown heading markers before rewriting ISO titles', () => {
    const html = formatIntelBrief(
      '# WHAT THIS MEANS FOR NO\n* **NBIM**: sale.',
      undefined,
      'Norway',
    );
    assert.match(html, /What this means for Norway/);
    assert.match(html, /<strong>NBIM<\/strong>/);
    assert.doesNotMatch(html, /\bFOR NO\b/);
  });

  it('unwraps combined heading markers before rewriting ISO titles', () => {
    const html = formatIntelBrief(
      '### **WHAT THIS MEANS FOR NO**\nNamed infrastructure impact.',
      undefined,
      'Norway',
    );
    assert.match(html, /What this means for Norway/);
    assert.doesNotMatch(html, /\bFOR NO\b/);
  });
});
