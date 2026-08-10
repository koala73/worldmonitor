import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ASSETS,
  CANONICAL_KEY,
  BASELINE_KEY,
  CACHE_TTL_SECONDS,
  BASELINE_TTL_SECONDS,
  SPARK_MAX,
  MIN_NOTIONAL_USD_24H,
  STALE_SYMBOL_DROP_AFTER_POLLS,
  WEIGHTS,
  THRESHOLDS,
  ALERT_THRESHOLD,
  clamp,
  scoreFunding,
  scoreVolume,
  scoreOi,
  scoreBasis,
  computeAsset,
  validateUpstream,
  validateDexPayload,
  fetchAllMetaAndCtxs,
  indexBySymbol,
  buildSnapshot,
  validateFn,
  runHyperliquidFlowSeed,
} from '../scripts/seed-hyperliquid-flow.mjs';

const META_BTC = { symbol: 'BTC', class: 'crypto', display: 'BTC', group: 'crypto' };
const META_OIL = { symbol: 'xyz:CL', class: 'commodity', display: 'WTI Crude', group: 'oil' };

function makeUniverse(extra = []) {
  // Build a universe with at least 50 entries so validateUpstream passes.
  const filler = Array.from({ length: 50 }, (_, i) => ({ name: `FILL${i}` }));
  return [...ASSETS.map((a) => ({ name: a.symbol })), ...filler, ...extra];
}

function makeAssetCtxs(universe, overrides = {}) {
  return universe.map((u) => overrides[u.name] || {
    funding: '0',
    openInterest: '0',
    markPx: '0',
    oraclePx: '0',
    dayNtlVlm: '0',
  });
}

describe('TTL constants', () => {
  it('CACHE_TTL_SECONDS is at least 9× cron cadence (5 min)', () => {
    assert.ok(CACHE_TTL_SECONDS >= 9 * 5 * 60, `expected >= 2700, got ${CACHE_TTL_SECONDS}`);
  });
  it('CANONICAL_KEY is the documented v1 key', () => {
    assert.equal(CANONICAL_KEY, 'market:hyperliquid:flow:v1');
  });
  it('keeps baseline state longer than the live snapshot', () => {
    assert.equal(BASELINE_KEY, 'market:hyperliquid:flow:baseline:v1');
    assert.ok(BASELINE_TTL_SECONDS > CACHE_TTL_SECONDS);
    assert.ok(BASELINE_TTL_SECONDS >= 7 * 24 * 60 * 60);
  });
});

describe('weights', () => {
  it('sum to 1.0', () => {
    const sum = WEIGHTS.funding + WEIGHTS.volume + WEIGHTS.oi + WEIGHTS.basis;
    assert.ok(Math.abs(sum - 1.0) < 1e-9, `weights sum=${sum}`);
  });
});

describe('clamp', () => {
  it('bounds to [0,100] by default', () => {
    assert.equal(clamp(150), 100);
    assert.equal(clamp(-5), 0);
    assert.equal(clamp(50), 50);
  });
  it('returns 0 for non-finite', () => {
    assert.equal(clamp(NaN), 0);
    assert.equal(clamp(Infinity), 0);
  });
});

describe('scoreFunding (parity with risk.py)', () => {
  it('|rate|/threshold * 100 clamped', () => {
    assert.equal(scoreFunding(0.0005, 0.001), 50);
    assert.equal(scoreFunding(-0.0005, 0.001), 50);
    assert.equal(scoreFunding(0.002, 0.001), 100);
    assert.equal(scoreFunding(0, 0.001), 0);
  });
  it('returns 0 on zero/negative threshold', () => {
    assert.equal(scoreFunding(0.001, 0), 0);
  });
});

describe('scoreVolume', () => {
  it('ratio / threshold * 100', () => {
    assert.equal(scoreVolume(2_000_000, 1_000_000, 5), 40);
    assert.equal(scoreVolume(10_000_000, 1_000_000, 5), 100);
  });
  it('returns 0 if avg is 0', () => {
    assert.equal(scoreVolume(1_000_000, 0, 5), 0);
  });
});

describe('scoreOi', () => {
  it('|delta|/prev / threshold * 100', () => {
    assert.equal(scoreOi(120, 100, 0.20), 100); // 20% change vs 20% threshold → score 100
    assert.equal(scoreOi(110, 100, 0.20), 50);  // 10% change → half of threshold
  });
  it('returns 0 if prevOi <= 0', () => {
    assert.equal(scoreOi(100, 0, 0.20), 0);
  });
});

