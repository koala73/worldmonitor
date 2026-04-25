#!/usr/bin/env node
// Compare current production overall_score (6-domain weighted aggregate)
// against the proposed pillar-combined score with penalty term (α=0.5).
// Produces a JSON artifact with the Spearman correlation, the top-N
// absolute-rank movers, and per-country score deltas so the activation
// decision (flip or keep pending?) has a concrete data point.
//
// Usage: node --import tsx/esm scripts/compare-resilience-current-vs-proposed.mjs > out.json
//
// IMPORTANT: this script must use the SAME pillar aggregation path the
// production API exposes, not a local re-implementation with different
// weighting semantics. We therefore import `buildPillarList` directly
// from `server/worldmonitor/resilience/v1/_pillar-membership.ts` (which
// weights member domains by their average dimension coverage, not by
// their static domain weights) and replicate `_shared.ts#buildDomainList`
// inline so domain scores are produced by the same coverage-weighted
// mean the production scorer uses. Any drift from production here
// invalidates the Spearman / rank-delta conclusions downstream, so if
// production ever changes its aggregation path this script must be
// updated in lockstep.

import { loadEnvFile } from './_seed-utils.mjs';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RESILIENCE_COHORTS } from '../tests/helpers/resilience-cohorts.mts';
import { MATCHED_PAIRS } from '../tests/helpers/resilience-matched-pairs.mts';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), '..');
const SNAPSHOT_DIR = path.join(REPO_ROOT, 'docs', 'snapshots');

loadEnvFile(import.meta.url);

// Scoring and acceptance gates run over the FULL scorable universe
// (listScorableCountries() from _shared.ts) — no curated SAMPLE is
// used. Earlier revisions computed drift / Spearman / cohort / pair
// checks on a 52-country sensitivity seed (+ cohort union); that
// missed regressions in any country outside the seed. RESILIENCE_COHORTS
// and MATCHED_PAIRS are still imported because the cohort/pair
// diagnostic blocks below are naturally scoped to their defined
// memberships, and we use them to report cohortMissingFromScorable
// (any cohort/pair endpoint that listScorableCountries refuses to
// score — fail-loud instead of silent drop).

// Mirrors `_shared.ts#coverageWeightedMean`. Kept local because the
// production helper is not exported. MUST stay in lockstep with
// _shared.ts — including the per-dim weight multiplier introduced in
// PR 2 §3.4 for the recovery-domain rebalance. Without the weight
// application, this harness's Spearman / rank-delta artifacts would
// silently diverge from live API scoring post-rebalance (see the
// RESILIENCE_DIMENSION_WEIGHTS source-of-truth constant).
function coverageWeightedMean(dims, dimensionWeights) {
  let totalWeight = 0;
  let weightedSum = 0;
  for (const d of dims) {
    const w = dimensionWeights[d.id] ?? 1.0;
    const effective = d.coverage * w;
    totalWeight += effective;
    weightedSum += d.score * effective;
  }
  if (!totalWeight) return 0;
  return weightedSum / totalWeight;
}

// Mirrors `_shared.ts#buildDomainList` exactly so the ResilienceDomain
// objects fed to buildPillarList are byte-identical to what production
// emits. The production helper is not exported, so we re-implement it
// here; the implementation MUST stay in lockstep with _shared.ts —
// including the per-dim weight pass-through from
// RESILIENCE_DIMENSION_WEIGHTS (PR 2 §3.4 recovery rebalance).
function buildDomainList(dimensions, dimensionDomains, domainOrder, getDomainWeight, dimensionWeights) {
  const grouped = new Map();
  for (const domainId of domainOrder) grouped.set(domainId, []);
  for (const dim of dimensions) {
    const domainId = dimensionDomains[dim.id];
    grouped.get(domainId)?.push(dim);
  }
  return domainOrder.map((domainId) => {
    const domainDims = grouped.get(domainId) ?? [];
    const domainScore = coverageWeightedMean(domainDims, dimensionWeights);
    return {
      id: domainId,
      score: Math.round(domainScore * 100) / 100,
      weight: getDomainWeight(domainId),
      dimensions: domainDims,
    };
  });
}

function rankCountries(scores) {
  const sorted = Object.entries(scores)
    .sort(([a, scoreA], [b, scoreB]) => scoreB - scoreA || a.localeCompare(b));
  const ranks = {};
  for (let i = 0; i < sorted.length; i++) {
    ranks[sorted[i][0]] = i + 1;
  }
  return ranks;
}

// Auto-discover the immediate-prior baseline snapshot so scorer PRs
// can compare against a LOCKED BEFORE-STATE (acceptance gates 2 + 6 + 7)
// rather than against the in-process proposed formula.
//
// Filename conventions:
//   resilience-ranking-live-pre-repair-<YYYY-MM-DD>.json     (PR 0 freeze)
//   resilience-ranking-live-post-pr<N>-<YYYY-MM-DD>.json     (each scorer PR's landing snapshot)
//
// Ordering MUST parse out both the PR number and the date, NOT plain
// filename sort. Plain sort breaks in two ways:
//   1. Lexical ordering: 'pre' > 'post' alphabetically (`pr...` → 'r' > 'o'),
//      so `live-pre-repair-2026-04-22` sorts AFTER `live-post-pr1-2026-05-01`,
//      which means the pre-repair freeze would keep winning even after
//      post-PR snapshots land.
//   2. Lexical ordering: `pr10` < `pr9` (digit-by-digit), so the PR-10
//      snapshot would lose to the PR-9 snapshot.
//
// Fix: sort keys are (kind rank desc, prNumber desc, date desc), where
// kind is `post` (newer than any pre-repair) over `pre-repair`. Among
// posts, higher PR number wins on numeric comparison; ties broken by
// date. Returns null if no baseline is present.
function parseBaselineSnapshotMeta(filename) {
  const preMatch = /^resilience-ranking-live-pre-repair-(\d{4}-\d{2}-\d{2})\.json$/.exec(filename);
  if (preMatch) {
    // kindRank 0 ensures any `post-*` snapshot supersedes every
    // `pre-repair-*` freeze regardless of date.
    return { filename, kind: 'pre-repair', kindRank: 0, prNumber: -1, date: preMatch[1] };
  }
  const postMatch = /^resilience-ranking-live-post-(.+?)-(\d{4}-\d{2}-\d{2})\.json$/.exec(filename);
  if (postMatch) {
    const [, tag, date] = postMatch;
    const prMatch = /^pr(\d+)$/i.exec(tag);
    // Unrecognised `post-<tag>` → prNumber 0 so it ranks between
    // pre-repair and any numbered post-PR snapshot. Better than
    // silently winning or silently losing; the tag is still printed
    // back in `baselineFile` so the operator can spot it.
    return { filename, kind: 'post', kindRank: 1, prNumber: prMatch ? Number(prMatch[1]) : 0, date, tag };
  }
  return null;
}

function loadMostRecentBaselineSnapshot() {
  if (!existsSync(SNAPSHOT_DIR)) return null;
  let entries;
  try {
    entries = readdirSync(SNAPSHOT_DIR);
  } catch {
    return null;
  }
  const candidates = entries
    .map(parseBaselineSnapshotMeta)
    .filter((m) => m != null)
    .sort((a, b) => {
      if (a.kindRank !== b.kindRank) return b.kindRank - a.kindRank;
      if (a.prNumber !== b.prNumber) return b.prNumber - a.prNumber;
      return b.date.localeCompare(a.date);
    });
  if (candidates.length === 0) return null;
  const latest = candidates[0];
  const raw = readFileSync(path.join(SNAPSHOT_DIR, latest.filename), 'utf8');
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed.items)) return null;
  return {
    filename: latest.filename,
    kind: latest.kind,
    prNumber: latest.prNumber,
    date: latest.date,
    capturedAt: parsed.capturedAt,
    commitSha: parsed.commitSha,
    scoresByCountry: Object.fromEntries(
      parsed.items.map((item) => [item.countryCode, item.overallScore]),
    ),
    greyedOutCountries: new Set((parsed.greyedOut ?? []).map((g) => g.countryCode)),
  };
}

function spearmanCorrelation(ranksA, ranksB) {
  const keys = Object.keys(ranksA).filter((k) => k in ranksB);
  const n = keys.length;
  if (n < 2) return 1;
  const dSqSum = keys.reduce((s, k) => s + (ranksA[k] - ranksB[k]) ** 2, 0);
  return 1 - (6 * dSqSum) / (n * (n * n - 1));
}

