import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { ValidationError } from '../src/generated/server/worldmonitor/shipping/v2/service_server';
import {
  OCCURRENCE_EVENT_TYPES,
  isOccurrenceEvent,
  normalizeWebhookScope,
  scopeSchemaFor,
} from '../server/worldmonitor/shipping/v2/webhook-scope';
import registry from '../shared/event-triggers.json';

// The `scope` object of an occurrence-event subscription is validated against
// the event's inputSchema in shared/event-triggers.json, so the registry is
// the one contract; defaults are stored on the record (the worker never reads
// registry defaults for an existing subscription).

function rejects(fn: () => unknown, field: string, pattern?: RegExp): void {
  assert.throws(fn, (err: unknown) => {
    assert.ok(err instanceof ValidationError, `expected ValidationError, got ${String(err)}`);
    assert.equal(err.violations[0]?.field, field);
    if (pattern) assert.match(err.violations[0]?.description ?? '', pattern);
    return true;
  });
}

describe('occurrence event set', () => {
  it('is derived from the registry kinds', () => {
    const expected = Object.values(registry.events).filter((event) => event.kind === 'occurrence').map((event) => event.key).sort();
    assert.deepEqual([...OCCURRENCE_EVENT_TYPES].sort(), expected);
    assert.ok(expected.includes('news.breaking') && expected.includes('market.move'));
    assert.equal(isOccurrenceEvent('chokepoint.disruption'), false);
    assert.equal(scopeSchemaFor('country.risk_surge'), null);
    assert.deepEqual(Object.keys(scopeSchemaFor('news.breaking') ?? {}).sort(), ['categories', 'countries', 'importanceFloor', 'keywords', 'severityFloor']);
  });
});

describe('normalizeWebhookScope: threshold events', () => {
  it('returns an empty scope when nothing is sent, including the generated client\'s empty arrays', () => {
    assert.deepEqual(normalizeWebhookScope('chokepoint.disruption', undefined), {});
    assert.deepEqual(normalizeWebhookScope('country.risk_surge', { keywords: [], symbols: [], severityFloor: '' }), {});
  });

  it('rejects any set scope key with a 400 on `scope`, like countries on a chokepoint subscription', () => {
    rejects(() => normalizeWebhookScope('chokepoint.disruption', { keywords: ['iran'] }), 'scope', /applies only to/);
    rejects(() => normalizeWebhookScope('country.risk_surge', { minAbsPct: 10 }), 'scope');
  });
});

describe('normalizeWebhookScope: news.breaking', () => {
  it('applies the registry defaults when scope is absent (importance 69, severity high, no lists)', () => {
    assert.deepEqual(normalizeWebhookScope('news.breaking', undefined), {
      keywords: [], categories: [], countries: [], importanceFloor: 69, severityFloor: 'high',
    });
    assert.deepEqual(normalizeWebhookScope('news.breaking', {}), normalizeWebhookScope('news.breaking', null));
  });

  it('lower-cases, trims and de-duplicates keywords, upper-cases countries, keeps categories as sent', () => {
    const scope = normalizeWebhookScope('news.breaking', {
      keywords: [' Hormuz ', 'hormuz', 'Strait of Hormuz'],
      countries: ['ir', ' IR', 'ua'],
      categories: ['conflict', 'military', 'conflict'],
      importanceFloor: 75,
      severityFloor: 'critical',
    });
    assert.deepEqual(scope, {
      keywords: ['hormuz', 'strait of hormuz'],
      categories: ['conflict', 'military'],
      countries: ['IR', 'UA'],
      importanceFloor: 75,
      severityFloor: 'critical',
    });
  });

  it('rejects a key another event owns, naming the accepted keys', () => {
    rejects(() => normalizeWebhookScope('news.breaking', { symbols: ['VIX'] }), 'scope.symbols', /does not apply to news\.breaking/);
    rejects(() => normalizeWebhookScope('news.breaking', { minMagnitude: 6 }), 'scope.minMagnitude');
  });

  it('rejects out-of-range floors, unknown enums, bad country codes and over-long keyword lists', () => {
    rejects(() => normalizeWebhookScope('news.breaking', { importanceFloor: 101 }), 'scope.importanceFloor', /between 0 and 100/);
    rejects(() => normalizeWebhookScope('news.breaking', { importanceFloor: 69.5 }), 'scope.importanceFloor', /integer/);
    rejects(() => normalizeWebhookScope('news.breaking', { severityFloor: 'medium' }), 'scope.severityFloor', /critical, high/);
    rejects(() => normalizeWebhookScope('news.breaking', { categories: ['sports'] }), 'scope.categories', /Unknown categories value: sports/);
    rejects(() => normalizeWebhookScope('news.breaking', { countries: ['ZZ'] }), 'scope.countries', /Unknown country code: ZZ/);
    rejects(() => normalizeWebhookScope('news.breaking', { countries: ['Iran'] }), 'scope.countries');
    rejects(() => normalizeWebhookScope('news.breaking', { keywords: ['a'] }), 'scope.keywords', /at least 2/);
    rejects(() => normalizeWebhookScope('news.breaking', { keywords: Array.from({ length: 21 }, (_, i) => `kw${i}`) }), 'scope.keywords', /at most 20/);
    rejects(() => normalizeWebhookScope('news.breaking', { keywords: 'iran' }), 'scope.keywords', /array of strings/);
    rejects(() => normalizeWebhookScope('news.breaking', { keywords: [1] }), 'scope.keywords', /array of strings/);
  });

  it('rejects a scope that is not an object', () => {
    rejects(() => normalizeWebhookScope('news.breaking', 'iran'), 'scope', /must be an object/);
    rejects(() => normalizeWebhookScope('news.breaking', ['iran']), 'scope');
  });

  it('accepts every country in shared/iso2-to-iso3.json, not only the risk-surge monitored set', () => {
    assert.deepEqual(normalizeWebhookScope('news.breaking', { countries: ['TO', 'ng'] }).countries, ['TO', 'NG']);
  });
});

