import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import Ajv2020 from 'ajv/dist/2020.js';
import { load as loadYaml } from 'js-yaml';
import {
  provenanceValueSchema,
  readChinaCorridorWireContract,
  readDecisionSignalProvenanceContract,
} from '../scripts/lib/openapi-codegen.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const path = '/api/supply-chain/v1/get-china-corridor-control-towers';
const corridorContract = readChinaCorridorWireContract();
const provenanceContract = readDecisionSignalProvenanceContract();
const provenanceDimensions = [...provenanceContract.dimensions].sort();

const specs = [
  ['SupplyChainService JSON', JSON.parse(readFileSync(resolve(root, 'docs/api/SupplyChainService.openapi.json'), 'utf8'))],
  ['SupplyChainService YAML', loadYaml(readFileSync(resolve(root, 'docs/api/SupplyChainService.openapi.yaml'), 'utf8'))],
  ['unified YAML', loadYaml(readFileSync(resolve(root, 'docs/api/worldmonitor.openapi.yaml'), 'utf8'))],
];

function resolveRef(spec, schema) {
  const ref = schema?.$ref;
  if (!ref) return schema;
  return spec.components.schemas[ref.slice('#/components/schemas/'.length)];
}

function embeddedValidator(spec) {
  const operation = spec.paths[path].get;
  const envelope = resolveRef(
    spec,
    operation.responses['200'].content['application/json'].schema,
  );
  const payloadRef = envelope.properties.payloadJson.contentSchema.$ref;
  const ajv = new Ajv2020({
    allErrors: true,
    strict: false,
    validateFormats: false,
  });
  return ajv.compile({
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    components: { schemas: spec.components.schemas },
    $ref: payloadRef,
  });
}