describe('scoreBasis', () => {
  it('|mark-oracle|/oracle / threshold * 100', () => {
    assert.equal(scoreBasis(105, 100, 0.05), 100); // exactly threshold
    assert.equal(Math.round(scoreBasis(102.5, 100, 0.05)), 50);
  });
});

describe('computeAsset min-notional guard', () => {
  it('volumeScore = 0 when dayNotional below MIN_NOTIONAL_USD_24H, even with prior history', () => {
    const prev = {
      symbol: 'xyz:CL',
      sparkVol: Array(12).fill(100_000),
      sparkFunding: [],
      sparkOi: [],
      sparkScore: [],
      openInterest: 1_000,
    };
    const ctx = { funding: '0', openInterest: '1000', markPx: '0', oraclePx: '0', dayNtlVlm: String(MIN_NOTIONAL_USD_24H - 1) };
    const out = computeAsset(META_OIL, ctx, prev);
    assert.equal(out.volumeScore, 0);
  });
  it('volumeScore > 0 when dayNotional above MIN_NOTIONAL with sufficient prior samples', () => {
    const prev = {
      symbol: 'xyz:CL',
      sparkVol: Array(12).fill(MIN_NOTIONAL_USD_24H),
      sparkFunding: [],
      sparkOi: [],
      sparkScore: [],
      openInterest: 1_000,
    };
    const ctx = { funding: '0', openInterest: '1000', markPx: '0', oraclePx: '0', dayNtlVlm: String(MIN_NOTIONAL_USD_24H * 4) };
    const out = computeAsset(META_OIL, ctx, prev);
    assert.ok(out.volumeScore > 0, `expected >0, got ${out.volumeScore}`);
  });
});

describe('computeAsset cold-start (no prev)', () => {
  it('zeros volumeScore and oiScore on first run', () => {
    const ctx = { funding: '0.0005', openInterest: '1000', markPx: '100', oraclePx: '100', dayNtlVlm: '5000000' };
    const out = computeAsset(META_BTC, ctx, null, { coldStart: true });
    assert.equal(out.oiScore, 0);
    assert.equal(out.volumeScore, 0);
    assert.ok(out.fundingScore > 0); // funding still computable
    assert.equal(out.warmup, true);
  });
});

describe('warmup persists until baseline is usable (not just first poll)', () => {
  it('stays warmup=true after coldStart clears if volume baseline has <12 samples', () => {
    // Second poll: coldStart=false, but only 1 prior vol sample.
    const prev = {
      symbol: 'BTC', openInterest: 1000,
      sparkVol: [1_000_000],
      sparkFunding: [], sparkOi: [1000], sparkScore: [],
    };
    const ctx = { funding: '0.0005', openInterest: '1010', markPx: '100', oraclePx: '100', dayNtlVlm: '5000000' };
    const out = computeAsset(META_BTC, ctx, prev, { coldStart: false });
    assert.equal(out.warmup, true, 'should stay warmup while baseline < 12 samples');
    assert.equal(out.volumeScore, 0, 'volume scoring must wait for baseline');
  });

  it('clears warmup=false once baseline has >=12 samples AND prior OI exists', () => {
    const prev = {
      symbol: 'BTC', openInterest: 1000,
      sparkVol: Array(12).fill(1_000_000),
      sparkFunding: [], sparkOi: Array(12).fill(1000), sparkScore: [],
    };
    const ctx = { funding: '0.0001', openInterest: '1010', markPx: '100', oraclePx: '100', dayNtlVlm: '1000000' };
    const out = computeAsset(META_BTC, ctx, prev, { coldStart: false });
    assert.equal(out.warmup, false);
  });

  it('stays warmup=true when prior OI is missing even with full vol baseline', () => {
    const prev = {
      symbol: 'BTC', openInterest: null,
      sparkVol: Array(12).fill(1_000_000),
      sparkFunding: [], sparkOi: [], sparkScore: [],
    };
    const ctx = { funding: '0', openInterest: '1000', markPx: '100', oraclePx: '100', dayNtlVlm: '1000000' };
    const out = computeAsset(META_BTC, ctx, prev, { coldStart: false });
    assert.equal(out.warmup, true);
    assert.equal(out.oiScore, 0);
  });
});

