/**
 * Static lookup tables for the Route Explorer wrapper RPC.
 *
 * These are hand-curated estimates, NOT live rate quotes. They exist because:
 *   - `route-intelligence` does not return transit days or freight estimates
 *   - `BYPASS_CORRIDORS_BY_CHOKEPOINT` has no geometry fields; the client-side
 *     `MapContainer.setBypassRoutes` API wants coordinate pairs, not IDs
 *
 * Every number here should be treated as a rough industry average, not
 * authoritative. If these ever need to move, replace with a live data source
 * (Baltic Exchange, Freightos, etc.) rather than extending these tables.
 */

import { CHOKEPOINT_REGISTRY } from '../../../_shared/chokepoint-registry';

// ─── Transit days per TRADE_ROUTES ID ────────────────────────────────────────

/**
 * Minimum and maximum transit-day estimates per trade route, keyed by the
 * `id` field from `src/config/trade-routes.ts`. Ranges span different vessel
 * classes and seasonal routing choices.
 */
export const TRANSIT_DAYS_BY_ROUTE_ID: Record<string, readonly [number, number]> = {
  'china-europe-suez': [28, 35],
  'china-us-west': [14, 18],
  'china-us-east-suez': [30, 38],
  'china-us-east-panama': [24, 30],
  'gulf-europe-oil': [18, 25],
  'gulf-asia-oil': [16, 22],
  'qatar-europe-lng': [18, 24],
  'qatar-asia-lng': [12, 18],
  'us-europe-lng': [10, 14],
  'russia-med-oil': [8, 14],
  'intra-asia-container': [3, 10],
  'singapore-med': [16, 22],
  'brazil-china-bulk': [35, 45],
  'gulf-americas-cape': [30, 42],
  'asia-europe-cape': [40, 52],
  'india-europe': [18, 26],
  'india-se-asia': [6, 12],
  'china-africa': [22, 32],
  'cpec-route': [10, 16],
  'panama-transit': [1, 2],
  'transatlantic': [8, 14],
};

/**
 * Fallback range when a `primaryRouteId` is not present in the lookup above.
 * Chosen to look obviously "estimated" so UI reviewers notice if the table
 * drifts out of sync with `TRADE_ROUTES`.
 */
export const TRANSIT_DAYS_FALLBACK: readonly [number, number] = [14, 28];

// ─── Freight estimate per cargo type ─────────────────────────────────────────

/**
 * Very rough freight cost estimate per cargo type. For containers this is USD
 * per TEU; for tankers it's USD per ton; for bulk and roro it's USD per ton
 * or per unit. The units are not homogeneous — the UI labels them as "est.
 * freight range" without claiming a specific unit, and users are expected to
 * treat it as an order-of-magnitude indicator only.
 */
export const FREIGHT_USD_BY_CARGO_TYPE: Record<string, readonly [number, number]> = {
  container: [1800, 3200],
  tanker: [25, 65],
  bulk: [12, 30],
  roro: [900, 1800],
};

export const FREIGHT_USD_FALLBACK: readonly [number, number] = [1800, 3200];

// ─── Bypass corridor geometry ────────────────────────────────────────────────

/**
 * Coordinate-pair endpoints for every bypass corridor ID in
 * `BYPASS_CORRIDORS_BY_CHOKEPOINT`. The client feeds these directly to
 * `MapContainer.setBypassRoutes([{fromPort, toPort}])`, which draws an arc
 * between the two points.
 *
 * These are *representative* endpoints, not precise port coordinates. Sea
 * bypass corridors generally use the source chokepoint (from the
 * `CHOKEPOINT_REGISTRY`) as `fromPort` and a notional "exit" point on the
 * other side of the alternative route as `toPort`. Land-bridge corridors use
 * hand-curated rail/road endpoints based on the corridor's `notes` field.
 */
export const BYPASS_CORRIDOR_GEOMETRY_BY_ID: Record<
  string,
  { fromPort: readonly [number, number]; toPort: readonly [number, number] }
