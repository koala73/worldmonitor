import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildPredictionContext } from '../server/worldmonitor/intelligence/v1/deduct-situation.ts';

// Titles taken from the live prediction:markets-bootstrap:v1 payload on
// 2026-11-23. The off-topic ones were sent to the model as evidence for a
// Strait of Hormuz question because "the", "of" and "in" matched as substrings.
const MARKETS = [
  { title: 'Will the Bank of Brazil make no change to the target for the Selic rate at the December meeting?', yesPrice: 85, volume: 151_000 },
  { title: 'Will there be no new be CEO of NVIDIA by December 31, 2028?', yesPrice: 15, volume: 7_600_000 },
  { title: 'Will Google have the best AI model at the end of December 2026?', yesPrice: 85, volume: 4_700_000 },
  { title: 'Will David Lisnard win the 2027 French presidential election?', yesPrice: 20, volume: 181_800_000 },
  { title: 'Will the Houthis successfully target shipping by November 30, 2026?', yesPrice: 10, volume: 162_000 },
  { title: 'Will the Iranian regime fall by June 30, 2027?', yesPrice: 10, volume: 113_000 },
  { title: 'Iran full airspace closure by December 31?', yesPrice: 5, volume: 90_000 },
];

function titlesIn(block: string): string[] {
  return block.split('\n').slice(1).map((row) => row.slice(3, row.indexOf('" — ')));
}

describe('buildPredictionContext relevance', () => {
  it('sends only markets that share a content word with the question', () => {
    const block = buildPredictionContext(
      'What are the implications of shipping disruption in the Strait of Hormuz?',
      { geopolitical: MARKETS },
    );
    assert.deepEqual(titlesIn(block), ['Will the Houthis successfully target shipping by November 30, 2026?']);
  });

  it('matches a country name to its adjective form in either direction', () => {
    assert.deepEqual(
      titlesIn(buildPredictionContext('Will Iran close the Strait of Hormuz?', { geopolitical: MARKETS })),
      ['Will the Iranian regime fall by June 30, 2027?', 'Iran full airspace closure by December 31?'],
    );
    assert.deepEqual(
      titlesIn(buildPredictionContext('Iranian nuclear talks', { geopolitical: MARKETS })),
      ['Will the Iranian regime fall by June 30, 2027?', 'Iran full airspace closure by December 31?'],
    );
  });

  it('sends no block when only function words overlap', () => {
    assert.equal(
      buildPredictionContext('What is the outlook for the war in Ukraine?', { geopolitical: MARKETS }),
      '',
    );
  });

  it('does not match on the letter left over from a contraction or possessive', () => {
    const markets = [
      { title: 'Will Anthropic’s next model top the leaderboard?', yesPrice: 60, volume: 900_000 },
      { title: "Will OpenAI's IPO happen in 2027?", yesPrice: 40, volume: 800_000 },
      { title: 'Ukraine peace referendum scheduled by June 30, 2027?', yesPrice: 15, volume: 595_000 },
    ];
    assert.deepEqual(
      titlesIn(buildPredictionContext("What's the outlook for Ukraine? Don't skip it.", { geopolitical: markets })),
      ['Ukraine peace referendum scheduled by June 30, 2027?'],
    );
    assert.deepEqual(
      titlesIn(buildPredictionContext('What’s the outlook for Ukraine?', { geopolitical: markets })),
      ['Ukraine peace referendum scheduled by June 30, 2027?'],
    );
  });

  it('does not match a short word inside a longer one', () => {
    assert.equal(
      buildPredictionContext('war', { geopolitical: [{ title: 'Warsaw mayoral election 2027?', yesPrice: 40, volume: 10_000 }] }),
      '',
    );
  });
});