describe('computeAsset OI continuity', () => {
  it('keeps warmup active and resets OI history when current OI is invalid', () => {
    const prev = {
      symbol: 'BTC', openInterest: 1000,
      sparkVol: Array(12).fill(1_000_000),
      sparkFunding: [], sparkOi: Array(12).fill(1000), sparkScore: Array(12).fill(10),
    };
    const highRiskCtx = {
      funding: '0.002', markPx: '105', oraclePx: '100', dayNtlVlm: '10000000',
    };

    for (const invalidOi of [null, '', 'not-a-number', '0', '-1']) {
      const out = computeAsset(META_BTC, { ...highRiskCtx, openInterest: invalidOi }, prev);
      assert.ok(out.composite >= ALERT_THRESHOLD, `expected inspectable partial score for OI=${invalidOi}`);
      assert.equal(out.openInterest, null);
      assert.equal(out.oiScore, 0);
      assert.equal(out.warmup, true);
      assert.deepEqual(out.sparkOi, []);
      assert.deepEqual(out.sparkScore, [out.composite]);
      assert.deepEqual(out.alerts, []);

      const recovered = computeAsset(META_BTC, { ...highRiskCtx, openInterest: '1500' }, out);
      assert.deepEqual(recovered.sparkOi, [1500]);
      assert.equal(recovered.warmup, true);
      assert.deepEqual(recovered.alerts, []);
    }
  });

  it('does not join a new OI window across a legacy invalid sample', () => {
    const prev = {
      symbol: 'BTC', openInterest: 1000,
      sparkVol: Array(12).fill(1_000_000),
      sparkFunding: [], sparkOi: [...Array(12).fill(1000), 0, 1000], sparkScore: [],
    };
    const out = computeAsset(META_BTC, {
      funding: '0.002', openInterest: '1500', markPx: '105', oraclePx: '100', dayNtlVlm: '10000000',
    }, prev);

    assert.deepEqual(out.sparkOi, [1000, 1500]);
    assert.equal(out.oiScore, 0);
    assert.equal(out.warmup, true);
    assert.deepEqual(out.alerts, []);
  });
});

describe('volume baseline uses the MOST RECENT window (slice(-12), not slice(0,12))', () => {
  // Regression: sparkVol is newest-at-tail via shiftAndAppend. Using slice(0,12)
  // anchors the baseline to the OLDEST window forever once len >= 12 + new samples
  // keep appending. Verify the baseline tracks the newest 12 samples.
  it('reflects recent-volume regime, not stale oldest-window baseline', () => {
    // Tail = last 12 samples (recent baseline ~200k).
    // Head = old samples (~1M). If we regress to slice(0,12), avg=1M and dayNotional=2M
    // would score volume=~2/5=40. With correct slice(-12), avg=200k so 2M/200k=10x → score=100.
    const sparkVol = [
      ...Array(20).fill(1_000_000), // oldest
      ...Array(12).fill(200_000),   // newest (baseline)
    ];
    const prev = {
      symbol: 'BTC', openInterest: 1000,
      sparkVol,
      sparkFunding: [], sparkOi: Array(12).fill(1000), sparkScore: [],
    };
    const ctx = { funding: '0', openInterest: '1010', markPx: '100', oraclePx: '100', dayNtlVlm: '2000000' };
    const out = computeAsset(META_BTC, ctx, prev, { coldStart: false });
    // Recent-window baseline: 2M / 200k / 5 * 100 = 200 → clamp 100.
    assert.equal(out.volumeScore, 100, `expected volume baseline to track recent window, got score=${out.volumeScore}`);
  });
});

