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
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';

import {
  WEATHER_NOTIFY_MAX_PER_TICK,
  WEATHER_NOTIFY_SLOTS_PER_COUNTRY,
  selectWeatherNotificationAlerts,
  weatherAlertFamilyKey,
  weatherAlertNotifyCountryCode,
} from '../scripts/_weather-alert-select.mjs';

const require = createRequire(import.meta.url);
const { buildDedupMaterial } = require('../scripts/shared/notification-dedup.cjs');

const AIS_RELAY_SOURCE = readFileSync(
  new URL('../scripts/ais-relay.cjs', import.meta.url),
  'utf8',
);

function notifyAlert({ source, countryCode, id, severity, event, headline, vtec }) {
  return {
    id,
    source,
    countryCode,
    severity,
    event,
    // SWIC/ECCC headlines are generic event names repeated verbatim across
    // every alert of that type — the live payload carries 19 Kazakh rows all
    // titled "Forestfire". Default to that shape rather than a per-id title,
    // which would make every fixture row look like its own family.
    headline: headline ?? event,
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
      // CAP ids embed a timestamp and a message sequence, so they differ per
      // row even for one storm system; the shared title is what identifies it.
      id: `2.49.0.0.756.0-20260828-10170${i}-0470417-00-EN`,
      severity: 'Extreme',
      event: 'Violent thunderstorm',
    }));
  }
  // Two further Swiss hazards, so CH has three genuinely distinct families and
  // can still exercise the full per-country budget.
  alerts.push(notifyAlert({
    source: 'swic', countryCode: 'CH', id: 'swic-ch-rain', severity: 'Extreme', event: 'Heavy rain',
  }));
  alerts.push(notifyAlert({
    source: 'swic', countryCode: 'CH', id: 'swic-ch-wind', severity: 'Extreme', event: 'Wind',
  }));
  // Deliberately shares CH's "Heavy rain" title: generic WMO event names
  // repeat across countries, and before #7243 that collided in publisher dedup.
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
    // above anything the 50-alert payload can actually hold. Distinct hazard
    // names per row, or they would coalesce into one family per country and
    // never approach the ceiling.
    const many = [];
    for (let c = 0; c < 30; c += 1) {
      const countryCode = `${String.fromCharCode(65 + Math.floor(c / 26))}${String.fromCharCode(65 + (c % 26))}`;
      for (const event of ['Storm', 'Flood', 'Wind', 'Snow', 'Fire']) {
        many.push(notifyAlert({
          source: 'swic',
          countryCode,
          id: `swic-${c}-${event}`,
          severity: 'Extreme',
          event,
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
    // Four DISTINCT hazards per bucket — same-titled rows coalesce into one
    // family, so distinct titles are what make this a slot-contention test.
    const hazards = ['Storm', 'Flood', 'Wind', 'Snow'];
    const alerts = [
      ...hazards.map((event, i) => notifyAlert({
        source: 'swic', countryCode: 'CH', id: `ch-${i}`, severity: 'Extreme', event,
      })),
      ...hazards.map((event, i) => notifyAlert({
        source: 'swic', countryCode: '', id: `unattributed-${i}`, severity: 'Extreme', event,
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

  it('does not let two countries with the same headline collide in publisher dedup', () => {
    // The selector can hand the publisher one alert per country and STILL lose
    // every country but one: publishNotificationEvent keys its SET NX dedup on
    // buildDedupMaterial(eventType, title, coalesceKey), which falls back to
    // `weather_alert:<title>` whenever coalesceKey is absent — i.e. for every
    // VTEC-less SWIC/ECCC alert. SWIC titles are generic event names ("Heavy
    // rain", "Forestfire", and one live alert titled literally "CAP Alert"),
    // so two countries collide on the title hash and only the first SET NX
    // wins. That recreates the #7243 starvation one layer down.
    const chRain = notifyAlert({
      source: 'swic', countryCode: 'CH', id: 'ch-rain', severity: 'Extreme', event: 'Heavy rain',
    });
    const inRain = notifyAlert({
      source: 'swic', countryCode: 'IN', id: 'in-rain', severity: 'Extreme', event: 'Heavy rain',
    });
    chRain.headline = 'Heavy rain';
    inRain.headline = 'Heavy rain';
    // Positive control for the trap itself: with no coalesceKey — what the
    // relay passed for every VTEC-less alert before this fix — they collide.
    assert.equal(
      buildDedupMaterial('weather_alert', chRain.headline, undefined),
      buildDedupMaterial('weather_alert', inRain.headline, undefined),
      'sanity: the title-hash fallback is what makes two countries collide',
    );
    const material = (a) => buildDedupMaterial('weather_alert', a.headline, weatherAlertFamilyKey(a));
    assert.notEqual(
      material(chRain),
      material(inRain),
      'a Swiss and an Indian "Heavy rain" must not share a publisher dedup key',
    );
  });

  it('coalesces same-headline alerts within one country to a single family', () => {
    // Live payload 2026-08-28: 19 Kazakh high-severity alerts ALL titled
    // "Forestfire". Keying the family on the raw alert id would treat them as
    // 19 families and burn all 3 KZ slots on one wildfire event; the ids also
    // embed a CAP timestamp (2.49.0.0.398.0-20260828-101702-0470417-00-EN), so
    // every CAP update would re-notify. Coalesce on (source, country, title)
    // instead: one family, freeing KZ's other slots for other hazards.
    const forestFires = Array.from({ length: 19 }, (_, i) => notifyAlert({
      source: 'swic',
      countryCode: 'KZ',
      id: `2.49.0.0.398.0-20260828-10170${i}-0470417-00-EN`,
      severity: 'Extreme',
      event: 'Forestfire',
    }));
    for (const a of forestFires) a.headline = 'Forestfire';
    const flood = notifyAlert({
      source: 'swic', countryCode: 'KZ', id: 'kz-flood', severity: 'Extreme', event: 'Flood',
    });
    flood.headline = 'Flood';
    const selected = selectWeatherNotificationAlerts([...forestFires, flood]);
    assert.deepEqual(
      selected.map((a) => a.headline),
      ['Forestfire', 'Flood'],
      '19 identically-titled Kazakh wildfires are one family, and the flood must still get a slot',
    );
  });

  it('keeps a VTEC-less family key stable across CAP updates of the same alert', () => {
    // SWIC/ECCC ids carry a timestamp and a message sequence, so the same
    // logical alert arrives with a new id on every update. An id-keyed family
    // would re-notify each tick; the 1800s dedup TTL only helps if the key
    // survives the update.
    const first = notifyAlert({
      source: 'swic',
      countryCode: 'KZ',
      id: '2.49.0.0.398.0-20260828-101702-0470417-00-EN',
      severity: 'Extreme',
      event: 'Forestfire',
    });
    const updated = notifyAlert({
      source: 'swic',
      countryCode: 'KZ',
      id: '2.49.0.0.398.0-20260828-111702-0470417-01-EN',
      severity: 'Extreme',
      event: 'Forestfire',
    });
    first.headline = 'Forestfire';
    updated.headline = 'Forestfire';
    assert.equal(weatherAlertFamilyKey(first), weatherAlertFamilyKey(updated));
  });

  it('ais-relay publishes the shared family key as the coalesceKey', () => {
    // The selector and the publisher must agree on what a family is. When they
    // disagree the selector's per-country guarantee is undone by the
    // publisher's title-hash dedup.
    assert.match(
      AIS_RELAY_SOURCE,
      /const coalesceKey = weatherAlertFamilyKey\(a\);/,
      'the publisher must key dedup on the same family key the selector partitions by',
    );
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
