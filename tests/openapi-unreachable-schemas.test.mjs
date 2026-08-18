import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadUnifiedOpenApiSpec } from './_lib/openapi-spec-cache.mjs';

import {
  dropUnreachableSchemas,
  unreachableSchemaNames,
} from '../scripts/openapi-drop-unreachable-schemas.mjs';
import { dedupeErrorResponses, dedupeSharedParameters } from '../scripts/openapi-dedup-responses.mjs';
import { dedupeSharedChinaProvenanceSchemas } from '../scripts/openapi-dedup-schemas.mjs';

// The generator emits one component schema per RPC message, but a GET operation
// spends its request message as `parameters` and never points at the request
// schema — so ~210 definitions were carried, served, and counted against the
// scanner body budget while being unreachable from every operation, response,
// and sibling schema (#6558). Dropping them at JSON-emit time returns ~93 KB of
// a 950 KB budget that had 3,318 bytes left.
//
// "Unreachable" has to mean unreachable, so these tests attack the transform
// from the direction that would actually hurt: a schema reached only through a
// nested JSON pointer, only from a hoisted component, or only through another
// schema, must survive. The real-bundle tests then prove the served document
// has no dangling $ref and that every schema an operation can still reach is
// byte-identical to what it was before.

const HTTP_METHODS = new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']);

/**
 * Every component-schema name the document mentions ANYWHERE, found without
 * reusing the transform's own idea of what a reference looks like.
 *
 * This is deliberately a regex over the serialized document rather than a
 * second key-aware walk. A walk that matched on `$ref` the way
 * `collectSchemaRefs` does would share its blind spot exactly — the safety net
 * would be woven from the same thread as the thing it is catching, and could
 * never fail for a vocabulary gap. Scanning raw text finds a schema name
 * wherever it is written: `$ref`, `$dynamicRef`, a `discriminator.mapping`
 * value, or a construct nobody has thought of yet.
 */
