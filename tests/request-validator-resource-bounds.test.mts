import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { validateGeneratedRequest } from '../server/request-validator.ts';
import {
  createBatchServiceRoutes,
  type BatchServiceHandler,
} from '../src/generated/server/worldmonitor/batch/v1/service_server.ts';
import {
  createConflictServiceRoutes,
  type ConflictServiceHandler,
} from '../src/generated/server/worldmonitor/conflict/v1/service_server.ts';
import {
  createEconomicServiceRoutes,
  type EconomicServiceHandler,
} from '../src/generated/server/worldmonitor/economic/v1/service_server.ts';

const options = { validateRequest: validateGeneratedRequest };
const cases = [
  {
    method: 'getHumanitarianSummaryBatch', field: 'countryCodes', maximum: 25,
    path: '/api/conflict/v1/get-humanitarian-summary-batch', validItem: 'US',
    routes: (call: () => Promise<never>) => createConflictServiceRoutes(
      { getHumanitarianSummaryBatch: call } as unknown as ConflictServiceHandler, options,
    ),
  },
  {
    method: 'getFredSeriesBatch', field: 'seriesIds', maximum: 20,
    path: '/api/economic/v1/get-fred-series-batch', validItem: 'GDP',
    routes: (call: () => Promise<never>) => createEconomicServiceRoutes(
      { getFredSeriesBatch: call } as unknown as EconomicServiceHandler, options,
    ),
  },
  {
    method: 'executeBatch', field: 'operations', maximum: 20,
    path: '/api/batch/v1/execute', validItem: { id: 'a', path: '/api/market/v1/list-market-quotes' },
    routes: (call: () => Promise<never>) => createBatchServiceRoutes(
      { executeBatch: call } as BatchServiceHandler, options,
    ),
  },
];

describe('request validation resource bounds', () => {
  for (const scenario of cases) {
    it(`returns one size violation for a large ${scenario.field} POST`, async () => {
      let calls = 0;
      const route = scenario.routes(async () => {
        calls += 1;
        throw new Error('invalid requests must not reach the handler');
      }).find(({ path }) => path === scenario.path);
      assert.ok(route);

      const response = await route.handler(new Request(`https://www.worldmonitor.app${scenario.path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [scenario.field]: Array(100_000).fill(0) }),
      }));

      assert.equal(response.status, 400);
      const text = await response.text();
      const body = JSON.parse(text);
      assert.equal(calls, 0);
      assert.equal(body.violations.length, 1);
      assert.deepEqual(body.violations[0], {
        field: scenario.field,
        description: `array must contain at most ${scenario.maximum} item(s)`,
      });
      assert.ok(text.length < 256, `error response must remain compact, got ${text.length} characters`);
    });

    it(`preserves ${scenario.field} validation at its exact maximum`, () => {
      assert.equal(validateGeneratedRequest(scenario.method, {
        [scenario.field]: Array(scenario.maximum).fill(scenario.validItem),
      }), undefined);
      const violations = validateGeneratedRequest(scenario.method, {
        [scenario.field]: Array(scenario.maximum).fill(0),
      });
      assert.ok(violations);
      assert.equal(violations.length, scenario.maximum);
      assert.equal(violations[0].field, `${scenario.field}[0]`);
      assert.equal(violations.at(-1)?.field, `${scenario.field}[${scenario.maximum - 1}]`);
    });
  }

  it('rejects an oversized unique array before reading its items', () => {
    const metals = ['gold', 'silver', 'gold'];
    Object.defineProperty(metals, 0, {
      get() { throw new Error('oversized array items must not be read'); },
    });
    assert.deepEqual(validateGeneratedRequest('getPhysicalPremiums', { metals }), [
      { field: 'metals', description: 'array must contain at most 2 item(s)' },
    ]);
    assert.ok(validateGeneratedRequest('getPhysicalPremiums', { metals: ['gold', 'gold'] })
      ?.some(({ description }) => description === 'array items must be unique'));
  });

  it('shares the 100-violation budget across uncapped arrays and stops traversal', () => {
    const request = {
      provider: 'openrouter',
      headlines: Array(60).fill(0),
      mode: '', geoContext: '', variant: '', lang: '', systemAppend: '',
      bodies: Array(100).fill(0),
    };
    Object.defineProperty(request.bodies, 40, {
      get() { throw new Error('array traversal must stop at the violation budget'); },
    });
    const violations = validateGeneratedRequest('summarizeArticle', request);
    assert.ok(violations);
    assert.equal(violations.length, 100);
    assert.equal(violations[59].field, 'headlines[59]');
    assert.equal(violations[99].field, 'bodies[39]');
  });

  it('stops nested message fields and array items when the request budget is exhausted', () => {
    const last = { type: '' };
    Object.defineProperty(last, 'region', {
      get() { throw new Error('nested message traversal must stop at the violation budget'); },
    });
    const updates = [...Array.from({ length: 49 }, () => ({})), { type: '', region: 'global' }, last];
    Object.defineProperty(updates, 51, {
      get() { throw new Error('nested array traversal must stop at the violation budget'); },
    });
    const violations = validateGeneratedRequest('recordBaselineSnapshot', { updates });
    assert.ok(violations);
    assert.equal(violations.length, 100);
    assert.equal(violations[99].field, 'updates[50].type');
  });

  it('does not exceed the budget when a scalar violates multiple rules', () => {
    const updates = [
      ...Array.from({ length: 49 }, () => ({})),
      { type: '', region: 'x'.repeat(65_537) },
    ];
    const violations = validateGeneratedRequest('recordBaselineSnapshot', { updates });
    assert.ok(violations);
    assert.equal(violations.length, 100);
    assert.equal(violations[99].field, 'updates[49].region');
    assert.equal(validateGeneratedRequest('recordBaselineSnapshot', {
      updates: [{ type: 'test', region: 'global' }],
    }), undefined);
  });
});
