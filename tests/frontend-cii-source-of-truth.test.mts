import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { transformSync } from 'esbuild';

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

let moduleCounter = 0;

async function loadStoryDataForTest() {
  const src = readSrc('src/services/story-data.ts')
    .replace(
      "import { calculateCII, type CountryScore } from './country-instability';",
      `type CountryScore = any;
const calculateCII = () => (globalThis as any).__ciiSourceTruthTest.calculateCII();`,
    )
    .replace(
      "import { getCachedCountryScore, normalizeCiiCountryCode } from './cached-risk-scores';",
      `const getCachedCountryScore = (code: string) => (globalThis as any).__ciiSourceTruthTest.getCachedCountryScore(code);
const normalizeCiiCountryCode = (code: string) => code.toUpperCase();`,
    )
    .replace(
      "import { CURATED_COUNTRIES } from '@/config/countries';",
      `const CURATED_COUNTRIES: Record<string, any> = {};`,
    )
    .replace(
      "import { tokenizeForMatch, matchKeyword } from '@/utils/keyword-match';",
      `const tokenizeForMatch = (value: string) => value.toLowerCase().split(/\\W+/).filter(Boolean);
const matchKeyword = (tokens: string[], keyword: string) => tokens.includes(keyword.toLowerCase());`,
    );

  const transformed = transformSync(src, {
    loader: 'ts',
    format: 'esm',
    target: 'es2022',
  });
  const dataUrl = `data:text/javascript;base64,${Buffer.from(transformed.code).toString('base64')}#${++moduleCounter}`;
  return (await import(dataUrl)) as {
    collectStoryData: (
      countryCode: string,
      countryName: string,
      allNews: unknown[],
      theaterPostures: unknown[],
      predictionMarkets: unknown[],
    ) => { cii: { score: number; level: string; trend: string; change24h: number } | null };
  };
}

function makeScore(score: number) {
  return {
    code: 'IR',
    name: 'Iran',
    score,
    level: score >= 81
      ? 'critical'
      : score >= 66
        ? 'high'
        : score >= 51
          ? 'elevated'
          : score >= 31
            ? 'normal'
            : 'low',
    trend: 'stable',
    change24h: 0,
    components: { unrest: 0, conflict: 0, security: 0, information: 0 },
    lastUpdated: null,
  };
}

