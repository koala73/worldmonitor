import test from 'node:test';
import assert from 'node:assert/strict';

import { buildReplayNarrative } from '../src/services/replay-narrative.ts';

test('replay narratives call out new critical escalations between snapshots', () => {
  const narrative = buildReplayNarrative(
    {
      criticalCount: 2,
      highCount: 3,
      watchedCountries: [
        { code: 'TW', name: 'Taiwan', severity: 'critical', scenario: 'war-escalation', score: 81 },
        { code: 'IL', name: 'Israel', severity: 'high', scenario: 'infrastructure-shock', score: 68 },
      ],
    },
    {
      criticalCount: 0,
      highCount: 1,
      watchedCountries: [
        { code: 'TW', name: 'Taiwan', severity: 'medium', scenario: 'steady-watch', score: 58 },
      ],
    },
    Date.UTC(2026, 2, 29, 15, 0, 0),
  );

  assert.equal(narrative.severity, 'critical');
  assert.match(narrative.headline, /Escalation|Critical/);
  assert.ok(narrative.bullets.some((bullet) => bullet.includes('Taiwan')));
  assert.ok(narrative.summary.includes('2 critical'));
});

test('replay narratives stay calm when the watchlist is stable', () => {
  const narrative = buildReplayNarrative(
    {
      criticalCount: 0,
      highCount: 1,
      watchedCountries: [
        { code: 'BR', name: 'Brazil', severity: 'medium', scenario: 'civil-unrest', score: 41 },
      ],
    },
    {
      criticalCount: 0,
      highCount: 1,
      watchedCountries: [
        { code: 'BR', name: 'Brazil', severity: 'medium', scenario: 'civil-unrest', score: 40 },
      ],
    },
  );

  assert.equal(narrative.severity, 'medium');
  assert.match(narrative.headline, /Holding|Stable|Watch/);
});
