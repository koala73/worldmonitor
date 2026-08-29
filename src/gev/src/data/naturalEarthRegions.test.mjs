// src/data/naturalEarthRegions.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { statSync, readFileSync } from 'node:fs';
import { findNaturalRegion, listRegions, lookupNaturalRegionOutline, pointInRing } from './naturalEarthRegions.js';

const PACK_DIR = new URL('./local_data/natural_earth/', import.meta.url);

test('marquee ranges resolve with sane areas (owner acceptance: Alps + Rockies)', async () => {
  const alps = await findNaturalRegion('Alps');
  assert.ok(alps, 'Alps must resolve');
  assert.equal(alps.kind, 'natural');
  assert.equal(alps.featurecla, 'Range/mtn');
  assert.ok(alps.areaKm2 > 150_000 && alps.areaKm2 < 350_000,
    `Alps area sane (got ${Math.round(alps.areaKm2)} km²)`);

  const rockies = await findNaturalRegion('Rocky Mountains');
  assert.ok(rockies, 'Rocky Mountains must resolve');
  assert.ok(rockies.areaKm2 >= 700_000 && rockies.areaKm2 < 1_500_000,
    `Rockies area sane (got ${Math.round(rockies.areaKm2)} km²)`);
  assert.ok(rockies.bboxDiagonalKm > 2000, 'Rockies span thousands of km');
});

test('aliases and articles: "the Alps", "Rockies", "Sahara Desert", "Himalaya"', async () => {
  assert.equal((await findNaturalRegion('the Alps'))?.name, 'Alps');
  assert.equal((await findNaturalRegion('Rockies'))?.name, 'Rocky Mountains');
  assert.equal((await findNaturalRegion('the Rockies'))?.name, 'Rocky Mountains');
  assert.equal((await findNaturalRegion('Sahara Desert'))?.name, 'Sahara');
  assert.equal((await findNaturalRegion('Himalaya'))?.name, 'Himalayas');
  assert.equal((await findNaturalRegion('  THE ALPS  '))?.name, 'Alps');
});

test('major deserts/ranges resolve with sane areas', async () => {
  const sahara = await findNaturalRegion('Sahara');
  assert.ok(sahara && sahara.areaKm2 > 8_000_000 && sahara.areaKm2 < 12_000_000,
    `Sahara ~9-11M km² (got ${sahara && Math.round(sahara.areaKm2)})`);

  const andes = await findNaturalRegion('Andes');
  assert.ok(andes && andes.areaKm2 > 2_000_000 && andes.areaKm2 < 4_000_000,
    `Andes area sane (got ${andes && Math.round(andes.areaKm2)})`);

  const himalayas = await findNaturalRegion('Himalayas');
  assert.ok(himalayas && himalayas.areaKm2 > 300_000 && himalayas.areaKm2 < 700_000,
    `Himalayas area sane (got ${himalayas && Math.round(himalayas.areaKm2)})`);
});

test('marine features resolve as kind "marine"', async () => {
  const gom = await findNaturalRegion('Gulf of Mexico');
  assert.ok(gom, 'Gulf of Mexico must resolve');
  assert.equal(gom.kind, 'marine');
  assert.equal(gom.featurecla, 'gulf');
  assert.ok(gom.areaKm2 > 1_200_000 && gom.areaKm2 < 1_800_000,
    `Gulf of Mexico area sane (got ${Math.round(gom.areaKm2)} km²)`);
});

test('nonsense / non-natural-region queries return null', async () => {
  assert.equal(await findNaturalRegion('Zilker Park'), null);
  assert.equal(await findNaturalRegion('Texas'), null);
  assert.equal(await findNaturalRegion(''), null);
  assert.equal(await findNaturalRegion(null), null);
  assert.equal(await findNaturalRegion('qqqqzzzz'), null);
});

test('returned polygons have >=8 vertices with valid lon/lat', async () => {
  for (const q of ['Alps', 'Rocky Mountains', 'Sahara', 'Andes', 'Himalayas', 'Gulf of Mexico']) {
    const r = await findNaturalRegion(q);
    assert.ok(r, `${q} resolves`);
    assert.ok(r.polygons.length >= 1, `${q} has polygons`);
    for (const ring of r.polygons) {
      assert.ok(ring.length >= 8, `${q} ring has >=8 vertices (got ${ring.length})`);
      for (const [lon, lat] of ring) {
        assert.ok(lon >= -180 && lon <= 180, `${q} lon in range (${lon})`);
        assert.ok(lat >= -90 && lat <= 90, `${q} lat in range (${lat})`);
      }
    }
  }
});

