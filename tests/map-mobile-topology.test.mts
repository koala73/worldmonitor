import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { MAP_URLS, worldTopologyUrl } from '../src/config/geo-map.ts';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const readTopo = (name: string) =>
  JSON.parse(readFileSync(`${repoRoot}public/data/${name}`, 'utf8'));

describe('U6 mobile 110m topology', () => {
  it('selects the 110m URL on mobile and the 50m URL on desktop', () => {
    assert.equal(worldTopologyUrl(true), '/data/countries-110m.json');
    assert.equal(worldTopologyUrl(false), '/data/countries-50m.json');
    assert.equal(MAP_URLS.worldMobile, '/data/countries-110m.json');
    assert.equal(MAP_URLS.world, '/data/countries-50m.json');
  });

  it('ships a valid 110m TopoJSON with a countries object', () => {
    const topo = readTopo('countries-110m.json');
    assert.equal(topo.type, 'Topology');
    assert.ok(topo.objects?.countries?.geometries?.length > 0);
    assert.ok(Array.isArray(topo.arcs) && topo.arcs.length > 0);
  });

  it('110m is materially lighter than 50m (the styleLayout win), at a pinned 64-feature cost', () => {
    const fifty = readTopo('countries-50m.json');
    const oneTen = readTopo('countries-110m.json');
    // far fewer arcs → shorter projected `d=` strings → lower path parse + styleLayout
    assert.ok(
      oneTen.arcs.length < fifty.arcs.length / 2,
      `expected 110m arcs (${oneTen.arcs.length}) well below half of 50m (${fifty.arcs.length})`,
    );
    // Accepted, pinned tradeoff (#4443 U6): 110m omits 64 micro-state/territory outlines.
    // If a world-atlas bump changes these counts, this test flags it for re-review.
    assert.equal(fifty.objects.countries.geometries.length, 241);
    assert.equal(oneTen.objects.countries.geometries.length, 177);
  });
});
