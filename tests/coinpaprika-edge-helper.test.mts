import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { fetchCryptoMarkets } from '../server/worldmonitor/market/v1/_shared.ts';

const originalFetch = globalThis.fetch;
const originalWarn = console.warn;

afterEach(() => {
  globalThis.fetch = originalFetch;
  console.warn = originalWarn;
});

describe('market Edge CoinPaprika fallback', () => {
  it('fetches only configured CoinPaprika ticker IDs after CoinGecko fails', async () => {
    const seen: string[] = [];

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      seen.push(url);

      if (url.includes('api.coingecko.com')) {
        return new Response('unavailable', { status: 503 });
      }

      const id = url.match(/tickers\/([^?]+)/)?.[1];
      assert.ok(id, `expected targeted CoinPaprika ticker URL, got ${url}`);
      return Response.json({
        id,
        name: id === 'btc-bitcoin' ? 'Bitcoin' : 'Ethereum',
        symbol: id === 'btc-bitcoin' ? 'BTC' : 'ETH',
        quotes: {
          USD: {
            price: id === 'btc-bitcoin' ? 100 : 50,
            volume_24h: 123,
            market_cap: 456,
            percent_change_24h: 1.5,
            percent_change_7d: 2.5,
          },
        },
      });
    }) as typeof fetch;

    console.warn = () => {};

    const markets = await fetchCryptoMarkets(['bitcoin', 'ethereum']);

    assert.deepEqual(
      seen.filter(url => url.includes('api.coinpaprika.com')),
      [
        'https://api.coinpaprika.com/v1/tickers/btc-bitcoin?quotes=USD',
        'https://api.coinpaprika.com/v1/tickers/eth-ethereum?quotes=USD',
      ],
    );
    assert.equal(seen.some(url => url === 'https://api.coinpaprika.com/v1/tickers?quotes=USD'), false);
    assert.deepEqual(markets.map(item => item.id), ['bitcoin', 'ethereum']);
    assert.equal(markets[0]?.current_price, 100);
    assert.equal(markets[1]?.market_cap, 456);
  });

  it('preserves successful CoinPaprika rows when one requested ticker fails', async () => {
    const warnings: unknown[] = [];

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('api.coingecko.com')) {
        return new Response('unavailable', { status: 503 });
      }
      const id = url.match(/tickers\/([^?]+)/)?.[1];
      if (id === 'eth-ethereum') {
        return new Response('missing', { status: 404 });
      }
      return Response.json({
        id,
        name: 'Bitcoin',
        symbol: 'BTC',
        quotes: {
          USD: {
            price: 100,
            volume_24h: 123,
            market_cap: 456,
            percent_change_24h: 1.5,
            percent_change_7d: 2.5,
          },
        },
      });
    }) as typeof fetch;

    console.warn = (...args: unknown[]) => {
      warnings.push(args);
    };

    const markets = await fetchCryptoMarkets(['bitcoin', 'ethereum']);

    assert.deepEqual(markets.map(item => item.id), ['bitcoin']);
    assert.equal(warnings.some(args => String(args[0]).includes('Skipping eth-ethereum')), true);
  });

  it('bounds CoinPaprika fallback fanout for larger configured sets', async () => {
    const ids = [
      'bitcoin',
      'ethereum',
      'binancecoin',
      'solana',
      'ripple',
      'cardano',
      'dogecoin',
      'tron',
      'avalanche-2',
      'chainlink',
    ];
    let activePaprika = 0;
    let maxActivePaprika = 0;

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('api.coingecko.com')) {
        return new Response('unavailable', { status: 503 });
      }

      activePaprika += 1;
      maxActivePaprika = Math.max(maxActivePaprika, activePaprika);
      await new Promise(resolve => setTimeout(resolve, 5));
      activePaprika -= 1;

      const id = url.match(/tickers\/([^?]+)/)?.[1] ?? 'unknown';
      return Response.json({
        id,
        name: id,
        symbol: id.slice(0, 3).toUpperCase(),
        quotes: {
          USD: {
            price: 100,
            volume_24h: 123,
            market_cap: 456,
            percent_change_24h: 1.5,
            percent_change_7d: 2.5,
          },
        },
      });
    }) as typeof fetch;

    console.warn = () => {};

    const markets = await fetchCryptoMarkets(ids);

    assert.equal(markets.length, ids.length);
    assert.equal(maxActivePaprika, 4);
  });
});