// Per-indicator extraction registry. Acceptance gate 8 in the plan
// requires effective-influence-by-INDICATOR (not by dimension) across
// the scorer. The registry below is built from INDICATOR_REGISTRY at
// runtime: every entry in INDICATOR_REGISTRY gets a row here with an
// explicit extractionStatus, so indicators that cannot be deterministi-
// cally extracted from raw Redis (event-window aggregates, Monte-Carlo
// style summaries, etc.) are NOT silently omitted — they appear in
// `perIndicatorInfluence[]` with `extractionStatus: 'not-implemented'`
// and a reason string. This keeps the acceptance apparatus honest:
// later PRs can see exactly which indicators are covered, which are
// gaps, and which ones they need to instrument in scorer trace hooks.
//
// Shape families covered deterministically (extractionStatus:
// 'implemented'):
//
//   A) resilience:static:{ISO2} + dotted sub-path (WB code / WGI /
//      WHO / FAO / GPI / RSF / IEA / tradeToGdp / fxReservesMonths /
//      appliedTariffRate)
//   B) energy:mix:v1:{ISO2} scalar field
//   C) energy:gas-storage:v1:{ISO2} scalar field
//   D) resilience:recovery:<name>:v1 bulk key, .countries[ISO2].<field>
//   E) economic:imf:macro:v2 bulk key, .countries[ISO2].<field>
//   F) economic:imf:labor:v1 bulk key, .countries[ISO2].<field>
//   G) economic:national-debt:v1 bulk key, .countries[ISO2].<field>
//
// Indicators whose source key is an aggregate-event stream (UCDP
// events, unrest events, cyber threats, GPS jamming hexes, internet
// outages, displacement summary, supply-chain shipping / transit
// stress, trade restrictions / barriers, sanctions counts, energy
// price stress, social Reddit, BIS DSR / EER, news threat summary)
// cannot be deterministically reduced to a single per-country scalar
// without re-running the scorer's own windowing / severity-weighting
// math, which would duplicate production logic and drift. These are
// marked `extractionStatus: 'not-implemented'` with a reason; later
// PRs can either expose a scorer trace hook, or add dedicated
// extractors here if the aggregation is simple enough to safely
// duplicate.
//
// EXTRACTION_RULES is keyed by the registry's indicator `id` field, so
// adding a new indicator to INDICATOR_REGISTRY flags this table via
// the "unregistered indicator" branch in buildIndicatorExtractionPlan.

// The rules below use exported scorer helpers wherever the indicator
// is an event-window aggregate or needs per-country name matching.
// This avoids duplicating scorer math in the harness — any drift
// between harness and scorer is impossible by construction.
//
// Three Core indicators remain `not-implemented` for structural
// reasons (NOT missing code — the scorer inputs are genuinely global
// scalars with no per-country variance to correlate):
//   - shippingStress: scorer reads a global stressScore and combines
//     it with each country's tradeExposure. The raw indicator has
//     zero per-country variance; Pearson(indicator, overall) is 0/NaN.
//   - transitDisruption: scorer takes `mean(...)` across all transit
//     corridor summaries → single global scalar with the same
//     no-variance problem.
//   - energyPriceStress: scorer reads a global mean absolute price
//     change across commodities → same no-variance problem.
// These three are per-country ONLY via trade/energy exposure ratios,
// which is a derived signal (in a different indicator entirely).
//
// Two more (fxVolatility, fxDeviation) remain unimplemented because
// they need monthly time-series math on BIS REER series that the
// harness shouldn't duplicate without a helper export.

const EXTRACTION_RULES = {
  // ── macroFiscal ─────────────────────────────────────────────────────
  govRevenuePct: { type: 'imf-macro-country-field', field: 'govRevenuePct' },
  debtGrowthRate: { type: 'national-debt', field: 'annualGrowth' },
  currentAccountPct: { type: 'imf-macro-country-field', field: 'currentAccountPct' },
  unemploymentPct: { type: 'imf-labor-country-field', field: 'unemploymentPct' },
  householdDebtService: { type: 'not-implemented', reason: 'BIS DSR curated series needs per-country quarterly DSR selection matching the scorer window' },

  // ── currencyExternal ────────────────────────────────────────────────
  // PR 3 §3.5: BIS retired from core; inflationStability (IMF macro) is
  // the new primary with reserves secondary. fxVolatility/fxDeviation
  // stay experimental-only (BIS monthly-change math not exported).
  inflationStability: { type: 'imf-macro-country-field', field: 'inflationPct' },
  fxReservesAdequacy: { type: 'static-path', path: ['fxReservesMonths', 'months'] },
  fxVolatility: { type: 'not-implemented', reason: 'BIS REER annualized volatility needs scorer monthly-change std-dev; helper not exported' },
  fxDeviation: { type: 'not-implemented', reason: 'BIS REER absolute deviation from 100 needs scorer latest-value selection; helper not exported' },

  // ── tradePolicy (renamed from tradeSanctions in plan 2026-04-25-004 Ship 1) ──
  // sanctionCount indicator dropped — OFAC component removed from formula.
  tradeRestrictions: { type: 'count-trade-restrictions' },
  tradeBarriers: { type: 'count-trade-barriers' },
  appliedTariffRate: { type: 'static-path', path: ['appliedTariffRate', 'value'] },

  // ── cyberDigital (scorer-aggregated event streams) ──────────────────
  cyberThreats: { type: 'summarize-cyber' },
  internetOutages: { type: 'summarize-outages-penalty' },
  gpsJamming: { type: 'summarize-gps-penalty' },

  // ── logisticsSupply ─────────────────────────────────────────────────
  roadsPavedLogistics: { type: 'static-wb-infrastructure', code: 'IS.ROD.PAVE.ZS' },
  shippingStress: { type: 'not-implemented', reason: 'Scorer input is a global stressScore applied to every country; no per-country variance to correlate' },
  transitDisruption: { type: 'not-implemented', reason: 'Scorer input is a global mean across transit corridor summaries; no per-country variance' },

  // ── infrastructure ──────────────────────────────────────────────────
  electricityAccess: { type: 'static-wb-infrastructure', code: 'EG.ELC.ACCS.ZS' },
  roadsPavedInfra: { type: 'static-wb-infrastructure', code: 'IS.ROD.PAVE.ZS' },
  infraOutages: { type: 'summarize-outages-penalty' },

  // ── energy ──────────────────────────────────────────────────────────
  energyImportDependency: { type: 'static-path', path: ['iea', 'energyImportDependency', 'value'] },
  gasShare: { type: 'energy-mix-field', field: 'gasShare' },
  coalShare: { type: 'energy-mix-field', field: 'coalShare' },
  renewShare: { type: 'energy-mix-field', field: 'renewShare' },
  gasStorageStress: { type: 'gas-storage-field', field: 'fillPct' },
  energyPriceStress: { type: 'not-implemented', reason: 'Scorer input is a global mean across commodity price changes; no per-country variance' },
  electricityConsumption: { type: 'static-wb-infrastructure', code: 'EG.USE.ELEC.KH.PC' },
  // PR 1 v2 energy indicators — `tier: 'experimental'` until seeders
  // land. The extractor reads the same bulk-payload shape the scorer
  // reads: { countries: { [ISO2]: { value, year } } }. When seed is
  // absent the pairedSampleSize drops to 0 and Pearson returns 0,
  // surfacing the "no influence yet" state in the harness output.
  // importedFossilDependence is a SCORER-LEVEL COMPOSITE, not a direct
  // seed-key read: scoreEnergyV2 computes
  //   fossilElectricityShare × max(netImports, 0) / 100
  // where netImports is staticRecord.iea.energyImportDependency.value.
  // Measuring only fossilShare underreports effective influence for
  // net importers (whose composite is modulated by netImports) and
  // zeros out the signal entirely for net exporters. The extractor
  // therefore has to recompute the same composite; the shape family
  // below reads BOTH inputs per country and applies the same math.
  importedFossilDependence: { type: 'imported-fossil-dependence-composite' },
  lowCarbonGenerationShare: { type: 'bulk-v1-country-value', key: 'resilience:low-carbon-generation:v1' },
  powerLossesPct: { type: 'bulk-v1-country-value', key: 'resilience:power-losses:v1' },
  // reserveMarginPct deferred per plan §3.1 — no seeder, no registry
  // entry. Add here when the IEA electricity-balance seeder lands.

  // ── governanceInstitutional (all 6 WGI sub-pillars) ─────────────────
  wgiVoiceAccountability: { type: 'static-wgi', code: 'VA.EST' },
  wgiPoliticalStability: { type: 'static-wgi', code: 'PV.EST' },
  wgiGovernmentEffectiveness: { type: 'static-wgi', code: 'GE.EST' },
  wgiRegulatoryQuality: { type: 'static-wgi', code: 'RQ.EST' },
  wgiRuleOfLaw: { type: 'static-wgi', code: 'RL.EST' },
  wgiControlOfCorruption: { type: 'static-wgi', code: 'CC.EST' },

  // ── socialCohesion ──────────────────────────────────────────────────
  gpiScore: { type: 'static-path', path: ['gpi', 'score'] },
  displacementTotal: { type: 'displacement-field', field: 'totalDisplaced' },
  displacementHosted: { type: 'displacement-field', field: 'hostTotal' },
  unrestEvents: { type: 'summarize-unrest' },

  // ── borderSecurity / stateContinuity conflict-events (event-window) ─
  ucdpConflict: { type: 'summarize-ucdp' },

  // ── informationCognitive ────────────────────────────────────────────
  rsfPressFreedom: { type: 'static-path', path: ['rsf', 'score'] },
  socialVelocity: { type: 'summarize-social-velocity' },
  newsThreatScore: { type: 'news-threat-score' },

  // ── healthPublicService ─────────────────────────────────────────────
  hospitalBeds: { type: 'static-who', code: 'hospitalBeds' },
  uhcIndex: { type: 'static-who', code: 'uhcIndex' },
  measlesCoverage: { type: 'static-who', code: 'measlesCoverage' },

  // ── foodWater ───────────────────────────────────────────────────────
  ipcPeopleInCrisis: { type: 'static-path', path: ['fao', 'peopleInCrisis'] },
  ipcPhase: { type: 'static-path', path: ['fao', 'phase'] },
  // AQUASTAT: both indicators share `.aquastat.value` but the scorer
  // splits them by the `.aquastat.indicator` tag keyword. The harness
  // matches the same branching so each row correlates only against
  // countries whose AQUASTAT entry is in the matching family —
  // otherwise availability-country readings would corrupt the stress
  // Pearson (and vice versa).
  aquastatWaterStress: { type: 'static-aquastat-stress' },
  aquastatWaterAvailability: { type: 'static-aquastat-availability' },

  // ── recovery* (seeded bulk keys, deterministic per-country fields) ──
  recoveryGovRevenue: { type: 'recovery-country-field', key: 'resilience:recovery:fiscal-space:v1', field: 'govRevenuePct' },
  recoveryFiscalBalance: { type: 'recovery-country-field', key: 'resilience:recovery:fiscal-space:v1', field: 'fiscalBalancePct' },
  recoveryDebtToGdp: { type: 'recovery-country-field', key: 'resilience:recovery:fiscal-space:v1', field: 'debtToGdpPct' },
  recoveryReserveMonths: { type: 'recovery-country-field', key: 'resilience:recovery:reserve-adequacy:v1', field: 'reserveMonths' },
  // PR 2 §3.4: replacement for recoveryReserveMonths at the tighter 1..12
  // anchor. Same seed key + field; the harness extracts the same value
  // and the scorer applies the new goalpost.
  recoveryLiquidReserveMonths: { type: 'recovery-country-field', key: 'resilience:recovery:reserve-adequacy:v1', field: 'reserveMonths' },
  recoveryDebtToReserves: { type: 'recovery-country-field', key: 'resilience:recovery:external-debt:v1', field: 'debtToReservesRatio' },
  recoveryImportHhi: { type: 'recovery-country-field', key: 'resilience:recovery:import-hhi:v1', field: 'hhi' },
  recoveryFuelStockDays: { type: 'recovery-country-field', key: 'resilience:recovery:fuel-stocks:v1', field: 'stockDays' },
  // PR 2 §3.4: SWF seed. Field is totalEffectiveMonths (pre-haircut sum
  // across a country's manifest funds). Countries without a manifest
  // entry score 0 via the substantive-no-SWF branch in the scorer;
  // the harness treats "absent from payload" as 0 for correlation math.
  recoverySovereignWealthEffectiveMonths: { type: 'recovery-country-field', key: 'resilience:recovery:sovereign-wealth:v1', field: 'totalEffectiveMonths' },

  // ── stateContinuity derived signals ─────────────────────────────────
  recoveryWgiContinuity: { type: 'static-wgi-mean' },
  recoveryConflictPressure: { type: 'summarize-ucdp' },
  recoveryDisplacementVelocity: { type: 'displacement-field', field: 'totalDisplaced' },
};

