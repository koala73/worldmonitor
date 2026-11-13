import assert from 'node:assert/strict';
import { it } from 'node:test';
import { actorName, statePartyIso2, parsePartyMonths } from '../scripts/shared/ucdp-state-parties.cjs';
import { summarizeUcdpWindow } from '../scripts/shared/ucdp-candidate.cjs';

it('resolves only named state governments, including UCDP historical names', () => {
  for (const [name, code] of [['Russia (Soviet Union)', 'RU'], ['Ukraine', 'UA'], ['Yemen (North Yemen)', 'YE'], ['Myanmar (Burma)', 'MM']]) {
    assert.equal(statePartyIso2(`Government of ${name}`), code);
  }
  for (const name of ['Russia', 'Rebels of Ukraine', 'XXX475', '', '[unknown]', 'Government of ZZ']) assert.equal(statePartyIso2(name), null);
  assert.equal(actorName('XXX475'), '');
});

it('groups full-window facts by location, ordered party pair and month without losing unknowns', () => {
  const dateStart = Date.UTC(2026, 8, 10);
  const base = { country: 'Ukraine', sideA: 'Government of Russia (Soviet Union)', sideB: 'Government of Ukraine', dateStart };
  const rows = [{ ...base, deathsBest: 3 }, { ...base, deathsBest: 7 }, { ...base, sideB: '', deathsBest: 0 },
    { ...base, dateStart: Date.UTC(2026, 9, 1), deathsBest: 4 }, { ...base, country: 'Russia', deathsBest: 2 }];
  const summary = summarizeUcdpWindow(rows, { startMs: dateStart, endMs: Date.UTC(2026, 9, 2) });
  assert.equal(summary.partyMonths.length, 4);
  assert.equal(summary.partyMonths.reduce((n, x) => n + x.deaths, 0), 16);
  assert.equal(summary.partyMonths.reduce((n, x) => n + x.events, 0), 5);
  assert.equal(summary.partyMonths.find(x => x.sideB === '[unknown]').deaths, 0);
  assert.deepEqual(parsePartyMonths(summary.partyMonths), summary.partyMonths);
  assert.deepEqual(summarizeUcdpWindow([...rows].reverse(), { startMs: dateStart, endMs: Date.UTC(2026, 9, 2) }).partyMonths, summary.partyMonths);
  assert.equal(parsePartyMonths([...summary.partyMonths, { ...summary.partyMonths[0], deaths: NaN }]), null);
});
