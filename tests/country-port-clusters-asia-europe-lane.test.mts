/**
 * Regression lock for the Asian-port-cluster ↔ Germany lane gap.
 *
 * PR #3828 fixed HK→DE by adding `china-europe-suez` and `asia-europe-cape` to
 * HK's `nearestRouteIds` in `scripts/shared/country-port-clusters.json`. The
 * same gap existed for TW/KR/JP/VN/TH/PH (the deferred follow-up noted in
 * #3828's commit message) and for IN.
 *
 * Symptom: Route Explorer renders "No modeled lane for this pair." for these
 * countries → DE because `computeLane` returns `noModeledLane: true` whenever
 * `sharedRoutes.length === 0` (server/.../get-route-explorer-lane.ts:233-234).
 *
 * Lock-down: every major Asian export-hub country with sea access must (a) share
 * at least one route with DE in the cluster JSON, AND (b) resolve to the
 * geographically-faithful `primaryRouteId` — IN→DE must pick `india-europe`
 * (Nhava Sheva → Rotterdam), not `china-europe-suez` (Shanghai → Rotterdam).
 *
 * The previous version of this test only asserted `noModeledLane === false`,
 * which was too weak: an "Indian shipment to Germany" rendering the Shanghai
 * origin port still passed (PR #3832 review P1). This version pins the exact
 * route ID per origin so a future contributor swapping the convention gets a
 * specific failure naming the offender and the route that resolved.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import COUNTRY_PORT_CLUSTERS from '../scripts/shared/country-port-clusters.json' with { type: 'json' };
import { computeLane } from '../server/worldmonitor/supply-chain/v1/get-route-explorer-lane.ts';

const ASIAN_PORT_COUNTRIES = ['CN', 'HK', 'TW', 'JP', 'KR', 'SG', 'MY', 'ID', 'TH', 'VN', 'PH', 'IN'] as const;

// Expected primaryRouteId for each origin → DE (container, HS2=85).
// The trunk Asia-Europe route is `china-europe-suez` (Shanghai → Rotterdam),
// shared by every East/Southeast Asian export hub via Suez transit. IN is the
// exception: it has its own dedicated route `india-europe` (Nhava Sheva →
// Rotterdam) and must resolve to that so the UI highlights an Indian origin
// port — not Shanghai — for an Indian shipment.
const EXPECTED_PRIMARY_ROUTE_TO_DE: Record<string, string> = {
  CN: 'china-europe-suez',
  HK: 'china-europe-suez',
  TW: 'china-europe-suez',
  JP: 'china-europe-suez',
  KR: 'china-europe-suez',
  SG: 'china-europe-suez',
  MY: 'china-europe-suez',
  ID: 'china-europe-suez',
  TH: 'china-europe-suez',
  VN: 'china-europe-suez',
  PH: 'china-europe-suez',
  IN: 'india-europe',
};

const clusters = COUNTRY_PORT_CLUSTERS as unknown as Record<string, { nearestRouteIds: string[] }>;

describe('country-port-clusters: Asian export hubs share a lane with DE', () => {
  it('every Asian port country has a non-empty nearestRouteIds intersection with DE', () => {
    const deRoutes = new Set(clusters.DE?.nearestRouteIds ?? []);
    assert.ok(deRoutes.size > 0, 'DE cluster entry must exist with at least one route');

    const gaps: string[] = [];
    for (const iso2 of ASIAN_PORT_COUNTRIES) {
      const countryRoutes = clusters[iso2]?.nearestRouteIds ?? [];
      const shared = countryRoutes.filter((r) => deRoutes.has(r));
      if (shared.length === 0) {
        gaps.push(`${iso2} → DE: shared routes = [] (country has [${countryRoutes.join(', ')}], DE has [${[...deRoutes].join(', ')}])`);
      }
    }

    assert.deepEqual(
      gaps,
      [],
      `Found ${gaps.length} Asian port country/countries with no modeled lane to DE.\n` +
      `Add 'china-europe-suez' and/or 'asia-europe-cape' (or, for IN, 'india-europe' to DE) in scripts/shared/country-port-clusters.json:\n  ${gaps.join('\n  ')}`,
    );
  });

  it('every Asian-port country → DE resolves the geographically-faithful primaryRouteId (PR #3832 review P1 lock, includes HK→DE — the user-reported pr-3718 symptom)', async () => {
    const mismatches: string[] = [];
    for (const iso2 of ASIAN_PORT_COUNTRIES) {
      const res = await computeLane({ fromIso2: iso2, toIso2: 'DE', hs2: '85', cargoType: 'container' }, new Map());
      if (res.noModeledLane) {
        mismatches.push(`${iso2} → DE: noModeledLane=true (expected primaryRouteId='${EXPECTED_PRIMARY_ROUTE_TO_DE[iso2]}')`);
        continue;
      }
      const expected = EXPECTED_PRIMARY_ROUTE_TO_DE[iso2];
      if (res.primaryRouteId !== expected) {
        mismatches.push(`${iso2} → DE: primaryRouteId='${res.primaryRouteId}', expected='${expected}'`);
      }
    }
    assert.deepEqual(
      mismatches,
      [],
      `Lane resolution picked a non-faithful primary route. The Route Explorer UI highlights the route's from→to ports, so IN→DE picking 'china-europe-suez' renders a Shanghai origin for an Indian shipment.\n  ${mismatches.join('\n  ')}\n` +
      `Fix: ensure DE's nearestRouteIds includes 'india-europe' (so IN's intersection finds it), and that no Indian-origin entry has been polluted with China-origin trunk routes.`,
    );
  });
});
