import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { getDefenseIndustrialBaseWithReader } from '../server/worldmonitor/military/v1/get-defense-industrial-base.ts';
import { drainResponseHeaders } from '../server/_shared/response-headers.ts';

function context() {
  return { request: new Request('https://worldmonitor.app/api/military/v1/get-defense-industrial-base') } as never;
}

describe('get-defense-industrial-base handler cache behavior', () => {
  it('serves two cache hits without the fallback header', async () => {
    const ctx = context();
    const reads = [
      { status: 'hit', value: { countries: { UA: { personnel: { value: 1, year: 2025 } } } } },
      { status: 'hit', value: { importers: { UA: { suppliers: [{ supplierIso2: 'US', tivShare: 1 }] } } } },
    ] as const;
    const response = await getDefenseIndustrialBaseWithReader(ctx, { countryCode: 'UA' }, async () => reads.shift() as never);

    assert.equal(response.available, true);
    assert.equal(drainResponseHeaders(ctx.request), undefined);
  });

  it('marks a partial miss as no-store while preserving the available source', async () => {
    const ctx = context();
    const reads = [
      { status: 'hit', value: { countries: { UA: { personnel: { value: 1, year: 2025 } } } } },
      { status: 'miss' },
    ] as const;
    const response = await getDefenseIndustrialBaseWithReader(ctx, { countryCode: 'UA' }, async () => reads.shift() as never);

    assert.equal(response.available, true);
    assert.deepEqual(drainResponseHeaders(ctx.request), { 'X-No-Cache': '1' });
  });

  it('marks Redis errors and thrown reads as no-store fallbacks', async () => {
    const errorContext = context();
    const errorReads = [
      { status: 'hit', value: { countries: { UA: { personnel: { value: 1, year: 2025 } } } } },
      { status: 'error', error: new Error('redis unavailable') },
    ] as const;
    await getDefenseIndustrialBaseWithReader(errorContext, { countryCode: 'UA' }, async () => errorReads.shift() as never);
    assert.deepEqual(drainResponseHeaders(errorContext.request), { 'X-No-Cache': '1' });

    const thrownContext = context();
    const response = await getDefenseIndustrialBaseWithReader(thrownContext, { countryCode: 'UA' }, async () => {
      throw new Error('read failed');
    });
    assert.equal(response.available, false);
    assert.deepEqual(drainResponseHeaders(thrownContext.request), { 'X-No-Cache': '1' });
  });
});
