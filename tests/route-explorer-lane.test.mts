import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { computeLane } from '../server/worldmonitor/supply-chain/v1/get-route-explorer-lane.ts';
import { countryBox, inBox } from '../shared/country-bbox.ts';
import { STRATEGIC_WATERWAYS } from '../shared/geo-data.ts';
import { TRADE_ROUTES } from '../src/config/trade-routes.ts';
import { CHOKEPOINT_REGISTRY } from '../server/_shared/chokepoint-registry.ts';
import { BYPASS_CORRIDORS_BY_CHOKEPOINT } from '../server/_shared/bypass-corridors.ts';

describe('route explorer lane responses', () => {
  it('returns the China-Europe container lane with its exposures and Suez bypass', async () => {
    const request = { fromIso2: 'CN', toIso2: 'DE', hs2: '85', cargoType: 'container' };
    const res = await computeLane(request, new Map());
    assert.equal(res.noModeledLane, false);
    assert.equal(res.primaryRouteId, 'china-europe-suez');
    assert.equal(res.fromIso2, request.fromIso2);
    assert.equal(res.toIso2, request.toIso2);
    assert.equal(res.hs2, request.hs2);
    assert.equal(res.cargoType, request.cargoType);
    assert.equal(res.warRiskTier, 'WAR_RISK_TIER_NORMAL');
    assert.equal(res.disruptionScore, 0);
    assert.equal(new Date(res.fetchedAt).toISOString(), res.fetchedAt);

    assert.ok(res.primaryRouteGeometry.length >= 2);
    assert.deepEqual(res.chokepointExposures.map(e => e.chokepointId).sort(), ['bab_el_mandeb', 'malacca_strait', 'suez']);
    for (const exposure of res.chokepointExposures) {
      assert.match(exposure.chokepointName, /\S/);
      assert.ok(Number.isFinite(exposure.exposurePct) && exposure.exposurePct > 0 && exposure.exposurePct <= 100);
    }

    assert.deepEqual(res.bypassOptions.map(b => b.id), ['suez_cape_of_good_hope']);
    const [cape] = res.bypassOptions;
    assert.ok(cape);
    assert.match(cape.name, /\S/);
    assert.equal(cape.type, 'alternative_sea_route');
    assert.equal(cape.status, 'CORRIDOR_STATUS_ACTIVE');
    assert.ok(Number.isFinite(cape.addedTransitDays));
    assert.ok(Number.isFinite(cape.addedCostMultiplier));
    for (const point of [...res.primaryRouteGeometry, cape.fromPort, cape.toPort]) {
      assert.ok(point && Number.isFinite(point.lon) && Number.isFinite(point.lat));
    }
    for (const range of [res.estTransitDaysRange, res.estFreightUsdPerTeuRange]) {
      assert.ok(range && Number.isFinite(range.min) && Number.isFinite(range.max) && range.min <= range.max);
    }
  });

  it('returns an empty lane without estimates for bulk cargo from South Africa to India', async () => {
    const request = { fromIso2: 'ZA', toIso2: 'IN', hs2: '10', cargoType: 'bulk' };
    const { fetchedAt, estTransitDaysRange, estFreightUsdPerTeuRange, ...lane } = await computeLane(request, new Map());
    assert.equal(new Date(fetchedAt).toISOString(), fetchedAt);
    assert.equal(estTransitDaysRange, undefined);
    assert.equal(estFreightUsdPerTeuRange, undefined);
    assert.deepEqual(lane, {
      ...request,
      primaryRouteId: '',
      primaryRouteGeometry: [],
      chokepointExposures: [],
      bypassOptions: [],
      warRiskTier: 'WAR_RISK_TIER_NORMAL',
      disruptionScore: 0,
      noModeledLane: true,
    });
  });

  it('selects different China-Japan routes for tankers and containers', async () => {
    const pair = { fromIso2: 'CN', toIso2: 'JP' };
    const tanker = await computeLane({ ...pair, hs2: '27', cargoType: 'tanker' }, new Map());
    const container = await computeLane({ ...pair, hs2: '27', cargoType: 'container' }, new Map());
    assert.equal(tanker.cargoType, 'tanker');
    assert.equal(tanker.hs2, '27');
    assert.equal(tanker.primaryRouteId, 'gulf-asia-oil');
    assert.equal(container.primaryRouteId, 'china-europe-suez');
  });

  it('reports Suez disruption and derives Cape bypass risk from its own waypoint', async () => {
    const status = new Map([
      ['suez', { id: 'suez', disruptionScore: 75, warRiskTier: 'WAR_RISK_TIER_CRITICAL' }],
      ['malacca_strait', { id: 'malacca_strait', disruptionScore: 30, warRiskTier: 'WAR_RISK_TIER_ELEVATED' }],
      ['cape_of_good_hope', { id: 'cape_of_good_hope', disruptionScore: 20, warRiskTier: 'WAR_RISK_TIER_HIGH' }],
    ]);
    const res = await computeLane({ fromIso2: 'CN', toIso2: 'DE', hs2: '85', cargoType: 'container' }, status);
    assert.equal(res.disruptionScore, 75);
    assert.equal(res.warRiskTier, 'WAR_RISK_TIER_CRITICAL');
    const cape = res.bypassOptions.find(b => b.id === 'suez_cape_of_good_hope');
    assert.equal(cape?.warRiskTier, 'WAR_RISK_TIER_HIGH');
  });

  for (const [fromIso2, toIso2, primary] of [
    ['IR', 'IT', 'gibraltar'],
    ['TW', 'ZA', 'cape_of_good_hope'],
  ]) {
    it(`excludes the placeholder bypass for ${primary}`, async () => {
      const res = await computeLane({ fromIso2, toIso2, hs2: '27', cargoType: 'tanker' }, new Map());
      assert.equal(res.chokepointExposures[0]?.chokepointId, primary);
      assert.deepEqual(res.bypassOptions, []);
    });
  }

  it('retains the proposed zero-day Kra Canal bypass for Malacca', async () => {
    const res = await computeLane({ fromIso2: 'NG', toIso2: 'CN', hs2: '85', cargoType: 'container' }, new Map());
    assert.equal(res.chokepointExposures[0]?.chokepointId, 'malacca_strait');
    const kra = res.bypassOptions.find(b => b.id === 'kra_canal_future');
    assert.equal(kra?.status, 'CORRIDOR_STATUS_PROPOSED');
    assert.equal(kra.addedTransitDays, 0);
  });

  it('reports war-zone risk for an unavailable corridor without waypoints', async (t) => {
    // Kerch has no modeled route. Supply its corridors on the modeled Black Sea tanker lane.
    t.mock.property(BYPASS_CORRIDORS_BY_CHOKEPOINT, 'bosphorus', BYPASS_CORRIDORS_BY_CHOKEPOINT.kerch_strait);
    const res = await computeLane({ fromIso2: 'RU', toIso2: 'TR', hs2: '27', cargoType: 'tanker' }, new Map());
    const westernPorts = res.bypassOptions.find(b => b.id === 'black_sea_western_ports');
    assert.equal(westernPorts?.status, 'CORRIDOR_STATUS_UNAVAILABLE');
    assert.equal(westernPorts.warRiskTier, 'WAR_RISK_TIER_WAR_ZONE');
  });
});

