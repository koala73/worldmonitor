import { strict as assert } from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, test } from 'node:test';
import {
  getLayerExplanation,
  hasCuratedLayerExplanation,
  LAYER_EXPLANATIONS,
  LAYER_REGISTRY,
  V1_LAYER_EXPLANATION_KEYS,
} from '../src/config/map-layer-definitions';
import { renderLayerExplanationCard } from '../src/utils/layer-explanation-card';

const root = resolve(import.meta.dirname, '..');
const relaySource = readFileSync(resolve(root, 'scripts/ais-relay.cjs'), 'utf8');
const healthSource = readFileSync(resolve(root, 'api/health.js'), 'utf8');

function evalNumberExpression(expression: string): number {
  const cleaned = expression.replace(/_/g, '');
  assert.match(cleaned, /^[0-9\s()+*/.-]+$/, `unsafe numeric expression: ${expression}`);
  const value = Function(`"use strict"; return (${cleaned});`)();
  assert.equal(typeof value, 'number', `expression did not evaluate to a number: ${expression}`);
  assert.ok(Number.isFinite(value), `expression did not evaluate to a finite number: ${expression}`);
  return value;
}

function readSource(path: string): string {
  return readFileSync(resolve(root, path), 'utf8');
}

function constNumber(path: string, name: string): number {
  const source = readSource(path);
  const match = source.match(new RegExp(`const\\s+${name}\\s*=\\s*([^;\\n]+);`));
  assert.ok(match, `${path} must define ${name}`);
  return evalNumberExpression(match[1]);
}

function relayConstMinutes(name: string): number {
  const match = relaySource.match(new RegExp(`const\\s+${name}\\s*=\\s*([^;\\n]+);`));
  assert.ok(match, `scripts/ais-relay.cjs must define ${name}`);
  return evalNumberExpression(match[1]) / 60_000;
}

function relayFunctionConstNumber(functionName: string, name: string): number {
  const start = relaySource.indexOf(`async function ${functionName}(`);
  assert.notEqual(start, -1, `scripts/ais-relay.cjs must define ${functionName}()`);
  const nextFunction = relaySource.indexOf('\nasync function ', start + 1);
  const body = relaySource.slice(start, nextFunction === -1 ? undefined : nextFunction);
  const match = body.match(new RegExp(`const\\s+${name}\\s*=\\s*([^;\\n]+);`));
  assert.ok(match, `scripts/ais-relay.cjs ${functionName}() must define ${name}`);
  return evalNumberExpression(match[1]);
}

function cyberRollingWindowMinutes(): number {
  return relayFunctionConstNumber('seedCyberThreats', 'days') * 24 * 60;
}

function relayEnvDefaultMinutes(name: string): number {
  const match = relaySource.match(new RegExp(`const\\s+${name}\\s*=\\s*Math\\.max\\([^|]+\\|\\|\\s*([0-9_]+)\\)\\)`));
  assert.ok(match, `scripts/ais-relay.cjs must define numeric env default for ${name}`);
  return evalNumberExpression(match[1]) / 60_000;
}

function aviationBreakerCacheMinutes(name: string): number {
  const source = readSource('src/services/aviation/index.ts');
  const match = source.match(new RegExp(`const\\s+${name}\\s*=\\s*createCircuitBreaker<[^>]+>\\(\\{[^}]*cacheTtlMs:\\s*([^,}\\n]+)`));
  assert.ok(match, `src/services/aviation/index.ts must define ${name}.cacheTtlMs`);
  return evalNumberExpression(match[1]) / 60_000;
}

function maxStaleMin(path: string, seedDomain: string): number {
  const source = readSource(path);
  const match = source.match(new RegExp(`runSeed\\(\\s*['"][^'"]+['"]\\s*,\\s*['"]${seedDomain}['"][\\s\\S]*?maxStaleMin:\\s*([^,\\n}]+)`));
  assert.ok(match, `${path} must pass maxStaleMin for ${seedDomain}`);
  return evalNumberExpression(match[1]);
}

