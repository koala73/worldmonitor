import { normalizeComtradePartner, quantityUnitAbbr } from '../../scripts/shared/comtrade';
import commodityRegistry from '../../scripts/shared/supply-vulnerability-commodities.json';
import transitHubRegistry from '../../scripts/shared/comtrade-transit-hubs.json';
import { computeSupplierRouteRisk } from './supplier-route-risk';
import type { CommodityBriefCapture, CommodityBriefSelection, CommodityBriefSnapshot } from '../types/decision-brief';
import type { MineralStageSnapshot } from '@/generated/client/worldmonitor/supply_chain/v1/service_client';
import type { DecisionBriefCapture, DecisionBriefSelection, DecisionBriefSnapshot } from '../types/decision-brief';

const nonnegative = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const month = (value: string | undefined): string | null => value && /^\d{4}-(0[1-9]|1[0-2])$/.test(value) ? value : null;

export function buildDecisionBrief(selection: DecisionBriefSelection, captures: [DecisionBriefCapture, DecisionBriefCapture]): DecisionBriefSnapshot {
  const evidence: DecisionBriefSnapshot['evidence'] = [];
  const unknowns = new Set<string>();
  const gas = selection.fuelMode === 'gas';
  const results = captures.map(({ response: r }, index) => {
    const reference = index === 0 ? 'baseline' : 'comparison';
    const severity = index === 0 ? selection.baselinePct : selection.comparisonPct;
    const identity = r.countryCode === selection.countryCode && r.chokepointId === selection.chokepointId && r.disruptionPct === severity;
    const g = r.gasSensitivity;
    const observedAt = gas ? month(g?.dataMonth) : null;
    const usable = identity && (gas
      ? !r.gasImpact && g?.dataAvailable === true && g.modelBasis === 'assumed_route_sensitivity' && nonnegative(g.lngImportsTj) && nonnegative(g.totalDemandTj) && g.totalDemandTj > 0 && nonnegative(g.lngDisruptionTj) && nonnegative(g.deficitPct)
      : r.dataAvailable && r.jodiOilCoverage && nonnegative(r.crudeLossKbd));
    if (!identity) unknowns.add(`${reference}: response does not match the selected country, route and severity.`);
    if (!observedAt) unknowns.add(`${reference}: observation date is unknown.`);
    if (!usable) unknowns.add(gas ? `${reference}: recover recorded LNG imports, positive gas demand and a supported gas model for ${selection.countryCode}.` : `${reference}: recover the oil import and demand baseline for ${selection.countryCode}.`);
    const add = (suffix: string, label: string, value: number | null, unit: string, source: string, date = observedAt) => evidence.push({ id: `${reference}-${suffix}`, label, value, unit, source, sourceUrl: source.startsWith('JODI') ? 'https://www.jodidata.org/' : source === 'GIE' ? 'https://agsi.gie.eu/' : 'https://comtradeplus.un.org/', observedAt: date });
    if (gas) {
      add('lng', 'Recorded LNG imports', identity && g?.dataAvailable && nonnegative(g.lngImportsTj) ? g.lngImportsTj : null, 'TJ', 'JODI');
      add('demand', 'Recorded gas demand', identity && g?.dataAvailable && nonnegative(g.totalDemandTj) && g.totalDemandTj > 0 ? g.totalDemandTj : null, 'TJ', 'JODI');
      if (identity && g?.storage) {
        const s = g.storage;
        add('storage', 'National gas storage (context only)', nonnegative(s.gasTwh) ? s.gasTwh : null, 'TWh', 'GIE', s.date || null);
        unknowns.add('Accessible storage and withdrawal capacity are unknown; storage is excluded from the comparison.');
      }
    } else {
      add('route', 'Comtrade-backed crude route share', usable && r.comtradeCoverage && nonnegative(r.gulfCrudeShare) ? r.gulfCrudeShare * 100 : null, '%', 'UN Comtrade / route model');
      if (identity && !r.comtradeCoverage) unknowns.add(`${reference}: Comtrade route exposure is unavailable; the oil loss model uses a fixed proxy share.`);
    }
    add('loss', gas ? 'Assumed monthly LNG loss' : 'Modeled crude loss', usable ? gas ? g!.lngDisruptionTj : r.crudeLossKbd : null, gas ? 'TJ' : 'kbd', gas ? 'JODI / assumed route sensitivity' : 'JODI / route model');
    if (!r.portwatchCoverage) unknowns.add(`${reference}: shipping traffic is unavailable; no closure is established.`);
    return { reference, severity, loss: usable ? gas ? g!.lngDisruptionTj : r.crudeLossKbd : null, unit: gas ? 'TJ' : 'kbd', demandPct: usable && gas ? g!.deficitPct : null, observedAt };
  });
  const a = captures[0].response.gasSensitivity;
  const b = captures[1].response.gasSensitivity;
  // `a.modelBasis === b.modelBasis` is defence in depth only: a non-null loss implies
  // `usable`, which already pins each capture's modelBasis to the same literal, so this
  // conjunct cannot currently be false. The `dataSource` terms are NOT implied by
  // `usable` and are load-bearing; note the non-empty check reads the baseline capture
  // only, which is why the tests mutate captures[0] and captures[1] separately.
  const comparable = gas && results.every(r => r.loss !== null && r.observedAt !== null) && a && b &&
    a.modelBasis === b.modelBasis && typeof a.dataSource === 'string' && a.dataSource.length > 0 && a.dataSource === b.dataSource && a.dataMonth === b.dataMonth &&
    a.lngImportsTj === b.lngImportsTj && a.totalDemandTj === b.totalDemandTj && a.lngShareOfImports === b.lngShareOfImports;
  const positive = results[0]!.loss !== null && results[0]!.loss! > 0;
  const missing = results[0]!.loss === null;
  const constraint = gas
    ? 'Country-specific supplier and route exposure, available alternative supply, prices and lead times are unknown.'
    : 'Modeled route exposure does not establish available alternative supply, prices or lead times.';
  return {
    selection: { ...selection }, capturedAt: captures[0].retrievedAt > captures[1].retrievedAt ? captures[0].retrievedAt : captures[1].retrievedAt, captures: structuredClone(captures), evidence, results,
    comparison: { delta: comparable ? results[1]!.loss! - results[0]!.loss! : null, reason: comparable ? 'Common country, route, model, observation month, LNG inputs and demand. Storage is context only.' : 'Numeric delta withheld: evidence bases differ or provenance is unknown. Refresh both results and check their observation dates.' },
    assumptions: gas ? [...captures.flatMap(({ response }) => response.countryCode === selection.countryCode && response.chokepointId === selection.chokepointId && response.gasSensitivity?.modelBasis === 'assumed_route_sensitivity' && !response.gasImpact && response.gasSensitivity.assessment ? [response.gasSensitivity.assessment] : []), 'Assumed route sensitivity; the route fraction is fixed by the existing model, not measured country-specific supplier exposure.', 'Monthly sensitivity only. No physical deficit, operational endurance or 14-day forecast is estimated.', 'Shipping traffic and storage do not scale this gas calculation.'] : ['Oil loss uses the existing route model. Observation dates are unavailable; no numeric comparison is supported.'],
    impact: gas ? 'If the assumed route exposure applies, a disruption reduces the modeled portion of recorded monthly LNG imports. The demand ratio is context, not a forecast of unmet demand.' : 'If the modeled crude route exposure applies, disruption reduces modeled crude flow. Actual obligations and substitution remain unverified.',
    action: {
      text: missing ? `Recover ${gas ? 'recorded LNG imports, positive gas demand and the supported model basis' : 'the oil import and demand baseline'} for ${selection.countryName}. Withhold a procurement conclusion until these inputs are available.` : positive ? `Compare ${selection.countryName}'s supply obligations and alternative origins against the modeled loss before considering procurement changes.` : `Verify ${selection.countryName}'s actual route exposure and supply obligations before treating the modeled zero as low risk.`,
      references: gas ? ['baseline-lng', 'baseline-demand', 'baseline-loss'] : ['baseline-route', 'baseline-loss'],
      constraint: missing ? `The baseline is incomplete. ${constraint}` : constraint,
      trigger: missing ? 'Reassess when the named baseline inputs and their observation dates are recovered.' : 'Reassess when updated source observations or verified supplier, route and delivery obligations change the assumed exposure.',
    },
    unknowns: [...unknowns, constraint, 'Retrieval time does not establish freshness. Review each observation date before acting.'],
  };
}

