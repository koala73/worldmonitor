import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { transformSync } from 'esbuild';

const root = resolve(import.meta.dirname, '..');

function readSrc(path: string): string {
  return readFileSync(resolve(root, path), 'utf8').replace(/\r\n/g, '\n');
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

async function loadElevatedCiiScoreForTest(): Promise<(score: number) => boolean> {
  const cachedRiskSrc = readSrc('src/services/cached-risk-scores.ts');
  const helperSrc = [
    extractMethod(cachedRiskSrc, 'function getScoreLevel(score: number)'),
    extractMethod(cachedRiskSrc, 'export function isElevatedCiiScore(score: number)'),
  ].join('\n');
  const transformed = transformSync(helperSrc, {
    loader: 'ts',
    format: 'esm',
    target: 'es2022',
  });
  const dataUrl = `data:text/javascript;base64,${Buffer.from(transformed.code).toString('base64')}#${++moduleCounter}`;
  const mod = await import(dataUrl) as { isElevatedCiiScore: (score: number) => boolean };
  return mod.isElevatedCiiScore;
}

async function loadStoryDataForTest() {
  const src = readSrc('src/services/story-data.ts')
    .replace("import type { CountryScore } from './country-instability';", 'type CountryScore = any;')
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
  const isElevatedCiiScore = await loadElevatedCiiScoreForTest();
  const testState = (globalThis as any).__ciiSourceTruthTest;
  assert.ok(testState, 'cross-module test state must be initialized before loading');
  testState.isElevatedCiiScore = isElevatedCiiScore;

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
      "import { isInLearningMode } from './country-instability';",
      `const isInLearningMode = () => Boolean((globalThis as any).__ciiSourceTruthTest.inLearning);`,
    )
    .replace(
      "import { getCachedCountryScores, isElevatedCiiScore } from './cached-risk-scores';",
      `const getCachedCountryScores = () => (globalThis as any).__ciiSourceTruthTest.cachedScores;
const isElevatedCiiScore = (score: number) => (globalThis as any).__ciiSourceTruthTest.isElevatedCiiScore(score);`,
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
    calculateStrategicRiskOverview: (convergenceAlerts: unknown[]) => {
      unstableCountries: Array<{ score: number }>;
    };
  };
}

async function loadDataLoaderCiiHarness() {
  const src = readSrc('src/app/data-loader.ts');
  const methods = [
    'private getAuthoritativeCachedRiskScores(): CachedRiskScores | null',
    'private applyCiiScoresToMap(scores: CountryScore[]): void',
    'private renderCachedCiiScores(cached: CachedRiskScores): boolean',
    'private refreshCiiAndBrief(): void',
    'public refreshCiiAfterFocalPointsReady(): void',
  ].map(signature => extractMethod(src, signature)).join('\n\n');

  const harnessSrc = `
type CachedRiskScores = any;
type CountryScore = any;
const getCachedScores = () => (globalThis as any).__ciiSourceTruthTest.cachedScores;
const toCountryScore = (score: any) => score;

export class DataLoaderCiiHarness {
  private appliedCiiState: CachedRiskScores | null | undefined;
  public panelCalls: Array<{ method: string; args: any[] }> = [];
  public mapScoreCalls: any[][] = [];
  public mapReadyCalls: Array<{ layer: string; ready: boolean }> = [];
  public briefRefreshes = 0;
  public ctx = {
    map: {
      setCIIScores: (scores: any[]) => this.mapScoreCalls.push(scores),
      setLayerReady: (layer: string, ready: boolean) => this.mapReadyCalls.push({ layer, ready }),
    },
  };
  public callbacks = {
    refreshOpenCountryBrief: () => { this.briefRefreshes += 1; },
  };

  private callPanel(_panel: string, method: string, ...args: any[]): void {
    this.panelCalls.push({ method, args });
  }

  ${methods}
}
`;
  const transformed = transformSync(harnessSrc, {
    loader: 'ts',
    format: 'esm',
    target: 'es2022',
  });
  const dataUrl = `data:text/javascript;base64,${Buffer.from(transformed.code).toString('base64')}#${++moduleCounter}`;
  return (await import(dataUrl)) as {
    DataLoaderCiiHarness: new () => {
      panelCalls: Array<{ method: string; args: unknown[] }>;
      mapScoreCalls: Array<Array<{ code: string; score: number }>>;
      mapReadyCalls: Array<{ layer: string; ready: boolean }>;
      briefRefreshes: number;
      refreshCiiAfterFocalPointsReady: () => void;
    };
  };
}

