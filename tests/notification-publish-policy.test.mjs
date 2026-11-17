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
    assert.equal(policy.marketMoveDedupTtlSeconds('equity'), 20 * 3600);
    assert.equal(policy.marketMoveDedupTtlSeconds('commodity'), 20 * 3600);
    assert.equal(policy.marketMoveDedupTtlSeconds('crypto'), 24 * 3600);
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

  it('routes every market severity through the policy', () => {
    assert.equal((src.match(/notifyPolicy\.marketMoveSeverity\(/g) || []).length, 3);
    assert.doesNotMatch(src, /Math\.abs\(q\.change\) >= (10|20) \? 'critical'/);
  });

  it('publishes corridor risk and shipping stress through the band-keyed builders', () => {
    assert.match(src, /notifyPolicy\.corridorRiskNotification\(corridorId, c\.riskScore\)/);
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
