import test from 'node:test';
import assert from 'node:assert/strict';
import { nextCockpitNearContacts } from './cockpitAirLod.js';

test('Cockpit AIR LOD admits at ADD and retains through KEEP', () => {
  const previous = new Set(['retained', 'expired']);
  const next = nextCockpitNearContacts(previous, [
    ['new-near', 149_000 ** 2],
    ['new-outside-add', 151_000 ** 2],
    ['retained', 184_000 ** 2],
    ['expired', 186_000 ** 2],
  ], 150_000, 185_000);

  assert.deepEqual([...next].sort(), ['new-near', 'retained']);
});

test('Cockpit AIR LOD switches to the All range without a model-budget dependency', () => {
  const next = nextCockpitNearContacts(new Set(), [
    ['inside-all', 399_000 ** 2],
    ['outside-all', 401_000 ** 2],
  ], 400_000, 450_000);

  assert.deepEqual([...next], ['inside-all']);
});

test('Cockpit AIR LOD drops absent and invalid contacts', () => {
  const next = nextCockpitNearContacts(new Set(['gone']), [
    ['nan', Number.NaN],
    ['', 1],
  ], 150_000, 185_000);

  assert.equal(next.size, 0);
});

