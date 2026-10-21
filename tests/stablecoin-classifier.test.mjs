// Guards #6319: ONE deviation → peg-status mapping and row shaping for
// `market:stablecoins:v1`, consumed by all three writers of that key.
//
// Three layers:
//   1. The classifier itself — peg boundaries and provider-row coercion.
//   2. Byte-parity — the shared module reproduces, byte for byte, the
//      payload rows the pre-#6319 inline copies produced for realistic
//      provider input (the acceptance criterion the extraction ran under).
//   3. Enforcement — each writer imports the shared module and no writer
//      carries a private copy of the classification. Without this, the next
//      "quick fix" lands in one file and the two seeders of the SAME Redis
//      key diverge again (#6308 found exactly that drift on the relay).
//
// The seeder imports the ESM path (static import of the scripts/shared
// mirror) and the relay the CJS path (requireShared), so this file loads the
// module BOTH ways rather than trusting one loader to vouch for the other.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// The ESM leg: the exact import form scripts/seed-stablecoin-markets.mjs uses.
import { classifyStablecoin as classifyViaEsm } from '../scripts/shared/stablecoin-classifier.cjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');

// The CJS leg: the canonical shared/ copy, the one requireShared prefers.
const require = createRequire(import.meta.url);
const { classifyStablecoin } = require('../shared/stablecoin-classifier.cjs');

const { pegThresholds } = JSON.parse(
  readFileSync(join(repoRoot, 'shared', 'stablecoins.json'), 'utf-8'),
);

describe('classifyStablecoin — peg boundaries', () => {
  const at = (price) => classifyStablecoin({ id: 'tether', current_price: price }).pegStatus;

  it('classifies exact $1.00 as ON PEG', () => {
    assert.equal(at(1.0), 'ON PEG');
  });

  // Band membership only, with prices safely inside each band. The exact
  // boundary is NOT testable through price arithmetic: `1.01 - 1.0` is
  // 0.010000000000000009 in floats, so a coin priced exactly at a threshold
  // already classified as the worse band before the extraction — behavior at
  // the boundary is pinned by the byte-parity suite below, not idealized here.
  it('classifies prices inside the on-peg band as ON PEG', () => {
    assert.equal(at(1.004), 'ON PEG');
    assert.equal(at(0.996), 'ON PEG');
  });

  it('classifies prices between the bands as SLIGHT DEPEG', () => {
    assert.equal(at(1.008), 'SLIGHT DEPEG');
    assert.equal(at(0.992), 'SLIGHT DEPEG');
  });

  it('classifies prices beyond the slight-depeg band as DEPEGGED', () => {
    assert.equal(at(1.02), 'DEPEGGED');
    assert.equal(at(0.98), 'DEPEGGED');
  });

  it('classifies a missing price as DEPEGGED at 100% deviation, not ON PEG at NaN', () => {
    const coin = classifyStablecoin({ id: 'tether' });
    assert.equal(coin.pegStatus, 'DEPEGGED');
    assert.equal(coin.price, 0);
    assert.equal(coin.deviation, 100);
  });

  it('classifies on the RAW deviation — rounding the stored percentage never moves a coin across a boundary', () => {
    // deviation 0.0050004 rounds to the stored "0.500" but exceeds the 0.005
    // threshold; a classifier reading its own rounded output would say ON PEG.
    const coin = classifyStablecoin({ id: 'tether', current_price: 1.0050004 });
    assert.equal(coin.deviation, 0.5);
    assert.equal(coin.pegStatus, 'SLIGHT DEPEG');
  });

  it('accepts explicit threshold overrides', () => {
    assert.equal(
      classifyStablecoin(
        { id: 'tether', current_price: 1.04 },
        { onPegMaxDeviation: 0.05, slightDepegMaxDeviation: 0.1 },
      ).pegStatus,
      'ON PEG',
    );
  });

  it('ESM and CJS entry points resolve the same implementation behaviour', () => {
    const row = { id: 'dai', symbol: 'dai', name: 'Dai', current_price: 0.9995, market_cap: 5e9, total_volume: 1e8, price_change_percentage_24h: 0.01, price_change_percentage_7d_in_currency: -0.02, image: 'https://x/dai.png' };
    assert.deepEqual(classifyViaEsm(row), classifyStablecoin(row));
  });
});

