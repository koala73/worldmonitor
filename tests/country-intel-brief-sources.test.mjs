import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseCountryBriefSources, renderSourceBoundCountryBrief } from '../server/worldmonitor/intelligence/v1/get-country-intel-brief.ts';
import { briefCitationGroundingGap } from '../scripts/crawlable-developments.mjs';

describe('source-bound country brief generation', () => {
  const sources = [
    { title: 'Finland completes a 200-kilometer fence', source: 'Reuters', url: 'https://reuters.com/fence', publishedAt: '' },
    { title: 'Fitburg defendants deny sabotage', source: 'Yle', url: 'https://yle.fi/trial', publishedAt: '' },
  ];
  const payload = () => ({ situation: [{ text: sources[0].title, source: 1 }], implications: [], risks: [], outlook: [], watch: [{ text: sources[1].title, source: 2 }] });
  it('formats separately cited claims and explicit evidence limits that pass the publication gate', () => {
    const text = renderSourceBoundCountryBrief(JSON.stringify(payload()), sources, 'Finland');
    assert.match(text, /Finland completes a 200-kilometer fence \[1\]/);
    assert.match(text, /OUTLOOK\nThe supplied headlines do not establish this\./);
    assert.equal(briefCitationGroundingGap({ text, sources }, { countryCode: 'FI', countryName: 'Finland' }), null);
  });
  it('accepts bounded model citation spellings without changing source identity', () => {
    for (const source of ['1', '[1]']) {
      assert.match(renderSourceBoundCountryBrief(JSON.stringify({ ...payload(), situation: [{ text: sources[0].title, source }] }), sources, 'Finland'), /fence \[1\]/);
    }
    for (const source of ['1,2', '[1][2]', '1.5', '1foo']) {
      assert.equal(renderSourceBoundCountryBrief(JSON.stringify({ ...payload(), situation: [{ text: sources[0].title, source }] }), sources, 'Finland'), null);
    }
  });
  it('retains independently grounded claims and discloses withheld claims', () => {
    const text = renderSourceBoundCountryBrief(JSON.stringify({ ...payload(), implications: [
      { text: 'Tamar output increases 30%', source: 1 },
      { text: 'The Fitburg defendants deny sabotage', source: 2 },
    ] }), sources, 'Finland');
    assert.match(text, /The Fitburg defendants deny sabotage \[2\]/);
    assert.doesNotMatch(text, /Tamar|30%/);
    assert.match(text, /Some generated claims were withheld/);
    assert.equal(briefCitationGroundingGap({ text, sources }, { countryCode: 'FI', countryName: 'Finland' }), null);
  });
  it('rejects missing citations, borrowed names, invented numbers, empty and malformed output', () => {
    for (const item of [
      { text: sources[0].title },
      { text: sources[0].title, source: 2 },
      { text: 'Finland completes a 300-kilometer fence', source: 1 },
      { text: 'Tamar faces disruption', source: 1 },
      { text: sources[0].title, source: 3 },
      { text: 'Finland completes a fence [2]', source: 1 },
    ]) {
      assert.equal(renderSourceBoundCountryBrief(JSON.stringify({ ...payload(), situation: [item] }), sources, 'Finland'), null);
    }
    for (const raw of ['not json', '{}', JSON.stringify({ ...payload(), situation: [] })]) {
      assert.equal(renderSourceBoundCountryBrief(raw, sources, 'Finland'), null);
    }
  });
});

describe('country intel brief source parsing', () => {
  it('parses bounded structured source lines from the context snapshot', () => {
    const sources = parseCountryBriefSources([
      'Country: United States (US)',
      'Brief source articles:',
      'Source [1]: {"title":"US headline | with delimiter","source":"Example | Wire","url":"https://example.com/us","publishedAt":"2026-06-07T00:00:00.000Z"}',
      'Source [2]: {"title":"Unsafe headline","source":"Bad Feed","url":"javascript:alert(1)"}',
      'Source [3]: {"title":"Duplicate headline","source":"Example Wire","url":"https://example.com/us"}',
      'Source [4]: Second headline | Agency | http://example.com/second',
    ].join('\n'));

    assert.deepEqual(sources, [
      {
        title: 'US headline | with delimiter',
        source: 'Example | Wire',
        url: 'https://example.com/us',
        publishedAt: '2026-06-07T00:00:00.000Z',
      },
      {
        title: 'Second headline',
        source: 'Agency',
        url: 'http://example.com/second',
        publishedAt: '',
      },
    ]);
  });
});