describe('validateUpstream (back-compat + merged shape)', () => {
  it('rejects non-tuple single-dex input', () => {
    assert.throws(() => validateUpstream(null), /tuple/);
  });
  it('rejects missing universe', () => {
    assert.throws(() => validateUpstream([{}, []]), /universe/);
  });
  it('rejects too-small default universe', () => {
    const small = Array.from({ length: 10 }, (_, i) => ({ name: `X${i}` }));
    assert.throws(() => validateUpstream([{ universe: small }, makeAssetCtxs(small)]), /suspiciously small/);
  });
  it('rejects mismatched assetCtxs length', () => {
    const u = makeUniverse();
    assert.throws(() => validateUpstream([{ universe: u }, []]), /length does not match/);
  });
  it('accepts single-dex tuple (back-compat)', () => {
    const u = makeUniverse();
    const ctxs = makeAssetCtxs(u);
    const out = validateUpstream([{ universe: u }, ctxs]);
    assert.equal(out.universe.length, u.length);
  });
  it('passes through merged {universe, assetCtxs} shape', () => {
    const u = makeUniverse();
    const ctxs = makeAssetCtxs(u);
    const out = validateUpstream({ universe: u, assetCtxs: ctxs });
    assert.equal(out.universe.length, u.length);
    assert.equal(out.assetCtxs.length, ctxs.length);
  });
});

describe('validateDexPayload — xyz dex has lower floor than default', () => {
  it('accepts a xyz payload with ~63 entries (above MIN_UNIVERSE_XYZ=30)', () => {
    const u = Array.from({ length: 40 }, (_, i) => ({ name: `xyz:X${i}` }));
    const ctxs = makeAssetCtxs(u);
    const out = validateDexPayload([{ universe: u }, ctxs], 'xyz', 30);
    assert.equal(out.universe.length, 40);
  });
  it('rejects a xyz payload below its floor', () => {
    const u = Array.from({ length: 10 }, (_, i) => ({ name: `xyz:X${i}` }));
    assert.throws(
      () => validateDexPayload([{ universe: u }, makeAssetCtxs(u)], 'xyz', 30),
      /xyz universe suspiciously small: 10 < 30/,
    );
  });
});

describe('fetchAllMetaAndCtxs — dual-dex fetch and merge', () => {
  it('merges default and xyz responses into one {universe, assetCtxs}', async () => {
    const defaultUniverse = [
      ...Array.from({ length: 50 }, (_, i) => ({ name: `D${i}` })),
      { name: 'BTC' }, { name: 'ETH' }, { name: 'SOL' }, { name: 'PAXG' },
    ];
    const xyzUniverse = [
      ...Array.from({ length: 30 }, (_, i) => ({ name: `xyz:Z${i}` })),
      { name: 'xyz:CL' }, { name: 'xyz:BRENTOIL' }, { name: 'xyz:GOLD' },
      { name: 'xyz:SILVER' }, { name: 'xyz:EUR' }, { name: 'xyz:JPY' },
    ];
    const fakeFetch = async (_url, opts) => {
      const body = JSON.parse(opts.body);
      const isXyz = body.dex === 'xyz';
      const universe = isXyz ? xyzUniverse : defaultUniverse;
      const payload = [{ universe }, makeAssetCtxs(universe)];
      return {
        ok: true,
        headers: { get: () => 'application/json' },
        json: async () => payload,
      };
    };
    const merged = await fetchAllMetaAndCtxs(fakeFetch);
    const merged_names = merged.universe.map((u) => u.name);
    assert.ok(merged_names.includes('BTC'), 'merged should include default-dex BTC');
    assert.ok(merged_names.includes('xyz:CL'), 'merged should include xyz-dex xyz:CL');
    assert.equal(merged.universe.length, defaultUniverse.length + xyzUniverse.length);
    assert.equal(merged.assetCtxs.length, defaultUniverse.length + xyzUniverse.length);
  });

  it('propagates validation errors from either dex', async () => {
    const fakeFetch = async (_url, opts) => {
      const body = JSON.parse(opts.body);
      const isXyz = body.dex === 'xyz';
      // Return too-small universe on xyz side to trigger its floor check.
      if (isXyz) {
        const u = [{ name: 'xyz:CL' }];
        return { ok: true, headers: { get: () => 'application/json' }, json: async () => [{ universe: u }, makeAssetCtxs(u)] };
      }
      const u = Array.from({ length: 60 }, (_, i) => ({ name: `D${i}` }));
      return { ok: true, headers: { get: () => 'application/json' }, json: async () => [{ universe: u }, makeAssetCtxs(u)] };
    };
    await assert.rejects(() => fetchAllMetaAndCtxs(fakeFetch), /xyz universe suspiciously small/);
  });
});

describe('buildSnapshot — first run', () => {
  it('flags warmup and emits all whitelisted assets present in upstream', () => {
    const u = makeUniverse();
    const ctxs = makeAssetCtxs(u);
    const snap = buildSnapshot([{ universe: u }, ctxs], null, { now: 1_700_000_000_000 });
    assert.equal(snap.warmup, true);
    assert.equal(snap.assets.length, ASSETS.length);
    assert.ok(snap.assets.every((a) => a.warmup === true));
  });
});

