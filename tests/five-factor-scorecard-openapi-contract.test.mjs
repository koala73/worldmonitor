import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { load as loadYaml } from 'js-yaml';

const specs = [
  ['service JSON', JSON.parse(readFileSync(new URL('../docs/api/ScorecardService.openapi.json', import.meta.url), 'utf8'))],
  ['service YAML', loadYaml(readFileSync(new URL('../docs/api/ScorecardService.openapi.yaml', import.meta.url), 'utf8'))],
  ['unified YAML', loadYaml(readFileSync(new URL('../docs/api/worldmonitor.openapi.yaml', import.meta.url), 'utf8'))],
];

function schema(spec, name) {
  return spec.components.schemas[name]
    ?? Object.entries(spec.components.schemas).find(([candidate]) => candidate.endsWith(`_${name}`))?.[1];
}

describe('five-factor OpenAPI contract', () => {
  it('publishes the exact custom-bloc selector constraints', () => {
    for (const [label, spec] of specs) {
      const request = schema(spec, 'GetBlocScorecardRequest');
      assert.deepEqual(request.oneOf, [
        { not: { required: ['members'] }, required: ['preset'] },
        { not: { required: ['preset'] }, required: ['members'] },
      ], label);
      assert.deepEqual(request.properties.members, {
        description: 'Custom list of 2-30 unique uppercase ISO 3166-1 alpha-2 members. Provide either preset or members; do not provide both.',
        items: { pattern: '^[A-Z]{2}$', type: 'string' },
        maxItems: 30,
        minItems: 2,
        type: 'array',
        uniqueItems: true,
      }, label);
      const operation = spec.paths['/api/scorecard/v1/get-bloc-scorecard'].get;
      assert.deepEqual(operation['x-worldmonitor-selector-one-of'], ['preset', 'members'], label);
      const members = operation.parameters.find((parameter) => parameter.name === 'members');
      assert.deepEqual(members.schema, {
        items: { pattern: '^[A-Z]{2}$', type: 'string' },
        maxItems: 30,
        minItems: 2,
        type: 'array',
        uniqueItems: true,
      }, label);
    }
  });

  it('discriminates available and unavailable response states', () => {
    for (const [label, spec] of specs) {
      const country = schema(spec, 'GetFiveFactorScorecardResponse');
      const bloc = schema(spec, 'GetBlocScorecardResponse');
      const list = schema(spec, 'ListFiveFactorScorecardsResponse');
      assert.equal(country.oneOf.length, 2, label);
      assert.equal(country.oneOf[0].properties.unavailable.const, false, label);
      assert.deepEqual(country.oneOf[1].properties.unavailableReason.enum, ['country-unavailable', 'scorecard-snapshot-unavailable'], label);
      assert.equal(bloc.oneOf[0].properties.unavailable.const, false, label);
      assert.deepEqual(bloc.oneOf[1].properties.unavailableReason.enum, ['bloc-members-unavailable', 'scorecard-snapshot-unavailable'], label);
      assert.equal(list.oneOf[0].properties.methodologyVersion.const, '1.0.0', label);
      assert.equal(list.oneOf[1].properties.scorecards.maxItems, 0, label);
    }
  });

  it('closes the scorecard value domains', () => {
    for (const [label, spec] of specs) {
      const pillar = schema(spec, 'FiveFactorPillar').properties;
      assert.match(pillar.pillar.pattern, /food\|energy\|demographics\|technology\|defense/, label);
      assert.deepEqual([pillar.score.minimum, pillar.score.maximum], [0, 5], label);
      assert.deepEqual([pillar.subScore.minimum, pillar.subScore.maximum], [0, 100], label);
      assert.deepEqual([pillar.inputCoverage.minimum, pillar.inputCoverage.maximum], [0, 1], label);
      assert.equal(pillar.includedMembers.items.pattern, '^[A-Z]{2}$', label);
      assert.match(pillar.insufficientReasons.items.pattern, /redistribution-blocked/, label);
    }
  });

  it('publishes runnable success examples instead of union placeholders', () => {
    for (const [label, spec] of specs) {
      const example = (path) => spec.paths[path].get.responses['200'].content['application/json'].example;
      const country = example('/api/scorecard/v1/get-five-factor-scorecard');
      const bloc = example('/api/scorecard/v1/get-bloc-scorecard');
      const list = example('/api/scorecard/v1/list-five-factor-scorecards');
      assert.match(country.scorecard.countryCode, /^[A-Z]{2}$/, label);
      assert.ok(Array.isArray(country.scorecard.pillars), label);
      assert.deepEqual(Object.keys(country.scorecard.pillars[0].inputs[0].observations[0]).sort(), [
        'indicatorCode', 'name', 'source', 'unit', 'value', 'year',
      ], label);
      assert.equal(bloc.scorecard.methodologyVersion, '1.0.0', label);
      assert.ok(Array.isArray(bloc.scorecard.members), label);
      assert.equal(list.computedAt, '2026-01-15T12:00:00Z', label);
      assert.ok(Array.isArray(list.scorecards), label);
      assert.equal(list.unavailable, false, label);
    }
  });
});
