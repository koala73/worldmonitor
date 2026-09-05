import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { PRODUCT_CATALOG } from '../convex/config/productCatalog.ts';
import { hasRedistributableProviderAttribution } from '../shared/provider-redistribution.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');
const R1_R3 = /R1[–-]R3 redistribution rights for customer-facing products/i;

describe('API Business redistribution rights', () => {
  it('states the qualified R1-R3 promise in the product catalog', () => {
    const rightsFeature = PRODUCT_CATALOG.api_business.marketingFeatures
      .find((feature) => /redistribut/i.test(feature));

    assert.match(rightsFeature ?? '', R1_R3);
    assert.doesNotMatch(rightsFeature ?? '', /embed our data in what you sell/i);
  });

  it('publishes the same qualified promise on both pricing surfaces', () => {
    for (const path of ['docs/pricing.mdx', 'public/pricing.md']) {
      const pricing = read(path);
      assert.match(pricing, R1_R3, `${path} must state the R1-R3 scope`);
      assert.match(pricing, /OpenSky data is display-only/i, `${path} must name the provider exception`);
      assert.match(pricing, /R4[^\n]*not redistributable/i, `${path} must preserve the R4 boundary`);
      assert.doesNotMatch(pricing, /embed our data in what you sell/i, `${path} must not publish the old promise`);
      assert.doesNotMatch(pricing, /embed WorldMonitor data in what you sell/i, `${path} must not publish the old license line`);
    }
  });

  it('grants R1-R3 for distributed sources while keeping R4 and OpenSky out', () => {
    const eula = read('docs/eula.mdx');
    const terms = read('docs/terms.mdx');

    for (const [label, text] of [['EULA', eula], ['Terms', terms]]) {
      assert.match(text, /R1, R2, and R3 Outputs from every source World Monitor distributes/i, `${label} must state the grant`);
      assert.match(text, /OpenSky data is display-only/i, `${label} must name the provider exception`);
      assert.match(text, /R4[^\n]*not redistributable/i, `${label} must preserve the R4 boundary`);
      assert.doesNotMatch(text, /R3 rights are available per source on request/i, `${label} must remove the stale request gate`);
    }

    assert.match(eula, /white-labeling beyond the R1 right in section 5/i);
  });

  it('matches the enforced provider boundary', () => {
    assert.equal(hasRedistributableProviderAttribution('adsb.lol'), true);
    assert.equal(hasRedistributableProviderAttribution('OpenSky Network'), false);
  });
});
