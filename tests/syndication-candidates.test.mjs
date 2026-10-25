// #9095: the curation report lists same-copy groups across families, and nothing else.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { syndicationCandidates } from '../scripts/syndication-candidates.mjs';

const TITLE = 'Zaporizhzhia airstrikes kill 17 as Russia intensifies attacks across Ukraine';
const LEAD = 'Zaporizhzhia was hit by deadly Russian airstrikes on Saturday, 10 October, killing at least 17 people, including three children, Ukrainian officials said. Rescuers searched rubble for survivors as the city faced renewed strikes on residential areas.';
const item = (source, link, title = TITLE, snippet = LEAD) => ({ source, title, snippet, link, publishedAt: Date.parse('2026-10-11T09:00:00Z') });

describe('syndicationCandidates', () => {
  it('lists unlisted outlets that carried the same copy, with their hosts', () => {
    const body = { categories: { world: { items: [
      item('EuroNews', 'https://www.euronews.com/a'),
      item('Africanews', 'https://www.africanews.com/a'),
      item('Unrelated Wire', 'https://unrelated.test/b', 'Panama declares a state of emergency after two strong quakes', 'The government of Panama declared a state of emergency on Saturday after two powerful earthquakes shook communities across all ten provinces for hours.'),
    ] } } };
    assert.deepEqual(syndicationCandidates(body), [{
      labels: ['Africanews', 'EuroNews'],
      families: ['label:africanews', 'label:euronews'],
      hosts: ['www.africanews.com', 'www.euronews.com'],
      stories: 1,
      example: TITLE,
    }]);
  });

  it('feeds of one curated publisher are not candidates, and an empty digest has none', () => {
    const body = { categories: { world: { items: [item('Reuters World', 'https://r.test/1'), item('Reuters US', 'https://r.test/2')] } } };
    assert.deepEqual(syndicationCandidates(body), []);
    assert.deepEqual(syndicationCandidates({}), []);
  });
});
