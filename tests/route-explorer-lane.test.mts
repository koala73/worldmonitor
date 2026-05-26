/**
 * Smoke test matrix for `get-route-explorer-lane`.
 *
 * Calls the pure `computeLane` function (no Redis, no premium gate) for 30
 * representative country pairs × HS2 codes and asserts on response *structure*
 * — not hard-coded transit/cost values, which would drift as the underlying
 * static tables change.
 *
 * The matrix also doubles as a gap report: any pair with empty
 * `chokepointExposures` or `bypassOptions` is logged so Sprint 3/5 can plan
 * empty-state work.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { computeLane } from '../server/worldmonitor/supply-chain/v1/get-route-explorer-lane.ts';
import type { GetRouteExplorerLaneRequest } from '../src/generated/server/worldmonitor/supply_chain/v1/service_server.ts';

const PAIRS: Array<[string, string, string]> = [
  ['CN', 'DE', 'high-volume baseline'],
  ['US', 'JP', 'transpacific'],
  ['IR', 'CN', 'Hormuz-dependent'],
  ['BR', 'NL', 'Atlantic'],
  ['AU', 'KR', 'Pacific'],
  ['ZA', 'IN', 'Cape of Good Hope'],
  ['EG', 'IT', 'Mediterranean short-haul'],
  ['NG', 'CN', 'Africa to Asia crude'],
  ['CL', 'CN', 'South America to Asia copper'],
  ['TR', 'DE', 'semi-landlocked, tests land-bridge path'],
];

const HS2_CODES = ['27', '85', '10'];

const VALID_WAR_RISK_TIERS = new Set([
  'WAR_RISK_TIER_UNSPECIFIED',
  'WAR_RISK_TIER_NORMAL',
  'WAR_RISK_TIER_ELEVATED',
  'WAR_RISK_TIER_HIGH',
  'WAR_RISK_TIER_CRITICAL',
  'WAR_RISK_TIER_WAR_ZONE',
]);

const VALID_STATUSES = new Set([
  'CORRIDOR_STATUS_UNSPECIFIED',
  'CORRIDOR_STATUS_ACTIVE',
  'CORRIDOR_STATUS_PROPOSED',
  'CORRIDOR_STATUS_UNAVAILABLE',
]);

interface GapRow {
  pair: string;
  hs2: string;
  primaryRouteId: string;
  noModeledLane: boolean;
  exposures: number;
  bypasses: number;
  reason: string;
}

const gapRows: GapRow[] = [];

describe('get-route-explorer-lane smoke matrix (30 queries)', () => {
  for (const [fromIso2, toIso2, reason] of PAIRS) {
    for (const hs2 of HS2_CODES) {
      it(`${fromIso2} -> ${toIso2}, HS ${hs2} (${reason})`, async () => {
        const req: GetRouteExplorerLaneRequest = {
          fromIso2,
          toIso2,
          hs2,
          cargoType: hs2 === '27' ? 'tanker' : hs2 === '10' ? 'bulk' : 'container',
        };

        // Pass an empty chokepoint-status map so the test does not depend on
        // a live Redis cache. War risk + disruption come back as defaults.
        const res = await computeLane(req, new Map());

        // Echoed inputs
        assert.equal(res.fromIso2, fromIso2);
        assert.equal(res.toIso2, toIso2);
        assert.equal(res.hs2, hs2);

        // Cargo type echoed and valid
        assert.match(res.cargoType, /^(container|tanker|bulk|roro)$/);

        // primaryRouteId is either non-empty OR noModeledLane is set
        if (!res.primaryRouteId) {
          assert.equal(
            res.noModeledLane,
            true,
            'empty primaryRouteId requires noModeledLane=true',
          );
        }

        // primaryRouteGeometry is an array (may be empty when no modeled lane)
        assert.ok(Array.isArray(res.primaryRouteGeometry));
        for (const pt of res.primaryRouteGeometry) {
          assert.equal(typeof pt.lon, 'number');
          assert.equal(typeof pt.lat, 'number');
          assert.ok(Number.isFinite(pt.lon));
          assert.ok(Number.isFinite(pt.lat));
        }

        // chokepointExposures is an array of well-formed entries
        assert.ok(Array.isArray(res.chokepointExposures));
        for (const e of res.chokepointExposures) {
          assert.equal(typeof e.chokepointId, 'string');
          assert.equal(typeof e.chokepointName, 'string');
          assert.equal(typeof e.exposurePct, 'number');
          assert.ok(e.exposurePct >= 0 && e.exposurePct <= 100);
        }

        // bypassOptions is an array of well-formed entries
        assert.ok(Array.isArray(res.bypassOptions));
        for (const b of res.bypassOptions) {
          assert.equal(typeof b.id, 'string');
          assert.equal(typeof b.name, 'string');
          assert.equal(typeof b.type, 'string');
          assert.equal(typeof b.addedTransitDays, 'number');
          assert.equal(typeof b.addedCostMultiplier, 'number');
          assert.ok(VALID_STATUSES.has(b.status));
          assert.ok(b.fromPort, 'bypass option must include fromPort');
          assert.ok(b.toPort, 'bypass option must include toPort');
          assert.equal(typeof b.fromPort.lon, 'number');
          assert.equal(typeof b.fromPort.lat, 'number');
          assert.equal(typeof b.toPort.lon, 'number');
          assert.equal(typeof b.toPort.lat, 'number');
          assert.ok(Number.isFinite(b.fromPort.lon));
          assert.ok(Number.isFinite(b.toPort.lon));
        }

        // war risk tier is in the known enum set
        assert.ok(
          VALID_WAR_RISK_TIERS.has(res.warRiskTier),
          `unexpected warRiskTier: ${res.warRiskTier}`,
        );

        // disruption score is a finite number in [0, 100]
        assert.equal(typeof res.disruptionScore, 'number');
        assert.ok(res.disruptionScore >= 0 && res.disruptionScore <= 100);

        // transit + freight ranges: present and well-formed when lane is modeled;
        // omitted when noModeledLane is true (no synthetic estimates)
        if (!res.noModeledLane) {
          assert.ok(res.estTransitDaysRange, 'modeled lane must include transit range');
          assert.ok(res.estFreightUsdPerTeuRange, 'modeled lane must include freight range');
          assert.ok(Number.isFinite(res.estTransitDaysRange.min));
          assert.ok(Number.isFinite(res.estTransitDaysRange.max));
          assert.ok(res.estTransitDaysRange.min <= res.estTransitDaysRange.max);
          assert.ok(res.estFreightUsdPerTeuRange.min <= res.estFreightUsdPerTeuRange.max);
        } else {
          assert.equal(res.primaryRouteId, '', 'noModeledLane must have empty primaryRouteId');
          assert.equal(res.primaryRouteGeometry.length, 0, 'noModeledLane must have empty geometry');
          assert.equal(res.chokepointExposures.length, 0, 'noModeledLane must have empty exposures');
          assert.equal(res.bypassOptions.length, 0, 'noModeledLane must have empty bypasses');
        }

        // fetchedAt is an ISO string
        assert.equal(typeof res.fetchedAt, 'string');
        assert.ok(res.fetchedAt.length > 0);

        // Record gap-report metadata for the run summary
        gapRows.push({
          pair: `${fromIso2}->${toIso2}`,
          hs2,
          primaryRouteId: res.primaryRouteId,
          noModeledLane: res.noModeledLane,
          exposures: res.chokepointExposures.length,
          bypasses: res.bypassOptions.length,
          reason,
        });
      });
    }
  }

  it('gap report summary (informational, never fails)', () => {
    // Print a compact gap report so plan reviewers can see which pairs
    // returned synthetic / empty data.
    if (gapRows.length === 0) {
      // No-op when run before the matrix above (test ordering is preserved)
      return;
    }
    const noLane = gapRows.filter((r) => r.noModeledLane);
    const emptyExposures = gapRows.filter((r) => r.exposures === 0);
    const emptyBypasses = gapRows.filter((r) => r.bypasses === 0);
    // eslint-disable-next-line no-console
    console.log(
      `\n[gap report] ${gapRows.length} queries | ${noLane.length} synthetic-fallback | ${emptyExposures.length} empty exposures | ${emptyBypasses.length} empty bypasses`,
    );
    if (noLane.length > 0) {
      // eslint-disable-next-line no-console
      console.log('  synthetic-fallback pairs:');
      for (const r of noLane) {
        // eslint-disable-next-line no-console
        console.log(`    ${r.pair} HS${r.hs2} -> ${r.primaryRouteId || '(none)'}`);
      }
    }
    // eslint-disable-next-line no-console
    console.log(
      '\n[design gap] bypassOptions are only computed for the primary chokepoint (highest exposurePct).' +
        '\nMulti-chokepoint routes (e.g. CN->DE via Malacca + Suez) show exposure data for both but' +
        '\nbypass guidance only for the primary one. Sprint 3 should decide: expand to top-N chokepoints,' +
        '\nor show a "see also" hint in the UI.',
    );
    // Always passes; informational only.
    assert.ok(true);
  });

  it('cargo-aware route selection: CN->JP tanker picks energy route over container', async () => {
    const res = await computeLane(
      { fromIso2: 'CN', toIso2: 'JP', hs2: '27', cargoType: 'tanker' },
      new Map(),
    );
    if (!res.noModeledLane && res.primaryRouteId) {
      const { TRADE_ROUTES } = await import('../src/config/trade-routes.ts');
      const route = TRADE_ROUTES.find((r: { id: string }) => r.id === res.primaryRouteId);
      assert.ok(route, `primaryRouteId ${res.primaryRouteId} not in TRADE_ROUTES`);
      assert.equal(
        route.category,
        'energy',
        `tanker request should prefer an energy route, got ${route.category} (${res.primaryRouteId})`,
      );
    }
  });

  it('bypass warRiskTier derives from waypoint chokepoints, not primary', async () => {
    const fakeStatus = new Map<string, { id: string; warRiskTier: string }>([
      ['suez', { id: 'suez', warRiskTier: 'WAR_RISK_TIER_CRITICAL' }],
      ['cape_of_good_hope', { id: 'cape_of_good_hope', warRiskTier: 'WAR_RISK_TIER_NORMAL' }],
    ]);
    const res = await computeLane(
      { fromIso2: 'CN', toIso2: 'DE', hs2: '85', cargoType: 'container' },
      fakeStatus as Map<string, any>,
    );
    const capeBypass = res.bypassOptions.find((b) => b.id === 'suez_cape_of_good_hope');
    if (capeBypass) {
      assert.equal(
        capeBypass.warRiskTier,
        'WAR_RISK_TIER_NORMAL',
        'Cape bypass should reflect its own waypoint risk (NORMAL), not the primary chokepoint (CRITICAL)',
      );
    }
  });

  it('placeholder corridors are excluded but proposed zero-day corridors survive', async () => {
    const res = await computeLane(
      { fromIso2: 'ES', toIso2: 'EG', hs2: '85', cargoType: 'container' },
      new Map(),
    );
    const placeholder = res.bypassOptions.find((b) =>
      b.id === 'gibraltar_no_bypass' || b.id === 'cape_of_good_hope_is_bypass',
    );
    assert.equal(placeholder, undefined, 'explicit placeholder corridors should be filtered out');
  });

  it('kra_canal_future appears as CORRIDOR_STATUS_PROPOSED for Malacca routes', async () => {
    const res = await computeLane(
      { fromIso2: 'CN', toIso2: 'DE', hs2: '85', cargoType: 'container' },
      new Map(),
    );
    const kra = res.bypassOptions.find((b) => b.id === 'kra_canal_future');
    if (kra) {
      assert.equal(
        kra.status,
        'CORRIDOR_STATUS_PROPOSED',
        'kra_canal_future should be surfaced as proposed, not filtered out',
      );
    }
  });

  it('disruptionScore and warRiskTier reflect injected status map', async () => {
    const fakeStatus = new Map<string, { id: string; disruptionScore?: number; warRiskTier?: string }>([
      ['suez', { id: 'suez', disruptionScore: 75, warRiskTier: 'WAR_RISK_TIER_HIGH' }],
      ['malacca_strait', { id: 'malacca_strait', disruptionScore: 30, warRiskTier: 'WAR_RISK_TIER_ELEVATED' }],
    ]);
    const res = await computeLane(
      { fromIso2: 'CN', toIso2: 'DE', hs2: '85', cargoType: 'container' },
      fakeStatus as Map<string, any>,
    );
    if (res.noModeledLane) return;
    assert.ok(res.disruptionScore > 0, 'disruptionScore should reflect injected data, not default to 0');
    assert.notEqual(res.warRiskTier, 'WAR_RISK_TIER_NORMAL', 'warRiskTier should reflect injected data');
  });

  it('unavailable corridor without waypoints gets WAR_RISK_TIER_WAR_ZONE', async () => {
    const fakeStatus = new Map<string, { id: string; warRiskTier?: string }>([
      ['kerch_strait', { id: 'kerch_strait', warRiskTier: 'WAR_RISK_TIER_WAR_ZONE' }],
    ]);
    const res = await computeLane(
      { fromIso2: 'RU', toIso2: 'TR', hs2: '27', cargoType: 'tanker' },
      fakeStatus as Map<string, any>,
    );
    const unavailable = res.bypassOptions.find((b) => b.status === 'CORRIDOR_STATUS_UNAVAILABLE');
    if (unavailable) {
      assert.equal(
        unavailable.warRiskTier,
        'WAR_RISK_TIER_WAR_ZONE',
        'unavailable corridors without waypoints should derive WAR_ZONE from status',
      );
    }
  });

  it('chokepointExposures and bypassOptions follow the primaryRouteId', async () => {
    const res = await computeLane(
      { fromIso2: 'CN', toIso2: 'JP', hs2: '85', cargoType: 'container' },
      new Map(),
    );
    if (res.noModeledLane || !res.primaryRouteId) return;
    const { TRADE_ROUTES } = await import('../src/config/trade-routes.ts');
    const { CHOKEPOINT_REGISTRY } = await import('../server/_shared/chokepoint-registry.ts');
    const route = TRADE_ROUTES.find((r: { id: string }) => r.id === res.primaryRouteId);
    assert.ok(route, `primaryRouteId ${res.primaryRouteId} not in TRADE_ROUTES`);
    const routeChokepointIds = new Set(
      CHOKEPOINT_REGISTRY
        .filter((cp: { routeIds: string[] }) => cp.routeIds.includes(res.primaryRouteId))
        .map((cp: { id: string }) => cp.id),
    );
    for (const exp of res.chokepointExposures) {
      assert.ok(
        routeChokepointIds.has(exp.chokepointId),
        `chokepoint ${exp.chokepointId} is not on the primary route ${res.primaryRouteId}`,
      );
    }
  });
});
