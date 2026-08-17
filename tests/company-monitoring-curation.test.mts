import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  CompanyMonitoringCurationError,
  auditCompanyMonitoringCurationSplit,
  compileCompanyMonitoringBlindCorpus,
  compileCompanyMonitoringGoldLabels,
  type CompanyMonitoringCurationManifest,
  type CompanyMonitoringGoldCurationManifest,
} from '../shared/company-monitoring-curation.ts';

const versions = {
  protocolVersion: 'cm_eval_v1',
  policyVersion: 'cm-admission-policy-v1',
  modelVersion: 'deepseek_v4_flash_2026_08_05',
  classifierRuntimeSha256: createHash('sha256').update('classifier-runtime').digest('hex'),
  queryVersion: 'cm_query_v1',
  curatorAccessVersion: 'cm_curator_access_v1',
};

function manifest(
  namespace: string,
  purpose: CompanyMonitoringCurationManifest['purpose'],
  count = 2,
): CompanyMonitoringCurationManifest {
  const namespaceDigest = createHash('sha256').update(namespace).digest('hex');
  return {
    schemaVersion: 'cm_public_evidence_curation_v1',
    collectionVersion: `cm_collection_${namespace}_v1`,
    corpusVersion: `cm_corpus_${namespace}_v1`,
    purpose,
    collectedAt: '2026-08-12T08:00:00.000Z',
    custody: {
      collectorTool: 'codex',
      collectorModel: 'gpt-5.6-sol',
      collectorRunId: `run_${namespace}`,
      storageClass: 'sealed_external',
      labelsVisibleToPolicyAuthors: false,
    },
    ...versions,
    candidates: Array.from({ length: count }, (_, index) => ({
      candidateId: `candidate_${namespace}_${index + 1}`,
      disposition: 'included' as const,
      exclusionReason: null,
      opaqueExampleId: `cm_example_${namespaceDigest.slice(0, 5)}${index.toString(16)}`,
      company: {
        legalName: `Synthetic ${namespace} Company ${index + 1} Ltd`,
        stableIdentity: `synthetic-company:${namespace}:${index + 1}`,
        corporateFamilyIdentity: `synthetic-family:${namespace}:${index + 1}`,
        officialDomains: [`publisher-${namespace}.example`],
        verifiedXAccountIds: [],
        geography: index % 2 === 0 ? 'US' as const : 'GB' as const,
        privateStatus: 'private' as const,
        privateStatusEvidence: {
          url: `https://registry-${namespace}.example/company/${index + 1}`,
          publisher: `Synthetic ${namespace} Registry`,
          sourceOrigin: `registry-${namespace}.example`,
          retrievedAt: '2026-08-12T07:30:00.000Z',
        },
      },
      occurrence: {
        stableIdentity: `synthetic-occurrence:${namespace}:${index + 1}`,
        occurredAt: `2026-08-${String(index + 1).padStart(2, '0')}T12:00:00.000Z`,
        occurredAtPrecision: 'second' as const,
        geography: index % 2 === 0 ? 'US' as const : 'GB' as const,
      },
      primarySourceId: `source_${index + 1}`,
      sources: [{
        sourceId: `source_${index + 1}`,
        url: `https://publisher-${namespace}.example/releases/${index + 1}`,
        publisher: `Synthetic ${namespace} Publisher`,
        sourceOrigin: `publisher-${namespace}.example`,
        title: `Synthetic ${namespace} observed event ${index + 1}`,
        boundedExcerpt: `Synthetic ${namespace} test-only evidence for event ${index + 1}.`,
        publishedAt: `2026-08-${String(index + 1).padStart(2, '0')}T12:05:00.000Z`,
        publishedAtPrecision: 'second' as const,
        observedAt: '2026-08-12T07:00:00.000Z',
        retrievedAt: '2026-08-12T07:30:00.000Z',
        evidenceAuthority: index % 2 === 0 ? 'official_company' as const : 'independent_news' as const,
        syndication: {
          relationship: index % 2 === 0 ? 'original' as const : 'independent' as const,
          upstreamUrl: null,
          groupIdentity: `synthetic-syndication:${namespace}:${index + 1}`,
        },
      }],
    })),
  };
}

function expectCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof CompanyMonitoringCurationError && error.code === code;
}

