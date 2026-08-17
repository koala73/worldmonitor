import assert from 'node:assert/strict';
import test from 'node:test';

import { reportEntitlementDesync } from '@/services/entitlement-desync-telemetry';

test('reports the client-asserted desync as a bounded, countable analytics event', () => {
  const calls: Array<{ event: string; data?: Record<string, unknown> }> = [];

  reportEntitlementDesync('latest-brief', (event, data) => calls.push({ event, data }));

  assert.deepEqual(calls, [{
    event: 'entitlement-desync',
    data: { verdict: 'entitlement_desync', panel: 'latest-brief' },
  }]);
});