// Shape-family dispatch tables. Each extractor takes (rule, sources,
// countryCode, scorerHelpers) and returns a number or null. Splitting
// the dispatcher this way keeps each function's cyclomatic complexity
// below the biome ceiling (the original monolithic switch exceeded it).

// AQUASTAT `.aquastat.value` is a single field whose MEANING is carried
// by the sibling `.aquastat.indicator` tag. scoreAquastatValue() in
// _dimension-scorers.ts branches the interpretation: stress-family
// keywords → lowerBetter, availability-family keywords → higherBetter.
// To match the scorer's classification exactly, the harness gates
// extraction on the same keyword set, lowercased to match the scorer's
// normalizeCountryToken path (which lowercases + strips punctuation
// before the includes() calls at L770-776).
const AQUASTAT_STRESS_KEYWORDS = ['stress', 'withdrawal', 'dependency'];
const AQUASTAT_AVAILABILITY_KEYWORDS = ['availability', 'renewable', 'access'];

// Classify the AQUASTAT entry by the scorer's EXACT priority order:
// stress-family first, then availability-family, then 'unknown'. This
// mirrors the sequential `if` checks in scoreAquastatValue() so a tag
// like "stress (withdrawal/availability)" routes to stress, not to
// availability (even though the tag string contains both keywords).
function classifyAquastatFamily(staticRecord) {
  const raw = staticRecord?.aquastat?.indicator;
  if (typeof raw !== 'string') return 'unknown';
  const normalized = raw.toLowerCase();
  if (AQUASTAT_STRESS_KEYWORDS.some((kw) => normalized.includes(kw))) return 'stress';
  if (AQUASTAT_AVAILABILITY_KEYWORDS.some((kw) => normalized.includes(kw))) return 'availability';
  return 'unknown';
}

const STATIC_EXTRACTORS = {
  'static-path': (rule, { staticRecord }) => {
    let cursor = staticRecord;
    for (const k of rule.path) cursor = cursor?.[k];
    return typeof cursor === 'number' ? cursor : null;
  },
  'static-wb-infrastructure': (rule, { staticRecord }) =>
    staticRecord?.infrastructure?.indicators?.[rule.code]?.value ?? null,
  'static-wgi': (rule, { staticRecord }) =>
    staticRecord?.wgi?.indicators?.[rule.code]?.value ?? null,
  'static-wgi-mean': (_rule, { staticRecord }) => {
    const entries = Object.values(staticRecord?.wgi?.indicators ?? {})
      .map((e) => (typeof e?.value === 'number' ? e.value : null))
      .filter((v) => v != null);
    if (entries.length === 0) return null;
    return entries.reduce((s, v) => s + v, 0) / entries.length;
  },
  'static-who': (rule, { staticRecord }) =>
    staticRecord?.who?.indicators?.[rule.code]?.value ?? null,
  'static-aquastat-stress': (_rule, { staticRecord }) => {
    const value = staticRecord?.aquastat?.value;
    if (typeof value !== 'number') return null;
    return classifyAquastatFamily(staticRecord) === 'stress' ? value : null;
  },
  'static-aquastat-availability': (_rule, { staticRecord }) => {
    const value = staticRecord?.aquastat?.value;
    if (typeof value !== 'number') return null;
    return classifyAquastatFamily(staticRecord) === 'availability' ? value : null;
  },
};

const SIMPLE_EXTRACTORS = {
  'energy-mix-field': (rule, { energyMix }) =>
    typeof energyMix?.[rule.field] === 'number' ? energyMix[rule.field] : null,
  'gas-storage-field': (rule, { gasStorage }) =>
    typeof gasStorage?.[rule.field] === 'number' ? gasStorage[rule.field] : null,
  'recovery-country-field': (rule, sources, countryCode) => {
    const bulkByKey = {
      'resilience:recovery:fiscal-space:v1': sources.fiscalSpace,
      'resilience:recovery:reserve-adequacy:v1': sources.reserveAdequacy,
      'resilience:recovery:external-debt:v1': sources.externalDebt,
      'resilience:recovery:import-hhi:v1': sources.importHhi,
      'resilience:recovery:fuel-stocks:v1': sources.fuelStocks,
    };
    const entry = bulkByKey[rule.key]?.countries?.[countryCode];
    return typeof entry?.[rule.field] === 'number' ? entry[rule.field] : null;
  },
  'imf-macro-country-field': (rule, { imfMacro }, countryCode) => {
    const entry = imfMacro?.countries?.[countryCode];
    return typeof entry?.[rule.field] === 'number' ? entry[rule.field] : null;
  },
  'imf-labor-country-field': (rule, { imfLabor }, countryCode) => {
    const entry = imfLabor?.countries?.[countryCode];
    return typeof entry?.[rule.field] === 'number' ? entry[rule.field] : null;
  },
  'national-debt': (rule, { nationalDebt }, countryCode) => {
    if (!Array.isArray(nationalDebt)) return null;
    const found = nationalDebt.find(
      (e) => e?.iso2 === countryCode || e?.countryCode === countryCode,
    );
    return typeof found?.[rule.field] === 'number' ? found[rule.field] : null;
  },
  'sanctions-count': (_rule, { sanctionsCounts }, countryCode) => {
    const direct = sanctionsCounts?.[countryCode];
    return typeof direct === 'number' ? direct : null;
  },
  // Shape: { countries: { [ISO2]: { value, year } } }. Used by the
  // PR 1 v2 energy seeders. The key is specified per-rule so the
  // dispatcher can route multiple bulk-v1 payloads through one
  // extractor.
  'bulk-v1-country-value': (rule, { bulkV1 }, countryCode) => {
    const payload = bulkV1?.[rule.key];
    const entry = payload?.countries?.[countryCode];
    return typeof entry?.value === 'number' ? entry.value : null;
  },
  // Mirrors scoreEnergyV2's `importedFossilDependence` composite:
  //   fossilElectricityShare × max(netImports, 0) / 100
  // fossilElectricityShare lives in the PR 1 bulk key; netImports
  // reuses the legacy resilience:static.iea.energyImportDependency.value
  // (EG.IMP.CONS.ZS) that the static seeder already publishes. This
  // extractor MUST stay in lockstep with the scorer — drift between
  // the two breaks gate-9's effective-influence interpretation.
  'imported-fossil-dependence-composite': (_rule, { staticRecord, bulkV1 }, countryCode) => {
    const fossilPayload = bulkV1?.['resilience:fossil-electricity-share:v1'];
    const fossilEntry = fossilPayload?.countries?.[countryCode];
    const fossilShare = typeof fossilEntry?.value === 'number' ? fossilEntry.value : null;
    const netImports = typeof staticRecord?.iea?.energyImportDependency?.value === 'number'
      ? staticRecord.iea.energyImportDependency.value
      : null;
    if (fossilShare == null || netImports == null) return null;
    return fossilShare * Math.max(netImports, 0) / 100;
  },
};

