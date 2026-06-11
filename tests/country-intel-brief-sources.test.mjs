import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseCountryBriefSources } from '../server/worldmonitor/intelligence/v1/get-country-intel-brief.ts';

describe('country intel brief source parsing', () => {
  it('parses bounded structured source lines from the context snapshot', () => {
    const sources = parseCountryBriefSources([
      'Country: United States (US)',
      'Brief source articles:',
      'Source [1]: US headline | Example Wire | https://example.com/us | published=2026-06-07T00:00:00.000Z',
      'Source [2]: Unsafe headline | Bad Feed | javascript:alert(1)',
      'Source [3]: Duplicate headline | Example Wire | https://example.com/us',
      'Source [4]: Second headline | Agency | http://example.com/second',
    ].join('\n'));

    assert.deepEqual(sources, [
      {
        title: 'US headline',
        source: 'Example Wire',
        url: 'https://example.com/us',
        publishedAt: '2026-06-07T00:00:00.000Z',
      },
      {
        title: 'Second headline',
        source: 'Agency',
        url: 'http://example.com/second',
      },
    ]);
  });
});
