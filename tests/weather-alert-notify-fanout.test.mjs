/**
 * #7243 — weather_alert notification fan-out must not starve non-winning
 * countries.
 *
 * `seedWeatherAlerts` published the globally severity-sorted top-3 distinct
 * families per 15-min tick. Downstream, `eventMatchesCountryScope`
 * (scripts/notification-relay.cjs) drops any event whose payload.countryCode
 * falls outside a rule's country list — so when all three global winners
 * belonged to one country, every subscriber scoped to any other country got
 * nothing that tick, even with active Extreme/Severe alerts for their country
 * sitting in the very same payload.
 *
 * The payload layer already solved this shape: mergeAlertSources' PER_SOURCE_FLOOR
 * (#6627) exists so no source can starve another out of the 50-alert cache.
 * These tests pin the notification-layer equivalent.
 *
 * Run: node --test tests/weather-alert-notify-fanout.test.mjs
 */

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  WEATHER_NOTIFY_MAX_PER_TICK,
  WEATHER_NOTIFY_SLOTS_PER_COUNTRY,
  selectWeatherNotificationAlerts,
  weatherAlertNotifyCountryCode,
} from '../scripts/_weather-alert-select.mjs';

const AIS_RELAY_SOURCE = readFileSync(
  new URL('../scripts/ais-relay.cjs', import.meta.url),
  'utf8',
);

function notifyAlert({ source, countryCode, id, severity, event, vtec }) {
  return {
    id,
    source,
    countryCode,
    severity,
    event,
    headline: `${event} ${id}`,
    ...(vtec ? { vtec } : {}),
  };
}

/**
 * The 2026-08-28 production shape, reduced to its starving core: nine SWIC
 * Swiss thunderstorms sorted ahead of every Canadian and US Severe alert.
 * SWIC carries no VTEC, so `deriveWeatherCoalesceKey` returns undefined and
 * each Swiss row falls back to its own unique `swic:<id>` family key — nine
 * DISTINCT families, not one coalesced storm. All three global slots went to
 * Switzerland; CA and US subscribers received nothing.
 */
function productionShape20260828() {
  const alerts = [];
  for (let i = 0; i < 9; i += 1) {
    alerts.push(notifyAlert({
      source: 'swic',
      countryCode: 'CH',
      id: `swic-ch-${i}`,
      severity: 'Extreme',
      event: 'Violent thunderstorm',
    }));
  }
  alerts.push(notifyAlert({
    source: 'swic',
    countryCode: 'IN',
    id: 'swic-in-0',
    severity: 'Extreme',
    event: 'Heavy rain',
  }));
  for (let i = 0; i < 15; i += 1) {
    alerts.push(notifyAlert({
      source: 'eccc',
      countryCode: 'CA',
      id: `eccc-ca-${i}`,
      severity: 'Severe',
      event: 'Winter storm warning',
    }));
  }
  for (let i = 0; i < 15; i += 1) {
    alerts.push(notifyAlert({
      source: 'nws',
      countryCode: 'US',
      id: `nws-us-${i}`,
      severity: 'Severe',
      event: 'Severe thunderstorm warning',
      vtec: `/O.NEW.KSGF.SV.W.${String(i).padStart(4, '0')}.250427T1257Z-250427T1330Z/`,
    }));
  }
  return alerts;
}

const countriesOf = (selected) => selected.map((a) => weatherAlertNotifyCountryCode(a));

