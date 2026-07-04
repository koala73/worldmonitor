import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const __dirname = dirname(fileURLToPath(import.meta.url));
const deckGlMapSrc = readFileSync(resolve(__dirname, '../src/components/DeckGLMap.ts'), 'utf-8');

// positionAlongPath is module-private and DeckGLMap.ts cannot be imported under
// node:test (it pulls in WebGL/maplibre). Extract its source, strip the TS types,
// and eval it in isolation — same source-extraction approach as
// deckgl-interleaved-race-filter.test.mjs.
function extractPositionAlongPath() {
  const start = deckGlMapSrc.indexOf('function positionAlongPath');
  assert.ok(start >= 0, 'positionAlongPath must remain a top-level function in DeckGLMap.ts');
  const braceStart = deckGlMapSrc.indexOf('{', start);
  let depth = 0;
  let end = -1;
  for (let i = braceStart; i < deckGlMapSrc.length; i++) {
    const ch = deckGlMapSrc[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) { end = i + 1; break; }
    }
  }
  assert.ok(end > braceStart, 'positionAlongPath body must have balanced braces');
  const tsSource = deckGlMapSrc.slice(start, end);
  const js = ts.transpileModule(tsSource, {
    compilerOptions: { target: ts.ScriptTarget.ES2020 },
  }).outputText;
  // eslint-disable-next-line no-new-func
  return new Function(`${js}\nreturn positionAlongPath;`)();
}

const positionAlongPath = extractPositionAlongPath();

const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

describe('positionAlongPath (trade-route dot interpolation)', () => {
  it('interpolates linearly along an ordinary segment', () => {
    const [lon, lat] = positionAlongPath([[0, 0], [10, 20]], 0.5);
    assert.ok(near(lon, 5), `lon ${lon} should be 5`);
    assert.ok(near(lat, 10), `lat ${lat} should be 10`);
  });

  it('returns the endpoints at progress 0 and 1', () => {
    assert.deepEqual(positionAlongPath([[0, 0], [10, 20]], 0), [0, 0]);
    assert.deepEqual(positionAlongPath([[0, 0], [10, 20]], 1), [10, 20]);
  });

  it('clamps out-of-range progress to the endpoints', () => {
    assert.deepEqual(positionAlongPath([[0, 0], [10, 20]], -0.5), [0, 0]);
    assert.deepEqual(positionAlongPath([[0, 0], [10, 20]], 2), [10, 20]);
  });

  it('handles single-point and empty paths without throwing', () => {
    assert.deepEqual(positionAlongPath([[42, -7]], 0.5), [42, -7]);
    assert.deepEqual(positionAlongPath([], 0.5), [0, 0]);
  });

  it('picks the correct segment on a multi-point path', () => {
    // 3 points -> 2 segments; progress 0.75 lands at the midpoint of segment 2.
    const [lon, lat] = positionAlongPath([[0, 0], [10, 0], [20, 0]], 0.75);
    assert.ok(near(lon, 15), `lon ${lon} should be 15`);
    assert.ok(near(lat, 0), `lat ${lat} should be 0`);
  });

  // Regression pin for #4396 ADV-1: a great-circle path crossing the antimeridian
  // has adjacent samples that straddle ±180 (e.g. 176 -> -176). A raw longitude
  // lerp would sweep the dot to ~0°E (Gulf of Guinea) for that segment; the fix
  // unwraps the delta so the dot stays on the dateline.
  it('does not teleport across the antimeridian (eastward seam)', () => {
    const [lon] = positionAlongPath([[176, 25], [-176, 26]], 0.5);
    assert.ok(near(Math.abs(lon), 180, 0.5), `lon ${lon} should sit on the ±180 seam, not collapse toward 0`);
    assert.ok(Math.abs(lon) > 170, `lon ${lon} must not drift toward 0°E (the pre-fix teleport bug)`);
  });

  it('does not teleport across the antimeridian (westward seam)', () => {
    const [lon] = positionAlongPath([[-176, 25], [176, 26]], 0.5);
    assert.ok(near(Math.abs(lon), 180, 0.5), `lon ${lon} should sit on the ±180 seam`);
    assert.ok(Math.abs(lon) > 170, `lon ${lon} must not drift toward 0°E`);
  });

  it('keeps the interpolated longitude normalized to [-180, 180]', () => {
    for (const progress of [0.1, 0.25, 0.5, 0.75, 0.9]) {
      const [lon] = positionAlongPath([[170, 10], [-170, 10]], progress);
      assert.ok(lon >= -180 && lon <= 180, `lon ${lon} out of range at progress ${progress}`);
    }
  });
});
