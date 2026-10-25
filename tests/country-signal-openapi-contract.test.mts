import { it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { countrySignalOutcomeSchema } from '../shared/country-signal-observations';

const spec = JSON.parse(readFileSync(new URL('../docs/api/IntelligenceService.openapi.json', import.meta.url), 'utf8'));
const operation = spec.paths['/api/intelligence/v1/get-country-signal-observations'].get;

it('keeps the same window and cursor bounds in both published YAML specs', () => {
  for (const name of ['IntelligenceService', 'worldmonitor']) {
    const yaml = parse(readFileSync(new URL(`../docs/api/${name}.openapi.yaml`, import.meta.url), 'utf8'));
    const parameters = Object.fromEntries(yaml.paths['/api/intelligence/v1/get-country-signal-observations'].get.parameters.map((parameter: { name: string }) => [parameter.name, parameter]));
    assert.equal(parameters.window_index.schema.minimum, 0);
    assert.equal(parameters.window_index.schema.maximum, 1);
    assert.equal(parameters.cursor.schema.maxLength, 200);
  }
});

it('documents required country/family and bounded flight window/cursor parameters', () => {
  const parameters = Object.fromEntries(operation.parameters.map((parameter: { name: string }) => [parameter.name, parameter]));
  assert.equal(parameters.country_code.required, true);
  assert.equal(parameters.family.required, true);
  assert.equal(parameters.window_index.schema.minimum, 0);
  assert.equal(parameters.window_index.schema.maximum, 1);
  assert.equal(parameters.cursor.schema.maxLength, 200);
  assert.equal(parameters.window_index.example, 0);
  assert.ok(!parameters.cursor.example);
});

it('publishes a valid qualified outcome example rather than mixed family flight data', () => {
  const example = operation.responses['200'].content['application/json'].example;
  const outcome = countrySignalOutcomeSchema.parse(JSON.parse(example.outcomeJson));
  assert.equal(example.countryCode, outcome.countryCode);
  assert.equal(example.family, `COUNTRY_SIGNAL_FAMILY_${outcome.family.toUpperCase()}`);
  assert.equal(example.windowIndex, 0);
  assert.equal(example.flightPage, undefined);
});
