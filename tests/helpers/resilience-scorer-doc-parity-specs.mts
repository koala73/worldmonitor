import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { IndicatorSpec } from '../../server/worldmonitor/resilience/v1/_indicator-registry.ts';
import { INDICATOR_REGISTRY } from '../../server/worldmonitor/resilience/v1/_indicator-registry.ts';
import { MACRO_FISCAL_INDICATOR_WEIGHTS } from '../../server/worldmonitor/resilience/v1/_macro-fiscal-weights.ts';
import type { ResilienceDimensionId } from '../../server/worldmonitor/resilience/v1/_dimension-scorers.ts';

export type ScorerParityExtraction = 'scorer-source' | 'non-linear-allowlist' | 'custom-source';

export interface ScorerDocParityIndicatorSpec {
  id: string;
  dimension: ResilienceDimensionId;
  methodologySection: string;
  methodologyDirection: string;
  registryDirection: IndicatorSpec['direction'];
  methodologyGoalposts: string;
  registryGoalposts: IndicatorSpec['goalposts'];
  weight: number;
  sourceKey?: string;
  tier?: IndicatorSpec['tier'];
  normalizationKind: NonNullable<IndicatorSpec['normalization']>['kind'];
  extraction: ScorerParityExtraction;
}

interface ScorerTableBinding {
  methodologySection: string;
  dimension: ResilienceDimensionId;
  scorerName: string;
  ids: readonly string[];
}

const here = dirname(fileURLToPath(import.meta.url));
const SCORER_SOURCE_PATH = resolve(here, '../../server/worldmonitor/resilience/v1/_dimension-scorers.ts');
const SCORER_SOURCE = readFileSync(SCORER_SOURCE_PATH, 'utf8');

const SCORER_TABLE_BINDINGS = [
  {
    methodologySection: 'Macro-Fiscal',
    dimension: 'macroFiscal',
    scorerName: 'scoreMacroFiscal',
    ids: ['govRevenuePct', 'debtGrowthRate', 'currentAccountPct', 'unemploymentPct', 'householdDebtService'],
  },
  {
    methodologySection: 'Currency & External',
    dimension: 'currencyExternal',
    scorerName: 'scoreCurrencyExternal',
    ids: ['inflationStability', 'fxReservesAdequacy'],
  },
  {
    methodologySection: 'Trade Policy',
    dimension: 'tradePolicy',
    scorerName: 'scoreTradePolicy',
    ids: ['tradeRestrictions', 'tradeBarriers', 'appliedTariffRate'],
  },
  {
    methodologySection: 'Financial System Exposure',
    dimension: 'financialSystemExposure',
    scorerName: 'scoreFinancialSystemExposure',
    ids: ['shortTermExternalDebtPctGni', 'bisLbsXborderPctGdp', 'fatfListingStatus', 'financialCenterRedundancy'],
  },
  {
    methodologySection: 'Cyber & Digital',
    dimension: 'cyberDigital',
    scorerName: 'scoreCyberDigital',
    ids: ['cyberThreats', 'internetOutages', 'gpsJamming'],
  },
  {
    methodologySection: 'Infrastructure',
    dimension: 'infrastructure',
    scorerName: 'scoreInfrastructure',
    ids: ['electricityAccess', 'roadsPavedInfra', 'infraOutages', 'broadband'],
  },
  {
    methodologySection: 'Conflict & Displacement',
    dimension: 'borderSecurity',
    scorerName: 'scoreBorderSecurity',
    ids: ['ucdpConflict', 'displacementHosted'],
  },
  {
    methodologySection: 'Information & Cognitive',
    dimension: 'informationCognitive',
    scorerName: 'scoreInformationCognitive',
    ids: ['rsfPressFreedom', 'socialVelocity', 'newsThreatScore'],
  },
  {
    methodologySection: 'Health & Public Service',
    dimension: 'healthPublicService',
    scorerName: 'scoreHealthPublicService',
    ids: ['uhcIndex', 'measlesCoverage', 'hospitalBeds', 'physiciansPer1k', 'healthExpPerCapitaUsd'],
  },
  {
    methodologySection: 'Food & Water',
    dimension: 'foodWater',
    scorerName: 'scoreFoodWater',
    ids: ['ipcPeopleInCrisis', 'ipcPhase', 'aquastatScore'],
  },
  {
    methodologySection: 'Fiscal Space',
    dimension: 'fiscalSpace',
    scorerName: 'scoreFiscalSpace',
    ids: ['recoveryGovRevenue', 'recoveryFiscalBalance', 'recoveryDebtToGdp', 'debtSustainabilityGap'],
  },
  {
    methodologySection: 'Liquid Reserve Adequacy',
    dimension: 'liquidReserveAdequacy',
    scorerName: 'scoreLiquidReserveAdequacy',
    ids: ['recoveryLiquidReserveMonths'],
  },
  {
    methodologySection: 'Sovereign Fiscal Buffer',
    dimension: 'sovereignFiscalBuffer',
    scorerName: 'scoreSovereignFiscalBuffer',
    ids: ['recoverySovereignWealthEffectiveMonths'],
  },
  {
    methodologySection: 'External Debt Coverage',
    dimension: 'externalDebtCoverage',
    scorerName: 'scoreExternalDebtCoverage',
    ids: ['recoveryDebtToReserves'],
  },
  {
    methodologySection: 'Import Concentration',
    dimension: 'importConcentration',
    scorerName: 'scoreImportConcentration',
    ids: ['recoveryImportHhi'],
  },
  {
    methodologySection: 'State Continuity',
    dimension: 'stateContinuity',
    scorerName: 'scoreStateContinuity',
    ids: ['recoveryWgiContinuity', 'recoveryConflictPressure', 'recoveryDisplacementVelocity'],
  },
] as const satisfies readonly ScorerTableBinding[];

