import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load as loadYaml } from 'js-yaml';

import {
  injectYamlWebhooks,
  WEBHOOK_EVENT,
  SIGNATURE_HEADER,
  EVENT_HEADER,
  DELIVERY_ID_HEADER,
} from '../scripts/openapi-inject-webhooks.mjs';

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
const bundle = loadYaml(bundleRaw);
const deliverSrc = readFileSync(deliverPath, 'utf8');

const webhook = bundle.webhooks?.[WEBHOOK_EVENT]?.post;

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

  it('documents the three branded delivery headers as required header params', () => {
    const headerParams = (webhook.parameters ?? []).filter((p) => p.in === 'header');
    const byName = new Map(headerParams.map((p) => [p.name, p]));
    for (const name of [SIGNATURE_HEADER, EVENT_HEADER, DELIVERY_ID_HEADER]) {
      const p = byName.get(name);
      assert.ok(p, `missing header parameter ${name}`);
      assert.equal(p.required, true, `${name} must be required`);
      assert.equal(p.schema?.type, 'string', `${name} schema must be a string`);
    }
  });

  it('the signature header schema constrains the sha256=<hex> format', () => {
    const sig = webhook.parameters.find((p) => p.name === SIGNATURE_HEADER);
    assert.equal(sig.schema.pattern, '^sha256=[0-9a-f]{64}$');
  });

  it('the delivery id header schema constrains the whd_<32hex> format', () => {
    const deliveryId = webhook.parameters.find((p) => p.name === DELIVERY_ID_HEADER);
    assert.equal(deliveryId.schema.pattern, '^whd_[0-9a-f]{32}$');
  });

  it('documents a verification recipe (HMAC-SHA256, constant-time compare)', () => {
    const desc = webhook.description ?? '';
    for (const needle of ['HMAC-SHA256', 'constant time', 'secret', 'do not hex-decode']) {
      assert.ok(desc.includes(needle), `webhook description must mention "${needle}"`);
    }
  });

  it('payload schema matches the WebhookDeliveryPayload interface exactly', () => {
    const schema = webhook.requestBody.content['application/json'].schema;

    // Parse the source-of-truth interface: `name: type;` (required) or
    // `name?: type;` (optional).
    const block = deliverSrc.match(/interface WebhookDeliveryPayload \{([\s\S]*?)\n\}/);
    assert.ok(block, 'could not locate WebhookDeliveryPayload interface');
    const fields = [...block[1].matchAll(/^\s*(\w+)(\??):/gm)].map((m) => ({
      name: m[1],
      optional: m[2] === '?',
    }));
    assert.ok(fields.length >= 6, 'expected the interface to parse at least 6 fields');

    const documented = Object.keys(schema.properties).sort();
    const expected = fields.map((f) => f.name).sort();
    assert.deepEqual(documented, expected, 'documented payload properties must match the interface');

    const requiredExpected = fields.filter((f) => !f.optional).map((f) => f.name).sort();
    assert.deepEqual([...schema.required].sort(), requiredExpected, 'required set must match non-optional interface fields');
  });

  it('documented headers match what the delivery worker actually sends', () => {
    // The worker sends header names lowercase; the spec uses canonical casing.
    const sent = [...deliverSrc.matchAll(/'(x-wm-[a-z-]+)'\s*:/g)].map((m) => m[1].toLowerCase());
    const sentSet = new Set(sent);
    for (const name of [SIGNATURE_HEADER, EVENT_HEADER, DELIVERY_ID_HEADER]) {
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

  it('the committed bundle is up to date with the injector (idempotent)', () => {
    const result = injectYamlWebhooks(bundleRaw);
    assert.equal(result.changed, false, 'run `npm run gen:openapi:webhooks` — committed bundle is stale');
  });

  it('webhooks live at the top level, not under paths (no phantom REST op)', () => {
    assert.ok(!('/webhooks/chokepoint.disruption' in (bundle.paths ?? {})));
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

  it('the echoed X-WM-Signature header equals the top-level signature', () => {
    assert.equal(fixture.headers?.['X-WM-Signature'], fixture.signature);
  });
});
