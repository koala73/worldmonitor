/**
 * Regression coverage for scripts/notification-relay.cjs's
 * eventMatchesCountryScope filter (country-scoping PR, #5359).
 *
 * This file used to MIRROR the filter — a hand-copied reimplementation that
 * deliberately omitted the regional_* branch and was 'kept in sync' by a
 * source grep. A mirror cannot fail when the relay changes, and this one had
 * already diverged. The real export is loaded here with the same env-stub and
 * loader-patch technique as tests/notification-relay-country-scope-5359.test.mjs:
 * the relay only starts its poll loop when require.main === module, so
 * requiring it from a test is side-effect free.
 *
 * Run: node --test tests/notification-relay-country-filter.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

process.env.UPSTASH_REDIS_REST_URL ??= 'https://stub.upstash.io';
process.env.UPSTASH_REDIS_REST_TOKEN ??= 'stub-token';
process.env.CONVEX_URL ??= 'https://stub.convex.cloud';
process.env.RELAY_SHARED_SECRET ??= 'stub-secret';
process.env.TELEGRAM_BOT_TOKEN ??= 'stub-bot-token';

// The relay's runtime deps live in scripts/package.json and are only installed
// in the Railway container — stub them at the loader level.
const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, ...rest) {
  if (request === 'resend') return { Resend: class {} };
  if (request === 'convex/browser') {
    return { ConvexHttpClient: class { async query() {} } };
  }
  return originalLoad.call(this, request, parent, ...rest);
};

const {
  COUNTRY_NAME_TO_ISO2,
  countryNameToIso2,
} = require('../scripts/shared/country-name-to-iso2.cjs');

const { eventMatchesCountryScope } = require(
  resolve(__dirname, '..', 'scripts', 'notification-relay.cjs'),
);

const relaySrc = readFileSync(
  resolve(__dirname, '..', 'scripts', 'notification-relay.cjs'),
  'utf-8',
);
const aisRelaySrc = readFileSync(
  resolve(__dirname, '..', 'scripts', 'ais-relay.cjs'),
  'utf-8',
);


describe('notification-relay eventMatchesCountryScope — source-grep contract', () => {
  it('publisher and dispatcher both import the shared country-name map', () => {
    assert.match(
      relaySrc,
      /require\(['"]\.\/shared\/country-name-to-iso2\.cjs['"]\)/,
      'notification-relay must import the shared country-name normalizer',
    );
    assert.match(
      aisRelaySrc,
      /require\(['"]\.\/shared\/country-name-to-iso2\.cjs['"]\)/,
      'ais-relay must import the same shared country-name normalizer',
    );
    assert.doesNotMatch(
      relaySrc,
      /EVENT_COUNTRY_NAME_TO_ISO2\s*=\s*new Map/,
      'notification-relay must not keep a private country-name map',
    );
    assert.doesNotMatch(
      aisRelaySrc,
      /NOTIFICATION_COUNTRY_NAME_TO_ISO2\s*=\s*new Map/,
      'ais-relay must not keep a private country-name map',
    );
  });

  it('declares eventMatchesCountryScope helper', () => {
    assert.match(
      relaySrc,
      /function\s+eventMatchesCountryScope\s*\(\s*event\s*,\s*rule\s*\)/,
      'relay must declare eventMatchesCountryScope(event, rule)',
    );
  });

  it('empty/absent rule.countries returns true (all events match)', () => {
    // Source must early-return true for empty/missing arrays.
    assert.match(
      relaySrc,
      /if\s*\(\s*!\s*Array\.isArray\(\s*rule\.countries\s*\)\s*\|\|\s*rule\.countries\.length\s*===\s*0\s*\)\s*return\s+true/,
      'empty/absent rule.countries must early-return true',
    );
  });

  it('country attribution is extracted with payload.countryCode → payload.country → event.country priority', () => {
    // The fallback chain must be in this order so publishers using either
    // shape (regional-snapshot uses countryCode; ais-relay uses country) all
    // resolve correctly.
    assert.match(
      relaySrc,
      /event\??\.payload\??\.countryCode\s*\?\?\s*event\??\.payload\??\.country\s*\?\?\s*event\??\.country/,
      'extraction priority must be payload.countryCode → payload.country → event.country',
    );
  });

  it('unattributed events default to DROP with an explicit news-permissive allowlist (#5359)', () => {
    // A populated country scope is a user opt-in to narrower delivery. Any
    // event without country attribution must not leak to scoped users unless
    // its type is explicitly news-permissive.
    assert.match(
      relaySrc,
      /PERMISSIVE_UNATTRIBUTED_EVENT_TYPES/,
      'relay must define the permissive-unattributed allowlist',
    );
    assert.match(
      relaySrc,
      /return\s+isPermissiveUnattributedEvent\(event\)/,
      'missing/empty country attribution must drop unless news-permissive',
    );
    assert.doesNotMatch(
      relaySrc,
      /UNATTRIBUTED_GLOBAL_EVENT_TYPES/,
      'the pre-#5359 global denylist must not come back (default is DROP now)',
    );
  });

  it('unknown malformed country (non-2-letter) follows the same permissive-unattributed gate', () => {
    assert.match(
      relaySrc,
      /if\s*\(\s*normalized\s*===\s*null\s*\)\s*return\s+isPermissiveUnattributedEvent\(event\)/,
      'unknown malformed country must use the same permissive-unattributed gate',
    );
  });

  it('filter is wired into the per-rule matching loop alongside shouldNotify', () => {
    // The filter must be in the .filter() arrow that builds `matching`.
    // Without this wiring, the filter exists but is never consulted.
    assert.match(
      relaySrc,
      /shouldNotify\(r,\s*event\)\s*&&\s*\n?\s*eventMatchesCountryScope\(event,\s*r\)/,
      'eventMatchesCountryScope must be in the matching filter alongside shouldNotify',
    );
  });
});

describe('notification-relay eventMatchesCountryScope — behavioural', () => {
  it('shared country-name map covers UK aliases used by both publisher and dispatcher', () => {
    assert.equal(COUNTRY_NAME_TO_ISO2['united kingdom'], 'GB');
    assert.equal(COUNTRY_NAME_TO_ISO2.uk, 'GB');
    assert.equal(countryNameToIso2('United Kingdom'), 'GB');
    assert.equal(countryNameToIso2('UK'), 'GB');
  });

  it("rule.countries=['GB'] + event.payload.country='United Kingdom' → true", () => {
    const event = { eventType: 'rss_alert', payload: { country: 'United Kingdom' } };
    assert.equal(eventMatchesCountryScope(event, { countries: ['GB'] }), true);
    assert.equal(eventMatchesCountryScope(event, { countries: ['US'] }), false);
  });

  it('rule.countries=[] → all events match', () => {
    const event = { eventType: 'rss_alert', payload: { country: 'US' } };
    assert.equal(eventMatchesCountryScope(event, { countries: [] }), true);
  });

  it("rule.countries=['US','GB'] + event.payload.countryCode='US' → true", () => {
    const event = { eventType: 'rss_alert', payload: { countryCode: 'US' } };
    assert.equal(eventMatchesCountryScope(event, { countries: ['US', 'GB'] }), true);
  });

  it("rule.countries=['US'] + event.payload.country='IR' → false (strict for attributed mismatch)", () => {
    // Strict for events that ARE attributed but don't match — those are
    // events the publisher unambiguously labelled as a different country.
    const event = { eventType: 'rss_alert', payload: { country: 'IR' } };
    assert.equal(eventMatchesCountryScope(event, { countries: ['US'] }), false);
  });

  it("rule.countries=['US'] + event.payload.country='US' → true (attributed match)", () => {
    const event = { eventType: 'rss_alert', payload: { country: 'US' } };
    assert.equal(eventMatchesCountryScope(event, { countries: ['US'] }), true);
  });

  it("rule.countries=['US'] + rss_alert with NO country attribution → true (RSS remains permissive until attribution exists)", () => {
    const event = { eventType: 'rss_alert', payload: { title: 'something' } };
    assert.equal(eventMatchesCountryScope(event, { countries: ['US'] }), true);
  });

  it("rule.countries=['US'] + rss_alert payload.country='' (empty string) → true", () => {
    const event = { eventType: 'rss_alert', payload: { country: '' } };
    assert.equal(eventMatchesCountryScope(event, { countries: ['US'] }), true);
  });

  it("rule.countries=['US'] + rss_alert payload.country='   ' (whitespace) → true", () => {
    const event = { eventType: 'rss_alert', payload: { country: '   ' } };
    assert.equal(eventMatchesCountryScope(event, { countries: ['US'] }), true);
  });

  it("rule.countries=['US'] + event.payload.countryCode='us' (lowercase) → true (normalized)", () => {
    const event = { eventType: 'rss_alert', payload: { countryCode: 'us' } };
    assert.equal(eventMatchesCountryScope(event, { countries: ['US'] }), true);
  });

  it("rule.countries=['US'] + known malformed country 'USA' → true, but non-matching rules drop", () => {
    const event = { eventType: 'rss_alert', payload: { country: 'USA' } };
    assert.equal(eventMatchesCountryScope(event, { countries: ['US'] }), true);
    assert.equal(eventMatchesCountryScope(event, { countries: ['GB'] }), false);
  });

  it("rule.countries=['US'] + known malformed country 'United States' → true, but non-matching rules drop", () => {
    const event = { eventType: 'rss_alert', payload: { country: 'United States' } };
    assert.equal(eventMatchesCountryScope(event, { countries: ['US'] }), true);
    assert.equal(eventMatchesCountryScope(event, { countries: ['GB'] }), false);
  });

  it("rule.countries=['AE'] + known malformed country 'UAE' → true, but non-matching rules drop", () => {
    const event = { eventType: 'rss_alert', payload: { country: 'UAE' } };
    assert.equal(eventMatchesCountryScope(event, { countries: ['AE'] }), true);
    assert.equal(eventMatchesCountryScope(event, { countries: ['US'] }), false);
  });

  it("rule.countries=['US'] + rss_alert unknown malformed country 'United States of Whatever' → true", () => {
    const event = { eventType: 'rss_alert', payload: { country: 'United States of Whatever' } };
    assert.equal(eventMatchesCountryScope(event, { countries: ['US'] }), true);
  });

  it("rule.countries=['UA','RO'] + global Corridor Risk alert with no country attribution → false", () => {
    const event = {
      eventType: 'corridor_risk',
      severity: 'critical',
      payload: {
        title: 'Suez / Bab el-Mandeb / Taiwan Strait corridor disruption risk rising',
        source: 'Corridor Risk',
      },
    };
    assert.equal(eventMatchesCountryScope(event, { countries: ['UA', 'RO'] }), false);
  });

  it("rule.countries=['UA','RO'] + global Shipping Stress alert with no country attribution → false", () => {
    const event = {
      eventType: 'shipping_stress',
      severity: 'critical',
      payload: {
        title: 'Global shipping stress: score 92/100',
        source: 'Shipping Index',
      },
    };
    assert.equal(eventMatchesCountryScope(event, { countries: ['UA', 'RO'] }), false);
  });

  it("rule.countries=['UA','RO'] + global Corridor Risk with unknown malformed country → false", () => {
    const event = {
      eventType: 'corridor_risk',
      severity: 'critical',
      payload: {
        title: 'Suez Canal disruption risk rising',
        source: 'Corridor Risk',
        country: 'Global maritime corridor',
      },
    };
    assert.equal(eventMatchesCountryScope(event, { countries: ['UA', 'RO'] }), false);
  });

  it('extraction priority: payload.countryCode wins over payload.country', () => {
    const event = { eventType: 'rss_alert', payload: { countryCode: 'US', country: 'GB' } };
    assert.equal(eventMatchesCountryScope(event, { countries: ['US'] }), true);
    assert.equal(eventMatchesCountryScope(event, { countries: ['GB'] }), false);
  });

  it('extraction priority: payload.country wins over event.country', () => {
    const event = { eventType: 'rss_alert', payload: { country: 'US' }, country: 'GB' };
    assert.equal(eventMatchesCountryScope(event, { countries: ['US'] }), true);
    assert.equal(eventMatchesCountryScope(event, { countries: ['GB'] }), false);
  });

  it("rule.countries=undefined → all events match (backward compat)", () => {
    const event = { eventType: 'rss_alert', payload: { country: 'US' } };
    assert.equal(eventMatchesCountryScope(event, {}), true);
  });
});

describe('ais-relay country-specific notification publishers — source-grep contract', () => {
  it('OREF, UCDP, cyber, and NWS publish countryCode when the publisher knows country scope', () => {
    assert.match(
      aisRelaySrc,
      /eventType:\s*'oref_siren'[\s\S]*?countryCode:\s*'IL'/,
      'OREF siren notifications must publish countryCode=IL',
    );
    assert.match(
      aisRelaySrc,
      /eventType:\s*'conflict_escalation'[\s\S]*?countryCode/,
      'UCDP conflict notifications must include normalized countryCode when available',
    );
    assert.match(
      aisRelaySrc,
      /eventType:\s*'cyber_threat'[\s\S]*?countryCode/,
      'cyber notifications must include normalized countryCode when available',
    );
    assert.match(
      aisRelaySrc,
      /weatherAlertNotifyCountryCode\(a\)/,
      'weather notifications must derive countryCode from the stored record (NWS/ECCC/SWIC)',
    );
    assert.match(
      aisRelaySrc,
      /eventType:\s*'weather_alert'[\s\S]{0,500}\.\.\.\(countryCode \? \{ countryCode \} : \{\}\)/,
      'weather_alert payload must publish the derived countryCode, not a hardcoded US default',
    );
  });
});
