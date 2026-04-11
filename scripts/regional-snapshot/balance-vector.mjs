// @ts-check
// Balance vector computation. Deterministic, no LLM.
// Mirrors the per-axis formulas in
// docs/internal/pro-regional-intelligence-appendix-scoring.md.

import { clip, num, weightedAverage, percentile } from './_helpers.mjs';
// Use scripts/shared mirror (not repo-root shared/): Railway service has
// rootDirectory=scripts so ../../shared/ escapes the deploy root.
import { getRegionCountries, getRegionCorridors, countryCriticality, REGIONS } from '../shared/geography.js';
import iso3ToIso2Raw from '../shared/iso3-to-iso2.json' with { type: 'json' };

/** @type {Record<string, string>} */
const ISO3_TO_ISO2 = iso3ToIso2Raw;

const SCORING_VERSION = '1.0.0';

export { SCORING_VERSION };

/**
 * @param {string} regionId
 * @param {Record<string, any>} sources - keyed by Redis key, see freshness.mjs
 * @returns {{ vector: import('../../shared/regions.types.js').BalanceVector }}
 */
export function computeBalanceVector(regionId, sources) {
  const region = REGIONS.find((r) => r.id === regionId);
  if (!region) throw new Error(`Unknown region: ${regionId}`);
  const countries = new Set(getRegionCountries(regionId));
  const corridors = getRegionCorridors(regionId);

  const pressuresOut = [];
  const buffersOut = [];

  // ── Pressures ────────────────────────────────────────────────────────────
  const coercive = computeCoercivePressure(region, sources, pressuresOut);
  const fragility = computeDomesticFragility(countries, sources, pressuresOut);
  const capital = computeCapitalStress(countries, sources, pressuresOut);
  const energyVuln = computeEnergyVulnerability(countries, sources, pressuresOut);

  // ── Buffers ──────────────────────────────────────────────────────────────
  const alliance = computeAllianceCohesion(regionId, sources, buffersOut);
  const maritime = computeMaritimeAccess(corridors, sources, buffersOut);
  const energyLev = computeEnergyLeverage(countries, buffersOut);

  const pressureMean = (coercive + fragility + capital + energyVuln) / 4;
  const bufferMean = (alliance + maritime + energyLev) / 3;
  const netBalance = bufferMean - pressureMean;

  return {
    vector: {
      coercive_pressure: round(coercive),
      domestic_fragility: round(fragility),
      capital_stress: round(capital),
      energy_vulnerability: round(energyVuln),
      alliance_cohesion: round(alliance),
      maritime_access: round(maritime),
      energy_leverage: round(energyLev),
      net_balance: round(netBalance),
      pressures: pressuresOut,
      buffers: buffersOut,
    },
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Per-axis computations
// ────────────────────────────────────────────────────────────────────────────

function computeCoercivePressure(region, sources, drivers) {
  // Cross-source signals scoped by theater label substring matching
  const xss = sources['intelligence:cross-source-signals:v1'];
  const signals = Array.isArray(xss?.signals) ? xss.signals : [];
  const theaterLabels = region.theaters; // theater IDs are kebab-case; cross-source uses display names
  const inRegion = signals.filter((s) => {
    const t = String(s?.theater ?? '').toLowerCase();
    return theaterLabels.some((label) => t.includes(label.replace(/-/g, ' ')));
  });
  const criticalCount = inRegion.filter((s) => /CRITICAL/i.test(String(s?.severity ?? ''))).length;
  const highCount = inRegion.filter((s) => /HIGH/i.test(String(s?.severity ?? ''))).length;

  // ACLED conflict counts (region-scoped via country bbox - approximate via signal theater)
  // For Phase 0 we approximate via cross-source signal counts since ACLED key not directly fetched.
  const cSignal = clip(criticalCount * 0.4 + highCount * 0.15, 0, 1);

  // Forecast 'rising' count for military/conflict in region
  const fc = sources['forecast:predictions:v2'];
  const forecasts = Array.isArray(fc?.predictions) ? fc.predictions : [];
  const risingMilitary = forecasts.filter((f) => {
    const trend = String(f?.trend ?? '').toLowerCase();
    const domain = String(f?.domain ?? '').toLowerCase();
    const fRegion = String(f?.region ?? '').toLowerCase();
    return (trend === 'rising' || trend === 'escalating') &&
           (domain === 'military' || domain === 'conflict') &&
           fRegion.includes(region.forecastLabel.toLowerCase());
  }).length;
  const cForecast = clip(risingMilitary / 5, 0, 1);

  // Vessel surge and conflict event surrogates default to mid-low when no data
  const cVessel = 0;
  const cConflict = clip(inRegion.length / 50, 0, 1);

  const score = 0.30 * cVessel + 0.30 * cSignal + 0.25 * cConflict + 0.15 * cForecast;

  if (cSignal > 0.05) {
    drivers.push({
      axis: 'coercive_pressure',
      description: `${criticalCount} critical, ${highCount} high cross-source signals in region`,
      magnitude: round(cSignal),
      evidence_ids: inRegion.slice(0, 5).map((s) => String(s?.id ?? `xss:${s?.type ?? 'unknown'}`)),
      orientation: 'pressure',
    });
  }
  if (cForecast > 0) {
    drivers.push({
      axis: 'coercive_pressure',
      description: `${risingMilitary} rising military/conflict forecasts in region`,
      magnitude: round(cForecast),
      evidence_ids: [],
      orientation: 'pressure',
    });
  }

  return clip(score, 0, 1);
}

function computeDomesticFragility(countries, sources, drivers) {
  const cii = sources['risk:scores:sebuf:stale:v1'];
  const ciiScores = Array.isArray(cii?.ciiScores) ? cii.ciiScores : [];
  const inRegion = ciiScores.filter((s) => countries.has(String(s?.region ?? '')));
  if (!inRegion.length) return 0;

  // Per-country normalized score
  const normPerCountry = inRegion.map((s) => ({
    iso: String(s.region),
    norm: clip(num(s.combinedScore) / 100, 0, 1),
  }));

  // Weighted base average
  const baseAvg = weightedAverage(
    normPerCountry,
    (item) => item.norm,
    (item) => countryCriticality(item.iso),
  );
  // Tail amplification
  const values = normPerCountry.map((c) => c.norm);
  const tailP90 = percentile(values, 90);
  const tailMax = Math.max(...values);

  const score = 0.4 * baseAvg + 0.4 * tailP90 + 0.2 * tailMax;

  // Top driver: the country with the highest weighted contribution
  const top = normPerCountry
    .map((c) => ({ ...c, contribution: c.norm * countryCriticality(c.iso) }))
    .sort((a, b) => b.contribution - a.contribution)[0];
  if (top && top.norm > 0.3) {
    drivers.push({
      axis: 'domestic_fragility',
      description: `${top.iso} CII ${(top.norm * 100).toFixed(0)} (criticality ${countryCriticality(top.iso).toFixed(1)})`,
      magnitude: round(top.contribution),
      evidence_ids: [`cii:${top.iso}`],
      orientation: 'pressure',
    });
  }

  return clip(score, 0, 1);
}

function computeCapitalStress(countries, sources, drivers) {
  // economic:macro-signals:v1 — seed-economy.mjs emits verdict: 'BUY' | 'CASH' | 'UNKNOWN'
  //   BUY  = bullish signals dominate (low stress)
  //   CASH = bearish, rotate to cash (high stress)
  //   UNKNOWN = missing/stale (treat as neutral)
  const macro = sources['economic:macro-signals:v1'];
  const verdict = String(macro?.verdict ?? '').toUpperCase();
  const cMacro = verdict === 'CASH' ? 1 : verdict === 'BUY' ? 0 : 0.5;

  // economic:national-debt:v1 shape: { entries: [{ iso3, debtToGdp, ... }] }
  // debtToGdp is a PERCENTAGE (e.g., 110 for 110% of GDP), not a 0-1 fraction.
  // Filter to region via iso3 -> iso2 lookup, then compute average debt percentage.
  const debt = sources['economic:national-debt:v1'];
  const debtEntries = Array.isArray(debt?.entries) ? debt.entries : [];
  const inRegionDebt = debtEntries.filter((e) => {
    const iso2 = ISO3_TO_ISO2[String(e?.iso3 ?? '')];
    return iso2 && countries.has(iso2);
  });
  // Neutral baseline: 60%. Saturate at 140%+ (80 pct points above neutral).
  const avgDebtPct = inRegionDebt.length
    ? inRegionDebt.reduce((sum, e) => sum + num(e.debtToGdp), 0) / inRegionDebt.length
    : 60;
  const cDebt = clip((avgDebtPct - 60) / 80, 0, 1);

  // economic:stress-index:v1 shape: { compositeScore, label, components, ... }
  // Single global object (US-based FRED composite on 0-100 scale), NOT per-country.
  // Apply as a global overlay that scales every region's capital_stress equally.
  const stress = sources['economic:stress-index:v1'];
  const stressComposite = num(stress?.compositeScore);
  const cStress = clip(stressComposite / 100, 0, 1);

  // Sanctions count proxy: not in default sources, leave at 0 for Phase 0.
  const cSanctions = 0;

  const score = 0.25 * cMacro + 0.20 * cDebt + 0.30 * cStress + 0.25 * cSanctions;

  if (cMacro > 0.6) {
    drivers.push({
      axis: 'capital_stress',
      description: `Macro signals verdict: ${verdict}`,
      magnitude: round(cMacro),
      evidence_ids: ['macro:verdict'],
      orientation: 'pressure',
    });
  }
  if (cDebt > 0.4) {
    drivers.push({
      axis: 'capital_stress',
      description: `Regional debt/GDP average: ${avgDebtPct.toFixed(0)}% across ${inRegionDebt.length} countries`,
      magnitude: round(cDebt),
      evidence_ids: ['debt:region-avg'],
      orientation: 'pressure',
    });
  }
  if (cStress > 0.5) {
    drivers.push({
      axis: 'capital_stress',
      description: `Global stress index: ${stressComposite.toFixed(0)} (${stress?.label ?? 'n/a'})`,
      magnitude: round(cStress),
      evidence_ids: ['stress:composite'],
      orientation: 'pressure',
    });
  }

  return clip(score, 0, 1);
}

function computeEnergyVulnerability(countries, sources, drivers) {
  // energy:mix:v1:_all shape: Record<ISO2, {
  //   year, coalShare, gasShare, oilShare, nuclearShare, renewShare,
  //   windShare, solarShare, hydroShare, importShare: number|null
  // }>
  // Values are OWID PERCENTAGES (0-100), not 0-1 fractions. Field is
  // `importShare`, not `imported`. Countries with null importShare are
  // excluded from the average (not treated as zero).
  const mix = sources['energy:mix:v1:_all'];
  if (!mix || typeof mix !== 'object') return 0;
  const entries = Object.entries(mix).filter(([iso]) => countries.has(iso));
  if (!entries.length) return 0;

  // Vulnerability = 0.5 * import share + 0.25 * (1 - storage proxy) + 0.25 * (1 - SPR proxy)
  // Phase 0: only import share is reliably present per-country.
  let totalImport = 0;
  let validCount = 0;
  for (const [, m] of entries) {
    if (m == null || m.importShare == null) continue;
    totalImport += clip(num(m.importShare) / 100, 0, 1);
    validCount += 1;
  }
  const avgImport = validCount > 0 ? totalImport / validCount : 0;

  // Storage proxy from EU gas storage (single number for EU region)
  const euGas = sources['economic:eu-gas-storage:v1'];
  const months = Array.isArray(euGas?.months) ? euGas.months : [];
  const latestFill = months.length ? num(months[months.length - 1]?.fillPct) / 100 : null;
  const cStorage = latestFill !== null ? 1 - clip(latestFill / 0.8, 0, 1) : 0.5;

  // SPR proxy
  const spr = sources['economic:spr:v1'];
  const sprDays = num(spr?.daysOfCover, 90);
  const cSpr = 1 - clip(sprDays / 90, 0, 1);

  const score = 0.5 * avgImport + 0.25 * cStorage + 0.25 * cSpr;

  if (avgImport > 0.4 && validCount > 0) {
    drivers.push({
      axis: 'energy_vulnerability',
      description: `Average import dependency ${(avgImport * 100).toFixed(0)}% across ${validCount} countries`,
      magnitude: round(avgImport),
      evidence_ids: ['energy:mix'],
      orientation: 'pressure',
    });
  }

  return clip(score, 0, 1);
}

function computeAllianceCohesion(regionId, sources, drivers) {
  // Phase 0: rough alliance signal from forecast actor lenses.
  // No headline classification yet (deferred to Phase 1 LLM batch tagging).
  const fc = sources['forecast:predictions:v2'];
  const forecasts = Array.isArray(fc?.predictions) ? fc.predictions : [];
  const region = REGIONS.find((r) => r.id === regionId);
  const inRegion = forecasts.filter((f) => {
    const fRegion = String(f?.region ?? '').toLowerCase();
    return fRegion.includes(String(region?.forecastLabel ?? '').toLowerCase());
  });
  const allianceRefs = inRegion.filter((f) => {
    const cf = JSON.stringify(f?.caseFile ?? {}).toLowerCase();
    return /alliance|treaty|coordination|coalition|nato|gcc/.test(cf);
  }).length;

  const cActor = clip(allianceRefs / 5, 0, 1);
  // Baseline: assume neutral cohesion if no data
  const score = 0.4 * cActor + 0.6 * 0.5;

  if (cActor > 0.2) {
    drivers.push({
      axis: 'alliance_cohesion',
      description: `${allianceRefs} forecast actor lenses reference alliance dynamics`,
      magnitude: round(cActor),
      evidence_ids: [],
      orientation: 'buffer',
    });
  }

  return clip(score, 0, 1);
}

function computeMaritimeAccess(corridors, sources, drivers) {
  if (!corridors.length) return 0.7; // Inland regions: assume neutral-good

  const chokepointData = sources['supply_chain:chokepoints:v4'];
  const allCps = Array.isArray(chokepointData?.chokepoints) ? chokepointData.chokepoints : [];
  const cpById = new Map();
  for (const cp of allCps) cpById.set(String(cp?.id ?? ''), cp);

  const transitData = sources['supply_chain:transit-summaries:v1'];
  const summaries = transitData?.summaries ?? {};

  let weightedSum = 0;
  let totalWeight = 0;

  for (const corridor of corridors) {
    if (!corridor.chokepointId) continue;
    const cp = cpById.get(corridor.chokepointId);
    if (!cp) continue;

    const threatLevel = String(cp?.threatLevel ?? cp?.status ?? 'normal').toLowerCase();
    const threatMap = { war_zone: 0.0, critical: 0.2, high: 0.4, elevated: 0.6, normal: 1.0 };
    const mThreat = threatMap[threatLevel] ?? 0.7;

    const summary = summaries[corridor.chokepointId];
    const wow = num(summary?.wowChangePct, 0);
    const mThroughput = clip((100 + wow) / 120, 0, 1); // 0% change -> 0.83, +20% -> 1.0

    const mCorridor = 0.6 * mThreat + 0.4 * mThroughput;
    weightedSum += mCorridor * corridor.weight;
    totalWeight += corridor.weight;

    if (mThreat < 0.6) {
      drivers.push({
        axis: 'maritime_access',
        description: `${corridor.label} threat level: ${threatLevel}`,
        magnitude: round(1 - mThreat),
        evidence_ids: [`chokepoint:${corridor.chokepointId}`],
        orientation: 'buffer',
      });
    }
  }

  return totalWeight > 0 ? clip(weightedSum / totalWeight, 0, 1) : 0.7;
}

function computeEnergyLeverage(countries, drivers) {
  // Producer leverage = max across region's producers
  const TOP_PRODUCERS = new Set(['SA', 'RU', 'US', 'IR', 'IQ', 'AE', 'CA', 'KW', 'QA', 'NG', 'NO', 'BR', 'MX', 'VE', 'AU']);
  const inRegion = [...countries].filter((c) => TOP_PRODUCERS.has(c));
  if (!inRegion.length) return 0;

  // Phase 0: simple presence-based leverage. Sophistication arrives in Phase 1.
  const baseLeverage = 0.6;
  const score = inRegion.length >= 3 ? Math.min(1, baseLeverage + 0.1 * inRegion.length) : baseLeverage;

  drivers.push({
    axis: 'energy_leverage',
    description: `${inRegion.length} top-15 producers in region: ${inRegion.join(', ')}`,
    magnitude: round(score),
    evidence_ids: inRegion.map((iso) => `producer:${iso}`),
    orientation: 'buffer',
  });

  return clip(score, 0, 1);
}

function round(n) {
  return Math.round(n * 1000) / 1000;
}