export const SCORER_DOC_PARITY_UNSUPPORTED_DIMENSIONS = [
  'logisticsSupply',
  'energy',
  'governanceInstitutional',
  'socialCohesion',
  'reserveAdequacy',
  'fuelStockDays',
] as const satisfies readonly ResilienceDimensionId[];

export const SCORER_DOC_PARITY_NON_LINEAR_IDS = [
  'inflationStability',
  'bisLbsXborderPctGdp',
  'fatfListingStatus',
  'recoverySovereignWealthEffectiveMonths',
] as const;

const NON_LINEAR_DOC_METADATA = {
  inflationStability: {
    methodologyDirection: '1-3% target band is best',
    methodologyGoalposts: '<= -5 or >= 50 -> 0; 1-3 -> 100',
  },
  bisLbsXborderPctGdp: {
    methodologyDirection: 'Lower is better (U-shape)',
    methodologyGoalposts: '60 - 25',
  },
  fatfListingStatus: {
    methodologyDirection: 'Higher is better',
    methodologyGoalposts: '0 - 100',
  },
  recoverySovereignWealthEffectiveMonths: {
    methodologyDirection: 'Higher is better',
    methodologyGoalposts: '0 - 60',
  },
} as const satisfies Record<(typeof SCORER_DOC_PARITY_NON_LINEAR_IDS)[number], {
  methodologyDirection: string;
  methodologyGoalposts: string;
}>;

export const STATIC_SCORER_CATALOG_PARITY_IDS = [
  'broadband',
  'physiciansPer1k',
  'healthExpPerCapitaUsd',
] as const;

const REGISTRY_BY_ID = new Map(INDICATOR_REGISTRY.map((spec) => [spec.id, spec]));

export const SCORER_DOC_PARITY_SPECS = buildScorerDocParitySpecs();

export function scorerDocParitySpecsBySection(): Map<string, readonly ScorerDocParityIndicatorSpec[]> {
  const bySection = new Map<string, ScorerDocParityIndicatorSpec[]>();
  for (const spec of SCORER_DOC_PARITY_SPECS) {
    const specs = bySection.get(spec.methodologySection) ?? [];
    specs.push(spec);
    bySection.set(spec.methodologySection, specs);
  }
  return bySection;
}

function buildScorerDocParitySpecs(): readonly ScorerDocParityIndicatorSpec[] {
  const specs: ScorerDocParityIndicatorSpec[] = [];
  for (const binding of SCORER_TABLE_BINDINGS) {
    if (binding.scorerName === 'scoreCurrencyExternal') {
      specs.push(...extractCurrencyExternalSpecs(binding));
      continue;
    }
    if (binding.scorerName === 'scoreFoodWater') {
      specs.push(...extractFoodWaterSpecs(binding));
      continue;
    }

    const entries = extractWeightedBlendEntries(binding.scorerName);
    assert.equal(
      entries.length,
      binding.ids.length,
      `${binding.scorerName} expected ${binding.ids.length} scorer rows for ${binding.ids.join(', ')}, found ${entries.length}. ` +
        'Update the extraction binding or add the scorer to SCORER_DOC_PARITY_UNSUPPORTED_DIMENSIONS with a rationale.',
    );

    binding.ids.forEach((id, index) => {
      specs.push(buildSpecFromEntry(binding, id, entries[index]!));
    });
  }
  return specs;
}

