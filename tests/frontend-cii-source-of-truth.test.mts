import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');

function readSrc(path: string): string {
  return readFileSync(resolve(root, path), 'utf8');
}

function extractMethod(src: string, signature: string): string {
  const start = src.indexOf(signature);
  assert.notEqual(start, -1, `missing method signature: ${signature}`);
  const bodyStart = src.indexOf('{', start);
  assert.notEqual(bodyStart, -1, `missing method body: ${signature}`);

  let depth = 0;
  for (let i = bodyStart; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth++;
    if (ch === '}') depth--;
    if (depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`unterminated method body: ${signature}`);
}

describe('frontend CII source of truth', () => {
  it('keeps cached backend CII authoritative until the explicit force-local path', () => {
    const src = readSrc('src/app/data-loader.ts');
    const refreshBody = extractMethod(src, 'private refreshCiiAndBrief(forceLocal = false): void');

    assert.match(src, /private cachedRiskScores: CachedRiskScores \| null = null;/);
    assert.match(src, /private preferLocalCii = false;/);
    assert.match(src, /private getAuthoritativeCachedRiskScores\(forceLocal: boolean\): CachedRiskScores \| null/);
    assert.match(src, /if \(forceLocal\) \{[\s\S]*this\.preferLocalCii = true;[\s\S]*return null;[\s\S]*\}/);
    assert.match(src, /const hasLocalCiiData = hasAnyIntelligenceData\(\);[\s\S]*if \(hasLocalCiiData\) \{[\s\S]*setIntelligenceSignalsLoaded\(\);[\s\S]*\}[\s\S]*this\.refreshCiiAndBrief\(hasLocalCiiData\);/);
    assert.doesNotMatch(src, /this\.refreshCiiAndBrief\(true\);/);

    assert.match(refreshBody, /const cached = this\.getAuthoritativeCachedRiskScores\(forceLocal\);/);
    assert.match(refreshBody, /if \(cached\) \{[\s\S]*this\.renderCachedCiiScores\(cached\);[\s\S]*return;[\s\S]*\}/);
    assert.match(refreshBody, /const scores = calculateCII\(\);[\s\S]*this\.applyCiiScoresToMap\(scores\);/);
  });

  it('renders Strategic Risk from cached strategic risk/CII instead of only marking the badge cached', () => {
    const src = readSrc('src/components/StrategicRiskPanel.ts');
    const refreshBody = extractMethod(src, 'public async refresh(): Promise<boolean>');

    assert.match(src, /private applyCachedRiskOverview\(cached: CachedRiskScores, localOverview: StrategicRiskOverview\): void/);
    assert.match(src, /compositeScore: Math\.max\(0, Math\.min\(100, Math\.round\(cached\.strategicRisk\.score\)\)\)/);
    assert.match(src, /unstableCountries: ciiScores\.filter\(s => s\.score >= 50\)\.slice\(0, 5\)/);
    assert.match(refreshBody, /this\.applyCachedRiskOverview\(cached, localOverview\);[\s\S]*this\.usedCachedScores = true;/);
    assert.match(refreshBody, /if \(this\.usedCachedScores\) \{[\s\S]*this\.setDataBadge\('cached', badgeDetail\);[\s\S]*\} else if \(!this\.freshnessSummary \|\| this\.freshnessSummary\.activeSources === 0\) \{[\s\S]*this\.setDataBadge\('unavailable'\);/);
  });

  it('uses cached CII for story data until local intelligence ingestion is ready', () => {
    const src = readSrc('src/services/story-data.ts');

    assert.match(src, /hasIntelligenceSignalsLoaded/);
    assert.match(src, /getCachedScores/);
    assert.match(src, /toCountryScore/);
    assert.match(src, /if \(!hasIntelligenceSignalsLoaded\(\)\) \{[\s\S]*getCachedScores\(\)\?\.cii\.find[\s\S]*toCountryScore\(cached\);[\s\S]*\}/);
    assert.match(src, /if \(!countryScore\) \{[\s\S]*const scores = calculateCII\(\);[\s\S]*\}/);
  });
});
