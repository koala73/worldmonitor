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

const replays: Array<{ incident: Incident; missing: string[]; rows: Replayed[] }> = [];
for (const incident of incidents) {
  const matcher = recordedMatcher(incident);
  replays.push({ incident, missing: matcher.missing, rows: await replayIncident(incident, matcher) });
}

describe('alert replay set (#10976)', () => {
  for (const { incident, missing, rows } of replays) {
    describe(incident.id, () => {
      it('has a recorded matcher answer for every question the replay asks', () => {
        assert.deepEqual(missing, [], 'run tests/helpers/record-alert-replay-matches.mts');
      });

      for (const { wording, loggedInputsScore, score, reaches, corroboratedBy } of rows) {
        describe(`${wording.originPublisher ?? wording.source} copy queued at ${wording.seenAt}`, () => {
          it('scores the logged inputs as production logged them', () => {
            assert.equal(loggedInputsScore, wording.observedScore);
          });
          it('scores and routes as today\'s code does', () => {
            assert.deepEqual(
              { score, reaches, corroboratedBy: [...corroboratedBy].sort() },
              { score: wording.scoreNow, reaches: wording.reaches, corroboratedBy: [...(wording.corroboratedBy ?? [])].sort() },
            );
          });
        });
      }

      const alerted = rows.some((r) => r.reaches === 'realtime');
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
