import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import { load as loadYaml } from 'js-yaml';

import {
  CHINA_DECISION_SIGNAL_GROUP_IDS,
  isChinaDecisionSignalSnapshot,
} from '../shared/china-decision-signals';
import {
  readChinaDecisionSignalWireContract,
  readDecisionSignalProvenanceContract,
} from '../scripts/lib/openapi-codegen.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const path = '/api/intelligence/v1/get-china-decision-signals';
const wireContract = readChinaDecisionSignalWireContract();
const provenanceContract = readDecisionSignalProvenanceContract();
const macroFixture = JSON.parse(readFileSync(
  resolve(
    root,
    'tests/fixtures/decision-signal-provenance/china-macro-official.json',
  ),
  'utf8',
));

const specs = [
  [
    'IntelligenceService JSON',
    JSON.parse(readFileSync(
      resolve(root, 'docs/api/IntelligenceService.openapi.json'),
      'utf8',
    )),
  ],
  [
    'IntelligenceService YAML',
    loadYaml(readFileSync(
      resolve(root, 'docs/api/IntelligenceService.openapi.yaml'),
      'utf8',
    )),
  ],
  [
    'unified YAML',
    loadYaml(readFileSync(
      resolve(root, 'docs/api/worldmonitor.openapi.yaml'),
      'utf8',
    )),
  ],
] as const;

function resolveRef(
  spec: Record<string, any>,
  schema: Record<string, any>,
): Record<string, any> {
  const ref = schema?.$ref;
  if (!ref) return schema;
  return spec.components.schemas[ref.slice('#/components/schemas/'.length)];
}

function embeddedValidator(spec: Record<string, any>) {
  const operation = spec.paths[path].get;
  const envelope = resolveRef(
    spec,
    operation.responses['200'].content['application/json'].schema,
  );
  const snapshotRef = envelope.properties.payloadJson.contentSchema.$ref;
  const ajv = new Ajv2020({
    allErrors: true,
    strict: false,
    validateFormats: false,
  });
  return ajv.compile({
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    components: { schemas: spec.components.schemas },
    $ref: snapshotRef,
  });
}

function availableSnapshot() {
  const provenance = structuredClone(macroFixture.provenance);
  const claims = provenance.claims;
  return {
    schemaVersion: wireContract.schemaVersion,
    generatedAt: '2026-07-26T12:00:00.000Z',
    groups: wireContract.groupIds.map((id, index) => index === 0
      ? {
          id,
          state: 'available',
          reason: null,
          items: [{
            id: provenance.signalId,
            lineageId: 'macro:nbs-industrial-value-added:2026-06',
            label: 'Industrial production',
            summary: 'Official industrial production release',
            sourceName: claims.publisher.value.name,
            sourceUrl: claims.source_url.value,
            publisherType: claims.publisher.value.type,
            observedAt: claims.observation_time.value.value,
            publishedAt: claims.publication_time.value.value,
            effectiveAt: null,
            retrievedAt: claims.retrieval_time.value.value,
            stale: false,
            metadata: {},
            provenance,
          }],
          metadata: {},
        }
      : {
          id,
          state: 'unavailable',
          reason: 'No launched, provenance-valid signal is currently available.',
          items: [],
          metadata: {},
        }),
    access: { ...wireContract.access },
  };
}