describe('buildSnapshot — missing-symbol carry-forward', () => {
  it('carries forward a stale entry when whitelisted symbol absent from upstream', () => {
    const u = makeUniverse().filter((m) => m.name !== 'BTC');
    const ctxs = makeAssetCtxs(u);
    const prevSnap = {
      ts: 1_700_000_000_000 - 5 * 60_000, // 5min ago
      assets: [{
        symbol: 'BTC', display: 'BTC', class: 'crypto', group: 'crypto',
        funding: 0.0001, openInterest: 1000, markPx: 65000, oraclePx: 65000, dayNotional: 1e9,
        fundingScore: 10, volumeScore: 0, oiScore: 0, basisScore: 0, composite: 3,
        sparkFunding: [0.0001], sparkOi: [1000], sparkScore: [3], sparkVol: [1e9],
        stale: false, staleSince: null, missingPolls: 0, alerts: [], warmup: false,
      }],
    };
    const snap = buildSnapshot([{ universe: u }, ctxs], prevSnap, { now: 1_700_000_000_000 });
    const btc = snap.assets.find((a) => a.symbol === 'BTC');
    assert.ok(btc, 'BTC should still appear');
    assert.equal(btc.stale, true);
    assert.equal(btc.missingPolls, 1);
    assert.equal(btc.warmup, true);
    assert.deepEqual(btc.sparkOi, []);
    assert.deepEqual(btc.sparkScore, []);
    assert.equal(btc.oiScore, 0);
    assert.deepEqual(btc.alerts, []);
    assert.deepEqual(btc.sparkVol, [1e9]);
  });

  it('drops a symbol after STALE_SYMBOL_DROP_AFTER_POLLS consecutive misses', () => {
    const u = makeUniverse().filter((m) => m.name !== 'BTC');
    const ctxs = makeAssetCtxs(u);
    const prevSnap = {
      ts: 1_700_000_000_000 - 5 * 60_000,
      assets: [{
        symbol: 'BTC', display: 'BTC', class: 'crypto', group: 'crypto',
        funding: 0, openInterest: 1000, markPx: 0, oraclePx: 0, dayNotional: 0,
        fundingScore: 0, volumeScore: 0, oiScore: 0, basisScore: 0, composite: 0,
        sparkFunding: [], sparkOi: [], sparkScore: [], sparkVol: [],
        stale: true, staleSince: 1_700_000_000_000 - 30 * 60_000,
        missingPolls: STALE_SYMBOL_DROP_AFTER_POLLS - 1,
        alerts: [], warmup: false,
      }],
    };
    const snap = buildSnapshot([{ universe: u }, ctxs], prevSnap, { now: 1_700_000_000_000 });
    assert.equal(snap.assets.find((a) => a.symbol === 'BTC'), undefined);
  });
});

