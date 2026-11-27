// Headlines from the relay score log, 2026-11-20 to 2026-11-27. The running
// totals were labelled critical and one reached 26 realtime subscribers.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isRunningTally } from '../shared/running-tally.js';

const RUNNING_TOTALS = [
  'Israeli strikes kill 16 schoolchildren so far this month, Gaza ministry says',
  'Gaza death toll rises to 74,736 as Israeli aggression continues',
  'Gaza death toll rises to 1,671',
  'Number of martyrs in war on Gaza rises to 74742',
  'Death toll in Israel’s genocidal war on Gaza rises to 74,746',
  'Russia fired 165 missiles at Ukraine this week, including North Korean ballistic weapons — Zelenskyy',
  'Russia launches approximately 2,700 drones, nearly 1,460 glide bombs, and 165 missiles at Ukraine in one week – Zelensky',
  'fars | Deputy FM: Over 4,300 Children Killed, 5,571 Injured in 15 Years of Saudi-Led War on Yemen',
  'Leaked data suggests 500,000 Russian soldiers killed since start of Ukraine invasion',
];

const NEW_EVENTS = [
  "Death toll from Russian strike on apartment building in Kyiv region's Dymer rises to 11",
  'Death toll from Russian attack in Dymer rises to four – Zelensky',
  '16 killed, 10 injured in W. Kordofan shelter drone strike',
  'Israeli strikes kill at least 16 Palestinians across Gaza over past day',
  'Russian attacks kill 12, injure 82 across Ukraine over past day as country reels from mass overnight strike',
  'Gaza’s health ministry says 19 Palestinians killed by Israeli attacks in 48 hours',
  'Iran attacks 60 ships in eight weeks as new strike on bulker reported',
  'Iran attacks 64 ships in eight weeks as multiple vessels are hit in same incident',
  'Putin’s prized bridge to occupied Crimea has been hit for the third time this week',
  'COP31 climate talks collapse without a deal over fossil fuels, 1st time in 17 years',
  'Deadliest attack on Kyiv since 2022 kills 31',
  'Iran closes Strait of Hormuz',
  'Russia launches 500 drones and 40 missiles at Ukraine in largest attack this year',
  'Iran fires missiles at Israel in most serious escalation since October 7',
  'Army seizes power in Burkina Faso, second coup in three years',
  'Third Russian strike on Kyiv in two weeks kills 14',
  'Death toll from RSF assault on El Fasher rises to 1,500',
  'Death toll in RSF assault on El Fasher rises to 1,500',
  'Death toll after Myanmar earthquake rises to 2,000',
  'Israel and Hamas agree ceasefire after war that killed 70,000 since October 7',
];

describe('isRunningTally', () => {
  for (const title of RUNNING_TOTALS) {
    it(`a running total: ${title.slice(0, 70)}`, () => assert.equal(isRunningTally(title), true));
  }
  for (const title of NEW_EVENTS) {
    it(`a new event: ${title.slice(0, 70)}`, () => assert.equal(isRunningTally(title), false));
  }
  it('stays fast on a long run of digits and commas', () => {
    const started = performance.now();
    isRunningTally(`Death toll rises to ${'1,'.repeat(32_000)}1`);
    assert.ok(performance.now() - started < 50, 'a crafted headline must not stall the relay');
  });
  it('is false for a value that is not a string', () => {
    assert.equal(isRunningTally(undefined), false);
    assert.equal(isRunningTally(null), false);
  });
});
