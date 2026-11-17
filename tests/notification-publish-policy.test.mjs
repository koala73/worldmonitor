// #10873: what ais-relay publishes to the notification queue, and how often.
// Realtime rules deliver critical events only, so the severity here decides
// whether a subscriber is woken up; the dedup key decides whether an unchanged
// condition repeats every tick.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';

const require = createRequire(import.meta.url);
const policy = require('../scripts/lib/notification-publish-policy.cjs');

const NOW = Date.parse('2026-11-16T12:00:00Z');

describe('market move severity', () => {
  it('caps a single stock at high, whatever the move', () => {
    assert.equal(policy.marketMoveSeverity({ assetClass: 'equity', symbol: 'NU', changePct: 12 }), 'high');
    assert.equal(policy.marketMoveSeverity({ assetClass: 'equity', symbol: 'NVDA', changePct: -35 }), 'high');
  });

  it('keeps an equity index crash critical', () => {
    assert.equal(policy.marketMoveSeverity({ assetClass: 'equity', symbol: '^GSPC', changePct: -10.4 }), 'critical');
    assert.equal(policy.marketMoveSeverity({ assetClass: 'equity', symbol: '^TASI.SR', changePct: 7 }), 'high');
  });

  it('never makes the VIX critical', () => {
    assert.equal(policy.marketMoveSeverity({ assetClass: 'commodity', symbol: '^VIX', changePct: 32 }), 'high');
  });

  it('keeps a 10% commodity move and a 20% crypto move critical', () => {
    assert.equal(policy.marketMoveSeverity({ assetClass: 'commodity', symbol: 'CL=F', changePct: -11 }), 'critical');
    assert.equal(policy.marketMoveSeverity({ assetClass: 'crypto', symbol: 'BTC', changePct: -21 }), 'critical');
    assert.equal(policy.marketMoveSeverity({ assetClass: 'crypto', symbol: 'BTC', changePct: 12 }), 'high');
  });

  it('publishes nothing below the move floor', () => {
    assert.equal(policy.marketMoveSeverity({ assetClass: 'equity', symbol: '^GSPC', changePct: 4.9 }), null);
    assert.equal(policy.marketMoveSeverity({ assetClass: 'crypto', symbol: 'ETH', changePct: 9 }), null);
    assert.equal(policy.marketMoveSeverity({ assetClass: 'equity', symbol: 'X', changePct: Number.NaN }), null);
  });

  it('holds one move for a session, not an hour', () => {
    assert.equal(policy.marketMoveDedupTtlSeconds('equity'), 4 * 24 * 3600);
    assert.equal(policy.marketMoveDedupTtlSeconds('commodity'), 4 * 24 * 3600);
    assert.equal(policy.marketMoveDedupTtlSeconds('crypto'), 24 * 3600);
  });

  it('keys a daily move by its trade session, so a move at the close cannot block the next open', () => {
    const sec = (iso) => Date.parse(iso) / 1000;
    const close = policy.marketMoveSessionKey('equity', sec('2026-11-16T20:55:00Z'));
    const nextOpen = policy.marketMoveSessionKey('equity', sec('2026-11-17T14:35:00Z'));
    assert.equal(close, '2026-11-16');
    assert.notEqual(close, nextOpen);
    assert.equal(policy.marketMoveSessionKey('crypto', sec('2026-11-16T20:55:00Z')), undefined);
  });

  it('keeps a closed market on its last session all weekend, past midnight UTC', () => {
    const fridayClose = Date.parse('2026-11-13T21:00:00Z') / 1000;
    const keys = ['2026-11-14T00:05:00Z', '2026-11-15T12:00:00Z', '2026-11-16T08:00:00Z']
      .map((at) => policy.marketMoveSessionKey('equity', fridayClose, Date.parse(at)));
    assert.deepEqual(new Set(keys), new Set(['2026-11-13']));
    // The dedup outlives the closure the stable key spans.
    assert.ok(policy.marketMoveDedupTtlSeconds('equity') >= 3 * 24 * 3600);
  });

  it('falls back to the wall-clock date without a trade time', () => {
    assert.equal(policy.marketMoveSessionKey('commodity', undefined, NOW), '2026-11-16');
    assert.equal(policy.marketMoveSessionKey('commodity', 0, NOW), '2026-11-16');
  });

  it('treats every catalog index as an index, caret or not', () => {
    const stocks = JSON.parse(readFileSync(new URL('../shared/stocks.json', import.meta.url), 'utf8'));
    const indexes = stocks.symbols.filter((s) => /\b(?:composite|index|ftse|nikkei|hang seng|dax|cac|s&p|nasdaq|dow|kospi|sensex|nifty|tasi|ibex|aex|smi|stoxx)\b/i.test(s.name));
    assert.ok(indexes.some((s) => s.symbol === '000001.SS'));
    for (const { symbol, name } of indexes) {
      if (symbol === '^VIX') continue;
      assert.equal(policy.isEquityIndexSymbol(symbol), true, `${symbol} (${name})`);
    }
    assert.equal(policy.marketMoveSeverity({ assetClass: 'equity', symbol: 'FTSEMIB.MI', changePct: -11 }), 'critical');
    // Market-wide trackers the name keywords miss.
    for (const symbol of ['DFMGI.AE', 'NQ=F', 'QQQ', 'QAT', 'UAE']) {
      assert.equal(policy.isEquityIndexSymbol(symbol), true, symbol);
      assert.equal(policy.marketMoveSeverity({ assetClass: 'equity', symbol, changePct: -11 }), 'critical', symbol);
    }
    assert.equal(policy.marketMoveSeverity({ assetClass: 'equity', symbol: '600519.SS', changePct: -11 }), 'high');
  });

  it('marks only index, commodity and crypto moves as global', () => {
    assert.equal(policy.isGlobalMarketMove({ assetClass: 'equity', symbol: '^N225' }), true);
    assert.equal(policy.isGlobalMarketMove({ assetClass: 'commodity', symbol: 'GC=F' }), true);
    assert.equal(policy.isGlobalMarketMove({ assetClass: 'crypto', symbol: 'BTC' }), true);
    assert.equal(policy.isGlobalMarketMove({ assetClass: 'equity', symbol: 'NU' }), false);
    assert.equal(policy.isGlobalMarketMove({ assetClass: 'commodity', symbol: '^VIX' }), false);
    assert.equal(policy.isGlobalMarketMove({ title: 'NU: +12% surge' }), false);
  });
});

