import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { VARIANT_FEEDS } from '../server/worldmonitor/news/v1/_feeds.ts';

describe('commodities news agent parity (#5889)', () => {
  it('exposes the finance dashboard commodities bucket in the full digest used by agents', () => {
    const financeCommodities = VARIANT_FEEDS.finance?.commodities;
    const agentCommodities = VARIANT_FEEDS.full?.commodities;

    assert.ok(financeCommodities?.length, 'finance dashboard commodities feeds must exist');
    assert.ok(agentCommodities?.length, 'full agent digest must expose a commodities category');
    assert.deepEqual(
      agentCommodities,
      financeCommodities,
      'agents and the finance dashboard must read the same commodities headline sources',
    );
  });
});
