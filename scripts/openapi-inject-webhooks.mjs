#!/usr/bin/env node
/**
 * Inject the outbound webhook-delivery contract into the OpenAPI bundle.
 *
 * The ShippingV2Service lets partners register a `callbackUrl` (RegisterWebhook)
 * that WorldMonitor POSTs a signed chokepoint-disruption alert to. The delivery
 * worker (server/worldmonitor/shipping/v2/deliver-webhook.ts) signs every POST
 * with an HMAC-SHA256 over the raw body, keyed by the subscription `secret`, and
 * sends it in a branded `X-WM-Signature` header (plus `X-WM-Event` /
 * `X-WM-Delivery-Id`). The sebuf `protoc-gen-openapiv3` plugin only emits the
 * *inbound* request/response shapes it can see in the proto; it has no way to
 * describe an *outbound* callback, so the published spec references the HMAC
 * secret (RegisterWebhookResponse.secret) without ever naming the signature
 * header an agent needs to verify a delivery. Agent-readiness scanners
 * (ora.ai / orank) flag this: "Webhook signing referenced ... but no branded
 * signature header identified".
 *
 * OpenAPI 3.1 models exactly this with a top-level `webhooks` object (a map of
 * named Path Item Objects describing requests the API *initiates*). This step
 * injects one `chokepoint.disruption` webhook documenting the three branded
 * headers, the payload schema, and — crucially — the verification recipe, so a
 * consuming agent can confirm a delivery genuinely came from WorldMonitor.
 *
 * Only the bundle (docs/api/worldmonitor.openapi.yaml) is touched: it is copied
 * to public/openapi.yaml and deserialized to public/openapi.json (the artifact
 * orank fetches) at build time. The per-service ShippingV2Service spec is left
 * alone — top-level `webhooks` is a bundle-level, cross-cutting concern and the
 * Mintlify per-service renderer does not surface it.
 *
 * Like the sibling injectors this runs in the `make generate` codegen context
 * (no npm deps guaranteed), so it has no external imports: the block is a static
 * constant and the YAML write is a formatting-preserving surgical insertion.
 * Wired into `make generate` (after the other OpenAPI injectors) and exposed as
 * `npm run gen:openapi:webhooks`. Idempotent and order-independent: re-running,
 * or a fresh regenerate followed by this step, yields byte-identical output.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const bundlePath = resolve(root, 'docs/api/worldmonitor.openapi.yaml');

const CHECK = process.argv.includes('--check');

// The webhook event name — matches the default `options.event` in
// deliver-webhook.ts (the `X-WM-Event` header value).
export const WEBHOOK_EVENT = 'chokepoint.disruption';

// The branded delivery headers, verbatim from deliver-webhook.ts. Header names
// are case-insensitive on the wire (the worker sends them lowercase); the spec
// uses canonical casing. Kept here as the single source the contract test reads.
export const SIGNATURE_HEADER = 'X-WM-Signature';
export const EVENT_HEADER = 'X-WM-Event';
export const DELIVERY_ID_HEADER = 'X-WM-Delivery-Id';

// The 4-space-indented top-level `webhooks:` block. Authored by hand to match
// the generator's bundle formatting (4-space steps; list items `- ` at +2) so
// the injected diff reads cleanly alongside the generated paths.
const WEBHOOKS_BLOCK = `webhooks:
    ${WEBHOOK_EVENT}:
        post:
            tags:
                - ShippingV2Service
            summary: Chokepoint disruption alert (outbound, signed)
            description: |-
                WorldMonitor POSTs this event to the \`callbackUrl\` you register via
                RegisterWebhook whenever a subscribed chokepoint's disruption score
                crosses your \`alertThreshold\`. Every delivery is signed so you can
                confirm it genuinely came from WorldMonitor.

                Verification: the \`${SIGNATURE_HEADER}\` header is
                \`sha256=<hex>\`, where \`<hex>\` is the lowercase hex HMAC-SHA256 of the
                exact raw request body, keyed by the \`secret\` returned when you
                registered the webhook. To verify, recompute
                \`sha256=\` + hex(HMAC_SHA256(key=secret, message=rawRequestBody)) over
                the bytes exactly as received (do not re-serialize the JSON) and
                compare against \`${SIGNATURE_HEADER}\` in constant time. Use the
                \`secret\` string verbatim as the HMAC key — do not hex-decode it.
                Reject the delivery if the signatures differ.

                Respond with any 2xx to acknowledge receipt; a non-2xx response or a
                timeout marks the delivery failed. \`${DELIVERY_ID_HEADER}\` uniquely
                identifies each delivery for idempotent processing.
            operationId: ChokepointDisruptionWebhook
            security: []
            parameters:
                - name: ${SIGNATURE_HEADER}
                  in: header
                  required: true
                  description: |-
                      HMAC-SHA256 signature of the raw request body, keyed by the
                      subscription \`secret\`, formatted as \`sha256=<lowercase-hex>\`.
                  schema:
                      type: string
                      pattern: ^sha256=[0-9a-f]{64}$
                      example: sha256=2b8c0d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c
                - name: ${EVENT_HEADER}
                  in: header
                  required: true
                  description: Event type. Currently always \`${WEBHOOK_EVENT}\`.
                  schema:
                      type: string
                      example: ${WEBHOOK_EVENT}
                - name: ${DELIVERY_ID_HEADER}
                  in: header
                  required: true
                  description: |-
                      Unique delivery identifier (\`whd_\` + 32 hex chars). Use it to
                      dedupe retries and process deliveries idempotently.
                  schema:
                      type: string
                      pattern: ^whd_[0-9a-f]{32}$
                      example: whd_1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d
            requestBody:
                required: true
                content:
                    application/json:
                        schema:
                            type: object
                            required:
                                - subscriberId
                                - chokepointId
                                - score
                                - alertThreshold
                                - triggeredAt
                                - reason
                            properties:
                                subscriberId:
                                    type: string
                                    description: The \`wh_\`-prefixed subscription receiving this alert.
                                chokepointId:
                                    type: string
                                    description: Chokepoint that breached the threshold (e.g. \`suez\`).
                                score:
                                    type: number
                                    description: Current disruption score of the chokepoint, 0-100.
                                alertThreshold:
                                    type: number
                                    description: The subscription's configured alert threshold, 0-100.
                                triggeredAt:
                                    type: string
                                    format: date-time
                                    description: ISO-8601 timestamp when the alert fired.
                                reason:
                                    type: string
                                    description: Human-readable explanation for the alert.
                                details:
                                    type: object
                                    additionalProperties: true
                                    description: Optional structured context for the disruption.
                        example:
                            "subscriberId": "wh_1a2b3c4d5e6f7a8b9c0d1e2f"
                            "chokepointId": "suez"
                            "score": 72
                            "alertThreshold": 50
                            "triggeredAt": "2026-07-04T12:34:56Z"
                            "reason": "Disruption score 72 crossed alert threshold 50"
                            "details":
                                "trend": "rising"
            responses:
                "2XX":
                    description: |-
                        Any 2xx acknowledges receipt. A non-2xx response or a delivery
                        timeout marks the delivery failed.`;

// A top-level key is at column 0; its block extends until the next column-0
// line. Mirrors findTopLevelBlock in openapi-inject-security.mjs /
// openapi-inject-servers.mjs.
function findTopLevelBlock(lines, key) {
  const start = lines.indexOf(key + ':');
  if (start === -1) return null;
  let end = start + 1;
  while (end < lines.length) {
    const line = lines[end];
    if (line && !line.startsWith(' ') && !line.startsWith('\t')) break;
    end++;
  }
  return { start, end, text: lines.slice(start, end).join('\n') };
}

export function injectYamlWebhooks(text) {
  const lines = text.split('\n');
  const expected = WEBHOOKS_BLOCK.split('\n');

  const block = findTopLevelBlock(lines, 'webhooks');
  if (block) {
    if (block.text === expected.join('\n')) return { text, changed: false };
    lines.splice(block.start, block.end - block.start, ...expected);
    return { text: lines.join('\n'), changed: true };
  }

  // Insert the top-level `webhooks:` block immediately before top-level
  // `components:`. Both keys are always present and at column 0, so the anchor
  // is stable regardless of which sibling injectors ran first — the diff is
  // additions-only and order-independent.
  const componentsIndex = lines.indexOf('components:');
  if (componentsIndex === -1) {
    throw new Error('yaml: could not find top-level `components:` anchor for webhooks block');
  }
  lines.splice(componentsIndex, 0, ...expected);
  return { text: lines.join('\n'), changed: true };
}

// Only run the CLI (read/write/log/exit) when invoked directly — importing this
// module for its exported constants + injectYamlWebhooks (the contract test does)
// must be side-effect-free.
const isEntryPoint =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isEntryPoint) {
  const raw = readFileSync(bundlePath, 'utf8');
  const result = injectYamlWebhooks(raw);

  if (CHECK) {
    if (result.changed) {
      console.error('✗ bundle (worldmonitor.openapi.yaml) is missing the webhooks delivery contract');
      console.error('  Run: npm run gen:openapi:webhooks');
      process.exit(1);
    }
    console.log(`✓ bundle carries the ${WEBHOOK_EVENT} webhook with the ${SIGNATURE_HEADER} header`);
  } else {
    if (result.changed) writeFileSync(bundlePath, result.text);
    console.log(
      `openapi-inject-webhooks: ${result.changed ? 'injected' : 'already present'} — ${WEBHOOK_EVENT} webhook (${SIGNATURE_HEADER}) in worldmonitor.openapi.yaml`,
    );
  }
}
