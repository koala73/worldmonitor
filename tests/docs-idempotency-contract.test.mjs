import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(resolve(root, path), 'utf8');

const usageErrors = read('docs/usage-errors.mdx');
const commerceDocs = read('docs/api-commerce.mdx');
const notificationsDocs = read('docs/api-notifications.mdx');
const platformDocs = read('docs/api-platform.mdx');
const routeExceptions = JSON.parse(read('api/api-route-exceptions.json'));
const scenarioOpenApi = JSON.parse(read('docs/api/ScenarioService.openapi.json'));
const createCheckoutSource = read('api/create-checkout.ts');
const notifySource = read('api/notify.ts');

const standaloneWrites = [
  {
    doc: commerceDocs,
    heading: 'POST /api/create-checkout',
    path: '/api/create-checkout',
    file: 'api/create-checkout.ts',
  },
  {
    doc: commerceDocs,
    heading: 'POST /api/customer-portal',
    path: '/api/customer-portal',
    file: 'api/customer-portal.ts',
  },
  {
    doc: notificationsDocs,
    heading: 'POST /api/notification-channels',
    path: '/api/notification-channels',
    file: 'api/notification-channels.ts',
  },
  {
    doc: notificationsDocs,
    heading: 'POST /api/notify',
    path: '/api/notify',
    file: 'api/notify.ts',
  },
  {
    doc: platformDocs,
    heading: 'POST /api/user-prefs',
    path: '/api/user-prefs',
    file: 'api/user-prefs.ts',
  },
];

function idempotencyDescriptionFor(pathname) {
  const operation = scenarioOpenApi.paths?.[pathname]?.post;
  assert.ok(operation, `expected POST operation for ${pathname}`);
  const param = (operation.parameters ?? []).find((p) => p?.name === 'Idempotency-Key');
  assert.ok(param, `expected Idempotency-Key parameter for ${pathname}`);
  return param.description ?? '';
}

function sectionForEndpoint(markdown, endpointHeading) {
  const escapedEndpoint = endpointHeading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const heading = new RegExp(`^###\\s+\`${escapedEndpoint}\`\\s*$`, 'm');
  const match = heading.exec(markdown);
  assert.ok(match, `missing heading for ${endpointHeading}`);
  const rest = markdown.slice(match.index + match[0].length);
  const nextHeading = rest.search(/^#{1,3}\s+/m);
  return nextHeading === -1 ? rest : rest.slice(0, nextHeading);
}

describe('docs Idempotency-Key prose contract', () => {
  it('usage-errors mirrors the machine-readable idempotency source of truth', () => {
    const openApiDescription = idempotencyDescriptionFor('/api/scenario/v1/run-scenario');

    for (const phrase of [
      'identical request body',
      'status, body, and Content-Type',
      '422',
      'authenticated caller',
      'source IP',
      '24 hours',
    ]) {
      assert.match(
        usageErrors,
        new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'),
        `usage-errors.mdx must mention "${phrase}" from the injector contract`,
      );
      assert.match(
        openApiDescription,
        new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'),
        `generated OpenAPI contract must continue to mention "${phrase}"`,
      );
    }

    assert.doesNotMatch(
      usageErrors,
      /run-scenario` is \*\*not\*\*|may double-charge/i,
      'run-scenario must not be documented as non-idempotent when keyed retries are supported',
    );
  });

  it('usage-errors documents persistence limits for retryable statuses and checkout', () => {
    assert.match(
      usageErrors,
      /5xx responses are not cached/i,
      'usage-errors.mdx must state that keyed 5xx responses are not persisted for replay',
    );
    assert.match(
      createCheckoutSource,
      /completedTtlSeconds:\s*10\s*\*\s*60/,
      'create-checkout must continue to declare its short checkout replay window',
    );
    assert.match(
      sectionForEndpoint(commerceDocs, 'POST /api/create-checkout'),
      /10 minutes/i,
      'create-checkout docs must disclose its 10-minute replay window',
    );
  });

  it('usage-errors documents retry guidance for in-flight and mismatched keys', () => {
    assert.match(
      usageErrors,
      /\| `409` \|[^\n]*Idempotency-Key[^\n]*\| Yes[^\n]*Retry-After: 2/i,
      '409 row must describe retryable in-flight keyed requests with Retry-After: 2',
    );
    assert.match(
      usageErrors,
      /\| `422` \|[^\n]*Idempotency-Key[^\n]*different request body[^\n]*\| No[^\n]*new key/i,
      '422 row must describe mismatched-key reuse as non-retryable unchanged input',
    );
  });

  it('standalone write endpoint docs mention Idempotency-Key support', () => {
    for (const endpoint of standaloneWrites) {
      assert.match(
        usageErrors,
        new RegExp(endpoint.heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
        `usage-errors.mdx must list ${endpoint.heading} as a standalone idempotent write`,
      );
      assert.match(
        sectionForEndpoint(endpoint.doc, endpoint.heading),
        /Idempotency-Key[\s\S]*same key[\s\S]*replays/i,
        `${endpoint.heading} docs must mention Idempotency-Key replay support`,
      );
    }
  });

  it('standalone write endpoint docs are backed by handler idempotency wiring', () => {
    for (const endpoint of standaloneWrites) {
      const source = read(endpoint.file);
      assert.match(source, /getIdempotencyKey/, `${endpoint.file} must read Idempotency-Key`);
      assert.match(
        source,
        /beginStandaloneIdempotency/,
        `${endpoint.file} must use the standalone idempotency helper`,
      );
      assert.match(
        source,
        new RegExp(`pathname:\\s*['"]${endpoint.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]`),
        `${endpoint.file} must scope idempotency to ${endpoint.path}`,
      );
    }
  });

  it('notify docs match the standalone handler auth contract', () => {
    const notifyDocs = sectionForEndpoint(notificationsDocs, 'POST /api/notify');
    const notifyException = routeExceptions.exceptions.find((entry) => entry.path === 'api/notify.ts');
    assert.match(notifySource, /validateBearerToken/, 'notify handler validates Clerk bearer tokens');
    assert.match(notifySource, /features\.tier\s*<\s*1/, 'notify handler requires PRO entitlement');
    assert.equal(notifyException?.category, 'internal-helper', 'notify route registry category');
    assert.match(
      notifyException?.reason ?? '',
      /Clerk bearer auth/i,
      'notify route registry must document Clerk bearer auth',
    );
    assert.match(
      notifyException?.reason ?? '',
      /PRO/i,
      'notify route registry must document PRO entitlement',
    );
    assert.match(
      notifyDocs,
      /Clerk bearer[\s\S]*PRO/i,
      'notify docs must document Clerk bearer auth and PRO entitlement',
    );
    assert.doesNotMatch(
      `${notifyDocs}\n${notifyException?.reason ?? ''}`,
      /RELAY_SHARED_SECRET|Not a public API/i,
      'notify docs and route registry must not describe the old relay-secret/internal-only contract',
    );
  });
});
