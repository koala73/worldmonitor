// The watched-site registry is composed from the curated map lists, every site is
// attributable to a country and a source list, and the seeder's generated copy is current.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { composeWatchedSites, type WatchedSiteCandidate } from '../shared/watched-sites.ts';
import { NUCLEAR_FACILITIES } from '../shared/nuclear-facilities-data.ts';
import { isWatchedSitesModuleCurrent, renderWatchedSitesModule } from '../scripts/generate-orbital-watched-sites.mjs';
import { WATCHED_SITES } from '../scripts/shared/orbital-watched-sites.generated.mjs';

const generated = readFileSync(new URL('../scripts/shared/orbital-watched-sites.generated.mjs', import.meta.url), 'utf8');
const sites = composeWatchedSites();

describe('watched-site registry', () => {
  it('gives every site real coordinates, a country code and at least one origin', () => {
    assert.ok(sites.length > 500, `${sites.length} sites`);
    for (const site of sites) {
      assert.ok(Number.isFinite(site.lat) && Math.abs(site.lat) <= 90, site.id);
      assert.ok(Number.isFinite(site.lon) && Math.abs(site.lon) <= 180, site.id);
      assert.ok(!(site.lat === 0 && site.lon === 0), `${site.id} sits at 0,0`);
      assert.match(site.countryCode, /^[A-Z]{2}$/, site.id);
      assert.ok(site.origins.length > 0, site.id);
      assert.equal(site.id, `${site.origins[0].list}:${site.origins[0].id}`);
    }
    assert.equal(new Set(sites.map((site) => site.id)).size, sites.length, 'site ids are unique');
  });

  it('draws on every source list and marks ports and chokepoints maritime', () => {
    const lists = new Set(sites.flatMap((site) => site.origins.map((origin) => origin.list)));
    assert.deepEqual([...lists].sort(), ['chokepoint', 'conflict-zone', 'hotspot', 'military-base', 'nuclear-facility', 'port']);
    const barakah = sites.find((site) => site.origins.some((o) => o.list === 'nuclear-facility' && o.id === NUCLEAR_FACILITIES.find((f) => f.operator === 'AE')?.id));
    assert.equal(barakah?.countryCode, 'AE');
    for (const site of sites.filter((s) => s.origins.every((o) => o.list === 'port' || o.list === 'chokepoint'))) {
      assert.equal(site.surface, 'maritime', site.id);
    }
  });

  it('merges entries of different lists at the same place into one site with both origins', () => {
    const base = { lat: 10, lon: 20, countryCode: 'XX', surface: 'land' as const };
    const merged = composeWatchedSites([
      { ...base, origin: { list: 'port', id: 'p' }, name: 'P', surface: 'maritime' },
      { ...base, origin: { list: 'military-base', id: 'b' }, name: 'B', lat: 10.001 },
    ] as WatchedSiteCandidate[]);
    assert.equal(merged.length, 1);
    assert.deepEqual(merged[0].origins, [{ list: 'port', id: 'p' }, { list: 'military-base', id: 'b' }]);
    assert.equal(merged[0].surface, 'land');
  });

  it('refuses an entry with no country attribution', () => {
    assert.throws(
      () => composeWatchedSites([{ origin: { list: 'hotspot', id: 'nowhere' }, name: 'N', lat: 1, lon: 1, countryCode: undefined, surface: 'land' }]),
      /hotspot:nowhere/,
    );
  });

  it('keeps the generated registry identical to the composed source', () => {
    assert.ok(isWatchedSitesModuleCurrent(generated, sites), 'run npm run generate');
    assert.deepEqual(WATCHED_SITES, sites);
  });

  it('reports a generated registry that no longer matches its source as stale', () => {
    const moved = sites.map((site, i) => (i === 0 ? { ...site, lat: site.lat + 1 } : site));
    assert.equal(isWatchedSitesModuleCurrent(renderWatchedSitesModule(moved), sites), false);
    assert.equal(isWatchedSitesModuleCurrent(generated.replace(sites[0].name, `${sites[0].name}x`), sites), false);
  });
});