function mentionedSchemaNames(spec) {
  const names = new Set();
  for (const [, name] of JSON.stringify(spec).matchAll(/#\/components\/schemas\/([A-Za-z0-9_.\-~]+)/g)) {
    names.add(name.replaceAll('~1', '/').replaceAll('~0', '~'));
  }
  return names;
}

function servedBundle() {
  const spec = loadUnifiedOpenApiSpec();
  dedupeErrorResponses(spec);
  dedupeSharedChinaProvenanceSchemas(spec);
  dedupeSharedParameters(spec);
  return spec;
}

describe('unreachableSchemaNames (fixture)', () => {
  const fixture = () => ({
    openapi: '3.1.0',
    paths: {
      '/a': {
        get: {
          responses: {
            200: { content: { 'application/json': { schema: { $ref: '#/components/schemas/Used' } } } },
          },
        },
        // A non-method key on the path item must not be mistaken for an operation.
        summary: 'not an operation',
      },
    },
    components: {
      schemas: {
        Used: { properties: { next: { $ref: '#/components/schemas/UsedIndirectly' } } },
        UsedIndirectly: { type: 'string' },
        Orphan: { type: 'object' },
        OrphanReferencedOnlyByOrphan: { type: 'integer' },
      },
    },
  });

  it('keeps schemas reachable transitively and drops orphans, including orphan-only referents', () => {
    const spec = fixture();
    spec.components.schemas.Orphan = { $ref: '#/components/schemas/OrphanReferencedOnlyByOrphan' };
    assert.deepEqual(
      [...unreachableSchemaNames(spec)].sort(),
      ['Orphan', 'OrphanReferencedOnlyByOrphan'],
    );
  });

  it('keeps a schema reached only through a nested JSON pointer', () => {
    const spec = fixture();
    spec.components.schemas.Used.properties.next = {
      $ref: '#/components/schemas/Orphan/properties/inner',
    };
    spec.components.schemas.Orphan = { properties: { inner: { type: 'string' } } };
    // Orphan is now reached only by a pointer THROUGH it; UsedIndirectly lost
    // its only referent to that same edit, so the two must land on opposite
    // sides of the verdict.
    assert.deepEqual(
      [...unreachableSchemaNames(spec)].sort(),
      ['OrphanReferencedOnlyByOrphan', 'UsedIndirectly'],
    );
  });

  it('keeps a schema reached only from a hoisted component (responses/parameters/headers)', () => {
    for (const bucket of ['responses', 'parameters', 'headers']) {
      const spec = fixture();
      spec.components[bucket] = { Hoisted: { schema: { $ref: '#/components/schemas/Orphan' } } };
      assert.ok(
        !unreachableSchemaNames(spec).has('Orphan'),
        `a schema referenced from components.${bucket} is reachable`,
      );
    }
  });

  it('keeps a schema reached only from webhooks', () => {
    const spec = fixture();
    delete spec.components.schemas.Orphan;
    spec.webhooks = {
      ping: { post: { requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/OrphanReferencedOnlyByOrphan' } } } } } },
    };
    assert.deepEqual([...unreachableSchemaNames(spec)], []);
  });

  it('returns nothing for a spec with no components.schemas', () => {
    assert.deepEqual([...unreachableSchemaNames({ openapi: '3.1.0', paths: {} })], []);
  });

  it('keeps a schema named only by discriminator.mapping — the edge with no $ref key', () => {
    // The bundle carries no discriminator today, which is exactly why this is a
    // fixture and not a real-bundle assertion: the first proto to add one would
    // otherwise silently lose its subtypes, and the served document would ship
    // a mapping pointing at a schema that is no longer there.
    for (const target of ['#/components/schemas/Orphan', 'Orphan']) {
      const spec = fixture();
      spec.components.schemas.Used = {
        oneOf: [{ $ref: '#/components/schemas/UsedIndirectly' }],
        discriminator: { propertyName: 'kind', mapping: { orphan: target } },
      };
      assert.ok(
        !unreachableSchemaNames(spec).has('Orphan'),
        `discriminator.mapping value ${target} must keep its target alive`,
      );
    }
  });

  it('ignores a discriminator.mapping value that points outside this document', () => {
    const spec = fixture();
    spec.components.schemas.Used = {
      discriminator: { propertyName: 'kind', mapping: { remote: 'https://example.com/schemas/Other' } },
    };
    // No crash, no invented component, and the genuine orphans still go.
    assert.ok(unreachableSchemaNames(spec).has('Orphan'));
  });

  it('keeps a schema reached only by $dynamicRef', () => {
    const spec = fixture();
    spec.components.schemas.Used = { $dynamicRef: '#/components/schemas/Orphan' };
    const unreachable = unreachableSchemaNames(spec);
    assert.ok(!unreachable.has('Orphan'));
    assert.ok(unreachable.has('UsedIndirectly'), 'the schema that lost its referent is now unreachable');
  });
});

describe('dropUnreachableSchemas (fixture)', () => {
  it('removes exactly the unreachable names and reports what it freed', () => {
    const spec = {
      openapi: '3.1.0',
      paths: { '/a': { get: { responses: { 200: { schema: { $ref: '#/components/schemas/Used' } } } } } },
      components: { schemas: { Used: { type: 'object' }, Orphan: { type: 'string', description: 'x'.repeat(200) } } },
    };
    const before = JSON.stringify(spec).length;
    const stats = dropUnreachableSchemas(spec);
    assert.equal(stats.dropped, 1);
    assert.deepEqual(Object.keys(spec.components.schemas), ['Used']);
    assert.equal(stats.bytesFreed, before - JSON.stringify(spec).length);
    assert.ok(stats.bytesFreed > 200, `expected the description bytes back, got ${stats.bytesFreed}`);
  });

  it('is idempotent: a second pass has nothing left to drop', () => {
    const spec = {
      openapi: '3.1.0',
      paths: { '/a': { get: { responses: { 200: { schema: { $ref: '#/components/schemas/Used' } } } } } },
      components: { schemas: { Used: { type: 'object' }, Orphan: { type: 'string' } } },
    };
    assert.equal(dropUnreachableSchemas(spec).dropped, 1);
    assert.deepEqual(dropUnreachableSchemas(spec), { dropped: 0, bytesFreed: 0, names: [] });
  });

  it('leaves components.schemas absent rather than empty when everything is unreachable', () => {
    const spec = { openapi: '3.1.0', paths: {}, components: { schemas: { Orphan: { type: 'string' } } } };
    dropUnreachableSchemas(spec);
    assert.equal(spec.components?.schemas, undefined);
  });
});

describe('unreachable schema drop (real bundle)', () => {
  const before = servedBundle();
  const after = servedBundle();
  const stats = dropUnreachableSchemas(after);

  it('actually engages — the generated request-message orphans are real', () => {
    // Vacuity guard. A reachability bug that marks everything reachable makes
    // every other assertion here pass while the transform does nothing, and the
    // budget is too tight for that to go unnoticed for long.
    assert.ok(stats.dropped >= 150, `expected the generated orphans, dropped only ${stats.dropped}`);
    assert.ok(stats.bytesFreed >= 60_000, `expected a material saving, freed ${stats.bytesFreed} bytes`);
  });

  it('drops only request-message-shaped orphans, never a response or operation schema', () => {
    const responseShaped = stats.names.filter((name) => /Response$/.test(name));
    assert.deepEqual(responseShaped, [], 'a *Response schema no operation reaches means the walk is wrong');
  });

  it('leaves no schema name mentioned anywhere in the served document unresolvable', () => {
    const present = new Set(Object.keys(after.components?.schemas ?? {}));
    const dangling = [...mentionedSchemaNames(after)].filter((name) => !present.has(name));
    assert.deepEqual(dangling, [], 'the served JSON must resolve every document-local schema name');
  });

  it('is lossless for everything an operation can reach: retained schemas are byte-identical', () => {
    const retained = Object.keys(after.components.schemas);
    assert.ok(retained.length > 0);
    for (const name of retained) {
      assert.equal(
        JSON.stringify(after.components.schemas[name]),
        JSON.stringify(before.components.schemas[name]),
        `${name} changed under a transform that may only remove unreachable entries`,
      );
    }
  });

  it('is order-independent: running the drop first emits the identical document', () => {
    // build-openapi-json.mjs runs the drop last and its comment says that is a
    // convention rather than a requirement — the unconditional seeding from
    // every non-schema bucket is what actually keeps hoisted components' schema
    // targets alive. This is that claim, executed. If it ever fails, the
    // comment is wrong and the ordering is load-bearing after all.
    const first = loadUnifiedOpenApiSpec();
    dropUnreachableSchemas(first);
    dedupeErrorResponses(first);
    dedupeSharedChinaProvenanceSchemas(first);
    dedupeSharedParameters(first);
    assert.equal(JSON.stringify(first), JSON.stringify(after));
  });

  it('changes nothing outside components.schemas', () => {
    const strip = (spec) => {
      const copy = { ...spec, components: { ...spec.components } };
      delete copy.components.schemas;
      return JSON.stringify(copy);
    };
    assert.equal(strip(after), strip(before));
  });

  it('every operation still resolves its 2xx response schema', () => {
    // The scanner credits the inline responses['200'] schema, so the refs that
    // matter most are the ones reachable from a 2xx body.
    const present = new Set(Object.keys(after.components.schemas));
    let checked = 0;
    for (const [path, pathItem] of Object.entries(after.paths)) {
      for (const [method, op] of Object.entries(pathItem ?? {})) {
        if (!HTTP_METHODS.has(method) || !op?.responses) continue;
        for (const [status, response] of Object.entries(op.responses)) {
          if (!/^2/.test(status)) continue;
          for (const name of mentionedSchemaNames(response)) {
            checked += 1;
            assert.ok(present.has(name), `${method.toUpperCase()} ${path} ${status} lost ${name}`);
          }
        }
      }
    }
    assert.ok(checked > 100, `expected the 2xx bodies to reference schemas, saw ${checked}`);
  });
});