describe('classifyStablecoin — byte parity with the replaced inline copies', () => {
  // The pre-#6319 seeder/relay shaping, frozen verbatim (modulo formatting).
  // scripts/ais-relay.cjs and scripts/seed-stablecoin-markets.mjs carried
  // this exact logic; both wrote market:stablecoins:v1.
  function legacySeederShape(coin) {
    const price = coin.current_price || 0;
    const deviation = Math.abs(price - 1.0);
    let pegStatus;
    if (deviation <= pegThresholds.onPegMaxDeviation) pegStatus = 'ON PEG';
    else if (deviation <= pegThresholds.slightDepegMaxDeviation) pegStatus = 'SLIGHT DEPEG';
    else pegStatus = 'DEPEGGED';
    return {
      id: coin.id,
      symbol: (coin.symbol || '').toUpperCase(),
      name: coin.name,
      price,
      deviation: +(deviation * 100).toFixed(3),
      pegStatus,
      marketCap: coin.market_cap || 0,
      volume24h: coin.total_volume || 0,
      change24h: coin.price_change_percentage_24h || 0,
      change7d: coin.price_change_percentage_7d_in_currency || 0,
      image: coin.image || '',
    };
  }

  // Realistic provider rows: CoinGecko /coins/markets output, plus the shapes
  // the CoinPaprika fallback produces after both seeders' field mapping
  // (image always '', occasional null percent-changes).
  const PROVIDER_ROWS = [
    { id: 'tether', symbol: 'usdt', name: 'Tether', image: 'https://assets.coingecko.com/usdt.png', current_price: 1.001, market_cap: 112_000_000_000, total_volume: 48_000_000_000, price_change_percentage_24h: 0.02, price_change_percentage_7d_in_currency: -0.05 },
    { id: 'usd-coin', symbol: 'usdc', name: 'USDC', image: 'https://assets.coingecko.com/usdc.png', current_price: 0.9998, market_cap: 33_000_000_000, total_volume: 6_000_000_000, price_change_percentage_24h: -0.01, price_change_percentage_7d_in_currency: 0.0 },
    // CoinGecko sends null for a change window it cannot compute.
    { id: 'first-digital-usd', symbol: 'fdusd', name: 'First Digital USD', image: '', current_price: 0.993, market_cap: 2_000_000_000, total_volume: 4_000_000_000, price_change_percentage_24h: null, price_change_percentage_7d_in_currency: null },
    // CoinPaprika-mapped row: image always ''.
    { id: 'ethena-usde', symbol: 'usde', name: 'Ethena USDe', image: '', current_price: 0.985, market_cap: 3_000_000_000, total_volume: 90_000_000, price_change_percentage_24h: -0.4, price_change_percentage_7d_in_currency: -1.1 },
    // Provider glitch: zero/missing price must not throw or go NaN.
    { id: 'dai', symbol: 'dai', name: 'Dai', image: '', current_price: 0, market_cap: 5_000_000_000, total_volume: 0, price_change_percentage_24h: 0, price_change_percentage_7d_in_currency: 0 },
    // Threshold-exact prices: parity here is what pins the float-arithmetic
    // boundary behavior (see the band-membership suite above).
    { id: 'tether', symbol: 'usdt', name: 'Tether', image: '', current_price: 1.005, market_cap: 1, total_volume: 1, price_change_percentage_24h: 0, price_change_percentage_7d_in_currency: 0 },
    { id: 'tether', symbol: 'usdt', name: 'Tether', image: '', current_price: 0.99, market_cap: 1, total_volume: 1, price_change_percentage_24h: 0, price_change_percentage_7d_in_currency: 0 },
  ];

  it('produces byte-identical rows for realistic provider input', () => {
    for (const row of PROVIDER_ROWS) {
      assert.equal(
        JSON.stringify(classifyStablecoin(row)),
        JSON.stringify(legacySeederShape(row)),
        `row ${row.id} diverged from the legacy seeder shaping`,
      );
    }
  });

  it('hardens the degenerate cases the seeders previously mis-serialized', () => {
    // Not parity — documented divergence. A string price passed the legacy
    // `|| 0` through as a string; a missing name dropped the key entirely.
    // The shared module keeps the TS handler's coercions for these.
    const coin = classifyStablecoin({ id: 'x', current_price: '1.001' });
    assert.equal(coin.price, 1.001);
    assert.equal(coin.name, '');
  });
});

describe('every writer of market:stablecoins:v1 uses the shared classifier', () => {
  const WRITERS = [
    'scripts/ais-relay.cjs',
    'scripts/seed-stablecoin-markets.mjs',
    'server/worldmonitor/market/v1/list-stablecoin-markets.ts',
  ];

  for (const relPath of WRITERS) {
    const source = readFileSync(join(repoRoot, relPath), 'utf-8');

    it(`${relPath} imports stablecoin-classifier.cjs`, () => {
      assert.match(
        source,
        /stablecoin-classifier\.cjs/,
        `${relPath} no longer references the shared classifier`,
      );
    });

    it(`${relPath} carries no private peg classification`, () => {
      // The status literals and the deviation formula may live ONLY in the
      // shared module. Their reappearance in a writer is the #6308 drift
      // pattern starting over.
      assert.doesNotMatch(
        source,
        /['"]SLIGHT DEPEG['"]/,
        `${relPath} contains a private copy of the peg-status mapping`,
      );
      assert.doesNotMatch(
        source,
        /Math\.abs\(\s*price\s*-\s*1(\.0)?\s*\)/,
        `${relPath} contains a private copy of the deviation formula`,
      );
    });
  }
});