// Aggregator extractors wire through exported scorer helpers so the
// per-country aggregation math never drifts between harness + scorer.
function extractSummarizeCyber(_rule, { cyber }, countryCode, { summarizeCyber }) {
  if (!summarizeCyber || cyber == null) return null;
  const { weightedCount } = summarizeCyber(cyber, countryCode);
  return weightedCount > 0 ? weightedCount : null;
}
function extractOutagesPenalty(_rule, { outages }, countryCode, { summarizeOutages }) {
  if (!summarizeOutages || outages == null) return null;
  const { total, major, partial } = summarizeOutages(outages, countryCode);
  const penalty = total * 4 + major * 2 + partial;
  return penalty > 0 ? penalty : null;
}
function extractGpsPenalty(_rule, { gps }, countryCode, { summarizeGps }) {
  if (!summarizeGps || gps == null) return null;
  const { high, medium } = summarizeGps(gps, countryCode);
  const penalty = high * 3 + medium;
  return penalty > 0 ? penalty : null;
}
function extractSummarizeUcdp(_rule, { ucdp }, countryCode, { summarizeUcdp }) {
  if (!summarizeUcdp || ucdp == null) return null;
  const { eventCount } = summarizeUcdp(ucdp, countryCode);
  return eventCount > 0 ? eventCount : null;
}
function extractSummarizeUnrest(_rule, { unrest }, countryCode, { summarizeUnrest }) {
  if (!summarizeUnrest || unrest == null) return null;
  const { unrestCount } = summarizeUnrest(unrest, countryCode);
  return unrestCount > 0 ? unrestCount : null;
}
function extractSocialVelocity(_rule, { socialVelocity }, countryCode, { summarizeSocialVelocity }) {
  if (!summarizeSocialVelocity || socialVelocity == null) return null;
  const v = summarizeSocialVelocity(socialVelocity, countryCode);
  return v > 0 ? v : null;
}
function extractDisplacementField(rule, { displacement }, countryCode, { getCountryDisplacement }) {
  if (!getCountryDisplacement || displacement == null) return null;
  const entry = getCountryDisplacement(displacement, countryCode);
  return typeof entry?.[rule.field] === 'number' ? entry[rule.field] : null;
}
function extractNewsThreat(_rule, { newsThreat }, countryCode, { getThreatSummaryScore }) {
  if (!getThreatSummaryScore || newsThreat == null) return null;
  return getThreatSummaryScore(newsThreat, countryCode);
}
function extractTradeRestrictions(_rule, { tradeRestrictions }, countryCode, { countTradeRestrictions }) {
  if (!countTradeRestrictions || tradeRestrictions == null) return null;
  const count = countTradeRestrictions(tradeRestrictions, countryCode);
  return count > 0 ? count : null;
}
function extractTradeBarriers(_rule, { tradeBarriers }, countryCode, { countTradeBarriers }) {
  if (!countTradeBarriers || tradeBarriers == null) return null;
  const count = countTradeBarriers(tradeBarriers, countryCode);
  return count > 0 ? count : null;
}

const AGGREGATE_EXTRACTORS = {
  'summarize-cyber': extractSummarizeCyber,
  'summarize-outages-penalty': extractOutagesPenalty,
  'summarize-gps-penalty': extractGpsPenalty,
  'summarize-ucdp': extractSummarizeUcdp,
  'summarize-unrest': extractSummarizeUnrest,
  'summarize-social-velocity': extractSocialVelocity,
  'displacement-field': extractDisplacementField,
  'news-threat-score': extractNewsThreat,
  'count-trade-restrictions': extractTradeRestrictions,
  'count-trade-barriers': extractTradeBarriers,
};

function applyExtractionRule(rule, sources, countryCode, scorerHelpers = {}) {
  if (!rule || rule.type === 'not-implemented') return null;
  const staticFn = STATIC_EXTRACTORS[rule.type];
  if (staticFn) return staticFn(rule, sources, countryCode);
  const simpleFn = SIMPLE_EXTRACTORS[rule.type];
  if (simpleFn) return simpleFn(rule, sources, countryCode);
  const aggFn = AGGREGATE_EXTRACTORS[rule.type];
  if (aggFn) return aggFn(rule, sources, countryCode, scorerHelpers);
  return null;
}

async function readExtractionSources(countryCode, reader) {
  // Displacement summary is year-scoped — the scorer reads the current
  // calendar year (see _dimension-scorers#scoreSocialCohesion). We use
  // the same resolver so the harness pulls the same payload the scorer
  // would at the moment of execution.
  const currentYear = new Date().getFullYear();
  // PR 1 v2 energy bulk keys. Fetched once per country (the memoized
  // reader de-dupes; these bulk payloads aren't country-scoped in the
  // key, so all 220 country iterations share one fetch per key.)
  const BULK_V1_KEYS = [
    'resilience:fossil-electricity-share:v1',
    'resilience:low-carbon-generation:v1',
    'resilience:power-losses:v1',
    // resilience:reserve-margin:v1 intentionally omitted — no seeder,
    // no registry entry, per plan §3.1 deferral. Add when the IEA
    // electricity-balance seeder lands.
  ];
  const [
    staticRecord, energyMix, gasStorage, fiscalSpace, reserveAdequacy,
    externalDebt, importHhi, fuelStocks, imfMacro, imfLabor,
    nationalDebt, sanctionsCounts,
    cyber, outages, gps, ucdp, unrest, newsThreat, displacement,
    socialVelocity, tradeRestrictions, tradeBarriers,
    ...bulkV1Payloads
  ] = await Promise.all([
    reader(`resilience:static:${countryCode}`),
    reader(`energy:mix:v1:${countryCode}`),
    reader(`energy:gas-storage:v1:${countryCode}`),
    reader('resilience:recovery:fiscal-space:v1'),
    reader('resilience:recovery:reserve-adequacy:v1'),
    reader('resilience:recovery:external-debt:v1'),
    reader('resilience:recovery:import-hhi:v1'),
    reader('resilience:recovery:fuel-stocks:v1'),
    reader('economic:imf:macro:v2'),
    reader('economic:imf:labor:v1'),
    reader('economic:national-debt:v1'),
    reader('sanctions:country-counts:v1'),
    reader('cyber:threats:v2'),
    reader('infra:outages:v1'),
    reader('intelligence:gpsjam:v2'),
    reader('conflict:ucdp-events:v1'),
    reader('unrest:events:v1'),
    reader('news:threat:summary:v1'),
    reader(`displacement:summary:v1:${currentYear}`),
    reader('intelligence:social:reddit:v1'),
    reader('trade:restrictions:v1:tariff-overview:50'),
    reader('trade:barriers:v1:tariff-gap:50'),
    ...BULK_V1_KEYS.map((k) => reader(k)),
  ]);
  const bulkV1 = Object.fromEntries(BULK_V1_KEYS.map((k, i) => [k, bulkV1Payloads[i]]));
  return {
    staticRecord, energyMix, gasStorage, fiscalSpace, reserveAdequacy,
    externalDebt, importHhi, fuelStocks, imfMacro, imfLabor,
    nationalDebt, sanctionsCounts,
    cyber, outages, gps, ucdp, unrest, newsThreat, displacement,
    socialVelocity, tradeRestrictions, tradeBarriers,
    bulkV1,
  };
}

