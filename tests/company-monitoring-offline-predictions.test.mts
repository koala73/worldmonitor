import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import {
  CompanyMonitoringOfflinePredictionError,
  computeOfflineClassifierRuntimeDigest,
  computeOfflineProviderObservationDigest,
  createOfflinePredictionReconciliation,
  createOfflinePredictionBundle,
  createOfflinePredictionRunReceipt,
  runCompanyMonitoringOfflinePredictions,
  validateOfflinePredictionBundle,
  type OfflineProviderObservationManifest,
  type OfflinePredictionCheckpoint,
  type OfflineContinuationAuthorization,
} from '../shared/company-monitoring-offline-predictions.ts';
import {
  compileCompanyMonitoringBlindCorpus,
  computeCompanyMonitoringCurationManifestDigest,
  type CompanyMonitoringCurationManifest,
} from '../shared/company-monitoring-curation.ts';
import {
  asNumber,
  asObject,
  canonicalJson,
  exactBinomialLowerBound,
  exactPoissonRateLowerBound,
  syntheticDigest,
  type JsonObject,
} from '../shared/company-monitoring-evaluation.ts';
import {
  computeBlindCorpusDigest,
  computeExpansionManifestDigest,
  computePredictionSetDigest,
  computeScoreReportDigest,
  type BlindCorpus,
  type ScoreReport,
} from '../shared/company-monitoring-blind-evaluation.ts';

const approvedThresholdDigest = '29ce1d431086f3b7a9a955776f0c2c009d87c809f810f32f8b10aef53f8ecfc2';
const checkpointAuthenticationKey = Buffer.alloc(32, 7).toString('base64');
const bundleKeys = generateKeyPairSync('ed25519');
const bundleSigningPrivateKeyPem = bundleKeys.privateKey.export({
  type: 'pkcs8',
  format: 'pem',
}).toString();
const bundleVerificationPublicKeyPem = bundleKeys.publicKey.export({
  type: 'spki',
  format: 'pem',
}).toString();
const protocol = JSON.parse(readFileSync(
  new URL('./fixtures/company-monitoring-evaluation/protocol.json', import.meta.url),
  'utf8',
)) as JsonObject;

function completeUsefulness(candidate: JsonObject): void {
  const directions = ['positive', 'negative', 'mixed'];
  const impacts = Array.from({ length: 10 }, (_, index) => ({
    impactId: `cm_impact_${(index + 1).toString(16).padStart(12, '0')}`,
    direction: directions[index % directions.length],
  }));
  const labels = (useful: number) => impacts.map((impact, index) => ({
    impactId: impact.impactId,
    useful: index < useful,
  }));
  Object.assign(
    asObject(asObject(candidate.historicalUsefulness, 'usefulness').result, 'result'),
    {
      status: 'complete',
      impactSetId: 'cm_impact_set_000000000001',
      impacts,
      customerJudgments: [
        {
          customerId: 'cm_customer_000000000001',
          externalTargetCustomer: true,
          qualificationEvidenceSha256: syntheticDigest('customer-one'),
          independent: true,
          labels: labels(7),
        },
        {
          customerId: 'cm_customer_000000000002',
          externalTargetCustomer: true,
          qualificationEvidenceSha256: syntheticDigest('customer-two'),
          independent: false,
          labels: labels(8),
        },
      ],
      aggregateEvidenceSha256: syntheticDigest('customer-aggregate'),
    },
  );
}

function continuedProtocol(): JsonObject {
  const candidate = structuredClone(protocol);
  const base = asObject(candidate.baseRate, 'baseRate');
  const baseThresholds = asObject(base.thresholds, 'baseRate.thresholds');
  Object.assign(asObject(base.result, 'baseRate.result'), {
    status: 'complete',
    companyYears: 150,
    materialEventCount: 45,
    pointEstimate: 45 / 150,
    lowerBound: exactPoissonRateLowerBound(
      45,
      150,
      asNumber(baseThresholds.confidenceLevel, 'baseRate confidence'),
    ),
    privateSelectionManifestSha256: syntheticDigest('base-private'),
    aggregateEvidenceSha256: syntheticDigest('base-aggregate'),
  });
  const rediscovery = asObject(candidate.rediscovery, 'rediscovery');
  const rediscoveryThresholds = asObject(rediscovery.thresholds, 'rediscovery.thresholds');
  Object.assign(asObject(rediscovery.result, 'rediscovery.result'), {
    status: 'complete',
    pairCount: 100,
    rediscoveredCount: 70,
    pointEstimate: 0.7,
    lowerBound: exactBinomialLowerBound(
      70,
      100,
      asNumber(rediscoveryThresholds.confidenceLevel, 'rediscovery confidence'),
    ),
    privatePairManifestSha256: syntheticDigest('rediscovery-private'),
    aggregateEvidenceSha256: syntheticDigest('rediscovery-aggregate'),
  });
  completeUsefulness(candidate);
  candidate.firstScoredRunStartedAt = '2026-08-05T00:00:01.000Z';
  const provider = asObject(asObject(candidate.providerPolicy, 'provider').result, 'result');
  provider.status = 'approved';
  Object.assign(asObject(provider.exa, 'exa'), {
    status: 'approved',
    paidRuntimeApprovalEvidenceSha256: syntheticDigest('exa-runtime'),
  });
  Object.assign(asObject(provider.x, 'x'), {
    status: 'approved',
    writtenCommercialUseApprovalEvidenceSha256: syntheticDigest('x-runtime'),
    offlineContentComplianceEnforcedByRuntime: true,
    modelTrainingProhibitionEnforcedByRuntime: true,
  });
  Object.assign(asObject(provider.model, 'model'), {
    status: 'approved',
    zeroDataRetentionEnforcedByRuntime: true,
    noTrainingEnforcedByRuntime: true,
    reasoningDisabledEnforcedByRuntime: true,
    modelAndProviderPinnedByRuntime: true,
  });
  return candidate;
}

function curation(count = 2): CompanyMonitoringCurationManifest {
  return {
    schemaVersion: 'cm_public_evidence_curation_v1',
    collectionVersion: 'cm_collection_offline_v1',
    corpusVersion: 'cm_corpus_offline_v1',
    purpose: 'pilot',
    collectedAt: '2026-08-12T08:00:00.000Z',
    custody: {
      collectorTool: 'test-only',
      collectorModel: 'test-only',
      collectorRunId: 'test-only',
      storageClass: 'sealed_external',
      labelsVisibleToPolicyAuthors: false,
    },
    protocolVersion: 'cm_eval_v1',
    policyVersion: 'cm-admission-policy-v1',
    modelVersion: 'deepseek_v4_flash_digitalocean_v1',
    classifierRuntimeSha256: computeOfflineClassifierRuntimeDigest({
      requestedModel: 'deepseek/deepseek-v4-flash',
      providerRoute: 'digitalocean',
      resolvedProvider: 'DigitalOcean',
    }),
    queryVersion: 'cm_provider_queries_v1',
    curatorAccessVersion: 'cm_curator_access_v1',
    candidates: Array.from({ length: count }, (_, index) => index + 1).map((ordinal) => ({
      candidateId: `candidate_${ordinal}`,
      disposition: 'included' as const,
      exclusionReason: null,
      opaqueExampleId: `cm_example_${ordinal.toString(16).padStart(6, '0')}`,
      company: {
        legalName: `Blind Boundary Company ${ordinal} Ltd`,
        stableIdentity: `company:${ordinal}`,
        corporateFamilyIdentity: `family:${ordinal}`,
        officialDomains: [],
        verifiedXAccountIds: ordinal === 1 ? ['1000000000000000001'] : [],
        geography: 'US' as const,
        privateStatus: 'private' as const,
        privateStatusEvidence: {
          url: `https://registry.example/company/${ordinal}`,
          publisher: 'Registry',
          sourceOrigin: 'registry.example',
          retrievedAt: '2026-08-12T07:30:00.000Z',
        },
      },
      occurrence: {
        stableIdentity: `never-send-occurrence-${ordinal}`,
        occurredAt: `2026-08-${String(ordinal).padStart(2, '0')}T06:00:00.000Z`,
        occurredAtPrecision: 'second' as const,
        geography: 'US' as const,
      },
      primarySourceId: `reference_${ordinal}`,
      sources: [{
        sourceId: `reference_${ordinal}`,
        url: `https://reference.example/private-${ordinal}`,
        publisher: 'Reference Publisher',
        sourceOrigin: 'reference.example',
        title: `Never send reference title ${ordinal}`,
        boundedExcerpt: `Never send sealed curator excerpt ${ordinal}.`,
        publishedAt: `2026-08-${String(ordinal).padStart(2, '0')}T06:30:00.000Z`,
        publishedAtPrecision: 'second' as const,
        observedAt: '2026-08-12T07:00:00.000Z',
        retrievedAt: '2026-08-12T07:30:00.000Z',
        evidenceAuthority: 'independent_news' as const,
        syndication: {
          relationship: 'independent' as const,
          upstreamUrl: null,
          groupIdentity: `reference-family-${ordinal}`,
        },
      }],
    })),
  };
}

