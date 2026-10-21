import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { parse as parseYaml } from 'yaml';

const ROOT = new URL('../', import.meta.url);

function readJson(path) {
  return JSON.parse(readFileSync(new URL(path, ROOT), 'utf8'));
}

function readYaml(path) {
  return parseYaml(readFileSync(new URL(path, ROOT), 'utf8'));
}

function schemasContaining(spec, needle) {
  return Object.entries(spec.components?.schemas ?? {})
    .filter(([, schema]) => JSON.stringify(schema).includes(needle))
    .map(([name]) => name);
}

function schemaEndingWith(spec, suffix) {
  return Object.entries(spec.components?.schemas ?? {})
    .find(([name]) => name.endsWith(suffix))?.[1];
}

describe('public API provider redistribution contract', () => {
  for (const [label, spec] of [
    ['AviationService JSON', () => readJson('docs/api/AviationService.openapi.json')],
    ['AviationService YAML', () => readYaml('docs/api/AviationService.openapi.yaml')],
    ['worldmonitor bundle', () => readYaml('docs/api/worldmonitor.openapi.yaml')],
  ]) {
    it(`${label} does not advertise OpenSky as a response provider`, () => {
      assert.deepEqual(schemasContaining(spec(), 'POSITION_SOURCE_OPENSKY'), []);
    });
  }

  for (const [label, spec] of [
    ['MilitaryService JSON', () => readJson('docs/api/MilitaryService.openapi.json')],
    ['MilitaryService YAML', () => readYaml('docs/api/MilitaryService.openapi.yaml')],
    ['worldmonitor bundle', () => readYaml('docs/api/worldmonitor.openapi.yaml')],
  ]) {
    it(`${label} documents only redistributable military observation examples`, () => {
      const militaryFlight = schemaEndingWith(spec(), 'MilitaryFlight');
      assert.ok(militaryFlight, 'MilitaryFlight schema must exist');
      assert.doesNotMatch(JSON.stringify(militaryFlight), /opensky/i);
      assert.match(militaryFlight.properties?.source?.description ?? '', /wingbits/i);
    });
  }

  it('keeps the OpenSky enum in the internal product proto', () => {
    const proto = readFileSync(new URL('proto/worldmonitor/aviation/v1/position_sample.proto', ROOT), 'utf8');
    assert.match(proto, /POSITION_SOURCE_OPENSKY/);
  });
});
