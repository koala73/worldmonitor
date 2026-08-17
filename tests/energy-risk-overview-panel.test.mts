import { strict as assert } from 'node:assert';
import { describe, test } from 'node:test';

import { buildOverviewState } from '../src/components/_energy-risk-overview-state.ts';

const NOW = 1735000000000;

function fulfilled<T>(value: T): PromiseFulfilledResult<T> {
  return { status: 'fulfilled', value };
}

function rejected(reason = new Error('test')): PromiseRejectedResult {
  return { status: 'rejected', reason };
}

describe('EnergyRiskOverviewPanel buildOverviewState', () => {
  test('maps four fulfilled sources to usable tile state', () => {
    const state = buildOverviewState(
      fulfilled({ status: 'open' }),
      fulfilled({ unavailable: false, fillPct: 75, fillPctChange1d: 0.5 }),
      fulfilled({ data: [{ price: 88.5, change: -0.3 }] }),
      fulfilled({ upstreamUnavailable: false, events: [{ endAt: null }, { endAt: '2026-01-01' }, { endAt: null }] }),
      NOW,
    );

    assert.deepEqual(Object.values(state).map(tile => tile.status), [
      'fulfilled',
      'fulfilled',
      'fulfilled',
      'fulfilled',
    ]);
    assert.equal(state.hormuz.value?.status, 'open');
    assert.equal(state.euGas.value?.fillPct, 75);
    assert.equal(state.brent.value?.price, 88.5);
    assert.equal(state.activeDisruptions.value?.count, 2);
    assert.equal(state.hormuz.fetchedAt, NOW);
  });

  test('isolates rejected sources without throwing or cascading', () => {
    const allRejected = buildOverviewState(
      rejected(),
      rejected(),
      rejected(),
      rejected(),
      NOW,
    );

    for (const tile of Object.values(allRejected)) {
      assert.equal(tile.status, 'rejected');
      assert.equal(tile.fetchedAt, undefined);
    }

    const oneRejected = buildOverviewState(
      rejected(),
      fulfilled({ unavailable: false, fillPct: 50, fillPctChange1d: 0 }),
      fulfilled({ data: [{ price: 80, change: 1 }] }),
      fulfilled({ upstreamUnavailable: false, events: [] }),
      NOW,
    );

    assert.deepEqual(Object.values(oneRejected).map(tile => tile.status), [
      'rejected',
      'fulfilled',
      'fulfilled',
      'fulfilled',
    ]);
  });

  test('treats unavailable or empty upstream payloads as rejected', () => {
    const state = buildOverviewState(
      fulfilled({} as { status?: string }),
      fulfilled({ unavailable: true, fillPct: 0, fillPctChange1d: 0 }),
      fulfilled({ data: [] }),
      fulfilled({ upstreamUnavailable: true, events: [] }),
      NOW,
    );

    assert.deepEqual(Object.values(state).map(tile => tile.status), [
      'rejected',
      'rejected',
      'rejected',
      'rejected',
    ]);
  });

  test('rejects zero gas fill and null Brent price sentinels', () => {
    const state = buildOverviewState(
      rejected(),
      fulfilled({ unavailable: false, fillPct: 0, fillPctChange1d: 0 }),
      fulfilled({ data: [{ price: null, change: 0 }] }),
      rejected(),
      NOW,
    );

    assert.equal(state.euGas.status, 'rejected');
    assert.equal(state.brent.status, 'rejected');
  });

  test('counts only ongoing disruptions', () => {
    const state = buildOverviewState(
      rejected(),
      rejected(),
      rejected(),
      fulfilled({
        upstreamUnavailable: false,
        events: [
          { endAt: null },
          { endAt: '2026-04-20' },
          { endAt: undefined },
          { endAt: '' },
          { endAt: null },
        ],
      }),
      NOW,
    );

    assert.equal(state.activeDisruptions.value?.count, 4);
  });
});