function lockedCorpus(input: CompanyMonitoringCurationManifest): BlindCorpus {
  const corpus = compileCompanyMonitoringBlindCorpus(input).corpus;
  return {
    ...corpus,
    status: 'locked',
    lockedAt: '2026-08-12T08:10:00.000Z',
    sealedGoldLabelsSha256: syntheticDigest('sealed-labels'),
  };
}

function observations(corpus: BlindCorpus): OfflineProviderObservationManifest {
  return {
    schemaVersion: 'cm_offline_provider_observations_v1',
    captureVersion: 'cm_capture_v1',
    corpusVersion: corpus.corpusVersion,
    corpusSha256: '',
    curationSha256: '',
    protocolVersion: corpus.protocolVersion,
    policyVersion: corpus.policyVersion,
    modelVersion: corpus.modelVersion,
    queryVersion: corpus.queryVersion,
    capturedAt: '2026-08-12T08:00:00.000Z',
    providerQueryVersions: {
      exa: 'exa-company-discovery-v1',
      x: 'x-company-discovery-v1',
    },
    runtime: {
      requestedModel: 'deepseek/deepseek-v4-flash',
      providerRoute: 'digitalocean',
      resolvedProvider: 'DigitalOcean',
    },
    custody: {
      storageClass: 'sealed_external',
      labelsVisibleToRuntime: false,
      referenceEvidenceVisibleToProviders: false,
    },
    rows: [{
      opaqueExampleId: 'cm_example_000001',
      coverage: { exa: 'complete', x: 'complete' },
      providerReceipts: {
        exa: syntheticDigest('exa-capture-receipt-1'),
        x: syntheticDigest('x-capture-receipt-1'),
      },
      latencyMs: 120,
      costUsd: 0.007,
      evidence: [{
        provider: 'exa',
        providerLocator: 'provider-result-1',
        providerReceiptSha256: syntheticDigest('provider-receipt'),
        queryVersion: 'exa-company-discovery-v1',
        url: 'https://provider-news.example/story-1',
        title: 'Blind Boundary Company 1 Ltd signs a major contract',
        text: 'Blind Boundary Company 1 Ltd signed a material multi-year contract.',
        author: 'Provider News',
        authorAccountId: null,
        officialCompanyDomain: null,
        publisherOrigin: 'provider-news.example',
        syndication: {
          relationship: 'independent',
          upstreamUrl: null,
          groupIdentity: 'provider-news-original-1',
        },
        publishedAt: Date.parse('2026-08-12T07:00:00.000Z'),
        observedAt: Date.parse('2026-08-12T08:00:00.000Z'),
        expiresAt: Date.parse('2026-08-15T08:00:00.000Z'),
        sourceAuthority: 'independent_source',
        verifiedCompany: false,
      }, {
        provider: 'x',
        providerLocator: '2000000000000000001',
        providerReceiptSha256: syntheticDigest('x-provider-receipt'),
        queryVersion: 'x-company-discovery-v1',
        url: 'https://x.com/i/status/2000000000000000001',
        title: null,
        text: 'Blind Boundary Company 1 Ltd signed a material multi-year contract.',
        author: 'blindboundaryco',
        authorAccountId: '1000000000000000001',
        officialCompanyDomain: null,
        publisherOrigin: '1000000000000000001',
        syndication: {
          relationship: 'independent',
          upstreamUrl: null,
          groupIdentity: 'blind-boundary-first-party-1',
        },
        publishedAt: Date.parse('2026-08-12T07:05:00.000Z'),
        observedAt: Date.parse('2026-08-12T08:00:00.000Z'),
        expiresAt: Date.parse('2026-08-15T08:00:00.000Z'),
        sourceAuthority: 'verified_first_party',
        verifiedCompany: true,
      }],
    }, {
      opaqueExampleId: 'cm_example_000002',
      coverage: { exa: 'complete', x: 'not_applicable' },
      providerReceipts: {
        exa: syntheticDigest('exa-capture-receipt-2'),
        x: null,
      },
      latencyMs: 100,
      costUsd: 0.007,
      evidence: [],
    }],
  };
}

async function bundle(count = 2) {
  const curator = curation(count);
  const corpus = lockedCorpus(curator);
  const captured = observations(corpus);
  captured.corpusSha256 = computeBlindCorpusDigest(corpus);
  captured.curationSha256 = computeCompanyMonitoringCurationManifestDigest(curator);
  return { curator, corpus, captured };
}

function modelOutput(evidenceIds: string[]): string {
  const axis = (truth: string, confidence: number) => ({
    truth,
    confidence,
    rationale: 'The provider evidence supports this conclusion.',
    evidenceIds,
  });
  return JSON.stringify({
    attribution: axis('confirmed', 0.99),
    occurrence: axis('confirmed', 0.95),
    materiality: axis('material', 0.9),
    direction: 'positive',
    channels: ['financial'],
    magnitude: 'high',
    category: 'contract',
    title: 'Company signs a major contract',
    neutralSummary: 'The company signed a material multi-year contract.',
    positiveRationale: 'The contract adds material revenue.',
    negativeRationale: '',
    conflict: false,
  });
}

function expectedError(code: string) {
  return (error: unknown) =>
    error instanceof CompanyMonitoringOfflinePredictionError && error.code === code;
}

function runOfflineCli(args: string[]) {
  return spawnSync(
    fileURLToPath(new URL('../node_modules/.bin/tsx', import.meta.url)),
    [fileURLToPath(new URL('../scripts/company-monitoring-offline-predictions.mts', import.meta.url)), ...args],
    {
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH,
        NODE_NO_WARNINGS: '1',
        COMPANY_MONITORING_OFFLINE_CHECKPOINT_HMAC_KEY: checkpointAuthenticationKey,
      },
    },
  );
}

