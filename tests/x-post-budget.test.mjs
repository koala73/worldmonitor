import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createXPostBudget,
  assertXPostBudgetAdmission,
  isXPostReturningUrl,
  ACK_RECEIPTS_LUA,
  SETTLE_LUA,
  STATUS_LUA,
  MAX_RECEIPT_BYTES,
  DEFAULT_X_CURATED_DAILY_COVERAGE_POSTS,
  DEFAULT_X_POST_DAILY_LIMIT,
  DEFAULT_X_POST_MONTHLY_LIMIT,
  X_POST_COST_USD_MICROS,
  xPostBudgetServiceStatus,
} from '../scripts/lib/x-post-budget.cjs';

const NOW = Date.parse('2026-09-02T12:00:00.000Z');

describe('X Post transport admission', () => {
  it('classifies Post-returning routes without blocking User routes', () => {
    assert.equal(isXPostReturningUrl('https://api.x.com/2/tweets'), true);
    assert.equal(isXPostReturningUrl('https://api.x.com/2/tweets/search/recent'), true);
    assert.equal(isXPostReturningUrl('https://api.x.com/2/users/123/tweets'), true);
    assert.equal(isXPostReturningUrl('https://api.x.com/2/users/123/timelines/reverse_chronological'), true);
    assert.equal(isXPostReturningUrl('https://api.x.com/2/spaces/1DXxyRYNejbKM/tweets'), true);
    assert.equal(isXPostReturningUrl('https://api.x.com/2/users//tweets'), false);
    assert.equal(isXPostReturningUrl('https://api.x.com/2/users/123'), false);
    assert.equal(isXPostReturningUrl('https://example.com/2/tweets'), false);
  });

  it('gives one reserved execution one Post transport admission', async () => {
    let evalCalls = 0;
    let fetches = 0;
    const budget = createXPostBudget({
      evalCommand: async () => {
        evalCalls += 1;
        return [1, 10, 10, 0, 0, ''];
      },
      now: () => NOW,
      idFactory: () => 'single-transport',
    });
    const guardedFetch = (admission) => {
      assertXPostBudgetAdmission('https://api.x.com/2/tweets', admission);
      fetches += 1;
      return Response.json({ data: [] });
    };

    await assert.rejects(
      () => budget.withReturnedPosts({
        consumer: 'test',
        operation: 'timeline',
        requestedPosts: 10,
        execute: async (_reservation, admission) => {
          guardedFetch(admission);
          return guardedFetch(admission);
        },
      }),
      /requires unused shared budget admission/,
    );
    assert.equal(fetches, 1);
    assert.equal(evalCalls, 1, 'a rejected second transport never reaches settlement');
    assert.doesNotThrow(() => assertXPostBudgetAdmission('https://api.x.com/2/users/123'));
  });
});

