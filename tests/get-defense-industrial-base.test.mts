import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildDefenseIndustrialResponse,
  hasCompleteDefenseIndustrialHydration,
  toDefenseIndustrialMetric,
} from '../shared/defense-industrial-response.ts';
import { validateGeneratedRequest } from '../server/request-validator.ts';
import { isPublicSharedRpcRequest } from '../src/shared/public-rpc-cache.ts';

describe('get-defense-industrial-base response mapping', () => {
  it('keeps World-Bank-only data available without claiming supplier data', () => {
    const response = buildDefenseIndustrialResponse('UA', {
      fetchedAt: '2026-08-12T00:00:00.000Z',
      countries: { UA: { expenditurePctGdp: { value: 34.5, year: 2024, source: 'World Bank' } } },
    }, null);

    assert.equal(response.available, true);
    assert.equal(response.expenditurePctGdp.value, 34.5);
    assert.deepEqual(response.suppliers, []);
    assert.equal(response.supplierSource, '');
  });

  it('keeps supplier-only data available and bounds corrupted shares', () => {
    const response = buildDefenseIndustrialResponse('UA', null, {
      importers: { UA: {
        suppliers: [
          { supplierIso2: 'US', tivShare: 0.8 },
          { supplierIso2: 'bad', tivShare: 0.1 },
          { supplierIso2: 'DE', tivShare: 1.2 },
        ],
        supplierHhi: 1.4,
        window: { startYear: 2021, endYear: 2025 },
        source: 'SIPRI Arms Transfers Database',
      } },
    });

    assert.equal(response.available, true);
    assert.deepEqual(response.suppliers, [{ supplierIso2: 'US', tivShare: 0.8 }]);
    assert.equal(response.supplierHhi, 1);
  });

  it('returns an explicit unavailable response for a missing country', () => {
    const response = buildDefenseIndustrialResponse('ZZ', { countries: {} }, { importers: {} });
    assert.equal(response.available, false);
    assert.equal(response.countryCode, 'ZZ');
  });

  it('does not turn malformed metric values into available zeros', () => {
    assert.deepEqual(toDefenseIndustrialMetric({ value: Number.NaN, year: 2024 }), {
      available: false,
      value: 0,
      year: 0,
      previousValue: 0,
      previousYear: 0,
      source: '',
    });
  });

  it('rejects missing and malformed REST country codes before the handler', () => {
    assert.deepEqual(validateGeneratedRequest('getDefenseIndustrialBase', {}), [
      { field: 'countryCode', description: 'value is required' },
    ]);
    assert.deepEqual(validateGeneratedRequest('getDefenseIndustrialBase', { countryCode: 'ua' }), [
      { field: 'countryCode', description: 'string must match pattern ^[A-Z]{2}$' },
    ]);
    assert.equal(validateGeneratedRequest('getDefenseIndustrialBase', { countryCode: 'UA' }), undefined);
  });

  it('exposes only the bounded uppercase per-country public cache shape', () => {
    const path = 'https://worldmonitor.app/api/military/v1/get-defense-industrial-base';
    assert.equal(isPublicSharedRpcRequest(`${path}?country_code=UA&public=1`), true);
    assert.equal(isPublicSharedRpcRequest(`${path}?country_code=ua&public=1`), false);
    assert.equal(isPublicSharedRpcRequest(`${path}?country_code=UA`), false);
    assert.equal(isPublicSharedRpcRequest(`${path}?country_code=UA&public=1&extra=1`), false);
  });

  it('does not accept a one-key hydration result as complete', () => {
    assert.equal(hasCompleteDefenseIndustrialHydration({ countries: {} }, { importers: {} }), true);
    assert.equal(hasCompleteDefenseIndustrialHydration({ countries: {} }, undefined), false);
    assert.equal(hasCompleteDefenseIndustrialHydration(undefined, { importers: {} }), false);
    assert.equal(hasCompleteDefenseIndustrialHydration({}, {}), false);
  });
});