describe('China corridor OpenAPI agent contract', () => {
  for (const [label, spec] of specs) {
    it(`${label}: documents the JSON payload's corridor, condition, and provenance shape`, () => {
      const operation = spec.paths[path].get;
      const envelope = resolveRef(
        spec,
        operation.responses['200'].content['application/json'].schema,
      );
      const payloadJson = envelope.properties.payloadJson;
      assert.equal(payloadJson.type, 'string');
      assert.equal(payloadJson.contentMediaType, 'application/json');

      const payload = resolveRef(spec, payloadJson.contentSchema);
      assert.ok(payload, 'payloadJson must reference a documented inner response schema');
      const corridor = resolveRef(spec, payload.properties.corridors.items);
      const condition = resolveRef(spec, corridor.properties.conditions.items);
      const provenance = resolveRef(
        spec,
        condition.properties.provenance.oneOf.find((item) => item.$ref),
      );
      assert.deepEqual(corridor.properties.id.enum, corridorContract.corridorIds);
      assert.equal(corridor.properties.boundary.type, 'array');
      assert.equal(corridor.properties.nodes.type, 'array');
      assert.deepEqual(
        corridor.properties.nodes.items.properties.type.enum,
        corridorContract.nodeTypes,
      );
      assert.deepEqual(
        corridor.properties.nodes.items.properties.sourceSelector
          .properties.family.enum,
        corridorContract.signalFamilies,
      );
      assert.deepEqual(
        corridor.properties.availability.enum,
        corridorContract.availabilities,
      );
      assert.deepEqual(condition.properties.family.enum, corridorContract.signalFamilies);
      assert.equal(condition.properties.sourceSignals.type, 'array');
      const sourceSignal = condition.properties.sourceSignals.items;
      assert.equal(sourceSignal.type, 'object');
      assert.ok(sourceSignal.required.includes('publisher'));
      assert.ok(sourceSignal.required.includes('observationTime'));
      assert.ok(sourceSignal.required.includes('transportFreshness'));
      assert.deepEqual(
        sourceSignal.properties.transportFreshness.enum,
        corridorContract.transportFreshnessStates,
      );
      assert.deepEqual(
        sourceSignal.properties.contentFreshness.enum,
        corridorContract.contentFreshnessStates,
      );
      assert.deepEqual(
        sourceSignal.properties.availability.enum,
        corridorContract.signalAvailabilities,
      );
      assert.deepEqual(
        sourceSignal.properties.family.enum,
        corridorContract.signalFamilies,
      );
      assert.deepEqual(
        sourceSignal.properties.corridorIds.items.enum,
        corridorContract.corridorIds,
      );
      assert.equal(sourceSignal.properties.publisher.type, 'object');
      assert.ok(sourceSignal.properties.publisher.required.includes('type'));
      assert.deepEqual(
        sourceSignal.properties.publisher.properties.type.enum,
        corridorContract.publisherTypes,
      );
      assert.deepEqual(
        sourceSignal.properties.sourceScope.enum,
        corridorContract.sourceScopes,
      );
      assert.deepEqual(
        sourceSignal.properties.observationTimePrecision.enum,
        corridorContract.timePrecisions,
      );
      const revision = sourceSignal.properties.revision.oneOf.find(
        (item) => item.type === 'object',
      );
      assert.deepEqual(
        revision.properties.state.enum,
        corridorContract.revisionStates,
      );
      assert.deepEqual(
        sourceSignal.properties.metrics.additionalProperties.type,
        ['string', 'number', 'boolean', 'null'],
      );
      const claims = provenance.properties.claims;
      assert.deepEqual([...claims.required].sort(), provenanceDimensions);
      for (const dimension of provenanceContract.dimensions) {
        const knownClaim = claims.properties[dimension].oneOf.find(
          (item) => item.properties?.status?.const === 'known',
        );
        assert.ok(
          knownClaim?.properties?.value,
          `${dimension} must publish a typed known-value schema`,
        );
      }

      assert.match(envelope.properties.upstreamUnavailable.description, /agent|caller/i);
      const example = operation.responses['200'].content['application/json'].example;
      const decoded = JSON.parse(example.payloadJson);
      const validateEmbedded = embeddedValidator(spec);
      assert.equal(
        validateEmbedded(decoded),
        true,
        `${label}: representative corridor payload rejected: ${JSON.stringify(validateEmbedded.errors)}`,
      );
      assert.equal(decoded.corridors[0].id, 'china-yangtze-river-delta');
      const exampleProvenance = decoded.corridors[0].conditions[0].provenance;
      assert.equal(exampleProvenance.contractVersion, provenanceContract.version);
      assert.deepEqual(Object.keys(exampleProvenance.claims).sort(), provenanceDimensions);

      const invalidPrecision = structuredClone(decoded);
      invalidPrecision.corridors[0].conditions[0].provenance
        .claims.observation_time.value = {
          role: 'observation',
          value: '2026',
          precision: 'instant',
        };
      assert.equal(validateEmbedded(invalidPrecision), false);

      const publisherClaim = claims.properties.publisher;
      const unavailableClaim = resolveRef(
        spec,
        publisherClaim.oneOf.find((item) => item.$ref),
      );
      assert.deepEqual(
        unavailableClaim.properties.status.enum,
        provenanceContract.claimStatuses.filter((status) => status !== 'known'),
      );
      const knownValue = (dimension) =>
        claims.properties[dimension].oneOf
          .find((item) => item.properties?.status?.const === 'known')
          .properties.value;
      for (const dimension of provenanceContract.dimensions) {
        assert.deepEqual(
          knownValue(dimension),
          provenanceValueSchema(dimension, provenanceContract),
          `${dimension} must use the shared provenance value schema`,
        );
      }
      assert.deepEqual(
        knownValue('publisher').properties.type.enum,
        provenanceContract.publisherTypes,
      );
      assert.equal(
        knownValue('observation_time').properties.role.const,
        'observation',
      );
      assert.deepEqual(
        knownValue('revision').properties.state.enum,
        provenanceContract.revisionStates,
      );
      assert.deepEqual(
        knownValue('corroboration').properties.state.enum,
        provenanceContract.corroborationStates,
      );
      assert.deepEqual(
        knownValue('transport_freshness').properties.state.enum,
        provenanceContract.transportFreshnessStates,
      );
      assert.ok(
        knownValue('derivation').required.includes('inputSignalIds'),
      );
    });
  }

  it('the OpenAPI injector is idempotent', async () => {
    const { execFileSync } = await import('node:child_process');
    execFileSync('node', ['scripts/openapi-inject-china-corridors.mjs', '--check'], {
      cwd: root,
      stdio: 'pipe',
    });
  });
});