export const COMMODITY_BRIEF_OPTIONS = commodityRegistry.commodities;

/** Reviewed entrepot origins (KTD9); the flag annotates and steers the next action only. */
const TRANSIT_HUBS = new Map(transitHubRegistry.hubs.map(hub => [hub.iso2, hub.label] as const));
const hubName = (iso2: string) => `${TRANSIT_HUBS.get(iso2) ?? iso2} (${iso2})`;

// `shared/source-attribution-manifest.json` records BGS world mineral statistics
// as "attribution required; redistribution restricted", so a BGS-sourced share is
// named but its number is not reprinted in the brief body.
const RESTRICTED_PRODUCTION_SOURCES = new Set(['bgs']);
const PRODUCTION_SOURCE_LABELS: Record<string, string> = { 'usgs-mcs': 'USGS MCS', bgs: 'BGS' };
const productionSourceLabel = (sources: readonly string[]): string =>
  sources.map(source => PRODUCTION_SOURCE_LABELS[source] ?? source).join(', ') || 'an unnamed source';

export function buildCommodityBrief(selection: CommodityBriefSelection, input: CommodityBriefCapture): CommodityBriefSnapshot {
  const commodity = COMMODITY_BRIEF_OPTIONS.find(c => c.id === selection.commodityId);
  if (!commodity) throw new Error('Unsupported commodity selection');
  if (input.products.iso2 !== selection.countryCode || input.vulnerabilities.iso2 !== selection.countryCode) {
    throw new Error('Commodity evidence country does not match selection');
  }
  const capture = structuredClone(input);
  const hs4 = commodity.hs4[0]!;
  const product = capture.products.products.find(p => p.hs4 === hs4);
  const observedAt = product && Number.isInteger(product.year) && product.year >= 1900 && product.year <= 2100 ? String(product.year) : null;
  const evidence: CommodityBriefSnapshot['evidence'] = [];
  const constraints = 'Spare capacity, qualification, price and lead time are unknown. Confirm usable material, transport mode and delivery terms with a qualified supplier.';
  const caveats = [commodity.mappingCaveat,
    'Recorded trade is a customs-heading observation, not a qualified supplier or proof of spare capacity. Shares are by import value, not physical volume.',
    'Routes are geographic models, not observed shipments. Only the selected chokepoint is assumed blocked; other disruptions and transport modes are unknown.',
    'A downstream Suez or Cape option cannot bypass an origin blocked at the Strait of Hormuz.'];
  if (hs4 === '2804') caveats.push('Helium uses the HS 2804 commodity-basket proxy, which includes other gases. It cannot establish a hospital helium supplier share.');
  // A heading recovered on demand carries its own fetch time, and it is the
  // evidence actually shown: the response-level time is the stored catalogue's,
  // which can be absent or a month older than the rows below.
  const sourceFetched = product?.fetchedAt
    ? `${product.fetchedAt} (HS ${hs4} recovered on demand; stored catalogue: ${capture.products.fetchedAt || 'none'})`
    : capture.products.fetchedAt || 'unknown';
  // The cache state and source describe the stored catalogue. A recovered
  // heading came from the public preview instead, so the line names that route
  // first and labels the catalogue's state and source as the catalogue's.
  const cacheState = capture.products.evidence?.state ?? 'legacy_unknown';
  const cacheSource = capture.products.evidence?.source ?? 'UN Comtrade bilateral HS4; retrieval method unknown';
  const recoveredSource = `UN Comtrade public preview (HS ${hs4} recovered on demand)`;
  const cacheLine = !capture.products.evidence?.recoveredHs4s?.includes(hs4)
    ? `Cache state: ${cacheState}. Source: ${cacheSource}.`
    : capture.products.fetchedAt
      ? `Cache state: ${cacheState} (stored catalogue). Source: ${recoveredSource}; stored catalogue: ${cacheSource}.`
      : `Cache state: ${cacheState}. Source: ${recoveredSource}.`;
  const coverage = [
    cacheLine,
    `Source fetched: ${sourceFetched}. Capture retrieved: ${capture.retrievedAt}. Trade observation year: ${observedAt ?? 'unknown'}. Publication lag and fetch age are separate.`,
    `Last refresh attempt: ${capture.products.evidence?.lastAttemptAt || 'unknown'}; result: ${capture.products.evidence?.lastAttemptState || 'unknown'}.`,
  ];
  if (!product) coverage.push(`HS ${hs4}: ${capture.products.evidence?.requestedHs4s.includes(hs4) ? 'requested, but no usable positive rows were returned' : 'requested-heading coverage is missing or unverified'}. Missing data is not zero trade.`);
  // World output for this commodity, joined per origin. `mine` first, `refinery`
  // only when no country carries a mine share -- a refined-stage share answers a
  // different question than a mined-stage one, so the label travels with it.
  const mineralId = commodity.mineralProductionId;
  const productionRecord = mineralId && capture.production && !capture.production.upstreamUnavailable
    ? capture.production.commodities.find(record => record.commodityId === mineralId) : undefined;
  const productionStage: 'mine' | 'refinery' | null = productionRecord?.mine?.countries.length ? 'mine'
    : productionRecord?.refinery?.countries.length ? 'refinery' : null;
  const productionSnapshot = productionStage ? productionRecord?.[productionStage] ?? null : null;
  const productionSources = productionRecord?.sources ?? [];
  const productionSource = productionSourceLabel(productionSources);
  const productionRestricted = productionSources.some(source => RESTRICTED_PRODUCTION_SOURCES.has(source));
  const excluded: string[] = [];
  const seen = new Set<string>();
  const candidates: CommodityBriefSnapshot['candidates'] = [];
  for (const exp of product?.topExporters ?? []) {
    if (!/^[A-Z]{2}$/.test(exp.partnerIso2) || exp.partnerIso2 === selection.countryCode || seen.has(exp.partnerIso2)) {
      const partner = normalizeComtradePartner(exp.partnerCode);
      excluded.push(`${exp.partnerCode} (${partner.label}; ${partner.kind}): ${nonnegative(exp.share) && exp.share <= 1 ? (exp.share * 100).toFixed(1) + '%' : 'unknown share'} excluded from country comparison${seen.has(exp.partnerIso2) ? ' as a duplicate country area; not added to avoid overlapping customs areas' : ''}`);
      continue;
    }
    seen.add(exp.partnerIso2);
    const sharePct = nonnegative(exp.share) && exp.share <= 1 ? exp.share * 100 : null;
    const shareReference = `share-${selection.countryCode}-${hs4}-${exp.partnerIso2}`;
    evidence.push({ id: shareReference, label: `${exp.partnerIso2} recorded share of HS ${hs4} imports`, value: sharePct, unit: '% of import value', source: 'UN Comtrade bilateral HS4', sourceUrl: 'https://comtradeplus.un.org/', observedAt });
    const route = computeSupplierRouteRisk(exp.partnerIso2, selection.countryCode, new Map());
    const affectedChokepoints = route.transitChokepoints.filter(cp => cp.chokepointId === selection.chokepointId).map(cp => cp.chokepointId);
    const routeState = route.routeIds.length === 0 ? 'unknown' : affectedChokepoints.length ? 'exposed' : 'not_on_modeled_route';
    const reason = routeState === 'unknown'
      ? 'No modeled route for this country pair. Validate the transport path before comparing route exposure.'
      : routeState === 'exposed'
        ? 'Modeled route includes the selected blocked chokepoint. A downstream detour does not establish an origin bypass.'
        : 'Selected chokepoint is absent from the modeled path. This supports investigating the origin, not a safe-route or availability conclusion.';
    // Comtrade reports an unmeasured weight or quantity as 0, so a zero here is
    // "not reported" and must not render as a recorded zero shipment (KTD4).
    const netWeightKg = nonnegative(exp.netWeightKg) && exp.netWeightKg > 0 ? exp.netWeightKg : null;
    const quantity = nonnegative(exp.quantity) && exp.quantity > 0 ? exp.quantity : null;
    const scale = exp.scale;
    const producer = productionSnapshot?.countries.find(row => row.iso2 === exp.partnerIso2);
    candidates.push({ origin: exp.partnerIso2, partnerCode: exp.partnerCode, partnerScope: normalizeComtradePartner(exp.partnerCode).note, shareReference, sharePct, routeIds: route.routeIds,
      transitChokepoints: route.transitChokepoints.map(cp => cp.chokepointId), affectedChokepoints, routeState, reason, constraints,
      netWeightKg,
      // Only meaningful beside a weight: an estimate flag with no weight would
      // read as a confirmed zero that happens to be estimated.
      netWeightEstimated: netWeightKg !== null && exp.netWeightEstimated === true,
      quantity,
      quantityUnit: quantity === null ? null : quantityUnitAbbr(exp.quantityUnitCode),
      transitHub: TRANSIT_HUBS.has(exp.partnerIso2),
      scale: scale && nonnegative(scale.worldExportsUsd) ? {
        worldExportsUsd: scale.worldExportsUsd,
        worldExportsKg: nonnegative(scale.worldExportsKg) && scale.worldExportsKg > 0 ? scale.worldExportsKg : null,
        rank: scale.rank, year: scale.year,
        // The population the rank is out of, and the reporters it leaves out.
        reporterCount: nonnegative(scale.reporterCount) && scale.reporterCount > 0 ? scale.reporterCount : null,
        unrankedReporterCount: nonnegative(scale.unrankedReporterCount) ? scale.unrankedReporterCount : null,
      } : null,
      production: producer && productionStage ? {
        // Percent of named producers as published (0-100), deliberately not
        // rescaled to the 0-1 Comtrade import share beside it. A restricted
        // source keeps its attribution and loses its number here, because the
        // snapshot is what the HTML and JSON exports carry.
        sharePct: !productionRestricted && nonnegative(producer.share) ? producer.share : null,
        stage: productionStage, source: productionSource, restricted: productionRestricted,
      } : null });
  }
  // Sorted before the coverage lines so the origins they name appear in the same
  // order the reader meets them in the candidate list.
  const order = { not_on_modeled_route: 0, unknown: 1, exposed: 2 };
  candidates.sort((a, b) => order[a.routeState] - order[b.routeState] || (b.sharePct ?? -1) - (a.sharePct ?? -1) || a.origin.localeCompare(b.origin));
  // "Listed" throughout: these lines count every origin in the brief, which the
  // export prints in full and the in-panel preview only in part.
  const listedShare = candidates.reduce((sum, c) => sum + (c.sharePct ?? 0), 0);
  coverage.push(product ? `Listed origins cover ${listedShare.toFixed(1)}% of the stored import-value denominator. ${Math.max(0, 100 - listedShare).toFixed(1)}% is not represented by listed usable shares (including unlisted origins and excluded or invalid rows; rounded shares). Shares are not renormalized.` : 'Share coverage is unknown: no product denominator is available. Missing data is not zero trade.');
  const hubs = candidates.filter(c => c.transitHub);
  if (product) {
    // The threshold list is padded to 5 and capped at 25, so "every origin at
    // or above 1%" would be false at both ends; the basis states both.
    coverage.push(product.partnerBasis === 'share_threshold'
      ? `Origins listed: partners holding at least 1% of the denominator, padded to 5 and capped at 25 (${candidates.length} listed; ${product.omittedPartnerCount ?? 0} omitted holding ${((product.omittedPartnerShare ?? 0) * 100).toFixed(1)}% combined).`
      : 'Origins listed: the stored leading 5 origins; smaller partners were not retained.');
    if (hubs.length) coverage.push(`Possible transit hubs among listed origins: ${hubs.map(c => hubName(c.origin)).join(', ')}. Recorded exports from a hub can be re-exports rather than origin production, so a hub share does not establish origin capacity.`);
    const worldExportsFetchedAt = capture.products.evidence?.worldExportsFetchedAt;
    // Reporters that have not filed the ranking year are left out of it, which
    // moves every rank below them; the count is stated wherever it is known.
    const unranked = Math.max(0, ...candidates.map(c => c.scale?.unrankedReporterCount ?? 0));
    coverage.push(worldExportsFetchedAt
      ? `Supplier scale: world exports of HS ${hs4} fetched ${worldExportsFetchedAt}; ${candidates.filter(c => c.scale).length} of ${candidates.length} listed origins matched.${unranked > 0 ? ` Ranks count only reporters that filed the ranking year; ${unranked} reporters whose newest HS ${hs4} filing is older are not ranked, so an origin's rank can change when they file.` : ''}`
      : 'Supplier scale unavailable: no world-export snapshot could be joined to these origins (not yet seeded, or unreadable at capture time). Recorded import share alone does not describe an origin\'s size as an exporter.');
    if (mineralId) {
      coverage.push(productionSnapshot && productionStage
        ? `World production: ${productionStage}-stage shares from ${productionSource}, observation year ${productionSnapshot.year || productionRecord?.year || 'unknown'}. Percent of named producers, a different denominator from the import shares above.${productionRestricted ? ' Source terms restrict redistribution, so shares are named but not reprinted.' : ''}`
        : 'Production share unavailable: no mineral-production snapshot is joined to these origins. Missing production data is not absent production.');
    }
  }
  coverage.push(...excluded);
  coverage.push(`Modeled routes: ${candidates.filter(c => c.routeState !== 'unknown').length}/${candidates.length} listed origins. Unknown paths remain unresolved; modeled chokepoints are an unordered set, not a shipment sequence.`);
  // What the origin list can and cannot hold, worded for the basis actually served.
  const originsAvailable = product?.partnerBasis === 'share_threshold'
    ? 'Origins at or above 1% of the denominator are available (at least 5, at most 25); smaller partners are summarised, not listed'
    : 'Only the stored leading origins are available';
  caveats.push(product?.denominatorBasis === 'reported_world'
    ? `Shares use the reported World import total for this heading and observation year. ${originsAvailable}; unreported trade can affect coverage.`
    : product?.denominatorBasis === 'observed_partners'
      ? `Shares use the sum of observed partner values, without a reported World total. ${originsAvailable}; preview limits and unreported trade can affect coverage.`
      : `${originsAvailable}. The stored denominator is not independently verified against a complete World total; preview limits and unreported trade can affect coverage.`);
  // R5: a hub's recorded exports may be someone else's production, so the next
  // action prefers a non-hub origin from the same route-state tier as the leader.
  // The preference never crosses tiers: an origin whose modeled route avoids the
  // blocked chokepoint outranks one with an unknown route for reasons the hub
  // flag does not touch. Falling back to `eligible[0]` keeps a hub nameable when
  // every origin in its tier is flagged -- withholding the action there would
  // read as "no origin available", which is a different claim.
  const eligible = candidates.filter(c => c.routeState !== 'exposed' && c.sharePct !== null && c.sharePct > 0);
  const leadingTier = eligible.filter(c => c.routeState === eligible[0]?.routeState);
  const candidate = leadingTier.find(c => !c.transitHub) ?? eligible[0];
  const skippedHubs = candidate ? leadingTier.slice(0, leadingTier.indexOf(candidate)).filter(c => c.transitHub) : [];
  const hubNote = !candidate ? ''
    : candidate.transitHub
      ? ` Every eligible origin with this route state is flagged a possible transit hub, so ${candidate.origin} is named anyway; its recorded exports may be re-exports rather than origin production.`
      : skippedHubs.length
        ? ` ${skippedHubs.map(c => hubName(c.origin)).join(', ')} ${skippedHubs.length > 1 ? 'hold' : 'holds'} a larger recorded share with the same route state but ${skippedHubs.length > 1 ? 'are' : 'is'} flagged a possible transit hub, so ${skippedHubs.length > 1 ? 'they were' : 'it was'} skipped.`
        : '';
  const vulnerability = !capture.vulnerabilities.upstreamUnavailable
    ? capture.vulnerabilities.vulnerabilities.find(v => v.countryIso2 === selection.countryCode && v.commodityId === commodity.id) : undefined;
  const context = vulnerability
    ? `Commodity vulnerability: ${vulnerability.state}; band: ${vulnerability.band || 'unknown'}. Coverage: ${vulnerability.coverage.join(', ') || 'unknown'}. This context does not establish bilateral supplier shares.`
    : 'Commodity vulnerability context is unavailable for this selection. No zero exposure is inferred.';
  const missing = !product ? `No recorded HS ${hs4} bilateral product evidence is available for ${selection.countryName}.`
    : candidates.length === 0 ? 'No recorded exporter-country rows are available.'
      : candidates.every(c => c.routeState === 'exposed') ? 'Every modeled candidate route includes the selected blocked chokepoint.'
        : 'No positive recorded share supports an alternative origin.';
  const action = candidate ? {
    text: `Validate ${candidate.origin}'s recorded HS ${hs4} basket trade (${commodity.basketLabel}) before investigating ${selection.countryName}'s ${commodity.label} needs. The share is not a commodity-specific supply estimate. ${candidate.reason}${hubNote}`,
    references: [candidate.shareReference], constraint: constraints,
    trigger: `Reassess when ${candidate.origin}'s actual route, usable capacity, qualification, price or delivery date is confirmed, or the recorded trade evidence changes.`,
  } : {
    text: `${missing} Recover the missing bilateral evidence or validate an origin route before a procurement conclusion.`,
    references: evidence.map(e => e.id), constraint: `${missing} ${constraints}`,
    trigger: 'Reassess when positive bilateral supplier evidence and a usable origin route are available, or the selected chokepoint reopens.',
  };
  // The snapshot is what the HTML and JSON exports carry. A restricted
  // production source (BGS) keeps its attribution, year, unit and the derived
  // concentration index, but its per-country rows and world total do not
  // travel into a downloadable file.
  const withoutRows = (stage: MineralStageSnapshot): MineralStageSnapshot => {
    const stripped: MineralStageSnapshot = { ...stage, countries: [] };
    delete stripped.worldTotal;
    return stripped;
  };
  const exportableProduction = capture.production && productionRestricted ? {
    ...capture.production,
    commodities: capture.production.commodities.map(record => record.commodityId !== mineralId ? record : {
      ...record,
      mine: record.mine ? withoutRows(record.mine) : record.mine,
      refinery: record.refinery ? withoutRows(record.refinery) : record.refinery,
    }),
  } : capture.production;
  return { kind: 'commodity', selection: { ...selection }, capturedAt: capture.retrievedAt, commodity: commodity.label, basket: commodity.basketLabel, coverage, hs4,
    capture: { ...capture, production: exportableProduction },
    evidence, candidates, context, caveats,
    ordering: 'Investigation order: selected chokepoint absent from modeled path, unknown route, then exposed route; within each group, descending recorded import-value share. This is not a supplier recommendation score.', action };
}