describe('US-Northeast Asia lanes (#7990)', () => {
  for (const toIso2 of ['JP', 'KR']) {
    it(`US -> ${toIso2} container and bulk use the West Coast lane with no chokepoint`, async () => {
      for (const cargoType of ['container', 'bulk']) {
        const res = await computeLane({ fromIso2: 'US', toIso2, hs2: '85', cargoType }, new Map());
        assert.equal(res.noModeledLane, false);
        assert.equal(res.primaryRouteId, 'us-west-northeast-asia');
        assert.deepEqual(res.chokepointExposures, []);
        assert.deepEqual(res.bypassOptions, []);
        assert.deepEqual(res.estTransitDaysRange, { min: 10, max: 14 });
      }
    });

    it(`US -> ${toIso2} tanker uses the Gulf lane through Panama with its bypass`, async () => {
      const res = await computeLane({ fromIso2: 'US', toIso2, hs2: '27', cargoType: 'tanker' }, new Map());
      assert.equal(res.noModeledLane, false);
      assert.equal(res.primaryRouteId, 'us-gulf-asia-panama');
      assert.deepEqual(res.chokepointExposures.map((e) => e.chokepointId), ['panama']);
      assert.deepEqual(res.bypassOptions.map((b) => b.id), ['panama_cape_horn']);
      assert.deepEqual(res.estTransitDaysRange, { min: 24, max: 32 });
    });
  }
});

