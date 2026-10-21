import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyEphemeralLiveCoverage } from '../shared/ephemeral-live-classifier.js';

describe('classifyEphemeralLiveCoverage', () => {
  it('drops WATCH LIVE programming teasers that become stale by digest time', () => {
    assert.equal(
      classifyEphemeralLiveCoverage({
        title: "WATCH LIVE: White House briefing with Dr. Oz may address Pulte's new role, Iran war",
      }),
      true,
    );
    assert.equal(
      classifyEphemeralLiveCoverage({ title: 'Watch live as the president addresses reporters' }),
      true,
    );
  });

  it('drops Watch: headlines only when they are explicitly live programming', () => {
    assert.equal(
      classifyEphemeralLiveCoverage({ title: 'Watch: Press conference live' }),
      true,
    );
    assert.equal(
      classifyEphemeralLiveCoverage({ title: 'Watch: tornadoes swirl through Oklahoma' }),
      false,
    );
  });

  it('drops Live: event broadcasts but preserves live-update hard-news blogs', () => {
    assert.equal(
      classifyEphemeralLiveCoverage({ title: 'LIVE: Senate hearing on Iran policy' }),
      true,
    );
    assert.equal(
      classifyEphemeralLiveCoverage({ title: 'LIVE: live stream of Senate hearing' }),
      true,
    );
    assert.equal(
      classifyEphemeralLiveCoverage({ title: 'LIVE: livestream of Senate hearing' }),
      true,
    );
    assert.equal(
      classifyEphemeralLiveCoverage({ title: 'Live updates: Iran launches new missile barrage' }),
      false,
    );
    assert.equal(
      classifyEphemeralLiveCoverage({ title: 'Live broadcasts paused during emergency' }),
      false,
    );
    assert.equal(
      classifyEphemeralLiveCoverage({ title: 'Live: stream of refugees crosses border' }),
      false,
    );
    assert.equal(
      classifyEphemeralLiveCoverage({ title: 'Live: data stream shows outage expanding' }),
      false,
    );
  });

  it('handles missing and non-string values without throwing', () => {
    assert.equal(classifyEphemeralLiveCoverage({}), false);
    assert.equal(classifyEphemeralLiveCoverage({ title: null }), false);
    assert.equal(classifyEphemeralLiveCoverage({ title: 42 }), false);
  });
});