describe('corridor risk', () => {
  it('dedups on corridor and band, so an unchanged score is sent once a day', () => {
    const a = policy.corridorRiskNotification('hormuz_strait', 85);
    const b = policy.corridorRiskNotification('hormuz_strait', 86);
    assert.equal(a.payload.coalesceKey, 'corridor:hormuz_strait:critical');
    assert.equal(b.payload.coalesceKey, a.payload.coalesceKey);
    assert.equal(a.dedupTtl, 86_400);
    assert.equal(a.severity, 'critical');
    assert.equal(a.payload.title, 'Hormuz Strait: risk score 85');
  });

  it('sends again when the corridor crosses into a higher band', () => {
    const high = policy.corridorRiskNotification('suez', 65);
    const critical = policy.corridorRiskNotification('suez', 72);
    assert.equal(high.severity, 'high');
    assert.notEqual(high.payload.coalesceKey, critical.payload.coalesceKey);
  });

  it('carries the chokepoint id the relay scopes on', () => {
    assert.equal(policy.corridorRiskNotification('bab_el_mandeb', 90).payload.chokepointId, 'bab_el_mandeb');
  });

  it('publishes nothing below 50', () => {
    assert.equal(policy.corridorRiskNotification('bosphorus', 49), null);
    assert.equal(policy.corridorRiskNotification('', 90), null);
  });
});

