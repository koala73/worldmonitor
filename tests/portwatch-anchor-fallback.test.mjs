import test from 'node:test';
import assert from 'node:assert/strict';

import {
  deriveRunAnchorMs,
  resolveCountryAnchorMs,
} from '../scripts/seed-portwatch-port-activity.mjs';

// IMF PortWatch stopped publishing on 2026-08-21: 1,481 rows/day through the
// 21st, then 0/day. The seeder anchors each country's 30/60-day windows on
// upstream max(date) precisely so a frozen feed keeps serving — but a country
// whose preflight errored fell through to Date.now(), re-introducing the
// now-relative window the anchor exists to avoid.
const AUG21 = Date.parse('2026-08-21T23:59:59.999Z');
const AUG19 = Date.parse('2026-08-19T23:59:59.999Z');

test('deriveRunAnchorMs takes the newest preflight that answered', () => {
  assert.equal(deriveRunAnchorMs(['2026-08-19', '2026-08-21', '2026-08-20']), AUG21);
});

test('deriveRunAnchorMs ignores the preflights that failed', () => {
  // fetchMaxDate returns null on ANY error, and this FeatureServer emits
  // sporadic HTTP 400/504 under load, so nulls are the common case — not rare.
  assert.equal(deriveRunAnchorMs([null, '2026-08-19', null, undefined, '']), AUG19);
});

test('deriveRunAnchorMs returns null when nothing answered', () => {
  assert.equal(deriveRunAnchorMs([null, null, undefined]), null);
  assert.equal(deriveRunAnchorMs([]), null);
  assert.equal(deriveRunAnchorMs(undefined), null);
});

test('deriveRunAnchorMs ignores unparseable dates rather than NaN-poisoning the max', () => {
  assert.equal(deriveRunAnchorMs(['not-a-date', '2026-08-21', 12345]), AUG21);
});

test("a country's own preflight always wins", () => {
  assert.equal(resolveCountryAnchorMs('2026-08-19', AUG21), AUG19);
});

test("a failed preflight keeps the country's prior max ahead of a newer run anchor", () => {
  assert.equal(resolveCountryAnchorMs(null, AUG21, '2026-08-19'), AUG19);
});

test('a failed preflight inherits the run anchor instead of Date.now()', () => {
  // The whole point: HKG/POL/KEN preflights return HTTP 400 while CHN's answers.
  // Before this, those countries got a now-anchored window, scored
  // `empty_activity`, stopped refreshing, and aged out at the 7-day cache wall.
  assert.equal(resolveCountryAnchorMs(null, AUG21), AUG21);
  assert.equal(resolveCountryAnchorMs(undefined, AUG21), AUG21);
  assert.equal(resolveCountryAnchorMs('', AUG21), AUG21);
});

test('undefined — never null — when nothing is known, so Date.now() still applies', () => {
  // fetchCountryAccum does `anchorEpochMs ?? Date.now()`. Returning null here
  // would satisfy `??` and pin every window to the epoch, which is far worse
  // than assuming now: a 1970 anchor makes every query return zero rows.
  assert.equal(resolveCountryAnchorMs(null, null), undefined);
  assert.equal(resolveCountryAnchorMs(null, undefined), undefined);
  assert.equal(resolveCountryAnchorMs(null, Number.NaN), undefined);
});
