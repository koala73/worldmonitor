// The browser may not import server code and the edge handler may not import
// browser code, so the gas model basis names and the LNG window label exist
// twice. A basis the handler emits but the panel does not know renders as
// "outdated model"; this keeps the two copies equal.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { GAS_MODEL_BASIS, formatLngWindow } from '../server/worldmonitor/intelligence/v1/_shock-compute.ts';
import { ASSUMED_ROUTE_BASIS, MEASURED_LNG_BASIS, SUPPORTED_GAS_MODEL_BASES, ZERO_LNG_BASIS, lngWindowLabel } from '../src/utils/gas-model-basis.ts';

test('the browser supports exactly the gas model bases the handler emits', () => {
  assert.deepEqual([...SUPPORTED_GAS_MODEL_BASES].sort(), Object.values(GAS_MODEL_BASIS).sort());
  assert.equal(MEASURED_LNG_BASIS, GAS_MODEL_BASIS.measured);
  assert.equal(ZERO_LNG_BASIS, GAS_MODEL_BASIS.zeroLng);
  assert.equal(ASSUMED_ROUTE_BASIS, GAS_MODEL_BASIS.assumed);
});

test('the browser labels an LNG window exactly as the handler does', () => {
  for (const b of [
    { basis: 'comtrade_monthly', fromMonth: '2025-02', toMonth: '2026-01' },
    { basis: 'comtrade_monthly', fromMonth: '2026-03', toMonth: '2026-03' },
    { basis: 'comtrade_annual', fromMonth: '2025-01', toMonth: '2025-12' },
  ] as const) {
    assert.equal(lngWindowLabel(b), formatLngWindow(b));
  }
});