describe('frontend CII source of truth', () => {
  it('keeps cached backend CII authoritative until the explicit force-local path', () => {
    const src = readSrc('src/app/data-loader.ts');
    const refreshBody = extractMethod(src, 'private refreshCiiAndBrief(forceLocal = false): void');

    assert.match(src, /private cachedRiskScores: CachedRiskScores \| null = null;/);
    assert.match(src, /private preferLocalCii = false;/);
    assert.match(src, /private getAuthoritativeCachedRiskScores\(forceLocal: boolean\): CachedRiskScores \| null/);
    assert.match(src, /if \(forceLocal\) \{[\s\S]*this\.preferLocalCii = true;[\s\S]*return null;[\s\S]*\}/);
    assert.match(src, /const hasLocalCiiData = hasAnyIntelligenceData\(\);[\s\S]*if \(hasLocalCiiData\) \{[\s\S]*setIntelligenceSignalsLoaded\(\);[\s\S]*\}[\s\S]*this\.refreshCiiAndBrief\(\);/);
    assert.doesNotMatch(src, /this\.refreshCiiAndBrief\(hasLocalCiiData\);/);
    assert.doesNotMatch(src, /this\.refreshCiiAndBrief\(true\);/);

    assert.match(refreshBody, /const cached = this\.getAuthoritativeCachedRiskScores\(forceLocal\);/);
    assert.match(refreshBody, /if \(cached\) \{[\s\S]*this\.renderCachedCiiScores\(cached\);[\s\S]*return;[\s\S]*\}/);
    assert.match(refreshBody, /const shouldUseLocalFallback = forceLocal \|\| !this\.cachedRiskScores;/);
    assert.match(refreshBody, /\(this\.ctx\.panels\['cii'\] as CIIPanel\)\?\.refresh\(shouldUseLocalFallback\);/);
    assert.match(refreshBody, /const scores = calculateCII\(\);[\s\S]*this\.applyCiiScoresToMap\(scores\);/);
  });

  it('renders Strategic Risk from cached strategic risk/CII instead of only marking the badge cached', () => {
    const src = readSrc('src/components/StrategicRiskPanel.ts');
    const overviewSrc = readSrc('src/services/cross-module-integration.ts');
    const refreshBody = extractMethod(src, 'public async refresh(): Promise<boolean>');
    const cachedTimestampBody = extractMethod(src, 'private cachedTimestamp(cached: CachedRiskScores): Date | null');

    assert.match(overviewSrc, /export interface StrategicRiskOverview[\s\S]*timestamp: Date \| null;/);
    assert.match(src, /private applyCachedRiskOverview\(cached: CachedRiskScores, localOverview: StrategicRiskOverview\): void/);
    assert.match(cachedTimestampBody, /if \(!raw\) return null;/);
    assert.match(cachedTimestampBody, /Number\.isNaN\(parsed\.getTime\(\)\) \? null : parsed/);
    assert.doesNotMatch(cachedTimestampBody, /new Date\(\)/);
    assert.match(src, /private formatOverviewTimestamp\(\): string \{[\s\S]*return this\.overview\?\.timestamp \? this\.overview\.timestamp\.toLocaleTimeString\(\) : '&mdash;';[\s\S]*\}/);
    assert.match(src, /compositeScore: Math\.max\(0, Math\.min\(100, Math\.round\(cached\.strategicRisk\.score\)\)\)/);
    assert.match(src, /unstableCountries: ciiScores\.filter\(s => s\.score >= 50\)\.slice\(0, 5\)/);
    assert.doesNotMatch(src, /hasIntelligenceSignalsLoaded/);
    assert.match(refreshBody, /this\.applyCachedRiskOverview\(cachedRiskScores, localOverview\);[\s\S]*this\.usedCachedScores = true;/);
    assert.match(refreshBody, /if \(this\.usedCachedScores\) \{[\s\S]*this\.setDataBadge\('cached', badgeDetail\);[\s\S]*\} else if \(!this\.freshnessSummary \|\| this\.freshnessSummary\.activeSources === 0\) \{[\s\S]*this\.setDataBadge\('unavailable'\);/);
  });

  it('story data consumes cached/server CII before recomputing local scores', async () => {
    let localCalls = 0;
    (globalThis as any).__ciiSourceTruthTest = {
      getCachedCountryScore: () => makeScore(87),
      calculateCII: () => {
        localCalls++;
        return [makeScore(12)];
      },
    };
    const story = await loadStoryDataForTest();

    const result = story.collectStoryData('IR', 'Iran', [], [], []);
    assert.equal(result.cii?.score, 87);
    assert.equal(localCalls, 0, 'local calculateCII must not run when cached CII exists');
  });

  it('story data falls back to local scores only when cached/server CII is absent', async () => {
    let localCalls = 0;
    (globalThis as any).__ciiSourceTruthTest = {
      getCachedCountryScore: () => null,
      calculateCII: () => {
        localCalls++;
        return [makeScore(67)];
      },
    };
    const story = await loadStoryDataForTest();

    const result = story.collectStoryData('IR', 'Iran', [], [], []);
    assert.equal(result.cii?.score, 67);
    assert.equal(localCalls, 1);
  });

  it('story data normalizes country code before cached and local score lookup', async () => {
    (globalThis as any).__ciiSourceTruthTest = {
      getCachedCountryScore: () => null,
      calculateCII: () => [makeScore(55)],
    };
    const story = await loadStoryDataForTest();

    const result = story.collectStoryData('ir', 'Iran', [], [], []);
    assert.equal(result.cii?.score, 55);
    assert.equal(result.cii?.level, 'elevated');
  });

  it('routes remaining on-demand CII consumers through cached/server scores first', () => {
    const storySrc = readSrc('src/services/story-data.ts');
    const countryIntelSrc = readSrc('src/app/country-intel.ts');
    const crossModuleSrc = readSrc('src/services/cross-module-integration.ts');
    const militarySrc = readSrc('src/services/military-surge.ts');
    const mapSrc = readSrc('src/components/Map.ts');
    const deckSrc = readSrc('src/components/DeckGLMap.ts');

    assert.doesNotMatch(storySrc, /hasIntelligenceSignalsLoaded/);
    assert.match(storySrc, /const normalizedCountryCode = normalizeCiiCountryCode\(countryCode\);/);
    assert.match(storySrc, /getCachedCountryScore\(normalizedCountryCode\)[\s\S]*s\.code === normalizedCountryCode/);

    assert.doesNotMatch(countryIntelSrc, /hasIntelligenceSignalsLoaded/);
    assert.match(countryIntelSrc, /const scoreCode = normalizeCiiCountryCode\(code\);[\s\S]*getCachedCountryScore\(scoreCode\) \?\? calculateCII\(\)\.find\(\(s\) => s\.code === scoreCode\)/);

    assert.match(crossModuleSrc, /type CIIScoreSource = 'cached' \| 'local';/);
    assert.match(crossModuleSrc, /let previousCIIScoreSource: CIIScoreSource \| null = null;/);
    assert.match(crossModuleSrc, /if \(previousCIIScoreSource !== null && previousCIIScoreSource !== source\) \{[\s\S]*previousCIIScores\.clear\(\);[\s\S]*\}/);
    assert.match(crossModuleSrc, /const \{ scores, source \} = getAuthoritativeCIIScores\(\);/);
    assert.match(crossModuleSrc, /const \{ scores: ciiScores \} = getAuthoritativeCIIScores\(\);/);

    assert.match(militarySrc, /getCachedCountryScoreValue\(code\) \?\? getCountryScore\(code\)/);
    assert.match(mapSrc, /setCIIGetter\(\(code\) => getCachedCountryScoreValue\(code\) \?\? getCountryScore\(code\)\)/);
    assert.match(deckSrc, /setCIIGetter\(\(code\) => getCachedCountryScoreValue\(code\) \?\? getCountryScore\(code\)\)/);
  });

  it('aligns CII badge and fill colors to the canonical frontend bands', () => {
    const modalSrc = readSrc('src/components/CountryIntelModal.ts');
    const strategicRiskSrc = readSrc('src/components/StrategicRiskPanel.ts');

    assert.match(extractMethod(modalSrc, 'private scoreBar(score: number): string'), /pct >= 81[\s\S]*pct >= 66[\s\S]*pct >= 51/);
    assert.match(extractMethod(strategicRiskSrc, 'private getScoreColor(score: number): string'), /score >= 81[\s\S]*score >= 66[\s\S]*score >= 51/);
  });
});
