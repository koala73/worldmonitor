import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

import {
  COMPANY_MONITORING_ADMISSION_POLICY_VERSION,
  COMPANY_MONITORING_CLASSIFICATION_JSON_SCHEMA,
  COMPANY_MONITORING_CLASSIFICATION_SCHEMA_VERSION,
  COMPANY_MONITORING_DEFAULT_CONFIDENCE_FLOORS,
  COMPANY_MONITORING_RETRY_POLICY,
  COMPANY_MONITORING_SOURCE_POLICY_VERSION,
  buildCompanyMonitoringClassificationRequest,
  evaluateCompanyMonitoringClassifierTransportFailure,
  evaluateCompanyMonitoringClassification,
} from "../scripts/lib/company-monitoring-classification.mjs";

type Json = Record<string, any>;

const HOUR_MS = 60 * 60 * 1000;
const MODEL_VERSION = "cm-classifier-model-2026-08-11";

const fixture = JSON.parse(await readFile(
  new URL("./fixtures/company-monitoring-classification/policy-scenarios.json", import.meta.url),
  "utf8",
)) as Json;

function makeEvidence(source: Json, index: number) {
  return {
    ownerAccountId: "account-classification",
    companyId: "company-classification",
    provider: source.provider,
    providerLocator: `provider-locator-${source.id}`,
    providerLocatorHash: `locator-hash-${source.id}`,
    providerOrigin: `provider-origin-${index}`,
    providerOriginFingerprint: source.origin,
    contentFingerprint: `content-${source.id}`,
    evidenceFingerprint: source.id,
    occurrenceDedupeKey: "occurrence-classification",
    matchedClaimIds: [],
    sourceAuthority: source.sourceAuthority,
    independence: source.independence,
    url: `https://example.test/${source.id}`,
    title: `Evidence ${source.id}`,
    text: `Normalized evidence text for ${source.id}.`,
    publishedAt: fixture.firstDiscoveredAt - HOUR_MS,
    observedAt: fixture.firstDiscoveredAt,
    queryVersion: source.queryVersion,
  };
}

function makeCandidate(evidence: Json[], overrides: Json = {}) {
  return {
    ownerAccountId: "account-classification",
    companyId: "company-classification",
    occurrenceDedupeKey: "occurrence-classification",
    state: "pending_classification",
    firstDiscoveredAt: fixture.firstDiscoveredAt,
    firstDiscoveredPath: "exa:locator-hash",
    attemptCount: 0,
    expiresAt: fixture.firstDiscoveredAt + 72 * HOUR_MS,
    observationBlocking: true,
    referenceEvidenceFingerprints: evidence.map((row) => row.evidenceFingerprint),
    referenceCount: evidence.length,
    referencesTruncated: false,
    selectionPolicyVersion: "cm-evidence-selection-v1",
    ...overrides,
  };
}

function makeModelOutput(classification: Json, evidenceIds = classification.evidenceIds) {
  return {
    attribution: {
      truth: classification.attributionTruth,
      confidence: classification.attributionConfidence,
      rationale: "The evidence identifies the monitored legal entity.",
      evidenceIds,
    },
    occurrence: {
      truth: classification.occurrenceTruth,
      confidence: classification.occurrenceConfidence,
      rationale: "The evidence reports whether the event occurred.",
      evidenceIds,
    },
    materiality: {
      truth: classification.materialityTruth,
      confidence: classification.materialityConfidence,
      rationale: "The evidence explains the material company impact.",
      evidenceIds,
    },
    direction: classification.direction,
    channels: classification.channels,
    magnitude: classification.magnitude,
    category: classification.category,
    title: classification.title,
    neutralSummary: classification.neutralSummary,
    positiveRationale: classification.positiveRationale,
    negativeRationale: classification.negativeRationale,
    conflict: classification.conflict,
  };
}

function evaluate(testCase: Json, options: Json = {}) {
  const allEvidence = testCase.evidence.map(makeEvidence);
  const evidence = options.evidence ?? allEvidence;
  const candidate = options.candidate ?? makeCandidate(evidence);
  const modelOutput = Object.hasOwn(options, "modelOutput")
    ? options.modelOutput
    : makeModelOutput(
      testCase.classification,
      evidence.map((row: Json) => row.evidenceFingerprint),
    );
  return evaluateCompanyMonitoringClassification({
    candidate,
    evidence,
    modelOutput,
    now: options.now ?? fixture.firstDiscoveredAt + testCase.nowOffsetHours * HOUR_MS,
    modelVersion: MODEL_VERSION,
  });
}

