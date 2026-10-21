import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import {
  RESILIENCE_INTERVAL_METHODOLOGY,
  isCurrentResilienceIntervalPayload,
  rankingCacheTagMatches,
  stampRankingCacheTag,
} from '../server/worldmonitor/resilience/v1/_shared.ts';

const originalEducationFlag = process.env.RESILIENCE_EDUCATION_ENABLED;
const originalPillarFlag = process.env.RESILIENCE_PILLAR_COMBINE_ENABLED;

afterEach(() => {
  if (originalEducationFlag == null) delete process.env.RESILIENCE_EDUCATION_ENABLED;
  else process.env.RESILIENCE_EDUCATION_ENABLED = originalEducationFlag;
  if (originalPillarFlag == null) delete process.env.RESILIENCE_PILLAR_COMBINE_ENABLED;
  else process.env.RESILIENCE_PILLAR_COMBINE_ENABLED = originalPillarFlag;
});

describe('education activation cache compatibility', () => {
  it('changes dynamically with the rollback flag', () => {
    process.env.RESILIENCE_EDUCATION_ENABLED = 'true';
    assert.equal(stampRankingCacheTag({})._educationState, 'education-on');
    process.env.RESILIENCE_EDUCATION_ENABLED = 'false';
    assert.equal(stampRankingCacheTag({})._educationState, 'education-off');
  });

  it('rejects an active ranking payload after rollback', () => {
    process.env.RESILIENCE_EDUCATION_ENABLED = 'true';
    const active = stampRankingCacheTag({ items: [], greyedOut: [] });
    assert.equal(active._educationState, 'education-on');
    assert.equal(rankingCacheTagMatches(active), true);

    process.env.RESILIENCE_EDUCATION_ENABLED = 'false';
    assert.equal(rankingCacheTagMatches(active), false);
  });

  it('rejects untagged ranking and interval payloads while active', () => {
    process.env.RESILIENCE_PILLAR_COMBINE_ENABLED = 'true';
    process.env.RESILIENCE_EDUCATION_ENABLED = 'true';
    assert.equal(rankingCacheTagMatches({
      _formula: 'pc',
      _intervalMethodology: RESILIENCE_INTERVAL_METHODOLOGY,
    }), false);
    assert.equal(isCurrentResilienceIntervalPayload({
      p05: 40,
      p95: 60,
      _formula: 'pc',
      methodology: RESILIENCE_INTERVAL_METHODOLOGY,
    }), false);
  });

  it('rejects an active interval payload after rollback', () => {
    process.env.RESILIENCE_PILLAR_COMBINE_ENABLED = 'true';
    process.env.RESILIENCE_EDUCATION_ENABLED = 'false';
    assert.equal(isCurrentResilienceIntervalPayload({
      p05: 40,
      p95: 60,
      _formula: 'pc',
      _educationState: 'education-on',
      methodology: RESILIENCE_INTERVAL_METHODOLOGY,
    }), false);
  });
});
