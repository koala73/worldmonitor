/**
 * Pick-ownership contract tests (pre-ship audit H2).
 *
 * Locks the cross-layer pick coercion rules:
 *  - resolvePickId reduces every layer's pick shape (string icao/station ids,
 *    numeric NORAD ids, AIS vessel record objects, Cesium Entity objects) to
 *    ONE canonical String id.
 *  - isOwnedByOtherLayer consults sibling predicates only, never the asker's,
 *    and never throws on a broken predicate.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  registerPickOwner,
  unregisterPickOwner,
  isOwnedByOtherLayer,
  resolvePickId,
} from './pickRegistry.js';

// ---------------------------------------------------------------------------
// resolvePickId — canonical String coercion for every layer's pick shape
// ---------------------------------------------------------------------------

test('resolvePickId: string pick id (flights/military/bikeshare/cctv billboards)', () => {
  assert.equal(resolvePickId({ id: 'aaa001' }), 'aaa001');
  assert.equal(resolvePickId({ id: undefined, primitive: { id: 'station:austin:1' } }), 'station:austin:1');
});

test('resolvePickId: numeric pick id (satellite NORAD numbers) → String', () => {
  assert.equal(resolvePickId({ id: 25544 }), '25544');
  assert.equal(resolvePickId({ id: undefined, primitive: { id: 43013 } }), '43013');
});

test('resolvePickId: AIS vessel record object → its mmsi', () => {
  const record = { mmsi: '367123450', name: 'EVER GIVEN', billboard: {} };
  assert.equal(resolvePickId({ id: record }), '367123450');
  assert.equal(resolvePickId({ primitive: { id: record } }), '367123450');
});

test('resolvePickId: Cesium-Entity-like object → its string id', () => {
  const entity = { id: 'cctv-atx-cam-3-center', properties: {} };
  assert.equal(resolvePickId({ id: entity }), 'cctv-atx-cam-3-center');
});

test('resolvePickId: unresolvable picks → null', () => {
  assert.equal(resolvePickId(null), null);
  assert.equal(resolvePickId(undefined), null);
  assert.equal(resolvePickId({}), null);
  assert.equal(resolvePickId({ id: {} }), null); // object with no mmsi/id
  assert.equal(resolvePickId({ primitive: {} }), null);
});

// ---------------------------------------------------------------------------
// isOwnedByOtherLayer — sibling-only scan over String-coerced ids
// ---------------------------------------------------------------------------

test('ownership: sibling layers recognize each other via String-coerced ids', () => {
  const points = new Map([[25544, {}], [43013, {}]]); // satellites: numeric keys
  const vessels = new Map([['367123450', {}]]);        // AIS: string mmsi keys
  registerPickOwner('satellites', (pickedId) => {
    const norad = Number(pickedId);
    return Number.isFinite(norad) && points.has(norad);
  });
  registerPickOwner('ais-live-vessels', (pickedId) => vessels.has(pickedId));
  try {
    // Flights asking about a satellite pick (raw numeric id → String upstream)
    assert.equal(isOwnedByOtherLayer('flights', resolvePickId({ id: 25544 })), true);
    // Flights asking about a vessel pick (record object → mmsi)
    assert.equal(isOwnedByOtherLayer('flights', resolvePickId({ id: { mmsi: '367123450' } })), true);
    // A layer never owns its own pick via the sibling scan
    assert.equal(isOwnedByOtherLayer('satellites', '25544'), false);
    // Unknown ids belong to nobody
    assert.equal(isOwnedByOtherLayer('flights', 'zzz999'), false);
    assert.equal(isOwnedByOtherLayer('flights', null), false);
  } finally {
    unregisterPickOwner('satellites');
    unregisterPickOwner('ais-live-vessels');
  }
});

test('ownership: a throwing predicate never breaks click handling', () => {
  registerPickOwner('broken', () => { throw new Error('boom'); });
  registerPickOwner('cctv', (pickedId) => pickedId === 'atx-cam-3');
  try {
    assert.equal(isOwnedByOtherLayer('flights', 'atx-cam-3'), true);
    assert.equal(isOwnedByOtherLayer('flights', 'nothing'), false);
  } finally {
    unregisterPickOwner('broken');
    unregisterPickOwner('cctv');
  }
});

test('ownership: unregister removes the predicate', () => {
  registerPickOwner('bikeshare', (pickedId) => pickedId === 'station:1');
  assert.equal(isOwnedByOtherLayer('flights', 'station:1'), true);
  unregisterPickOwner('bikeshare');
  assert.equal(isOwnedByOtherLayer('flights', 'station:1'), false);
});
