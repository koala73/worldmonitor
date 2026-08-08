import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const apiDir = resolve(root, 'docs/api');
const TARGETS = [
  ['AviationService.openapi.json', 'GetAirportOpsSummary'],
  ['AviationService.openapi.json', 'ListAirportFlights'],
  ['InfrastructureService.openapi.json', 'ListTemporalAnomalies'],
  ['MaritimeService.openapi.json', 'ListNavigationalWarnings'],
  ['ConflictService.openapi.json', 'ListAcledEvents'],
  ['ConflictService.openapi.json', 'ListIranEvents'],
  ['MilitaryService.openapi.json', 'ListMilitaryFlights'],
];
const SEMANTIC_CONTRACTS = [
  {
    file: 'MaritimeService.openapi.json',
    operationId: 'ListNavigationalWarnings',
    required: [/issue times/, /area filtering/],
    forbidden: [/expiry/i],
  },
  {
    file: 'ConflictService.openapi.json',
    operationId: 'ListIranEvents',
    required: [/disabled by default/, /IRAN_EVENTS_ENABLED/, /empty list/],
    forbidden: [],
  },
  {
    file: 'MilitaryService.openapi.json',
    operationId: 'ListMilitaryFlights',
    required: [/bounding box/, /source fields/],
    forbidden: [/clusters/i, /OpenSky/i, /Wingbits/i],
  },
];

function operationById(file, operationId) {
  const spec = JSON.parse(readFileSync(resolve(apiDir, file), 'utf8'));
  for (const pathItem of Object.values(spec.paths ?? {})) {
    for (const operation of Object.values(pathItem ?? {})) {
      if (operation?.operationId === operationId) return operation;
    }
  }
  assert.fail(`${operationId} is missing from ${file}`);
}

describe('Bing-reported OpenAPI meta descriptions', () => {
  it('keeps targeted API reference descriptions complete, unique and search-friendly', () => {
    const descriptions = new Set();
    for (const [file, operationId] of TARGETS) {
      const description = operationById(file, operationId).description;
      assert.equal(typeof description, 'string', `${operationId} must have a description`);
      assert.ok(
        description.length >= 155 && description.length <= 160,
        `${operationId} description must be 155-160 characters, got ${description.length}`,
      );
      assert.match(description, /\.$/, `${operationId} description must be a complete sentence`);
      assert.ok(!descriptions.has(description), `${operationId} description must be unique`);
      descriptions.add(description);
    }
  });

  it('keeps descriptions aligned with current handler behavior', () => {
    for (const { file, operationId, required, forbidden } of SEMANTIC_CONTRACTS) {
      const description = operationById(file, operationId).description;
      for (const pattern of required) {
        assert.match(description, pattern, `${operationId} must describe ${pattern}`);
      }
      for (const pattern of forbidden) {
        assert.doesNotMatch(description, pattern, `${operationId} must not claim ${pattern}`);
      }
    }
  });
});
