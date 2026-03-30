import test from 'node:test';
import assert from 'node:assert/strict';

import { buildCountryConsequences } from '../src/services/country-consequence-engine.ts';

test('war-heavy countries produce escalation-first consequences', () => {
  const consequences = buildCountryConsequences({
    country: 'Taiwan',
    score: 79,
    trend: 'rising',
    signals: {
      criticalNews: 4,
      activeStrikes: 1,
      militaryFlights: 10,
      militaryVessels: 7,
      conflictEvents: 5,
      outages: 1,
    },
    infrastructureCounts: {
      cable: 4,
      port: 3,
      datacenter: 2,
    },
    markets: [{ title: 'China invades Taiwan in 2026', yesPrice: 68 }],
  });

  assert.equal(consequences[0]?.kind, 'war-escalation');
  assert.equal(consequences[0]?.severity, 'critical');
  assert.ok(consequences[0]?.watchPanels.includes('strategic-posture'));
  assert.ok(consequences[0]?.evidence.some((item) => item.includes('military')));
});

test('cyber and outage pressure elevates infrastructure shock consequences', () => {
  const consequences = buildCountryConsequences({
    country: 'Germany',
    score: 46,
    trend: 'rising',
    signals: {
      cyberThreats: 6,
      outages: 4,
      aviationDisruptions: 2,
      travelAdvisories: 1,
    },
    infrastructureCounts: {
      cable: 3,
      datacenter: 4,
      pipeline: 2,
    },
  });

  assert.equal(consequences[0]?.kind, 'cyber-disruption');
  assert.ok(consequences.some((item) => item.kind === 'infrastructure-shock'));
  assert.ok(consequences[0]?.watchPanels.includes('comms-health'));
});
