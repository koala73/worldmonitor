// Live-labelled headlines from the relay score log, 2026-11-21 to 2026-11-28.
// The Business Recorder header was labelled critical three times and reached
// 26 realtime subscribers on 2026-11-28.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isLiveBlogTopicHeader } from '../shared/live-blog-topic.js';

const TOPIC_HEADERS = [
  'Live Updates: LIVE: Iran-US war - Business Recorder',
  'LIVE: Iran-US war',
  'Live: Russia-Ukraine War',
  'Israel-Hamas war live updates',
  'Middle East crisis live',
  'Live blog: war in Ukraine - The Guardian',
  'Live updates | Iran-Israel conflict',
];

const EVENTS = [
  'Iran war live: Saudi-led coalition downs Houthi missiles',
  'Iran war live: Tankers set ablaze in Hormuz as IRGC warns of unrest threat',
  'Live: Russian strikes kill at least 15 people in Kyiv region, Ukraine says',
  'Zelenskyy says Ukraine responsible for sinking Russian warship in Libya – Europe live',
  'US-Iran War Live Updates: IRGC Navy says three tankers hit mines, catch fire in Strait of Hormuz - The Indian Express',
  'Iran live updates: Iranian drone attack killed 2 Italians, Kuwait says',
  'Iran live updates: US military disables vessel while enforcing blockade',
  'Live - Trump seeks permanent deal as Iran vows to break US blockade - Iran International',
  'Tanker hit in Strait of Hormuz as Iran moves to close strait further | NewsNation Live - Yahoo',
  'Live: France braces for fresh protests as social unrest enters sixth week',
  'Live: Iran declares war',
  'Live: Iran Declares War on Israel',
  'Live: Israel-Iran war escalates',
  'Live: Iran War Ceasefire Collapses',
  'LIVE: Russia-Ukraine War: Kyiv Hit',
  'Live: NATO Enters War',
  'LIVE: IRAN WAR: TANKER HIT',
  'Live: Gaza War Truce Holds',
  'Live: Ceasefire in Iran-US war',
  'Live: Fighting in Iran-US war',
  'Live: US strikes Iran',
  'Iran-US war',
  'The US-Iran war: what we know',
];

describe('isLiveBlogTopicHeader', () => {
  for (const title of TOPIC_HEADERS) {
    it(`matches a header with no event: ${title}`, () => assert.equal(isLiveBlogTopicHeader(title), true));
  }
  for (const title of EVENTS) {
    it(`leaves a headline that reports an event: ${title}`, () => assert.equal(isLiveBlogTopicHeader(title), false));
  }
  it('rejects a non-string', () => assert.equal(isLiveBlogTopicHeader(undefined), false));
});