function scenario(name: string) {
  const found = fixture.cases.find((entry: Json) => entry.name === name);
  assert.ok(found, `missing fixture scenario: ${name}`);
  return found;
}

function expectInvalid(baseCase: Json, mutate: (output: Json) => unknown, reasonCode: string) {
  const evidence = baseCase.evidence.map(makeEvidence);
  const output = makeModelOutput(baseCase.classification);
  const modelOutput = mutate(structuredClone(output));
  let result: Json | undefined;
  assert.doesNotThrow(() => {
    result = evaluate(baseCase, { evidence, modelOutput });
  });
  assert.equal(result?.decision, "reject");
  assert.deepEqual(result?.reasonCodes, [reasonCode]);
  assert.equal(result?.classification, null);
  assert.equal(result?.overallConfidence, null);
  assert.equal(result?.authority, null);
  assert.deepEqual(result?.queryVersions, ["cm-x-query-v1"]);
}

describe("Company Monitoring strict classifier request contract", () => {
  it("pins schema, policy, source, confidence, and retry versions", () => {
    assert.equal(COMPANY_MONITORING_CLASSIFICATION_SCHEMA_VERSION, "cm-classification-schema-v1");
    assert.equal(COMPANY_MONITORING_ADMISSION_POLICY_VERSION, "cm-admission-policy-v1");
    assert.equal(COMPANY_MONITORING_SOURCE_POLICY_VERSION, "cm-source-policy-v1");
    assert.deepEqual(COMPANY_MONITORING_DEFAULT_CONFIDENCE_FLOORS, {
      attribution: 0.9,
      eventTruth: 0.8,
      materialImpact: 0.7,
      overall: "minimum_axis",
    });
    assert.deepEqual(COMPANY_MONITORING_RETRY_POLICY, {
      version: "cm-retry-policy-v1",
      checkpointsMs: [6 * HOUR_MS, 24 * HOUR_MS, 48 * HOUR_MS],
      terminalExpiryMs: 72 * HOUR_MS,
    });
  });

  it("gives the model only delimited candidate data and a strict exact schema, without tools", () => {
    const testCase = fixture.cases[0];
    const evidence = testCase.evidence.map(makeEvidence);
    const candidate = makeCandidate(evidence);
    const request = buildCompanyMonitoringClassificationRequest({
      candidate,
      evidence,
      model: MODEL_VERSION,
    });

    assert.equal(request.model, MODEL_VERSION);
    assert.equal(Object.hasOwn(request, "tools"), false);
    assert.equal(Object.hasOwn(request, "tool_choice"), false);
    assert.equal(request.response_format.type, "json_schema");
    assert.equal(request.response_format.json_schema.strict, true);
    assert.deepEqual(
      request.response_format.json_schema.schema,
      COMPANY_MONITORING_CLASSIFICATION_JSON_SCHEMA,
    );
    assert.equal(COMPANY_MONITORING_CLASSIFICATION_JSON_SCHEMA.additionalProperties, false);
    assert.equal(
      COMPANY_MONITORING_CLASSIFICATION_JSON_SCHEMA.properties.attribution.additionalProperties,
      false,
    );
    const modelKeys = Object.keys(COMPANY_MONITORING_CLASSIFICATION_JSON_SCHEMA.properties);
    for (const forbidden of [
      "sourceAuthority",
      "independence",
      "overallConfidence",
      "thresholds",
      "decision",
      "policyVersion",
      "schemaVersion",
      "sourcePolicyVersion",
      "modelVersion",
      "queryVersion",
      "queryVersions",
    ]) {
      assert.equal(modelKeys.includes(forbidden), false, `model schema must not contain ${forbidden}`);
    }
    assert.match(request.messages[1].content, /^<company_monitoring_candidate_data>\n/);
    assert.match(request.messages[1].content, /\n<\/company_monitoring_candidate_data>$/);
    assert.match(request.messages[1].content, /"queryVersion":"cm-x-query-v1"/);
    assert.doesNotMatch(request.messages[1].content, /<\/company_monitoring_candidate_data>.*Evidence/s);
  });
});