test('whole pack: every feature ring has >=8 vertices and valid coords', () => {
  for (const file of ['regions.json', 'marine.json']) {
    const pack = JSON.parse(readFileSync(new URL(file, PACK_DIR), 'utf8'));
    assert.ok(pack.meta?.license?.toLowerCase().includes('public domain'), `${file} meta declares PD license`);
    assert.ok(pack.meta?.fetched, `${file} meta records fetch time`);
    assert.ok(pack.features.length > 200, `${file} has hundreds of features (got ${pack.features.length})`);
    for (const ft of pack.features) {
      assert.ok(ft.name && typeof ft.name === 'string', `${file} feature named`);
      for (const ring of ft.polygons) {
        assert.ok(ring.length >= 8, `${file} ${ft.name}: ring >=8 verts (got ${ring.length})`);
        for (const [lon, lat] of ring) {
          assert.ok(Number.isFinite(lon) && lon >= -180 && lon <= 180, `${file} ${ft.name}: lon valid`);
          assert.ok(Number.isFinite(lat) && lat >= -90 && lat <= 90, `${file} ${ft.name}: lat valid`);
        }
      }
    }
  }
});

test('pack byte-size budget: regions.json + marine.json <= 3 MB', () => {
  const total = statSync(new URL('regions.json', PACK_DIR)).size
    + statSync(new URL('marine.json', PACK_DIR)).size;
  assert.ok(total <= 3 * 1024 * 1024, `pack total ${total} bytes exceeds 3 MB budget`);
});

test('listRegions() enumerates both kinds for diagnostics', async () => {
  const list = await listRegions();
  assert.ok(list.length > 1000, `pack has 1000+ named regions (got ${list.length})`);
  assert.ok(list.some((e) => e.kind === 'natural'));
  assert.ok(list.some((e) => e.kind === 'marine'));
  // diagnostics entries carry no geometry payload
  assert.equal(list[0].polygons, undefined);
});

// ── lookupNaturalRegionOutline (resolver first-rung contract) ──────
test('outline lookup: Alps ring via containment anchor', async () => {
  const r = await lookupNaturalRegionOutline('the Alps', 46.5, 10.0);
  assert.ok(r, 'Alps must resolve with an inside anchor');
  assert.equal(r.name, 'Alps');
  assert.ok(r.ring.length >= 8, 'range-scale ring');
  assert.ok(r.areaKm2 > 100000 && r.areaKm2 < 400000, `sane Alps area, got ${r.areaKm2}`);
});

test('outline lookup: duplicate names disambiguate by anchor containment', async () => {
  const us = await lookupNaturalRegionOutline('Sierra Nevada', 37.2, -119.0);
  assert.ok(us, 'US anchor must match a Sierra Nevada');
  assert.ok(pointInRing(us.ring, 37.2, -119.0), 'returned ring contains the US anchor');
});

test('outline lookup: anchor outside every ring → null (wrong-place guard)', async () => {
  assert.equal(await lookupNaturalRegionOutline('the Alps', 30.26, -97.77), null);
});

test('outline lookup: non-region names never match', async () => {
  assert.equal(await lookupNaturalRegionOutline('Zilker Park', 30.26, -97.77), null);
  assert.equal(await lookupNaturalRegionOutline('Texas', 31.0, -99.0), null);
});

test('outline lookup: marine regions resolve (Gulf of Mexico)', async () => {
  const gulf = await lookupNaturalRegionOutline('Gulf of Mexico', 25.0, -90.0);
  assert.ok(gulf && gulf.kind === 'marine');
});

test('pointInRing: basic square', () => {
  const sq = [[0, 0], [10, 0], [10, 10], [0, 10]];
  assert.equal(pointInRing(sq, 5, 5), true);
  assert.equal(pointInRing(sq, 15, 5), false);
  assert.equal(pointInRing([[0, 0], [1, 1]], 0.5, 0.5), false, 'degenerate ring');
});