function healthMaxStale(entry: string): number {
  const match = healthSource.match(new RegExp(`${entry}:\\s*\\{[^}]*maxStaleMin:\\s*([^,}\\n]+)`));
  assert.ok(match, `api/health.js must declare SEED_META.${entry}.maxStaleMin`);
  return evalNumberExpression(match[1]);
}

function renderedFreshnessText(layerKey: keyof typeof LAYER_REGISTRY): string {
  const html = renderLayerExplanationCard('Layer', getLayerExplanation(layerKey));
  const match = html.match(/<span>Freshness<\/span>\s*<p>([\s\S]*?)<\/p>/);
  assert.ok(match, `${layerKey} card must render a Freshness section`);
  return match[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

function durationMinutes(text: string, pattern: RegExp): number {
  const match = text.match(pattern);
  assert.ok(match, `duration pattern ${pattern} did not match: ${text}`);
  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();
  if (unit.startsWith('second')) return amount / 60;
  if (unit.startsWith('minute')) return amount;
  if (unit.startsWith('hour')) return amount * 60;
  if (unit.startsWith('day')) return amount * 24 * 60;
  throw new Error(`Unsupported duration unit: ${unit}`);
}

function assertDuration(text: string, pattern: RegExp, expectedMinutes: number, label: string): void {
  assert.equal(
    durationMinutes(text, pattern),
    expectedMinutes,
    `${label} must match authoritative freshness/cadence source`,
  );
}

describe('layer explanation metadata', () => {
  test('v1 high-adoption layers have curated structured cards', () => {
    const expected = new Set([
      'conflicts',
      'ucdpEvents',
      'ciiChoropleth',
      'natural',
      'flights',
      'ais',
      'waterways',
      'tradeRoutes',
      'cyberThreats',
      'hotspots',
    ]);

    assert.deepEqual(new Set(V1_LAYER_EXPLANATION_KEYS), expected);

    for (const key of V1_LAYER_EXPLANATION_KEYS) {
      assert.ok(LAYER_REGISTRY[key], `${key} must be a registered layer`);
      assert.equal(hasCuratedLayerExplanation(key), true, `${key} must have curated metadata`);

      const explanation = getLayerExplanation(key);
      assert.equal(explanation.coverage, 'curated', `${key} must not use fallback metadata`);
      assert.equal(explanation.key, key);
      assert.ok(explanation.category.trim(), `${key} category is required`);
      assert.ok(explanation.purpose.trim(), `${key} purpose is required`);
      assert.ok(explanation.source.trim(), `${key} source/provider text is required`);
      assert.ok(explanation.freshness.trim(), `${key} freshness text is required`);
      assert.ok(explanation.confidence.trim(), `${key} confidence text is required`);
      assert.ok(explanation.limitations.length > 0, `${key} limitations are required`);
      assert.ok(explanation.related.length > 0, `${key} related panels/actions are required`);
      assert.ok(explanation.evidence.length > 0, `${key} evidence paths are required`);

      for (const evidencePath of explanation.evidence) {
        assert.equal(
          existsSync(resolve(root, evidencePath)),
          true,
          `${key} evidence path does not exist: ${evidencePath}`,
        );
      }
    }
  });

  test('unsupported layers degrade to fallback metadata without fabricating freshness', () => {
    const explanation = getLayerExplanation('dayNight');

    assert.equal(explanation.coverage, 'fallback');
    assert.equal(explanation.key, 'dayNight');
    assert.equal(hasCuratedLayerExplanation('dayNight'), false);
    assert.match(explanation.source, /Not curated/i);
    assert.match(explanation.freshness, /No layer-level freshness contract/i);
    assert.match(explanation.confidence, /Unknown/i);
    assert.deepEqual(explanation.evidence, []);
  });

  test('curated freshness text is a data contract against seeder and runtime cadence sources', () => {
    const naturalCadenceMin = maxStaleMin('scripts/seed-natural-events.mjs', 'events') / 3;
    const naturalTtlMin = constNumber('scripts/seed-natural-events.mjs', 'CACHE_TTL') / 60;
    assert.equal(naturalTtlMin, naturalCadenceMin * 6, 'natural TTL must keep the documented 6x cadence buffer');
    assertDuration(renderedFreshnessText('natural'), /every\s+([0-9]+)\s+(hour)s?/i, naturalCadenceMin, 'natural event seed cadence');

    const aviationCadenceMin = maxStaleMin('scripts/seed-aviation.mjs', 'intl') / 3;
    assertDuration(renderedFreshnessText('flights'), /([0-9]+)-\s*(minute)\s+cadence/i, aviationCadenceMin, 'aviation disruption seed cadence');
    assertDuration(
      renderedFreshnessText('flights'),
      /([0-9]+)-\s*(minute)\s+polling cycle/i,
      aviationBreakerCacheMinutes('breakerFlights'),
      'aviation panel polling cycle',
    );

    assertDuration(renderedFreshnessText('ucdpEvents'), /every\s+([0-9]+)\s+(hour)s?/i, relayConstMinutes('UCDP_POLL_INTERVAL_MS'), 'UCDP relay seed cadence');
    assert.equal(healthMaxStale('ucdpEvents'), relayConstMinutes('UCDP_POLL_INTERVAL_MS') + 60, 'UCDP health budget should be cadence plus one hour grace');

    assertDuration(renderedFreshnessText('cyberThreats'), /every\s+([0-9]+)\s+(hour)s?/i, relayConstMinutes('CYBER_SEED_INTERVAL_MS'), 'cyber relay seed cadence');
    assertDuration(renderedFreshnessText('cyberThreats'), /([0-9]+)-\s*(day)\s+rolling window/i, cyberRollingWindowMinutes(), 'cyber IOC rolling window');
    assert.equal(healthMaxStale('cyberThreats'), relayConstMinutes('CYBER_SEED_INTERVAL_MS') * 2, 'cyber health budget should stay 2x relay cadence');

    assertDuration(renderedFreshnessText('ciiChoropleth'), /every\s+([0-9]+)\s+(minute)s?/i, relayConstMinutes('CII_WARM_PING_INTERVAL_MS'), 'CII warm-ping cadence');
    assertDuration(renderedFreshnessText('ciiChoropleth'), /([0-9]+)-\s*(minute)\s+freshness budget/i, healthMaxStale('riskScores'), 'CII health freshness budget');

    assertDuration(renderedFreshnessText('ais'), /every\s+([0-9]+)\s+(second)s?/i, relayEnvDefaultMinutes('SNAPSHOT_INTERVAL_MS'), 'AIS relay snapshot cadence');
    assertDuration(
      renderedFreshnessText('ais'),
      /([0-9]+)\s+(minute)s?/i,
      constNumber('server/worldmonitor/maritime/v1/get-vessel-snapshot.ts', 'SNAPSHOT_CACHE_TTL_BASE_MS') / 60_000,
      'AIS base snapshot server cache',
    );

    for (const layer of ['waterways', 'tradeRoutes'] as const) {
      const text = renderedFreshnessText(layer);
      assertDuration(text, /every\s+([0-9]+)\s+(minute)s?/i, relayConstMinutes('CHOKEPOINT_WARM_PING_INTERVAL_MS'), `${layer} chokepoint warm-ping cadence`);
      assertDuration(text, /refresh\s+every\s+([0-9]+)\s+(minute)s?/i, relayConstMinutes('TRANSIT_SUMMARY_INTERVAL_MS'), `${layer} transit-summary cadence`);
    }

    assertDuration(
      renderedFreshnessText('hotspots'),
      /around\s+([0-9]+)\s+(minute)s?/i,
      constNumber('src/services/live-news.ts', 'CACHE_TTL') / 60_000,
      'hotspot live-news RSS cache',
    );
  });

  test('freshness contract assertions fail on stale copied cadence values', () => {
    const staleNaturalText = renderedFreshnessText('natural').replace('3 hours', '12 hours');

    assert.throws(
      () => assertDuration(staleNaturalText, /every\s+([0-9]+)\s+(hour)s?/i, maxStaleMin('scripts/seed-natural-events.mjs', 'events') / 3, 'natural event seed cadence'),
      /natural event seed cadence must match authoritative freshness\/cadence source/,
    );
  });

  test('cyber source text distinguishes ransomware.live news from geo-enriched IOCs', () => {
    const cyberThreats = getLayerExplanation('cyberThreats');

    assert.match(cyberThreats.source, /ransomware\.live RSS\/news feed/i);
    assert.match(cyberThreats.source, /IP geolocation enrichment/i);
  });

  test('curated explanations are not accidentally added outside the declared v1 set', () => {
    const declared = new Set<string>(V1_LAYER_EXPLANATION_KEYS);
    const curated = Object.entries(LAYER_EXPLANATIONS)
      .filter(([, explanation]) => explanation?.coverage === 'curated')
      .map(([key]) => key);

    assert.deepEqual(new Set(curated), declared);
  });
});

describe('map layer explanation control wiring', () => {
  const componentSources = new Map([
    ['SVG map', readFileSync(resolve(root, 'src/components/Map.ts'), 'utf8')],
    ['DeckGL map', readFileSync(resolve(root, 'src/components/DeckGLMap.ts'), 'utf8')],
    ['Globe map', readFileSync(resolve(root, 'src/components/GlobeMap.ts'), 'utf8')],
  ]);
  const rendererSource = readFileSync(resolve(root, 'src/utils/layer-explanation-card.ts'), 'utf8');

  test('layer pickers render an explanation button for each layer row', () => {
    for (const [name, source] of componentSources) {
      assert.match(source, /layer-toggle-row/, `${name} must keep the layer and explanation controls grouped`);
      assert.match(source, /layer-explain-btn/, `${name} must render explanation buttons`);
      assert.match(source, /aria-label/, `${name} explanation buttons must be screen-reader labeled`);
      assert.match(source, /hasCuratedLayerExplanation/, `${name} must distinguish curated coverage`);
    }
  });

  test('info button opens the structured explanation card without toggling the layer', () => {
    for (const [name, source] of componentSources) {
      assert.match(source, /event\.preventDefault\(\)/, `${name} must not submit or trigger parent controls`);
      assert.match(source, /event\.stopPropagation\(\)/, `${name} must not toggle the layer when opening help`);
      assert.match(source, /this\.showLayerExplanation\(layer\)/, `${name} must open the explanation card`);
      assert.match(source, /getLayerExplanation\(layer\)/, `${name} must use the shared explanation catalog`);
      assert.match(source, /renderLayerExplanationCard/, `${name} must use the shared explanation renderer`);
    }
  });

  test('explanation card exposes source, freshness, confidence, limitations, and related sections', () => {
    for (const label of ['Source', 'Freshness', 'Confidence', 'Limitations', 'Related']) {
      assert.match(rendererSource, new RegExp(`>${label}<`), `missing shared card section: ${label}`);
    }
  });

  test('DeckGL help and explanation popups dismiss each other', () => {
    const source = componentSources.get('DeckGL map');
    assert.ok(source);
    assert.match(source, /querySelector\('\.layer-help-popup'\)\?\.remove\(\)/);
    assert.match(source, /querySelector\('\.layer-explanation-popup'\)\?\.remove\(\)/);
  });

  test('SVG map clears stale outside-click listeners when explanation popups close or switch', () => {
    const source = componentSources.get('SVG map');
    assert.ok(source);
    assert.match(source, /layerExplanationOutsideClickHandler/);
    assert.match(source, /clearLayerExplanationOutsideClickHandler\(\)/);
    assert.match(source, /document\.removeEventListener\('click', this\.layerExplanationOutsideClickHandler\)/);
  });

  test('SVG map preserves the localized sanctions label path', () => {
    const source = componentSources.get('SVG map');
    assert.ok(source);
    assert.match(source, /layer === 'sanctions'/);
    assert.match(source, /components\.deckgl\.layerHelp\.labels\.sanctions/);
  });
});
