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
 * Lock-down: every major Asian export-hub country with sea access must share
 * at least one route with DE in the cluster JSON, AND `computeLane` must
 * return `noModeledLane: false` for the corresponding HK→DE / TW→DE / etc.
 * Container / Electrical (HS2=85) query — which is the exact shape of the
 * reporter's screenshot in pr-3718's session notes.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import COUNTRY_PORT_CLUSTERS from '../scripts/shared/country-port-clusters.json' with { type: 'json' };
import { computeLane } from '../server/worldmonitor/supply-chain/v1/get-route-explorer-lane.ts';

const ASIAN_PORT_COUNTRIES = ['CN', 'HK', 'TW', 'JP', 'KR', 'SG', 'MY', 'ID', 'TH', 'VN', 'PH', 'IN'] as const;

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
      `Add 'china-europe-suez' and/or 'asia-europe-cape' to the offender's nearestRouteIds in scripts/shared/country-port-clusters.json:\n  ${gaps.join('\n  ')}`,
    );
  });

  it('computeLane(HK → DE, container, HS2=85) returns noModeledLane: false', async () => {
    const res = await computeLane({ fromIso2: 'HK', toIso2: 'DE', hs2: '85', cargoType: 'container' }, new Map());
    assert.equal(res.noModeledLane, false, 'HK → DE container/electronics must resolve a primary route (regression of the user-reported pr-3718 symptom)');
    assert.ok(res.primaryRouteId.length > 0, 'primaryRouteId must be populated when noModeledLane is false');
  });

  it('computeLane returns noModeledLane: false for every Asian-port country → DE (container, HS2=85)', async () => {
    const failures: string[] = [];
    for (const iso2 of ASIAN_PORT_COUNTRIES) {
      const res = await computeLane({ fromIso2: iso2, toIso2: 'DE', hs2: '85', cargoType: 'container' }, new Map());
      if (res.noModeledLane) {
        failures.push(`${iso2} → DE: noModeledLane=true`);
      }
    }
    assert.deepEqual(failures, [], `computeLane reported no modeled lane for:\n  ${failures.join('\n  ')}`);
  });
});
