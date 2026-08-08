import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import { createBrowserEnvironment } from './helpers/runtime-config-panel-harness.mjs';
import { LeftRail } from '../src/components/RouteExplorer/components/LeftRail.ts';
import { CountryImpactTab } from '../src/components/RouteExplorer/tabs/CountryImpactTab.ts';
import type {
  GetRouteExplorerLaneResponse,
  GetRouteImpactResponse,
} from '../src/generated/server/worldmonitor/supply_chain/v1/service_server.ts';
import type { ResilienceScoreResponse } from '../src/services/resilience.ts';

function snapshotGlobal(name: string) {
  return {
    exists: Object.prototype.hasOwnProperty.call(globalThis, name),
    value: (globalThis as Record<string, unknown>)[name],
  };
}

function restoreGlobal(name: string, snapshot: { exists: boolean; value: unknown }) {
  if (snapshot.exists) {
    Object.defineProperty(globalThis, name, {
      configurable: true,
      writable: true,
      value: snapshot.value,
    });
    return;
  }
  delete (globalThis as Record<string, unknown>)[name];
}

function defineGlobal(name: string, value: unknown) {
  Object.defineProperty(globalThis, name, {
    configurable: true,
    writable: true,
    value,
  });
}

const originalGlobals = {
  document: snapshotGlobal('document'),
  window: snapshotGlobal('window'),
  localStorage: snapshotGlobal('localStorage'),
  requestAnimationFrame: snapshotGlobal('requestAnimationFrame'),
  cancelAnimationFrame: snapshotGlobal('cancelAnimationFrame'),
  navigator: snapshotGlobal('navigator'),
  HTMLElement: snapshotGlobal('HTMLElement'),
  HTMLButtonElement: snapshotGlobal('HTMLButtonElement'),
  Node: snapshotGlobal('Node'),
};

const browserEnvironment = createBrowserEnvironment();
const MiniNode = Object.getPrototypeOf(browserEnvironment.HTMLElement.prototype).constructor;
const STABLE_FIXTURE_DATE = '2024-01-15';
const STABLE_FIXTURE_FETCHED_AT = `${STABLE_FIXTURE_DATE}T00:00:00.000Z`;

defineGlobal('document', browserEnvironment.document);
defineGlobal('window', browserEnvironment.window);
defineGlobal('localStorage', browserEnvironment.localStorage);
defineGlobal('requestAnimationFrame', browserEnvironment.requestAnimationFrame);
defineGlobal('cancelAnimationFrame', browserEnvironment.cancelAnimationFrame);
defineGlobal('navigator', browserEnvironment.window.navigator);
defineGlobal('HTMLElement', browserEnvironment.HTMLElement);
defineGlobal('HTMLButtonElement', browserEnvironment.HTMLButtonElement);
defineGlobal('Node', MiniNode);

after(() => {
  restoreGlobal('document', originalGlobals.document);
  restoreGlobal('window', originalGlobals.window);
  restoreGlobal('localStorage', originalGlobals.localStorage);
  restoreGlobal('requestAnimationFrame', originalGlobals.requestAnimationFrame);
  restoreGlobal('cancelAnimationFrame', originalGlobals.cancelAnimationFrame);
  restoreGlobal('navigator', originalGlobals.navigator);
  restoreGlobal('HTMLElement', originalGlobals.HTMLElement);
  restoreGlobal('HTMLButtonElement', originalGlobals.HTMLButtonElement);
  restoreGlobal('Node', originalGlobals.Node);
});

function laneFixture(overrides: Partial<GetRouteExplorerLaneResponse> = {}): GetRouteExplorerLaneResponse {
  return {
    fromIso2: 'US',
    toIso2: 'NO',
    hs2: '27',
    cargoType: 'EXPLORER_CARGO_CONTAINER',
    currentRoutes: [],
    chokepointExposure: [],
    bypassOptions: [],
    warRiskTier: 'WAR_RISK_TIER_NORMAL',
    disruptionScore: 12,
    estTransitDaysRange: { min: 14, max: 18 },
    estFreightUsdPerTeuRange: { min: 1800, max: 2400 },
    noModeledLane: false,
    fetchedAt: STABLE_FIXTURE_FETCHED_AT,
    ...overrides,
  };
}

