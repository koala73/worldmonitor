import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyCockpitVisionStageIntensities,
  captureCockpitVisionBaseline,
  COCKPIT_VISION_MODES,
  normalizeCockpitVisionMode,
} from './cockpitVisionPolicy.js';

const createStages = () => ({
  noir: { uniforms: { intensity: 0.72, contrast: 1.3 } },
  retro: { uniforms: { intensity: 0.18, gain: 0.4 } },
  surveillance: { uniforms: { intensity: 0, grain: 0.6 } },
  thermal: { uniforms: { intensity: 0, heat: 0.8 } },
});

test('Cockpit vision order exposes inherited, CRT, NVG, FLIR, and NOIR modes', () => {
  assert.deepEqual(COCKPIT_VISION_MODES, ['optical', 'crt', 'nvg', 'thermal', 'noir']);
  assert.equal(normalizeCockpitVisionMode('none'), 'optical');
  assert.equal(normalizeCockpitVisionMode('unknown'), 'optical');
});

test('Cockpit settles pending map crossfades before a temporary preset takes ownership', () => {
  const stages = createStages();
  const transitions = new Map([
    ['noir', { from: 0, to: 1, start: 10 }],
    ['retro', { from: 1, to: 0, start: 10 }],
  ]);
  const restore = captureCockpitVisionBaseline(stages, transitions);
  assert.deepEqual(restore, { noir: 1, retro: 0, surveillance: 0, thermal: 0 });
  assert.equal(transitions.size, 0);
  applyCockpitVisionStageIntensities(stages, 'nvg', restore);
  assert.equal(stages.surveillance.uniforms.intensity, 1);
  applyCockpitVisionStageIntensities(stages, 'optical', restore);
  assert.equal(stages.noir.uniforms.intensity, 1);
  assert.equal(stages.retro.uniforms.intensity, 0);
});

test('returning from a temporary preset restores the exact inherited intensities', () => {
  const stages = createStages();
  const restore = Object.fromEntries(
    Object.entries(stages).map(([name, stage]) => [name, stage.uniforms.intensity]),
  );
  applyCockpitVisionStageIntensities(stages, 'thermal', restore);
  applyCockpitVisionStageIntensities(stages, 'optical', restore);
  assert.deepEqual(
    Object.fromEntries(Object.entries(stages).map(([name, stage]) => [name, stage.uniforms.intensity])),
    restore,
  );
});

test('temporary styles replace each other without changing the inherited restore snapshot', () => {
  const stages = createStages();
  const restore = Object.fromEntries(
    Object.entries(stages).map(([name, stage]) => [name, stage.uniforms.intensity]),
  );
  applyCockpitVisionStageIntensities(stages, 'thermal', restore);
  assert.equal(applyCockpitVisionStageIntensities(stages, 'crt', restore), 'retro');
  assert.equal(stages.retro.uniforms.intensity, 1);
  assert.equal(stages.noir.uniforms.intensity, 0);
  applyCockpitVisionStageIntensities(stages, 'optical', restore);
  assert.equal(stages.noir.uniforms.intensity, 0.72);
  assert.equal(stages.retro.uniforms.intensity, 0.18);
});

test('NOIR is a temporary Cockpit override and inherited restores the captured map style', () => {
  const stages = createStages();
  const restore = Object.fromEntries(
    Object.entries(stages).map(([name, stage]) => [name, stage.uniforms.intensity]),
  );
  assert.equal(applyCockpitVisionStageIntensities(stages, 'noir', restore), 'noir');
  assert.equal(stages.noir.uniforms.intensity, 1);
  assert.equal(stages.retro.uniforms.intensity, 0);
  applyCockpitVisionStageIntensities(stages, 'optical', restore);
  assert.equal(stages.noir.uniforms.intensity, 0.72);
  assert.equal(stages.retro.uniforms.intensity, 0.18);
});
