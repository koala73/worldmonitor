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