describe('route waypoints and chokepoint registries agree', () => {
  // Exposure arithmetic reads registry routeIds, while supplier route risk and
  // lane geometry read route waypoints. A route that crosses a chokepoint in
  // one source and not the other draws a lane through the canal with no
  // chokepoint on it (US→JP tanker via us-gulf-asia-panama, #7990).
  it('lists every waypoint route in that chokepoint registry entry, and back', async () => {
    const { TRADE_ROUTES } = await import('../src/config/trade-routes.ts');
    const { CHOKEPOINT_REGISTRY } = await import('../server/_shared/chokepoint-registry.ts');
    const byWaypoint = new Map<string, { id: string; routeIds: string[] }>();
    for (const cp of CHOKEPOINT_REGISTRY) {
      byWaypoint.set(cp.id, cp);
      byWaypoint.set(cp.geoId, cp);
    }
    const mismatches: string[] = [];
    for (const route of TRADE_ROUTES) {
      for (const waypoint of route.waypoints) {
        const cp = byWaypoint.get(waypoint);
        if (cp && !cp.routeIds.includes(route.id)) mismatches.push(`${route.id} crosses ${cp.id} but is not in its routeIds`);
      }
    }
    for (const cp of CHOKEPOINT_REGISTRY) {
      for (const routeId of cp.routeIds) {
        const route = TRADE_ROUTES.find((r) => r.id === routeId);
        if (!route) mismatches.push(`${cp.id} lists unknown route ${routeId}`);
        else if (!route.waypoints.includes(cp.id) && !route.waypoints.includes(cp.geoId)) {
          mismatches.push(`${cp.id} lists ${routeId}, whose waypoints do not include it`);
        }
      }
    }
    assert.deepEqual(mismatches, []);
  });

  it('keeps the browser and seeder registry routeIds equal to the server registry', async () => {
    const { CHOKEPOINT_REGISTRY: server } = await import('../server/_shared/chokepoint-registry.ts');
    const { CHOKEPOINT_REGISTRY: browser } = await import('../src/config/chokepoint-registry.ts');
    const expected = Object.fromEntries(server.map((cp) => [cp.id, [...cp.routeIds].sort()]));
    assert.deepEqual(Object.fromEntries(browser.map((cp) => [cp.id, [...cp.routeIds].sort()])), expected);
    const seederSource = readFileSync(new URL('../scripts/seed-hs2-chokepoint-exposure.mjs', import.meta.url), 'utf8');
    const seeder: Record<string, string[]> = {};
    for (const match of seederSource.matchAll(/^ {2}\{ id: '([a-z0-9_]+)'[^\n]*routeIds: \[([^\]]*)\]/gm)) {
      seeder[match[1]] = match[2].split(',').map((entry) => entry.trim().replace(/'/g, '')).filter(Boolean).sort();
    }
    assert.deepEqual(seeder, expected);
  });
});

describe('lanes start and end in the requested countries', () => {
  const lane = (fromIso2: string, toIso2: string, cargoType: string) =>
    computeLane({ fromIso2, toIso2, hs2: cargoType === 'tanker' ? '27' : '85', cargoType }, new Map());
  type Lane = Awaited<ReturnType<typeof computeLane>>;
  const ends = (res: Lane) => {
    const g = res.primaryRouteGeometry;
    return { first: g[0]!, last: g[g.length - 1]! };
  };
  const assertIn = (iso2: string, point: { lat: number; lon: number }, label: string) => {
    assert.ok(inBox(countryBox(iso2), point.lat, point.lon), `${label} ${JSON.stringify(point)} is not in ${iso2}`);
  };
  const cps = (res: Lane) => res.chokepointExposures.map((e) => e.chokepointId);

  for (const origin of ['SA', 'AE', 'IR']) {
    it(`${origin} -> IN stops in India before Malacca`, async () => {
      const res = await lane(origin, 'IN', 'tanker');
      assert.equal(res.primaryRouteId, 'gulf-asia-oil');
      assert.deepEqual(cps(res), ['hormuz_strait']);
      assertIn('IN', ends(res).last, 'lane end');
      assert.ok(res.bypassOptions.every((b) => !/malacca|kra|sunda|lombok/i.test(b.id)), 'bypasses follow Hormuz, not Malacca');
    });
  }

  it('IN -> SA runs the Gulf route backwards from India and keeps only Hormuz', async () => {
    const res = await lane('IN', 'SA', 'tanker');
    assert.deepEqual(cps(res), ['hormuz_strait']);
    assertIn('IN', ends(res).first, 'lane start');
    assertIn('SA', ends(res).last, 'lane end');
  });

  it('SA -> KR ends in Korea and keeps Hormuz and Malacca', async () => {
    const res = await lane('SA', 'KR', 'tanker');
    assert.deepEqual([...cps(res)].sort(), ['hormuz_strait', 'malacca_strait']);
    assertIn('SA', ends(res).first, 'lane start');
    assertIn('KR', ends(res).last, 'lane end');
  });

  it('CN -> KR does not cross Suez or Bab el-Mandeb', async () => {
    const res = await lane('CN', 'KR', 'container');
    for (const cp of ['suez', 'bab_el_mandeb', 'gibraltar']) assert.ok(!cps(res).includes(cp), `${cp} is not on a China-Korea lane`);
    assertIn('CN', ends(res).first, 'lane start');
    assertIn('KR', ends(res).last, 'lane end');
  });

  it('keeps a full route whose endpoints are already in the requested countries', async () => {
    const res = await lane('CN', 'NL', 'container');
    assert.equal(res.primaryRouteId, 'china-europe-suez');
    assert.ok(cps(res).includes('suez') && cps(res).includes('malacca_strait'));
    assertIn('CN', ends(res).first, 'lane start');
    assertIn('NL', ends(res).last, 'lane end');
  });

  it('keeps every route chokepoint when a country has no modeled port', async () => {
    // Kuwait has no entry in PORTS, so nothing says where it sits on the
    // route; dropping Malacca there would be a guess that reads as safer.
    const kuwait = await lane('KW', 'IN', 'tanker');
    assert.deepEqual([...cps(kuwait)].sort(), ['hormuz_strait', 'malacca_strait']);
    assertIn('IN', ends(kuwait).last, 'lane end');
    const australia = await lane('AU', 'KR', 'container');
    assertIn('KR', ends(australia).last, 'lane end');
    assert.ok(australia.primaryRouteGeometry.length >= 2);
  });

  it('keeps Hormuz for UAE cargo although the straight leg passes Jebel Ali', async () => {
    for (const toIso2 of ['NL', 'GR', 'IN']) {
      const res = await lane('AE', toIso2, 'tanker');
      assert.ok(cps(res).includes('hormuz_strait'), `AE -> ${toIso2} must cross Hormuz`);
    }
  });

  it('counts Malacca for Gulf cargo to Laem Chabang, which projects just short of the strait', async () => {
    const res = await lane('SA', 'TH', 'tanker');
    assert.deepEqual([...cps(res)].sort(), ['hormuz_strait', 'malacca_strait']);
    assertIn('TH', ends(res).last, 'lane end');
  });

  it('drops chokepoints a lane never reaches', async () => {
    assert.deepEqual(cps(await lane('JP', 'KR', 'container')), []);
    assert.deepEqual(cps(await lane('NL', 'GR', 'tanker')), ['gibraltar']);
  });

  // The lane is built from the browser's waterway coordinates so free visitors
  // see the same lane as subscribers; the server reports exposure from its
  // chokepoint registry. The two must not drift apart.
  it('route waypoints sit at the same coordinates in the waterway list and the chokepoint registry', () => {
    for (const id of new Set(TRADE_ROUTES.flatMap((r) => r.waypoints))) {
      const waterway = STRATEGIC_WATERWAYS.find((w) => w.id === id);
      const registered = CHOKEPOINT_REGISTRY.find((c) => c.geoId === id);
      assert.ok(waterway && registered, `${id} is missing from the waterway list or the registry`);
      assert.deepEqual([waterway.lat, waterway.lon], [registered.lat, registered.lon], id);
    }
  });
});
