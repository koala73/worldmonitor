import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { transformSync } from 'esbuild';

import { ciiBandForLevel } from '../src/components/CountryDeepDivePanel-cii.ts';

const root = resolve(import.meta.dirname, '..');

async function loadCanonicalLevelMapper(): Promise<(score: number) => 'low' | 'normal' | 'elevated' | 'high' | 'critical'> {
  const source = readFileSync(resolve(root, 'src/services/cached-risk-scores.ts'), 'utf8');
  const match = source.match(/function getScoreLevel\(score: number\):[^\{]+\{[\s\S]*?\n\}/);
  assert.ok(match, 'canonical cached-score level mapper must exist');

  const transformed = transformSync(`${match[0]}\nexport { getScoreLevel };`, {
    loader: 'ts',
    format: 'esm',
    target: 'es2022',
  });
  const dataUrl = `data:text/javascript;base64,${Buffer.from(transformed.code).toString('base64')}`;
  const module = await import(dataUrl) as { getScoreLevel: (score: number) => 'low' | 'normal' | 'elevated' | 'high' | 'critical' };
  return module.getScoreLevel;
}

describe('CountryDeepDivePanel canonical CII bands', () => {
  it('renders the canonical level at every boundary without recalculating thresholds', async () => {
    const getScoreLevel = await loadCanonicalLevelMapper();
    const cases = [
      { score: 30, level: 'low', band: 'stable' },
      { score: 31, level: 'normal', band: 'stable' },
      { score: 50, level: 'normal', band: 'stable' },
      { score: 51, level: 'elevated', band: 'elevated' },
      { score: 65, level: 'elevated', band: 'elevated' },
      { score: 66, level: 'high', band: 'high' },
      { score: 80, level: 'high', band: 'high' },
      { score: 81, level: 'critical', band: 'critical' },
    ] as const;

    for (const { score, level, band } of cases) {
      const canonicalLevel = getScoreLevel(score);
      assert.equal(canonicalLevel, level, `canonical level for ${score}`);
      assert.equal(ciiBandForLevel(canonicalLevel), band, `deep-dive band for ${score}`);
    }
  });

  it('uses score.level at both render sites instead of local numeric cutoffs', () => {
    const source = readFileSync(resolve(root, 'src/components/CountryDeepDivePanel.ts'), 'utf8');
    assert.equal(source.match(/ciiBandForLevel\(score\.level\)/g)?.length, 2);
    assert.doesNotMatch(source, /ciiBandForLevel\(score\.score\)/);
    assert.doesNotMatch(source, /private ciiBand\(/);
  });
});
