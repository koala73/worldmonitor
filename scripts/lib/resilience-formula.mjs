const CACHE_TO_METHODOLOGY_FORMULA = Object.freeze({
  d6: 'domain-weighted-6d',
  pc: 'pillar-combined-penalized-v1',
});

const KNOWN_CACHE_FORMULAS = new Set(Object.keys(CACHE_TO_METHODOLOGY_FORMULA));
const KNOWN_METHODOLOGY_FORMULAS = new Set(Object.values(CACHE_TO_METHODOLOGY_FORMULA));

// First committed pc validation artifacts were regenerated during the
// 2026-05-28 pillar-combine activation window. A pc-stamped artifact older
// than this is almost certainly stale d6 data with a hand-edited label.
const PC_VALIDATION_ARTIFACT_MIN_GENERATED_AT = Date.parse('2026-05-28T13:30:00.000Z');

function currentCacheFormulaLocal(env = process.env) {
  const combine = (env.RESILIENCE_PILLAR_COMBINE_ENABLED ?? 'false').toLowerCase() === 'true';
  const v2 = (env.RESILIENCE_SCHEMA_V2_ENABLED ?? 'true').toLowerCase() === 'true';
  return combine && v2 ? 'pc' : 'd6';
}

function methodologyFormulaForCacheFormula(cacheFormula) {
  return CACHE_TO_METHODOLOGY_FORMULA[cacheFormula] ?? null;
}

function currentMethodologyFormulaLocal(env = process.env) {
  return methodologyFormulaForCacheFormula(currentCacheFormulaLocal(env));
}

function validationFormulaMetadata(env = process.env) {
  const _formula = currentCacheFormulaLocal(env);
  return {
    _formula,
    methodologyFormula: methodologyFormulaForCacheFormula(_formula),
  };
}

export {
  CACHE_TO_METHODOLOGY_FORMULA,
  KNOWN_CACHE_FORMULAS,
  KNOWN_METHODOLOGY_FORMULAS,
  PC_VALIDATION_ARTIFACT_MIN_GENERATED_AT,
  currentCacheFormulaLocal,
  currentMethodologyFormulaLocal,
  methodologyFormulaForCacheFormula,
  validationFormulaMetadata,
};
