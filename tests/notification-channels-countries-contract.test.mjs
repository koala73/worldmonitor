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
});