describe('Company Monitoring public-evidence curation', () => {
  it('compiles a sealed public-evidence manifest into an opaque draft corpus', () => {
    const input = manifest('pilot', 'pilot');
    const result = compileCompanyMonitoringBlindCorpus(input);

    assert.equal(result.corpus.status, 'draft');
    assert.equal(result.corpus.examples.length, 2);
    assert.equal(result.summary.researchedCandidates, 2);
    assert.equal(result.summary.verifiedEvidenceBundles, 2);
    assert.deepEqual(result.summary.geography, { US: 1, GB: 1 });
    assert.deepEqual(result.summary.exclusions, {});
    assert.match(result.manifestSha256, /^[a-f0-9]{64}$/);

    const serialized = JSON.stringify(result);
    assert.doesNotMatch(serialized, /Synthetic pilot Company/);
    assert.doesNotMatch(serialized, /publisher-pilot\.example/);
    assert.doesNotMatch(serialized, /releases\/1/);
  });

  it('rejects incomplete provenance and chronology violations before opacity', () => {
    const missing = manifest('missing', 'pilot');
    missing.candidates[0]!.sources[0]!.publisher = '';
    assert.throws(
      () => compileCompanyMonitoringBlindCorpus(missing),
      expectCode('source_publisher_invalid'),
    );

    const lateObservation = manifest('chronology', 'pilot');
    lateObservation.candidates[0]!.sources[0]!.observedAt = '2026-08-12T08:00:01.000Z';
    assert.throws(
      () => compileCompanyMonitoringBlindCorpus(lateObservation),
      expectCode('source_observed_after_collection'),
    );

    const longExcerpt = manifest('excerpt', 'pilot');
    longExcerpt.candidates[0]!.sources[0]!.boundedExcerpt = 'x'.repeat(601);
    assert.throws(
      () => compileCompanyMonitoringBlindCorpus(longExcerpt),
      expectCode('source_excerpt_too_long'),
    );

    const futureOccurrence = manifest('future-occurrence', 'pilot');
    futureOccurrence.candidates[0]!.occurrence.occurredAt = '2026-08-12T08:00:01.000Z';
    assert.throws(
      () => compileCompanyMonitoringBlindCorpus(futureOccurrence),
      expectCode('occurrence_after_collection'),
    );
  });

  it('preserves official day-precision publication and occurrence dates', () => {
    const input = manifest('day-precision', 'tracer_gate') as unknown as Record<string, unknown>;
    const candidates = input.candidates as Array<Record<string, unknown>>;
    const candidate = candidates[0]!;
    const occurrence = candidate.occurrence as Record<string, unknown>;
    const sources = candidate.sources as Array<Record<string, unknown>>;
    occurrence.occurredAt = '2026-08-01';
    occurrence.occurredAtPrecision = 'day';
    sources[0]!.publishedAt = '2026-08-01';
    sources[0]!.publishedAtPrecision = 'day';

    const result = compileCompanyMonitoringBlindCorpus(
      input as unknown as CompanyMonitoringCurationManifest,
    );
    assert.equal(result.corpus.examples.length, 2);

    const invalidDate = structuredClone(input);
    const invalidCandidates = invalidDate.candidates as Array<Record<string, unknown>>;
    const invalidOccurrence = invalidCandidates[0]!.occurrence as Record<string, unknown>;
    invalidOccurrence.occurredAt = '2026-02-30';
    assert.throws(
      () => compileCompanyMonitoringBlindCorpus(
        invalidDate as unknown as CompanyMonitoringCurationManifest,
      ),
      expectCode('occurrence_timestamp_invalid'),
    );
  });

  it('accepts an official government record as primary evidence', () => {
    const input = manifest('government-record', 'pilot') as unknown as Record<string, unknown>;
    const candidates = input.candidates as Array<Record<string, unknown>>;
    const sources = candidates[0]!.sources as Array<Record<string, unknown>>;
    sources[0]!.evidenceAuthority = 'official_government';

    const result = compileCompanyMonitoringBlindCorpus(
      input as unknown as CompanyMonitoringCurationManifest,
    );
    assert.deepEqual(result.summary.evidenceAuthority, {
      official_government: 1,
      independent_news: 1,
    });
  });

  it('counts exclusions without compiling excluded candidates into the corpus', () => {
    const input = manifest('exclusions', 'tracer_gate');
    const excluded = input.candidates[1]!;
    excluded.disposition = 'excluded';
    excluded.exclusionReason = 'not_private';
    excluded.opaqueExampleId = null;

    const result = compileCompanyMonitoringBlindCorpus(input);
    assert.equal(result.corpus.examples.length, 1);
    assert.equal(result.summary.researchedCandidates, 2);
    assert.equal(result.summary.verifiedEvidenceBundles, 1);
    assert.deepEqual(result.summary.exclusions, { not_private: 1 });

    const inheritedKey = manifest('constructor-exclusion', 'tracer_gate');
    inheritedKey.candidates[1]!.disposition = 'excluded';
    inheritedKey.candidates[1]!.exclusionReason = 'constructor';
    inheritedKey.candidates[1]!.opaqueExampleId = null;
    assert.deepEqual(
      compileCompanyMonitoringBlindCorpus(inheritedKey).summary.exclusions,
      { constructor: 1 },
    );
  });

  it('rejects a manifest with no verified evidence bundles', () => {
    const input = manifest('all-excluded', 'pilot');
    for (const candidate of input.candidates) {
      candidate.disposition = 'excluded';
      candidate.exclusionReason = 'not_private';
      candidate.opaqueExampleId = null;
    }
    assert.throws(
      () => compileCompanyMonitoringBlindCorpus(input),
      expectCode('curation_included_candidates_missing'),
    );
  });

  it('rejects pilot and gate overlap on every frozen disjointness dimension', () => {
    const pilot = manifest('pilot-split', 'pilot');
    const tracer = manifest('tracer-split', 'tracer_gate');
    const stage3 = manifest('stage3-split', 'stage3_gate');

    const clean = auditCompanyMonitoringCurationSplit({ pilot, tracer, stage3 });
    assert.deepEqual(clean.counts, { pilot: 2, tracer: 2, stage3: 2 });

    const mutations: Array<{
      code: string;
      mutate: (candidate: CompanyMonitoringCurationManifest['candidates'][number]) => void;
    }> = [
      {
        code: 'curation_split_overlap_occurrence',
        mutate: (candidate) => {
          candidate.occurrence.stableIdentity = pilot.candidates[0]!.occurrence.stableIdentity;
        },
      },
      {
        code: 'curation_split_overlap_content',
        mutate: (candidate) => {
          candidate.sources[0]!.title = pilot.candidates[0]!.sources[0]!.title;
          candidate.sources[0]!.boundedExcerpt = pilot.candidates[0]!.sources[0]!.boundedExcerpt;
        },
      },
      {
        code: 'curation_split_overlap_corporate_family',
        mutate: (candidate) => {
          candidate.company.corporateFamilyIdentity =
            pilot.candidates[0]!.company.corporateFamilyIdentity;
        },
      },
      {
        code: 'curation_split_overlap_source_origin',
        mutate: (candidate) => {
          candidate.sources[0]!.sourceOrigin = pilot.candidates[0]!.sources[0]!.sourceOrigin;
          candidate.sources[0]!.url = 'https://publisher-pilot-split.example/new-event';
        },
      },
    ];

    for (const { code, mutate } of mutations) {
      const overlapping = structuredClone(tracer);
      mutate(overlapping.candidates[0]!);
      assert.throws(
        () => auditCompanyMonitoringCurationSplit({ pilot, tracer: overlapping, stage3 }),
        expectCode(code),
      );
    }
  });

  it('compiles complete sealed labels and keeps customer judgment unknown by default', () => {
    const input = manifest('gold', 'stage3_gate');
    const corpus = compileCompanyMonitoringBlindCorpus(input).corpus;
    const labels: CompanyMonitoringGoldCurationManifest = {
      schemaVersion: 'cm_gold_curation_v1',
      corpusVersion: corpus.corpusVersion,
      goldLabelVersion: 'cm_gold_stage3_v1',
      curatorAccessVersion: versions.curatorAccessVersion,
      labels: corpus.examples.map((example, index) => ({
        opaqueExampleId: example.opaqueExampleId,
        publicationEligible: index === 0,
        goldMateriality: index === 0 ? 'material' : 'immaterial',
        goldDirection: index === 0 ? 'positive' : 'negative',
        customerUseful: null,
      })),
    };

    const gold = compileCompanyMonitoringGoldLabels(input, labels);
    assert.equal(gold.labels.length, 2);
    assert.equal(gold.labels[0]!.customerUseful, null);
    assert.equal(
      gold.labels[0]!.canonicalCorporateFamilyDigest,
      corpus.examples[0]!.corporateFamilyDigest,
    );

    labels.labels.pop();
    assert.throws(
      () => compileCompanyMonitoringGoldLabels(input, labels),
      expectCode('gold_label_coverage_mismatch'),
    );
  });
});

describe('Company Monitoring public-evidence curation CLI', () => {
  it('maps unreadable sealed input to an opaque error code', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'cm-curation-cli-'));
    const input = join(workspace, 'invalid.json');
    writeFileSync(input, '{"legalName":"PRIVATE_LEAK_MARKER"');
    try {
      const result = spawnSync(
        fileURLToPath(new URL('../node_modules/.bin/tsx', import.meta.url)),
        [
          fileURLToPath(new URL('../scripts/company-monitoring-curation.mts', import.meta.url)),
          'audit-manifest',
          input,
        ],
        {
          encoding: 'utf8',
          env: { ...process.env, NODE_NO_WARNINGS: '1' },
        },
      );
      assert.equal(result.status, 1);
      assert.equal(result.stderr, 'curation_input_unreadable\n');
      assert.doesNotMatch(result.stderr, /PRIVATE_LEAK_MARKER/);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