function extractCurrencyExternalSpecs(binding: ScorerTableBinding): readonly ScorerDocParityIndicatorSpec[] {
  const functionBody = extractFunctionBody(binding.scorerName);
  const blendMatch = /inflationScore!\s*\*\s*([0-9.]+)\s*\+\s*reservesScore\s*\*\s*([0-9.]+)/.exec(functionBody);
  assert.ok(blendMatch, 'scoreCurrencyExternal must expose the inflation/reserves blend weights in source.');

  const reservesFunction = extractFunctionBody('scoreFxReserves');
  const reservesNormalize = extractNormalizer(reservesFunction, 'fxReservesAdequacy');
  assert.equal(reservesNormalize.direction, 'higherBetter');

  return [
    buildSpecFromRegistry(binding, 'inflationStability', {
      weight: Number(blendMatch[1]),
      extraction: 'custom-source',
    }),
    buildSpecFromRegistry(binding, 'fxReservesAdequacy', {
      weight: Number(blendMatch[2]),
      extraction: 'custom-source',
      registryDirection: reservesNormalize.direction,
      registryGoalposts: reservesNormalize.goalposts,
      methodologyDirection: 'Higher is better',
      methodologyGoalposts: formatGoalposts(reservesNormalize.goalposts),
      normalizationKind: 'linear',
    }),
  ];
}

function extractFoodWaterSpecs(binding: ScorerTableBinding): readonly ScorerDocParityIndicatorSpec[] {
  const entries = extractWeightedBlendEntries(binding.scorerName, 'last');
  assert.equal(entries.length, binding.ids.length, 'scoreFoodWater final weightedBlend must expose IPC, phase, and AQUASTAT rows.');

  return [
    buildSpecFromEntry(binding, 'ipcPeopleInCrisis', entries[0]!, 'custom-source'),
    buildSpecFromEntry(binding, 'ipcPhase', entries[1]!, 'custom-source'),
    buildSpecFromRegistry(binding, 'aquastatScore', {
      weight: extractWeight(entries[2]!, 'aquastatScore'),
      extraction: 'custom-source',
      methodologyDirection: 'Indicator semantics',
      methodologyGoalposts: 'Indicator-dependent',
      normalizationKind: 'discrete',
    }),
  ];
}

function buildSpecFromEntry(
  binding: ScorerTableBinding,
  id: string,
  entry: string,
  extraction: ScorerParityExtraction = 'scorer-source',
): ScorerDocParityIndicatorSpec {
  const weight = extractWeight(entry, id);
  if (isNonLinearId(id)) {
    return buildSpecFromRegistry(binding, id, { weight, extraction: 'non-linear-allowlist' });
  }

  const normalize = extractNormalizer(entry, id);
  return buildSpecFromRegistry(binding, id, {
    weight,
    extraction,
    registryDirection: normalize.direction,
    registryGoalposts: normalize.goalposts,
    methodologyDirection: normalize.direction === 'higherBetter' ? 'Higher is better' : 'Lower is better',
    methodologyGoalposts: formatGoalposts(normalize.goalposts),
    normalizationKind: 'linear',
  });
}