describe('China decision-signals OpenAPI embedded JSON contract', () => {
  for (const [label, spec] of specs) {
    it(`${label}: documents the anonymous six-group canonical snapshot`, () => {
      const operation = spec.paths[path].get;
      assert.deepEqual(operation.security, []);

      const envelope = resolveRef(
        spec,
        operation.responses['200'].content['application/json'].schema,
      );
      const payloadJson = envelope.properties.payloadJson;
      assert.equal(payloadJson.type, 'string');
      assert.equal(payloadJson.contentMediaType, 'application/json');

      const snapshot = resolveRef(spec, payloadJson.contentSchema);
      assert.equal(snapshot.properties.schemaVersion.const, wireContract.schemaVersion);
      assert.equal(snapshot.properties.generatedAt.format, 'date-time');
      assert.equal(snapshot.properties.groups.minItems, wireContract.groupIds.length);
      assert.equal(snapshot.properties.groups.maxItems, wireContract.groupIds.length);

      assert.deepEqual(
        snapshot.properties.groups.prefixItems.map(
          (candidate: Record<string, any>) =>
            candidate.allOf[1].properties.id.const,
        ),
        wireContract.groupIds,
      );
      assert.equal(snapshot.properties.groups.items, false);
      const group = resolveRef(
        spec,
        snapshot.properties.groups.prefixItems[0].allOf[0],
      );
      assert.deepEqual(group.properties.id.enum, wireContract.groupIds);
      assert.deepEqual(group.properties.state.enum, wireContract.states);
      assert.equal(group.properties.items.maxItems, wireContract.maxItemsPerGroup);

      const item = resolveRef(spec, group.properties.items.items);
      assert.deepEqual(
        item.properties.publisherType.enum,
        provenanceContract.publisherTypes,
      );
      assert.equal(item.properties.metadata.type, 'object');

      const provenance = resolveRef(spec, item.properties.provenance);
      assert.equal(
        provenance.properties.contractVersion.const,
        provenanceContract.version,
      );
      assert.deepEqual(
        provenance.properties.familyId.enum,
        wireContract.provenanceFamilyIds,
      );
      const claims = resolveRef(spec, provenance.properties.claims);
      assert.deepEqual(
        [...claims.required].sort(),
        [...provenanceContract.dimensions].sort(),
      );

      const access = resolveRef(spec, snapshot.properties.access);
      assert.equal(
        access.properties.anonymous.const,
        wireContract.access.anonymous,
      );
      assert.equal(access.properties.pro.const, wireContract.access.pro);
      assert.equal(
        access.properties.operator.const,
        wireContract.access.operator,
      );

      const example =
        operation.responses['200'].content['application/json'].example;
      const decoded = JSON.parse(example.payloadJson);
      assert.equal(isChinaDecisionSignalSnapshot(decoded), true);
      assert.deepEqual(
        decoded.groups.map((candidate: { id: string }) => candidate.id),
        CHINA_DECISION_SIGNAL_GROUP_IDS,
      );
      assert.equal(decoded.groups.length, wireContract.groupIds.length);
      assert.equal(
        decoded.groups.every(
          (candidate: { state: string; items: unknown[] }) =>
            candidate.state === 'unavailable' && candidate.items.length === 0,
        ),
        true,
      );
      assert.equal(example.generatedAt, decoded.generatedAt);
      assert.equal(example.upstreamUnavailable, true);

      const validateEmbedded = embeddedValidator(spec);
      const available = availableSnapshot();
      assert.equal(isChinaDecisionSignalSnapshot(available), true);
      assert.equal(
        validateEmbedded(available),
        true,
        `${label}: valid available snapshot rejected: ${JSON.stringify(validateEmbedded.errors)}`,
      );

      const duplicateId = structuredClone(available);
      duplicateId.groups[1].id = duplicateId.groups[0].id;
      assert.equal(isChinaDecisionSignalSnapshot(duplicateId), false);
      assert.equal(validateEmbedded(duplicateId), false);

      const unavailableWithItems = structuredClone(available);
      unavailableWithItems.groups[0].state = 'unavailable';
      assert.equal(isChinaDecisionSignalSnapshot(unavailableWithItems), false);
      assert.equal(validateEmbedded(unavailableWithItems), false);

      const invalidPublisher = structuredClone(available);
      invalidPublisher.groups[0].items[0].provenance.claims.publisher.value = 7;
      assert.equal(isChinaDecisionSignalSnapshot(invalidPublisher), false);
      assert.equal(validateEmbedded(invalidPublisher), false);

      const invalidFamilyPolicy = structuredClone(available);
      invalidFamilyPolicy.groups[0].items[0].provenance.claims.publisher = {
        status: 'unknown',
        reason: 'Publisher missing',
      };
      assert.equal(isChinaDecisionSignalSnapshot(invalidFamilyPolicy), false);
      assert.equal(validateEmbedded(invalidFamilyPolicy), false);

      const invalidPrecision = structuredClone(available);
      invalidPrecision.groups[0].items[0].provenance.claims.observation_time.value = {
        role: 'observation',
        value: '2026',
        precision: 'instant',
      };
      assert.equal(isChinaDecisionSignalSnapshot(invalidPrecision), false);
      assert.equal(validateEmbedded(invalidPrecision), false);

      const invalidCalendarDay = structuredClone(available);
      invalidCalendarDay.groups[0].items[0].provenance.claims.observation_time.value = {
        role: 'observation',
        value: '2026-02-29',
        precision: 'day',
      };
      assert.equal(isChinaDecisionSignalSnapshot(invalidCalendarDay), false);
      assert.equal(validateEmbedded(invalidCalendarDay), false);

      const emptyUnavailableReason = structuredClone(available);
      emptyUnavailableReason.groups[0].items[0].provenance.claims.effective_time = {
        status: 'unknown',
        reason: '',
      };
      assert.equal(isChinaDecisionSignalSnapshot(emptyUnavailableReason), false);
      assert.equal(validateEmbedded(emptyUnavailableReason), false);

      const emptyLineageId = structuredClone(available);
      emptyLineageId.groups[0].items[0].lineageId = '';
      assert.equal(isChinaDecisionSignalSnapshot(emptyLineageId), false);
      assert.equal(validateEmbedded(emptyLineageId), false);

      const credentialBearingUrl = structuredClone(available);
      credentialBearingUrl.groups[0].items[0].sourceUrl =
        'https://user:pass@example.com/release';
      credentialBearingUrl.groups[0].items[0].provenance.claims.source_url.value =
        'https://user:pass@example.com/release';
      assert.equal(isChinaDecisionSignalSnapshot(credentialBearingUrl), false);
      assert.equal(validateEmbedded(credentialBearingUrl), false);

      const emptyAuthorityUrl = structuredClone(available);
      emptyAuthorityUrl.groups[0].items[0].sourceUrl = 'https://?x';
      emptyAuthorityUrl.groups[0].items[0].provenance.claims.source_url.value =
        'https://?x';
      assert.equal(isChinaDecisionSignalSnapshot(emptyAuthorityUrl), false);
      assert.equal(validateEmbedded(emptyAuthorityUrl), false);

      const emptyGroupReason = structuredClone(available);
      emptyGroupReason.groups[0].reason = ' ';
      assert.equal(isChinaDecisionSignalSnapshot(emptyGroupReason), false);
      assert.equal(validateEmbedded(emptyGroupReason), false);
    });
  }

  it('the OpenAPI injector is idempotent', () => {
    execFileSync(
      'node',
      ['scripts/openapi-inject-china-decision-signals.mjs', '--check'],
      { cwd: root, stdio: 'pipe' },
    );
  });
});