describe('shared X returned-Post budget', () => {
  it('reports budget exhaustion or an inadmissible next request as degraded', () => {
    assert.equal(DEFAULT_X_CURATED_DAILY_COVERAGE_POSTS, 505);
    assert.equal(xPostBudgetServiceStatus({ available: true, exhausted: false }), 'ok');
    assert.equal(xPostBudgetServiceStatus({ available: true, exhausted: false, nextRequestAdmissible: false }), 'degraded');
    assert.equal(xPostBudgetServiceStatus({ available: true, exhausted: true }), 'degraded');
    assert.equal(xPostBudgetServiceStatus({ available: false, exhausted: false }), 'degraded');
  });

  it('owns the reserve, request, raw-count settlement sequence', async () => {
    const calls = [];
    const budget = createXPostBudget({
      evalCommand: async (script, keys, args) => {
        calls.push({ script, keys, args });
        return calls.length === 1 ? [1, 10, 10, 0, 0] : [1, 2, 2, 10, 2, 0];
      },
      now: () => NOW,
      idFactory: () => 'owned-lifecycle',
    });

    const outcome = await budget.withReturnedPosts({
      consumer: 'curated-feed',
      operation: 'timeline',
      requestedPosts: 10,
      execute: async (admission) => {
        assert.equal(admission.reservation.period.day, '2026-09-02');
        return {
          response: { ok: true },
          body: { data: [{ id: '1' }, { id: '2' }] },
        };
      },
    });

    assert.equal(outcome.allowed, true);
    assert.equal(outcome.completed, true);
    assert.equal(outcome.returnedPosts, 2);
    assert.equal(outcome.status.dailyUsed, 2);
    assert.equal(calls.length, 2);
  });

  it('retains the full reservation when the response cannot be counted safely', async () => {
    const calls = [];
    const budget = createXPostBudget({
      evalCommand: async (script, keys, args) => {
        calls.push({ script, keys, args });
        if (script === ACK_RECEIPTS_LUA) return 1;
        return [1, 10, 10, 0, 0];
      },
      now: () => NOW,
      idFactory: () => 'uncountable',
    });

    const outcome = await budget.withReturnedPosts({
      consumer: 'curated-feed',
      operation: 'timeline',
      requestedPosts: 10,
      receiptScope: 'list:123',
      execute: async () => ({ response: { ok: true }, body: { data: 'not-an-array' } }),
    });

    assert.equal(outcome.allowed, true);
    assert.equal(outcome.completed, false);
    assert.equal(outcome.reason, 'unsettled_response');
    assert.equal(calls.some(({ script }) => script === SETTLE_LUA), false,
      'an unsafe response must not run the refund script');
    assert.deepEqual(calls.at(-1).keys, ['intelligence:x-post-budget:v1:receipt-inflight:list-123:none']);
    assert.deepEqual(calls.at(-1).args, ['intelligence:x-post-budget:v1:reservation:uncountable']);
    assert.equal(outcome.status.dailyUsed, 10);
  });

  it('releases only its receipt-scope lock after an unknown transport outcome', async () => {
    const calls = [];
    const budget = createXPostBudget({
      evalCommand: async (script, keys, args) => {
        calls.push({ script, keys, args });
        if (script === ACK_RECEIPTS_LUA) return 1;
        return [1, 5, 5, 0, 500, ''];
      },
      now: () => NOW,
      idFactory: () => 'transport-unknown',
    });

    await assert.rejects(() => budget.withReturnedPosts({
      consumer: 'curated-feed',
      operation: 'list-feed',
      requestedPosts: 5,
      coverageTotal: 505,
      coverageId: 'list-slot:2026-09-02T12:00:00.000Z',
      coverageUnitPosts: 5,
      receiptScope: 'list:123',
      execute: async () => { throw new Error('socket reset'); },
    }), /socket reset/);

    assert.equal(calls.length, 2);
    assert.equal(calls[1].script, ACK_RECEIPTS_LUA);
    assert.deepEqual(calls[1].keys, [
      'intelligence:x-post-budget:v1:receipt-inflight:list-123:list-slot-2026-09-02T12-00-00-000Z',
    ]);
    assert.deepEqual(calls[1].args, ['intelligence:x-post-budget:v1:reservation:transport-unknown']);
  });

  it('settles a completed non-success response at zero without publishing a replay receipt', async () => {
    const calls = [];
    const budget = createXPostBudget({
      evalCommand: async (script, keys, args) => {
        calls.push({ script, keys, args });
        return calls.length === 1 ? [1, 10, 10, 0, 0, ''] : [1, 0, 0, 10, 0, 0];
      },
      now: () => NOW,
      idFactory: () => 'failed-response',
    });

    const outcome = await budget.withReturnedPosts({
      consumer: 'curated-feed',
      operation: 'timeline',
      requestedPosts: 10,
      receiptScope: 'timeline:1652541',
      execute: async () => ({ response: { ok: false, status: 503 }, body: null }),
      receiptFromResult: () => ({ version: 1, body: 'must not be replayed' }),
    });

    assert.equal(outcome.allowed, true);
    assert.equal(outcome.completed, true);
    assert.equal(outcome.returnedPosts, 0);
    assert.equal(outcome.receipt, undefined);
    assert.equal(outcome.receiptAck, undefined);
    assert.equal(outcome.status.dailyUsed, 0);
    assert.equal(calls.length, 2, 'a known failed response must run settlement');
  });

  it('returns a pending paid receipt without executing another X request', async () => {
    const receipt = {
      version: 1,
      accountId: '1652541',
      sinceId: '100',
      body: { data: [{ id: '1999999999999999999' }] },
    };
    let executed = false;
    const budget = createXPostBudget({
      evalCommand: async () => [0, 1, 1, 4, 0, JSON.stringify(receipt)],
      now: () => NOW,
      idFactory: () => 'replay',
      keyPrefix: 'test:x-posts',
    });

    const outcome = await budget.withReturnedPosts({
      consumer: 'curated-feed',
      operation: 'timeline',
      requestedPosts: 10,
      receiptScope: 'timeline:1652541',
      execute: async () => { executed = true; },
    });

    assert.equal(executed, false);
    assert.equal(outcome.allowed, true);
    assert.equal(outcome.reusedReceipt, true);
    assert.equal(outcome.receipt.body.data[0].id, '1999999999999999999');
    assert.equal(outcome.returnedPosts, 0);
    assert.equal(outcome.receiptAck.key, 'test:x-posts:receipt:timeline-1652541');
  });

  it('returns an acknowledgement for a malformed pending receipt without calling X', async () => {
    let executed = false;
    const budget = createXPostBudget({
      evalCommand: async () => [0, 1, 1, 4, 0, '{not-json'],
      now: () => NOW,
      idFactory: () => 'malformed-replay',
    });
    const outcome = await budget.withReturnedPosts({
      consumer: 'curated-feed',
      operation: 'timeline',
      requestedPosts: 10,
      receiptScope: 'timeline:1652541',
      execute: async () => { executed = true; },
    });

    assert.equal(executed, false);
    assert.equal(outcome.allowed, true);
    assert.equal(outcome.completed, true);
    assert.equal(outcome.reusedReceipt, true);
    assert.equal(outcome.receipt, null);
    assert.equal(outcome.reason, 'invalid_pending_receipt');
    assert.equal(outcome.receiptAck.expected, '{not-json');
  });

  it('keeps the full reservation when a receipt exceeds its size bound', async () => {
    const scripts = [];
    const budget = createXPostBudget({
      evalCommand: async (script) => {
        scripts.push(script);
        if (script === STATUS_LUA) return [10, 10, 0, 0, ''];
        if (script === ACK_RECEIPTS_LUA) return 1;
        return [1, 10, 10, 0, 0, ''];
      },
      now: () => NOW,
      idFactory: () => 'oversized-receipt',
    });
    const outcome = await budget.withReturnedPosts({
      consumer: 'curated-feed',
      operation: 'timeline',
      requestedPosts: 10,
      receiptScope: 'timeline:1652541',
      execute: async () => ({ response: { ok: true }, body: { data: [{ id: '101' }] } }),
      receiptFromResult: () => ({ version: 1, body: 'x'.repeat(MAX_RECEIPT_BYTES + 1) }),
    });

    assert.equal(outcome.completed, false);
    assert.equal(outcome.reason, 'invalid_receipt');
    assert.equal(outcome.status.dailyUsed, 10);
    assert.equal(scripts.includes(SETTLE_LUA), false, 'invalid receipt bytes must not run the refund script');
    assert.equal(scripts.includes(ACK_RECEIPTS_LUA), true, 'the unusable receipt must release its scope lock');
  });

  it('acknowledges receipts with an exact compare-and-delete script', async () => {
    const calls = [];
    const budget = createXPostBudget({
      evalCommand: async (script, keys, args) => {
        calls.push({ script, keys, args });
        return 1;
      },
      keyPrefix: 'test:x-posts',
    });
    const receipt = {
      key: 'test:x-posts:receipt:timeline-1652541',
      expected: '{"version":1}',
    };

    assert.equal(await budget.ackReceipts([receipt]), true);
    assert.equal(calls[0].script, ACK_RECEIPTS_LUA);
    assert.deepEqual(calls[0].keys, [receipt.key]);
    assert.deepEqual(calls[0].args, [receipt.expected]);
  });

  it('reports a conflicting settlement separately from an invalid count', async () => {
    const budget = createXPostBudget({
      evalCommand: async () => [-2, 3, 3, 0, 3, 0],
      now: () => NOW,
    });
    const settlement = await budget.settle({
      id: 'conflict',
      reservedPosts: 10,
      period: {
        day: '2026-09-02',
        month: '2026-09',
        dayExpiresAtSeconds: 1_788_566_400,
      },
    }, 4);
    assert.equal(settlement.settled, false);
    assert.equal(settlement.reason, 'settlement_conflict');
  });

  it('reserves day and month capacity atomically and settles unused capacity', async () => {
    const calls = [];
    const responses = [
      [1, 10, 110, 0, 562],
      [1, 3, 103, 10, 3, 562],
      [3, 103, 562, 1, 'fixed-slots-v1:572'],
    ];
    const budget = createXPostBudget({
      evalCommand: async (script, keys, args) => {
        calls.push({ script, keys, args });
        return responses.shift();
      },
      now: () => NOW,
      idFactory: () => 'reservation-1',
      keyPrefix: 'test:x-posts',
    });

    const admitted = await budget.reserve({
      consumer: 'curated-feed',
      operation: 'timeline',
      requestedPosts: 10,
      coverageTotal: 572,
      coverageId: 'timeline:1652541',
      coverageUnitPosts: 10,
    });
    assert.equal(admitted.allowed, true);
    assert.equal(admitted.reservation.id, 'reservation-1');
    assert.equal(admitted.status.dailyUsed, 10);
    assert.equal(admitted.status.monthlyUsed, 110);
    assert.equal(admitted.status.monthlyCostUsdMicros, 110 * X_POST_COST_USD_MICROS);
    assert.deepEqual(calls[0].keys, [
      'test:x-posts:day:2026-09-02',
      'test:x-posts:month:2026-09',
      'test:x-posts:reservation:reservation-1',
      'test:x-posts:once:2026-09-02:curated-feed:timeline',
      'test:x-posts:coverage-held:2026-09-02',
      'test:x-posts:coverage-accounted:2026-09-02:timeline-1652541',
      'test:x-posts:receipt:none',
      'test:x-posts:receipt-inflight:none:timeline-1652541',
      'test:x-posts:coverage-model:2026-09-02',
    ]);
    assert.deepEqual(calls[0].args.slice(0, 4), [
      '10',
      '572',
      String(DEFAULT_X_POST_DAILY_LIMIT),
      String(DEFAULT_X_POST_MONTHLY_LIMIT),
    ]);

    const settled = await budget.settle(admitted.reservation, 3);
    assert.equal(settled.settled, true);
    assert.equal(settled.status.dailyUsed, 3);
    assert.equal(settled.status.monthlyUsed, 103);
    assert.equal(calls[1].args[0], '3');

    const status = await budget.status();
    assert.equal(status.available, true);
    assert.equal(status.dailyRemaining, DEFAULT_X_POST_DAILY_LIMIT - 3);
    assert.equal(status.dailyCoverageHeld, 562);
    assert.equal(status.dailySpendableRemaining, 35);
    assert.equal(status.monthlyRemaining, DEFAULT_X_POST_MONTHLY_LIMIT - 103);
  });

  it('reports whether the next fixed-size request fits after converting its held coverage', async () => {
    const dailyUsed = [95, 96];
    const budget = createXPostBudget({
      evalCommand: async () => [
        dailyUsed.shift(),
        10_000,
        DEFAULT_X_CURATED_DAILY_COVERAGE_POSTS,
        1,
        `fixed-slots-v1:${DEFAULT_X_CURATED_DAILY_COVERAGE_POSTS}`,
      ],
      dailyCoveragePosts: DEFAULT_X_CURATED_DAILY_COVERAGE_POSTS,
      now: () => NOW,
    });

    const exact = await budget.status({ requestedPosts: 5, coverageUnitPosts: 5 });
    assert.equal(exact.nextRequestAdmissible, true);
    assert.equal(exact.nextRequestDailyProjected, DEFAULT_X_POST_DAILY_LIMIT);

    const over = await budget.status({ requestedPosts: 5, coverageUnitPosts: 5 });
    assert.equal(over.nextRequestAdmissible, false);
    assert.equal(xPostBudgetServiceStatus(over), 'degraded');
  });

  it('projects the full daily coverage hold before its first reservation', async () => {
    const usage = [
      [95, 19_495],
      [96, 19_496],
    ];
    const budget = createXPostBudget({
      evalCommand: async () => {
        const [dailyUsed, monthlyUsed] = usage.shift();
        return [dailyUsed, monthlyUsed, 0, 0, ''];
      },
      dailyCoveragePosts: DEFAULT_X_CURATED_DAILY_COVERAGE_POSTS,
      now: () => NOW,
    });

    const exact = await budget.status({ requestedPosts: 5, coverageUnitPosts: 5 });
    assert.equal(exact.dailyCoverageHeld, DEFAULT_X_CURATED_DAILY_COVERAGE_POSTS);
    assert.equal(exact.nextRequestDailyProjected, DEFAULT_X_POST_DAILY_LIMIT);
    assert.equal(exact.nextRequestMonthlyProjected, DEFAULT_X_POST_MONTHLY_LIMIT);
    assert.equal(exact.nextRequestAdmissible, true);

    const over = await budget.status({ requestedPosts: 5, coverageUnitPosts: 5 });
    assert.equal(over.nextRequestDailyProjected, DEFAULT_X_POST_DAILY_LIMIT + 1);
    assert.equal(over.nextRequestMonthlyProjected, DEFAULT_X_POST_MONTHLY_LIMIT + 1);
    assert.equal(over.nextRequestAdmissible, false);
  });

  it('reports a legacy coverage hold as not admissible before cutover', async () => {
    const budget = createXPostBudget({
      evalCommand: async () => [0, 0, DEFAULT_X_CURATED_DAILY_COVERAGE_POSTS, 1, ''],
      dailyCoveragePosts: DEFAULT_X_CURATED_DAILY_COVERAGE_POSTS,
      now: () => NOW,
    });

    const status = await budget.status({ requestedPosts: 5, coverageUnitPosts: 5 });
    assert.equal(status.available, true);
    assert.equal(status.nextRequestAdmissible, false);
    assert.equal(status.nextRequestBlockedReason, 'coverage_model_mismatch');
    assert.equal(xPostBudgetServiceStatus(status), 'degraded');
  });

  it('reports a lower same-day fixed-slots model as admissible', async () => {
    const budget = createXPostBudget({
      evalCommand: async () => [5, 105, 592, 1, 'fixed-slots-v1:597'],
      dailyCoveragePosts: DEFAULT_X_CURATED_DAILY_COVERAGE_POSTS,
      now: () => NOW,
    });

    const status = await budget.status({ requestedPosts: 5, coverageUnitPosts: 5 });
    assert.equal(status.dailyCoverageHeld, 500);
    assert.equal(status.nextRequestAdmissible, true);
    assert.equal(status.nextRequestDailyProjected, 505);
    assert.equal(status.nextRequestMonthlyProjected, 605);
    assert.equal(status.nextRequestBlockedReason, undefined);
    assert.equal(xPostBudgetServiceStatus(status), 'ok');
  });

  it('keeps an upward same-day fixed-slots change blocked', async () => {
    const budget = createXPostBudget({
      evalCommand: async () => [5, 105, 495, 1, 'fixed-slots-v1:500'],
      dailyCoveragePosts: DEFAULT_X_CURATED_DAILY_COVERAGE_POSTS,
      now: () => NOW,
    });

    const status = await budget.status({ requestedPosts: 5, coverageUnitPosts: 5 });
    assert.equal(status.nextRequestAdmissible, false);
    assert.equal(status.nextRequestBlockedReason, 'coverage_model_mismatch');
    assert.equal(xPostBudgetServiceStatus(status), 'degraded');
  });

  it('blocks the same unsafe coverage states as reserve', async () => {
    const cases = [
      ['upward model', [5, 105, 495, 1, 'fixed-slots-v1:500']],
      ['cross-version model', [5, 105, 592, 1, 'fixed-slots-v2:597']],
      ['malformed model', [5, 105, 592, 1, 'not-a-model']],
      ['hold without model', [5, 105, 592, -1, '']],
      ['model without hold', [5, 105, 0, -1, 'fixed-slots-v1:597']],
      ['noncanonical model', [5, 105, 592, 1, 'fixed-slots-v1:0597']],
      ['noncanonical hold', [5, 105, 0, -1, 'fixed-slots-v1:597']],
      ['negative hold', [5, 105, 0, -1, 'fixed-slots-v1:597']],
      ['fractional hold', [5, 105, 0, -1, 'fixed-slots-v1:597']],
      ['hold over stored total', [5, 105, 598, 1, 'fixed-slots-v1:597']],
      ['spent Posts over new total', [5, 105, 91, 1, 'fixed-slots-v1:597']],
      ['effective hold below the unit', [5, 105, 96, 1, 'fixed-slots-v1:597']],
    ];

    for (const [label, redisStatus] of cases) {
      const budget = createXPostBudget({
        evalCommand: async () => redisStatus,
        dailyCoveragePosts: DEFAULT_X_CURATED_DAILY_COVERAGE_POSTS,
        now: () => NOW,
      });
      const status = await budget.status({ requestedPosts: 5, coverageUnitPosts: 5 });
      assert.equal(status.nextRequestAdmissible, false, label);
      assert.equal(status.nextRequestBlockedReason, 'coverage_model_mismatch', label);
      assert.equal(xPostBudgetServiceStatus(status), 'degraded', label);
    }
  });

  it('keeps malformed reserve states classified as coverage model mismatches', async () => {
    for (const invalidHold of [-1, 592.5]) {
      const budget = createXPostBudget({
        evalCommand: async () => [0, 5, 105, 6, invalidHold, ''],
        dailyCoveragePosts: DEFAULT_X_CURATED_DAILY_COVERAGE_POSTS,
        now: () => NOW,
      });
      const outcome = await budget.reserve({
        requestedPosts: 5,
        coverageTotal: DEFAULT_X_CURATED_DAILY_COVERAGE_POSTS,
        coverageUnitPosts: 5,
        coverageId: `malformed-${invalidHold}`,
      });
      assert.equal(outcome.allowed, false);
      assert.equal(outcome.reason, 'coverage_model_mismatch');
      assert.equal(xPostBudgetServiceStatus(outcome.status), 'degraded');
    }
  });

  it('reports the binding limit without creating a reservation', async () => {
    const calls = [];
    const budget = createXPostBudget({
      evalCommand: async (script, keys, args) => {
        calls.push({ script, keys, args });
        return [0, 599, 4_000, 1, 0];
      },
      now: () => NOW,
      idFactory: () => 'denied',
    });

    const denied = await budget.reserve({
      consumer: 'curated-feed',
      operation: 'timeline',
      requestedPosts: 10,
    });
    assert.equal(denied.allowed, false);
    assert.equal(denied.reason, 'daily_limit');
    assert.equal(denied.reservation, undefined);
    assert.equal(denied.status.dailyUsed, 599);
    assert.equal(calls.length, 1);
  });

  it('reports a monthly-only limit without creating a reservation', async () => {
    const budget = createXPostBudget({
      evalCommand: async () => [0, 100, 19_991, 2, 0],
      now: () => NOW,
      idFactory: () => 'monthly-denied',
    });

    const denied = await budget.reserve({
      consumer: 'curated-feed',
      operation: 'timeline',
      requestedPosts: 10,
    });
    assert.equal(denied.allowed, false);
    assert.equal(denied.reason, 'monthly_limit');
    assert.equal(denied.reservation, undefined);
    assert.equal(denied.status.monthlyUsed, 19_991);
  });

  it('passes the configured 505-Post curated hold on a non-curated request', async () => {
    const calls = [];
    const budget = createXPostBudget({
      evalCommand: async (script, keys, args) => {
        calls.push({ script, keys, args });
        return [0, 0, 0, 1, DEFAULT_X_CURATED_DAILY_COVERAGE_POSTS];
      },
      dailyCoveragePosts: DEFAULT_X_CURATED_DAILY_COVERAGE_POSTS,
      now: () => NOW,
      idFactory: () => 'company-first',
    });

    const denied = await budget.reserve({
      consumer: 'company-monitoring',
      operation: 'recent-search',
      requestedPosts: 95,
    });
    assert.equal(denied.allowed, false);
    assert.equal(calls[0].args[1], String(DEFAULT_X_CURATED_DAILY_COVERAGE_POSTS));
    assert.equal(calls[0].args[9], '0');
  });

  it('never configures a coverage hold above the daily hard cap', async () => {
    const calls = [];
    const budget = createXPostBudget({
      evalCommand: async (script, keys, args) => {
        calls.push({ script, keys, args });
        return [0, 0, 0, 1, 100];
      },
      dailyLimit: 100,
      dailyCoveragePosts: DEFAULT_X_CURATED_DAILY_COVERAGE_POSTS,
      now: () => NOW,
    });

    await budget.reserve({
      consumer: 'company-monitoring',
      operation: 'recent-search',
      requestedPosts: 10,
    });
    assert.equal(calls[0].args[1], '100');
  });

  it('fails closed when the shared Redis budget cannot be read', async () => {
    const budget = createXPostBudget({
      evalCommand: async () => null,
      now: () => NOW,
      idFactory: () => 'unavailable',
    });

    const denied = await budget.reserve({
      consumer: 'curated-feed',
      operation: 'timeline',
      requestedPosts: 10,
    });
    assert.equal(denied.allowed, false);
    assert.equal(denied.reason, 'budget_unavailable');
    assert.equal(denied.status.available, false);
  });
});