function buildSpecFromRegistry(
  binding: ScorerTableBinding,
  id: string,
  override: {
    weight: number;
    extraction: ScorerParityExtraction;
    registryDirection?: IndicatorSpec['direction'];
    registryGoalposts?: IndicatorSpec['goalposts'];
    methodologyDirection?: string;
    methodologyGoalposts?: string;
    normalizationKind?: NonNullable<IndicatorSpec['normalization']>['kind'];
  },
): ScorerDocParityIndicatorSpec {
  const registry = REGISTRY_BY_ID.get(id);
  assert.ok(registry, `${id} missing from INDICATOR_REGISTRY.`);
  assert.equal(registry.dimension, binding.dimension, `${id} registry dimension must be ${binding.dimension}.`);
  const nonLinear = isNonLinearId(id) ? NON_LINEAR_DOC_METADATA[id] : null;
  return {
    id,
    dimension: binding.dimension,
    methodologySection: binding.methodologySection,
    methodologyDirection: override.methodologyDirection ?? nonLinear?.methodologyDirection ?? directionLabel(registry.direction),
    registryDirection: override.registryDirection ?? registry.direction,
    methodologyGoalposts: override.methodologyGoalposts ?? nonLinear?.methodologyGoalposts ?? formatGoalposts(registry.goalposts),
    registryGoalposts: override.registryGoalposts ?? registry.goalposts,
    weight: override.weight,
    sourceKey: registry.sourceKey,
    tier: registry.tier,
    normalizationKind: override.normalizationKind ?? registry.normalization?.kind ?? 'linear',
    extraction: override.extraction,
  };
}

function extractWeightedBlendEntries(scorerName: string, occurrence: 'first' | 'last' = 'first'): string[] {
  const functionBody = extractFunctionBody(scorerName);
  let callStart = occurrence === 'first'
    ? functionBody.indexOf('return weightedBlend(')
    : functionBody.lastIndexOf('return weightedBlend(');
  if (callStart === -1) {
    callStart = occurrence === 'first'
      ? functionBody.indexOf('weightedBlend([')
      : functionBody.lastIndexOf('weightedBlend([');
  }
  assert.notEqual(callStart, -1, `${scorerName} does not call weightedBlend in the extractable source shape.`);
  const openParen = functionBody.indexOf('(', callStart);
  const closeParen = findMatchingDelimiter(functionBody, openParen, '(', ')');
  const callArg = functionBody.slice(openParen + 1, closeParen).trim();
  assert.ok(callArg.startsWith('['), `${scorerName} weightedBlend argument must be an array literal.`);
  const closeBracket = findMatchingDelimiter(callArg, 0, '[', ']');
  return splitTopLevel(stripLineComments(callArg.slice(1, closeBracket)));
}

function extractFunctionBody(functionName: string): string {
  const nameIndex = SCORER_SOURCE.indexOf(`function ${functionName}`);
  assert.notEqual(nameIndex, -1, `Function ${functionName} not found in ${SCORER_SOURCE_PATH}.`);
  const openBrace = SCORER_SOURCE.indexOf('{', nameIndex);
  assert.notEqual(openBrace, -1, `Function ${functionName} body not found in ${SCORER_SOURCE_PATH}.`);
  const closeBrace = findMatchingDelimiter(SCORER_SOURCE, openBrace, '{', '}');
  return SCORER_SOURCE.slice(openBrace + 1, closeBrace);
}

function extractWeight(entry: string, indicatorId: string): number {
  const match = /\bnominalWeight:\s*([^,}\n]+)/.exec(entry) ?? /\bweight:\s*([^,}\n]+)/.exec(entry);
  assert.ok(match, `No weight field found for scorer row ${indicatorId}.`);
  const expression = match[1].trim();
  const macroMatch = /^MACRO_FISCAL_INDICATOR_WEIGHTS\.([A-Za-z0-9_]+)$/.exec(expression);
  if (macroMatch) {
    const key = macroMatch[1] as keyof typeof MACRO_FISCAL_INDICATOR_WEIGHTS;
    const value = MACRO_FISCAL_INDICATOR_WEIGHTS[key];
    assert.equal(typeof value, 'number', `Unknown macro-fiscal weight ${expression} for ${indicatorId}.`);
    return value;
  }
  const numeric = Number(expression);
  assert.ok(Number.isFinite(numeric), `Unsupported weight expression "${expression}" for ${indicatorId}.`);
  return numeric;
}