async function loadStrategicRiskRefreshHarness() {
  const refreshMethod = extractMethod(
    readSrc('src/components/StrategicRiskPanel.ts'),
    'public async refresh(): Promise<boolean>',
  );
  const harnessSrc = `
const dataFreshness = { getSummary: () => ({ activeSources: 1, totalSources: 2 }) };
const detectConvergence = () => [];
const getCachedPosture = () => null;
const fetchCachedRiskScores = async () => (globalThis as any).__ciiSourceTruthTest.cachedScores;
const calculateStrategicRiskOverview = () => { throw new Error('local overview must not run without canonical scores'); };
const getRecentAlerts = () => [];
const t = (key: string) => key;

export class StrategicRiskRefreshHarness {
  public overview: any = { compositeScore: 92 };
  public alerts: any[] = [{ id: 'prior-alert' }];
  public badgeCalls: Array<{ state: string; detail?: string }> = [];
  public errorCalls: Array<{ message: string; retry: () => void }> = [];
  public renderCalls = 0;
  public freshnessSummary: any = null;
  public convergenceAlerts: any[] = [];
  public breakingAlerts = new Map();
  public breakingExpiryTimer: ReturnType<typeof setTimeout> | null = null;
  public signal = undefined;
  public element = { isConnected: true };
  public lastRiskFingerprint = '';

  public setDataBadge(state: string, detail?: string): void {
    this.badgeCalls.push({ state, detail });
  }

  public showError(message: string, retry: () => void): void {
    this.errorCalls.push({ message, retry });
  }

  public applyCachedRiskOverview(): void {
    throw new Error('cached overview must not run without canonical scores');
  }

  public render(): void {
    this.renderCalls += 1;
  }

  ${refreshMethod}
}
`;
  const transformed = transformSync(harnessSrc, {
    loader: 'ts',
    format: 'esm',
    target: 'es2022',
  });
  const dataUrl = `data:text/javascript;base64,${Buffer.from(transformed.code).toString('base64')}#${++moduleCounter}`;
  return (await import(dataUrl)) as {
    StrategicRiskRefreshHarness: new () => {
      overview: unknown;
      alerts: unknown[];
      badgeCalls: Array<{ state: string; detail?: string }>;
      errorCalls: Array<{ message: string; retry: () => void }>;
      renderCalls: number;
      refresh: () => Promise<boolean>;
    };
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
  it('keeps cached backend CII authoritative and renders unavailable instead of calculating locally', () => {
    const src = readSrc('src/app/data-loader.ts');
    const eventHandlersSrc = readSrc('src/app/event-handlers.ts');
    const appSrc = readSrc('src/App.ts');
    const ciiPanelSrc = readSrc('src/components/CIIPanel.ts');
    const refreshBody = extractMethod(src, 'private refreshCiiAndBrief(): void');
    const ciiUnavailableBody = extractMethod(ciiPanelSrc, 'public renderUnavailable(): void');
    const eventHandlerWiringStart = appSrc.indexOf('this.eventHandlers = new EventHandlerManager');
    const eventHandlerWiringEnd = appSrc.indexOf('// Wire cross-module callback', eventHandlerWiringStart);
    assert.notEqual(eventHandlerWiringStart, -1, 'missing EventHandlerManager wiring');
    assert.notEqual(eventHandlerWiringEnd, -1, 'missing EventHandlerManager wiring end marker');
    const eventHandlerWiring = appSrc.slice(eventHandlerWiringStart, eventHandlerWiringEnd);

    assert.doesNotMatch(src, /private cachedRiskScores:/);
    assert.doesNotMatch(src, /preferLocalCii|forceLocal|calculateCII\(/);
    assert.match(src, /private getAuthoritativeCachedRiskScores\(\): CachedRiskScores \| null/);
    assert.match(src, /public refreshCiiAfterFocalPointsReady\(\): void \{[\s\S]*this\.refreshCiiAndBrief\(\);[\s\S]*\}/);
    assert.doesNotMatch(src, /this\.refreshCiiAndBrief\(hasLocalCiiData\);/);
    assert.doesNotMatch(src, /this\.refreshCiiAndBrief\(true\);/);
    assert.doesNotMatch(src, /setIntelligenceSignalsLoaded/);

    assert.match(refreshBody, /const cached = this\.getAuthoritativeCachedRiskScores\(\);/);
    assert.match(refreshBody, /if \(cached\) \{[\s\S]*this\.renderCachedCiiScores\(cached\)[\s\S]*return;[\s\S]*\}/);
    assert.match(refreshBody, /if \(this\.appliedCiiState === null\) return;/);
    assert.match(refreshBody, /this\.callPanel\('cii', 'renderUnavailable'\);/);
    assert.match(refreshBody, /this\.applyCiiScoresToMap\(\[\]\);/);

    assert.match(eventHandlersSrc, /refreshCiiAfterFocalPointsReady\?: \(\) => void;/);
    assert.match(eventHandlersSrc, /this\.boundFocalPointsReadyHandler = \(\) => \{[\s\S]*this\.callbacks\.refreshCiiAfterFocalPointsReady\?\.\(\);[\s\S]*\};/);
    assert.doesNotMatch(eventHandlersSrc, /refreshOpenCountryBrief/);
    assert.doesNotMatch(eventHandlersSrc, /CIIPanel/);
    assert.doesNotMatch(eventHandlersSrc, /\.refresh\(true\)/);
    assert.doesNotMatch(eventHandlerWiring, /refreshOpenCountryBrief/);
    assert.match(appSrc, /refreshCiiAfterFocalPointsReady: \(\) => this\.dataLoader\.refreshCiiAfterFocalPointsReady\(\)/);

    assert.match(ciiUnavailableBody, /this\.scores = \[\];/);
    assert.match(ciiUnavailableBody, /this\.setDataBadge\('unavailable'\);/);
    assert.match(ciiUnavailableBody, /t\('common\.failedCII'\)/);
  });

  it('applies canonical CII availability transitions once per state change', async () => {
    (globalThis as any).__ciiSourceTruthTest = { cachedScores: null };
    const { DataLoaderCiiHarness } = await loadDataLoaderCiiHarness();
    const loader = new DataLoaderCiiHarness();

    loader.refreshCiiAfterFocalPointsReady();
    assert.deepEqual(loader.panelCalls.map(call => call.method), ['renderUnavailable']);
    assert.deepEqual(loader.mapScoreCalls, [[]]);
    assert.deepEqual(loader.mapReadyCalls, [{ layer: 'ciiChoropleth', ready: false }]);
    assert.equal(loader.briefRefreshes, 1);

    loader.refreshCiiAfterFocalPointsReady();
    assert.equal(loader.panelCalls.length, 1, 'repeated unavailable state must not re-render');
    assert.equal(loader.mapScoreCalls.length, 1, 'repeated unavailable state must not rewrite the map');
    assert.equal(loader.briefRefreshes, 1, 'repeated unavailable state must not refresh an open brief');

    const cached = { cii: [makeScore(71)], strategicRisk: { score: 71 }, degraded: false, stale: false };
    (globalThis as any).__ciiSourceTruthTest.cachedScores = cached;
    loader.refreshCiiAfterFocalPointsReady();
    assert.deepEqual(loader.panelCalls.map(call => call.method), ['renderUnavailable', 'renderFromCached']);
    assert.strictEqual(loader.panelCalls[1]?.args[0], cached);
    assert.deepEqual(loader.mapScoreCalls[1], [{ code: 'IR', score: 71, level: 'high' }]);
    assert.deepEqual(loader.mapReadyCalls[1], { layer: 'ciiChoropleth', ready: true });
    assert.equal(loader.briefRefreshes, 2);

    loader.refreshCiiAfterFocalPointsReady();
    assert.equal(loader.panelCalls.length, 2, 'same canonical cache object must not re-render');
    assert.equal(loader.mapScoreCalls.length, 2, 'same canonical cache object must not rewrite the map');
    assert.equal(loader.briefRefreshes, 3, 'same canonical cache object must still refresh an open brief');

    const updatedCached = { cii: [makeScore(76)], strategicRisk: { score: 76 }, degraded: false, stale: false };
    (globalThis as any).__ciiSourceTruthTest.cachedScores = updatedCached;
    loader.refreshCiiAfterFocalPointsReady();
    assert.deepEqual(loader.panelCalls.map(call => call.method), [
      'renderUnavailable',
      'renderFromCached',
      'renderFromCached',
    ]);
    assert.strictEqual(loader.panelCalls[2]?.args[0], updatedCached);
    assert.deepEqual(loader.mapScoreCalls[2], [{ code: 'IR', score: 76, level: 'high' }]);
    assert.deepEqual(loader.mapReadyCalls[2], { layer: 'ciiChoropleth', ready: true });
    assert.equal(loader.briefRefreshes, 4);

    (globalThis as any).__ciiSourceTruthTest.cachedScores = null;
    loader.refreshCiiAfterFocalPointsReady();
    assert.deepEqual(loader.panelCalls.map(call => call.method), [
      'renderUnavailable',
      'renderFromCached',
      'renderFromCached',
      'renderUnavailable',
    ]);
    assert.deepEqual(loader.mapScoreCalls[3], []);
    assert.deepEqual(loader.mapReadyCalls[3], { layer: 'ciiChoropleth', ready: false });
    assert.equal(loader.briefRefreshes, 5);
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
    assert.match(src, /unstableCountries: ciiScores\.filter\(s => isElevatedCiiScore\(s\.score\)\)\.slice\(0, 5\)/);
    assert.doesNotMatch(src, /hasIntelligenceSignalsLoaded/);
    assertBefore(
      refreshBody,
      'const cachedRiskScores = await fetchCachedRiskScores(this.signal);',
      'const localOverview = calculateStrategicRiskOverview(',
    );
    assert.match(refreshBody, /if \(!cachedRiskScores\) \{[\s\S]*this\.setDataBadge\('unavailable'\);[\s\S]*this\.showError\(t\('common\.failedRiskOverview'\)[\s\S]*return false;/);
    assert.doesNotMatch(refreshBody, /using local fallback|setDataBadge\('live'/);
    assert.match(refreshBody, /this\.applyCachedRiskOverview\(cachedRiskScores, localOverview\);/);
    assert.doesNotMatch(src, /usedCachedScores|getLearningProgress\(/);
    assert.match(refreshBody, /this\.setDataBadge\('cached', badgeDetail\);/);
  });

  it('clears prior Strategic Risk state when canonical scores are unavailable', async () => {
    (globalThis as any).__ciiSourceTruthTest = { cachedScores: null };
    const { StrategicRiskRefreshHarness } = await loadStrategicRiskRefreshHarness();
    const panel = new StrategicRiskRefreshHarness();

    assert.equal(await panel.refresh(), false);
    assert.equal(panel.overview, null);
    assert.deepEqual(panel.alerts, []);
    assert.deepEqual(panel.badgeCalls, [{ state: 'unavailable', detail: undefined }]);
    assert.equal(panel.errorCalls.length, 1);
    assert.equal(panel.errorCalls[0]?.message, 'common.failedRiskOverview');
    assert.equal(panel.renderCalls, 0);
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
    (globalThis as any).__ciiSourceTruthTest = {
      getCachedCountryScore: () => makeScore(87),
    };
    const story = await loadStoryDataForTest();

    const result = story.collectStoryData('IR', 'Iran', [], [], []);
    assert.equal(result.cii?.score, 87);
  });

  it('story data reports CII unavailable when cached/server CII is absent', async () => {
    (globalThis as any).__ciiSourceTruthTest = {
      getCachedCountryScore: () => null,
    };
    const story = await loadStoryDataForTest();

    const result = story.collectStoryData('IR', 'Iran', [], [], []);
    assert.equal(result.cii, null);
  });

  it('story data normalizes country code before cached score lookup', async () => {
    let requestedCode = '';
    (globalThis as any).__ciiSourceTruthTest = {
      getCachedCountryScore: (code: string) => {
        requestedCode = code;
        return makeScore(55);
      },
    };
    const story = await loadStoryDataForTest();

    const result = story.collectStoryData('ir', 'Iran', [], [], []);
    assert.equal(result.countryCode, 'IR');
    assert.equal(requestedCode, 'IR');
    assert.equal(result.cii?.score, 55);
    assert.equal(result.cii?.level, 'elevated');
  });

  it('does not seed CII-spike alerts until canonical cached scores exist', async () => {
    const previousDocument = (globalThis as any).document;
    const previousCustomEvent = (globalThis as any).CustomEvent;
    (globalThis as any).document = { dispatchEvent: () => undefined };
    (globalThis as any).CustomEvent = class CustomEvent {
      constructor(public type: string) {}
    };

    try {
      (globalThis as any).__ciiSourceTruthTest = {
        cachedScores: [],
        inLearning: false,
      };
      const crossModule = await loadCrossModuleForTest();

      assert.equal(crossModule.checkCIIChanges().length, 0);

      (globalThis as any).__ciiSourceTruthTest.cachedScores = [makeScore(80)];
      assert.equal(
        crossModule.checkCIIChanges().length,
        0,
        'the first canonical snapshot must establish the alert baseline',
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

  it('uses the production elevated-or-higher threshold in cross-module risk summaries', async () => {
    const previousDocument = (globalThis as any).document;
    const previousCustomEvent = (globalThis as any).CustomEvent;
    (globalThis as any).document = { dispatchEvent: () => undefined };
    (globalThis as any).CustomEvent = class CustomEvent {
      constructor(public type: string) {}
    };

    try {
      const isElevatedCiiScore = await loadElevatedCiiScoreForTest();
      assert.equal(isElevatedCiiScore(50), false);
      assert.equal(isElevatedCiiScore(51), true);
      assert.equal(isElevatedCiiScore(66), true);
      assert.equal(isElevatedCiiScore(81), true);

      (globalThis as any).__ciiSourceTruthTest = {
        cachedScores: [makeScore(50), makeScore(51), makeScore(66), makeScore(81)],
        inLearning: false,
      };
      const crossModule = await loadCrossModuleForTest();
      const overview = crossModule.calculateStrategicRiskOverview([]);

      assert.deepEqual(
        overview.unstableCountries.map((score) => score.score),
        [51, 66, 81],
      );
    } finally {
      if (previousDocument === undefined) delete (globalThis as any).document;
      else (globalThis as any).document = previousDocument;
      if (previousCustomEvent === undefined) delete (globalThis as any).CustomEvent;
      else (globalThis as any).CustomEvent = previousCustomEvent;
      delete (globalThis as any).__ciiSourceTruthTest;
    }
  });

  it('routes every product CII consumer through cached/server scores only', () => {
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
    assert.match(storySrc, /const countryScore: CountryScore \| null = getCachedCountryScore\(normalizedCountryCode\);/);
    assert.match(storySrc, /countryCode: normalizedCountryCode/);

    assert.doesNotMatch(countryIntelSrc, /hasIntelligenceSignalsLoaded/);
    assert.match(countryIntelSrc, /const scoreCode = normalizeCiiCountryCode\(code\);[\s\S]*const score = getCachedCountryScore\(scoreCode\);/);

    assert.doesNotMatch(crossModuleSrc, /CIIScoreSource|previousCIIScoreSource|calculateCII\(/);
    assert.match(crossModuleSrc, /const scores = getAuthoritativeCIIScores\(\);/);
    assert.match(crossModuleSrc, /const ciiScores = getAuthoritativeCIIScores\(\);/);
    assert.match(crossModuleSrc, /export function clearAlerts\(\): void \{[\s\S]*previousCIIScores\.clear\(\);[\s\S]*\}/);

    assert.match(militarySrc, /const cii = getCachedCountryScoreValue\(code\);/);
    assert.match(mapSrc, /setCIIGetter\(getCachedCountryScoreValue\)/);
    assert.match(deckSrc, /setCIIGetter\(getCachedCountryScoreValue\)/);
    assert.match(searchSrc, /const scores = cachedScores\.length > 0[\s\S]*\? cachedScores[\s\S]*: panelScores;/);
    assert.match(insightsSrc, /const getAuthoritativeCountryScore = getCachedCountryScoreValue;/);
    assert.match(insightsSrc, /focalFnServer, getAuthoritativeCountryScore, isFocalReadyServer/);
    assert.match(insightsSrc, /this\.selectTopStories\(clusters, 8, focalFn, getAuthoritativeCountryScore, isFocalReady\)/);

    for (const [path, source] of [
      ['story-data.ts', storySrc],
      ['country-intel.ts', countryIntelSrc],
      ['cross-module-integration.ts', crossModuleSrc],
      ['military-surge.ts', militarySrc],
      ['Map.ts', mapSrc],
      ['DeckGLMap.ts', deckSrc],
      ['search-manager.ts', searchSrc],
      ['InsightsPanel.ts', insightsSrc],
    ] as const) {
      assert.doesNotMatch(source, /\b(?:calculateCII|getCountryScore)\s*\(/, `${path} must not compute local CII`);
    }
  });

  it('aligns CII badge colors and StrategicRiskPanel display bands to source contracts', () => {
    const modalPath = resolve(root, 'src/components/CountryIntelModal.ts');
    const strategicRiskSrc = readSrc('src/components/StrategicRiskPanel.ts');
    const serverRiskSrc = readSrc('server/worldmonitor/intelligence/v1/get-risk-scores.ts');
    const methodologySrc = readSrc('docs/methodology/cii-risk-scores.mdx');
    const mainCss = readSrc('src/styles/main.css');
    const rtlCss = readSrc('src/styles/rtl-overrides.css');

    assert.equal(existsSync(modalPath), false, 'CountryIntelModal is an unused orphan and should stay deleted');
    assert.doesNotMatch(mainCss, /country-intel-/);
    assert.doesNotMatch(mainCss, /\.cii-score-(bar|fill|value)|\.cii-label|\.cii-badge/);
    assert.doesNotMatch(rtlCss, /country-intel-/);

    assert.match(serverRiskSrc, /overallScore >= 70[\s\S]*'SEVERITY_LEVEL_HIGH'[\s\S]*overallScore >= 40[\s\S]*'SEVERITY_LEVEL_MEDIUM'[\s\S]*'SEVERITY_LEVEL_LOW'/);
    assert.match(methodologySrc, /`SEVERITY_LEVEL_HIGH` if `overallScore ≥ 70`[\s\S]*`SEVERITY_LEVEL_MEDIUM` if `40 ≤ overallScore < 70`[\s\S]*`SEVERITY_LEVEL_LOW` if `overallScore < 40`/);
    const strategicRiskBands = strategicRiskSrc.match(/const STRATEGIC_RISK_BANDS: readonly StrategicRiskDisplayBand\[\] = \[[\s\S]*?\] as const;/)?.[0] ?? '';
    assert.notEqual(strategicRiskBands, '', 'missing Strategic Risk display band table');
    assert.match(strategicRiskBands, /min: 81[\s\S]*levelKey: 'critical'[\s\S]*colorVar: '--semantic-critical'[\s\S]*min: 66[\s\S]*levelKey: 'high'[\s\S]*colorVar: '--semantic-high'[\s\S]*min: 51[\s\S]*levelKey: 'elevated'[\s\S]*colorVar: '--semantic-elevated'[\s\S]*min: 31[\s\S]*levelKey: 'normal'[\s\S]*colorVar: '--semantic-normal'[\s\S]*min: 0[\s\S]*levelKey: 'low'[\s\S]*colorVar: '--semantic-low'/);
    assert.doesNotMatch(strategicRiskBands, /min: 70[\s\S]*levelKey: 'high'/);
    assert.doesNotMatch(strategicRiskBands, /min: 40[\s\S]*levelKey: 'medium'/);
    assert.doesNotMatch(strategicRiskBands, /min: 50[\s\S]*levelKey: 'elevated'/);
    assert.doesNotMatch(strategicRiskBands, /min: 30[\s\S]*levelKey: 'moderate'/);
    assert.doesNotMatch(strategicRiskSrc, /normalizeStrategicRiskLevel|STRATEGIC_RISK_LEVEL_ALIASES|strategicRiskLevel/);
    assert.doesNotMatch(strategicRiskSrc, /private getScoreBand\(score: number\)/);
    assert.match(extractMethod(strategicRiskSrc, 'private getScoreColor(score: number): string'), /this\.getFallbackScoreBand\(score\)\.colorVar/);
    assert.match(extractMethod(strategicRiskSrc, 'private getScoreLevel(score: number): string'), /t\(`countryBrief\.levels\.\$\{this\.getFallbackScoreBand\(score\)\.levelKey\}`\)/);
  });

  it('keeps shared CII level labels complete in every locale', () => {
    const localeDir = resolve(root, 'src/locales');
    const localeFiles = readdirSync(localeDir).filter((file) => file.endsWith('.json')).sort();

    for (const file of localeFiles) {
      const locale = JSON.parse(readFileSync(resolve(localeDir, file), 'utf8')) as {
        countryBrief?: { levels?: Record<string, string> };
      };
      const levels = locale.countryBrief?.levels;
      assert.ok(levels?.critical, `${file} must define countryBrief.levels.critical`);
      assert.ok(levels?.high, `${file} must define countryBrief.levels.high`);
      assert.ok(levels?.elevated, `${file} must define countryBrief.levels.elevated`);
      assert.ok(levels?.normal, `${file} must define countryBrief.levels.normal`);
      assert.ok(levels?.low, `${file} must define countryBrief.levels.low`);
    }
  });
});