describe("Company Monitoring deterministic admission policy fixtures", () => {
  it("keeps the complete issue-required fixture contract", () => {
    assert.deepEqual(fixture.cases.map((testCase: Json) => testCase.name), [
      "positive contract award publishes from verified first-party X",
      "negative safety incident publishes with two independent origins",
      "mixed restructuring publishes with both rationales",
      "weak X rumor holds",
      "wrong subsidiary rejects",
      "conflicting evidence holds",
      "high-impact weak attribution rejects",
      "held candidate publishes at retry after corroboration",
      "held candidate expires by 72 hours",
    ]);
  });

  for (const testCase of fixture.cases) {
    it(testCase.name, () => {
      if (testCase.initialEvidenceCount) {
        const initialEvidence = testCase.evidence.slice(0, testCase.initialEvidenceCount).map(makeEvidence);
        const initial = evaluate(testCase, {
          evidence: initialEvidence,
          now: fixture.firstDiscoveredAt + HOUR_MS,
        });
        assert.equal(initial.decision, "hold");
        assert.deepEqual(initial.reasonCodes, ["insufficient_source_authority"]);
        assert.equal(initial.retryAt, fixture.firstDiscoveredAt + 6 * HOUR_MS);
      }

      const result = evaluate(testCase);
      assert.equal(result.decision, testCase.expected.decision);
      assert.deepEqual(result.reasonCodes, testCase.expected.reasonCodes);
      assert.equal(result.versions.classificationSchema, COMPANY_MONITORING_CLASSIFICATION_SCHEMA_VERSION);
      assert.equal(result.versions.admissionPolicy, COMPANY_MONITORING_ADMISSION_POLICY_VERSION);
      assert.equal(result.versions.sourcePolicy, COMPANY_MONITORING_SOURCE_POLICY_VERSION);
      assert.equal(result.versions.model, MODEL_VERSION);
      assert.deepEqual(result.queryVersions, [...result.queryVersions].sort());
      assert.equal(result.terminalAt, fixture.firstDiscoveredAt + 72 * HOUR_MS);
      if (result.decision === "publish") assert.equal(result.retryAt, null);
    });
  }

  it("computes overall confidence itself as the minimum axis and sorts mixed query versions", () => {
    const result = evaluate(scenario("negative safety incident publishes with two independent origins"));
    assert.equal(result.overallConfidence, 0.88);
    assert.deepEqual(result.queryVersions, ["cm-exa-query-v2", "cm-exa-query-v3"]);
    assert.deepEqual(result.authority, {
      hasVerifiedFirstPartyPrimary: false,
      independentOriginCount: 2,
      satisfiesAuthority: true,
      qualifyingEvidenceIds: ["e-safety-a", "e-safety-b"],
    });
  });

  it("publishes at all confidence floor boundaries", () => {
    const testCase = scenario("negative safety incident publishes with two independent origins");
    const output = makeModelOutput({
      ...testCase.classification,
      attributionConfidence: 0.9,
      occurrenceConfidence: 0.8,
      materialityConfidence: 0.7,
    });
    const result = evaluate(testCase, { modelOutput: output });
    assert.equal(result.decision, "publish");
    assert.equal(result.overallConfidence, 0.7);
  });

  it("holds valid event and impact scores below their floors", () => {
    const testCase = scenario("negative safety incident publishes with two independent origins");
    const output = makeModelOutput({
      ...testCase.classification,
      occurrenceConfidence: 0.79,
      materialityConfidence: 0.69,
    });
    const result = evaluate(testCase, { modelOutput: output });
    assert.equal(result.decision, "hold");
    assert.deepEqual(result.reasonCodes, [
      "materiality_confidence_below_floor",
      "occurrence_confidence_below_floor",
    ]);
  });

  it("does not count syndicated or unknown copies as independent corroboration", () => {
    const testCase = scenario("negative safety incident publishes with two independent origins");
    const evidence = testCase.evidence.map(makeEvidence).map((row: Json, index: number) => ({
      ...row,
      providerOriginFingerprint: `copy-origin-${index}`,
      independence: index === 0 ? "syndicated" : "unknown",
    }));
    const result = evaluate(testCase, { evidence });
    assert.equal(result.decision, "hold");
    assert.deepEqual(result.reasonCodes, ["insufficient_source_authority"]);
    assert.equal(result.authority.independentOriginCount, 0);
  });

  it("counts independent corroboration only once per provider origin", () => {
    const testCase = scenario("negative safety incident publishes with two independent origins");
    const evidence = testCase.evidence.map(makeEvidence).map((row: Json) => ({
      ...row,
      providerOriginFingerprint: "same-provider-origin",
    }));
    const result = evaluate(testCase, { evidence });
    assert.equal(result.decision, "hold");
    assert.equal(result.authority.independentOriginCount, 1);
  });

  it("derives event authority only from occurrence evidence citations", () => {
    const testCase = scenario("negative safety incident publishes with two independent origins");
    const output = makeModelOutput(testCase.classification);
    output.occurrence.evidenceIds = ["e-safety-a"];
    const result = evaluate(testCase, { modelOutput: output });
    assert.equal(result.decision, "hold");
    assert.deepEqual(result.reasonCodes, ["insufficient_source_authority"]);
    assert.equal(result.authority.independentOriginCount, 1);
    assert.deepEqual(result.authority.qualifyingEvidenceIds, ["e-safety-a"]);
  });

  it("sorts all simultaneous hold reasons stably", () => {
    const testCase = scenario("weak X rumor holds");
    const output = makeModelOutput({
      ...testCase.classification,
      occurrenceTruth: "uncertain",
      occurrenceConfidence: 0.7,
      materialityTruth: "uncertain",
      materialityConfidence: 0.6,
      conflict: true,
    });
    const result = evaluate(testCase, { modelOutput: output });
    assert.deepEqual(result.reasonCodes, [
      "conflicting_evidence",
      "insufficient_source_authority",
      "materiality_confidence_below_floor",
      "materiality_not_confirmed",
      "occurrence_confidence_below_floor",
      "occurrence_not_confirmed",
    ]);
  });

  it("uses the next fixed retry checkpoint and caps it at terminal expiry", () => {
    const testCase = scenario("weak X rumor holds");
    const evidence = testCase.evidence.map(makeEvidence);
    const terminalAt = fixture.firstDiscoveredAt + 72 * HOUR_MS;
    for (const [offset, expected] of [
      [0, 6],
      [6, 24],
      [24, 48],
      [48, 72],
      [60, 72],
    ]) {
      const result = evaluate(testCase, {
        evidence,
        now: fixture.firstDiscoveredAt + offset * HOUR_MS,
      });
      assert.equal(result.retryAt, fixture.firstDiscoveredAt + expected * HOUR_MS);
    }
    const earlyCandidate = makeCandidate(evidence, {
      expiresAt: fixture.firstDiscoveredAt + 50 * HOUR_MS,
    });
    const capped = evaluate(testCase, {
      candidate: earlyCandidate,
      evidence,
      now: fixture.firstDiscoveredAt + 48 * HOUR_MS,
    });
    assert.equal(capped.terminalAt, fixture.firstDiscoveredAt + 50 * HOUR_MS);
    assert.equal(capped.retryAt, fixture.firstDiscoveredAt + 50 * HOUR_MS);
    assert.equal(terminalAt, fixture.firstDiscoveredAt + COMPANY_MONITORING_RETRY_POLICY.terminalExpiryMs);
  });

  it("never publishes an otherwise admitted candidate at or after terminal expiry", () => {
    const testCase = scenario("negative safety incident publishes with two independent origins");
    const result = evaluate(testCase, {
      now: fixture.firstDiscoveredAt + 72 * HOUR_MS,
    });
    assert.equal(result.decision, "expire");
    assert.deepEqual(result.reasonCodes, ["candidate_expired"]);
    assert.equal(result.retryAt, null);
  });

  it("rejects a false occurrence paired with material impact as contradictory", () => {
    const testCase = scenario("positive contract award publishes from verified first-party X");
    const output = makeModelOutput({
      ...testCase.classification,
      occurrenceTruth: "false",
      materialityTruth: "material",
    });
    const result = evaluate(testCase, { modelOutput: output });
    assert.equal(result.decision, "reject");
    assert.deepEqual(result.reasonCodes, ["classification_output_contradictory"]);
    assert.equal(result.classification, null);
  });
});