function extractNormalizer(
  source: string,
  indicatorId: string,
): { direction: IndicatorSpec['direction']; goalposts: IndicatorSpec['goalposts'] } {
  const higherCall = findCall(source, 'normalizeHigherBetter');
  const lowerCall = findCall(source, 'normalizeLowerBetter');
  assert.ok(
    !(higherCall && lowerCall),
    `${indicatorId} mixes normalizeHigherBetter and normalizeLowerBetter in one scorer entry. Add an explicit extractor or non-linear allowlist entry instead of guessing direction.`,
  );
  const call = higherCall ?? lowerCall;
  assert.ok(
    call,
    `No linear normalizer found for ${indicatorId}. If this scorer is intentionally non-linear, add it to SCORER_DOC_PARITY_NON_LINEAR_IDS.`,
  );
  const args = splitTopLevel(call.args);
  assert.ok(args.length >= 3, `${indicatorId} ${call.name} call must have at least three arguments.`);
  const firstAnchor = Number(args[args.length - 2]!.trim());
  const secondAnchor = Number(args[args.length - 1]!.trim());
  assert.ok(
    Number.isFinite(firstAnchor) && Number.isFinite(secondAnchor),
    `${indicatorId} ${call.name} anchors must be numeric literals; got ${args.slice(-2).join(', ')}.`,
  );
  if (call.name === 'normalizeHigherBetter') {
    return { direction: 'higherBetter', goalposts: { worst: firstAnchor, best: secondAnchor } };
  }
  return { direction: 'lowerBetter', goalposts: { worst: secondAnchor, best: firstAnchor } };
}

export function extractLinearNormalizerForTest(
  source: string,
  indicatorId: string,
): { direction: IndicatorSpec['direction']; goalposts: IndicatorSpec['goalposts'] } {
  return extractNormalizer(source, indicatorId);
}

function findCall(source: string, name: 'normalizeHigherBetter' | 'normalizeLowerBetter'): { name: typeof name; args: string } | null {
  const nameIndex = source.indexOf(`${name}(`);
  if (nameIndex === -1) return null;
  const openParen = source.indexOf('(', nameIndex);
  const closeParen = findMatchingDelimiter(source, openParen, '(', ')');
  return { name, args: source.slice(openParen + 1, closeParen) };
}

function splitTopLevel(source: string): string[] {
  const entries: string[] = [];
  let start = 0;
  let curly = 0;
  let square = 0;
  let paren = 0;
  let quote: '"' | "'" | '`' | null = null;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i]!;
    const prev = i > 0 ? source[i - 1] : '';
    if (quote) {
      if (ch === quote && prev !== '\\') quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '{') curly += 1;
    else if (ch === '}') curly -= 1;
    else if (ch === '[') square += 1;
    else if (ch === ']') square -= 1;
    else if (ch === '(') paren += 1;
    else if (ch === ')') paren -= 1;
    else if (ch === ',' && curly === 0 && square === 0 && paren === 0) {
      const entry = source.slice(start, i).trim();
      if (entry) entries.push(entry);
      start = i + 1;
    }
  }
  const tail = source.slice(start).trim();
  if (tail) entries.push(tail);
  return entries;
}

function stripLineComments(source: string): string {
  return source
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');
}

function findMatchingDelimiter(source: string, openIndex: number, open: string, close: string): number {
  assert.equal(source[openIndex], open, `Expected "${open}" at index ${openIndex}.`);
  let depth = 0;
  let quote: '"' | "'" | '`' | null = null;
  for (let i = openIndex; i < source.length; i += 1) {
    const ch = source[i]!;
    const prev = i > 0 ? source[i - 1] : '';
    if (quote) {
      if (ch === quote && prev !== '\\') quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      continue;
    }
    // Skip comments so parens/braces in prose (e.g. "(no explicit weight transfer)")
    // do not desync the delimiter depth counter.
    if (ch === '/' && source[i + 1] === '/') {
      const newline = source.indexOf('\n', i + 2);
      if (newline === -1) break;
      i = newline;
      continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      if (end === -1) break;
      i = end + 1;
      continue;
    }
    if (ch === open) depth += 1;
    if (ch === close) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  throw new Error(`No matching "${close}" found for "${open}" at index ${openIndex}.`);
}

function directionLabel(direction: IndicatorSpec['direction']): string {
  return direction === 'higherBetter' ? 'Higher is better' : 'Lower is better';
}

function formatGoalposts(goalposts: IndicatorSpec['goalposts']): string {
  return `${formatNumber(goalposts.worst)} - ${formatNumber(goalposts.best)}`;
}

function formatNumber(value: number): string {
  return String(value);
}

function isNonLinearId(id: string): id is (typeof SCORER_DOC_PARITY_NON_LINEAR_IDS)[number] {
  return (SCORER_DOC_PARITY_NON_LINEAR_IDS as readonly string[]).includes(id);
}
