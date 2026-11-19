import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadUnifiedOpenApiSpec } from './_lib/openapi-spec-cache.mjs';

import {
  injectYamlWebhooks,
  WEBHOOK_EVENT,
  RISK_SURGE_WEBHOOK_EVENT,
  WEBHOOK_EVENTS,
  SIGNATURE_HEADER,
  SIGNATURE_V2_HEADER,
  TIMESTAMP_HEADER,
  EVENT_HEADER,
  DELIVERY_ID_HEADER,
} from '../scripts/openapi-inject-webhooks.mjs';
import { REASON_RULES, RISK_SURGE_RULE } from '../scripts/shipping-webhook-worker.mjs';

// Guards the outbound webhook-delivery contract injected into the OpenAPI bundle
// by scripts/openapi-inject-webhooks.mjs (orank Access — "webhook signing
// referenced but no branded signature header identified"). The published spec
// (public/openapi.json ← docs/api/worldmonitor.openapi.yaml) must name the
// branded X-WM-Signature header and describe how to verify it, and that
// documented contract must not drift from what the delivery worker actually
// sends (server/worldmonitor/shipping/v2/deliver-webhook.ts).

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const bundlePath = resolve(root, 'docs/api/worldmonitor.openapi.yaml');
const deliverPath = resolve(root, 'server/worldmonitor/shipping/v2/deliver-webhook.ts');

const bundleRaw = readFileSync(bundlePath, 'utf8');
const bundle = loadUnifiedOpenApiSpec();
const deliverSrc = readFileSync(deliverPath, 'utf8');

const webhook = bundle.webhooks?.[WEBHOOK_EVENT]?.post;
const registry = JSON.parse(readFileSync(resolve(root, 'shared/event-triggers.json'), 'utf8'));
const EVENT_BLOCKS = [[WEBHOOK_EVENT, webhook, 'ChokepointDisruptionWebhook', 'WebhookDeliveryPayload']];

function interfaceFields(name) {
  // Parse the source-of-truth interface: `name: type;` (required) or
  // `name?: type;` (optional).
  const block = deliverSrc.match(new RegExp(`interface ${name} \\{([\\s\\S]*?)\\n\\}`));
  assert.ok(block, `could not locate ${name} interface`);
  return [...block[1].matchAll(/^\s*(\w+)(\??):/gm)].map((m) => ({ name: m[1], optional: m[2] === '?' }));
}