function impactFixture(overrides: Partial<GetRouteImpactResponse> = {}): GetRouteImpactResponse {
  return {
    laneValueUsd: 1_200_000,
    primaryExporterIso2: 'NO',
    primaryExporterShare: 0.42,
    topStrategicProducts: [
      {
        hs4: '2709',
        label: 'Crude petroleum',
        totalValueUsd: 4_200_000,
        topExporterIso2: 'NO',
        topExporterShare: 0.61,
        primaryChokepointId: 'north-sea',
      },
    ],
    resilienceScore: 57,
    dependencyFlags: [],
    hs2InSeededUniverse: true,
    comtradeSource: 'live',
    fetchedAt: STABLE_FIXTURE_FETCHED_AT,
    ...overrides,
  };
}

function resilienceFixture(overrides: Partial<ResilienceScoreResponse> = {}): ResilienceScoreResponse {
  return {
    countryCode: 'NO',
    overallScore: 72.6,
    baselineScore: 80,
    stressScore: 61,
    stressFactor: 0.2,
    level: 'high',
    domains: [
      {
        id: 'economic',
        score: 78,
        weight: 1,
        dimensions: [
          { id: 'macroFiscal', score: 78, coverage: 0.9, observedWeight: 1, imputedWeight: 0 },
        ],
      },
    ],
    trend: 'stable',
    change30d: 0,
    lowConfidence: false,
    imputationShare: 0,
    dataVersion: STABLE_FIXTURE_DATE,
    ...overrides,
  };
}

function seedLeftRailResilienceNodes(rail: LeftRail, sourceHtml?: string) {
  if (sourceHtml !== undefined) {
    assert.match(sourceHtml, /re-leftrail__resilience-value/);
    assert.match(sourceHtml, /re-leftrail__resilience-meta/);
  }
  const value = document.createElement('span');
  value.className = 're-leftrail__resilience-value';
  const meta = document.createElement('div');
  meta.className = 're-leftrail__resilience-meta';
  rail.element.replaceChildren(value, meta);
  return { value, meta };
}

function seedImpactResilienceSlot(tab: CountryImpactTab, sourceHtml?: string) {
  if (sourceHtml !== undefined) {
    assert.match(sourceHtml, /re-impact__resilience-slot/);
  }
  const slot = document.createElement('div');
  slot.className = 're-impact__resilience-slot';
  tab.element.replaceChildren(slot);
  return slot;
}

