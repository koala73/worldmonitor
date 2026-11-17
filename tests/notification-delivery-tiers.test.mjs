// #10873: realtime delivery tiers. A rule with no countries used to receive
// every critical event in the world (a Kazakh wind warning, a Colombian CAP
// alert, one airport's delays), while a scoped rule never received a global
// event without a country. Each event type now has one tier: global (every
// rule), local (rules listing the event's country) or opt_in (the type's own
// scope).
import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Module, { createRequire } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

process.env.UPSTASH_REDIS_REST_URL ??= 'https://stub.upstash.io';
process.env.UPSTASH_REDIS_REST_TOKEN ??= 'stub-token';
process.env.CONVEX_URL ??= 'https://stub.convex.cloud';
process.env.CONVEX_NOTIFICATION_RELAY_SECRET ??= 'stub-secret';
process.env.TELEGRAM_BOT_TOKEN ??= 'stub-bot-token';

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, ...rest) {
  if (request === 'resend') return { Resend: class {} };
  if (request === 'convex/browser') return { ConvexHttpClient: class { async query() {} } };
  return originalLoad.call(this, request, parent, ...rest);
};

const tiers = require('../scripts/lib/notification-delivery-tiers.cjs');

let relay;
before(() => {
  relay = require(resolve(__dirname, '..', 'scripts', 'notification-relay.cjs'));
  assert.equal(typeof relay.eventMatchesDeliveryScope, 'function');
});

const UNSCOPED = { countries: [], eventTypes: [], sensitivity: 'critical' };
const KZ_RULE = { countries: ['KZ'], eventTypes: [], sensitivity: 'critical' };
const US_RULE = { countries: ['US'], eventTypes: [], sensitivity: 'critical' };

const ev = (eventType, payload = {}, extra = {}) => ({ eventType, severity: 'critical', payload: { title: 't', ...payload }, ...extra });

describe('every published event type has an explicit tier', () => {
  // Control events never reach rule matching: processEventDelivery handles
  // channel_welcome and flush_quiet_held first, and digest / quiet_hours_batch
  // are payload shapes the relay builds itself, never queue events.
  const CONTROL = new Set(['channel_welcome', 'flush_quiet_held', 'digest', 'quiet_hours_batch', 'riot']);

  function publishedTypes() {
    const found = new Set();
    const walk = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name === 'vendor') continue;
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (/\.(c?js|mjs)$/.test(entry.name)) {
          const src = readFileSync(path, 'utf8');
          for (const m of src.matchAll(/eventType:\s*'([a-z_]+)'/g)) found.add(m[1]);
          for (const m of src.matchAll(/(?:const|let)\s+EVENT_[A-Z_]+\s*=\s*'([a-z_]+)'/g)) found.add(m[1]);
        }
      }
    };
    walk(resolve(__dirname, '..', 'scripts'));
    return [...found].filter((t) => !CONTROL.has(t));
  }

  it('finds the publishers it is meant to police', () => {
    const types = publishedTypes();
    for (const t of ['weather_alert', 'market_alert', 'corridor_risk', 'rss_alert', 'aviation_closure', 'regional_regime_shift']) {
      assert.ok(types.includes(t), `scan missed ${t}`);
    }
  });

  it('has a tier for each one, so a new publisher cannot broadcast by default', () => {
    const missing = publishedTypes().filter((t) => !tiers.hasExplicitTier(t));
    assert.deepEqual(missing, []);
    assert.equal(tiers.hasExplicitTier('china_policy_decision_signal'), true);
  });

  it('treats an unknown type as local', () => {
    assert.equal(tiers.resolveDeliveryTier(ev('some_new_feed')).tier, 'local');
  });
});

describe('local events reach only the rules that list their country', () => {
  const wind = ev('weather_alert', { countryCode: 'KZ', title: 'Extreme wind warning: Alakol district, Kazakhstan' });

  it('no longer reaches a rule with no countries', () => {
    assert.equal(relay.eventMatchesDeliveryScope(wind, UNSCOPED), false);
  });

  it('reaches a rule that lists the country, and not one that does not', () => {
    assert.equal(relay.eventMatchesDeliveryScope(wind, KZ_RULE), true);
    assert.equal(relay.eventMatchesDeliveryScope(wind, US_RULE), false);
  });

  it('drops an unattributed local event everywhere', () => {
    const unplaced = ev('aviation_closure', {});
    assert.equal(relay.eventMatchesDeliveryScope(unplaced, UNSCOPED), false);
    assert.equal(relay.eventMatchesDeliveryScope(unplaced, KZ_RULE), false);
  });

  it('resolves a country name to its code', () => {
    assert.equal(relay.eventMatchesDeliveryScope(ev('conflict_escalation', { country: 'Kazakhstan' }), KZ_RULE), true);
  });

  it('matches a regional event through region membership only', () => {
    const regional = ev('regional_regime_shift', { region_id: 'europe', countryCode: 'US' });
    assert.equal(relay.eventMatchesDeliveryScope(regional, KZ_RULE), true);
    assert.equal(relay.eventMatchesDeliveryScope(regional, US_RULE), false);
    assert.equal(relay.eventMatchesDeliveryScope(regional, UNSCOPED), false);
  });

  for (const type of ['oref_siren', 'cyber_threat', 'notam_closure', 'china_activity_nowcast_transition']) {
    it(`${type} is local`, () => {
      assert.equal(relay.eventMatchesDeliveryScope(ev(type, { countryCode: 'KZ' }), UNSCOPED), false);
      assert.equal(relay.eventMatchesDeliveryScope(ev(type, { countryCode: 'KZ' }), KZ_RULE), true);
    });
  }
});