describe('corridor risk transitions', () => {
  // The feed on 2026-11-17: every corridor at 85, the score's ceiling, whether
  // it logged 12 incidents in a week (Suez) or 703 (South China Sea). The
  // 24h band dedup re-sent all five as critical every day.
  const PINNED = { hormuz_strait: 85, bab_el_mandeb: 85, suez: 85, taiwan_strait: 85, bosphorus: 85 };
  const ALL_CRITICAL = Object.fromEntries(Object.keys(PINNED).map((id) => [id, 'critical']));

  it('sends nothing for a corridor that stays in its band', () => {
    const { notifications, nextBands } = policy.corridorRiskTransitions(ALL_CRITICAL, PINNED);
    assert.deepEqual(notifications, []);
    assert.deepEqual(nextBands, ALL_CRITICAL);
  });

  it('records the first reading silently, so a deploy or a fresh key does not page everyone', () => {
    const { notifications, nextBands } = policy.corridorRiskTransitions(null, { suez: 72, bosphorus: 40 });
    assert.deepEqual(notifications, []);
    assert.deepEqual(nextBands, { suez: 'critical', bosphorus: 'none' });
  });

  it('records a corridor first seen in a later reading silently', () => {
    const { notifications } = policy.corridorRiskTransitions({ suez: 'none' }, { suez: 40, hormuz_strait: 90 });
    assert.deepEqual(notifications, []);
  });

  it('sends once when a corridor rises into a higher band', () => {
    const { notifications, nextBands } = policy.corridorRiskTransitions(
      { suez: 'none', hormuz_strait: 'high', bosphorus: 'critical' },
      { suez: 72, hormuz_strait: 75, bosphorus: 90 },
    );
    assert.deepEqual(notifications.map((n) => [n.payload.chokepointId, n.severity]), [
      ['suez', 'critical'],
      ['hormuz_strait', 'critical'],
    ]);
    assert.equal(nextBands.bosphorus, 'critical');
  });

  it('sends nothing when a corridor falls to a lower band, and re-arms the rise', () => {
    const fell = policy.corridorRiskTransitions({ suez: 'critical' }, { suez: 60 });
    assert.deepEqual(fell.notifications, []);
    assert.deepEqual(fell.nextBands, { suez: 'high' });
    const rose = policy.corridorRiskTransitions(fell.nextBands, { suez: 80 });
    assert.equal(rose.notifications.length, 1);
  });

  function harness(stored, { readFails = false, writeFails = false, publishOk = () => true } = {}) {
    const calls = { published: [], written: [] };
    return {
      calls,
      io: {
        readBands: async () => (readFails ? { ok: false } : { ok: true, bands: stored }),
        writeBands: async (bands) => { calls.written.push(bands); return !writeFails; },
        publish: async (n) => { calls.published.push(n.payload.chokepointId); return publishOk(n); },
      },
    };
  }

  it('relay glue: an unchanged pinned feed publishes nothing hour after hour', async () => {
    let stored = null;
    for (let tick = 0; tick < 24; tick++) {
      const { calls, io } = harness(stored);
      await policy.publishCorridorRiskTransitions({ scores: PINNED, ...io });
      assert.deepEqual(calls.published, []);
      stored = calls.written.at(-1);
    }
    assert.deepEqual(stored, ALL_CRITICAL);
  });

  it('relay glue: a failed state read publishes and writes nothing', async () => {
    const { calls, io } = harness(null, { readFails: true });
    const out = await policy.publishCorridorRiskTransitions({ scores: { suez: 90 }, ...io });
    assert.equal(out.skipped, 'state-read-failed');
    assert.deepEqual(calls.published, []);
    assert.deepEqual(calls.written, []);
  });

  it('relay glue: a failed state write is reported, not swallowed', async () => {
    const quiet = harness({ suez: 'critical' }, { writeFails: true });
    assert.deepEqual(
      await policy.publishCorridorRiskTransitions({ scores: { suez: 60 }, ...quiet.io }),
      { published: 0, skipped: 'state-write-failed' },
    );
    const rose = harness({ suez: 'none' }, { writeFails: true });
    assert.deepEqual(
      await policy.publishCorridorRiskTransitions({ scores: { suez: 90 }, ...rose.io }),
      { published: 1, skipped: 'state-write-failed' },
    );
  });

  it('relay glue: a rise whose publish fails keeps the old band so the next tick retries', async () => {
    const { calls, io } = harness({ suez: 'none', bosphorus: 'none' }, { publishOk: (n) => n.payload.chokepointId !== 'suez' });
    await policy.publishCorridorRiskTransitions({ scores: { suez: 90, bosphorus: 90 }, ...io });
    assert.deepEqual(calls.published, ['suez', 'bosphorus']);
    assert.deepEqual(calls.written[0], { suez: 'none', bosphorus: 'critical' });
  });

  it('ignores a corridor whose score is not a number', () => {
    const { notifications, nextBands } = policy.corridorRiskTransitions({ suez: 'none' }, { suez: 'n/a' });
    assert.deepEqual(notifications, []);
    assert.deepEqual(nextBands, { suez: 'none' });
  });
});

