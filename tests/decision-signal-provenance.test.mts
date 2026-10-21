import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  DECISION_SIGNAL_PROVENANCE_CONTRACT_VERSION,
  DECISION_SIGNAL_PROVENANCE_DIMENSIONS,
  DECISION_SIGNAL_PROVENANCE_FAMILY_DECLARATIONS,
  DECISION_SIGNAL_PROVENANCE_FAMILY_REGISTRATIONS,
  DECISION_SIGNAL_PROVENANCE_SURFACE_ADAPTERS,
  DECISION_SIGNAL_PROVENANCE_SURFACES,
  DecisionSignalProvenanceValidationError,
  parseDecisionSignalProvenance,
  serializeDecisionSignalProvenance,
  validateDecisionSignalProvenance,
} from '../shared/decision-signal-provenance';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const fixtureRoot = join(root, 'tests/fixtures/decision-signal-provenance');

interface Fixture {
  id: string;
  familyId: string;
  scenarios: string[];
  provenance: Record<string, unknown>;
}

interface InvalidFixture {
  id: string;
  baseFixtureId: string;
  mutations: Array<{
    operation: 'delete' | 'set';
    path: string;
    value?: unknown;
  }>;
  expectedCodes: string[];
}

const positiveFixtures = [
  ...(JSON.parse(readFileSync(join(fixtureRoot, 'positive.json'), 'utf8')) as Fixture[]),
  JSON.parse(
    readFileSync(join(fixtureRoot, 'china-macro-official.json'), 'utf8'),
  ) as Fixture,
];
const negativeFixtures = JSON.parse(
  readFileSync(join(fixtureRoot, 'negative.json'), 'utf8'),
) as InvalidFixture[];

function positiveFixture(id: string): Fixture {
  const fixture = positiveFixtures.find((candidate) => candidate.id === id);
  assert.ok(fixture, `missing positive fixture ${id}`);
  return fixture;
}

function invalidFixtureProvenance(fixture: InvalidFixture): Record<string, unknown> {
  const provenance = structuredClone(positiveFixture(fixture.baseFixtureId).provenance);
  for (const mutation of fixture.mutations) {
    const segments = mutation.path.split('.');
    const finalSegment = segments.pop();
    assert.ok(finalSegment, `${fixture.id} mutation path must not be empty`);
    let target: Record<string, unknown> = provenance;
    for (const segment of segments) {
      const next = target[segment];
      assert.ok(next && typeof next === 'object' && !Array.isArray(next), `${fixture.id} invalid path`);
      target = next as Record<string, unknown>;
    }
    if (mutation.operation === 'delete') {
      delete target[finalSegment];
    } else {
      target[finalSegment] = mutation.value;
    }
  }
  return provenance;
}

function assertValid(fixture: Fixture) {
  const result = validateDecisionSignalProvenance(fixture.provenance);
  assert.equal(
    result.ok,
    true,
    `${fixture.id}: ${result.ok ? '' : result.errors.map((error) => `${error.path} ${error.code}`).join(', ')}`,
  );
  return result.value;
}

