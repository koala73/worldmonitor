'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const App = require('../index');
const { EVENT_REGISTRY } = require('../constants');

const CANONICAL = path.resolve(__dirname, '..', '..', '..', 'shared', 'event-triggers.json');

describe('event registry', () => {
  it('is a byte-for-byte copy of shared/event-triggers.json', () => {
    // Zapier bundles only integrations/zapier, so the registry is mirrored
    // here. The canonical file is the one the server and the worker read.
    const canonical = fs.readFileSync(CANONICAL, 'utf8');
    const mirror = fs.readFileSync(path.resolve(__dirname, '..', 'event-triggers.json'), 'utf8');
    assert.equal(mirror, canonical, 'run: cp shared/event-triggers.json integrations/zapier/event-triggers.json');
  });

  it('backs one REST-hook trigger per registry event, with the registry copy', () => {
    const hooks = Object.values(App.triggers).filter((t) => t.operation.type === 'hook');
    assert.deepEqual(
      hooks.map((t) => t.operation.sample.eventType).sort(),
      Object.keys(EVENT_REGISTRY.events).sort(),
    );
    for (const trigger of hooks) {
      const event = EVENT_REGISTRY.events[trigger.operation.sample.eventType];
      assert.equal(trigger.noun, event.noun);
      assert.ok(trigger.display.description.startsWith('Triggers when'), 'Zapier D021: description starts with "Triggers when"');
      assert.ok(trigger.display.description.endsWith('.'));
      assert.equal(typeof trigger.operation.performSubscribe, 'function');
      assert.equal(typeof trigger.operation.performUnsubscribe, 'function');
      assert.equal(typeof trigger.operation.performList, 'function');
    }
  });

  it('samples carry every required payload field plus the delivery id as the row id', () => {
    for (const trigger of Object.values(App.triggers).filter((t) => t.operation.type === 'hook')) {
      const { sample } = trigger.operation;
      const schema = EVENT_REGISTRY.events[sample.eventType].payloadSchema;
      for (const field of schema.required) {
        assert.ok(field in sample, `${trigger.key} sample lacks ${field}`);
      }
      assert.match(sample.id, /^whd_[0-9a-f]{32}$/);
      assert.equal(sample.id, sample.deliveryId);
    }
  });

  it('occurrence triggers expose exactly the registry scope fields as inputs (snake_case to camelCase)', () => {
    const toCamel = (key) => key.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
    for (const trigger of Object.values(App.triggers).filter((t) => t.operation.type === 'hook')) {
      const event = EVENT_REGISTRY.events[trigger.operation.sample.eventType];
      if (event.kind !== 'occurrence') continue;
      const inputs = trigger.operation.inputFields.map((field) => toCamel(field.key)).sort();
      assert.deepEqual(inputs, Object.keys(event.inputSchema.properties).sort(), `${trigger.key} inputs drifted from the registry inputSchema`);
      for (const field of trigger.operation.inputFields) {
        const schema = event.inputSchema.properties[toCamel(field.key)];
        if (schema.type === 'array') assert.equal(field.list, true, `${trigger.key}.${field.key} is a list`);
        if (schema.enum) assert.deepEqual(Object.keys(field.choices), schema.enum, `${trigger.key}.${field.key} choices`);
        if (schema.items && schema.items.enum) assert.deepEqual(Object.keys(field.choices), schema.items.enum, `${trigger.key}.${field.key} choices`);
        if ('default' in schema && !Array.isArray(schema.default)) assert.equal(field.default, String(schema.default), `${trigger.key}.${field.key} default`);
      }
      // subscriberId is the Zap's own subscription, not a field users map.
      const userFacing = event.payloadSchema.required.filter((key) => key !== 'subscriberId');
      assert.ok(userFacing.every((key) => trigger.operation.outputFields.some((f) => f.key === key)), `${trigger.key} outputFields name every required payload field`);
    }
  });

  it('the monitored-country dropdown lists exactly the registry countries, with unique ids', async () => {
    const rows = await App.triggers.country_list.operation.perform();
    const ids = rows.map((r) => r.id);
    assert.deepEqual(new Set(ids).size, ids.length);
    assert.deepEqual(ids.sort(), Object.keys(EVENT_REGISTRY.events['country.risk_surge'].countries).sort());
    assert.equal(App.triggers.country_risk_surge.operation.inputFields[0].dynamic, 'country_list.id.name');
  });
});
