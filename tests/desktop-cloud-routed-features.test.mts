// Desktop features that need no local key (#5829) are only correct while the
// sidecar sends their routes to the cloud and the gateway serves those routes
// to a keyless desktop. If either changes, the layer or panel goes empty again.
// A keyless desktop reaches the cloud with the anonymous wms_ session the
// sidecar mints, which the gateway accepts on any route that is neither
// tier-gated nor premium (forceKey rejects that session on those).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

import { TIER_GATED_PATHS } from '../server/_shared/entitlement-check.ts';
import { PREMIUM_RPC_PATHS } from '../src/shared/premium-paths.ts';
import { __testing__ } from '../src-tauri/sidecar/local-api-server.mjs';

const root = resolve(import.meta.dirname, '..');
const runtimeConfig = readFileSync(resolve(root, 'src/services/runtime-config.ts'), 'utf8');

const CLOUD_ROUTED: Record<string, string[]> = {
  internetOutages: ['/api/infrastructure/v1/list-internet-outages'],
  energyEia: [
    '/api/economic/v1/get-energy-prices',
    '/api/economic/v1/get-crude-inventories',
    '/api/economic/v1/get-nat-gas-storage',
    '/api/economic/v1/get-energy-capacity',
  ],
  economicFred: ['/api/economic/v1/get-fred-series-batch', '/api/economic/v1/get-fred-series'],
  // get-tariff-trends is left out: it is Pro-gated and goes through
  // premiumFetch, so a free desktop gets an empty result and no Tariffs tab, as on web.
  wtoTrade: [
    '/api/trade/v1/get-trade-restrictions',
    '/api/trade/v1/get-trade-flows',
    '/api/trade/v1/get-trade-barriers',
  ],
  supplyChain: ['/api/supply-chain/v1/get-shipping-rates'],
};

describe('desktop features that need no local key', () => {
  for (const [feature, routes] of Object.entries(CLOUD_ROUTED)) {
    it(`${feature} is cloud-routed and served to an anonymous session`, () => {
      for (const route of routes) {
        assert.equal(__testing__.isCloudPreferred(route), true, `${route} is cloud-routed`);
        assert.equal(TIER_GATED_PATHS.has(route), false, `${route} is not tier-gated`);
        assert.equal(PREMIUM_RPC_PATHS.has(route), false, `${route} is not premium`);
      }
    });
  }

  it('matches the features runtime-config un-gates on desktop', () => {
    const ungated = [...runtimeConfig.matchAll(/id: '(\w+)'[^}]*?desktopRequiredSecrets: \[\]/g)].map((m) => m[1]!);
    assert.deepEqual(ungated.sort(), Object.keys(CLOUD_ROUTED).sort());
  });
});