describe('Company Monitoring sealed offline predictions', () => {
  it('stops before classifier access while the approved protocol remains STOP', async () => {
    const { curator, corpus, captured } = await bundle();
    let classifierCalls = 0;
    await assert.rejects(
      runCompanyMonitoringOfflinePredictions({
        protocol,
        approvedThresholdDigest,
        curation: curator,
        expectedCurationSha256: computeCompanyMonitoringCurationManifestDigest(curator),
        corpus,
        observations: captured,
        runtime: captured.runtime,
        checkpointAuthenticationKey,
        classify: async () => {
          classifierCalls += 1;
          throw new Error('must not run');
        },
      }),
      expectedError('offline_runtime_protocol_stop'),
    );
    assert.equal(classifierCalls, 0);
  });

  it('rejects weak checkpoint authentication keys before classifier access', async () => {
    const { curator, corpus, captured } = await bundle();
    let classifierCalls = 0;
    await assert.rejects(
      runCompanyMonitoringOfflinePredictions({
        protocol: continuedProtocol(),
        approvedThresholdDigest,
        curation: curator,
        expectedCurationSha256: computeCompanyMonitoringCurationManifestDigest(curator),
        corpus,
        observations: captured,
        expectedObservationsSha256: computeOfflineProviderObservationDigest(captured, corpus),
        runtime: captured.runtime,
        checkpointAuthenticationKey: 'YQ==',
        classify: async () => {
          classifierCalls += 1;
          throw new Error('must not run');
        },
      }),
      expectedError('offline_checkpoint_authentication_invalid'),
    );
    assert.equal(classifierCalls, 0);
  });

  it('uses only provider observations, applies the merged policy, and emits opaque predictions', async () => {
    const { curator, corpus, captured } = await bundle();
    let classifierInput = '';
    const times = [10, 35];
    const predictions = await runCompanyMonitoringOfflinePredictions({
      protocol: continuedProtocol(),
      approvedThresholdDigest,
      curation: curator,
      expectedCurationSha256: computeCompanyMonitoringCurationManifestDigest(curator),
      corpus,
      observations: captured,
      expectedObservationsSha256: computeOfflineProviderObservationDigest(captured, corpus),
      runtime: captured.runtime,
      checkpointAuthenticationKey,
      monotonicNow: () => times.shift()!,
      classify: async ({ candidate, evidence }) => {
        classifierInput = JSON.stringify({ candidate, evidence });
        return {
          providerResponseId: 'gen-offline-1',
          content: modelOutput(evidence.map((row) => row.evidenceFingerprint)),
          route: {
            resolvedModel: captured.runtime.requestedModel,
            resolvedProvider: 'DigitalOcean',
            configuredProviderRoute: captured.runtime.providerRoute,
          },
          costUsd: 0.001,
        };
      },
    });

    assert.equal(predictions.predictions.length, 2);
    assert.deepEqual(predictions.predictions[0], {
      opaqueExampleId: 'cm_example_000001',
      discovered: true,
      publish: true,
      predictedMateriality: 'material',
      predictedDirection: 'positive',
      attributedCorporateFamilyDigest: corpus.examples[0]!.corporateFamilyDigest,
      confidence: 0.9,
      latencyMs: 145,
      costUsd: 0.008,
    });
    assert.equal(predictions.predictions[1]!.discovered, false);
    assert.equal(predictions.predictions[1]!.publish, false);
    assert.doesNotMatch(classifierInput, /reference\.example|Never send|sealed curator excerpt/);
    assert.doesNotMatch(JSON.stringify(predictions), /Blind Boundary Company|provider-news\.example/);
  });

  it('rejects incomplete coverage, observation reuse, and runtime drift', async () => {
    const { curator, corpus, captured } = await bundle();
    const base = {
      protocol: continuedProtocol(),
      approvedThresholdDigest,
      curation: curator,
      expectedCurationSha256: computeCompanyMonitoringCurationManifestDigest(curator),
      corpus,
      expectedObservationsSha256: computeOfflineProviderObservationDigest(captured, corpus),
      runtime: captured.runtime,
      checkpointAuthenticationKey,
      classify: async () => ({
        providerResponseId: 'gen-offline-2',
        content: '{}',
        route: {
          resolvedModel: captured.runtime.requestedModel,
          resolvedProvider: 'DigitalOcean',
          configuredProviderRoute: captured.runtime.providerRoute,
        },
        costUsd: 0,
      }),
    };

    const incomplete = structuredClone(captured);
    incomplete.rows[0]!.coverage.exa = 'incomplete';
    await assert.rejects(
      runCompanyMonitoringOfflinePredictions({ ...base, observations: incomplete }),
      expectedError('offline_provider_coverage_incomplete'),
    );

    const reused = structuredClone(captured);
    reused.rows[1]!.evidence = [structuredClone(reused.rows[0]!.evidence[0]!)];
    await assert.rejects(
      runCompanyMonitoringOfflinePredictions({ ...base, observations: reused }),
      expectedError('offline_observation_reused'),
    );

    const queryDrift = structuredClone(captured);
    queryDrift.rows[0]!.evidence[0]!.queryVersion = 'exa-company-discovery-v2';
    await assert.rejects(
      runCompanyMonitoringOfflinePredictions({ ...base, observations: queryDrift }),
      expectedError('offline_observation_query_version_mismatch'),
    );

    const lateObservation = structuredClone(captured);
    lateObservation.rows[0]!.evidence[0]!.observedAt = Date.parse('2026-08-12T08:00:01.000Z');
    await assert.rejects(
      runCompanyMonitoringOfflinePredictions({ ...base, observations: lateObservation }),
      expectedError('offline_observation_after_capture'),
    );

    const changedAfterFreeze = structuredClone(captured);
    changedAfterFreeze.rows[0]!.latencyMs += 1;
    let digestMismatchCalls = 0;
    await assert.rejects(
      runCompanyMonitoringOfflinePredictions({
        ...base,
        observations: changedAfterFreeze,
        classify: async () => {
          digestMismatchCalls += 1;
          throw new Error('must not run');
        },
      }),
      expectedError('offline_observation_digest_mismatch'),
    );
    assert.equal(digestMismatchCalls, 0);

    const changedCuration = structuredClone(curator);
    changedCuration.candidates[0]!.company.legalName = 'Changed After Freeze Ltd';
    let curationMismatchCalls = 0;
    await assert.rejects(
      runCompanyMonitoringOfflinePredictions({
        ...base,
        curation: changedCuration,
        classify: async () => {
          curationMismatchCalls += 1;
          throw new Error('must not run');
        },
      }),
      expectedError('offline_curation_digest_mismatch'),
    );
    assert.equal(curationMismatchCalls, 0);

    const missingEmptyReceipt = structuredClone(captured);
    missingEmptyReceipt.rows[1]!.providerReceipts.exa = null;
    await assert.rejects(
      runCompanyMonitoringOfflinePredictions({ ...base, observations: missingEmptyReceipt }),
      expectedError('offline_provider_receipt_invalid'),
    );

    const falseOfficial = structuredClone(captured);
    falseOfficial.rows[0]!.evidence[0]!.sourceAuthority = 'verified_first_party';
    falseOfficial.rows[0]!.evidence[0]!.verifiedCompany = true;
    falseOfficial.rows[0]!.evidence[0]!.officialCompanyDomain = 'company.example';
    await assert.rejects(
      runCompanyMonitoringOfflinePredictions({ ...base, observations: falseOfficial }),
      expectedError('offline_observation_verification_invalid'),
    );

    for (const custody of [
      { ...captured.custody, storageClass: 'repository' },
      { ...captured.custody, labelsVisibleToRuntime: true },
      { ...captured.custody, referenceEvidenceVisibleToProviders: true },
    ]) {
      await assert.rejects(
        runCompanyMonitoringOfflinePredictions({
          ...base,
          observations: { ...captured, custody } as unknown as OfflineProviderObservationManifest,
        }),
        expectedError('offline_custody_boundary_invalid'),
      );
    }

    let mismatchCalls = 0;
    await assert.rejects(
      runCompanyMonitoringOfflinePredictions({
        ...base,
        observations: captured,
        runtime: { ...captured.runtime, providerRoute: 'other-provider' },
        checkpointAuthenticationKey,
        classify: async () => {
          mismatchCalls += 1;
          throw new Error('must not run');
        },
      }),
      expectedError('offline_classifier_configuration_mismatch'),
    );
    assert.equal(mismatchCalls, 0);

    const coherentRuntimeDrift = structuredClone(captured);
    coherentRuntimeDrift.runtime.requestedModel = 'other/provider-model';
    let runtimeDigestCalls = 0;
    await assert.rejects(
      runCompanyMonitoringOfflinePredictions({
        ...base,
        observations: coherentRuntimeDrift,
        expectedObservationsSha256: computeOfflineProviderObservationDigest(
          coherentRuntimeDrift,
          corpus,
        ),
        runtime: coherentRuntimeDrift.runtime,
        classify: async () => {
          runtimeDigestCalls += 1;
          throw new Error('must not run');
        },
      }),
      expectedError('offline_classifier_runtime_digest_mismatch'),
    );
    assert.equal(runtimeDigestCalls, 0);

    const driftCurator = structuredClone(curator);
    driftCurator.classifierRuntimeSha256 = computeOfflineClassifierRuntimeDigest(
      coherentRuntimeDrift.runtime,
    );
    coherentRuntimeDrift.curationSha256 = computeCompanyMonitoringCurationManifestDigest(driftCurator);
    let lockedCorpusRuntimeCalls = 0;
    await assert.rejects(
      runCompanyMonitoringOfflinePredictions({
        ...base,
        curation: driftCurator,
        expectedCurationSha256: coherentRuntimeDrift.curationSha256,
        observations: coherentRuntimeDrift,
        expectedObservationsSha256: computeOfflineProviderObservationDigest(
          coherentRuntimeDrift,
          corpus,
        ),
        runtime: coherentRuntimeDrift.runtime,
        classify: async () => {
          lockedCorpusRuntimeCalls += 1;
          throw new Error('must not run');
        },
      }),
      expectedError('offline_curation_corpus_mismatch'),
    );
    assert.equal(lockedCorpusRuntimeCalls, 0);

    const validResult = {
      providerResponseId: 'gen-offline-3',
      content: modelOutput([]),
      route: {
        resolvedModel: captured.runtime.requestedModel,
        resolvedProvider: captured.runtime.resolvedProvider,
        configuredProviderRoute: captured.runtime.providerRoute,
      },
      costUsd: 0,
    };
    const invalidResults = [
      { ...validResult, route: { ...validResult.route, resolvedModel: 'other/model' } },
      { ...validResult, route: { ...validResult.route, resolvedProvider: 'Other Provider' } },
      { ...validResult, route: { ...validResult.route, configuredProviderRoute: 'other-route' } },
      { ...validResult, costUsd: -1 },
      { ...validResult, costUsd: Number.NaN },
    ];
    for (const result of invalidResults) {
      await assert.rejects(
        runCompanyMonitoringOfflinePredictions({
          ...base,
          observations: captured,
          classify: async ({ evidence }) => ({
            ...result,
            content: modelOutput(evidence.map((row) => row.evidenceFingerprint)),
          }),
        }),
        expectedError('offline_classifier_runtime_mismatch'),
      );
    }
  });

  it('binds a validated sealed observation manifest to a deterministic digest', async () => {
    const { corpus, captured } = await bundle();
    const first = computeOfflineProviderObservationDigest(captured, corpus);
    const second = computeOfflineProviderObservationDigest(structuredClone(captured), corpus);
    assert.match(first, /^[a-f0-9]{64}$/);
    assert.equal(first, second);
  });

  it('binds the prediction output to a versioned sealed run receipt', async () => {
    const { curator, corpus, captured } = await bundle();
    const predictions = await runCompanyMonitoringOfflinePredictions({
      protocol: continuedProtocol(),
      approvedThresholdDigest,
      curation: curator,
      expectedCurationSha256: computeCompanyMonitoringCurationManifestDigest(curator),
      corpus,
      observations: captured,
      expectedObservationsSha256: computeOfflineProviderObservationDigest(captured, corpus),
      runtime: captured.runtime,
      checkpointAuthenticationKey,
      classify: async ({ evidence }) => ({
        providerResponseId: 'gen-offline-4',
        content: modelOutput(evidence.map((row) => row.evidenceFingerprint)),
        route: {
          resolvedModel: captured.runtime.requestedModel,
          resolvedProvider: captured.runtime.resolvedProvider,
          configuredProviderRoute: captured.runtime.providerRoute,
        },
        costUsd: 0,
      }),
    });
    const receipt = createOfflinePredictionRunReceipt({
      protocol: continuedProtocol(),
      approvedThresholdDigest,
      curation: curator,
      corpus,
      observations: captured,
      predictions,
    });

    assert.equal(receipt.curationSha256, computeCompanyMonitoringCurationManifestDigest(curator));
    assert.equal(receipt.approvedThresholdDigest, approvedThresholdDigest);
    assert.match(receipt.protocolSha256, /^[a-f0-9]{64}$/);
    assert.equal(receipt.providerObservationsSha256, computeOfflineProviderObservationDigest(captured, corpus));
    assert.equal(receipt.predictionSetSha256, computePredictionSetDigest(predictions));
    assert.deepEqual(receipt.runtime, captured.runtime);

    const predictionBundle = createOfflinePredictionBundle({
      predictions,
      receipt,
      signingPrivateKeyPem: bundleSigningPrivateKeyPem,
    });
    assert.deepEqual(validateOfflinePredictionBundle({
      bundle: predictionBundle,
      verificationPublicKeyPem: bundleVerificationPublicKeyPem,
      protocol: continuedProtocol(),
      approvedThresholdDigest,
      curation: curator,
      expectedCurationSha256: computeCompanyMonitoringCurationManifestDigest(curator),
      corpus,
      observations: captured,
      expectedObservationsSha256: computeOfflineProviderObservationDigest(captured, corpus),
    }), predictions);
    const forged = structuredClone(predictionBundle);
    forged.receipt.runtime.resolvedProvider = 'Forged Provider';
    assert.throws(
      () => validateOfflinePredictionBundle({
        bundle: forged,
        verificationPublicKeyPem: bundleVerificationPublicKeyPem,
        protocol: continuedProtocol(),
        approvedThresholdDigest,
        curation: curator,
        expectedCurationSha256: computeCompanyMonitoringCurationManifestDigest(curator),
        corpus,
        observations: captured,
        expectedObservationsSha256: computeOfflineProviderObservationDigest(captured, corpus),
      }),
      expectedError('offline_prediction_bundle_invalid'),
    );
    const runtimeDrift = {
      requestedModel: 'other/provider-model',
      providerRoute: captured.runtime.providerRoute,
      resolvedProvider: captured.runtime.resolvedProvider,
    };
    const runtimeDriftCurator = structuredClone(curator);
    runtimeDriftCurator.classifierRuntimeSha256 = computeOfflineClassifierRuntimeDigest(runtimeDrift);
    const runtimeDriftObservations = structuredClone(captured);
    runtimeDriftObservations.runtime = runtimeDrift;
    runtimeDriftObservations.curationSha256 =
      computeCompanyMonitoringCurationManifestDigest(runtimeDriftCurator);
    const runtimeDriftPredictions = structuredClone(predictions);
    runtimeDriftPredictions.classifierRuntimeSha256 = runtimeDriftCurator.classifierRuntimeSha256;
    const runtimeDriftBundle = createOfflinePredictionBundle({
      predictions: runtimeDriftPredictions,
      receipt: {
        ...receipt,
        curationSha256: runtimeDriftObservations.curationSha256,
        providerObservationsSha256: computeOfflineProviderObservationDigest(
          runtimeDriftObservations,
          corpus,
        ),
        predictionSetSha256: computePredictionSetDigest(runtimeDriftPredictions),
        runtime: runtimeDrift,
      },
      signingPrivateKeyPem: bundleSigningPrivateKeyPem,
    });
    assert.throws(
      () => validateOfflinePredictionBundle({
        bundle: runtimeDriftBundle,
        verificationPublicKeyPem: bundleVerificationPublicKeyPem,
        protocol: continuedProtocol(),
        approvedThresholdDigest,
        curation: runtimeDriftCurator,
        expectedCurationSha256: runtimeDriftObservations.curationSha256,
        corpus,
        observations: runtimeDriftObservations,
        expectedObservationsSha256: computeOfflineProviderObservationDigest(
          runtimeDriftObservations,
          corpus,
        ),
      }),
      expectedError('offline_prediction_bundle_invalid'),
    );
    const incompatiblePredictions = structuredClone(predictions);
    incompatiblePredictions.policyVersion = 'cm-admission-policy-v2';
    const incompatibleBundle = createOfflinePredictionBundle({
      predictions: incompatiblePredictions,
      receipt: createOfflinePredictionRunReceipt({
        protocol: continuedProtocol(),
        approvedThresholdDigest,
        curation: curator,
        corpus,
        observations: captured,
        predictions: incompatiblePredictions,
      }),
      signingPrivateKeyPem: bundleSigningPrivateKeyPem,
    });
    assert.throws(
      () => validateOfflinePredictionBundle({
        bundle: incompatibleBundle,
        verificationPublicKeyPem: bundleVerificationPublicKeyPem,
        protocol: continuedProtocol(),
        approvedThresholdDigest,
        curation: curator,
        expectedCurationSha256: computeCompanyMonitoringCurationManifestDigest(curator),
        corpus,
        observations: captured,
        expectedObservationsSha256: computeOfflineProviderObservationDigest(captured, corpus),
      }),
      expectedError('offline_prediction_bundle_invalid'),
    );
    const edited = structuredClone(predictionBundle);
    edited.predictions.predictions[0]!.confidence = 0.01;
    edited.receipt = createOfflinePredictionRunReceipt({
      protocol: continuedProtocol(),
      approvedThresholdDigest,
      curation: curator,
      corpus,
      observations: captured,
      predictions: edited.predictions,
    });
    assert.throws(
      () => validateOfflinePredictionBundle({
        bundle: edited,
        verificationPublicKeyPem: bundleVerificationPublicKeyPem,
        protocol: continuedProtocol(),
        approvedThresholdDigest,
        curation: curator,
        expectedCurationSha256: computeCompanyMonitoringCurationManifestDigest(curator),
        corpus,
        observations: captured,
        expectedObservationsSha256: computeOfflineProviderObservationDigest(captured, corpus),
      }),
      expectedError('offline_prediction_bundle_invalid'),
    );
  });

  it('preserves verified first-party Exa authority only for a bound official domain', async () => {
    const curator = curation();
    const authoritativeSource = curator.candidates[0]!.sources[0]!;
    authoritativeSource.url = 'https://blindboundary.example/material-event';
    authoritativeSource.sourceOrigin = 'blindboundary.example';
    authoritativeSource.evidenceAuthority = 'official_company';
    curator.candidates[0]!.company.officialDomains = ['blindboundary.example'];
    const corpus = lockedCorpus(curator);
    const captured = observations(corpus);
    captured.corpusSha256 = computeBlindCorpusDigest(corpus);
    captured.curationSha256 = computeCompanyMonitoringCurationManifestDigest(curator);
    const exa = captured.rows[0]!.evidence[0]!;
    exa.url = 'https://news.blindboundary.example/material-event';
    exa.publisherOrigin = 'news.blindboundary.example';
    exa.sourceAuthority = 'verified_first_party';
    exa.verifiedCompany = true;
    exa.officialCompanyDomain = 'blindboundary.example';
    let exaAuthority: string | undefined;

    await runCompanyMonitoringOfflinePredictions({
      protocol: continuedProtocol(),
      approvedThresholdDigest,
      curation: curator,
      expectedCurationSha256: computeCompanyMonitoringCurationManifestDigest(curator),
      corpus,
      observations: captured,
      expectedObservationsSha256: computeOfflineProviderObservationDigest(captured, corpus),
      runtime: captured.runtime,
      checkpointAuthenticationKey,
      classify: async ({ evidence }) => {
        exaAuthority = evidence.find((row) => row.provider === 'exa')?.sourceAuthority;
        return {
          providerResponseId: 'gen-offline-5',
          content: modelOutput(evidence.map((row) => row.evidenceFingerprint)),
          route: {
            resolvedModel: captured.runtime.requestedModel,
            resolvedProvider: captured.runtime.resolvedProvider,
            configuredProviderRoute: captured.runtime.providerRoute,
          },
          costUsd: 0,
        };
      },
    });

    assert.equal(exaAuthority, 'verified_first_party');
  });

  it('rejects self-asserted first-party identity without an independent curation binding', async () => {
    const { curator, corpus, captured } = await bundle();
    const exa = captured.rows[0]!.evidence[0]!;
    exa.url = 'https://news.blindboundary.example/material-event';
    exa.publisherOrigin = 'news.blindboundary.example';
    exa.sourceAuthority = 'verified_first_party';
    exa.verifiedCompany = true;
    exa.officialCompanyDomain = 'blindboundary.example';
    let classifierCalls = 0;

    await assert.rejects(
      runCompanyMonitoringOfflinePredictions({
        protocol: continuedProtocol(),
        approvedThresholdDigest,
        curation: curator,
        expectedCurationSha256: computeCompanyMonitoringCurationManifestDigest(curator),
        corpus,
        observations: captured,
        expectedObservationsSha256: computeOfflineProviderObservationDigest(captured, corpus),
        runtime: captured.runtime,
        checkpointAuthenticationKey,
        classify: async () => {
          classifierCalls += 1;
          throw new Error('must not run');
        },
      }),
      expectedError('offline_observation_identity_binding_mismatch'),
    );
    assert.equal(classifierCalls, 0);

    const unverified = await bundle();
    const unverifiedX = unverified.captured.rows[0]!.evidence.find((row) => row.provider === 'x')!;
    unverifiedX.verifiedCompany = false;
    let unverifiedCalls = 0;
    await assert.rejects(
      runCompanyMonitoringOfflinePredictions({
        protocol: continuedProtocol(),
        approvedThresholdDigest,
        curation: unverified.curator,
        expectedCurationSha256: computeCompanyMonitoringCurationManifestDigest(unverified.curator),
        corpus: unverified.corpus,
        observations: unverified.captured,
        expectedObservationsSha256: syntheticDigest('unverified-observations'),
        runtime: unverified.captured.runtime,
        checkpointAuthenticationKey,
        classify: async () => {
          unverifiedCalls += 1;
          throw new Error('must not run');
        },
      }),
      expectedError('offline_observation_verification_invalid'),
    );
    assert.equal(unverifiedCalls, 0);
  });

  it('preserves parent predictions and classifies only a continuation expansion', async () => {
    const parent = await bundle();
    parent.curator.purpose = 'stage3_gate';
    parent.corpus.purpose = 'stage3_gate';
    const childCurator = curation(3);
    childCurator.corpusVersion = 'cm_corpus_offline_v2';
    childCurator.purpose = 'stage3_gate';
    const childCorpus = lockedCorpus(childCurator);
    const expansion = childCorpus.examples.slice(parent.corpus.examples.length);
    parent.corpus.precommittedExpansion = {
      manifestSha256: computeExpansionManifestDigest(expansion),
      exampleCount: expansion.length,
    };
    parent.captured.corpusSha256 = computeBlindCorpusDigest(parent.corpus);
    parent.captured.curationSha256 = computeCompanyMonitoringCurationManifestDigest(parent.curator);
    const parentPredictions = await runCompanyMonitoringOfflinePredictions({
      protocol: continuedProtocol(),
      approvedThresholdDigest,
      curation: parent.curator,
      expectedCurationSha256: computeCompanyMonitoringCurationManifestDigest(parent.curator),
      corpus: parent.corpus,
      observations: parent.captured,
      expectedObservationsSha256: computeOfflineProviderObservationDigest(parent.captured, parent.corpus),
      runtime: parent.captured.runtime,
      checkpointAuthenticationKey,
      classify: async ({ evidence }) => ({
        providerResponseId: 'gen-offline-6',
        content: modelOutput(evidence.map((row) => row.evidenceFingerprint)),
        route: {
          resolvedModel: parent.captured.runtime.requestedModel,
          resolvedProvider: parent.captured.runtime.resolvedProvider,
          configuredProviderRoute: parent.captured.runtime.providerRoute,
        },
        costUsd: 0,
      }),
    });
    const parentCorpusSha256 = computeBlindCorpusDigest(parent.corpus);
    const parentPredictionSetSha256 = computePredictionSetDigest(parentPredictions);
    const parentReport = {
      schemaVersion: 'cm_blind_score_report_v1',
      reportSha256: '',
      outcome: 'incomplete',
      reasons: ['publication_precision_denominator_insufficient'],
      protocol: { version: parent.corpus.protocolVersion, approvedThresholdsSha256: approvedThresholdDigest },
      corpus: {
        version: parent.corpus.corpusVersion,
        sha256: parentCorpusSha256,
        purpose: 'stage3_gate',
        exampleCount: parent.corpus.examples.length,
        parentCorpusVersion: null,
      },
      versions: {
        policyVersion: parent.corpus.policyVersion,
        modelVersion: parent.corpus.modelVersion,
        classifierRuntimeSha256: parent.corpus.classifierRuntimeSha256,
        queryVersion: parent.corpus.queryVersion,
        goldLabelVersion: 'cm_gold_v1',
        curatorAccessVersion: parent.corpus.curatorAccessVersion,
      },
      forecast: {}, observedDenominators: {}, metrics: {}, discovery: {}, customerUsefulness: {},
      confusionMatrices: {}, calibration: {}, latency: {}, cost: {},
      predictionSetSha256: parentPredictionSetSha256,
      goldLabelSetSha256: parent.corpus.sealedGoldLabelsSha256,
    } as unknown as ScoreReport;
    parentReport.reportSha256 = computeScoreReportDigest(parentReport);
    childCorpus.continuation = {
      parentCorpusVersion: parent.corpus.corpusVersion,
      parentCorpusSha256,
      parentReportSha256: parentReport.reportSha256,
      reason: 'denominator_shortfall',
    };
    const childCaptured = observations(childCorpus);
    childCaptured.rows.push({
      opaqueExampleId: 'cm_example_000003',
      coverage: { exa: 'complete', x: 'not_applicable' },
      providerReceipts: { exa: syntheticDigest('exa-capture-receipt-3'), x: null },
      latencyMs: 80,
      costUsd: 0.002,
      evidence: [{
        ...structuredClone(childCaptured.rows[0]!.evidence[0]!),
        providerLocator: 'provider-result-3',
        providerReceiptSha256: syntheticDigest('provider-receipt-3'),
        url: 'https://provider-news.example/story-3',
        title: 'Blind Boundary Company 3 Ltd signs a major contract',
        text: 'Blind Boundary Company 3 Ltd signed a material contract.',
      }],
    });
    childCaptured.corpusSha256 = computeBlindCorpusDigest(childCorpus);
    childCaptured.curationSha256 = computeCompanyMonitoringCurationManifestDigest(childCurator);
    const continuationKeyPair = generateKeyPairSync('ed25519');
    const authorizationBody = {
      schemaVersion: 'cm_offline_continuation_authorization_v1' as const,
      outcome: 'incomplete' as const,
      approvedThresholdDigest,
      parentCorpusSha256,
      parentPredictionSetSha256,
      parentGoldLabelSetSha256: parent.corpus.sealedGoldLabelsSha256!,
      parentReportSha256: parentReport.reportSha256,
      classifierRuntimeSha256: childCurator.classifierRuntimeSha256,
      childCorpusSha256: computeBlindCorpusDigest(childCorpus),
      expansionManifestSha256: parent.corpus.precommittedExpansion!.manifestSha256,
    };
    const signAuthorization = (
      body: Omit<OfflineContinuationAuthorization, 'signatureBase64'>,
    ): OfflineContinuationAuthorization => ({
      ...body,
      signatureBase64: sign(
        null,
        Buffer.from(canonicalJson(body)),
        continuationKeyPair.privateKey,
      ).toString('base64'),
    });
    const authorization = signAuthorization(authorizationBody);
    const continuationPrevious = {
      corpus: parent.corpus,
      expectedCorpusSha256: parentCorpusSha256,
      predictions: parentPredictions,
      expectedPredictionSetSha256: parentPredictionSetSha256,
      report: parentReport,
      expectedReportSha256: parentReport.reportSha256,
      authorization,
      authorizationPublicKeyPem: continuationKeyPair.publicKey.export({
        type: 'spki',
        format: 'pem',
      }).toString(),
    };
    let unauthorizedCalls = 0;
    await assert.rejects(
      runCompanyMonitoringOfflinePredictions({
        protocol: continuedProtocol(),
        approvedThresholdDigest,
        curation: childCurator,
        expectedCurationSha256: computeCompanyMonitoringCurationManifestDigest(childCurator),
        corpus: childCorpus,
        observations: childCaptured,
        expectedObservationsSha256: computeOfflineProviderObservationDigest(childCaptured, childCorpus),
        runtime: childCaptured.runtime,
        checkpointAuthenticationKey,
        previous: {
          ...continuationPrevious,
          authorization: { ...authorization, signatureBase64: Buffer.alloc(64).toString('base64') },
        },
        classify: async () => {
          unauthorizedCalls += 1;
          throw new Error('must not run');
        },
      }),
      expectedError('offline_continuation_authorization_invalid'),
    );
    assert.equal(unauthorizedCalls, 0);
    for (const [field, value] of [
      ['approvedThresholdDigest', syntheticDigest('wrong-threshold')],
      ['parentCorpusSha256', syntheticDigest('wrong-parent-corpus')],
      ['parentPredictionSetSha256', syntheticDigest('wrong-parent-predictions')],
      ['parentGoldLabelSetSha256', syntheticDigest('wrong-parent-gold')],
      ['parentReportSha256', syntheticDigest('wrong-parent-report')],
      ['classifierRuntimeSha256', syntheticDigest('wrong-classifier-runtime')],
      ['childCorpusSha256', syntheticDigest('wrong-child-corpus')],
      ['expansionManifestSha256', syntheticDigest('wrong-expansion')],
    ] as const) {
      let signedFieldCalls = 0;
      const mutatedBody = { ...authorizationBody, [field]: value };
      await assert.rejects(
        runCompanyMonitoringOfflinePredictions({
          protocol: continuedProtocol(),
          approvedThresholdDigest,
          curation: childCurator,
          expectedCurationSha256: computeCompanyMonitoringCurationManifestDigest(childCurator),
          corpus: childCorpus,
          observations: childCaptured,
          expectedObservationsSha256: computeOfflineProviderObservationDigest(childCaptured, childCorpus),
          runtime: childCaptured.runtime,
          checkpointAuthenticationKey,
          previous: {
            ...continuationPrevious,
            authorization: signAuthorization(mutatedBody),
          },
          classify: async () => {
            signedFieldCalls += 1;
            throw new Error('must not run');
          },
        }),
        expectedError('offline_continuation_authorization_invalid'),
      );
      assert.equal(signedFieldCalls, 0, `${field} must fail before classification`);
    }
    const assertContinuationFailure = async ({
      curator,
      corpus,
      captured,
      previous = continuationPrevious,
      code,
    }: {
      curator: CompanyMonitoringCurationManifest;
      corpus: BlindCorpus;
      captured: OfflineProviderObservationManifest;
      previous?: typeof continuationPrevious;
      code: string;
    }) => {
      let calls = 0;
      await assert.rejects(
        runCompanyMonitoringOfflinePredictions({
          protocol: continuedProtocol(),
          approvedThresholdDigest,
          curation: curator,
          expectedCurationSha256: computeCompanyMonitoringCurationManifestDigest(curator),
          corpus,
          observations: captured,
          expectedObservationsSha256: computeOfflineProviderObservationDigest(captured, corpus),
          runtime: captured.runtime,
          checkpointAuthenticationKey,
          previous,
          classify: async () => {
            calls += 1;
            throw new Error('must not run');
          },
        }),
        expectedError(code),
      );
      assert.equal(calls, 0, `${code} must fail before classification`);
    };
    const continuationVariant = (
      curator: CompanyMonitoringCurationManifest,
    ): { corpus: BlindCorpus; captured: OfflineProviderObservationManifest } => {
      const corpus = lockedCorpus(curator);
      corpus.continuation = structuredClone(childCorpus.continuation);
      const captured = structuredClone(childCaptured);
      captured.corpusVersion = corpus.corpusVersion;
      captured.protocolVersion = corpus.protocolVersion;
      captured.policyVersion = corpus.policyVersion;
      captured.modelVersion = corpus.modelVersion;
      captured.queryVersion = corpus.queryVersion;
      captured.corpusSha256 = computeBlindCorpusDigest(corpus);
      captured.curationSha256 = computeCompanyMonitoringCurationManifestDigest(curator);
      return { corpus, captured };
    };

    const versionCurator = structuredClone(childCurator);
    versionCurator.modelVersion = 'deepseek_v4_flash_digitalocean_v2';
    const versionVariant = continuationVariant(versionCurator);
    await assertContinuationFailure({
      curator: versionCurator,
      ...versionVariant,
      code: 'offline_continuation_version_mismatch',
    });

    const runtimeDriftCurator = structuredClone(childCurator);
    const runtimeDrift = {
      requestedModel: 'other/provider-model',
      providerRoute: 'other-route',
      resolvedProvider: 'Other Provider',
    };
    runtimeDriftCurator.classifierRuntimeSha256 =
      computeOfflineClassifierRuntimeDigest(runtimeDrift);
    const runtimeDriftCorpus = structuredClone(childCorpus);
    const runtimeDriftCaptured = structuredClone(childCaptured);
    runtimeDriftCaptured.runtime = runtimeDrift;
    runtimeDriftCaptured.curationSha256 =
      computeCompanyMonitoringCurationManifestDigest(runtimeDriftCurator);
    await assertContinuationFailure({
      curator: runtimeDriftCurator,
      corpus: runtimeDriftCorpus,
      captured: runtimeDriftCaptured,
      previous: {
        ...continuationPrevious,
        authorization: signAuthorization({
          ...authorizationBody,
          classifierRuntimeSha256: runtimeDriftCurator.classifierRuntimeSha256,
        }),
      },
      code: 'offline_continuation_classifier_runtime_mismatch',
    });

    const parentMismatchCorpus = structuredClone(childCorpus);
    parentMismatchCorpus.continuation!.parentReportSha256 = syntheticDigest('wrong-parent-report');
    const parentMismatchCaptured = structuredClone(childCaptured);
    parentMismatchCaptured.corpusSha256 = computeBlindCorpusDigest(parentMismatchCorpus);
    await assertContinuationFailure({
      curator: childCurator,
      corpus: parentMismatchCorpus,
      captured: parentMismatchCaptured,
      code: 'offline_continuation_parent_mismatch',
    });

    const prefixCurator = structuredClone(childCurator);
    prefixCurator.candidates[0]!.occurrence.stableIdentity = 'changed-parent-prefix';
    const prefixVariant = continuationVariant(prefixCurator);
    await assertContinuationFailure({
      curator: prefixCurator,
      ...prefixVariant,
      code: 'offline_continuation_changed_example',
    });

    const expansionCurator = structuredClone(childCurator);
    expansionCurator.candidates[2]!.occurrence.stableIdentity = 'changed-expansion';
    const expansionVariant = continuationVariant(expansionCurator);
    await assertContinuationFailure({
      curator: expansionCurator,
      ...expansionVariant,
      code: 'offline_continuation_expansion_mismatch',
    });

    const invalidPreviousPredictions = structuredClone(parentPredictions);
    invalidPreviousPredictions.policyVersion = 'cm-admission-policy-v2';
    const invalidPreviousPredictionSetSha256 = computePredictionSetDigest(invalidPreviousPredictions);
    const invalidPreviousReport = structuredClone(parentReport);
    invalidPreviousReport.predictionSetSha256 = invalidPreviousPredictionSetSha256;
    invalidPreviousReport.reportSha256 = computeScoreReportDigest(invalidPreviousReport);
    const invalidPreviousChildCorpus = structuredClone(childCorpus);
    invalidPreviousChildCorpus.continuation!.parentReportSha256 = invalidPreviousReport.reportSha256;
    const invalidPreviousCaptured = structuredClone(childCaptured);
    invalidPreviousCaptured.corpusSha256 = computeBlindCorpusDigest(invalidPreviousChildCorpus);
    const invalidPreviousAuthorizationBody = {
      ...authorizationBody,
      parentPredictionSetSha256: invalidPreviousPredictionSetSha256,
      parentReportSha256: invalidPreviousReport.reportSha256,
      childCorpusSha256: computeBlindCorpusDigest(invalidPreviousChildCorpus),
    };
    await assertContinuationFailure({
      curator: childCurator,
      corpus: invalidPreviousChildCorpus,
      captured: invalidPreviousCaptured,
      previous: {
        ...continuationPrevious,
        predictions: invalidPreviousPredictions,
        expectedPredictionSetSha256: invalidPreviousPredictionSetSha256,
        report: invalidPreviousReport,
        expectedReportSha256: invalidPreviousReport.reportSha256,
        authorization: signAuthorization(invalidPreviousAuthorizationBody),
      },
      code: 'offline_previous_predictions_mismatch',
    });
    let classifierCalls = 0;
    const childPredictions = await runCompanyMonitoringOfflinePredictions({
      protocol: continuedProtocol(),
      approvedThresholdDigest,
      curation: childCurator,
      expectedCurationSha256: computeCompanyMonitoringCurationManifestDigest(childCurator),
      corpus: childCorpus,
      observations: childCaptured,
      expectedObservationsSha256: computeOfflineProviderObservationDigest(childCaptured, childCorpus),
      runtime: childCaptured.runtime,
      checkpointAuthenticationKey,
      previous: continuationPrevious,
      classify: async ({ evidence }) => {
        classifierCalls += 1;
        return {
          providerResponseId: 'gen-offline-7',
          content: modelOutput(evidence.map((row) => row.evidenceFingerprint)),
          route: {
            resolvedModel: childCaptured.runtime.requestedModel,
            resolvedProvider: childCaptured.runtime.resolvedProvider,
            configuredProviderRoute: childCaptured.runtime.providerRoute,
          },
          costUsd: 0,
        };
      },
    });

    assert.equal(classifierCalls, 1);
    assert.deepEqual(childPredictions.predictions.slice(0, 2), parentPredictions.predictions);
    assert.equal(childPredictions.parentPredictionSetSha256, parentPredictionSetSha256);
    assert.equal(childPredictions.parentGoldLabelSetSha256, parent.corpus.sealedGoldLabelsSha256);
  });

  it('bounds concurrent classifications and retains opaque corpus order', async () => {
    const { curator, corpus, captured } = await bundle(6);
    const template = captured.rows[0]!.evidence[0]!;
    captured.rows = corpus.examples.map((example, index) => ({
      opaqueExampleId: example.opaqueExampleId,
      coverage: { exa: 'complete', x: 'not_applicable' },
      providerReceipts: {
        exa: syntheticDigest(`exa-capture-receipt-${index + 1}`),
        x: null,
      },
      latencyMs: 0,
      costUsd: 0,
      evidence: [{
        ...template,
        providerLocator: `provider-result-${index + 1}`,
        url: `https://provider-news.example/story-${index + 1}`,
        title: `Blind Boundary Company ${index + 1} Ltd signs a major contract`,
        text: `Blind Boundary Company ${index + 1} Ltd signed a material contract.`,
      }],
    }));

    let active = 0;
    let maximumActive = 0;
    let releaseInitialBatch!: () => void;
    const initialBatch = new Promise<void>((resolve) => { releaseInitialBatch = resolve; });
    const result = await runCompanyMonitoringOfflinePredictions({
      protocol: continuedProtocol(),
      approvedThresholdDigest,
      curation: curator,
      expectedCurationSha256: computeCompanyMonitoringCurationManifestDigest(curator),
      corpus,
      observations: captured,
      expectedObservationsSha256: computeOfflineProviderObservationDigest(captured, corpus),
      runtime: captured.runtime,
      checkpointAuthenticationKey,
      classify: async ({ evidence }) => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        if (active === 4) releaseInitialBatch();
        await Promise.race([
          initialBatch,
          new Promise((resolve) => setTimeout(resolve, 500)),
        ]);
        active -= 1;
        return {
          providerResponseId: 'gen-offline-8',
          content: modelOutput(evidence.map((row) => row.evidenceFingerprint)),
          route: {
            resolvedModel: captured.runtime.requestedModel,
            resolvedProvider: captured.runtime.resolvedProvider,
            configuredProviderRoute: captured.runtime.providerRoute,
          },
          costUsd: 0,
        };
      },
    });

    assert.equal(maximumActive, 4);
    assert.deepEqual(
      result.predictions.map((prediction) => prediction.opaqueExampleId),
      [...corpus.examples.map((example) => example.opaqueExampleId)].sort(),
    );
  });

  it('resumes from anchored checkpoints after a late concurrent failure', async () => {
    const { curator, corpus, captured } = await bundle(6);
    const template = captured.rows[0]!.evidence[0]!;
    captured.rows = corpus.examples.map((example, index) => ({
      opaqueExampleId: example.opaqueExampleId,
      coverage: { exa: 'complete' as const, x: 'not_applicable' as const },
      providerReceipts: {
        exa: syntheticDigest(`resume-capture-receipt-${index + 1}`),
        x: null,
      },
      latencyMs: 0,
      costUsd: 0,
      evidence: [{
        ...template,
        providerLocator: `resume-provider-result-${index + 1}`,
        url: `https://provider-news.example/resume-${index + 1}`,
        title: `Blind Boundary Company ${index + 1} Ltd signs a major contract`,
        text: `Blind Boundary Company ${index + 1} Ltd signed a material contract.`,
      }],
    }));
    const anchors = {
      protocol: continuedProtocol(),
      approvedThresholdDigest,
      curation: curator,
      expectedCurationSha256: computeCompanyMonitoringCurationManifestDigest(curator),
      corpus,
      observations: captured,
      expectedObservationsSha256: computeOfflineProviderObservationDigest(captured, corpus),
      runtime: captured.runtime,
      checkpointAuthenticationKey,
    };
    const checkpoints: OfflinePredictionCheckpoint[] = [];
    await assert.rejects(runCompanyMonitoringOfflinePredictions({
      ...anchors,
      onCheckpoint: (checkpoint) => { checkpoints.push(checkpoint); },
      classify: async ({ candidate, evidence }) => {
        if (candidate.companyId.endsWith('000003')) throw new Error('injected late failure');
        return {
          providerResponseId: `gen-offline-${candidate.companyId}`,
          content: modelOutput(evidence.map((row) => row.evidenceFingerprint)),
          route: {
            resolvedModel: captured.runtime.requestedModel,
            resolvedProvider: captured.runtime.resolvedProvider,
            configuredProviderRoute: captured.runtime.providerRoute,
          },
          costUsd: 0,
        };
      },
    }), /injected late failure/);
    assert.ok(checkpoints.length > 0);

    const completed = checkpoints.filter((checkpoint) => checkpoint.state === 'completed');
    assert.ok(completed.length > 0);
    const tampered = structuredClone(completed);
    tampered[0]!.prediction!.confidence = 0;
    await assert.rejects(
      runCompanyMonitoringOfflinePredictions({
        ...anchors,
        checkpoints: tampered,
        checkpointAuthenticationKey,
        classify: async () => { throw new Error('must not run'); },
      }),
      expectedError('offline_checkpoint_authentication_invalid'),
    );
    let resumedCalls = 0;
    await assert.rejects(
      runCompanyMonitoringOfflinePredictions({
        ...anchors,
        checkpoints,
        classify: async () => {
          resumedCalls += 1;
          throw new Error('must not run before reconciliation');
        },
      }),
      expectedError('offline_checkpoint_reconciliation_required'),
    );
    assert.equal(resumedCalls, 0);
  });

  it('reconciles one provider-accepted attempt without issuing a second request', async () => {
    const curator = curation(1);
    const corpus = lockedCorpus(curator);
    const captured = observations(corpus);
    captured.rows = captured.rows.slice(0, 1);
    captured.corpusSha256 = computeBlindCorpusDigest(corpus);
    captured.curationSha256 = computeCompanyMonitoringCurationManifestDigest(curator);
    const anchors = {
      protocol: continuedProtocol(),
      approvedThresholdDigest,
      curation: curator,
      expectedCurationSha256: computeCompanyMonitoringCurationManifestDigest(curator),
      corpus,
      observations: captured,
      expectedObservationsSha256: computeOfflineProviderObservationDigest(captured, corpus),
      runtime: captured.runtime,
      checkpointAuthenticationKey,
    };
    const checkpoints: OfflinePredictionCheckpoint[] = [];
    let requestAttemptId = '';
    await assert.rejects(
      runCompanyMonitoringOfflinePredictions({
        ...anchors,
        createAttemptId: () => 'cm_attempt_00000000-0000-4000-8000-000000000001',
        onCheckpoint: (checkpoint) => { checkpoints.push(checkpoint); },
        classify: async ({ attemptId }) => {
          requestAttemptId = attemptId;
          throw new Error('response lost after provider acceptance');
        },
      }),
      /response lost after provider acceptance/,
    );
    const started = checkpoints.find((checkpoint) => checkpoint.state === 'started');
    assert.ok(started);
    assert.equal(started.attemptId, requestAttemptId);

    const retainedProviderResponse = {
      schemaVersion: 'cm_offline_retained_provider_response_v1' as const,
      attemptId: started.attemptId,
      providerResponseId: 'gen-recovered-provider-response',
      providerLatencyMs: 345,
      response: {},
    };
    const providerResponseSha256 = createHash('sha256')
      .update(canonicalJson(retainedProviderResponse))
      .digest('hex');
    const reconciliation = createOfflinePredictionReconciliation({
      checkpoint: started,
      retainedProviderResponse,
      providerResponseSha256,
      classification: {
        providerResponseId: retainedProviderResponse.providerResponseId,
        content: modelOutput([]),
        route: {
          resolvedModel: captured.runtime.requestedModel,
          resolvedProvider: captured.runtime.resolvedProvider,
          configuredProviderRoute: captured.runtime.providerRoute,
        },
        costUsd: 0.001,
      },
      checkpointAuthenticationKey,
    });
    assert.throws(
      () => createOfflinePredictionReconciliation({
        checkpoint: started,
        retainedProviderResponse,
        providerResponseSha256: syntheticDigest('substituted-retained-response'),
        classification: reconciliation.classification,
        checkpointAuthenticationKey,
      }),
      expectedError('offline_retained_provider_response_digest_mismatch'),
    );
    assert.throws(
      () => createOfflinePredictionReconciliation({
        checkpoint: started,
        retainedProviderResponse,
        providerResponseSha256,
        classification: {
          ...reconciliation.classification,
          providerResponseId: 'gen-substituted-provider-response',
        },
        checkpointAuthenticationKey,
      }),
      expectedError('offline_reconciliation_checkpoint_invalid'),
    );
    const tamperedReconciliation = structuredClone(reconciliation);
    tamperedReconciliation.classification.content = '{}';
    await assert.rejects(
      runCompanyMonitoringOfflinePredictions({
        ...anchors,
        checkpoints,
        reconciliations: [tamperedReconciliation],
        classify: async () => { throw new Error('must not run'); },
      }),
      expectedError('offline_checkpoint_authentication_invalid'),
    );
    let orphanCalls = 0;
    await assert.rejects(
      runCompanyMonitoringOfflinePredictions({
        ...anchors,
        reconciliations: [reconciliation],
        classify: async () => {
          orphanCalls += 1;
          throw new Error('must not accept an orphan reconciliation');
        },
      }),
      expectedError('offline_reconciliation_checkpoint_invalid'),
    );
    assert.equal(orphanCalls, 0);

    let replayCalls = 0;
    const result = await runCompanyMonitoringOfflinePredictions({
      ...anchors,
      checkpoints,
      reconciliations: [reconciliation],
      classify: async () => {
        replayCalls += 1;
        throw new Error('must not replay a reconciled provider attempt');
      },
    });
    assert.equal(replayCalls, 0);
    assert.equal(result.predictions.length, 1);
    assert.equal(result.predictions[0]!.latencyMs, captured.rows[0]!.latencyMs + 345);

    const otherAttemptCheckpoints: OfflinePredictionCheckpoint[] = [];
    await runCompanyMonitoringOfflinePredictions({
      ...anchors,
      createAttemptId: () => 'cm_attempt_00000000-0000-4000-8000-000000000009',
      onCheckpoint: (checkpoint) => { otherAttemptCheckpoints.push(checkpoint); },
      classify: async () => reconciliation.classification,
    });
    const otherCompleted = otherAttemptCheckpoints.find((checkpoint) => checkpoint.state === 'completed');
    assert.ok(otherCompleted);
    await assert.rejects(
      runCompanyMonitoringOfflinePredictions({
        ...anchors,
        checkpoints: [started, otherCompleted],
        classify: async () => { throw new Error('must not run'); },
      }),
      expectedError('offline_checkpoint_attempt_mismatch'),
    );
  });

  it('exits the run command before credentials or sealed inputs while the protocol remains STOP', () => {
    const result = spawnSync(
      fileURLToPath(new URL('../node_modules/.bin/tsx', import.meta.url)),
      [
        fileURLToPath(new URL('../scripts/company-monitoring-offline-predictions.mts', import.meta.url)),
        'run',
        '--protocol',
        fileURLToPath(new URL('./fixtures/company-monitoring-evaluation/protocol.json', import.meta.url)),
        '--approved-threshold-digest',
        approvedThresholdDigest,
        '--curation',
        '/sealed/not-readable-curation.json',
        '--corpus',
        '/sealed/not-readable-corpus.json',
        '--observations',
        '/sealed/not-readable-observations.json',
      ],
      {
        encoding: 'utf8',
        env: {
          PATH: process.env.PATH,
          NODE_NO_WARNINGS: '1',
          COMPANY_MONITORING_CLASSIFIER_MODEL: '',
          COMPANY_MONITORING_CLASSIFIER_PROVIDER_ROUTE: '',
          OPENROUTER_API_KEY: '',
        },
      },
    );
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'offline_runtime_protocol_stop\n');
  });

  it('executes the sealed preflight, digest, reconcile, and extraction CLI paths', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'cm-offline-cli-'));
    try {
      const curator = curation(1);
      const corpus = lockedCorpus(curator);
      const captured = observations(corpus);
      captured.rows = captured.rows.slice(0, 1);
      captured.corpusSha256 = computeBlindCorpusDigest(corpus);
      captured.curationSha256 = computeCompanyMonitoringCurationManifestDigest(curator);
      const continued = continuedProtocol();
      const paths = Object.fromEntries([
        'protocol', 'curation', 'corpus', 'observations', 'bundle', 'public-key',
        'predictions', 'checkpoint', 'provider-response', 'reconciliation',
      ].map((name) => [name, join(directory, `${name}.json`)]));
      writeFileSync(paths.protocol!, canonicalJson(continued));
      writeFileSync(paths.curation!, canonicalJson(curator));
      writeFileSync(paths.corpus!, canonicalJson(corpus));
      writeFileSync(paths.observations!, canonicalJson(captured));

      const preflight = runOfflineCli([
        'preflight', '--protocol', paths.protocol!,
        '--approved-threshold-digest', approvedThresholdDigest,
      ]);
      assert.equal(preflight.status, 0, preflight.stderr);
      assert.equal(preflight.stdout, '{"status":"continue"}\n');

      const observationDigest = computeOfflineProviderObservationDigest(captured, corpus);
      const digest = runOfflineCli([
        'digest-observations', '--corpus', paths.corpus!, '--observations', paths.observations!,
      ]);
      assert.equal(digest.status, 0, digest.stderr);
      assert.equal(digest.stdout, `${observationDigest}\n`);

      const checkpoints: OfflinePredictionCheckpoint[] = [];
      await assert.rejects(runCompanyMonitoringOfflinePredictions({
        protocol: continued,
        approvedThresholdDigest,
        curation: curator,
        expectedCurationSha256: captured.curationSha256,
        corpus,
        observations: captured,
        expectedObservationsSha256: observationDigest,
        runtime: captured.runtime,
        checkpointAuthenticationKey,
        createAttemptId: () => 'cm_attempt_00000000-0000-4000-8000-000000000002',
        onCheckpoint: (checkpoint) => { checkpoints.push(checkpoint); },
        classify: async () => { throw new Error('response lost'); },
      }), /response lost/);
      const started = checkpoints.find((checkpoint) => checkpoint.state === 'started')!;
      writeFileSync(paths.checkpoint!, canonicalJson(started));
      const retainedProviderResponse = {
        schemaVersion: 'cm_offline_retained_provider_response_v1',
        attemptId: started.attemptId,
        providerResponseId: 'gen-cli-recovered-response',
        providerLatencyMs: 678,
        response: {
          id: 'gen-cli-recovered-response',
          model: captured.runtime.requestedModel,
          provider: captured.runtime.resolvedProvider,
          usage: { cost: 0.001 },
          openrouter_metadata: {
            requested: captured.runtime.requestedModel,
            strategy: 'direct',
            attempt: 1,
            endpoints: {
              total: 1,
              available: [{
                provider: captured.runtime.resolvedProvider,
                model: captured.runtime.requestedModel,
                selected: true,
              }],
            },
            attempts: [{
              provider: captured.runtime.resolvedProvider,
              model: captured.runtime.requestedModel,
              status: 200,
            }],
            pipeline: [],
          },
          choices: [{
            finish_reason: 'stop',
            message: { role: 'assistant', content: modelOutput([]) },
          }],
        },
      };
      writeFileSync(paths['provider-response']!, canonicalJson(retainedProviderResponse));
      const providerResponseSha256 = createHash('sha256')
        .update(canonicalJson(retainedProviderResponse))
        .digest('hex');
      const rejectedReconcile = runOfflineCli([
        'reconcile', '--checkpoint', paths.checkpoint!,
        '--retained-provider-response', paths['provider-response']!,
        '--expected-provider-response-digest', syntheticDigest('wrong-provider-response'),
        '--output', paths.reconciliation!,
      ]);
      assert.equal(rejectedReconcile.status, 1);
      assert.match(rejectedReconcile.stderr, /offline_retained_provider_response_digest_mismatch/);
      const reconcile = runOfflineCli([
        'reconcile', '--checkpoint', paths.checkpoint!,
        '--retained-provider-response', paths['provider-response']!,
        '--expected-provider-response-digest', providerResponseSha256,
        '--output', paths.reconciliation!,
      ]);
      assert.equal(reconcile.status, 0, reconcile.stderr);
      const reconciliation = JSON.parse(readFileSync(paths.reconciliation!, 'utf8'));
      assert.equal(reconciliation.attemptId, started.attemptId);
      assert.equal(reconciliation.providerResponseSha256, providerResponseSha256);
      assert.match(reconciliation.authenticationSha256, /^[a-f0-9]{64}$/);

      const predictions = await runCompanyMonitoringOfflinePredictions({
        protocol: continued,
        approvedThresholdDigest,
        curation: curator,
        expectedCurationSha256: captured.curationSha256,
        corpus,
        observations: captured,
        expectedObservationsSha256: observationDigest,
        runtime: captured.runtime,
        checkpointAuthenticationKey,
        checkpoints: [started],
        reconciliations: [reconciliation],
        classify: async () => { throw new Error('must not replay'); },
      });
      const receipt = createOfflinePredictionRunReceipt({
        protocol: continued,
        approvedThresholdDigest,
        curation: curator,
        corpus,
        observations: captured,
        predictions,
      });
      writeFileSync(paths.bundle!, canonicalJson(createOfflinePredictionBundle({
        predictions,
        receipt,
        signingPrivateKeyPem: bundleSigningPrivateKeyPem,
      })));
      writeFileSync(paths['public-key']!, bundleVerificationPublicKeyPem);
      const extract = runOfflineCli([
        'extract-predictions', '--bundle', paths.bundle!,
        '--bundle-verification-public-key', paths['public-key']!,
        '--protocol', paths.protocol!, '--approved-threshold-digest', approvedThresholdDigest,
        '--curation', paths.curation!, '--expected-curation-digest', captured.curationSha256,
        '--corpus', paths.corpus!, '--observations', paths.observations!,
        '--expected-observations-digest', observationDigest, '--output', paths.predictions!,
      ]);
      assert.equal(extract.status, 0, extract.stderr);
      assert.deepEqual(JSON.parse(readFileSync(paths.predictions!, 'utf8')), predictions);
      const noOverwrite = runOfflineCli([
        'extract-predictions', '--bundle', paths.bundle!,
        '--bundle-verification-public-key', paths['public-key']!,
        '--protocol', paths.protocol!, '--approved-threshold-digest', approvedThresholdDigest,
        '--curation', paths.curation!, '--expected-curation-digest', captured.curationSha256,
        '--corpus', paths.corpus!, '--observations', paths.observations!,
        '--expected-observations-digest', observationDigest, '--output', paths.predictions!,
      ]);
      assert.equal(noOverwrite.status, 1);
      assert.equal(noOverwrite.stderr, 'offline_output_write_failed\n');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
