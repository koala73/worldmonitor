import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  latestStatusesByContext,
  planStatusLifecycle,
} from '../scripts/_github-status-lifecycle.mjs';

const failure = (description = 'STALE_SEED blocks operational acceptance') => ({
  context: 'ingestion/seed/example',
  state: 'failure',
  description,
});

describe('durable GitHub status lifecycle', () => {
  it('alerts once for a new failure and stays quiet while the exact incident is unchanged', () => {
    const first = planStatusLifecycle({ current: [failure()], previous: [] });
    assert.deepEqual(first.alerting.map((status) => status.context), ['ingestion/seed/example']);
    assert.deepEqual(first.updates, [failure()]);

    const repeated = planStatusLifecycle({ current: [failure()], previous: [failure()] });
    assert.deepEqual(repeated.alerting, []);
    assert.deepEqual(repeated.updates, [failure()]);
  });

  it('alerts again when the same source changes failure class', () => {
    const changed = planStatusLifecycle({
      current: [failure('EMPTY blocks operational acceptance')],
      previous: [failure()],
    });
    assert.deepEqual(changed.alerting.map((status) => status.context), ['ingestion/seed/example']);
  });

  it('does not fail a workflow for pending evidence and records recovery durably', () => {
    const pending = {
      context: 'ingestion/run/seed-example',
      state: 'pending',
      description: 'waiting for a real Railway execution',
    };
    assert.deepEqual(
      planStatusLifecycle({ current: [pending], previous: [] }).alerting,
      [],
    );

    const recovered = planStatusLifecycle({ current: [], previous: [failure()] });
    assert.deepEqual(recovered.alerting, []);
    assert.deepEqual(recovered.updates, [{
      context: 'ingestion/seed/example',
      state: 'success',
      description: 'recovered; no longer reported',
    }]);
  });

  it('uses the newest status for each context across the first-parent history', () => {
    const newest = failure('EMPTY blocks operational acceptance');
    const older = failure();
    const statuses = latestStatusesByContext([
      [newest],
      [{ context: 'gate', state: 'success', description: 'irrelevant' }, older],
    ], 'ingestion/');
    assert.deepEqual([...statuses.values()], [newest]);
  });
});