describe('global events reach every rule, scoped or not', () => {
  const globals = [
    ev('shipping_stress', { coalesceKey: 'shipping_stress:critical' }),
    ev('aviation_traffic_collapse', { countryCode: 'IR' }),
    ev('market_alert', { assetClass: 'commodity', symbol: 'CL=F' }),
    ev('market_alert', { assetClass: 'crypto', symbol: 'BTC' }),
    ev('market_alert', { assetClass: 'equity', symbol: '^GSPC' }),
  ];
  for (const event of globals) {
    it(`${event.eventType} ${event.payload.symbol ?? ''}`.trim(), () => {
      assert.equal(relay.eventMatchesDeliveryScope(event, UNSCOPED), true);
      assert.equal(relay.eventMatchesDeliveryScope(event, KZ_RULE), true);
    });
  }

  it('keeps a single stock or the VIX local, so it reaches no rule without a country', () => {
    for (const payload of [{ assetClass: 'equity', symbol: 'NU' }, { assetClass: 'commodity', symbol: '^VIX' }, {}]) {
      const event = ev('market_alert', payload);
      assert.equal(relay.eventMatchesDeliveryScope(event, UNSCOPED), false);
      assert.equal(relay.eventMatchesDeliveryScope(event, KZ_RULE), false);
    }
  });
});

describe('news', () => {
  it('stays global when the headline names no single country, including events from before the field existed', () => {
    const event = ev('rss_alert', { countryCodes: ['UA', 'RU'], importanceScore: 70 });
    assert.equal(relay.eventMatchesDeliveryScope(event, UNSCOPED), true);
    assert.equal(relay.eventMatchesDeliveryScope(event, US_RULE), true);
  });

  it('is local when it names one country and stays under the critical importance bar', () => {
    const event = ev('rss_alert', { primaryCountryCode: 'KZ', importanceScore: 70 });
    assert.equal(relay.eventMatchesDeliveryScope(event, KZ_RULE), true);
    assert.equal(relay.eventMatchesDeliveryScope(event, US_RULE), false);
    assert.equal(relay.eventMatchesDeliveryScope(event, UNSCOPED), false);
  });

  it('is local when a single-country feed attributes it with countryCode', () => {
    const event = ev('rss_alert', { countryCode: 'SA', title: 'Civil defense warning' });
    assert.equal(relay.eventMatchesDeliveryScope(event, { ...UNSCOPED, countries: ['SA'] }), true);
    assert.equal(relay.eventMatchesDeliveryScope(event, US_RULE), false);
    assert.equal(relay.eventMatchesDeliveryScope(event, UNSCOPED), false);
  });

  it('reaches everyone when a single-country story clears the critical bar', () => {
    const event = ev('rss_alert', { primaryCountryCode: 'KZ', importanceScore: tiers.NEWS_GLOBAL_IMPORTANCE_SCORE });
    assert.equal(relay.eventMatchesDeliveryScope(event, US_RULE), true);
    assert.equal(relay.eventMatchesDeliveryScope(event, UNSCOPED), true);
  });

  it('keeps legacy semantics for a browser-submitted event, which only reaches its own submitter', () => {
    const event = ev('keyword_spike', {}, { userId: 'u1' });
    assert.equal(relay.eventMatchesDeliveryScope(event, { ...UNSCOPED, userId: 'u1' }), true);
    assert.equal(relay.eventMatchesDeliveryScope(event, { ...KZ_RULE, userId: 'u1' }), true);
  });
});

describe('opt-in events', () => {
  it('ignore country scope', () => {
    const event = ev('chokepoint_disruption', { chokepointId: 'suez' });
    assert.equal(relay.eventMatchesDeliveryScope(event, KZ_RULE), true);
    assert.equal(relay.eventMatchesDeliveryScope(event, UNSCOPED), true);
  });

  it('corridor_risk rides the chokepoint_disruption opt-in and its chokepoint list', () => {
    const corridor = ev('corridor_risk', { chokepointId: 'hormuz_strait' });
    assert.equal(relay.ruleMatchesEventType({ eventTypes: [] }, corridor), false);
    assert.equal(relay.ruleMatchesEventType({ eventTypes: ['corridor_risk'] }, corridor), false);
    assert.equal(relay.ruleMatchesEventType({ eventTypes: ['chokepoint_disruption'] }, corridor), true);
    assert.equal(relay.eventMatchesChokepointScope(corridor, { chokepoints: [] }), true);
    assert.equal(relay.eventMatchesChokepointScope(corridor, { chokepoints: ['hormuz_strait'] }), true);
    assert.equal(relay.eventMatchesChokepointScope(corridor, { chokepoints: ['suez'] }), false);
  });

  it('drops a corridor_risk event from before it carried its chokepoint', () => {
    assert.equal(relay.eventMatchesChokepointScope(ev('corridor_risk', {}), { chokepoints: [] }), false);
  });
});

describe('relay wiring', () => {
  const src = readFileSync(resolve(__dirname, '..', 'scripts', 'notification-relay.cjs'), 'utf8');

  it('matches rules, counts scope drops and clamps free rules through the tier gate', () => {
    assert.equal((src.match(/eventMatchesDeliveryScope\(/g) || []).length >= 5, true);
    const matchBlock = src.slice(src.indexOf('const matching = enabledRules.filter'), src.indexOf('const countryScopeDrops'));
    assert.match(matchBlock, /eventMatchesDeliveryScope\(event, r\)/);
    assert.doesNotMatch(matchBlock, /eventMatchesCountryScope\(/);
    assert.match(src, /!eventMatchesDeliveryScope\(event, \{ \.\.\.rule, countries: scope\.countries \}\)/);
    assert.match(src, /!eventMatchesDeliveryScope\(ev, \{ countries: drainScope\.countries \}\)/);
  });
});
