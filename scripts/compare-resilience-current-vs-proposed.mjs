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
// production helper is not exported.
function coverageWeightedMean(dims) {
  const totalCoverage = dims.reduce((s, d) => s + d.coverage, 0);
  if (!totalCoverage) return 0;
  return dims.reduce((s, d) => s + d.score * d.coverage, 0) / totalCoverage;
}

// Mirrors `_shared.ts#buildDomainList` exactly so the ResilienceDomain
// objects fed to buildPillarList are byte-identical to what production
// emits. The production helper is not exported, so we re-implement it
// here; the implementation MUST stay in lockstep with _shared.ts.
function buildDomainList(dimensions, dimensionDomains, domainOrder, getDomainWeight) {
  const grouped = new Map();
  for (const domainId of domainOrder) grouped.set(domainId, []);
  for (const dim of dimensions) {
    const domainId = dimensionDomains[dim.id];
    grouped.get(domainId)?.push(dim);
  }
  return domainOrder.map((domainId) => {
    const domainDims = grouped.get(domainId) ?? [];
    const domainScore = coverageWeightedMean(domainDims);
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

const EXTRACTION_RULES = {
  // ── macroFiscal ─────────────────────────────────────────────────────
  govRevenuePct: { type: 'imf-macro-country-field', field: 'govRevenuePct' },
  debtGrowthRate: { type: 'national-debt', field: 'annualGrowth' },
  currentAccountPct: { type: 'imf-macro-country-field', field: 'currentAccountPct' },
  unemploymentPct: { type: 'imf-labor-country-field', field: 'unemploymentPct' },
  householdDebtService: { type: 'not-implemented', reason: 'BIS DSR curated series needs per-country quarterly DSR selection matching the scorer window' },

  // ── currencyExternal ────────────────────────────────────────────────
  fxVolatility: { type: 'not-implemented', reason: 'BIS REER annualized volatility requires the scorer monthly-change std-dev computation' },
  fxDeviation: { type: 'not-implemented', reason: 'BIS REER absolute deviation from 100 requires the scorer latest-value selection' },
  fxReservesAdequacy: { type: 'static-path', path: ['fxReservesMonths', 'months'] },

  // ── tradeSanctions ──────────────────────────────────────────────────
  sanctionCount: { type: 'sanctions-count' },
  tradeRestrictions: { type: 'not-implemented', reason: 'WTO tariff-overview requires IN_FORCE weighting + curated top-50 reporter filter matching the scorer' },
  tradeBarriers: { type: 'not-implemented', reason: 'WTO tariff-gap requires notifying-country aggregation matching the scorer' },
  appliedTariffRate: { type: 'static-path', path: ['appliedTariffRate', 'value'] },

  // ── cyberDigital ────────────────────────────────────────────────────
  cyberThreats: { type: 'not-implemented', reason: 'Severity-weighted threat count needs scorer critical/high/medium/low weighting' },
  internetOutages: { type: 'not-implemented', reason: 'Outage penalty needs scorer total/major/partial weighting' },
  gpsJamming: { type: 'not-implemented', reason: 'GPS jamming hex penalty needs scorer high/medium weighting' },

  // ── logisticsSupply ─────────────────────────────────────────────────
  roadsPavedLogistics: { type: 'static-wb-infrastructure', code: 'IS.ROD.PAVE.ZS' },
  shippingStress: { type: 'not-implemented', reason: 'Global shipping-stress score is not per-country; Pearson against overall is ill-defined' },
  transitDisruption: { type: 'not-implemented', reason: 'Transit-corridor disruption requires per-country route aggregation matching the scorer' },

  // ── infrastructure ──────────────────────────────────────────────────
  electricityAccess: { type: 'static-wb-infrastructure', code: 'EG.ELC.ACCS.ZS' },
  roadsPavedInfra: { type: 'static-wb-infrastructure', code: 'IS.ROD.PAVE.ZS' },
  infraOutages: { type: 'not-implemented', reason: 'Same aggregation as cyberDigital.internetOutages' },

  // ── energy ──────────────────────────────────────────────────────────
  energyImportDependency: { type: 'static-path', path: ['iea', 'energyImportDependency', 'value'] },
  gasShare: { type: 'energy-mix-field', field: 'gasShare' },
  coalShare: { type: 'energy-mix-field', field: 'coalShare' },
  renewShare: { type: 'energy-mix-field', field: 'renewShare' },
  gasStorageStress: { type: 'gas-storage-field', field: 'fillPct' },
  energyPriceStress: { type: 'not-implemented', reason: 'Commodity energy price stress is a global average, not per-country' },
  electricityConsumption: { type: 'static-wb-infrastructure', code: 'EG.USE.ELEC.KH.PC' },

  // ── governanceInstitutional (all 6 WGI sub-pillars) ─────────────────
  // Static-record keys are World-Bank WGI standard codes; see
  // scripts/seed-resilience-static.mjs#WGI_INDICATORS.
  wgiVoiceAccountability: { type: 'static-wgi', code: 'VA.EST' },
  wgiPoliticalStability: { type: 'static-wgi', code: 'PV.EST' },
  wgiGovernmentEffectiveness: { type: 'static-wgi', code: 'GE.EST' },
  wgiRegulatoryQuality: { type: 'static-wgi', code: 'RQ.EST' },
  wgiRuleOfLaw: { type: 'static-wgi', code: 'RL.EST' },
  wgiControlOfCorruption: { type: 'static-wgi', code: 'CC.EST' },

  // ── socialCohesion ──────────────────────────────────────────────────
  gpiScore: { type: 'static-path', path: ['gpi', 'score'] },
  displacementTotal: { type: 'not-implemented', reason: 'Displacement summary is year-scoped bulk key; needs scorer year selection' },
  displacementHosted: { type: 'not-implemented', reason: 'Displacement-hosted counterpart; same year-scoped bulk aggregation' },
  unrestEvents: { type: 'not-implemented', reason: 'ACLED-style unrest aggregation requires scorer event-count windowing' },

  // ── borderSecurity / stateContinuity conflict-events (event-window) ─
  ucdpConflict: { type: 'not-implemented', reason: 'UCDP events need scorer event-count windowing and severity weighting' },

  // ── informationCognitive ────────────────────────────────────────────
  rsfPressFreedom: { type: 'static-path', path: ['rsf', 'score'] },
  socialVelocity: { type: 'not-implemented', reason: 'Reddit social velocity is cross-post aggregated; not per-country scalar' },
  newsThreatScore: { type: 'not-implemented', reason: 'News threat summary requires scorer severity weighting' },

  // ── healthPublicService ─────────────────────────────────────────────
  hospitalBeds: { type: 'static-who', code: 'hospitalBeds' },
  uhcIndex: { type: 'static-who', code: 'uhcIndex' },
  measlesCoverage: { type: 'static-who', code: 'measlesCoverage' },

  // ── foodWater ───────────────────────────────────────────────────────
  ipcPeopleInCrisis: { type: 'static-path', path: ['fao', 'peopleInCrisis'] },
  ipcPhase: { type: 'static-path', path: ['fao', 'phase'] },
  aquastatWaterStress: { type: 'static-path', path: ['aquastat', 'value'] },
  aquastatWaterAvailability: { type: 'not-implemented', reason: 'AQUASTAT availability has distinct sub-indicator scope from stress; needs separate path resolution' },

  // ── recovery* (seeded bulk keys, deterministic per-country fields) ──
  recoveryGovRevenue: { type: 'recovery-country-field', key: 'resilience:recovery:fiscal-space:v1', field: 'govRevenuePct' },
  recoveryFiscalBalance: { type: 'recovery-country-field', key: 'resilience:recovery:fiscal-space:v1', field: 'fiscalBalancePct' },
  recoveryDebtToGdp: { type: 'recovery-country-field', key: 'resilience:recovery:fiscal-space:v1', field: 'debtToGdpPct' },
  recoveryReserveMonths: { type: 'recovery-country-field', key: 'resilience:recovery:reserve-adequacy:v1', field: 'reserveMonths' },
  recoveryDebtToReserves: { type: 'recovery-country-field', key: 'resilience:recovery:external-debt:v1', field: 'debtToReservesRatio' },
  recoveryImportHhi: { type: 'recovery-country-field', key: 'resilience:recovery:import-hhi:v1', field: 'hhi' },
  recoveryFuelStockDays: { type: 'recovery-country-field', key: 'resilience:recovery:fuel-stocks:v1', field: 'stockDays' },

  // ── stateContinuity derived signals ─────────────────────────────────
  recoveryWgiContinuity: { type: 'static-wgi-mean' },
  recoveryConflictPressure: { type: 'not-implemented', reason: 'Derived from UCDP conflict; depends on ucdpConflict extraction' },
  recoveryDisplacementVelocity: { type: 'not-implemented', reason: 'Derived from displacement summary; depends on displacementTotal/Hosted extraction' },
};

function applyExtractionRule(rule, sources, countryCode) {
  if (!rule || rule.type === 'not-implemented') return null;
  const {
    staticRecord, energyMix, gasStorage, fiscalSpace, reserveAdequacy,
    externalDebt, importHhi, fuelStocks, imfMacro, imfLabor,
    nationalDebt, sanctionsCounts,
  } = sources;
  switch (rule.type) {
    case 'static-path': {
      let cursor = staticRecord;
      for (const k of rule.path) cursor = cursor?.[k];
      return typeof cursor === 'number' ? cursor : null;
    }
    case 'static-wb-infrastructure':
      return staticRecord?.infrastructure?.indicators?.[rule.code]?.value ?? null;
    case 'static-wgi':
      return staticRecord?.wgi?.indicators?.[rule.code]?.value ?? null;
    case 'static-wgi-mean': {
      const entries = Object.values(staticRecord?.wgi?.indicators ?? {})
        .map((entry) => (typeof entry?.value === 'number' ? entry.value : null))
        .filter((v) => v != null);
      if (entries.length === 0) return null;
      return entries.reduce((s, v) => s + v, 0) / entries.length;
    }
    case 'static-who':
      return staticRecord?.who?.indicators?.[rule.code]?.value ?? null;
    case 'energy-mix-field':
      return typeof energyMix?.[rule.field] === 'number' ? energyMix[rule.field] : null;
    case 'gas-storage-field':
      return typeof gasStorage?.[rule.field] === 'number' ? gasStorage[rule.field] : null;
    case 'recovery-country-field': {
      const bulkByKey = {
        'resilience:recovery:fiscal-space:v1': fiscalSpace,
        'resilience:recovery:reserve-adequacy:v1': reserveAdequacy,
        'resilience:recovery:external-debt:v1': externalDebt,
        'resilience:recovery:import-hhi:v1': importHhi,
        'resilience:recovery:fuel-stocks:v1': fuelStocks,
      };
      const bulk = bulkByKey[rule.key];
      const entry = bulk?.countries?.[countryCode];
      return typeof entry?.[rule.field] === 'number' ? entry[rule.field] : null;
    }
    case 'imf-macro-country-field': {
      const entry = imfMacro?.countries?.[countryCode];
      return typeof entry?.[rule.field] === 'number' ? entry[rule.field] : null;
    }
    case 'imf-labor-country-field': {
      const entry = imfLabor?.countries?.[countryCode];
      return typeof entry?.[rule.field] === 'number' ? entry[rule.field] : null;
    }
    case 'national-debt': {
      // economic:national-debt:v1 is an array of { iso3?, iso2?, debtToGdp?, annualGrowth? }
      if (!Array.isArray(nationalDebt)) return null;
      const found = nationalDebt.find((e) => e?.iso2 === countryCode || e?.countryCode === countryCode);
      return typeof found?.[rule.field] === 'number' ? found[rule.field] : null;
    }
    case 'sanctions-count': {
      // sanctions:country-counts:v1 shape tolerates either {countries:{ISO2:n}} or {ISO2:n}.
      const direct = sanctionsCounts?.[countryCode];
      const nested = sanctionsCounts?.countries?.[countryCode];
      if (typeof direct === 'number') return direct;
      if (typeof nested === 'number') return nested;
      if (typeof nested?.count === 'number') return nested.count;
      return null;
    }
    default:
      return null;
  }
}

async function readExtractionSources(countryCode, reader) {
  const [
    staticRecord, energyMix, gasStorage, fiscalSpace, reserveAdequacy,
    externalDebt, importHhi, fuelStocks, imfMacro, imfLabor,
    nationalDebt, sanctionsCounts,
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
  ]);
  return {
    staticRecord, energyMix, gasStorage, fiscalSpace, reserveAdequacy,
    externalDebt, importHhi, fuelStocks, imfMacro, imfLabor,
    nationalDebt, sanctionsCounts,
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
  const {
    scoreAllDimensions,
    RESILIENCE_DIMENSION_ORDER,
    RESILIENCE_DIMENSION_DOMAINS,
    getResilienceDomainWeight,
    RESILIENCE_DOMAIN_ORDER,
    createMemoizedSeedReader,
  } = await import('../server/worldmonitor/resilience/v1/_dimension-scorers.ts');

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
      const value = applyExtractionRule(plan.rule, sources, countryCode);
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

    // Build domains and pillars with the EXACT production aggregation.
    const domains = buildDomainList(
      dimensions,
      RESILIENCE_DIMENSION_DOMAINS,
      RESILIENCE_DOMAIN_ORDER,
      getResilienceDomainWeight,
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
    },
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
