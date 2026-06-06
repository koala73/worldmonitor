import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
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

function assertBefore(src: string, first: string, second: string): void {
  const firstIndex = src.indexOf(first);
  const secondIndex = src.indexOf(second);
  assert.notEqual(firstIndex, -1, `missing first marker: ${first}`);
  assert.notEqual(secondIndex, -1, `missing second marker: ${second}`);
  assert.ok(firstIndex < secondIndex, `expected "${first}" before "${second}"`);
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
    ) => { countryCode: string; cii: { score: number; level: string; trend: string; change24h: number } | null };
  };
}

async function loadCrossModuleForTest() {
  const src = readSrc('src/services/cross-module-integration.ts')
    .replace(
      "import { getLocationName, type GeoConvergenceAlert } from './geo-convergence';",
      `type GeoConvergenceAlert = any;
const getLocationName = () => 'Test Location';`,
    )
    .replace(
      "import type { CountryScore } from './country-instability';",
      `type CountryScore = any;`,
    )
    .replace(
      "import { getLatestSanctionsPressure, type SanctionsPressureResult } from './sanctions-pressure';",
      `type SanctionsPressureResult = any;
const getLatestSanctionsPressure = () => null;`,
    )
    .replace(
      "import { getLatestRadiationWatch, type RadiationObservation } from './radiation';",
      `type RadiationObservation = any;
const getLatestRadiationWatch = () => null;`,
    )
    .replace(
      "import type { CascadeResult, CascadeImpactLevel } from '@/types';",
      `type CascadeResult = any;
type CascadeImpactLevel = any;`,
    )
    .replace(
      "import { calculateCII, isInLearningMode } from './country-instability';",
      `const calculateCII = () => (globalThis as any).__ciiSourceTruthTest.localScores;
const isInLearningMode = () => Boolean((globalThis as any).__ciiSourceTruthTest.inLearning);`,
    )
    .replace(
      "import { getCachedCountryScores } from './cached-risk-scores';",
      `const getCachedCountryScores = () => (globalThis as any).__ciiSourceTruthTest.cachedScores;`,
    )
    .replace(
      "import { getCountryNameByCode } from './country-geometry';",
      `const getCountryNameByCode = (code: string) => ({ IR: 'Iran' } as Record<string, string>)[code] || code;`,
    )
    .replace(
      "import { t } from '@/services/i18n';",
      `const t = (key: string, params?: Record<string, unknown>) => String(params?.country ?? key);`,
    )
    .replace(
      "import type { TheaterPostureSummary } from '@/services/military-surge';",
      `type TheaterPostureSummary = any;`,
    );

  const transformed = transformSync(src, {
    loader: 'ts',
    format: 'esm',
    target: 'es2022',
  });
  const dataUrl = `data:text/javascript;base64,${Buffer.from(transformed.code).toString('base64')}#${++moduleCounter}`;
  return (await import(dataUrl)) as {
    checkCIIChanges: () => Array<{
      type: string;
      components: { ciiChange?: { previousScore: number; currentScore: number } };
    }>;
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
    const eventHandlersSrc = readSrc('src/app/event-handlers.ts');
    const appSrc = readSrc('src/App.ts');
    const ciiPanelSrc = readSrc('src/components/CIIPanel.ts');
    const refreshBody = extractMethod(src, 'private refreshCiiAndBrief(forceLocal = false): void');
    const ciiRefreshBody = extractMethod(ciiPanelSrc, 'public async refresh(forceLocal = false): Promise<void>');
    const eventHandlerWiringStart = appSrc.indexOf('this.eventHandlers = new EventHandlerManager');
    const eventHandlerWiringEnd = appSrc.indexOf('// Wire cross-module callback', eventHandlerWiringStart);
    assert.notEqual(eventHandlerWiringStart, -1, 'missing EventHandlerManager wiring');
    assert.notEqual(eventHandlerWiringEnd, -1, 'missing EventHandlerManager wiring end marker');
    const eventHandlerWiring = appSrc.slice(eventHandlerWiringStart, eventHandlerWiringEnd);

    assert.match(src, /private cachedRiskScores: CachedRiskScores \| null = null;/);
    assert.match(src, /private preferLocalCii = false;/);
    assert.match(src, /private getAuthoritativeCachedRiskScores\(forceLocal: boolean\): CachedRiskScores \| null/);
    assert.match(src, /if \(forceLocal\) \{[\s\S]*this\.preferLocalCii = true;[\s\S]*return null;[\s\S]*\}/);
    assert.match(src, /public refreshCiiAfterFocalPointsReady\(\): void \{[\s\S]*this\.refreshCiiAndBrief\(false\);[\s\S]*\}/);
    assert.doesNotMatch(src, /this\.refreshCiiAndBrief\(hasLocalCiiData\);/);
    assert.doesNotMatch(src, /this\.refreshCiiAndBrief\(true\);/);
    assert.doesNotMatch(src, /setIntelligenceSignalsLoaded/);

    assert.match(refreshBody, /const cached = this\.getAuthoritativeCachedRiskScores\(forceLocal\);/);
    assert.match(refreshBody, /if \(cached\) \{[\s\S]*this\.renderCachedCiiScores\(cached\);[\s\S]*return;[\s\S]*\}/);
    assert.match(refreshBody, /const shouldUseLocalFallback = forceLocal \|\| !this\.cachedRiskScores;/);
    assert.match(refreshBody, /\(this\.ctx\.panels\['cii'\] as CIIPanel\)\?\.refresh\(shouldUseLocalFallback\);/);
    assert.match(refreshBody, /const scores = calculateCII\(\);[\s\S]*this\.applyCiiScoresToMap\(scores\);/);

    assert.match(eventHandlersSrc, /refreshCiiAfterFocalPointsReady\?: \(\) => void;/);
    assert.match(eventHandlersSrc, /this\.boundFocalPointsReadyHandler = \(\) => \{[\s\S]*this\.callbacks\.refreshCiiAfterFocalPointsReady\?\.\(\);[\s\S]*\};/);
    assert.doesNotMatch(eventHandlersSrc, /refreshOpenCountryBrief/);
    assert.doesNotMatch(eventHandlersSrc, /CIIPanel/);
    assert.doesNotMatch(eventHandlersSrc, /\.refresh\(true\)/);
    assert.doesNotMatch(eventHandlerWiring, /refreshOpenCountryBrief/);
    assert.match(appSrc, /refreshCiiAfterFocalPointsReady: \(\) => this\.dataLoader\.refreshCiiAfterFocalPointsReady\(\)/);

    assert.match(ciiRefreshBody, /if \(withData\.length === 0\) \{[\s\S]*this\.updateSourceBadge\(null\);[\s\S]*return;/);
  });

  it('renders Strategic Risk from cached strategic risk/CII instead of only marking the badge cached', () => {
    const src = readSrc('src/components/StrategicRiskPanel.ts');
    const overviewSrc = readSrc('src/services/cross-module-integration.ts');
    const refreshBody = extractMethod(src, 'public async refresh(): Promise<boolean>');
    const cachedTimestampBody = extractMethod(src, 'private cachedTimestamp(cached: CachedRiskScores): Date | null');

    assert.match(overviewSrc, /export interface StrategicRiskOverview[\s\S]*timestamp: Date \| null;/);
    assert.match(src, /private applyCachedRiskOverview\(cached: CachedRiskScores, localOverview: StrategicRiskOverview\): void/);
    assert.match(overviewSrc, /degraded: boolean;/);
    assert.match(overviewSrc, /stale: boolean;/);
    assert.match(cachedTimestampBody, /if \(!raw\) return null;/);
    assert.match(cachedTimestampBody, /Number\.isNaN\(parsed\.getTime\(\)\) \? null : parsed/);
    assert.doesNotMatch(cachedTimestampBody, /new Date\(\)/);
    assert.match(src, /private formatOverviewTimestamp\(\): string \{[\s\S]*return this\.overview\?\.timestamp \? this\.overview\.timestamp\.toLocaleTimeString\(\) : '&mdash;';[\s\S]*\}/);
    assert.match(src, /compositeScore: Math\.max\(0, Math\.min\(100, Math\.round\(cached\.strategicRisk\.score\)\)\)/);
    assert.match(src, /degraded: cached\.degraded/);
    assert.match(src, /stale: cached\.stale/);
    assert.match(src, /private renderCachedRiskStateBanner\(\): string/);
    assert.match(src, /risk-status-cached/);
    const cachedBannerBody = extractMethod(src, 'private renderCachedRiskStateBanner(): string');
    assert.match(cachedBannerBody, /t\('components\.strategicRisk\.sourceStates\.degraded'\)/);
    assert.match(cachedBannerBody, /t\('components\.strategicRisk\.sourceStates\.stale'\)/);
    assert.match(cachedBannerBody, /t\('components\.strategicRisk\.cachedCiiStatus', \{ states: labels\.join\(' · '\) \}\)/);
    assert.doesNotMatch(cachedBannerBody, /'degraded'|'stale'|Cached CII/);
    assert.match(src, /unstableCountries: ciiScores\.filter\(s => s\.score >= 50\)\.slice\(0, 5\)/);
    assert.doesNotMatch(src, /hasIntelligenceSignalsLoaded/);
    assertBefore(
      refreshBody,
      'const cachedRiskScores = await fetchCachedRiskScores(this.signal);',
      'const localOverview = calculateStrategicRiskOverview(',
    );
    assert.match(refreshBody, /this\.applyCachedRiskOverview\(cachedRiskScores, localOverview\);[\s\S]*this\.usedCachedScores = true;/);
    assert.match(refreshBody, /if \(this\.usedCachedScores\) \{[\s\S]*this\.setDataBadge\('cached', badgeDetail\);[\s\S]*\} else if \(!this\.freshnessSummary \|\| this\.freshnessSummary\.activeSources === 0\) \{[\s\S]*this\.setDataBadge\('unavailable'\);/);
  });

  it('localizes cached CII degraded/stale state labels', () => {
    const ciiSrc = readSrc('src/components/CIIPanel.ts');
    const riskSrc = readSrc('src/components/StrategicRiskPanel.ts');
    const enLocaleSrc = readSrc('src/locales/en.json');
    const ciiDetailBody = extractMethod(
      ciiSrc,
      "private formatCachedSourceDetail(cached: Pick<CachedRiskScores, 'degraded' | 'stale'>): string",
    );
    const cachedBannerBody = extractMethod(riskSrc, 'private renderCachedRiskStateBanner(): string');

    assert.match(ciiDetailBody, /t\('components\.cii\.sourceStates\.degraded'\)/);
    assert.match(ciiDetailBody, /t\('components\.cii\.sourceStates\.stale'\)/);
    assert.doesNotMatch(ciiDetailBody, /flags\.push\('degraded'\)|flags\.push\('stale'\)/);

    assert.match(cachedBannerBody, /t\('components\.strategicRisk\.sourceStates\.degraded'\)/);
    assert.match(cachedBannerBody, /t\('components\.strategicRisk\.sourceStates\.stale'\)/);
    assert.match(cachedBannerBody, /t\('components\.strategicRisk\.cachedCiiStatus', \{ states: labels\.join\(' · '\) \}\)/);
    assert.doesNotMatch(cachedBannerBody, /'degraded'|'stale'|Cached CII/);

    assert.match(enLocaleSrc, /"sourceStates": \{\n        "degraded": "degraded",\n        "stale": "stale"\n      \}/);
    assert.match(enLocaleSrc, /"cachedCiiStatus": "Cached CII \{\{states\}\}"/);
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
    assert.equal(result.countryCode, 'IR');
    assert.equal(result.cii?.score, 55);
    assert.equal(result.cii?.level, 'elevated');
  });

  it('does not emit false CII-spike alerts when score source switches from local to cached', async () => {
    const previousDocument = (globalThis as any).document;
    const previousCustomEvent = (globalThis as any).CustomEvent;
    (globalThis as any).document = { dispatchEvent: () => undefined };
    (globalThis as any).CustomEvent = class CustomEvent {
      constructor(public type: string) {}
    };

    try {
      (globalThis as any).__ciiSourceTruthTest = {
        cachedScores: [],
        localScores: [makeScore(5)],
        inLearning: false,
      };
      const crossModule = await loadCrossModuleForTest();

      assert.equal(crossModule.checkCIIChanges().length, 0);

      (globalThis as any).__ciiSourceTruthTest.cachedScores = [makeScore(80)];
      assert.equal(
        crossModule.checkCIIChanges().length,
        0,
        'local-to-cached source switch must rebaseline instead of alerting on formula drift',
      );

      (globalThis as any).__ciiSourceTruthTest.cachedScores = [makeScore(95)];
      const alerts = crossModule.checkCIIChanges();
      assert.equal(alerts.length, 1, 'same-source cached changes should still emit CII spike alerts');
      assert.equal(alerts[0]?.type, 'cii_spike');
      assert.equal(alerts[0]?.components.ciiChange?.previousScore, 80);
      assert.equal(alerts[0]?.components.ciiChange?.currentScore, 95);
    } finally {
      if (previousDocument === undefined) delete (globalThis as any).document;
      else (globalThis as any).document = previousDocument;
      if (previousCustomEvent === undefined) delete (globalThis as any).CustomEvent;
      else (globalThis as any).CustomEvent = previousCustomEvent;
      delete (globalThis as any).__ciiSourceTruthTest;
    }
  });

  it('routes remaining on-demand CII consumers through cached/server scores first', () => {
    const storySrc = readSrc('src/services/story-data.ts');
    const countryIntelSrc = readSrc('src/app/country-intel.ts');
    const crossModuleSrc = readSrc('src/services/cross-module-integration.ts');
    const militarySrc = readSrc('src/services/military-surge.ts');
    const mapSrc = readSrc('src/components/Map.ts');
    const deckSrc = readSrc('src/components/DeckGLMap.ts');
    const searchSrc = readSrc('src/app/search-manager.ts');
    const insightsSrc = readSrc('src/components/InsightsPanel.ts');

    assert.doesNotMatch(storySrc, /hasIntelligenceSignalsLoaded/);
    assert.match(storySrc, /const normalizedCountryCode = normalizeCiiCountryCode\(countryCode\);/);
    assert.match(storySrc, /getCachedCountryScore\(normalizedCountryCode\)[\s\S]*s\.code === normalizedCountryCode/);
    assert.match(storySrc, /countryCode: normalizedCountryCode/);

    assert.doesNotMatch(countryIntelSrc, /hasIntelligenceSignalsLoaded/);
    assert.match(countryIntelSrc, /const scoreCode = normalizeCiiCountryCode\(code\);[\s\S]*getCachedCountryScore\(scoreCode\) \?\? calculateCII\(\)\.find\(\(s\) => s\.code === scoreCode\)/);

    assert.match(crossModuleSrc, /type CIIScoreSource = 'cached' \| 'local';/);
    assert.match(crossModuleSrc, /let previousCIIScoreSource: CIIScoreSource \| null = null;/);
    assert.match(crossModuleSrc, /if \(previousCIIScoreSource !== null && previousCIIScoreSource !== source\) \{[\s\S]*previousCIIScores\.clear\(\);[\s\S]*\}/);
    assert.match(crossModuleSrc, /const \{ scores, source \} = getAuthoritativeCIIScores\(\);/);
    assert.match(crossModuleSrc, /const \{ scores: ciiScores \} = getAuthoritativeCIIScores\(\);/);
    assert.match(crossModuleSrc, /export function clearAlerts\(\): void \{[\s\S]*previousCIIScores\.clear\(\);[\s\S]*previousCIIScoreSource = null;[\s\S]*\}/);

    assert.match(militarySrc, /getCachedCountryScoreValue\(code\) \?\? getCountryScore\(code\)/);
    assert.match(mapSrc, /setCIIGetter\(\(code\) => getCachedCountryScoreValue\(code\) \?\? getCountryScore\(code\)\)/);
    assert.match(deckSrc, /setCIIGetter\(\(code\) => getCachedCountryScoreValue\(code\) \?\? getCountryScore\(code\)\)/);
    assert.match(searchSrc, /const cachedScores = getCachedCountryScores\(\);[\s\S]*const scores = cachedScores\.length > 0[\s\S]*\? cachedScores[\s\S]*: \(panelScores\.length > 0 \? panelScores : calculateCII\(\)\);/);
    assert.match(insightsSrc, /function getAuthoritativeCountryScore\(code: string\): number \| null \{[\s\S]*return getCachedCountryScoreValue\(code\) \?\? getCountryScore\(code\);[\s\S]*\}/);
    assert.match(insightsSrc, /focalFnServer, getAuthoritativeCountryScore, isFocalReadyServer/);
    assert.match(insightsSrc, /this\.selectTopStories\(clusters, 8, focalFn, getAuthoritativeCountryScore, isFocalReady\)/);
  });

  it('aligns CII badge and fill colors to the canonical frontend bands', () => {
    const modalPath = resolve(root, 'src/components/CountryIntelModal.ts');
    const strategicRiskSrc = readSrc('src/components/StrategicRiskPanel.ts');
    const mainCss = readSrc('src/styles/main.css');
    const rtlCss = readSrc('src/styles/rtl-overrides.css');

    assert.equal(existsSync(modalPath), false, 'CountryIntelModal is an unused orphan and should stay deleted');
    assert.doesNotMatch(mainCss, /country-intel-/);
    assert.doesNotMatch(mainCss, /\.cii-score-(bar|fill|value)|\.cii-label|\.cii-badge/);
    assert.doesNotMatch(rtlCss, /country-intel-/);
    assert.match(strategicRiskSrc, /const STRATEGIC_RISK_BANDS = \[[\s\S]*min: 70[\s\S]*critical[\s\S]*min: 50[\s\S]*elevated[\s\S]*min: 30[\s\S]*moderate/);
    assert.match(extractMethod(strategicRiskSrc, 'private getScoreColor(score: number): string'), /this\.getScoreBand\(score\)\.colorVar/);
    assert.match(extractMethod(strategicRiskSrc, 'private getScoreLevel(score: number): string'), /this\.getScoreBand\(score\)\.levelKey/);
  });
});