describe('decision-signal provenance contract (#5581)', () => {
  it('publishes one explicit declaration policy for every shared provenance dimension', () => {
    assert.equal(DECISION_SIGNAL_PROVENANCE_CONTRACT_VERSION, 'decision-signal-provenance/v1');
    assert.deepEqual(DECISION_SIGNAL_PROVENANCE_DIMENSIONS, [
      'publisher',
      'source_url',
      'original_reference',
      'original_language',
      'translation',
      'observation_time',
      'effective_time',
      'publication_time',
      'retrieval_time',
      'revision',
      'supersession',
      'extraction_confidence',
      'classification_confidence',
      'corroboration',
      'transport_freshness',
      'content_freshness',
      'derivation',
    ]);

    const expectedKinds = [
      'official_numeric_observation',
      'typed_document_event',
      'operational_activity_record',
      'exchange_disclosure',
      'composed_corridor_condition',
      'derived_comparison',
    ];
    assert.deepEqual(
      [...new Set(
        Object.values(DECISION_SIGNAL_PROVENANCE_FAMILY_DECLARATIONS)
          .map((declaration) => declaration.kind),
      )].sort(),
      [...expectedKinds].sort(),
    );

    for (const declaration of Object.values(DECISION_SIGNAL_PROVENANCE_FAMILY_DECLARATIONS)) {
      assert.deepEqual(
        Object.keys(declaration.dimensions).sort(),
        [...DECISION_SIGNAL_PROVENANCE_DIMENSIONS].sort(),
        `${declaration.id} must declare every provenance dimension`,
      );
      for (const policy of Object.values(declaration.dimensions)) {
        assert.ok(
          policy === 'required' || policy === 'unknown_allowed' || policy === 'not_applicable',
          `${declaration.id} has invalid declaration policy ${policy}`,
        );
      }
    }
  });

  it('keeps the family registration and fixture completeness frontier exact', () => {
    assert.deepEqual(
      Object.keys(DECISION_SIGNAL_PROVENANCE_FAMILY_REGISTRATIONS).sort(),
      Object.keys(DECISION_SIGNAL_PROVENANCE_FAMILY_DECLARATIONS).sort(),
      'a registered or launched family cannot exist without a declaration, and stale declarations cannot linger',
    );

    const fixtureIds = new Set(positiveFixtures.map((fixture) => fixture.id));
    const fixtureFamilyIds = new Set(positiveFixtures.map((fixture) => fixture.familyId));
    for (const [familyId, registration] of Object.entries(
      DECISION_SIGNAL_PROVENANCE_FAMILY_REGISTRATIONS,
    )) {
      const serializationFixture = positiveFixture(registration.serializationFixtureId);
      assert.equal(
        serializationFixture.familyId,
        familyId,
        `${familyId} serialization fixture points at ${serializationFixture.familyId}`,
      );
      assert.ok(fixtureIds.has(registration.serializationFixtureId), `${familyId} missing serialization fixture`);
      assert.ok(fixtureFamilyIds.has(familyId), `${familyId} missing a positive contract fixture`);
      assert.ok(
        registration.launchStatus === 'reference' || registration.launchStatus === 'launched',
        `${familyId} missing explicit launch status`,
      );
    }

    for (const familyId of fixtureFamilyIds) {
      assert.ok(
        DECISION_SIGNAL_PROVENANCE_FAMILY_DECLARATIONS[familyId],
        `fixture uses undeclared family ${familyId}`,
      );
    }
  });

  it('accepts the positive reference matrix across every supported family', () => {
    assert.equal(positiveFixtures.length, 8);
    for (const fixture of positiveFixtures) {
      const value = assertValid(fixture);
      assert.equal(value.familyId, fixture.familyId);
      assert.equal(value.contractVersion, DECISION_SIGNAL_PROVENANCE_CONTRACT_VERSION);
    }

    const scenarios = new Set(positiveFixtures.flatMap((fixture) => fixture.scenarios));
    for (const scenario of [
      'translated_document',
      'revised_observation',
      'cancelled_or_superseded_event',
      'stale_transport_current_content',
      'current_transport_stale_content',
      'derived_output',
    ]) {
      assert.ok(scenarios.has(scenario), `missing positive scenario ${scenario}`);
    }
  });

  it('rejects omissions, invalid vocabulary, stale source references, and semantic substitutions', () => {
    assert.equal(negativeFixtures.length, 23);
    for (const fixture of negativeFixtures) {
      const result = validateDecisionSignalProvenance(invalidFixtureProvenance(fixture));
      assert.equal(result.ok, false, `${fixture.id} should fail validation`);
      if (result.ok) continue;
      const codes = new Set(result.errors.map((error) => error.code));
      for (const expectedCode of fixture.expectedCodes) {
        assert.ok(codes.has(expectedCode), `${fixture.id} missing ${expectedCode}: ${[...codes].join(', ')}`);
      }
    }
  });

  it('resolves source-backed publishers through the #5571 registry without conflating publisher classes', () => {
    const government = assertValid(positiveFixture('official-numeric-revised'));
    const stateMedia = assertValid(positiveFixture('typed-document-translated'));
    const marketAuthority = assertValid(positiveFixture('exchange-disclosure-superseded'));
    const derived = assertValid(positiveFixture('derived-comparison'));

    assert.deepEqual(government.claims.publisher, {
      status: 'known',
      value: {
        id: 'publisher:miit-cn',
        name: 'Ministry of Industry and Information Technology',
        type: 'official_government',
        registryReference: {
          sourceName: 'MIIT (China)',
          sourceType: 'gov',
          propagandaRisk: 'high',
        },
      },
    });
    assert.equal(
      (stateMedia.claims.publisher as { value: { type: string } }).value.type,
      'state_controlled_media',
    );
    assert.equal(
      (marketAuthority.claims.publisher as { value: { type: string } }).value.type,
      'official_exchange',
    );
    assert.deepEqual(
      (derived.claims.publisher as { value: { type: string; registryReference: null } }).value,
      {
        id: 'publisher:worldmonitor-derived',
        name: 'WorldMonitor derived output',
        type: 'derived_output',
        registryReference: null,
      },
    );
  });

  it('keeps time roles, confidence claims, and freshness claims independent through serialization', () => {
    const translated = assertValid(positiveFixture('typed-document-translated'));
    const observation = assertValid(positiveFixture('official-numeric-revised'));
    const staleTransport = assertValid(positiveFixture('operational-stale-transport'));
    const staleContent = assertValid(positiveFixture('corridor-stale-content'));

    assert.notDeepEqual(translated.claims.effective_time, translated.claims.publication_time);
    assert.notDeepEqual(translated.claims.publication_time, translated.claims.retrieval_time);
    assert.deepEqual(
      parseDecisionSignalProvenance(serializeDecisionSignalProvenance(translated)),
      translated,
    );

    assert.equal(
      (observation.claims.extraction_confidence as { value: { score: number } }).value.score,
      0.42,
      'official publisher authority must not inflate extraction confidence',
    );
    assert.equal(observation.claims.classification_confidence.status, 'not_applicable');
    assert.equal(translated.claims.corroboration.status, 'unknown');

    assert.equal(
      (staleTransport.claims.transport_freshness as { value: { state: string } }).value.state,
      'stale',
    );
    assert.equal(
      (staleTransport.claims.content_freshness as { value: { state: string } }).value.state,
      'current',
    );
    assert.equal(
      (staleContent.claims.transport_freshness as { value: { state: string } }).value.state,
      'fresh',
    );
    assert.equal(
      (staleContent.claims.content_freshness as { value: { state: string } }).value.state,
      'stale',
    );
  });

  it('round-trips the same stable IDs and status vocabulary across cache, API, MCP, and UI adapters', () => {
    assert.deepEqual(DECISION_SIGNAL_PROVENANCE_SURFACES, [
      'cache_storage',
      'api',
      'mcp',
      'ui',
    ]);

    for (const registration of Object.values(DECISION_SIGNAL_PROVENANCE_FAMILY_REGISTRATIONS)) {
      const fixture = positiveFixture(registration.serializationFixtureId);
      const canonical = assertValid(fixture);
      const encodings = DECISION_SIGNAL_PROVENANCE_SURFACES.map((surface) => {
        const adapter = DECISION_SIGNAL_PROVENANCE_SURFACE_ADAPTERS[surface];
        const wire = adapter.serialize(canonical);
        const roundTripped = adapter.deserialize(JSON.parse(JSON.stringify(wire)));
        assert.deepEqual(roundTripped, canonical, `${fixture.id} ${surface} round trip`);
        return JSON.stringify(wire);
      });
      assert.equal(new Set(encodings).size, 1, `${fixture.id} surface serialization drift`);
    }
  });

  it('fails closed before serializing invalid provenance', () => {
    const invalid = negativeFixtures[0];
    assert.ok(invalid);
    assert.throws(
      () => serializeDecisionSignalProvenance(invalidFixtureProvenance(invalid)),
      (error: unknown) => {
        assert.ok(error instanceof DecisionSignalProvenanceValidationError);
        assert.ok(error.errors.length > 0);
        return true;
      },
    );
  });

  it('fails closed on malformed JSON before it ever reaches shape validation', () => {
    assert.throws(
      () => parseDecisionSignalProvenance('{not valid json'),
      (error: unknown) => {
        assert.ok(error instanceof DecisionSignalProvenanceValidationError);
        assert.deepEqual(error.errors.map((issue) => issue.code), ['INVALID_JSON']);
        return true;
      },
    );
  });

  it('is included in the required CI test path', () => {
    const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    const testWorkflow = readFileSync(join(root, '.github/workflows/test.yml'), 'utf8');
    assert.match(packageJson.scripts?.['test:data'] ?? '', /tests\/\*\.test\.mts/);
    assert.match(testWorkflow, /npm run test:data/);
  });
});