describe('weather_alert notification fan-out — per-country slots (#7243)', () => {
  it('notifies CA, US and IN subscribers even when the global severity head is all CH', () => {
    // Pre-fix this returned three Swiss thunderstorms and nothing else, so
    // eventMatchesCountryScope dropped the whole tick for every ['CA'] and
    // ['US'] rule despite 15 active alerts each in the same payload.
    const selected = selectWeatherNotificationAlerts(productionShape20260828());
    const countries = new Set(countriesOf(selected));
    assert.ok(countries.has('CA'), 'a CA-scoped rule must receive at least one alert this tick');
    assert.ok(countries.has('US'), 'a US-scoped rule must receive at least one alert this tick');
    assert.ok(countries.has('IN'), 'an IN-scoped rule must receive at least one alert this tick');
    assert.ok(countries.has('CH'), 'CH must keep its own slots');
  });

  it('caps each country at WEATHER_NOTIFY_SLOTS_PER_COUNTRY distinct families', () => {
    // The old global 3 was really "3 for the only audience" — it was written
    // when NWS was the only source. The budget is kept per audience: a Swiss
    // subscriber must not get nine notifications just because nine Swiss
    // storms happen to lead the global sort.
    const selected = selectWeatherNotificationAlerts(productionShape20260828());
    const perCountry = new Map();
    for (const code of countriesOf(selected)) {
      perCountry.set(code, (perCountry.get(code) ?? 0) + 1);
    }
    for (const [code, count] of perCountry) {
      assert.ok(
        count <= WEATHER_NOTIFY_SLOTS_PER_COUNTRY,
        `${code} took ${count} slots, above the ${WEATHER_NOTIFY_SLOTS_PER_COUNTRY} per-country cap`,
      );
    }
    assert.equal(perCountry.get('CH'), WEATHER_NOTIFY_SLOTS_PER_COUNTRY);
    assert.equal(perCountry.get('IN'), 1, 'IN only has one high-severity family to give');
  });

  it('bounds the whole tick at WEATHER_NOTIFY_MAX_PER_TICK', () => {
    // 30 countries x 5 distinct Extreme families each = 150 candidates, far
    // above anything the 50-alert payload can actually hold.
    const many = [];
    for (let c = 0; c < 30; c += 1) {
      const countryCode = `${String.fromCharCode(65 + Math.floor(c / 26))}${String.fromCharCode(65 + (c % 26))}`;
      for (let i = 0; i < 5; i += 1) {
        many.push(notifyAlert({
          source: 'swic',
          countryCode,
          id: `swic-${c}-${i}`,
          severity: 'Extreme',
          event: 'Storm',
        }));
      }
    }
    const selected = selectWeatherNotificationAlerts(many);
    assert.ok(
      selected.length <= WEATHER_NOTIFY_MAX_PER_TICK,
      `tick published ${selected.length}, above the ${WEATHER_NOTIFY_MAX_PER_TICK} ceiling`,
    );
    assert.ok(selected.length > 3, 'the ceiling must sit above the old global 3-slot cap');
  });

  it('spends the global ceiling across countries, not down one country', () => {
    // A ceiling reached by draining the highest-severity country first is the
    // original bug with a bigger number. Every country must be served once
    // before any country takes a second slot.
    const many = [];
    for (let c = 0; c < WEATHER_NOTIFY_MAX_PER_TICK + 10; c += 1) {
      const countryCode = `${String.fromCharCode(65 + Math.floor(c / 26))}${String.fromCharCode(65 + (c % 26))}`;
      many.push(notifyAlert({
        source: 'swic',
        countryCode,
        id: `swic-${c}-0`,
        // The first country is strictly more severe than every other, so a
        // severity-greedy fill would hand it slots the rest never see.
        severity: c === 0 ? 'Extreme' : 'Severe',
        event: 'Storm',
      }));
      many.push(notifyAlert({
        source: 'swic',
        countryCode,
        id: `swic-${c}-1`,
        severity: c === 0 ? 'Extreme' : 'Severe',
        event: 'Flood',
      }));
    }
    const selected = selectWeatherNotificationAlerts(many);
    const perCountry = new Map();
    for (const code of countriesOf(selected)) {
      perCountry.set(code, (perCountry.get(code) ?? 0) + 1);
    }
    assert.equal(selected.length, WEATHER_NOTIFY_MAX_PER_TICK, 'the ceiling must be reached');
    assert.equal(
      perCountry.size,
      WEATHER_NOTIFY_MAX_PER_TICK,
      'a saturated tick must serve one distinct country per slot, not stack slots on the most severe country',
    );
  });

  it('still coalesces one VTEC family spanning adjacent zones into one slot', () => {
    // Slot B (PR #3467): three adjacent-zone bulletins for one storm collapse
    // to one notification, so a fourth distinct family must still be reached.
    const sameFamily = ['nws-a', 'nws-b', 'nws-c'].map((id) => notifyAlert({
      source: 'nws',
      countryCode: 'US',
      id,
      severity: 'Extreme',
      event: 'Severe thunderstorm warning',
      vtec: '/O.NEW.KSGF.SV.W.0034.250427T1257Z-250427T1330Z/',
    }));
    const other = notifyAlert({
      source: 'nws',
      countryCode: 'US',
      id: 'nws-tornado',
      severity: 'Extreme',
      event: 'Tornado warning',
      vtec: '/O.NEW.KSGF.TO.W.0034.250427T1257Z-250427T1330Z/',
    });
    const selected = selectWeatherNotificationAlerts([...sameFamily, other]);
    assert.deepEqual(selected.map((a) => a.id), ['nws-a', 'nws-tornado']);
  });

  it("gives country-less alerts their own bucket, not the winning country's", () => {
    // weatherAlertNotifyCountryCode() returns undefined for these; downstream
    // they only reach unscoped rules, so they must neither consume CH's slots
    // nor be starved by CH.
    const alerts = [
      ...Array.from({ length: 4 }, (_, i) => notifyAlert({
        source: 'swic', countryCode: 'CH', id: `ch-${i}`, severity: 'Extreme', event: 'Storm',
      })),
      ...Array.from({ length: 4 }, (_, i) => notifyAlert({
        source: 'swic', countryCode: '', id: `unattributed-${i}`, severity: 'Extreme', event: 'Storm',
      })),
    ];
    const selected = selectWeatherNotificationAlerts(alerts);
    const unattributed = selected.filter((a) => weatherAlertNotifyCountryCode(a) === undefined);
    assert.equal(unattributed.length, WEATHER_NOTIFY_SLOTS_PER_COUNTRY);
    assert.equal(selected.length - unattributed.length, WEATHER_NOTIFY_SLOTS_PER_COUNTRY);
  });

  it('ignores Moderate and Minor alerts entirely', () => {
    const selected = selectWeatherNotificationAlerts([
      notifyAlert({ source: 'nws', countryCode: 'US', id: 'm1', severity: 'Moderate', event: 'Advisory' }),
      notifyAlert({ source: 'nws', countryCode: 'US', id: 'm2', severity: 'Minor', event: 'Statement' }),
      notifyAlert({ source: 'nws', countryCode: 'US', id: 'x1', severity: 'Extreme', event: 'Tornado' }),
    ]);
    assert.deepEqual(selected.map((a) => a.id), ['x1']);
  });

  it('returns [] for a non-array or empty input', () => {
    assert.deepEqual(selectWeatherNotificationAlerts(undefined), []);
    assert.deepEqual(selectWeatherNotificationAlerts(null), []);
    assert.deepEqual(selectWeatherNotificationAlerts([]), []);
  });

  it('emits in severity order so the most dangerous alert publishes first', () => {
    const selected = selectWeatherNotificationAlerts([
      notifyAlert({ source: 'eccc', countryCode: 'CA', id: 'ca-severe', severity: 'Severe', event: 'Storm' }),
      notifyAlert({ source: 'swic', countryCode: 'CH', id: 'ch-extreme', severity: 'Extreme', event: 'Storm' }),
    ]);
    assert.deepEqual(selected.map((a) => a.id), ['ch-extreme', 'ca-severe']);
  });

  it('ais-relay delegates weather notification selection to the shared module', () => {
    assert.match(
      AIS_RELAY_SOURCE,
      /const distinctFamilyAlerts = selectWeatherNotificationAlerts\(alerts\);/,
      'the relay must call the shared selector, not re-implement a slot cap inline',
    );
    assert.doesNotMatch(
      AIS_RELAY_SOURCE,
      /distinctFamilyAlerts\.length >= 3/,
      'the inline global 3-slot cap must be gone from the relay',
    );
  });
});
