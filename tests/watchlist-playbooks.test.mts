import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createWatchlistStore,
  evaluateWatchlistPlaybook,
  rankWatchedCountries,
} from '../src/services/watchlist-playbooks.ts';

function createMemoryStorage() {
  const store = new Map<string, string>();
  return {
    getItem(key: string) {
      return store.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      store.set(key, value);
    },
    removeItem(key: string) {
      store.delete(key);
    },
  };
}

test('watchlist store dedupes countries and keeps newest additions first', () => {
  const watchlist = createWatchlistStore(createMemoryStorage());

  watchlist.addCountry({ code: 'ua', name: 'Ukraine' });
  watchlist.addCountry({ code: 'tw', name: 'Taiwan' });
  watchlist.addCountry({ code: 'UA', name: 'Ukraine' });

  assert.deepEqual(
    watchlist.getCountries().map((country) => country.code),
    ['TW', 'UA'],
  );
  assert.equal(watchlist.isWatched('ua'), true);
});

test('war playbooks promote conflict panels and critical severity', () => {
  const playbook = evaluateWatchlistPlaybook({
    code: 'TW',
    name: 'Taiwan',
    score: 78,
    trend: 'rising',
    signals: {
      criticalNews: 5,
      militaryFlights: 12,
      militaryVessels: 8,
      activeStrikes: 1,
      conflictEvents: 6,
      travelAdvisoryMaxLevel: 'do-not-travel',
    },
  });

  assert.equal(playbook.severity, 'critical');
  assert.equal(playbook.scenario, 'war-escalation');
  assert.deepEqual(
    playbook.priorityPanels.slice(0, 4),
    ['watchlist', 'alert-center', 'strategic-risk', 'strategic-posture'],
  );
  assert.ok(playbook.nextActions.some((action) => action.includes('maritime')));
});

test('ranking puts critical watched countries ahead of medium playbooks', () => {
  const ranked = rankWatchedCountries([
    {
      code: 'BR',
      name: 'Brazil',
      score: 34,
      playbook: evaluateWatchlistPlaybook({
        code: 'BR',
        name: 'Brazil',
        score: 34,
        trend: 'stable',
        signals: { protests: 2, criticalNews: 1 },
      }),
    },
    {
      code: 'TW',
      name: 'Taiwan',
      score: 78,
      playbook: evaluateWatchlistPlaybook({
        code: 'TW',
        name: 'Taiwan',
        score: 78,
        trend: 'rising',
        signals: {
          criticalNews: 5,
          militaryFlights: 12,
          militaryVessels: 8,
          activeStrikes: 1,
        },
      }),
    },
  ]);

  assert.equal(ranked[0]?.code, 'TW');
  assert.equal(ranked[0]?.playbook.severity, 'critical');
});