describe('buildSnapshot — post-outage baseline recovery', () => {
  it('retains volume history but suppresses misleading OI delta after a long gap', () => {
    const u = makeUniverse();
    const ctxs = makeAssetCtxs(u, {
      BTC: { funding: '0.002', openInterest: '2000', markPx: '105', oraclePx: '100', dayNtlVlm: '10000000' },
    });
    const prevSnap = {
      ts: 1_700_000_000_000 - 60 * 60_000, // 1h ago — way past 900s threshold
      assets: [{
        symbol: 'BTC',
        openInterest: 1000,
        sparkOi: Array(60).fill(1000),
        sparkScore: Array(60).fill(10),
        sparkVol: Array(12).fill(1e6),
      }],
    };
    const snap = buildSnapshot([{ universe: u }, ctxs], prevSnap, { now: 1_700_000_000_000 });
    const btc = snap.assets.find((a) => a.symbol === 'BTC');
    assert.equal(btc.warmup, true);
    assert.equal(snap.warmup, true);
    assert.equal(btc.oiScore, 0); // a one-hour move must not be labeled a 5m delta
    assert.deepEqual(btc.sparkOi, [2000]); // old, time-less samples must not cross the gap
    assert.deepEqual(btc.sparkScore, [btc.composite]);
    assert.ok(btc.volumeScore > 0); // durable rolling baseline remains usable
    assert.ok(btc.composite >= ALERT_THRESHOLD); // partial score remains inspectable
    assert.deepEqual(btc.alerts, []); // but incomplete four-component scores must not alert
  });

  it('keeps OI warmup until 13 post-gap samples form a real one-hour window', () => {
    const ctx = {
      funding: '0.002', openInterest: '2000', markPx: '105', oraclePx: '100', dayNtlVlm: '10000000',
    };
    let asset = computeAsset(META_BTC, ctx, {
      symbol: 'BTC',
      openInterest: 1000,
      sparkOi: Array(60).fill(1000),
      sparkScore: Array(60).fill(10),
      sparkVol: Array(12).fill(1e6),
    }, { suppressOiDelta: true });

    assert.equal(asset.sparkOi.length, 1);
    assert.equal(asset.warmup, true);
    for (let i = 1; i < 12; i++) {
      asset = computeAsset(META_BTC, ctx, asset);
    }
    assert.equal(asset.sparkOi.length, 12);
    assert.equal(asset.warmup, true);
    assert.deepEqual(asset.alerts, []);

    asset = computeAsset(META_BTC, { ...ctx, openInterest: '2500' }, asset);
    assert.equal(asset.sparkOi.length, 13);
    assert.equal(asset.warmup, false);
    assert.ok(asset.alerts.some((alert) => alert.includes('HIGH RISK')));
  });

  it('breaks OI continuity across one missing asset poll at a healthy snapshot cadence', () => {
    const now = 1_700_000_000_000;
    const missingBtcUniverse = makeUniverse().filter((entry) => entry.name !== 'BTC');
    const prevSnap = {
      ts: now - 5 * 60_000,
      assets: [{
        symbol: 'BTC', display: 'BTC', class: 'crypto', group: 'crypto',
        openInterest: 1000, composite: 90, oiScore: 100,
        sparkOi: Array(60).fill(1000), sparkScore: Array(60).fill(90),
        sparkVol: Array(12).fill(1e6), alerts: ['HIGH RISK 90/100'],
        warmup: false, stale: false, staleSince: null, missingPolls: 0,
      }],
    };
    const staleSnap = buildSnapshot(
      [{ universe: missingBtcUniverse }, makeAssetCtxs(missingBtcUniverse)],
      prevSnap,
      { now },
    );
    const staleBtc = staleSnap.assets.find((asset) => asset.symbol === 'BTC');
    assert.equal(staleBtc.stale, true);
    assert.equal(staleBtc.missingPolls, 1);
    assert.equal(staleBtc.warmup, true);
    assert.deepEqual(staleBtc.sparkOi, []);
    assert.deepEqual(staleBtc.sparkScore, []);
    assert.deepEqual(staleBtc.alerts, []);
    assert.equal(staleBtc.sparkVol.length, 12);

    const recoveredUniverse = makeUniverse();
    const recoveredSnap = buildSnapshot(
      [{ universe: recoveredUniverse }, makeAssetCtxs(recoveredUniverse, {
        BTC: { funding: '0', openInterest: '2000', markPx: '100', oraclePx: '100', dayNtlVlm: '1000000' },
      })],
      staleSnap,
      { now: now + 5 * 60_000 },
    );
    const recoveredBtc = recoveredSnap.assets.find((asset) => asset.symbol === 'BTC');
    assert.deepEqual(recoveredBtc.sparkOi, [2000]);
    assert.equal(recoveredBtc.warmup, true);
    assert.equal(recoveredBtc.oiScore, 0);
  });
});

describe('sparkline arrays', () => {
  it('cap at SPARK_MAX samples', () => {
    const u = makeUniverse();
    const ctxs = makeAssetCtxs(u, {
      BTC: { funding: '0.0001', openInterest: '1000', markPx: '0', oraclePx: '0', dayNtlVlm: '0' },
    });
    const longArr = Array.from({ length: SPARK_MAX + 30 }, (_, i) => i);
    const prevSnap = {
      ts: 1_700_000_000_000 - 5 * 60_000,
      assets: [{
        symbol: 'BTC', sparkFunding: longArr, sparkOi: longArr, sparkScore: longArr, sparkVol: longArr,
        openInterest: 1000,
      }],
    };
    const snap = buildSnapshot([{ universe: u }, ctxs], prevSnap, { now: 1_700_000_000_000 });
    const btc = snap.assets.find((a) => a.symbol === 'BTC');
    assert.ok(btc.sparkFunding.length <= SPARK_MAX);
    assert.ok(btc.sparkOi.length <= SPARK_MAX);
    assert.ok(btc.sparkScore.length <= SPARK_MAX);
  });
});

