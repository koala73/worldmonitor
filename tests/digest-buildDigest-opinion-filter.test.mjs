// Behavioral coverage for digest story:track opinion stamp handling.
//
// buildDigest uses this pure helper so the policy is executable without
// loading cron configuration or a Redis accumulator harness.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { shouldDropOpinionTrack } from '../scripts/lib/digest-opinion-track-filter.mjs';

const DW_RETROSPECTIVE = {
  title: "How Turkey's 2016 coup attempt changed the country for good",
  link: 'https://amp.dw.com/en/how-turkeys-2016-coup-attempt-changed-the-country-for-good/a-77955154',
  description: 'A reported look back at the coup and its lasting political consequences.',
  publishedAt: String(Date.UTC(2026, 6, 14)),
};

describe('shouldDropOpinionTrack — digest read-path stamp policy', () => {
  it('drops an ingest-stamped historical explainer', () => {
    assert.equal(shouldDropOpinionTrack({ ...DW_RETROSPECTIVE, isOpinion: '1' }), true);
  });

  it('keeps hard news with an explicit non-opinion stamp', () => {
    assert.equal(
      shouldDropOpinionTrack({
        title: 'Iran launches missiles at UAE oil tankers in Strait of Hormuz',
        link: 'https://example.com/world/hormuz-tankers',
        description: 'The attacks escalated a regional confrontation overnight.',
        publishedAt: String(Date.UTC(2026, 6, 15)),
        isOpinion: '0',
      }),
      false,
    );
  });

  it('drops an unstamped legacy historical explainer', () => {
    assert.equal(shouldDropOpinionTrack(DW_RETROSPECTIVE), true);
  });

  it('trusts an explicit legacy non-opinion stamp until the next ingest poll', () => {
    assert.equal(shouldDropOpinionTrack({ ...DW_RETROSPECTIVE, isOpinion: '0' }), false);
  });
});