describe("Company Monitoring classifier transport failure policy", () => {
  it("holds on fixed checkpoints and expires at the terminal boundary", () => {
    const testCase = scenario("positive contract award publishes from verified first-party X");
    const evidence = testCase.evidence.map(makeEvidence);
    const candidate = makeCandidate(evidence);
    for (const [elapsedHours, retryHours] of [[0, 6], [6, 24], [24, 48], [48, 72]]) {
      const result = evaluateCompanyMonitoringClassifierTransportFailure({
        candidate,
        evidence,
        now: fixture.firstDiscoveredAt + elapsedHours * HOUR_MS,
        modelVersion: MODEL_VERSION,
      });
      assert.equal(result.decision, "hold");
      assert.deepEqual(result.reasonCodes, ["classifier_transport_failure"]);
      assert.equal(result.retryAt, fixture.firstDiscoveredAt + retryHours * HOUR_MS);
      assert.equal(result.versions.model, MODEL_VERSION);
      assert.deepEqual(result.queryVersions, ["cm-x-query-v1"]);
    }

    const expired = evaluateCompanyMonitoringClassifierTransportFailure({
      candidate,
      evidence,
      now: fixture.firstDiscoveredAt + 72 * HOUR_MS,
      modelVersion: MODEL_VERSION,
    });
    assert.equal(expired.decision, "expire");
    assert.deepEqual(expired.reasonCodes, [
      "candidate_expired",
      "classifier_transport_failure",
    ]);
    assert.equal(expired.retryAt, null);
  });
});