describe('RouteExplorer resilience UI surfaces', () => {
  describe('LeftRail', () => {
    it('renders the destination score row with no authoritative score by default', () => {
      const rail = new LeftRail();

      rail.updateLane(laneFixture());

      assert.match(rail.element.innerHTML, /<h3 class="re-leftrail__title">Resilience<\/h3>/);
      assert.match(rail.element.innerHTML, /<span class="re-leftrail__label">NO score<\/span>/);
      assert.match(
        rail.element.innerHTML,
        /<span class="re-leftrail__value re-leftrail__resilience-value">\u2014<\/span>/,
      );
      assert.doesNotMatch(rail.element.innerHTML, /re-leftrail__resilience-value">\d+\/100/);
      assert.match(rail.element.innerHTML, /<div class="re-leftrail__resilience-meta"><\/div>/);
    });

    it('renders endpoint score, confidence, and a valid score interval', () => {
      const rail = new LeftRail();
      const { value, meta } = seedLeftRailResilienceNodes(rail);

      rail.updateResilience(resilienceFixture({ scoreInterval: { p05: 65.2, p95: 72.8 } }));

      assert.equal(value.textContent, '73/100');
      assert.match(meta.innerHTML, /Coverage 90%/);
      assert.match(meta.innerHTML, /\[65\u201373\]/);
      assert.match(meta.innerHTML, /95% score sensitivity band: 65\.2 - 72\.8/);
      assert.doesNotMatch(meta.innerHTML, /re-resilience-confidence--low/);
    });

    it('keeps updateLane resilience markup compatible with updateResilience selectors', () => {
      const rail = new LeftRail();

      rail.updateLane(laneFixture());
      const renderedLaneHtml = rail.element.innerHTML;
      const { value, meta } = seedLeftRailResilienceNodes(rail, renderedLaneHtml);
      rail.updateResilience(resilienceFixture({
        overallScore: 64.4,
        lowConfidence: true,
        scoreInterval: { p05: 60.2, p95: 68.9 },
      }));

      assert.equal(value.textContent, '64/100');
      assert.match(meta.innerHTML, /Low confidence \u2014 sparse data/);
      assert.match(meta.innerHTML, /\[60\u201369\]/);
    });

    it('surfaces low-confidence endpoint scores instead of treating them as normal cached data', () => {
      const rail = new LeftRail();
      const { value, meta } = seedLeftRailResilienceNodes(rail);

      rail.updateResilience(resilienceFixture({ overallScore: 58.4, lowConfidence: true }));

      assert.equal(value.textContent, '58/100');
      assert.match(meta.innerHTML, /re-resilience-confidence--low/);
      assert.match(meta.innerHTML, /Low confidence \u2014 sparse data/);
    });

    it('omits malformed score intervals while keeping the confidence badge', () => {
      const rail = new LeftRail();
      const { value, meta } = seedLeftRailResilienceNodes(rail);

      rail.updateResilience(resilienceFixture({ scoreInterval: { p05: Number.NaN, p95: 72.8 } }));

      assert.equal(value.textContent, '73/100');
      assert.match(meta.innerHTML, /Coverage 90%/);
      assert.doesNotMatch(meta.innerHTML, /re-resilience-interval/);
    });

    it('does not render null, zero, negative, or NaN resilience sentinels as scores', () => {
      const cases: Array<[string, ResilienceScoreResponse | null]> = [
        ['null response', null],
        ['null score', resilienceFixture({ overallScore: null as unknown as number })],
        ['unknown-level zero score', resilienceFixture({ overallScore: 0, level: 'unknown' })],
        ['missing-level zero score', resilienceFixture({ overallScore: 0, level: undefined as unknown as string })],
        ['negative score', resilienceFixture({ overallScore: -1 })],
        ['NaN score', resilienceFixture({ overallScore: Number.NaN })],
      ];

      for (const [label, resilience] of cases) {
        const rail = new LeftRail();
        const { value, meta } = seedLeftRailResilienceNodes(rail);

        rail.updateResilience(resilience);

        assert.equal(value.textContent, '\u2014', label);
        assert.doesNotMatch(meta.innerHTML, /\/100/, label);
        if (resilience) {
          assert.match(meta.innerHTML, /No scored resilience data/, label);
          assert.match(meta.innerHTML, /re-resilience-confidence--low/, label);
        } else {
          assert.equal(meta.innerHTML, '', label);
        }
      }
    });

    it('renders explicit zero resilience scores when the API level is real', () => {
      const rail = new LeftRail();
      const { value, meta } = seedLeftRailResilienceNodes(rail);

      rail.updateResilience(resilienceFixture({ overallScore: 0, level: 'low' }));

      assert.equal(value.textContent, '0/100');
      assert.match(meta.innerHTML, /Coverage 90%/);
      assert.doesNotMatch(meta.innerHTML, /No scored resilience data/);
    });

    it('renders positive sub-1 resilience scores distinctly from explicit zero', () => {
      const rail = new LeftRail();
      const { value, meta } = seedLeftRailResilienceNodes(rail);

      rail.updateResilience(resilienceFixture({ overallScore: 0.4, level: 'low' }));

      assert.equal(value.textContent, '<1/100');
      assert.match(meta.innerHTML, /Coverage 90%/);
      assert.doesNotMatch(meta.innerHTML, /No scored resilience data/);
    });
  });

  describe('CountryImpactTab', () => {
    it('renders fallback lane resilience score with unavailable confidence when endpoint data is absent', () => {
      const tab = new CountryImpactTab();

      tab.update(impactFixture({ resilienceScore: 57.8 }));

      assert.match(tab.element.innerHTML, /Resilience: <strong>58\/100<\/strong>/);
      assert.match(tab.element.innerHTML, /Confidence unavailable/);
      assert.doesNotMatch(tab.element.innerHTML, /Low confidence/);
    });

    it('omits fallback lane resilience sentinels instead of rendering authoritative scores', () => {
      const cases = [0, -1, Number.NaN];

      for (const resilienceScore of cases) {
        const tab = new CountryImpactTab();

        tab.update(impactFixture({ resilienceScore }));

        assert.match(tab.element.innerHTML, /<div class="re-impact__resilience-slot"><\/div>/);
        assert.doesNotMatch(tab.element.innerHTML, /Confidence unavailable/);
        assert.doesNotMatch(tab.element.innerHTML, /\/100/);
      }
    });

    it('renders endpoint score, confidence, and valid interval over fallback data', () => {
      const tab = new CountryImpactTab();
      tab.update(impactFixture({ resilienceScore: 44 }));
      const slot = seedImpactResilienceSlot(tab);

      tab.updateResilience(resilienceFixture({ scoreInterval: { p05: 66.4, p95: 74.6 } }));

      assert.match(slot.innerHTML, /Resilience: <strong>73\/100<\/strong>/);
      assert.match(slot.innerHTML, /\[66\u201375\]/);
      assert.match(slot.innerHTML, /95% score sensitivity band: 66\.4 - 74\.6/);
      assert.match(slot.innerHTML, /Coverage 90%/);
      assert.doesNotMatch(slot.innerHTML, /Confidence unavailable/);
    });

    it('keeps update-rendered resilience slot compatible with endpoint updates', () => {
      const tab = new CountryImpactTab();

      tab.update(impactFixture());
      const renderedImpactHtml = tab.element.innerHTML;
      const slot = seedImpactResilienceSlot(tab, renderedImpactHtml);
      tab.updateResilience(resilienceFixture({
        overallScore: 81.1,
        lowConfidence: true,
        scoreInterval: { p05: 77.2, p95: 84.8 },
      }));

      assert.match(renderedImpactHtml, /Resilience: <strong>57\/100<\/strong>/);
      assert.match(renderedImpactHtml, /Confidence unavailable/);
      assert.match(slot.innerHTML, /Resilience: <strong>81\/100<\/strong>/);
      assert.match(slot.innerHTML, /Low confidence \u2014 sparse data/);
      assert.match(slot.innerHTML, /\[77\u201385\]/);
    });

    it('preserves low-confidence endpoint text and omits malformed endpoint intervals', () => {
      const tab = new CountryImpactTab();
      tab.update(impactFixture({ resilienceScore: 44 }));
      const slot = seedImpactResilienceSlot(tab);

      tab.updateResilience(resilienceFixture({
        lowConfidence: true,
        scoreInterval: { p05: 66.4, p95: Number.POSITIVE_INFINITY },
      }));

      assert.match(slot.innerHTML, /Resilience: <strong>73\/100<\/strong>/);
      assert.match(slot.innerHTML, /re-resilience-confidence--low/);
      assert.match(slot.innerHTML, /Low confidence \u2014 sparse data/);
      assert.doesNotMatch(slot.innerHTML, /re-resilience-interval/);
    });

    it('renders endpoint no-score state for null, unknown-level zero, negative, and NaN sentinels', () => {
      const cases: Array<[string, ResilienceScoreResponse]> = [
        ['null score', resilienceFixture({ overallScore: null as unknown as number })],
        ['unknown-level zero score', resilienceFixture({ overallScore: 0, level: 'unknown' })],
        ['missing-level zero score', resilienceFixture({ overallScore: 0, level: undefined as unknown as string })],
        ['negative score', resilienceFixture({ overallScore: -1 })],
        ['NaN score', resilienceFixture({ overallScore: Number.NaN })],
      ];

      for (const [label, resilience] of cases) {
        const tab = new CountryImpactTab();
        tab.update(impactFixture({ resilienceScore: 44 }));
        const slot = seedImpactResilienceSlot(tab);

        tab.updateResilience(resilience);

        assert.match(slot.innerHTML, /Resilience: <strong>\u2014<\/strong>/, label);
        assert.match(slot.innerHTML, /No scored resilience data/, label);
        assert.match(slot.innerHTML, /re-resilience-confidence--low/, label);
        assert.doesNotMatch(slot.innerHTML, /44\/100/, label);
      }
    });

    it('renders endpoint explicit zero resilience scores when the API level is real', () => {
      const tab = new CountryImpactTab();
      tab.update(impactFixture({ resilienceScore: 44 }));
      const slot = seedImpactResilienceSlot(tab);

      tab.updateResilience(resilienceFixture({ overallScore: 0, level: 'low' }));

      assert.match(slot.innerHTML, /Resilience: <strong>0\/100<\/strong>/);
      assert.match(slot.innerHTML, /Coverage 90%/);
      assert.doesNotMatch(slot.innerHTML, /No scored resilience data/);
      assert.doesNotMatch(slot.innerHTML, /44\/100/);
    });

    it('renders endpoint positive sub-1 resilience scores distinctly from explicit zero', () => {
      const tab = new CountryImpactTab();
      tab.update(impactFixture({ resilienceScore: 44 }));
      const slot = seedImpactResilienceSlot(tab);

      tab.updateResilience(resilienceFixture({ overallScore: 0.4, level: 'low' }));

      assert.match(slot.innerHTML, /Resilience: <strong>&lt;1\/100<\/strong>/);
      assert.match(slot.innerHTML, /Coverage 90%/);
      assert.doesNotMatch(slot.innerHTML, /No scored resilience data/);
      assert.doesNotMatch(slot.innerHTML, /44\/100/);
    });
  });
});
