import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

// shared/event-triggers.json is the one definition of every push event: the
// registration handler validates against it, the delivery worker reads the
// scripts/shared mirror, the Zapier app reads its own mirror and the OpenAPI
// webhooks block names its events. This suite pins the shape every consumer
// relies on, so a new event cannot land half-described.

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const canonicalRaw = readFileSync(resolve(root, 'shared/event-triggers.json'), 'utf8');
const registry = JSON.parse(canonicalRaw);
const { marketEventId, rssEventId } = require('../scripts/lib/occurrence-events.cjs');
const { diffHazards, normalizeTeeMessage, parseHazardSeen, planTick } = await import('../scripts/shipping-webhook-worker.mjs');

const events = Object.entries(registry.events);
const occurrenceEvents = events.filter(([, event]) => event.kind === 'occurrence');
const thresholdEvents = events.filter(([, event]) => event.kind === 'threshold');

function propertyNames(schema) {
  return Object.keys(schema?.properties ?? {});
}

describe('event registry shape', () => {
  it('mirrors byte-for-byte where the worker and the Zapier app read it', () => {
    for (const mirror of ['scripts/shared/event-triggers.json', 'integrations/zapier/event-triggers.json']) {
      assert.equal(readFileSync(resolve(root, mirror), 'utf8'), canonicalRaw, `run: cp shared/event-triggers.json ${mirror}`);
    }
  });

  it('every event declares a kind the subscription block defines, and its key matches its map entry', () => {
    const kinds = Object.keys(registry.subscription.kinds);
    assert.deepEqual(kinds.sort(), ['occurrence', 'threshold']);
    for (const [key, event] of events) {
      assert.equal(event.key, key);
      assert.ok(kinds.includes(event.kind), `${key}: kind ${event.kind}`);
      for (const field of ['label', 'noun', 'description', 'source', 'inputSchema', 'id', 'payloadSchema', 'sample']) {
        assert.ok(event[field], `${key} lacks ${field}`);
      }
      assert.match(event.description, /^Triggers when .*\.$/, `${key}: Zapier needs "Triggers when ...."`);
      assert.equal(event.id.field, 'deliveryId');
      assert.equal(event.id.header, registry.subscription.signature.deliveryIdHeader);
    }
    assert.ok(thresholdEvents.length >= 2 && occurrenceEvents.length >= 2);
  });

  it('samples carry every required payload field, only documented fields, and no extras', () => {
    for (const [key, event] of events) {
      const { payloadSchema, sample } = event;
      for (const field of payloadSchema.required) {
        assert.ok(field in sample, `${key} sample lacks required ${field}`);
      }
      const documented = new Set(propertyNames(payloadSchema));
      for (const field of Object.keys(sample)) {
        assert.ok(documented.has(field), `${key} sample has undocumented ${field}`);
      }
      assert.equal(sample.subscriberId.startsWith('wh_'), true);
      assert.match(sample.triggeredAt, /^\d{4}-\d{2}-\d{2}T/);
      assert.ok(payloadSchema.properties.reason.enum.includes(sample.reason), `${key}: sample reason must be an enum value`);
    }
  });

  it('input schema defaults sit inside their own bounds and enums', () => {
    for (const [key, event] of events) {
      for (const [name, schema] of Object.entries(event.inputSchema.properties)) {
        if (!('default' in schema)) continue;
        const value = schema.default;
        if (schema.type === 'array') {
          assert.deepEqual(value, [], `${key}.${name}: array scopes default to empty (no filter)`);
        } else if (schema.type === 'integer' || schema.type === 'number') {
          assert.ok(value >= schema.minimum && value <= schema.maximum, `${key}.${name}: default ${value} outside [${schema.minimum}, ${schema.maximum}]`);
          if (schema.type === 'integer') assert.ok(Number.isInteger(value));
        } else if (schema.enum) {
          assert.ok(schema.enum.includes(value), `${key}.${name}: default ${value} not in enum`);
        }
      }
    }
  });
});