// Build the full extraction plan at startup: every entry in
// INDICATOR_REGISTRY becomes a row in the plan, with status derived
// from EXTRACTION_RULES. Any indicator present in the registry but
// missing from EXTRACTION_RULES is flagged as `unregistered-in-harness`
// so future registry additions can't silently skip influence reporting.
function buildIndicatorExtractionPlan(indicatorRegistry) {
  return indicatorRegistry.map((spec) => {
    const rule = EXTRACTION_RULES[spec.id];
    if (!rule) {
      return {
        indicator: spec.id,
        dimension: spec.dimension,
        tier: spec.tier,
        nominalWeight: spec.weight,
        extractionStatus: 'unregistered-in-harness',
        reason: 'Indicator exists in INDICATOR_REGISTRY but has no EXTRACTION_RULES entry; add one or explicitly mark not-implemented',
      };
    }
    if (rule.type === 'not-implemented') {
      return {
        indicator: spec.id,
        dimension: spec.dimension,
        tier: spec.tier,
        nominalWeight: spec.weight,
        extractionStatus: 'not-implemented',
        reason: rule.reason,
      };
    }
    return {
      indicator: spec.id,
      dimension: spec.dimension,
      tier: spec.tier,
      nominalWeight: spec.weight,
      extractionStatus: 'implemented',
      rule,
    };
  });
}

// Pearson correlation across two equal-length arrays. Used for
// variable-influence baseline per acceptance gate 8 in the v3 plan.
function pearsonCorrelation(xs, ys) {
  const n = xs.length;
  if (n < 2) return 0;
  const meanX = xs.reduce((s, v) => s + v, 0) / n;
  const meanY = ys.reduce((s, v) => s + v, 0) / n;
  let num = 0, denomX = 0, denomY = 0;
  for (let i = 0; i < n; i += 1) {
    const dx = xs[i] - meanX;
    const dy = ys[i] - meanY;
    num += dx * dy;
    denomX += dx * dx;
    denomY += dy * dy;
  }
  const denom = Math.sqrt(denomX * denomY);
  return denom > 0 ? num / denom : 0;
}

