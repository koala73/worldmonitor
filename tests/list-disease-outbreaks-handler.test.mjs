/**
 * Tests for server/worldmonitor/health/v1/list-disease-outbreaks.ts
 *
 * Regression coverage for PR #3793 round 3 (P2 review finding):
 *   - alertLevelMethodologyVersion is declared on the proto contract and
 *     surfaced on the typed handler response.
 *   - The handler echoes the field when present on the cached payload.
 *   - The handler falls back to 'v1' when the cached payload predates the
 *     field (transitional read tolerance for already-cached payloads).
 *
 * Pattern mirrors tests/list-airport-delays.test.mjs — stub Upstash REST at
 * the globalThis.fetch boundary because ESM module exports are immutable.
 */

import { describe, it, before, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

// ── Generated client/server interface assertions ─────────────────────────

describe('proto + generated bindings declare alertLevelMethodologyVersion (#3793 round 3)', () => {
  it('list_disease_outbreaks.proto declares alert_level_methodology_version field 3', () => {
    const protoSrc = readFileSync(
      resolve(root, 'proto/worldmonitor/health/v1/list_disease_outbreaks.proto'),
      'utf-8',
    );
    assert.match(
      protoSrc,
      /string\s+alert_level_methodology_version\s*=\s*3;/,
      'proto must declare alert_level_methodology_version = 3',
    );
    // Comment must point at the methodology doc so future hands know the protocol.
    assert.match(
      protoSrc,
      /docs\/methodology\/disease-alert-level\.md/,
      'proto comment must reference the methodology doc',
    );
  });

  it('generated client ListDiseaseOutbreaksResponse interface declares alertLevelMethodologyVersion', () => {
    const clientGen = readFileSync(
      resolve(root, 'src/generated/client/worldmonitor/health/v1/service_client.ts'),
      'utf-8',
    );
    // Locate the response interface block and assert the field is inside it.
    const match = clientGen.match(/export interface ListDiseaseOutbreaksResponse \{[^}]*\}/);
    assert.ok(match, 'client must declare ListDiseaseOutbreaksResponse');
    assert.match(
      match[0],
      /alertLevelMethodologyVersion:\s*string/,
      'client ListDiseaseOutbreaksResponse must declare alertLevelMethodologyVersion: string',
    );
  });

  it('generated server ListDiseaseOutbreaksResponse interface declares alertLevelMethodologyVersion', () => {
    const serverGen = readFileSync(
      resolve(root, 'src/generated/server/worldmonitor/health/v1/service_server.ts'),
      'utf-8',
    );
    const match = serverGen.match(/export interface ListDiseaseOutbreaksResponse \{[^}]*\}/);
    assert.ok(match, 'server must declare ListDiseaseOutbreaksResponse');
    assert.match(
      match[0],
      /alertLevelMethodologyVersion:\s*string/,
      'server ListDiseaseOutbreaksResponse must declare alertLevelMethodologyVersion: string',
    );
  });

  it('OpenAPI HealthService.openapi.yaml surfaces alertLevelMethodologyVersion under ListDiseaseOutbreaksResponse', () => {
    const yaml = readFileSync(resolve(root, 'docs/api/HealthService.openapi.yaml'), 'utf-8');
    // Naive but sufficient: locate the response schema block and assert the
    // property name appears inside it.
    const startIdx = yaml.indexOf('ListDiseaseOutbreaksResponse:');
    assert.ok(startIdx >= 0, 'response schema must be present');
    const block = yaml.slice(startIdx, startIdx + 1500);
    assert.match(block, /alertLevelMethodologyVersion:\s*\n\s*type:\s*string/);
  });
});

// ── Behavioural — invoke the handler against stubbed Redis ───────────────

// Cannot replace ESM module exports at runtime, so stub the Upstash REST
// boundary (globalThis.fetch). The handler reads:
//   getCachedJson('health:disease-outbreaks:v1', true)  // raw=true ⇒ no prefix
// and we set Upstash env vars so the helper actually issues a fetch.

let listDiseaseOutbreaks;
const cacheStore = new Map();
const originalFetch = globalThis.fetch;
const REDIS_KEY = 'health:disease-outbreaks:v1';

before(async () => {
  process.env.UPSTASH_REDIS_REST_URL = 'https://stub-upstash.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'stub-token';
  process.env.VERCEL_ENV = 'production';

  mock.method(globalThis, 'fetch', async (url, _init) => {
    const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
    const getMatch = urlStr.match(/\/get\/([^/?#]+)$/);
    if (getMatch) {
      const key = decodeURIComponent(getMatch[1]);
      if (cacheStore.has(key)) {
        return new Response(JSON.stringify({ result: JSON.stringify(cacheStore.get(key)) }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ result: null }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return originalFetch(url, _init);
  });

  const mod = await import('../server/worldmonitor/health/v1/list-disease-outbreaks.ts');
  listDiseaseOutbreaks = mod.listDiseaseOutbreaks;
});

beforeEach(() => {
  cacheStore.clear();
});

describe('listDiseaseOutbreaks handler — alertLevelMethodologyVersion (#3793 round 3)', () => {
  it('emits the field verbatim when the cached payload carries it', async () => {
    cacheStore.set(REDIS_KEY, {
      outbreaks: [
        { id: 'a', disease: 'Cholera', alertLevel: 'alert', publishedAt: 1700000000000 },
      ],
      fetchedAt: 1700000000000,
      alertLevelMethodologyVersion: 'v2',  // deliberately != fallback to prove pass-through
    });

    const resp = await listDiseaseOutbreaks({}, {});

    assert.equal(
      resp.alertLevelMethodologyVersion,
      'v2',
      'handler must echo the payload version unchanged (no clobbering of seeder-stamped value)',
    );
    assert.equal(resp.outbreaks.length, 1);
    assert.equal(resp.fetchedAt, 1700000000000);
  });

  it('falls back to "v1" when the cached payload predates the field (transitional read tolerance)', async () => {
    // Pre-3793-round-3 payload shape: no alertLevelMethodologyVersion.
    // Without the fallback the response would be missing a required proto
    // field, breaking generated clients on the deploy window between server
    // ship and the next seed publish.
    cacheStore.set(REDIS_KEY, {
      outbreaks: [
        { id: 'b', disease: 'Mpox', alertLevel: 'watch', publishedAt: 1690000000000 },
      ],
      fetchedAt: 1690000000000,
    });

    const resp = await listDiseaseOutbreaks({}, {});

    assert.equal(
      resp.alertLevelMethodologyVersion,
      'v1',
      'handler must fall back to v1 when cached payload lacks the field (back-compat with old caches)',
    );
    assert.equal(resp.outbreaks.length, 1);
    assert.equal(resp.fetchedAt, 1690000000000);
  });

  it('returns empty defaults + "v1" methodology when cache is entirely empty (cold start)', async () => {
    // No cacheStore.set → /get returns { result: null } → getCachedJson → null.
    const resp = await listDiseaseOutbreaks({}, {});

    assert.deepEqual(resp.outbreaks, [], 'empty outbreaks on cold start');
    assert.equal(resp.fetchedAt, 0, 'fetchedAt=0 on cold start');
    assert.equal(
      resp.alertLevelMethodologyVersion,
      'v1',
      'methodology version field is always present (proto contract); fallback covers cold start',
    );
  });
});
