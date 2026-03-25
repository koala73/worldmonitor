import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const crypto = require('../shared/crypto.json');

describe('shared/crypto.json integrity', () => {
  it('every id in ids has a meta entry', () => {
    for (const id of crypto.ids) {
      assert.ok(crypto.meta[id], `missing meta for "${id}"`);
      assert.ok(crypto.meta[id].name, `missing meta.name for "${id}"`);
      assert.ok(crypto.meta[id].symbol, `missing meta.symbol for "${id}"`);
    }
  });

  it('every id in ids has a coinpaprika mapping', () => {
    for (const id of crypto.ids) {
      assert.ok(crypto.coinpaprika[id], `missing coinpaprika mapping for "${id}"`);
    }
  });

  it('coinpaprika ids follow the symbol-name pattern', () => {
    for (const [geckoId, paprikaId] of Object.entries(crypto.coinpaprika)) {
      assert.match(paprikaId, /^[a-z0-9]+-[a-z0-9-]+$/, `bad coinpaprika id format for "${geckoId}": "${paprikaId}"`);
    }
  });

  it('coinpaprika ids exist on CoinPaprika API', async () => {
    let coins;
    try {
      const resp = await fetch('https://api.coinpaprika.com/v1/coins', {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(10_000),
      });
      if (!resp.ok) { console.log(`  skipping: CoinPaprika API returned ${resp.status}`); return; }
      coins = await resp.json();
    } catch (err) {
      console.log(`  skipping: CoinPaprika unreachable (${err.code || err.message})`);
      return;
    }
    const validIds = new Set(coins.map((c) => c.id));
    const invalid = [];
    for (const [geckoId, paprikaId] of Object.entries(crypto.coinpaprika)) {
      if (!validIds.has(paprikaId)) invalid.push(`${geckoId} → ${paprikaId}`);
    }
    assert.equal(invalid.length, 0, `invalid CoinPaprika ids:\n  ${invalid.join('\n  ')}`);
  });

  it('symbols are unique', () => {
    const symbols = Object.values(crypto.meta).map((m) => m.symbol);
    assert.equal(new Set(symbols).size, symbols.length, `duplicate symbols: ${symbols}`);
  });

  it('no stablecoins in the top-coins list', () => {
    const stableSymbols = new Set(['USDT', 'USDC', 'DAI', 'FDUSD', 'USDE', 'TUSD', 'BUSD']);
    for (const id of crypto.ids) {
      const sym = crypto.meta[id]?.symbol;
      assert.ok(!stableSymbols.has(sym), `stablecoin "${sym}" (${id}) should not be in top-coins list`);
    }
  });
});
