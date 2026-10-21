// The Canadian agency wildfire sources (CWFIS #6613, BC Wildfire #6614) emit
// fields the FireDetection contract did not declare. Undeclared fields are
// invisible to typed clients, absent from the SDK and the OpenAPI spec, and a
// strict decoder is free to drop them.
//
// The subtler failure is a field declared under the WRONG NAME: it appears in
// the schema, consumers code against it, and it is never populated. These pin
// proto, generated types and emitted payload to the same names.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string) => readFileSync(join(root, rel), 'utf8');

const proto = read('proto/worldmonitor/wildfire/v1/fire_detection.proto');
const generated = read('src/generated/server/worldmonitor/wildfire/v1/service_server.ts');
const cwfis = read('scripts/wildfire/cwfis-wfs.mjs');
const bc = read('scripts/wildfire/bc-fire-points.mjs');

/** snake_case proto field -> lowerCamelCase, as the sebuf generator emits. */
const camel = (name: string) => name.replace(/_([a-z])/g, (_, c) => c.toUpperCase());

// Every agency field, with the emitter that produces it.
const AGENCY_FIELDS = [
  { proto: 'source', emittedBy: [cwfis, bc] },
  { proto: 'kind', emittedBy: [cwfis, bc] },
  { proto: 'emergency', emittedBy: [cwfis, bc] },
  { proto: 'agency_fire_id', emittedBy: [cwfis] },
  { proto: 'agency_code', emittedBy: [cwfis] },
  { proto: 'fire_size', emittedBy: [cwfis, bc] },
];

test('FireDetection declares every agency field', () => {
  for (const { proto: field } of AGENCY_FIELDS) {
    assert.match(
      proto,
      new RegExp(`\\b${field} = \\d+;`),
      `${field} is emitted but not declared — invisible to the SDK and OpenAPI`,
    );
  }
});

test('agency fields use NEW field numbers and do not renumber existing ones', () => {
  // Reusing a number silently reinterprets old bytes as the new type.
  const numbers = [...proto.matchAll(/^\s*(?:[\w.]+)\s+(\w+) = (\d+)/gm)]
    .map((m) => ({ name: m[1], num: Number(m[2]) }));
  const byNum = new Map<number, string>();
  for (const { name, num } of numbers) {
    assert.equal(byNum.has(num), false, `field number ${num} reused by ${name}`);
    byNum.set(num, name);
  }
  // The pre-existing satellite contract must keep its original numbering.
  assert.equal(byNum.get(1), 'id');
  assert.equal(byNum.get(3), 'brightness');
  assert.equal(byNum.get(10), 'possible_explosion');
  for (const { proto: field } of AGENCY_FIELDS) {
    const entry = numbers.find((n) => n.name === field);
    assert.ok(entry && entry.num > 10, `${field} must take a new number above the existing 10`);
  }
});

test('the generated types expose each agency field', () => {
  for (const { proto: field } of AGENCY_FIELDS) {
    assert.match(
      generated,
      new RegExp(`\\n  ${camel(field)}[?]?:`),
      `${camel(field)} missing from generated types — regenerate after editing the proto`,
    );
  }
});

test('every declared agency field is actually populated by a seeder', () => {
  // The mismatch this catches: a proto field named fire_size_hectares while the
  // seeder emits fireSize. It appears in the schema, consumers code against it,
  // and it is never set.
  for (const { proto: field, emittedBy } of AGENCY_FIELDS) {
    const key = camel(field);
    const emitted = emittedBy.some((src) => new RegExp(`\\n\\s*${key}:`).test(src));
    assert.ok(
      emitted,
      `${key} is declared in the proto but no seeder emits it — a schema field that is always empty`,
    );
  }
});

test('the OpenAPI artifact carries the agency fields', () => {
  const spec = read('docs/api/WildfireService.openapi.json');
  for (const { proto: field } of AGENCY_FIELDS) {
    assert.ok(
      spec.includes(`"${field}"`) || spec.includes(`"${camel(field)}"`),
      `${field} missing from the published OpenAPI spec`,
    );
  }
});