describe('shipping stress', () => {
  it('dedups on the band for a day', () => {
    const a = policy.shippingStressNotification(91, 'critical');
    const b = policy.shippingStressNotification(95, 'critical');
    assert.equal(a.payload.coalesceKey, 'shipping_stress:critical');
    assert.equal(b.payload.coalesceKey, a.payload.coalesceKey);
    assert.equal(a.dedupTtl, 86_400);
    assert.equal(policy.shippingStressNotification(80, 'critical').severity, 'high');
    assert.equal(policy.shippingStressNotification(74, 'elevated'), null);
  });
});

describe('weather alert title', () => {
  const swicWind = {
    source: 'swic',
    event: 'Wind',
    headline: 'Wind',
    severity: 'Extreme',
    areaDesc: 'Alakol district',
    countryCode: 'KZ',
    expires: '2026-11-17T15:00:00Z',
  };

  it('names what, where and until when for a bare WMO title', () => {
    assert.equal(
      policy.weatherAlertNotifyTitle(swicWind, NOW),
      'Extreme wind warning: Alakol district, Kazakhstan (until 17 Nov 15:00 UTC)',
    );
  });

  it('rebuilds a literal "CAP Alert" title from the area and country', () => {
    const title = policy.weatherAlertNotifyTitle({
      source: 'swic', event: 'CAP Alert', headline: 'CAP Alert', severity: 'Severe',
      areaDesc: 'Antioquia', countryCode: 'CO', expires: '',
    }, NOW);
    assert.equal(title, 'Severe weather warning: Antioquia, Colombia');
  });

  it('does not repeat the country when the area already names it', () => {
    const title = policy.weatherAlertNotifyTitle({ ...swicWind, areaDesc: 'Almaty Region, Kazakhstan' }, NOW);
    assert.equal(title, 'Extreme wind warning: Almaty Region, Kazakhstan (until 17 Nov 15:00 UTC)');
  });

  it('keeps an event that already reads as a warning, and drops a past expiry', () => {
    const title = policy.weatherAlertNotifyTitle({
      source: 'eccc', event: 'Snowfall warning', headline: 'Snowfall warning — Banff', severity: 'Severe',
      areaDesc: 'Banff, AB', countryCode: 'CA', expires: '2026-11-15T00:00:00Z',
    }, NOW);
    assert.equal(title, 'Severe snowfall warning: Banff, AB, Canada');
  });

  it('keeps an NWS headline, which already carries the office and expiry', () => {
    const headline = 'Blizzard Warning issued November 16 at 3:00AM CST until November 17 at 6:00PM CST by NWS Bismarck ND';
    assert.equal(policy.weatherAlertNotifyTitle({ source: 'nws', headline, event: 'Blizzard Warning', countryCode: 'US' }, NOW), headline);
  });

  it('dedups an active alert until it expires, between 1h and 24h', () => {
    assert.equal(policy.weatherAlertDedupTtlSeconds({ expires: '2026-11-16T18:00:00Z' }, NOW), 6 * 3600);
    assert.equal(policy.weatherAlertDedupTtlSeconds({ expires: '2026-11-16T12:10:00Z' }, NOW), 3600);
    assert.equal(policy.weatherAlertDedupTtlSeconds({ expires: '2026-11-20T00:00:00Z' }, NOW), 86_400);
    assert.equal(policy.weatherAlertDedupTtlSeconds({ expires: '' }, NOW), 6 * 3600);
  });
});

