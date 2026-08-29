export const COCKPIT_VISION_MODES = Object.freeze(['optical', 'crt', 'nvg', 'thermal', 'noir']);

const TARGET_STYLE_BY_MODE = Object.freeze({
  crt: 'retro',
  nvg: 'surveillance',
  thermal: 'thermal',
  noir: 'noir',
});

/** Normalize a requested Cockpit vision mode to the inherited preset entry. */
export function normalizeCockpitVisionMode(mode) {
  return COCKPIT_VISION_MODES.includes(mode) ? mode : 'optical';
}

/** Settle pending map-style crossfades and return their intended final intensities. */
export function captureCockpitVisionBaseline(stages, transitions) {
  const baseline = {};
  for (const [name, stage] of Object.entries(stages)) {
    const intensity = transitions?.get(name)?.to ?? stage.uniforms.intensity;
    stage.uniforms.intensity = intensity;
    transitions?.delete(name);
    baseline[name] = intensity;
  }
  return baseline;
}

/**
 * Apply Cockpit-only stage intensities without changing any shader parameters.
 * Returns the temporary style whose parameters should be shown, or null.
 */
export function applyCockpitVisionStageIntensities(stages, mode, restore = {}) {
  const next = normalizeCockpitVisionMode(mode);
  if (next === 'optical') {
    for (const [name, intensity] of Object.entries(restore)) {
      if (stages[name]) stages[name].uniforms.intensity = intensity;
    }
    return null;
  }

  for (const stage of Object.values(stages)) stage.uniforms.intensity = 0;
  const target = TARGET_STYLE_BY_MODE[next] || null;
  if (target && stages[target]) stages[target].uniforms.intensity = 1;
  return target;
}