describe('normalizeWebhookScope: market.move', () => {
  it('applies the defaults (minAbsPct 10, direction any, no class or symbol filter)', () => {
    assert.deepEqual(normalizeWebhookScope('market.move', undefined), {
      assetClasses: [], symbols: [], minAbsPct: 10, direction: 'any',
    });
  });

  it('upper-cases symbols, checks asset classes against the enum and bounds the percent floor', () => {
    assert.deepEqual(normalizeWebhookScope('market.move', { symbols: ['vix', ' btc '], assetClasses: ['crypto'], minAbsPct: '12.5', direction: 'down' }), {
      assetClasses: ['crypto'], symbols: ['VIX', 'BTC'], minAbsPct: 12.5, direction: 'down',
    });
    rejects(() => normalizeWebhookScope('market.move', { assetClasses: ['bond'] }), 'scope.assetClasses', /Unknown assetClasses value: bond/);
    rejects(() => normalizeWebhookScope('market.move', { minAbsPct: 4 }), 'scope.minAbsPct', /between 5 and 100/);
    rejects(() => normalizeWebhookScope('market.move', { minAbsPct: 'ten' }), 'scope.minAbsPct', /must be a number/);
    rejects(() => normalizeWebhookScope('market.move', { direction: 'sideways' }), 'scope.direction', /up, down, any/);
    rejects(() => normalizeWebhookScope('market.move', { keywords: ['oil'] }), 'scope.keywords', /does not apply to market\.move/);
  });
});

describe('normalizeWebhookScope: natural.hazard', () => {
  it('applies the defaults (magnitude 5.5, alert level Orange, every type and country)', () => {
    assert.ok(OCCURRENCE_EVENT_TYPES.has('natural.hazard'));
    assert.deepEqual(normalizeWebhookScope('natural.hazard', undefined), {
      hazardTypes: [], minMagnitude: 5.5, minAlertLevel: 'Orange', countries: [],
    });
  });

  it('keeps hazard types as sent, upper-cases countries, and bounds the magnitude', () => {
    assert.deepEqual(normalizeWebhookScope('natural.hazard', { hazardTypes: ['earthquakes', 'severeStorms', 'earthquakes'], countries: ['jp', 'TW'], minMagnitude: '6.5', minAlertLevel: 'Red' }), {
      hazardTypes: ['earthquakes', 'severeStorms'], countries: ['JP', 'TW'], minMagnitude: 6.5, minAlertLevel: 'Red',
    });
    rejects(() => normalizeWebhookScope('natural.hazard', { hazardTypes: ['tsunami'] }), 'scope.hazardTypes', /Unknown hazardTypes value: tsunami/);
    rejects(() => normalizeWebhookScope('natural.hazard', { minMagnitude: 4 }), 'scope.minMagnitude', /between 4.5 and 9.5/);
    rejects(() => normalizeWebhookScope('natural.hazard', { minMagnitude: 10 }), 'scope.minMagnitude');
    rejects(() => normalizeWebhookScope('natural.hazard', { minAlertLevel: 'Green' }), 'scope.minAlertLevel', /Orange, Red/);
    rejects(() => normalizeWebhookScope('natural.hazard', { countries: ['XX'] }), 'scope.countries', /Unknown country code/);
    rejects(() => normalizeWebhookScope('natural.hazard', { keywords: ['quake'] }), 'scope.keywords', /does not apply to natural\.hazard/);
  });
});

describe('published WebhookScope schema', () => {
  it('names exactly the scope keys the registry occurrence events define, so the spec documents no key every registration rejects', () => {
    const spec = JSON.parse(readFileSync(new URL('../docs/api/ShippingV2Service.openapi.json', import.meta.url), 'utf8'));
    const published = Object.keys(spec.components.schemas.WebhookScope.properties).sort();
    const registryKeys = [...new Set(Object.values(registry.events)
      .filter((event) => event.kind === 'occurrence')
      .flatMap((event) => Object.keys(event.inputSchema.properties)))].sort();
    assert.deepEqual(published, registryKeys);
  });
});

describe('published RegisterWebhook example', () => {
  it('carries no scope, since its chokepoint.disruption event rejects one', () => {
    const spec = JSON.parse(readFileSync(new URL('../docs/api/ShippingV2Service.openapi.json', import.meta.url), 'utf8'));
    const example = spec.paths['/api/v2/shipping/webhooks'].post.requestBody.content['application/json'].example;
    assert.equal(example.eventType, 'chokepoint.disruption');
    assert.equal('scope' in example, false);
    assert.doesNotThrow(() => normalizeWebhookScope(example.eventType, example.scope));
    assert.throws(() => normalizeWebhookScope('chokepoint.disruption', { keywords: ['oil'] }), ValidationError);
  });
});
