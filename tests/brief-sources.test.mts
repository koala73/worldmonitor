import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildBriefSourceContextLines,
  collectBriefSources,
  normalizeCachedBriefSources,
  normalizeBriefSourceUrl,
  renderBriefSourcesFooter,
} from '../src/utils/brief-sources';

describe('brief source helpers', () => {
  it('keeps only absolute http(s) article URLs', () => {
    assert.equal(normalizeBriefSourceUrl('https://example.com/a'), 'https://example.com/a');
    assert.equal(normalizeBriefSourceUrl('http://example.com/a'), 'http://example.com/a');
    assert.equal(normalizeBriefSourceUrl('/relative/article'), '');
    assert.equal(normalizeBriefSourceUrl('javascript:alert(1)'), '');
  });

  it('dedupes, caps, and normalizes source objects from grounding inputs', () => {
    const sources = collectBriefSources([
      { title: 'First story', source: 'Wire', link: 'https://example.com/one', pubDate: '2026-06-07T00:00:00Z' },
      { title: 'Duplicate URL', source: 'Wire', link: 'https://example.com/one' },
      { title: 'Unsafe story', source: 'Bad', link: 'javascript:alert(1)' },
      { title: 'Second story', source: 'Agency', primaryLink: 'https://example.com/two' },
    ], 2);

    assert.deepEqual(sources, [
      {
        title: 'First story',
        source: 'Wire',
        url: 'https://example.com/one',
        publishedAt: '2026-06-07T00:00:00.000Z',
      },
      {
        title: 'Second story',
        source: 'Agency',
        url: 'https://example.com/two',
      },
    ]);
  });

  it('renders a collapsible source footer with escaped labels and methodology link', () => {
    const html = renderBriefSourcesFooter([
      {
        title: 'Story <one>',
        source: 'Wire & Co',
        url: 'https://example.com/one',
      },
    ]);

    assert.match(html, /<details class="brief-sources">/);
    assert.match(html, /<summary>Sources \(1\)<\/summary>/);
    assert.match(html, /AI-synthesized from 1 source &middot; may contain errors/);
    assert.match(html, /href="\/docs\/methodology\/news-digest-and-briefing"/);
    assert.match(html, /Story &lt;one&gt;/);
    assert.match(html, /Wire &amp; Co/);
  });

  it('builds numbered source context lines for LLM grounding', () => {
    const lines = buildBriefSourceContextLines([
      {
        title: 'Grounding story | with delimiter',
        source: 'Wire | Desk',
        url: 'https://example.com/grounding',
        publishedAt: '2026-06-07T00:00:00.000Z',
      },
    ]);

    assert.deepEqual(lines, [
      'Source [1]: {"title":"Grounding story | with delimiter","source":"Wire | Desk","url":"https://example.com/grounding","publishedAt":"2026-06-07T00:00:00.000Z"}',
    ]);
  });

  it('distinguishes legacy source-free cache from current empty source lists', () => {
    assert.deepEqual(normalizeCachedBriefSources(undefined), {
      legacySourceShape: true,
      sources: [],
    });

    assert.deepEqual(normalizeCachedBriefSources({}), {
      legacySourceShape: true,
      sources: [],
    });

    assert.deepEqual(normalizeCachedBriefSources({ sources: [] }), {
      legacySourceShape: false,
      sources: [],
    });

    assert.deepEqual(normalizeCachedBriefSources({ sources: [{ title: 'Bad', source: 'Feed', url: 'javascript:alert(1)' }] }), {
      legacySourceShape: false,
      sources: [],
    });
  });
});