describe('validateFn (runSeed gate)', () => {
  it('rejects empty / fewer than 12 assets', () => {
    assert.equal(validateFn(null), false);
    assert.equal(validateFn({ assets: [] }), false);
    assert.equal(validateFn({ assets: Array(11).fill({}) }), false);
  });
  it('accepts >=12 assets', () => {
    assert.equal(validateFn({ assets: Array(12).fill({}) }), true);
  });
});

describe('runHyperliquidFlowSeed lifecycle', () => {
  const upstream = () => {
    const universe = makeUniverse();
    return {
      universe,
      assetCtxs: makeAssetCtxs(universe, {
        BTC: { funding: '0', openInterest: '1000', markPx: '100', oraclePx: '100', dayNtlVlm: '1000000' },
      }),
    };
  };

  it('reads inside the protected fetch phase and falls back canonical -> baseline strictly', async () => {
    const events = [];
    const baseline = {
      ts: 1_700_000_000_000 - 5 * 60_000,
      assets: [{
        symbol: 'BTC', openInterest: 1000,
        sparkOi: Array(12).fill(1000), sparkVol: Array(12).fill(1e6),
      }],
    };
    const readSeedSnapshotImpl = async (key, options) => {
      events.push(`read:${key}`);
      assert.deepEqual(options, { strict: true });
      return key === CANONICAL_KEY ? null : baseline;
    };
    const writes = [];
    const writeExtraKeyWithMetaImpl = async (...args) => {
      events.push('write:baseline');
      writes.push(args);
      return true;
    };
    const runSeedImpl = async (domain, resource, key, fetchFn, options) => {
      events.push('runSeed:entered');
      assert.equal(domain, 'market');
      assert.equal(resource, 'hyperliquid-flow');
      assert.equal(key, CANONICAL_KEY);
      const data = await fetchFn();
      assert.equal(options.validateFn(data), true);
      assert.equal(writes.length, 0, 'baseline must not publish during fetch/validation');
      events.push('runSeed:validated');
      await options.afterPublish(data, { canonicalKey: key });
      return data;
    };

    const result = await runHyperliquidFlowSeed({
      runSeedImpl,
      readSeedSnapshotImpl,
      writeExtraKeyWithMetaImpl,
      fetchAllMetaAndCtxsImpl: async () => {
        events.push('fetch:upstream');
        return upstream();
      },
    });

    assert.equal(result.assets.length, ASSETS.length);
    assert.deepEqual(events, [
      'runSeed:entered',
      `read:${CANONICAL_KEY}`,
      `read:${BASELINE_KEY}`,
      'fetch:upstream',
      'runSeed:validated',
      'write:baseline',
    ]);
    assert.equal(writes.length, 1);
    assert.equal(writes[0][0], BASELINE_KEY);
    assert.equal(writes[0][2], BASELINE_TTL_SECONDS);
    assert.equal(writes[0][4], 'seed-meta:market:hyperliquid-flow-baseline');
  });

  it('prefers a valid canonical snapshot without reading the baseline', async () => {
    const canonical = {
      ts: Date.now() - 5 * 60_000,
      assets: [{
        symbol: 'BTC', openInterest: 900,
        sparkOi: Array(12).fill(900), sparkVol: Array(12).fill(1e6),
      }],
    };
    const reads = [];
    const runSeedImpl = async (_domain, _resource, _key, fetchFn) => fetchFn();

    const result = await runHyperliquidFlowSeed({
      runSeedImpl,
      readSeedSnapshotImpl: async (key, options) => {
        reads.push(key);
        assert.deepEqual(options, { strict: true });
        if (key === BASELINE_KEY) {
          throw new Error('baseline must not be read when canonical is available');
        }
        return canonical;
      },
      fetchAllMetaAndCtxsImpl: upstream,
    });

    const btc = result.assets.find((asset) => asset.symbol === 'BTC');
    assert.deepEqual(reads, [CANONICAL_KEY]);
    assert.deepEqual(btc.sparkOi, [...canonical.assets[0].sparkOi, 1000]);
    assert.equal(btc.oiScore > 0, true);
  });

  it('propagates a baseline read error after an explicit canonical miss without fetching or publishing', async () => {
    const expected = new Error('Redis baseline read failed: HTTP 503');
    const reads = [];
    let fetched = false;
    let wrote = false;
    const runSeedImpl = async (_domain, _resource, _key, fetchFn) => fetchFn();

    await assert.rejects(() => runHyperliquidFlowSeed({
      runSeedImpl,
      readSeedSnapshotImpl: async (key, options) => {
        reads.push(key);
        assert.deepEqual(options, { strict: true });
        if (key === CANONICAL_KEY) return null;
        throw expected;
      },
      fetchAllMetaAndCtxsImpl: async () => {
        fetched = true;
        return upstream();
      },
      writeExtraKeyWithMetaImpl: async () => {
        wrote = true;
      },
    }), expected);

    assert.deepEqual(reads, [CANONICAL_KEY, BASELINE_KEY]);
    assert.equal(fetched, false);
    assert.equal(wrote, false);
  });

  it('propagates an ambiguous canonical read and never fetches or overwrites the baseline', async () => {
    const expected = new Error('Redis snapshot read failed: HTTP 503');
    let fetched = false;
    let wrote = false;
    const runSeedImpl = async (_domain, _resource, _key, fetchFn) => fetchFn();

    await assert.rejects(() => runHyperliquidFlowSeed({
      runSeedImpl,
      readSeedSnapshotImpl: async (key, options) => {
        assert.equal(key, CANONICAL_KEY);
        assert.deepEqual(options, { strict: true });
        throw expected;
      },
      fetchAllMetaAndCtxsImpl: async () => {
        fetched = true;
        return upstream();
      },
      writeExtraKeyWithMetaImpl: async () => {
        wrote = true;
      },
    }), expected);

    assert.equal(fetched, false);
    assert.equal(wrote, false);
  });

  it('does not publish the baseline when shared validation rejects the canonical snapshot', async () => {
    let wrote = false;
    const validationError = new Error('validation rejected');
    const runSeedImpl = async (_domain, _resource, _key, fetchFn) => {
      await fetchFn();
      throw validationError; // models runSeed rejecting before afterPublish
    };

    await assert.rejects(() => runHyperliquidFlowSeed({
      runSeedImpl,
      readSeedSnapshotImpl: async () => null,
      fetchAllMetaAndCtxsImpl: upstream,
      writeExtraKeyWithMetaImpl: async () => {
        wrote = true;
      },
    }), validationError);
    assert.equal(wrote, false);
  });

  it('fails after canonical publication when baseline seed-meta is not confirmed', async () => {
    const runSeedImpl = async (_domain, _resource, _key, fetchFn, options) => {
      const snapshot = await fetchFn();
      assert.equal(options.validateFn(snapshot), true);
      await options.afterPublish(snapshot, { canonicalKey: CANONICAL_KEY });
    };

    await assert.rejects(() => runHyperliquidFlowSeed({
      runSeedImpl,
      readSeedSnapshotImpl: async () => null,
      fetchAllMetaAndCtxsImpl: upstream,
      writeExtraKeyWithMetaImpl: async () => false,
    }), /Hyperliquid baseline seed-meta write failed/);
  });
});

describe('alert threshold', () => {
  it('emits HIGH RISK alert at composite >= 60', () => {
    // Funding=100% × 0.30 + Basis=100% × 0.20 = 50; bump volume to push >60
    const prev = {
      symbol: 'BTC',
      sparkVol: Array(12).fill(1_000_000),
      sparkFunding: [], sparkOi: Array(12).fill(1000), sparkScore: [],
      openInterest: 1000,
    };
    const ctx = {
      funding: '0.002', // 2× threshold → score 100
      openInterest: '1500', // 50% delta vs 1000 → 250 → clamped to 100
      markPx: '105', oraclePx: '100', // basis 5% = threshold → 100
      dayNtlVlm: '10000000', // 10× avg → 200/5 → clamped 100
    };
    const out = computeAsset(META_BTC, ctx, prev);
    assert.ok(out.composite >= ALERT_THRESHOLD, `composite=${out.composite}`);
    assert.ok(out.alerts.some((a) => a.includes('HIGH RISK')));
  });
});
