import { strict as assert } from 'node:assert';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, test } from 'node:test';
import i18next from 'i18next';
import {
  getLayerExplanation,
  hasCuratedLayerExplanation,
  LAYER_EXPLANATIONS,
  LAYER_REGISTRY,
  layerExplanationCopyPrefix,
  V1_LAYER_EXPLANATION_KEYS,
} from '../src/config/map-layer-definitions';
import { layerExplanationList, layerExplanationLookup, renderLayerExplanationCard } from '../src/utils/layer-explanation-card';
import { escapeHtml } from '../src/utils/sanitize';

const root = resolve(import.meta.dirname, '..');
const relaySource = readFileSync(resolve(root, 'scripts/ais-relay.cjs'), 'utf8');
const healthSource = readFileSync(resolve(root, 'api/health.js'), 'utf8');
const enLocale = JSON.parse(readFileSync(resolve(root, 'src/locales/en.json'), 'utf8')) as LocaleTree;
const deLocale = JSON.parse(readFileSync(resolve(root, 'src/locales/de.json'), 'utf8')) as LocaleTree;

type LocaleTree = Record<string, unknown>;

interface LayerCopyBlock {
  category: string;
  purpose: string;
  source: string;
  freshness: string;
  confidence: string;
  limitations: string[];
  related: string[];
}

function lookupLocale(locale: LocaleTree, key: string): unknown {
  const value = key.split('.').reduce<unknown>((current, part) => {
    if (current == null || typeof current !== 'object') return undefined;
    return (current as LocaleTree)[part];
  }, locale);
  return value === undefined ? key : value;
}

function dictionaryLookup(primary: LocaleTree, fallback?: LocaleTree) {
  return (key: string) => {
    const value = lookupLocale(primary, key);
    if (value !== key) return value;
    return fallback ? lookupLocale(fallback, key) : key;
  };
}

const englishCopy = dictionaryLookup(enLocale);

function copyBlock(layerKey: keyof typeof LAYER_REGISTRY): LayerCopyBlock {
  const explanation = getLayerExplanation(layerKey);
  const prefix = layerExplanationCopyPrefix(explanation.key, explanation.coverage);
  const block = lookupLocale(enLocale, prefix);
  assert.equal(typeof block, 'object', `${layerKey} lacks i18n copy at ${prefix}`);
  assert.ok(block && !Array.isArray(block), `${prefix} must be an object`);
  const record = block as Record<string, unknown>;
  return {
    category: String(record.category ?? ''),
    purpose: String(record.purpose ?? ''),
    source: String(record.source ?? ''),
    freshness: String(record.freshness ?? ''),
    confidence: String(record.confidence ?? ''),
    limitations: layerExplanationList(record.limitations),
    related: layerExplanationList(record.related),
  };
}

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

