import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load as loadYaml } from 'js-yaml';

import { dedupeErrorResponses } from '../scripts/openapi-dedup-responses.mjs';

// Guards the served public/openapi.json against the ~1 MB scanner body cap.
// On 2026-07-05 the per-op rate-limit/idempotency/example doc injections grew
// the minified JSON from ~752 KB to ~1.04 MB and ora.ai/orank's Access
// "function-calling compatibility" check flipped from PASS ("192/192 with
// typed schemas") to WARN ("API spec found but couldn't validate function
// calling compatibility") — the same error path its validator hits on
// elevenlabs' 1.8 MB and openrouter's 1.5 MB specs, while sub-800 KB specs get
// computed verdicts. build-openapi-json.mjs now $ref-dedupes the repeated
// non-2xx error responses when emitting the JSON artifact; these tests prove
// the dedup is lossless, keeps scanner-credited 2xx responses inline, and
// keeps the artifact under budget so the next injector can't silently
// re-cross the cap.

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const bundlePath = resolve(root, 'docs/api/worldmonitor.openapi.yaml');
const buildScriptPath = resolve(root, 'scripts/build-openapi-json.mjs');

// Leave headroom under the ~1 MB cap: the spec sat at ~752 KB when the check
// last passed and ~814 KB deduped today. If this fails, either extend the
// dedup (more shared structure) or trim the newest per-op injection — do NOT
// raise the budget past 1 MB.
const SIZE_BUDGET_BYTES = 950_000;

const HTTP_METHODS = new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']);

function operationResponses(spec) {
  const out = [];
  for (const [path, pathItem] of Object.entries(spec.paths ?? {})) {
    for (const [method, op] of Object.entries(pathItem ?? {})) {
      if (!HTTP_METHODS.has(method.toLowerCase()) || !op?.responses) continue;
      for (const [statusCode, response] of Object.entries(op.responses)) {
        out.push({ path, method, statusCode, response });
      }
    }
  }
  return out;
}

function resolveResponseRefs(spec) {
  for (const site of operationResponses(spec)) {
    const ref = site.response?.$ref;
    if (!ref) continue;
    const name = ref.replace('#/components/responses/', '');
    const target = spec.components?.responses?.[name];
    assert.ok(target, `${site.method.toUpperCase()} ${site.path} ${site.statusCode}: dangling ${ref}`);
    spec.paths[site.path][site.method].responses[site.statusCode] = structuredClone(target);
  }
  delete spec.components?.responses;
  if (spec.components && Object.keys(spec.components).length === 0) delete spec.components;
  return spec;
}

describe('dedupeErrorResponses (fixture)', () => {
  const fixture = () => ({
    openapi: '3.1.0',
    paths: {
      '/a': {
        get: {
          responses: {
            200: { description: 'a-ok', content: {} },
            429: { description: 'slow down', headers: { 'Retry-After': {} } },
            400: { description: 'bad a' },
          },
        },
      },
      '/b': {
        post: {
          responses: {
            200: { description: 'b-ok', content: {} },
            429: { description: 'slow down', headers: { 'Retry-After': {} } },
            400: { description: 'bad b' },
          },
        },
      },
    },
  });

  it('hoists repeated non-2xx responses and leaves unique + 2xx responses inline', () => {
    const spec = fixture();
    const stats = dedupeErrorResponses(spec);
    assert.equal(stats.hoisted, 1, 'only the repeated 429 group is hoisted');
    assert.equal(stats.replacedRefs, 2);
    assert.deepEqual(spec.components.responses.TooManyRequests, {
      description: 'slow down',
      headers: { 'Retry-After': {} },
    });
    assert.deepEqual(spec.paths['/a'].get.responses[429], {
      $ref: '#/components/responses/TooManyRequests',
    });
    assert.deepEqual(spec.paths['/b'].post.responses[429], {
      $ref: '#/components/responses/TooManyRequests',
    });
    // Unique 400s and both 200s stay put.
    assert.equal(spec.paths['/a'].get.responses[400].description, 'bad a');
    assert.equal(spec.paths['/b'].post.responses[400].description, 'bad b');
    assert.equal(spec.paths['/a'].get.responses[200].description, 'a-ok');
    assert.equal(spec.paths['/b'].post.responses[200].description, 'b-ok');
  });

  it('never hoists 2xx responses even when identical', () => {
    const spec = fixture();
    spec.paths['/a'].get.responses[200] = { description: 'same' };
    spec.paths['/b'].post.responses[200] = { description: 'same' };
    dedupeErrorResponses(spec);
    assert.equal(spec.paths['/a'].get.responses[200].description, 'same');
    assert.equal(spec.paths['/b'].post.responses[200].description, 'same');
  });

  it('avoids colliding with pre-existing component names', () => {
    const spec = fixture();
    spec.components = { responses: { TooManyRequests: { description: 'taken' } } };
    dedupeErrorResponses(spec);
    assert.equal(spec.components.responses.TooManyRequests.description, 'taken');
    assert.equal(spec.components.responses.TooManyRequests2.description, 'slow down');
    assert.equal(
      spec.paths['/a'].get.responses[429].$ref,
      '#/components/responses/TooManyRequests2',
    );
  });
});

describe('dedupeErrorResponses (real bundle)', () => {
  const original = loadYaml(readFileSync(bundlePath, 'utf8'));
  const deduped = structuredClone(original);
  const stats = dedupeErrorResponses(deduped);

  it('is lossless: resolving the $refs reproduces the original spec exactly', () => {
    assert.deepEqual(resolveResponseRefs(structuredClone(deduped)), original);
  });

  it('keeps every 2xx response inline (orank credits only the inline responses["200"])', () => {
    for (const site of operationResponses(deduped)) {
      if (!/^2/.test(site.statusCode)) continue;
      assert.equal(
        site.response.$ref,
        undefined,
        `${site.method.toUpperCase()} ${site.path} ${site.statusCode} must stay inline`,
      );
    }
  });

  it('actually engages on the injected error docs (429 et al.)', () => {
    assert.ok(
      deduped.components.responses.TooManyRequests,
      'the per-op 429 rate-limit block must dedupe into components.responses.TooManyRequests',
    );
    assert.ok(stats.replacedRefs >= 500, `expected wide dedup, got ${stats.replacedRefs} refs`);
  });

  it(`keeps the minified JSON under the ${SIZE_BUDGET_BYTES}-byte scanner budget`, () => {
    const bytes = JSON.stringify(deduped).length;
    assert.ok(
      bytes <= SIZE_BUDGET_BYTES,
      `public/openapi.json would be ${bytes} bytes (budget ${SIZE_BUDGET_BYTES}). ` +
        'Scanners cap spec bodies around 1 MB (orank function-calling-compat degrades to ' +
        '"couldn\'t validate" above it). Extend scripts/openapi-dedup-responses.mjs or slim ' +
        'the newest per-op injection instead of raising this budget.',
    );
  });
});

describe('build-openapi-json wiring', () => {
  it('the build script applies dedupeErrorResponses before writing public/openapi.json', () => {
    const src = readFileSync(buildScriptPath, 'utf8');
    assert.match(src, /from '\.\/openapi-dedup-responses\.mjs'/);
    assert.match(src, /dedupeErrorResponses\(spec\)/);
  });
});
