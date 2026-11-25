// Which chokepoints a bilateral sea flow crosses. A chokepoint that encloses a sea
// (Hormuz and the Persian Gulf) is crossed when exactly one partner is inside it.
// Any other chokepoint counts only when both countries sit on a modeled TRADE_ROUTES
// corridor (src/config/trade-routes.ts) at opposite regional ends. A country merely
// near a corridor is not evidence that its trade with every partner uses it. Pure
// data in, so the Railway seeder and the edge handler share one rule.

// Regional ends of each corridor; same table as src/utils/supplier-route-risk.ts.
export const CORRIDOR_REGIONS = Object.freeze({
  'china-europe-suez': ['east-asia', 'europe'],
  'china-us-west': ['east-asia', 'north-america'],
  'china-us-east-suez': ['east-asia', 'north-america'],
  'china-us-east-panama': ['east-asia', 'north-america'],
  'gulf-europe-oil': ['mena', 'europe'],
  'gulf-asia-oil': ['mena', 'east-asia'],
  'qatar-europe-lng': ['mena', 'europe'],
  'qatar-asia-lng': ['mena', 'east-asia'],
  'us-europe-lng': ['north-america', 'europe'],
  'russia-med-oil': ['europe', 'europe'],
  'intra-asia-container': ['east-asia', 'east-asia'],
  'singapore-med': ['east-asia', 'europe'],
  'brazil-china-bulk': ['latam', 'east-asia'],
  'gulf-americas-cape': ['mena', 'latam'],
  'asia-europe-cape': ['east-asia', 'europe'],
  'india-europe': ['south-asia', 'europe'],
  'india-se-asia': ['south-asia', 'east-asia'],
  'china-africa': ['east-asia', 'sub-saharan-africa'],
  'cpec-route': ['south-asia', 'east-asia'],
  'transatlantic': ['north-america', 'europe'],
  'us-west-northeast-asia': ['north-america', 'east-asia'],
  'us-gulf-asia-panama': ['north-america', 'east-asia'],
});

// Persian Gulf littoral states except Oman, whose main ports (Sohar, Duqm,
// Salalah) lie outside the strait.
export const ENCLOSED_CHOKEPOINT_SIDES = Object.freeze({
  hormuz_strait: Object.freeze(new Set(['AE', 'BH', 'IQ', 'IR', 'KW', 'QA', 'SA'])),
});

// Chokepoints plausibly crossed by trade between two countries on the same coast.
const INTRA_REGIONAL_CHOKEPOINTS = Object.freeze({
  med: new Set(['bosphorus', 'gibraltar', 'suez']),
  atlantic: new Set(['panama', 'gibraltar', 'dover_strait', 'cape_of_good_hope']),
  pacific: new Set(['panama', 'malacca_strait', 'taiwan_strait', 'korea_strait', 'lombok_strait']),
  indian: new Set(['malacca_strait', 'bab_el_mandeb', 'hormuz_strait', 'cape_of_good_hope', 'lombok_strait']),
});

function clusterFor(clusters, iso2) {
  const entry = clusters[iso2];
  return entry && typeof entry === 'object' && Array.isArray(entry.nearestRouteIds) ? entry : null;
}

/**
 * @param {string} importerIso2
 * @param {string} exporterIso2
 * @param {{
 *   clusters: Record<string, unknown>,
 *   regions: Record<string, string>,
 *   chokepoints: ReadonlyArray<{ id: string, routeIds: readonly string[] }>,
 * }} context
 * @returns {Map<string, number>} chokepoint id -> fraction (0, 1] of the pair's sea flow crossing it
 */
export function bilateralTransitShares(importerIso2, exporterIso2, { clusters, regions, chokepoints }) {
  const crossed = new Map();
  const importer = clusterFor(clusters, importerIso2);
  const exporter = clusterFor(clusters, exporterIso2);
  if (!importer || !exporter || importerIso2 === exporterIso2) return crossed;
  if (importer.coastSide === 'landlocked' || exporter.coastSide === 'landlocked') return crossed;

  const importerRegion = regions[importerIso2];
  const exporterRegion = regions[exporterIso2];
  // India is an intermediate stop on the Gulf-Asia corridor: its leg ends before Malacca.
  const indiaGulfLeg = (importerIso2 === 'IN' && exporterRegion === 'mena')
    || (exporterIso2 === 'IN' && importerRegion === 'mena');
  const importerRoutes = new Set(importer.nearestRouteIds);
  const routes = new Set(exporter.nearestRouteIds.filter((routeId) => {
    if (!importerRoutes.has(routeId) || (routeId === 'gulf-asia-oil' && indiaGulfLeg)) return false;
    const ends = CORRIDOR_REGIONS[routeId];
    return ends !== undefined && ((importerRegion === ends[0] && exporterRegion === ends[1])
      || (importerRegion === ends[1] && exporterRegion === ends[0]));
  }));

  // Alternative corridors for one pair (Suez vs Panama for China-US East) split the flow evenly.
  const sharedCoast = importer.coastSide === exporter.coastSide ? INTRA_REGIONAL_CHOKEPOINTS[importer.coastSide] : null;
  for (const cp of chokepoints) {
    const inside = ENCLOSED_CHOKEPOINT_SIDES[cp.id];
    const fraction = inside
      ? Number(inside.has(importerIso2) !== inside.has(exporterIso2))
      : (!sharedCoast || sharedCoast.has(cp.id)) ? cp.routeIds.filter((routeId) => routes.has(routeId)).length / routes.size : 0;
    if (fraction > 0) crossed.set(cp.id, fraction);
  }
  return crossed;
}
