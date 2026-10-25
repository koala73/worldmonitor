import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { dispatchToolsCall } from '../api/mcp/dispatch.ts';
import { OPERATOR_KEY_DAILY_CEILINGS } from '../server/_shared/high-usage-alarm.ts';
import { hashKeySync } from '../server/_shared/usage-identity.ts';
import { makePipelineMock } from './helpers/mcp-pro-deps.mjs';

// Operator keys (WORLDMONITOR_VALID_KEYS → MCP `env_key`) used to skip the
// daily counter entirely, so one leaked key had no ceiling. They now reserve on
// a per-key counter against OPERATOR_KEY_DAILY_CEILINGS.mcpUnits.

const OPERATOR_KEY = 'operator-ceiling-test-key';
const CONTEXT = { kind: 'env_key', apiKey: OPERATOR_KEY };
const TOOL = 'get_food_stocks';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

function stubData() {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return Response.json({ records: [{ countryCode: 'EG' }], unavailable: false });
  };
  return () => calls;
}

const call = (deps) => dispatchToolsCall(
  new Request('https://worldmonitor.app/mcp'),
  CONTEXT,
  deps,
  { id: 7, params: { name: TOOL, arguments: { country_code: 'EG' } } },
  {},
);

describe('MCP operator-key daily ceiling', () => {
  it('charges one unit per call on a per-key counter keyed on the hashed key', async () => {
    stubData();
    const mock = makePipelineMock();
    const response = await call({ redisPipeline: mock.pipeline });
    const body = await response.json();
    assert.equal(body.error, undefined, JSON.stringify(body.error));
    assert.equal(mock.count, 1);
    const reservation = mock.ops.flat().find((cmd) => cmd[0] === 'EVAL' && Number(cmd[2]) === 2);
    assert.ok(reservation, 'expected a reserveQuota EVAL');
    const keys = reservation.slice(3, 5).join(' ');
    assert.match(keys, new RegExp(`env_key:${hashKeySync(OPERATOR_KEY)}`));
    assert.doesNotMatch(keys, new RegExp(OPERATOR_KEY), 'the raw key must never become a Redis key');
    assert.equal(Number(reservation[5]), OPERATOR_KEY_DAILY_CEILINGS.mcpUnits);
  });

  it('rejects with the quota envelope once the ceiling is spent, before any data fetch', async () => {
    const fetches = stubData();
    const mock = makePipelineMock({ initialCount: OPERATOR_KEY_DAILY_CEILINGS.mcpUnits });
    const response = await call({ redisPipeline: mock.pipeline });
    const body = await response.json();
    assert.equal(response.status, 429);
    assert.equal(body.error?.code, -32029);
    assert.ok(response.headers.get('Retry-After'));
    assert.equal(fetches(), 0);
  });

  it('fails open when the counter cannot be read, like the env_key per-minute limiter', async () => {
    const fetches = stubData();
    const mock = makePipelineMock({ throwOnEval: true });
    const response = await call({ redisPipeline: mock.pipeline });
    const body = await response.json();
    assert.equal(body.error, undefined, JSON.stringify(body.error));
    assert.equal(fetches(), 1);
  });
});
