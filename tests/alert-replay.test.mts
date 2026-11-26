import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { recordedMatcher, replayIncident, type Incident, type Replayed } from './helpers/alert-replay-harness.mts';

// Nothing in a replay may reach the network: the matcher answers from the
// fixture and every store is in memory.
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url: unknown) => { throw new Error(`alert replay made a network call: ${String(url)}`); };
after(() => { globalThis.fetch = originalFetch; });

const { incidents } = JSON.parse(
  readFileSync(new URL('./fixtures/alert-replays.json', import.meta.url), 'utf8'),
) as { incidents: Incident[] };

const replays: Array<{ incident: Incident; missing: string[]; unusedRewrites: string[]; rows: Replayed[] }> = [];
for (const incident of incidents) {
  const matcher = recordedMatcher(incident);
  const rows = await replayIncident(incident, matcher);
  replays.push({ incident, missing: matcher.missing, unusedRewrites: matcher.unusedRewrites(), rows });
}

describe('alert replay set (#10976)', () => {
  for (const { incident, missing, unusedRewrites, rows } of replays) {
    describe(incident.id, () => {
      it('has a recorded matcher answer for every question the replay asks', () => {
        assert.deepEqual(missing, [], 'run tests/helpers/record-alert-replay-matches.mts');
      });
      it('asks every recorded repeat-check question once per recorded vote', () => {
        assert.deepEqual(unusedRewrites, [], 'the repeat check no longer runs where it was recorded');
      });
      it('runs the reworded-repeat check without an error', () => {
        assert.deepEqual(rows.filter((r) => r.repeatCheckError).map((r) => `${r.wording.title}: ${r.repeatCheckError}`), []);
      });

      for (const { wording, loggedInputsScore, score, reaches, corroboratedBy, repeatOf } of rows) {
        describe(`${wording.originPublisher ?? wording.source} copy queued at ${wording.seenAt}`, () => {
          it('scores the logged inputs as production logged them', () => {
            // A tier-table fix changes what the logged inputs score today; the
            // wording then records the new score and why it moved.
            assert.equal(loggedInputsScore, wording.loggedInputsScoreNow ?? wording.observedScore);
            if (wording.loggedInputsScoreNow !== undefined) assert.ok(wording.loggedInputsScoreNowBecause, 'loggedInputsScoreNow needs loggedInputsScoreNowBecause');
          });
          it('scores and routes as today\'s code does', () => {
            assert.deepEqual(
              { score, reaches, corroboratedBy: [...corroboratedBy].sort(), repeatOf },
              {
                score: wording.scoreNow, reaches: wording.reaches, corroboratedBy: [...(wording.corroboratedBy ?? [])].sort(),
                repeatOf: wording.repeatOf ?? null,
              },
            );
          });
        });
      }

      // An alert counts when it reaches the edition's subscriber and the
      // reworded-repeat check does not skip it. An earlier alert kept in the
      // set as context never counts.
      const alerted = rows.some((r) => !r.wording.context && r.reaches === 'realtime' && !r.repeatOf);
      if (incident.knownMiss) {
        it(`still misses: ${incident.knownMiss}`, () => {
          assert.equal(alerted, false, 'the miss is fixed: drop knownMiss');
        });
      } else {
        it(`outcome is ${incident.expected}`, () => {
          assert.equal(alerted, incident.expected === 'alert');
        });
      }
    });
  }
});