describe('OpenAPI webhooks contract', () => {
  it('bundle documents the chokepoint.disruption outbound webhook', () => {
    assert.ok(bundle.webhooks, 'bundle must carry a top-level `webhooks` object');
    assert.ok(webhook, `bundle.webhooks['${WEBHOOK_EVENT}'].post must exist`);
    assert.equal(webhook.operationId, 'ChokepointDisruptionWebhook');
    // The delivery is outbound (the consumer receives it), so it carries no API
    // key — document it as unauthenticated to the consumer, authenticated by the
    // signature instead.
    assert.deepEqual(webhook.security, [], 'outbound webhook must document security: []');
  });

  it('names every other registry event in the X-WM-Event header description (one webhooks entry; the public JSON budget has no room for more)', () => {
    assert.deepEqual(Object.keys(registry.events).sort(), [...WEBHOOK_EVENTS].sort(), 'registry and injector must list the same events');
    const eventHeader = webhook.parameters.find((p) => p.name === EVENT_HEADER);
    // The enum must stay truthful to the documented body: this entry's schema
    // is the chokepoint payload, so only that event is enumerated here.
    assert.deepEqual(eventHeader.schema.enum, [WEBHOOK_EVENT]);
    const desc = eventHeader.description.replace(/\s+/g, ' ');
    for (const event of WEBHOOK_EVENTS.filter((name) => name !== WEBHOOK_EVENT)) {
      assert.ok(desc.includes(event), `the header description must name ${event}`);
    }
    assert.ok(desc.includes('api-shipping-v2#delivery-format'), 'and point at the documented payload');
  });

  it('documents the legacy and V2 delivery headers as required header params', () => {
    const headerParams = (webhook.parameters ?? []).filter((p) => p.in === 'header');
    const byName = new Map(headerParams.map((p) => [p.name, p]));
    for (const name of [SIGNATURE_HEADER, SIGNATURE_V2_HEADER, TIMESTAMP_HEADER, EVENT_HEADER, DELIVERY_ID_HEADER]) {
      const p = byName.get(name);
      assert.ok(p, `missing header parameter ${name}`);
      assert.equal(p.required, true, `${name} must be required`);
      assert.equal(p.schema?.type, 'string', `${name} schema must be a string`);
    }
    assert.equal(byName.get(EVENT_HEADER).schema.enum[0], WEBHOOK_EVENT, 'the default event leads the enum');
  });

  it('the signature header schema constrains the sha256=<hex> format', () => {
    for (const name of [SIGNATURE_HEADER, SIGNATURE_V2_HEADER]) {
      const sig = webhook.parameters.find((p) => p.name === name);
      assert.equal(sig.schema.pattern, '^sha256=[0-9a-f]{64}$');
    }
    assert.equal(webhook.parameters.find(p => p.name === TIMESTAMP_HEADER).schema.pattern, '^[0-9]+$');
  });

  it('the delivery id header schema constrains the whd_<32hex> format', () => {
    const deliveryId = webhook.parameters.find((p) => p.name === DELIVERY_ID_HEADER);
    assert.equal(deliveryId.schema.pattern, '^whd_[0-9a-f]{32}$');
  });

  it('documents a verification recipe (HMAC-SHA256, constant-time compare)', () => {
    // The YAML block folds lines, so compare on single-spaced prose.
    const desc = (webhook.description ?? '').replace(/\s+/g, ' ');
    for (const needle of ['HMAC-SHA256', 'constant time', 'secret', 'do not hex-decode', SIGNATURE_V2_HEADER, 'timestamp.deliveryId.event.rawRequestBody', '300 seconds', 'never fall back']) {
      assert.ok(desc.includes(needle), `webhook description must mention "${needle}"`);
    }
  });

  it('payload schema matches the WebhookDeliveryPayload interface exactly', () => {
    for (const [event, block, , interfaceName] of EVENT_BLOCKS) {
      const schema = block.requestBody.content['application/json'].schema;
      const fields = interfaceFields(interfaceName);
      assert.ok(fields.length >= 6, `${event}: expected the interface to parse at least 6 fields`);

      const documented = Object.keys(schema.properties).sort();
      const expected = fields.map((f) => f.name).sort();
      assert.deepEqual(documented, expected, `${event}: documented payload properties must match ${interfaceName}`);

      const requiredExpected = fields.filter((f) => !f.optional).map((f) => f.name).sort();
      assert.deepEqual([...schema.required].sort(), requiredExpected, `${event}: required set must match non-optional interface fields`);
    }
  });

  it('the registry payloadSchema matches each delivery payload interface (every event)', () => {
    const interfaces = [
      [WEBHOOK_EVENT, 'WebhookDeliveryPayload'],
      [RISK_SURGE_WEBHOOK_EVENT, 'RiskSurgeWebhookPayload'],
      ['news.breaking', 'NewsBreakingWebhookPayload'],
      ['market.move', 'MarketMoveWebhookPayload'],
      ['natural.hazard', 'NaturalHazardWebhookPayload'],
    ];
    assert.deepEqual(interfaces.map(([event]) => event).sort(), Object.keys(registry.events).sort(), 'every registry event pins a delivery interface');
    for (const [event, interfaceName] of interfaces) {
      const fromRegistry = registry.events[event].payloadSchema;
      const fields = interfaceFields(interfaceName);
      assert.deepEqual(Object.keys(fromRegistry.properties).sort(), fields.map((f) => f.name).sort(), `${event}: registry properties drifted from ${interfaceName}`);
      assert.deepEqual([...fromRegistry.required].sort(), fields.filter((f) => !f.optional).map((f) => f.name).sort(), `${event}: registry required set drifted from ${interfaceName}`);
    }
    const schema = webhook.requestBody.content['application/json'].schema;
    const fromRegistry = registry.events[WEBHOOK_EVENT].payloadSchema;
    assert.deepEqual(Object.keys(schema.properties).sort(), Object.keys(fromRegistry.properties).sort(), 'spec and registry chokepoint properties drifted');
  });

  it('the registry risk-surge thresholds are the ones the worker applies', () => {
    const rule = registry.events[RISK_SURGE_WEBHOOK_EVENT];
    assert.equal(rule.threshold.riseThreshold, RISK_SURGE_RULE.rise);
    assert.equal(rule.threshold.floor, RISK_SURGE_RULE.floor);
    assert.equal(rule.cooldown.rearmBelow, RISK_SURGE_RULE.rearmBelow);
    assert.equal(rule.cooldown.minimumSeconds * 1000, RISK_SURGE_RULE.cooldownMs);
    assert.equal(RISK_SURGE_RULE.cooldownMs, 24 * 3600 * 1000);
    const { sample } = rule;
    assert.ok(sample.delta24h >= RISK_SURGE_RULE.rise && sample.score >= RISK_SURGE_RULE.floor, 'the registry sample must itself satisfy the rule');
    assert.deepEqual(rule.payloadSchema.properties.reason.enum, ['risk_surge']);
  });

  it('documented headers match what the delivery worker actually sends', () => {
    // The worker sends header names lowercase; the spec uses canonical casing.
    const sent = [...deliverSrc.matchAll(/'(x-wm-[a-z0-9-]+)'\s*:/g)].map((m) => m[1].toLowerCase());
    const sentSet = new Set(sent);
    for (const name of [SIGNATURE_HEADER, SIGNATURE_V2_HEADER, TIMESTAMP_HEADER, EVENT_HEADER, DELIVERY_ID_HEADER]) {
      assert.ok(sentSet.has(name.toLowerCase()), `worker must send the ${name} header it documents`);
    }
  });

  it('the signing algorithm the worker uses backs the documented contract', () => {
    assert.ok(/createHmac\(\s*'sha256'/.test(deliverSrc), 'worker must sign with HMAC-SHA256');
    assert.ok(/`sha256=\$\{signature\}`/.test(deliverSrc), 'worker must prefix the signature with sha256=');
    assert.ok(/\.digest\('hex'\)/.test(deliverSrc), 'worker must hex-encode the signature');
  });

  it('the worker defaults the event header to the documented event name', () => {
    assert.ok(
      deliverSrc.includes(`?? '${WEBHOOK_EVENT}'`),
      `worker must default the event header to '${WEBHOOK_EVENT}'`,
    );
  });

  it('documents the reason enum the delivery worker emits', () => {
    const { schema, example } = webhook.requestBody.content['application/json'];
    assert.deepEqual(schema.properties.reason.enum, REASON_RULES.map((rule) => rule.reason));
    assert.ok(schema.properties.reason.enum.includes(example.reason), 'example reason must be an enum value');
  });

  it('the committed bundle is up to date with the injector (idempotent)', () => {
    const result = injectYamlWebhooks(bundleRaw);
    assert.equal(result.changed, false, 'run `npm run gen:openapi:webhooks` — committed bundle is stale');
  });

  it('documents a body-agnostic any-2xx acknowledgement', () => {
    assert.equal(webhook.responses?.['200'], undefined, 'webhook must not invent an exact 200 response');
    const acknowledgement = webhook.responses?.['2XX'];
    assert.ok(acknowledgement, 'webhook must document the any-2xx acknowledgement');
    assert.equal(
      acknowledgement.content,
      undefined,
      'acknowledgement must not require a response body or media type',
    );
    assert.match(acknowledgement.description ?? '', /any 2xx/i);
  });

  it('webhooks live at the top level, not under paths (no phantom REST op)', () => {
    for (const event of WEBHOOK_EVENTS) {
      assert.ok(!(`/webhooks/${event}` in (bundle.paths ?? {})));
    }
    assert.equal(Object.keys(bundle.webhooks).length, 1);
  });
});

// The published, verifiable sample delivery (public/.well-known/webhook-sample.json)
// lets an agent confirm its HMAC verification end-to-end BEFORE registering a live
// webhook (orank Usability — "webhook signature verification"). This guards it
// against drift: the committed signature MUST be the genuine HMAC of the committed
// body+secret, and the scheme must match the documented + worker contract.
describe('webhook verification fixture (/.well-known/webhook-sample.json)', () => {
  const fixture = JSON.parse(
    readFileSync(resolve(root, 'public/.well-known/webhook-sample.json'), 'utf8'),
  );
  const guide = readFileSync(resolve(root, 'docs/api-shipping-v2.mdx'), 'utf8');
  const example = guide.split('### Verifying deliveries')[1].match(/```js\n([\s\S]*?)\n```/)[1];
  const verify = new Function('createHmac', 'timingSafeEqual', 'Buffer',
    example.replace(/import .* from 'node:crypto';/, '') + '\nreturn verifyWorldMonitorWebhook;')(createHmac, timingSafeEqual, Buffer);
  const headers = Object.fromEntries(Object.entries(fixture.headers).map(([name, value]) => [name.toLowerCase(), value]));
  const sampleMs = Number(headers['x-wm-timestamp']) * 1000;

  function signV2(body, values) {
    return 'sha256=' + createHmac('sha256', fixture.secret)
      .update(`${values['x-wm-timestamp']}.${values['x-wm-delivery-id']}.${values['x-wm-event']}.`)
      .update(body).digest('hex');
  }

  it('the documented V2 verifier accepts the fixture at both tolerance boundaries', () => {
    assert.equal(fixture.signatureV2Header, SIGNATURE_V2_HEADER);
    assert.equal(fixture.timestampHeader, TIMESTAMP_HEADER);
    assert.equal(fixture.signatureV2, signV2(fixture.body, headers));
    assert.equal(headers['x-wm-signature-v2'], fixture.signatureV2);
    for (const drift of [-300_000, 0, 300_000]) {
      assert.equal(verify(Buffer.from(fixture.body), headers, fixture.secret, sampleMs + drift), true);
    }
  });

  it('rejects valid signatures outside the 300-second past and future window', () => {
    for (const drift of [-301_000, 301_000]) {
      assert.equal(verify(Buffer.from(fixture.body), headers, fixture.secret, sampleMs + drift), false);
    }
  });

  it('rejects body, timestamp, delivery-id and event substitutions', () => {
    assert.equal(verify(Buffer.from(fixture.body + ' '), headers, fixture.secret, sampleMs), false);
    for (const [name, value] of [
      ['x-wm-timestamp', String(sampleMs / 1000 + 1)],
      ['x-wm-delivery-id', 'whd_' + 'a'.repeat(32)],
      ['x-wm-event', 'country.risk_surge'],
      ['x-wm-signature-v2', 'sha256=' + '0'.repeat(64)],
    ]) {
      assert.equal(verify(fixture.body, { ...headers, [name]: value }, fixture.secret, sampleMs), false, name);
    }
  });

  it('rejects missing or malformed V2 headers without a legacy fallback', () => {
    for (const name of ['x-wm-timestamp', 'x-wm-delivery-id', 'x-wm-event', 'x-wm-signature-v2']) {
      for (const value of [undefined, '', ['duplicate', 'headers'], `${headers[name]}, ${headers[name]}`]) {
        assert.equal(verify(fixture.body, { ...headers, [name]: value }, fixture.secret, sampleMs), false, name);
      }
    }
    for (const timestamp of ['NaN', 'Infinity', '1e9', '1783168496.5', '9007199254740992']) {
      assert.equal(verify(fixture.body, { ...headers, 'x-wm-timestamp': timestamp }, fixture.secret, sampleMs), false);
    }
  });

  it('authenticates event names independently of the receiver event router', () => {
    const values = { ...headers, 'x-wm-event': 'vessel.alert' };
    values['x-wm-signature-v2'] = signV2(fixture.body, values);
    assert.equal(verify(fixture.body, values, fixture.secret, sampleMs), true);
  });

  it('rejects ambiguous delivery-id/event boundaries even with a matching HMAC', () => {
    const values = { ...headers, 'x-wm-delivery-id': headers['x-wm-delivery-id'] + '.chokepoint', 'x-wm-event': 'disruption' };
    assert.equal(signV2(fixture.body, values), headers['x-wm-signature-v2']);
    assert.equal(verify(fixture.body, values, fixture.secret, sampleMs), false);
  });

  it('the committed signature is the genuine HMAC-SHA256 of body keyed by secret', () => {
    const expected = 'sha256=' + createHmac('sha256', fixture.secret).update(fixture.body).digest('hex');
    assert.equal(fixture.signature, expected, 'fixture signature is stale — recompute it from body+secret');
  });

  it('the sample matches the documented signing scheme', () => {
    assert.equal(fixture.algorithm, 'HMAC-SHA256');
    assert.equal(fixture.signatureHeader, SIGNATURE_HEADER);
    assert.equal(fixture.event, WEBHOOK_EVENT);
    // Same shape the OpenAPI signature-header schema constrains (^sha256=[0-9a-f]{64}$).
    assert.match(fixture.signature, /^sha256=[0-9a-f]{64}$/);
    // Sample secret uses the real registration format (raw 64-char lowercase hex).
    assert.match(fixture.secret, /^[0-9a-f]{64}$/);
  });

  it('the signature does NOT match if the body is tampered (guards the recipe)', () => {
    const tampered = fixture.body.replace('"score":72', '"score":99');
    const forged = 'sha256=' + createHmac('sha256', fixture.secret).update(tampered).digest('hex');
    assert.notEqual(fixture.signature, forged, 'a mutated body must not verify against the sample signature');
  });

  it('the sample body carries a reason the worker emits', () => {
    const { reason } = JSON.parse(fixture.body);
    assert.ok(REASON_RULES.some((rule) => rule.reason === reason), `sample reason '${reason}' is not one the worker sends`);
  });

  it('the echoed X-WM-Signature header equals the top-level signature', () => {
    assert.equal(fixture.headers?.['X-WM-Signature'], fixture.signature);
  });
});
