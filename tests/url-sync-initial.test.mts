/**
 * Initial URL-sync suppression (fix/url-params-overwrite series).
 *
 * setupUrlStateSync skips its immediate URL write when applying the initial
 * URL state starts an async camera move, because getCenter() would report
 * intermediate coordinates until the flight settles. The predicate that
 * decides this is `urlHasAsyncFlyTo` in src/utils/urlState.ts; this file
 * exercises that production function directly. The copy it replaced passed
 * with no production file present (#7770).
 *
 * The DeckGLMap pendingCenter behaviour these cases used to stub lives in
 * tests/dom/deckgl-map-state.test.mts, against the real class.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { urlHasAsyncFlyTo, type ParsedMapUrlState } from '../src/utils/urlState.ts';

type Case = { name: string; state: ParsedMapUrlState | undefined; expected: boolean };

const cases: Case[] = [
  { name: 'undefined state (cold load) does not suppress', state: undefined, expected: false },
  { name: 'bare ?view=mena does not suppress', state: { view: 'mena' }, expected: false },
  { name: 'lone ?lat=41 without lon does not suppress', state: { lat: 41 }, expected: false },
  { name: 'lone ?lon=29 without lat does not suppress', state: { lon: 29 }, expected: false },
  { name: 'a full ?lat=41&lon=29 pair suppresses (setCenter flies)', state: { lat: 41, lon: 29 }, expected: true },
  { name: 'lat+lon+zoom suppresses', state: { lat: 41, lon: 29, zoom: 6 }, expected: true },
  { name: 'bare ?zoom without a view suppresses (animated setZoom)', state: { zoom: 5 }, expected: true },
  { name: 'bare ?chokepoint suppresses until the renderer opens it', state: { chokepoint: 'hormuz_strait' }, expected: true },
  { name: '?view=mena&zoom=4 does not suppress (setView writes zoom synchronously)', state: { view: 'mena', zoom: 4 }, expected: false },
  { name: '?view=eu without coordinates does not suppress', state: { view: 'eu' }, expected: false },
  { name: '?view=eu&lat=50&lon=15 suppresses (setCenter overrides the view)', state: { view: 'eu', lat: 50, lon: 15 }, expected: true },
  { name: '?view=eu&chokepoint suppresses (the deep link still opens later)', state: { view: 'eu', chokepoint: 'suez' }, expected: true },
  { name: 'country and expanded flags alone never suppress', state: { country: 'UA', expanded: true }, expected: false },
];

describe('urlHasAsyncFlyTo', () => {
  for (const { name, state, expected } of cases) {
    it(name, () => {
      assert.equal(urlHasAsyncFlyTo(state), expected);
    });
  }

  it('treats null like an absent state', () => {
    assert.equal(urlHasAsyncFlyTo(null), false);
  });
});

describe('setupUrlStateSync consults the predicate', () => {
  it('gates the immediate sync on urlHasAsyncFlyTo(initialUrlState)', () => {
    // A passing predicate proves nothing if the call site re-inlines the
    // condition; pin the wiring so the two cannot drift apart again.
    const source = readFileSync(resolve(import.meta.dirname, '../src/app/event-handlers.ts'), 'utf8');
    assert.match(
      source,
      /if \(!urlHasAsyncFlyTo\(this\.ctx\.initialUrlState\)\) \{\s*\n\s*this\.debouncedUrlSync\(\);/,
      'setupUrlStateSync must skip the immediate URL write exactly when the shared predicate says the camera will move',
    );
    assert.doesNotMatch(
      source,
      /const urlHasAsyncFlyTo =/,
      'the predicate must not be re-inlined beside the import',
    );
  });
});