function refreshIntervalMinutes(name: string): number {
  const block = readSource('src/config/variants/base.ts').match(/export const REFRESH_INTERVALS = \{([\s\S]*?)\n\};/);
  assert.ok(block, 'src/config/variants/base.ts must define REFRESH_INTERVALS');
  const match = block[1].match(new RegExp(`\\n\\s*${name}:\\s*([^,\\n]+),`));
  assert.ok(match, `REFRESH_INTERVALS must define ${name}`);
  return evalNumberExpression(match[1]) / 60_000;
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
  const html = renderLayerExplanationCard('Layer', getLayerExplanation(layerKey), englishCopy);
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
      'weather',
      'canadaRoads', 'canadaAlerts',
      'flights',
      'aircraftEmergencies',
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
      const copy = copyBlock(key);
      assert.equal(explanation.coverage, 'curated', `${key} must not use fallback metadata`);
      assert.equal(explanation.key, key);
      assert.ok(copy.category.trim(), `${key} category is required`);
      assert.ok(copy.purpose.trim(), `${key} purpose is required`);
      assert.ok(copy.source.trim(), `${key} source/provider text is required`);
      assert.ok(copy.freshness.trim(), `${key} freshness text is required`);
      assert.ok(copy.confidence.trim(), `${key} confidence text is required`);
      assert.ok(copy.limitations.length > 0, `${key} limitations are required`);
      assert.ok(copy.related.length > 0, `${key} related panels/actions are required`);
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
    const copy = copyBlock('dayNight');

    assert.equal(explanation.coverage, 'fallback');
    assert.equal(explanation.key, 'dayNight');
    assert.equal(hasCuratedLayerExplanation('dayNight'), false);
    assert.match(copy.source, /Not curated/i);
    assert.match(copy.freshness, /No layer-level freshness contract/i);
    assert.match(copy.confidence, /Unknown/i);
    assert.deepEqual(explanation.evidence, []);
  });

  test('curated freshness text is a data contract against seeder and runtime cadence sources', () => {
    const naturalCadenceMin = maxStaleMin('scripts/seed-natural-events.mjs', 'events') / 3;
    const naturalTtlMin = constNumber('scripts/seed-natural-events.mjs', 'CACHE_TTL') / 60;
    assert.equal(naturalTtlMin, naturalCadenceMin * 6, 'natural TTL must keep the documented 6x cadence buffer');
    assertDuration(renderedFreshnessText('natural'), /every\s+([0-9]+)\s+(hour)s?/i, naturalCadenceMin, 'natural event seed cadence');

    assertDuration(renderedFreshnessText('weather'), /every\s+([0-9]+)\s+(minute)s?/i, relayConstMinutes('WEATHER_SEED_INTERVAL_MS'), 'weather relay seed cadence');
    assertDuration(renderedFreshnessText('weather'), /([0-9]+)-\s*(minute)\s+freshness budget/i, healthMaxStale('weatherAlerts'), 'weather health freshness budget');

    assertDuration(renderedFreshnessText('canadaRoads'), /every\s+([0-9]+)\s+(minute)s?/i, 15, 'ontario 511 seed cadence');
    assert.equal(healthMaxStale('albertaRoads'), healthMaxStale('canadaRoads'), 'Alberta 511 shares the 45-minute 3x cron budget');
    assert.equal(healthMaxStale('manitobaRoads'), healthMaxStale('canadaRoads'), 'Manitoba 511 shares the 45-minute 3x cron budget');
    assertDuration(renderedFreshnessText('canadaRoads'), /([0-9]+)-\s*(minute)\s+freshness budget/i, healthMaxStale('canadaRoads'), 'ontario 511 health freshness budget');
    assertDuration(renderedFreshnessText('canadaAlerts'), /every\s+([0-9]+)\s+(minute)s?/i, 15, 'alberta AEA seed cadence');
    assertDuration(renderedFreshnessText('canadaAlerts'), /([0-9]+)-\s*(minute)\s+freshness budget/i, healthMaxStale('canadaAlerts'), 'alberta AEA health freshness budget');
    assert.equal(healthMaxStale('canadaAlerts'), maxStaleMin('scripts/seed-alberta-emergency-alert.mjs', 'alberta-aea'), 'canadaAlerts health budget must match seeder maxStaleMin');

    const nmsService = JSON.parse(readSource('scripts/railway-services.json')).find((s: { service: string }) => s.service === 'seed-notam-nms');
    assert.equal(nmsService?.cronSchedule, '*/5 * * * *', 'seed-notam-nms runs every 5 minutes');
    // Airspace NOTAMs are drawn by the Aviation layer, so its card owns the NMS cadence.
    assertDuration(renderedFreshnessText('flights'), /every\s+([0-9]+)\s+(minute)s?/i, 5, 'FAA NMS seed cadence');
    assertDuration(renderedFreshnessText('flights'), /([0-9]+)-\s*(minute)\s+freshness budget/i, healthMaxStale('notamAirspace'), 'FAA NMS health freshness budget');

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

    // Hotspot levels are recomputed from the dashboard news, which reloads on the feeds refresh loop.
    assertDuration(
      renderedFreshnessText('hotspots'),
      /around\s+([0-9]+)\s+(minute)s?\s+apart/i,
      refreshIntervalMinutes('feeds'),
      'hotspot news refresh cadence',
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
    const cyberThreats = copyBlock('cyberThreats');

    assert.match(cyberThreats.source, /ransomware\.live RSS\/news feed/i);
    assert.match(cyberThreats.source, /IP geolocation enrichment/i);
  });

  test('canadaRoads explanation discloses provincial and Toronto coverage on one layer', () => {
    const roads = copyBlock('canadaRoads');
    assert.match(LAYER_REGISTRY.canadaRoads.fallbackLabel, /Canada/i);
    assert.match(roads.source, /Ontario 511/i);
    assert.match(roads.source, /Alberta 511/i);
    assert.match(roads.source, /Manitoba 511/i);
    assert.match(roads.source, /Toronto Road Restrictions/i);
    assert.match(roads.source, /DriveBC Open511/i);
    assert.match(roads.purpose, /closures/i);
    assert.doesNotMatch(roads.source, /Alberta 511[^.]{0,80}road-conditions/i);
    assert.equal(
      roads.limitations.some(limitation => /Manitoba 511 is not ingested/i.test(limitation)),
      false,
      'canadaRoads limitations must not still name Manitoba as not ingested',
    );
    assert.ok(
      roads.limitations.some(limitation => /Alberta 511 roadconditions is not ingested/i.test(limitation)),
      'canadaRoads limitations must say Alberta roadconditions is not ingested',
    );
    const roadsEvidence = getLayerExplanation('canadaRoads').evidence;
    for (const path of ['scripts/seed-provincial-511.mjs', 'scripts/seed-toronto-road-restrictions.mjs', 'scripts/seed-open511.mjs', 'api/health.js', 'src/services/canada-roads.ts']) {
      assert.ok(roadsEvidence.includes(path), `canadaRoads evidence must cite ${path}`);
    }
  });


  test('weather explanation discloses NWS, ECCC, and WMO SWIC coverage', () => {
    const weather = copyBlock('weather');

    assert.equal(LAYER_REGISTRY.weather.fallbackLabel, 'Severe Weather Alerts (NWS, ECCC, WMO SWIC)');
    assert.match(weather.source, /National Weather Service \(NWS\)/i);
    assert.match(weather.source, /Environment and Climate Change Canada \(ECCC\)/i);
    assert.match(weather.source, /WMO Severe Weather Information Centre \(SWIC\)/i);
    assert.ok(
      weather.limitations.some(limitation => /country-level points/i.test(limitation)),
      'weather limitations must say SWIC geocoded alerts render as country-level points',
    );
    assert.ok(
      !weather.limitations.some(limitation => /outside the United States and Canada/i.test(limitation)),
      'weather limitations must not still claim coverage is US + Canada only',
    );
    const weatherEvidence = getLayerExplanation('weather').evidence;
    for (const path of ['scripts/ais-relay.cjs', 'scripts/_weather-alert-select.mjs', 'api/health.js', 'src/services/weather.ts']) {
      assert.ok(weatherEvidence.includes(path), `weather evidence must cite ${path}`);
    }
  });

  test('canadaAlerts explanation discloses Alberta, B.C., and Saskatchewan coverage', () => {
    const canadaAlerts = copyBlock('canadaAlerts');

    assert.equal(LAYER_REGISTRY.canadaAlerts.fallbackLabel, 'Canada Alerts (AB + BC + SK)');
    assert.match(canadaAlerts.source, /Alberta Emergency Alert/i);
    assert.match(canadaAlerts.source, /OGL-BC Evacuation Orders and Alerts/i);
    assert.match(canadaAlerts.source, /SaskAlert/i);
    assert.ok(
      canadaAlerts.limitations.some(limitation => /Alberta, British Columbia, and Saskatchewan/i.test(limitation)),
      'canadaAlerts limitations must state the supported provincial scope',
    );
    const canadaAlertsEvidence = getLayerExplanation('canadaAlerts').evidence;
    for (const path of ['scripts/seed-alberta-emergency-alert.mjs', 'scripts/seed-bc-emergency-info.mjs', 'scripts/seed-saskalert.mjs', 'api/health.js', 'src/services/canada-alerts.ts']) {
      assert.ok(canadaAlertsEvidence.includes(path), `canadaAlerts evidence must cite ${path}`);
    }
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
      assert.match(source, /layerExplanationLookup\(t\)/, `${name} must resolve the card through t()`);
    }
  });

  test('explanation card exposes source, freshness, confidence, limitations, and related sections', () => {
    const html = renderLayerExplanationCard('Layer', getLayerExplanation('hotspots'), englishCopy);
    for (const label of ['Source', 'Freshness', 'Confidence', 'Limitations', 'Related']) {
      assert.match(html, new RegExp(`>${label}<`), `missing shared card section: ${label}`);
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

const COPY_FIELDS = ['category', 'purpose', 'source', 'freshness', 'confidence', 'limitations', 'related'] as const;
const LABEL_KEYS = [
  'layerExplanation.labels.source',
  'layerExplanation.labels.freshness',
  'layerExplanation.labels.confidence',
  'layerExplanation.labels.limitations',
  'layerExplanation.labels.related',
  'layerExplanation.labels.groundedIn',
  'layerExplanation.labels.curated',
  'layerExplanation.labels.fallback',
  'layerExplanation.labels.layerGuide',
] as const;

function missingExplanationKeys(locale: LocaleTree): string[] {
  const missing: string[] = [];
  for (const key of Object.keys(LAYER_REGISTRY) as Array<keyof typeof LAYER_REGISTRY>) {
    const explanation = getLayerExplanation(key);
    const prefix = layerExplanationCopyPrefix(explanation.key, explanation.coverage);
    for (const field of COPY_FIELDS) {
      const path = `${prefix}.${field}`;
      const value = lookupLocale(locale, path);
      const list = layerExplanationList(value);
      const ok = field === 'limitations' || field === 'related'
        ? list.length > 0 && list.every((item) => item.trim() !== '')
        : typeof value === 'string' && value.trim() !== '' && value !== path;
      if (!ok) missing.push(`${key} ${path}`);
    }
  }
  for (const key of LABEL_KEYS) {
    const value = lookupLocale(locale, key);
    if (typeof value !== 'string' || value.trim() === '' || value === key) missing.push(key);
  }
  return missing;
}

describe('layer explanation localization', () => {
  test('every map layer has an i18n description key', () => {
    assert.deepEqual(missingExplanationKeys(enLocale), []);
  });

  test('missing English prose and labels fail the completeness check', () => {
    const incomplete = structuredClone(enLocale);
    const explanation = lookupLocale(incomplete, 'layerExplanation.layers.hotspots') as LocaleTree;
    const labels = lookupLocale(incomplete, 'layerExplanation.labels') as LocaleTree;
    delete explanation.purpose;
    delete labels.source;
    const missing = missingExplanationKeys(incomplete);
    assert.ok(missing.includes('hotspots layerExplanation.layers.hotspots.purpose'));
    assert.ok(missing.includes('layerExplanation.labels.source'));
  });

  test('German locale renders translated card labels and hotspot prose', () => {
    const html = renderLayerExplanationCard(
      'Intel-Hotspots',
      getLayerExplanation('hotspots'),
      dictionaryLookup(deLocale, enLocale),
    );
    for (const label of ['Quelle', 'Aktualität', 'Konfidenz', 'Einschränkungen', 'Verwandt', 'Belegt in', 'Kuratiert v1']) {
      assert.match(html, new RegExp(`>${label}<`), `German card missing ${label}`);
    }
    assert.match(html, /Hebt überwachte geopolitische Hotspots hervor/);
    assert.equal(html.includes('>Source<'), false);
    assert.equal(html.includes('Highlights monitored geopolitical hotspots'), false);
    assert.match(html, /aria-label="Schließen"/);
  });

  test('a missing locale value falls back to the English description', async () => {
    const englishPurpose = copyBlock('hotspots').purpose;
    const instance = i18next.createInstance();
    await instance.init({
      lng: 'de',
      fallbackLng: 'en',
      resources: {
        de: { translation: { layerExplanation: { labels: { source: 'Quelle' } } } },
        en: { translation: { layerExplanation: enLocale.layerExplanation } },
      },
      interpolation: { escapeValue: false },
      returnNull: false,
    });
    const html = renderLayerExplanationCard(
      'Intel-Hotspots',
      getLayerExplanation('hotspots'),
      layerExplanationLookup((key, options) => instance.t(key, options)),
    );
    assert.match(html, />Quelle</);
    assert.match(html, new RegExp(englishPurpose.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });

  test('German fallback layers use the shared fallback description', () => {
    const html = renderLayerExplanationCard(
      'Tag/Nacht',
      getLayerExplanation('dayNight'),
      dictionaryLookup(deLocale, enLocale),
    );
    assert.match(html, />Nicht kuratiert</);
    assert.match(html, /kuratierte Quellen- und Konfidenzkarte/);
    assert.equal(html.includes('>Fallback<'), false);
    assert.equal(html.includes('a curated source and confidence card has not been added yet'), false);
  });

  test('every shipped locale renders its own explanation card', () => {
    const english = collectLayerExplanationStrings(enLocale);
    const englishPurpose = english.get('layerExplanation.layers.hotspots.purpose') ?? '';
    const englishFallback = english.get('layerExplanation.fallback.purpose') ?? '';
    assert.ok(englishPurpose.length > 0, 'English hotspot purpose is required');
    assert.ok(englishFallback.length > 0, 'English fallback purpose is required');

    const problems: string[] = [];
    for (const code of shippedLocaleCodes()) {
      const locale = code === 'en' ? enLocale : loadLocale(code);
      const strings = collectLayerExplanationStrings(locale);
      for (const [path, englishValue] of english) {
        const value = strings.get(path);
        if (value === undefined || value.trim() === '') {
          problems.push(`${code} missing ${path}`);
          continue;
        }
        if (code !== 'en' && isLayerExplanationProse(path) && value === englishValue) {
          problems.push(`${code} left English prose at ${path}`);
        }
      }
      for (const path of strings.keys()) {
        if (!english.has(path)) problems.push(`${code} orphan ${path}`);
      }

      const lookup = dictionaryLookup(locale, enLocale);
      const hotspots = renderLayerExplanationCard('Hotspots', getLayerExplanation('hotspots'), lookup);
      const fallback = renderLayerExplanationCard('Day/Night', getLayerExplanation('dayNight'), lookup);
      const purpose = strings.get('layerExplanation.layers.hotspots.purpose') ?? '';
      const fallbackPurpose = strings.get('layerExplanation.fallback.purpose') ?? '';
      if (purpose && !hotspots.includes(escapeHtml(purpose))) problems.push(`${code} hotspot card dropped its purpose`);
      if (fallbackPurpose && !fallback.includes(escapeHtml(fallbackPurpose))) problems.push(`${code} fallback card dropped its purpose`);
      for (const labelKey of ['source', 'freshness', 'confidence', 'limitations', 'related', 'groundedIn', 'curated'] as const) {
        const label = strings.get(`layerExplanation.labels.${labelKey}`) ?? '';
        if (!hotspots.includes(`>${escapeHtml(label)}<`)) problems.push(`${code} hotspot card missing ${labelKey} label`);
      }
      const fallbackLabel = strings.get('layerExplanation.labels.fallback') ?? '';
      if (!fallback.includes(`>${escapeHtml(fallbackLabel)}<`)) problems.push(`${code} fallback card missing its coverage label`);
      if (code !== 'en') {
        if (hotspots.includes(englishPurpose)) problems.push(`${code} hotspot card still shows the English purpose`);
        if (fallback.includes(englishFallback)) problems.push(`${code} fallback card still shows the English purpose`);
        if (hotspots.includes('>Freshness<')) problems.push(`${code} hotspot card still shows the English Freshness label`);
      }
    }
    assert.deepEqual(problems, []);
  });
});

const PROSE_FIELDS = new Set(['purpose', 'source', 'freshness', 'confidence', 'limitations', 'related']);

function shippedLocaleCodes(): string[] {
  const source = readFileSync(resolve(root, 'src/services/i18n.ts'), 'utf8');
  const match = source.match(/const SUPPORTED_LANGUAGES = \[([^\]]+)\] as const/);
  assert.ok(match, 'src/services/i18n.ts must declare SUPPORTED_LANGUAGES');
  const declared = [...match[1].matchAll(/'([^']+)'/g)].map((item) => item[1]).sort();
  const files = readdirSync(resolve(root, 'src/locales'))
    .filter((name) => name.endsWith('.json') && name !== 'en.shell.json')
    .map((name) => name.replace(/\.json$/, ''))
    .sort();
  assert.deepEqual(files, declared, 'every supported language needs a full locale file');
  return declared;
}

function loadLocale(code: string): LocaleTree {
  return JSON.parse(readFileSync(resolve(root, `src/locales/${code}.json`), 'utf8')) as LocaleTree;
}

function collectLayerExplanationStrings(locale: LocaleTree): Map<string, string> {
  const out = new Map<string, string>();
  collectStrings(locale.layerExplanation, 'layerExplanation', out);
  return out;
}

function collectStrings(value: unknown, path: string, out: Map<string, string>): void {
  if (typeof value === 'string') {
    out.set(path, value);
    return;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  for (const [key, child] of Object.entries(value)) {
    collectStrings(child, `${path}.${key}`, out);
  }
}

function isLayerExplanationProse(path: string): boolean {
  if (path.startsWith('layerExplanation.labels.')) return false;
  return path.split('.').some((part) => PROSE_FIELDS.has(part));
}