> = {
  // ── Sea alternatives (use CHOKEPOINT_REGISTRY for endpoints) ───────────
  suez_cape_of_good_hope: {
    fromPort: [32.3, 30.5], // Suez
    toPort: [18.49, -34.36], // Cape of Good Hope
  },
  sumed_pipeline: {
    fromPort: [32.58, 29.95], // Ain Sukhna terminal, Gulf of Suez
    toPort: [28.88, 31.33], // Sidi Kerir terminal, Mediterranean
  },
  hormuz_cape_of_good_hope: {
    fromPort: [56.5, 26.5], // Hormuz Strait
    toPort: [18.49, -34.36], // Cape of Good Hope
  },
  btc_pipeline: {
    fromPort: [49.85, 40.4], // Baku
    toPort: [35.24, 36.87], // Ceyhan, Turkey
  },
  lombok_strait_bypass: {
    fromPort: [101.5, 2.5], // Malacca Strait
    toPort: [115.7, -8.5], // Lombok Strait
  },
  sunda_strait: {
    fromPort: [101.5, 2.5], // Malacca Strait
    toPort: [105.8, -6.0], // Sunda Strait
  },
  kra_canal_future: {
    fromPort: [101.5, 2.5], // Malacca Strait
    toPort: [99.3, 10.0], // Kra Isthmus (notional)
  },
  bab_el_mandeb_cape_of_good_hope: {
    fromPort: [43.3, 12.5], // Bab el-Mandeb
    toPort: [18.49, -34.36], // Cape of Good Hope
  },
  btc_pipeline_black_sea: {
    fromPort: [49.85, 40.4], // Baku
    toPort: [41.65, 41.65], // Batumi
  },
  panama_cape_horn: {
    fromPort: [-79.7, 9.1], // Panama
    toPort: [-67.3, -55.98], // Cape Horn
  },
  bashi_channel: {
    fromPort: [119.5, 24.0], // Taiwan Strait
    toPort: [121.5, 21.9], // Bashi Channel
  },
  miyako_strait: {
    fromPort: [129.0, 34.0], // Korea Strait
    toPort: [125.3, 24.85], // Miyako Strait
  },
  north_sea_scotland: {
    fromPort: [1.5, 51.0], // Dover Strait
    toPort: [-4.0, 58.5], // North-of-Scotland route
  },
  channel_tunnel: {
    fromPort: [1.5, 51.0], // Dover Strait
    toPort: [1.85, 50.92], // Eurotunnel Coquelles
  },
  gibraltar_no_bypass: {
    fromPort: [-5.6, 35.9], // Gibraltar (degenerate "no bypass" placeholder)
    toPort: [-5.6, 35.9],
  },
  cape_of_good_hope_is_bypass: {
    fromPort: [18.49, -34.36], // Cape of Good Hope
    toPort: [18.49, -34.36],
  },
  la_perouse_strait: {
    fromPort: [129.0, 34.0], // Korea Strait
    toPort: [142.0, 45.7], // La Perouse Strait
  },
  tsugaru_strait: {
    fromPort: [129.0, 34.0], // Korea Strait
    toPort: [140.7, 41.5], // Tsugaru Strait
  },
  black_sea_western_ports: {
    fromPort: [36.6, 45.3], // Kerch Strait
    toPort: [28.65, 44.18], // Constanta
  },
  sunda_strait_for_lombok: {
    fromPort: [115.7, -8.5], // Lombok Strait
    toPort: [105.8, -6.0], // Sunda Strait
  },
  ombai_strait: {
    fromPort: [115.7, -8.5], // Lombok Strait
    toPort: [124.5, -8.4], // Ombai Strait
  },

  // ── Land-bridge corridors (hand-curated rail/road endpoints) ──────────
  aqaba_land_bridge: {
    fromPort: [56.5, 26.5], // Hormuz Strait (origin side)
    toPort: [35.0, 29.53], // Aqaba, Jordan
  },
  djibouti_rail: {
    fromPort: [43.15, 11.6], // Djibouti port
    toPort: [38.74, 9.03], // Addis Ababa
  },
  baku_tbilisi_batumi_rail: {
    fromPort: [49.85, 40.4], // Baku
    toPort: [41.65, 41.65], // Batumi
  },
  us_rail_landbridge: {
    fromPort: [-118.25, 33.74], // Port of Los Angeles
    toPort: [-74.15, 40.67], // Port of New York/New Jersey
  },
  ukraine_rail_reroute: {
    fromPort: [30.74, 46.48], // Odesa
    toPort: [21.0, 52.23], // Warsaw (notional EU entry)
  },
};

/**
 * Deterministic fallback when a corridor ID has no explicit geometry entry.
 * Uses the chokepoint registry coordinate for both endpoints, which renders
 * as a degenerate zero-length arc — intentionally obvious to reviewers.
 */
export function getCorridorGeometryOrFallback(
  corridorId: string,
  primaryChokepointId: string,
): { fromPort: readonly [number, number]; toPort: readonly [number, number] } {
  const explicit = BYPASS_CORRIDOR_GEOMETRY_BY_ID[corridorId];
  if (explicit) return explicit;
  const cp = CHOKEPOINT_REGISTRY.find((c) => c.id === primaryChokepointId);
  if (cp) {
    const pt: readonly [number, number] = [cp.lon, cp.lat];
    return { fromPort: pt, toPort: pt };
  }
  const zero: readonly [number, number] = [0, 0];
  return { fromPort: zero, toPort: zero };
}
