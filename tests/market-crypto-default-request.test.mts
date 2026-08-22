import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CRYPTO_IDS } from '../src/config/markets.ts';
import {
  createDefaultCryptoQuoteRequest,
  isUsableCryptoQuoteResponse,
} from '../src/services/market/index.ts';

describe('default crypto quote request', () => {
  it('sends canonical ids so a missing seed can use the bounded gap provider path', () => {
    const request = createDefaultCryptoQuoteRequest();

    assert.deepEqual(request.ids, [...CRYPTO_IDS]);
    assert.ok(request.ids.length > 0, 'the default dashboard request must not be seed-only');
    assert.equal(new Set(request.ids).size, request.ids.length, 'default ids must be unique');
  });

  it('does not cache empty degraded responses', () => {
    assert.equal(isUsableCryptoQuoteResponse({
      quotes: [],
      unresolvedIds: [],
      provider: 'degraded',
    }), false);

    assert.equal(isUsableCryptoQuoteResponse({
      quotes: [{
        name: 'Bitcoin',
        symbol: 'BTC',
        price: 78_657,
        change: 4.8,
        sparkline: [],
        change7d: 0,
      }],
      unresolvedIds: [],
      provider: 'upstream',
    }), true);
  });
});