describe('weather coalesce key', () => {
  it('sends an upgrade to Extreme once more, and an unchanged band never again', () => {
    const severe = policy.weatherAlertCoalesceKey('weather:eccc:CA:wind:area', 'Severe');
    const extreme = policy.weatherAlertCoalesceKey('weather:eccc:CA:wind:area', 'Extreme');
    assert.notEqual(severe, extreme);
    assert.equal(severe, policy.weatherAlertCoalesceKey('weather:eccc:CA:wind:area', 'Moderate'));
    assert.equal(policy.weatherAlertCoalesceKey(undefined, 'Extreme'), undefined);
  });
});

describe('news country', () => {
  it('names the country only when the headline names exactly one', () => {
    assert.equal(policy.primaryNewsCountryCode(['ua']), 'UA');
    assert.equal(policy.primaryNewsCountryCode(['UA', 'UA']), 'UA');
    assert.equal(policy.primaryNewsCountryCode(['UA', 'RU']), undefined);
    assert.equal(policy.primaryNewsCountryCode([]), undefined);
    assert.equal(policy.primaryNewsCountryCode(undefined), undefined);
  });
});

describe('ais-relay wiring', () => {
  const src = readFileSync(new URL('../scripts/ais-relay.cjs', import.meta.url), 'utf8');

  it('keys equity and commodity moves by session, and weather by severity band', () => {
    assert.match(src, /marketAlertCoalesceKey\('equity', q\.symbol, dir, severity, notifyPolicy\.marketMoveSessionKey\('equity', lastTradeAtBySymbol\.get\(q\.symbol\)\)\)/);
    assert.match(src, /marketAlertCoalesceKey\('commodity', q\.symbol \|\| q\.name, dir, severity, notifyPolicy\.marketMoveSessionKey\('commodity', lastTradeAtBySymbol\.get\(q\.symbol\)\)\)/);
    assert.match(src, /resolve\(\{ price: data\.c, changePercent: data\.dp, lastTradeAt: data\.t \}\)/);
    assert.match(src, /notifyPolicy\.weatherAlertCoalesceKey\(weatherAlertFamilyKey\(a\), a\.severity\)/);
  });

  it('alerts on fresh equity quotes only, never a retained one', () => {
    assert.match(src, /const movingStocks = quotes\.filter\(q => lastTradeAtBySymbol\.has\(q\.symbol\) && /);
  });

  it('routes every market severity through the policy', () => {
    assert.equal((src.match(/notifyPolicy\.marketMoveSeverity\(/g) || []).length, 3);
    assert.doesNotMatch(src, /Math\.abs\(q\.change\) >= (10|20) \? 'critical'/);
  });

  it('publishes corridor risk and shipping stress through the band-keyed builders', () => {
    assert.match(src, /notifyPolicy\.publishCorridorRiskTransitions\(\{/);
    assert.doesNotMatch(src, /notifyPolicy\.corridorRiskNotification\(/);
    assert.match(src, /notifyPolicy\.shippingStressNotification\(stressScore, stressLevel\)/);
  });

  it('never publishes a cyber indicator as critical', () => {
    const block = src.slice(src.indexOf("eventType: 'cyber_threat'"), src.indexOf("eventType: 'cyber_threat'") + 600);
    assert.match(block, /severity: 'high'/);
  });

  it('titles weather alerts and dedups them until they expire', () => {
    assert.match(src, /title: notifyPolicy\.weatherAlertNotifyTitle\(a\)/);
    assert.match(src, /dedupTtl: notifyPolicy\.weatherAlertDedupTtlSeconds\(a\)/);
  });

  it('keeps rss_alert unattributed for the relay, adding only primaryCountryCode', () => {
    const start = src.indexOf("eventType: 'rss_alert'");
    const block = src.slice(start, src.indexOf('severity: level', start));
    assert.match(block, /primaryCountryCode/);
    assert.doesNotMatch(block, /^\s*(?:\.\.\.\(.*)?\bcountryCode\b\s*[:,}]/m);
  });
});
