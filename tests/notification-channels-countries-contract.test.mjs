/**
 * Source contract for country-scope forwarding through the notification
 * channels API layers.
 *
 * Run: node --test tests/notification-channels-countries-contract.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const edgeSrc = readFileSync(resolve(__dirname, '..', 'api', 'notification-channels.ts'), 'utf-8');
const convexHttpSrc = readFileSync(resolve(__dirname, '..', 'convex', 'http.ts'), 'utf-8');
const convexRulesSrc = readFileSync(resolve(__dirname, '..', 'convex', 'alertRules.ts'), 'utf-8');

describe('notification country-scope forwarding contract', () => {
  it('quiet-hours and digest edge saves forward countries to Convex relay', () => {
    assert.match(
      edgeSrc,
      /action === 'set-quiet-hours'[\s\S]*?countries[\s\S]*?convexRelay\(\{[\s\S]*?countries/,
      'set-quiet-hours must forward countries',
    );
    assert.match(
      edgeSrc,
      /action === 'set-digest-settings'[\s\S]*?countries[\s\S]*?convexRelay\(\{[\s\S]*?countries/,
      'set-digest-settings must forward countries',
    );
  });

  it('Convex HTTP forwards countries into first-row insert-capable mutations', () => {
    assert.match(
      convexHttpSrc,
      /setQuietHoursForUser[\s\S]*?countries:\s*Array\.isArray\(body\.countries\)/,
      'setQuietHoursForUser call must include countries',
    );
    assert.match(
      convexHttpSrc,
      /setDigestSettingsForUser[\s\S]*?countries:\s*Array\.isArray\(body\.countries\)/,
      'setDigestSettingsForUser call must include countries',
    );
  });

  it('set-notification-config rejects non-array countries before mutation forwarding', () => {
    assert.match(
      edgeSrc,
      /countries\s*!==\s*undefined\s*&&\s*!Array\.isArray\(countries\)[\s\S]*?COUNTRIES_MUST_BE_ARRAY/,
      'Vercel edge route must reject non-array countries',
    );
    assert.match(
      convexHttpSrc,
      /body\.countries\s*!==\s*undefined\s*&&\s*!Array\.isArray\(body\.countries\)[\s\S]*?COUNTRIES_MUST_BE_ARRAY/,
      'Convex HTTP route must reject non-array countries',
    );
  });

  it('insert-capable internal mutations accept and normalize optional countries', () => {
    assert.match(
      convexRulesSrc,
      /setDigestSettingsForUser[\s\S]*?countries:\s*v\.optional\(v\.array\(v\.string\(\)\)\)[\s\S]*?normalizeCountries\(countries\)/,
      'setDigestSettingsForUser must accept and normalize countries',
    );
    assert.match(
      convexRulesSrc,
      /setQuietHoursForUser[\s\S]*?countries:\s*v\.optional\(v\.array\(v\.string\(\)\)\)[\s\S]*?normalizeCountries\(countries\)/,
      'setQuietHoursForUser must accept and normalize countries',
    );
  });

  // #4922 U3 review fix: normalizeTickers/normalizeCountries throw ConvexError
  // with a structured *_LIMIT_EXCEEDED code on a >50-entry cap. The set-alert-rules
  // HTTP block previously had no try/catch, so the cap violation fell to the
  // outer catch as a generic 500 the client cannot route on — unlike the
  // set-notification-config block, which already translates codes to 400/402.
  it('set-alert-rules translates cap-exceeded ConvexError codes to a 400', () => {
    assert.match(
      convexHttpSrc,
      /action === "set-alert-rules"[\s\S]*?try \{[\s\S]*?setAlertRulesForUser[\s\S]*?\} catch \(err: unknown\) \{[\s\S]*?TICKERS_LIMIT_EXCEEDED[\s\S]*?COUNTRIES_LIMIT_EXCEEDED[\s\S]*?status: 400/,
      'set-alert-rules must catch and translate *_LIMIT_EXCEEDED to a 400',
    );
  });
});