describe('X Post budget inflight release on settlement failure', () => {
  const NOW_LOCAL = Date.parse('2026-09-02T12:00:00.000Z');

  it('releases its receipt-scope lock when settlement conflicts', async () => {
    // The conflict path reached only through withReturnedPosts: settle() returning
    // -2 leaves the reservation unsettled, and without the release the slot's
    // inflight lock would sit until its own TTL, blocking the replay that is
    // supposed to recover the paid page on the next slot. The pre-existing
    // settlement_conflict test calls settle() directly and never reaches here.
    const calls = [];
    const budget = createXPostBudget({
      evalCommand: async (script, keys, args) => {
        calls.push({ script, keys, args });
        if (script === ACK_RECEIPTS_LUA) return 1;
        if (script === SETTLE_LUA) return [-2, 5, 5, 0, 4, 500];
        if (script === STATUS_LUA) return [5, 5, 500, 1, 'fixed-slots-v1:505'];
        return [1, 5, 5, 0, 500, ''];
      },
      now: () => NOW_LOCAL,
      idFactory: () => 'settle-conflict-release',
    });

    const outcome = await budget.withReturnedPosts({
      consumer: 'curated-feed',
      operation: 'list-feed',
      requestedPosts: 5,
      coverageTotal: 505,
      coverageId: 'list-slot:2026-09-02T12:00:00.000Z',
      coverageUnitPosts: 5,
      receiptScope: 'list:123',
      receiptFromResult: () => ({ version: 1, listId: '123', posts: [] }),
      execute: async () => ({
        response: { ok: true, status: 200 },
        body: { data: [{ id: '1' }, { id: '2' }], meta: { result_count: 2 } },
      }),
    });

    assert.equal(outcome.allowed, true);
    assert.equal(outcome.completed, false, 'a conflicting settlement is not a completion');
    const acks = calls.filter((call) => call.script === ACK_RECEIPTS_LUA);
    assert.equal(acks.length, 1, 'the inflight lock must be released exactly once');
    assert.deepEqual(acks[0].args, [
      'intelligence:x-post-budget:v1:reservation:settle-conflict-release',
    ]);
  });

  it('releases its receipt-scope lock when the response over-returns its reservation', async () => {
    const calls = [];
    const budget = createXPostBudget({
      evalCommand: async (script, keys, args) => {
        calls.push({ script, keys, args });
        if (script === ACK_RECEIPTS_LUA) return 1;
        if (script === STATUS_LUA) return [5, 5, 500, 1, 'fixed-slots-v1:505'];
        return [1, 5, 5, 0, 500, ''];
      },
      now: () => NOW_LOCAL,
      idFactory: () => 'over-return-release',
    });

    const outcome = await budget.withReturnedPosts({
      consumer: 'curated-feed',
      operation: 'list-feed',
      requestedPosts: 5,
      coverageTotal: 505,
      coverageId: 'list-slot:2026-09-02T12:00:00.000Z',
      coverageUnitPosts: 5,
      receiptScope: 'list:123',
      execute: async () => ({
        response: { ok: true, status: 200 },
        body: { data: Array.from({ length: 9 }, (_, i) => ({ id: String(i) })) },
      }),
    });

    assert.equal(outcome.completed, false);
    assert.equal(calls.filter((call) => call.script === ACK_RECEIPTS_LUA).length, 1);
  });
});