describe("Company Monitoring untrusted model output", () => {
  const baseCase = scenario("positive contract award publishes from verified first-party X");

  it("rejects malformed, missing, and extra structures without throwing", () => {
    expectInvalid(baseCase, () => "{not-json", "classification_output_malformed_json");
    expectInvalid(baseCase, () => null, "classification_output_not_object");
    expectInvalid(baseCase, (output) => {
      delete output.conflict;
      return output;
    }, "classification_output_missing_key");
    expectInvalid(baseCase, (output) => ({ ...output, decision: "publish" }), "classification_output_extra_key");
  });

  it("rejects invalid confidence numbers and enums", () => {
    expectInvalid(baseCase, (output) => {
      output.attribution.confidence = Number.NaN;
      return output;
    }, "classification_output_non_finite_confidence");
    expectInvalid(baseCase, (output) => {
      output.materiality.confidence = 1.01;
      return output;
    }, "classification_output_confidence_out_of_range");
    expectInvalid(baseCase, (output) => {
      output.direction = "up";
      return output;
    }, "classification_output_invalid_value");
    expectInvalid(baseCase, (output) => {
      output.attribution.truth = "probably";
      return output;
    }, "classification_output_invalid_value");
    expectInvalid(baseCase, (output) => {
      output.channels = ["operations"];
      return output;
    }, "classification_output_invalid_value");
    expectInvalid(baseCase, (output) => {
      output.magnitude = "extreme";
      return output;
    }, "classification_output_invalid_value");
  });

  it("rejects untrimmed, overlong, and contradictory rationales", () => {
    expectInvalid(baseCase, (output) => {
      output.attribution.rationale = " untrimmed";
      return output;
    }, "classification_output_untrimmed_text");
    expectInvalid(baseCase, (output) => {
      output.negativeRationale = "x".repeat(1_001);
      return output;
    }, "classification_output_text_too_long");
    expectInvalid(baseCase, (output) => {
      output.negativeRationale = "This contradicts a positive-only direction.";
      return output;
    }, "classification_output_contradictory");
  });

  it("rejects duplicate, foreign, and missing per-axis evidence IDs", () => {
    expectInvalid(baseCase, (output) => {
      output.attribution.evidenceIds.push(output.attribution.evidenceIds[0]);
      return output;
    }, "classification_output_duplicate_evidence_id");
    expectInvalid(baseCase, (output) => {
      output.occurrence.evidenceIds = ["foreign-evidence"];
      return output;
    }, "classification_output_foreign_evidence_id");
    expectInvalid(baseCase, (output) => {
      output.materiality.evidenceIds = [];
      return output;
    }, "classification_output_missing_axis_evidence");
  });
});