describe('occurrence events', () => {
  it('declare the volume cap, pending retry, dedupe window and event id rule the worker applies', () => {
    for (const [key, event] of occurrenceEvents) {
      assert.ok(event.volume.maxDeliveriesPerHour > 0 && event.volume.maxDeliveriesPerDay >= event.volume.maxDeliveriesPerHour, key);
      assert.ok(event.retry.pendingTtlSeconds >= registry.subscription.evaluationSeconds * 2, `${key}: a pending delivery must survive at least two ticks`);
      assert.ok(event.dedupe.seenWindowSeconds >= 3600, key);
      assert.equal(event.id.eventIdField, 'eventId');
      assert.ok(event.id.eventIdConstruction.length > 40, `${key}: document how eventId is built`);
      assert.ok(event.payloadSchema.required.includes('eventId'), `${key}: eventId is part of the delivery`);
      assert.ok(event.source.channel || event.source.redisKeys, `${key}: an occurrence source is a fan-out channel or a set of Redis keys`);
    }
  });

  it('threshold events keep their feed source and have no occurrence-only blocks', () => {
    for (const [key, event] of thresholdEvents) {
      assert.ok(event.source.redisKey, key);
      assert.ok(event.threshold && event.cooldown, key);
      assert.equal(event.volume, undefined, `${key}: caps apply to occurrence events only`);
    }
  });

  it('news.breaking: the sample eventId is the link hash the relay and the worker compute', () => {
    const event = registry.events['news.breaking'];
    const { sample } = event;
    assert.equal(sample.eventId, rssEventId(sample.link, sample.title));
    assert.deepEqual(event.inputSchema.properties.categories.items.enum, event.categories);
    assert.ok(event.categories.includes(sample.category));
    assert.equal(event.inputSchema.properties.importanceFloor.default, 69);
    assert.equal(event.inputSchema.properties.severityFloor.default, 'high');
    assert.ok(sample.importanceScore >= event.inputSchema.properties.importanceFloor.default, 'the sample itself clears the default floor');
    assert.deepEqual(propertyNames(event.inputSchema).sort(), ['categories', 'countries', 'importanceFloor', 'keywords', 'severityFloor']);
  });

  it('the worker builds exactly the sample\'s field set for each occurrence event', () => {
    const now = Date.parse('2026-10-17T18:45:16.000Z');
    const record = (eventType) => ({
      subscriberId: 'wh_041fef6d0657b56b75fb62cb', ownerTag: 'o', callbackUrl: 'https://hooks.example.com/wm',
      chokepointIds: [], alertThreshold: 50, createdAt: '2026-10-01T00:00:00.000Z', active: true, secret: 'a'.repeat(64), eventType,
    });
    const news = registry.events['news.breaking'].sample;
    const market = registry.events['market.move'].sample;
    const occurrences = [
      normalizeTeeMessage(JSON.stringify({
        eventType: 'rss_alert', severity: news.severity, variant: news.variant, publishedAt: now - 60_000,
        payload: { title: news.title, source: news.source, link: news.link, publishedAt: Date.parse(news.publishedAt), importanceScore: news.importanceScore, corroborationCount: news.corroborationCount, category: news.category, countryCodes: news.countryCodes },
      }), now),
      normalizeTeeMessage(JSON.stringify({
        eventType: 'market_alert', severity: market.severity, publishedAt: Date.parse(market.publishedAt),
        payload: { title: 'VIX: +21% surge', source: market.source, coalesceKey: 'market:equity:vix:surge:critical', assetClass: market.assetClass, symbol: market.symbol, name: market.name, price: market.price, changePct: market.changePct, direction: market.direction },
      }), now),
    ];
    assert.ok(occurrences.every(Boolean));
    const { deliveries } = planTick({
      chokepoints: null, riskScores: null, occurrences,
      records: [record('news.breaking'), record('market.move')],
      states: new Map(), now, scoresFetchedAt: null, makeId: () => 'whd_fixed',
    });
    assert.equal(deliveries.length, 2);
    for (const delivery of deliveries) {
      const { sample } = registry.events[delivery.event];
      assert.deepEqual(Object.keys(delivery.payload).sort(), Object.keys(sample).sort(), `${delivery.event}: worker payload keys drifted from the registry sample`);
      assert.equal(delivery.payload.eventId, sample.eventId, `${delivery.event}: the worker derives the sample's eventId from the same message`);
      assert.equal(delivery.payload.reason, sample.reason);
    }
  });

  it('market.move: the sample eventId is the per-UTC-day coalesce-key hash', () => {
    const event = registry.events['market.move'];
    const { sample } = event;
    const coalesceKey = `market:${sample.assetClass}:${sample.symbol.toLowerCase()}:${sample.direction === 'up' ? 'surge' : 'decline'}:${sample.severity}`;
    assert.equal(sample.eventId, marketEventId(coalesceKey, Date.parse(sample.publishedAt)));
    assert.deepEqual(event.inputSchema.properties.assetClasses.items.enum, event.assetClasses);
    assert.equal(event.inputSchema.properties.minAbsPct.default, 10);
    assert.equal(event.inputSchema.properties.minAbsPct.minimum, 5, 'the relay floors equity and commodity moves at 5 percent');
    assert.equal(event.inputSchema.properties.direction.default, 'any');
    assert.ok(Math.abs(sample.changePct) >= event.inputSchema.properties.minAbsPct.default, 'the sample itself clears the default floor');
    assert.deepEqual(propertyNames(event.inputSchema).sort(), ['assetClasses', 'direction', 'minAbsPct', 'symbols']);
  });

  it('natural.hazard: scope keys, defaults and the sample eventId the worker derives from the earthquake feed', () => {
    const event = registry.events['natural.hazard'];
    const { sample } = event;
    assert.deepEqual(propertyNames(event.inputSchema).sort(), ['countries', 'hazardTypes', 'minAlertLevel', 'minMagnitude']);
    assert.equal(event.inputSchema.properties.minMagnitude.default, 5.5);
    assert.equal(event.inputSchema.properties.minAlertLevel.default, 'Orange');
    assert.deepEqual(event.inputSchema.properties.minAlertLevel.enum, ['Orange', 'Red']);
    assert.ok(event.inputSchema.properties.hazardTypes.items.enum.includes(sample.hazardType));
    assert.deepEqual([event.volume.maxDeliveriesPerHour, event.volume.maxDeliveriesPerDay], [30, 150]);
    assert.ok(event.dedupe.seenWindowSeconds > event.dedupe.newWithinSeconds.other, 'an id must stay seen longer than it can count as new');
    assert.deepEqual(event.source.redisKeys, ['seismology:earthquakes:v1', 'natural:events:v1']);
    assert.ok(sample.magnitude >= event.inputSchema.properties.minMagnitude.default, 'the sample itself clears the default floor');

    const now = Date.parse(sample.triggeredAt);
    const quake = {
      id: sample.eventId.slice('eq:'.length), place: '76 km NE of Ozernovskiy, Russia', magnitude: sample.magnitude, depthKm: sample.depthKm,
      location: { latitude: sample.lat, longitude: sample.lon }, occurredAt: Date.parse(sample.occurredAt), sourceUrl: sample.sourceUrl, source: 'usgs',
    };
    const seen = parseHazardSeen(['eq:us0000seed', 'nat:EONET_1']);
    const { occurrences } = diffHazards({ earthquakes: [quake], naturalEvents: [] }, seen, now);
    assert.equal(occurrences.length, 1);
    const record = {
      subscriberId: 'wh_041fef6d0657b56b75fb62cb', ownerTag: 'o', callbackUrl: 'https://hooks.example.com/wm', chokepointIds: [], alertThreshold: 50,
      createdAt: '2026-10-01T00:00:00.000Z', active: true, secret: 'a'.repeat(64), eventType: 'natural.hazard',
      scope: { hazardTypes: [], minMagnitude: 5.5, minAlertLevel: 'Orange', countries: [] },
    };
    const { deliveries } = planTick({ chokepoints: null, hazards: occurrences, records: [record], states: new Map(), now, scoresFetchedAt: null, makeId: () => 'whd_fixed' });
    assert.equal(deliveries.length, 1);
    assert.deepEqual(Object.keys(deliveries[0].payload).sort(), Object.keys(sample).sort(), 'worker payload keys drifted from the registry sample');
    assert.deepEqual(deliveries[0].payload, sample, 'the worker builds the sample from its earthquake row');
  });
});