async function main() {
  const scorerMod = await import('../server/worldmonitor/resilience/v1/_dimension-scorers.ts');
  const {
    scoreAllDimensions,
    RESILIENCE_DIMENSION_ORDER,
    RESILIENCE_DIMENSION_DOMAINS,
    // PR 2 §3.4 recovery-domain rebalance: per-dim weights applied
    // inside coverageWeightedMean so the harness's domain scores,
    // overall score, and Spearman / rank-delta artifacts track live
    // scoring after the rebalance. Missing entries default to 1.0 in
    // the mirror functions above (same as production), so this import
    // is authoritative if present and forward-compatible if a future
    // refactor renames / removes the constant.
    RESILIENCE_DIMENSION_WEIGHTS,
    getResilienceDomainWeight,
    RESILIENCE_DOMAIN_ORDER,
    createMemoizedSeedReader,
    // Scorer helpers passed through to applyExtractionRule so per-
    // indicator aggregation uses the scorer's own math (zero drift).
    summarizeCyber,
    summarizeOutages,
    summarizeGps,
    summarizeUcdp,
    summarizeUnrest,
    summarizeSocialVelocity,
    getCountryDisplacement,
    getThreatSummaryScore,
    countTradeRestrictions,
    countTradeBarriers,
  } = scorerMod;
  const scorerHelpers = {
    summarizeCyber,
    summarizeOutages,
    summarizeGps,
    summarizeUcdp,
    summarizeUnrest,
    summarizeSocialVelocity,
    getCountryDisplacement,
    getThreatSummaryScore,
    countTradeRestrictions,
    countTradeBarriers,
  };

  const {
    listScorableCountries,
    PENALTY_ALPHA,
    penalizedPillarScore,
  } = await import('../server/worldmonitor/resilience/v1/_shared.ts');

  const {
    buildPillarList,
    PILLAR_ORDER,
    PILLAR_WEIGHTS,
  } = await import('../server/worldmonitor/resilience/v1/_pillar-membership.ts');

  const { INDICATOR_REGISTRY } = await import(
    '../server/worldmonitor/resilience/v1/_indicator-registry.ts'
  );

  const domainWeights = {};
  for (const domainId of RESILIENCE_DOMAIN_ORDER) {
    domainWeights[domainId] = getResilienceDomainWeight(domainId);
  }

  // Run the acceptance math over the FULL scorable universe, not a
  // curated subset. Plan gate 2 ("no country's overallScore changes
  // by more than 15 points") and the baseline-Spearman check must see
  // every country in the ranking universe; otherwise a large regression
  // inside an excluded country passes silently. RESILIENCE_COHORTS and
  // MATCHED_PAIRS are still used by the cohort/pair diagnostic blocks
  // (naturally scoped to their memberships); any endpoint those
  // definitions reference but listScorableCountries refuses to score
  // is reported in `cohortMissingFromScorable` (fail-loud, not drop).
  const scorableCountries = await listScorableCountries();
  const scorableUniverse = scorableCountries.slice(); // full universe
  const cohortOrPairMembers = new Set([
    ...RESILIENCE_COHORTS.flatMap((c) => c.countryCodes),
    ...MATCHED_PAIRS.flatMap((p) => [p.higherExpected, p.lowerExpected]),
  ]);
  const cohortMissingFromScorable = [...cohortOrPairMembers].filter(
    (cc) => !scorableCountries.includes(cc),
  );

  // Load the frozen pre-PR-0 baseline before scoring so we can compute
  // baseline-delta gates (acceptance gates 2, 6, 7). If no baseline
  // exists yet (first run under PR 0), we still emit the comparison
  // output but mark the baselineComparison block `unavailable` so the
  // caller can detect missing-baseline vs passed-baseline.
  const baseline = loadMostRecentBaselineSnapshot();

  // Finding 3 — per-indicator extraction plan is driven by
  // INDICATOR_REGISTRY (every Core + Enrichment indicator gets a row)
  // rather than a hand-picked subset of 12. Indicators whose source
  // key cannot be reduced to a per-country scalar without duplicating
  // scorer math get extractionStatus 'not-implemented' with a reason
  // — so the gap is visible in output, not hidden.
  const extractionPlan = buildIndicatorExtractionPlan(INDICATOR_REGISTRY);
  const implementedRules = extractionPlan.filter((p) => p.extractionStatus === 'implemented');

  const sharedReader = createMemoizedSeedReader();
  const rows = [];
  const perIndicatorValues = {};
  for (const plan of implementedRules) {
    perIndicatorValues[plan.indicator] = [];
  }

  for (const countryCode of scorableUniverse) {
    const scoreMap = await scoreAllDimensions(countryCode, sharedReader);

    const sources = await readExtractionSources(countryCode, sharedReader);
    for (const plan of implementedRules) {
      const value = applyExtractionRule(plan.rule, sources, countryCode, scorerHelpers);
      if (value == null || !Number.isFinite(value)) continue;
      perIndicatorValues[plan.indicator].push({ countryCode, value });
    }

    // Build the same ResilienceDimension shape production uses. Only
    // `id`, `score`, and `coverage` are read by buildDomainList /
    // buildPillarList, but pass the other fields too for fidelity with
    // the production payload (empty strings / zeros are fine here
    // because the pillar aggregation does not touch them).
    const dimensions = RESILIENCE_DIMENSION_ORDER.map((dimId) => ({
      id: dimId,
      score: scoreMap[dimId].score,
      coverage: scoreMap[dimId].coverage,
      observedWeight: scoreMap[dimId].observedWeight ?? 0,
      imputedWeight: scoreMap[dimId].imputedWeight ?? 0,
      imputationClass: scoreMap[dimId].imputationClass ?? '',
      freshness: { lastObservedAtMs: '0', staleness: '' },
    }));

    // Build domains and pillars with the EXACT production aggregation
    // — including the per-dim weight channel (PR 2 §3.4 recovery
    // rebalance). RESILIENCE_DIMENSION_WEIGHTS is passed through so
    // this harness's Spearman / rank-delta artifacts reflect live
    // scoring. The mirror `coverageWeightedMean` above defaults any
    // missing id to 1.0 (same contract as production).
    const domains = buildDomainList(
      dimensions,
      RESILIENCE_DIMENSION_DOMAINS,
      RESILIENCE_DOMAIN_ORDER,
      getResilienceDomainWeight,
      RESILIENCE_DIMENSION_WEIGHTS,
    );

    // Current production overallScore: Σ domain.score * domain.weight
    // (pre-round `domains[*].score` matches the value used inside
    // production's `buildResilienceScore` where the reduce operates on
    // the rounded domain-list scores).
    const currentOverall = domains.reduce(
      (sum, d) => sum + d.score * d.weight,
      0,
    );

    // Production pillar shape: coverage-weighted by average dimension
    // coverage per member domain, not by the static domain weights.
    // This is the material correction vs the earlier comparison script.
    const pillars = buildPillarList(domains, true);

    // Proposed overallScore: Σ pillar.score * pillar.weight × (1 − α(1 − min/100))
    const proposedOverall = penalizedPillarScore(
      pillars.map((p) => ({ score: p.score, weight: p.weight })),
    );

    const pillarById = Object.fromEntries(pillars.map((p) => [p.id, p.score]));

    // Retain per-dimension scores on the row so the variable-influence
    // pass below can correlate each dimension's cross-country variance
    // against overall score (acceptance gate 8 baseline).
    const dimensionScores = Object.fromEntries(
      dimensions.map((d) => [d.id, d.score]),
    );

    rows.push({
      countryCode,
      currentOverallScore: Math.round(currentOverall * 100) / 100,
      proposedOverallScore: Math.round(proposedOverall * 100) / 100,
      scoreDelta: Math.round((proposedOverall - currentOverall) * 100) / 100,
      dimensionScores,
      pillars: {
        structuralReadiness: Math.round((pillarById['structural-readiness'] ?? 0) * 100) / 100,
        liveShockExposure: Math.round((pillarById['live-shock-exposure'] ?? 0) * 100) / 100,
        recoveryCapacity: Math.round((pillarById['recovery-capacity'] ?? 0) * 100) / 100,
        minPillar: Math.round(Math.min(...pillars.map((p) => p.score)) * 100) / 100,
      },
    });
  }

  const currentScoresMap = Object.fromEntries(rows.map((r) => [r.countryCode, r.currentOverallScore]));
  const proposedScoresMap = Object.fromEntries(rows.map((r) => [r.countryCode, r.proposedOverallScore]));

  const currentRanks = rankCountries(currentScoresMap);
  const proposedRanks = rankCountries(proposedScoresMap);

  for (const row of rows) {
    row.currentRank = currentRanks[row.countryCode];
    row.proposedRank = proposedRanks[row.countryCode];
    row.rankDelta = row.proposedRank - row.currentRank; // + means dropped, − means climbed
    row.rankAbsDelta = Math.abs(row.rankDelta);
  }

  const spearman = spearmanCorrelation(currentRanks, proposedRanks);

  // Top movers by absolute rank change, breaking ties by absolute score delta.
  const topMovers = [...rows]
    .sort((a, b) =>
      b.rankAbsDelta - a.rankAbsDelta ||
      Math.abs(b.scoreDelta) - Math.abs(a.scoreDelta),
    )
    .slice(0, 10);

  const biggestScoreDrops = [...rows].sort((a, b) => a.scoreDelta - b.scoreDelta).slice(0, 5);
  const biggestScoreClimbs = [...rows].sort((a, b) => b.scoreDelta - a.scoreDelta).slice(0, 5);

  const meanScoreDelta = rows.reduce((s, r) => s + r.scoreDelta, 0) / rows.length;
  const meanAbsScoreDelta = rows.reduce((s, r) => s + Math.abs(r.scoreDelta), 0) / rows.length;
  const maxRankAbsDelta = Math.max(...rows.map((r) => r.rankAbsDelta));

  // Cohort + matched-pair summaries (PR 0 fairness-audit harness).
  // Scoped to the cohort/pair memberships defined in the helpers;
  // scoring ran over the full scorable universe so every member that
  // listScorableCountries recognised is already in `rows`.
  const rowsByCc = new Map(rows.map((r) => [r.countryCode, r]));

  function median(values) {
    if (values.length === 0) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  }

  const cohortSummary = RESILIENCE_COHORTS.map((cohort) => {
    const members = cohort.countryCodes
      .map((cc) => rowsByCc.get(cc))
      .filter((r) => r != null);
    if (members.length === 0) {
      return { cohortId: cohort.id, inSample: 0, skipped: true };
    }
    const deltas = members.map((m) => m.scoreDelta);
    const rankDeltas = members.map((m) => m.rankDelta);
    const sortedByDelta = [...members].sort((a, b) => b.scoreDelta - a.scoreDelta);
    return {
      cohortId: cohort.id,
      label: cohort.label,
      inSample: members.length,
      medianScoreDelta: Math.round(median(deltas) * 100) / 100,
      medianAbsScoreDelta: Math.round(median(deltas.map((d) => Math.abs(d))) * 100) / 100,
      maxRankAbsDelta: Math.max(...rankDeltas.map((d) => Math.abs(d))),
      biggestClimber: sortedByDelta[0] != null
        ? { countryCode: sortedByDelta[0].countryCode, scoreDelta: sortedByDelta[0].scoreDelta, rankDelta: sortedByDelta[0].rankDelta }
        : null,
      biggestDrop: sortedByDelta.at(-1) != null
        ? { countryCode: sortedByDelta.at(-1).countryCode, scoreDelta: sortedByDelta.at(-1).scoreDelta, rankDelta: sortedByDelta.at(-1).rankDelta }
        : null,
      middleMover: sortedByDelta[Math.floor(sortedByDelta.length / 2)] != null
        ? {
            countryCode: sortedByDelta[Math.floor(sortedByDelta.length / 2)].countryCode,
            scoreDelta: sortedByDelta[Math.floor(sortedByDelta.length / 2)].scoreDelta,
            rankDelta: sortedByDelta[Math.floor(sortedByDelta.length / 2)].rankDelta,
          }
        : null,
    };
  });

  const matchedPairSummary = MATCHED_PAIRS.map((pair) => {
    const higher = rowsByCc.get(pair.higherExpected);
    const lower = rowsByCc.get(pair.lowerExpected);
    if (!higher || !lower) {
      return { pairId: pair.id, skipped: true, reason: `pair member missing from scorable universe: ${!higher ? pair.higherExpected : pair.lowerExpected}` };
    }
    const minGap = pair.minGap ?? 3;
    const currentGap = higher.currentOverallScore - lower.currentOverallScore;
    const proposedGap = higher.proposedOverallScore - lower.proposedOverallScore;
    const expectedDirectionHeld = proposedGap > 0;
    const gapAtLeastMin = proposedGap >= minGap;
    return {
      pairId: pair.id,
      axis: pair.axis,
      higherExpected: pair.higherExpected,
      lowerExpected: pair.lowerExpected,
      minGap,
      currentGap: Math.round(currentGap * 100) / 100,
      proposedGap: Math.round(proposedGap * 100) / 100,
      expectedDirectionHeld,
      gapAtLeastMin,
      // Gate: if either flag is false, this pair fails the matched-pair
      // acceptance check and the PR stops.
      passes: expectedDirectionHeld && gapAtLeastMin,
    };
  });

  const matchedPairFailures = matchedPairSummary.filter((p) => !p.skipped && !p.passes);

  // Variable-influence baseline (Pearson-derivative approximation of
  // Sobol indices). For every dimension, measures the cross-country
  // Pearson correlation between that dimension's score and the current
  // overall score, scaled by the dimension's nominal domain weight.
  // The scaled correlation is a proxy for "effective influence" —
  // acceptance gate 8 requires that after any scorer change the
  // measured effective-influence agree in sign and rank-order with
  // the assigned nominal weights. Indicators that nominal-weight as
  // material but measured-effective-influence as near-zero flag a
  // construct problem (the indicator carries weight but drives no
  // variance — classic wealth-proxy or saturated-signal behaviour).
  //
  // A full Sobol implementation is a PR 0.5 follow-up; this Pearson-
  // derivative is sufficient to produce the per-indicator baseline
  // the plan's acceptance gates require.
  const currentOverallArr = rows.map((r) => r.currentOverallScore);
  const variableInfluence = RESILIENCE_DIMENSION_ORDER.map((dimId) => {
    const domainId = RESILIENCE_DIMENSION_DOMAINS[dimId];
    const domainWeight = domainWeights[domainId] ?? 0;
    const dimScoresArr = rows.map((r) => r.dimensionScores[dimId] ?? 0);
    const correlation = pearsonCorrelation(dimScoresArr, currentOverallArr);
    // Normalize: the influence is the correlation × domain weight.
    // We don't know the intra-domain weight here without re-threading
    // the full indicator registry, so this is a domain-level proxy —
    // sufficient for the construct-problem detector described above.
    const influence = correlation * domainWeight;
    const dimScoreMean = dimScoresArr.reduce((s, v) => s + v, 0) / dimScoresArr.length;
    const dimScoreVariance = dimScoresArr.reduce((s, v) => s + (v - dimScoreMean) ** 2, 0) / dimScoresArr.length;
    return {
      dimensionId: dimId,
      domainId,
      nominalDomainWeight: domainWeight,
      pearsonVsOverall: Math.round(correlation * 10000) / 10000,
      effectiveInfluence: Math.round(influence * 10000) / 10000,
      dimScoreMean: Math.round(dimScoreMean * 100) / 100,
      dimScoreVariance: Math.round(dimScoreVariance * 100) / 100,
    };
  });
  // Sort by effective influence desc so the report shows the biggest
  // drivers first.
  variableInfluence.sort((a, b) => Math.abs(b.effectiveInfluence) - Math.abs(a.effectiveInfluence));

  // Per-indicator effective influence, driven by INDICATOR_REGISTRY
  // via extractionPlan. Every registered indicator gets a row:
  //
  //   - extractionStatus='implemented': Pearson(indicatorValue, overallScore)
  //     across countries with non-null readings; pairedSampleSize
  //     reports coverage.
  //   - extractionStatus='not-implemented': correlation omitted, reason
  //     surfaced so callers can see why (event-window aggregate,
  //     global-only scalar, curated sub-series, etc.).
  //   - extractionStatus='unregistered-in-harness': indicator exists in
  //     INDICATOR_REGISTRY but EXTRACTION_RULES has no entry, signalling
  //     a registry addition that skipped this harness.
  //
  // The output is sorted by absolute effective influence within the
  // implemented group, then by dimension id for the other groups so
  // gaps are legible.
  const scoreByCc = new Map(rows.map((r) => [r.countryCode, r.currentOverallScore]));
  const perIndicatorInfluence = extractionPlan.map((plan) => {
    if (plan.extractionStatus !== 'implemented') {
      return {
        indicator: plan.indicator,
        dimension: plan.dimension,
        tier: plan.tier,
        nominalWeight: plan.nominalWeight,
        extractionStatus: plan.extractionStatus,
        reason: plan.reason,
      };
    }
    const observations = perIndicatorValues[plan.indicator] ?? [];
    const xs = [];
    const ys = [];
    for (const { countryCode, value } of observations) {
      const overall = scoreByCc.get(countryCode);
      if (overall == null) continue;
      xs.push(value);
      ys.push(overall);
    }
    const correlation = pearsonCorrelation(xs, ys);
    return {
      indicator: plan.indicator,
      dimension: plan.dimension,
      tier: plan.tier,
      nominalWeight: plan.nominalWeight,
      extractionStatus: 'implemented',
      pairedSampleSize: xs.length,
      pearsonVsOverall: Math.round(correlation * 10000) / 10000,
      effectiveInfluence: Math.round(correlation * 10000) / 10000,
    };
  });
  perIndicatorInfluence.sort((a, b) => {
    // Implemented entries first (sorted by |influence| desc),
    // not-implemented/unregistered after (sorted by dimension/id)
    // so the acceptance-apparatus gap is easy to read at the bottom.
    const aImpl = a.extractionStatus === 'implemented';
    const bImpl = b.extractionStatus === 'implemented';
    if (aImpl !== bImpl) return aImpl ? -1 : 1;
    if (aImpl) {
      return Math.abs(b.effectiveInfluence) - Math.abs(a.effectiveInfluence);
    }
    const byDim = (a.dimension ?? '').localeCompare(b.dimension ?? '');
    return byDim !== 0 ? byDim : a.indicator.localeCompare(b.indicator);
  });

  // Coverage summary for the extraction apparatus itself. PR 0.5 can
  // track the "not-implemented" and "unregistered-in-harness" lists to
  // measure progress toward full per-indicator influence coverage.
  const extractionCoverage = {
    totalIndicators: extractionPlan.length,
    implemented: perIndicatorInfluence.filter((p) => p.extractionStatus === 'implemented').length,
    notImplemented: perIndicatorInfluence.filter((p) => p.extractionStatus === 'not-implemented').length,
    unregisteredInHarness: perIndicatorInfluence.filter((p) => p.extractionStatus === 'unregistered-in-harness').length,
    coreImplemented: perIndicatorInfluence.filter((p) => p.extractionStatus === 'implemented' && p.tier === 'core').length,
    coreTotal: extractionPlan.filter((p) => p.tier === 'core').length,
  };

  // Baseline comparison. Compares today's currentOverallScore against
  // the locked baseline snapshot the plan pins for acceptance gates 2,
  // 6, and 7. If no baseline exists (first PR 0 run), emit an explicit
  // `unavailable` marker so downstream acceptance tooling can detect
  // the state difference rather than treating it as a pass.
  let baselineComparison;
  if (!baseline) {
    baselineComparison = {
      status: 'unavailable',
      reason:
        'No baseline snapshot found in docs/snapshots/. Expected resilience-ranking-live-pre-repair-<date>.json from PR 0 freeze.',
    };
  } else {
    const baselineScores = baseline.scoresByCountry;
    const overlapping = rows
      .map((r) => ({
        countryCode: r.countryCode,
        currentOverallScore: r.currentOverallScore,
        baselineOverallScore: baselineScores[r.countryCode],
      }))
      .filter((r) => typeof r.baselineOverallScore === 'number');

    const scoreDrifts = overlapping.map((r) => ({
      countryCode: r.countryCode,
      currentOverallScore: r.currentOverallScore,
      baselineOverallScore: Math.round(r.baselineOverallScore * 100) / 100,
      scoreDelta: Math.round((r.currentOverallScore - r.baselineOverallScore) * 100) / 100,
      scoreAbsDelta: Math.abs(Math.round((r.currentOverallScore - r.baselineOverallScore) * 100) / 100),
    }));

    const maxCountryAbsDelta = scoreDrifts.reduce((max, d) => Math.max(max, d.scoreAbsDelta), 0);
    const biggestDrifts = [...scoreDrifts]
      .sort((a, b) => b.scoreAbsDelta - a.scoreAbsDelta)
      .slice(0, 10);

    // Spearman vs baseline over the overlap (both ranking universes
    // restricted to the shared country set so newly-added or newly-
    // removed countries can't skew the correlation).
    const currentOverlap = Object.fromEntries(
      overlapping.map((r) => [r.countryCode, r.currentOverallScore]),
    );
    const baselineOverlap = Object.fromEntries(
      overlapping.map((r) => [r.countryCode, r.baselineOverallScore]),
    );
    const spearmanVsBaseline = spearmanCorrelation(
      rankCountries(currentOverlap),
      rankCountries(baselineOverlap),
    );

    // Cohort median shift vs baseline (the plan's effective cohort
    // gate). A cohort whose median score has drifted by more than the
    // plan's +/-5 tolerance flags for audit even if Spearman looks fine.
    const cohortShiftVsBaseline = RESILIENCE_COHORTS.map((cohort) => {
      const members = cohort.countryCodes
        .map((cc) => {
          const row = rowsByCc.get(cc);
          const base = baselineScores[cc];
          if (!row || typeof base !== 'number') return null;
          return { countryCode: cc, delta: row.currentOverallScore - base };
        })
        .filter((m) => m != null);
      if (members.length === 0) {
        return { cohortId: cohort.id, inSample: 0, skipped: true };
      }
      return {
        cohortId: cohort.id,
        label: cohort.label,
        inSample: members.length,
        medianScoreDeltaVsBaseline: Math.round(median(members.map((m) => m.delta)) * 100) / 100,
      };
    });

    // Matched-pair gap change vs baseline. For each pair, compare the
    // higher-minus-lower gap today against the same gap in the frozen
    // baseline so construct changes that reverse a pair can be flagged
    // explicitly (the matched-pair table above is current-vs-proposed;
    // this block is current-vs-baseline).
    const matchedPairGapChange = MATCHED_PAIRS.map((pair) => {
      const higherBase = baselineScores[pair.higherExpected];
      const lowerBase = baselineScores[pair.lowerExpected];
      const higher = rowsByCc.get(pair.higherExpected);
      const lower = rowsByCc.get(pair.lowerExpected);
      if (
        typeof higherBase !== 'number' ||
        typeof lowerBase !== 'number' ||
        !higher ||
        !lower
      ) {
        return { pairId: pair.id, skipped: true };
      }
      const baselineGap = higherBase - lowerBase;
      const currentGap = higher.currentOverallScore - lower.currentOverallScore;
      return {
        pairId: pair.id,
        axis: pair.axis,
        baselineGap: Math.round(baselineGap * 100) / 100,
        currentGap: Math.round(currentGap * 100) / 100,
        gapChange: Math.round((currentGap - baselineGap) * 100) / 100,
      };
    });

    baselineComparison = {
      status: 'ok',
      baselineFile: baseline.filename,
      baselineKind: baseline.kind,
      baselinePrNumber: baseline.prNumber,
      baselineDate: baseline.date,
      baselineCapturedAt: baseline.capturedAt,
      baselineCommitSha: baseline.commitSha,
      overlapSize: overlapping.length,
      spearmanVsBaseline: Math.round(spearmanVsBaseline * 10000) / 10000,
      maxCountryAbsDelta: Math.round(maxCountryAbsDelta * 100) / 100,
      biggestDriftsVsBaseline: biggestDrifts,
      cohortShiftVsBaseline,
      matchedPairGapChange,
    };
  }

  // Acceptance-gate verdict per plan §6. Computed programmatically
  // from the inputs above so every scorer-changing PR has a
  // machine-readable pass/fail on every gate. Gate numbering matches
  // the plan sections literally — do NOT reorder without updating the
  // plan.
  //
  // Thresholds are encoded here (not tunable per-PR) so gate criteria
  // can't silently soften. Any adjustment requires a PR touching this
  // file + the plan doc in the same commit.
  const GATE_THRESHOLDS = {
    SPEARMAN_VS_BASELINE_MIN: 0.85,
    MAX_COUNTRY_ABS_DELTA_MAX: 15,
    COHORT_MEDIAN_SHIFT_MAX: 10,
  };
  const gates = [];
  const addGate = (id, name, status, detail) => {
    gates.push({ id, name, status, detail });
  };

  // Gate 1: Spearman vs immediate-prior baseline >= 0.85.
  if (baselineComparison.status === 'ok') {
    const s = baselineComparison.spearmanVsBaseline;
    addGate('gate-1-spearman', 'Spearman vs baseline >= 0.85',
      s >= GATE_THRESHOLDS.SPEARMAN_VS_BASELINE_MIN ? 'pass' : 'fail',
      `${s} (floor ${GATE_THRESHOLDS.SPEARMAN_VS_BASELINE_MIN})`);
  } else {
    addGate('gate-1-spearman', 'Spearman vs baseline >= 0.85', 'skipped',
      'baseline unavailable; re-run after PR 0 freeze ships');
  }

  // Gate 2: No country's overallScore changes by more than 15 points
  // from the immediate-prior baseline.
  if (baselineComparison.status === 'ok') {
    const drift = baselineComparison.maxCountryAbsDelta;
    addGate('gate-2-country-drift', 'Max country drift vs baseline <= 15 points',
      drift <= GATE_THRESHOLDS.MAX_COUNTRY_ABS_DELTA_MAX ? 'pass' : 'fail',
      `${drift}pt (ceiling ${GATE_THRESHOLDS.MAX_COUNTRY_ABS_DELTA_MAX})`);
  } else {
    addGate('gate-2-country-drift', 'Max country drift vs baseline <= 15 points', 'skipped',
      'baseline unavailable');
  }

  // Gate 6: Cohort median shift vs baseline capped at 10 points.
  if (baselineComparison.status === 'ok') {
    const worstCohort = (baselineComparison.cohortShiftVsBaseline ?? [])
      .filter((c) => !c.skipped && typeof c.medianScoreDeltaVsBaseline === 'number')
      .reduce((worst, c) => {
        const abs = Math.abs(c.medianScoreDeltaVsBaseline);
        return abs > Math.abs(worst?.medianScoreDeltaVsBaseline ?? 0) ? c : worst;
      }, null);
    if (worstCohort) {
      const shift = Math.abs(worstCohort.medianScoreDeltaVsBaseline);
      addGate('gate-6-cohort-median', 'Cohort median shift vs baseline <= 10 points',
        shift <= GATE_THRESHOLDS.COHORT_MEDIAN_SHIFT_MAX ? 'pass' : 'fail',
        `worst: ${worstCohort.cohortId} ${worstCohort.medianScoreDeltaVsBaseline}pt (ceiling ${GATE_THRESHOLDS.COHORT_MEDIAN_SHIFT_MAX})`);
    } else {
      addGate('gate-6-cohort-median', 'Cohort median shift vs baseline <= 10 points', 'skipped',
        'no cohort has baseline overlap');
    }
  } else {
    addGate('gate-6-cohort-median', 'Cohort median shift vs baseline <= 10 points', 'skipped',
      'baseline unavailable');
  }

  // Gate 7: Matched-pair within-pair gap signs verified. Any pair
  // flipping direction or falling below minGap stops the PR.
  addGate('gate-7-matched-pair', 'Matched-pair within-pair gaps hold expected direction',
    matchedPairFailures.length === 0 ? 'pass' : 'fail',
    matchedPairFailures.length === 0
      ? `${matchedPairSummary.filter((p) => !p.skipped).length}/${matchedPairSummary.filter((p) => !p.skipped).length} pairs pass`
      : `${matchedPairFailures.length} pair(s) failed: ${matchedPairFailures.map((p) => p.pairId).join(', ')}`);

  // Gate 9: Per-indicator effective-influence baseline present. Sign-
  // and rank-order correctness against nominal weights is a post-hoc
  // human-review check; this gate asserts the MEASUREMENT exists,
  // which is the diagnostic-apparatus pre-requisite from PR 0.
  addGate('gate-9-effective-influence-baseline',
    'Per-indicator effective-influence baseline exists (>= 80% of Core implemented)',
    extractionCoverage.coreTotal > 0 && (extractionCoverage.coreImplemented / extractionCoverage.coreTotal) >= 0.80
      ? 'pass' : 'fail',
    `${extractionCoverage.coreImplemented}/${extractionCoverage.coreTotal} Core indicators measurable`);

  // Gate: cohort/pair membership present in scorable universe (not
  // numbered in plan §6 but is the PR 0 fail-loud addition — if any
  // cohort/pair endpoint falls out of listScorableCountries, every
  // other gate is being computed over a silently-partial universe).
  addGate('gate-universe-integrity', 'All cohort/pair endpoints are in the scorable universe',
    cohortMissingFromScorable.length === 0 ? 'pass' : 'fail',
    cohortMissingFromScorable.length === 0
      ? `${cohortOrPairMembers.size} endpoints verified`
      : `missing from scorable: ${cohortMissingFromScorable.join(', ')}`);

  const acceptanceGates = {
    thresholds: GATE_THRESHOLDS,
    results: gates,
    summary: {
      total: gates.length,
      pass: gates.filter((g) => g.status === 'pass').length,
      fail: gates.filter((g) => g.status === 'fail').length,
      skipped: gates.filter((g) => g.status === 'skipped').length,
    },
    verdict: gates.some((g) => g.status === 'fail')
      ? 'BLOCK' // any fail halts the PR per plan §6
      : gates.some((g) => g.status === 'skipped')
        ? 'CONDITIONAL' // skipped gates need the missing inputs before final merge
        : 'PASS',
  };

  const output = {
    comparison: 'currentDomainAggregate_vs_proposedPillarCombined',
    penaltyAlpha: PENALTY_ALPHA,
    pillarWeights: PILLAR_WEIGHTS,
    domainWeights,
    // Finding 1 acceptance-apparatus metadata: scoring + acceptance
    // gates ran over the FULL scorable universe, not a curated sample.
    // cohortMissingFromScorable surfaces any cohort/pair endpoint that
    // the scoring registry cannot actually score (e.g. new cohort
    // addition that slipped past listScorableCountries): fail-loud
    // instead of silently dropping.
    scorableUniverseSize: scorableCountries.length,
    sampleSize: rows.length,
    sampleCountries: rows.map((r) => r.countryCode),
    cohortMissingFromScorable,
    summary: {
      spearmanRankCorrelation: Math.round(spearman * 10000) / 10000,
      meanScoreDelta: Math.round(meanScoreDelta * 100) / 100,
      meanAbsScoreDelta: Math.round(meanAbsScoreDelta * 100) / 100,
      maxRankAbsDelta,
      matchedPairFailures: matchedPairFailures.length,
      acceptanceVerdict: acceptanceGates.verdict,
    },
    acceptanceGates,
    baselineComparison,
    cohortSummary,
    matchedPairSummary,
    variableInfluence,
    extractionCoverage,
    perIndicatorInfluence,
    topMoversByRank: topMovers.map((r) => ({
      countryCode: r.countryCode,
      currentRank: r.currentRank,
      proposedRank: r.proposedRank,
      rankDelta: r.rankDelta,
      currentOverallScore: r.currentOverallScore,
      proposedOverallScore: r.proposedOverallScore,
      scoreDelta: r.scoreDelta,
      pillars: r.pillars,
    })),
    biggestScoreDrops: biggestScoreDrops.map((r) => ({
      countryCode: r.countryCode,
      scoreDelta: r.scoreDelta,
      currentOverallScore: r.currentOverallScore,
      proposedOverallScore: r.proposedOverallScore,
      rankDelta: r.rankDelta,
    })),
    biggestScoreClimbs: biggestScoreClimbs.map((r) => ({
      countryCode: r.countryCode,
      scoreDelta: r.scoreDelta,
      currentOverallScore: r.currentOverallScore,
      proposedOverallScore: r.proposedOverallScore,
      rankDelta: r.rankDelta,
    })),
    fullSample: rows,
  };

  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

// Export the baseline-snapshot selection helpers so unit tests can
// verify the ordering contract (pre-repair < post-pr1 < post-pr10, etc.)
// without having to spin up the full scoring pipeline.
export {
  parseBaselineSnapshotMeta,
  loadMostRecentBaselineSnapshot,
  EXTRACTION_RULES,
  buildIndicatorExtractionPlan,
  applyExtractionRule,
};

// isMain guard so importing the helpers from a test file does not
// accidentally trigger the full scoring run. Per the project's
// feedback_seed_isMain_guard memory: any script that exports functions
// AND runs work at top level MUST guard the work behind an explicit
// entrypoint check.
const invokedAsScript = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return path.resolve(entry) === path.resolve(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (invokedAsScript) {
  main().catch((err) => {
    console.error('[compare-resilience-current-vs-proposed] failed:', err);
    process.exit(1);
  });
}
