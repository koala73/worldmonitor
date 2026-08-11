import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

import {
  COMPANY_MONITORING_EVIDENCE_POLICY,
  normalizeCompanyEvidence,
} from "../shared/company-monitoring-evidence";

type Json = Record<string, any>;

const fixture = JSON.parse(await readFile(
  new URL("./fixtures/company-monitoring-evidence/golden.json", import.meta.url),
  "utf8",
)) as Json;

function evidenceRows(testCase: Json) {
  if (Array.isArray(testCase.evidence)) return testCase.evidence;
  const template = testCase.evidenceTemplate;
  return Array.from({ length: template.replicas }, (_, index) => {
    const suffix = String(index).padStart(2, "0");
    return {
      provider: template.provider,
      providerLocator: `${template.providerLocatorPrefix}${suffix}`,
      url: `${template.urlPrefix}${suffix}${template.urlSuffix}`,
      title: template.title,
      publishedAt: template.publishedAt + index,
      observedAt: template.observedAt,
      candidateCompanyIds: template.candidateCompanyIds,
      sourceAuthority: template.sourceAuthority,
    };
  });
}

describe("Company Monitoring normalized evidence golden contract", () => {
  it("pins the bounded selection policy version", () => {
    assert.equal(COMPANY_MONITORING_EVIDENCE_POLICY.version, fixture.policyVersion);
    assert.equal(COMPANY_MONITORING_EVIDENCE_POLICY.maxReferences, 20);
  });

  it("does not throw on a malformed percent escape in a valid HTTPS URL", async () => {
    const result = await normalizeCompanyEvidence({
      ownerAccountId: "account-golden",
      subjects: [{
        companyId: "company-safe-path",
        name: "Safe Path Ltd",
        claims: [{
          claimId: "claim-safe-path",
          type: "legal_identifier",
          value: "lei:SAFEPATH",
          trustState: "verified",
          allowedUses: ["attribution"],
        }],
      }],
      evidence: [{
        provider: "exa",
        providerLocator: "exa-malformed-path",
        url: "https://news.example/%E0%A4%A",
        title: "Safe Path update (LEI:SAFEPATH)",
        publishedAt: fixture.now - 1,
        observedAt: fixture.now,
        candidateCompanyIds: ["company-safe-path"],
        sourceAuthority: "low_authority",
      }],
      now: fixture.now,
    });

    assert.equal(result.evidence.length, 1);
    assert.equal(result.candidates.length, 1);
  });

  for (const testCase of fixture.cases) {
    it(testCase.name, async () => {
      const result = await normalizeCompanyEvidence({
        ownerAccountId: "account-golden",
        subjects: testCase.subjects,
        evidence: evidenceRows(testCase),
        now: fixture.now,
      });
      const companyIds = [...new Set(result.evidence.map((row) => row.companyId))].sort();
      assert.deepEqual(companyIds, testCase.expected.companyIds);
      assert.equal(result.candidates.length, testCase.expected.candidateCount);

      if (testCase.expected.candidateCount === 0) return;
      if (testCase.expected.observationBlocking !== undefined) {
        assert.equal(result.candidates[0].observationBlocking, testCase.expected.observationBlocking);
      }
      if (testCase.expected.referenceCount !== undefined) {
        assert.equal(result.candidates[0].referenceCount, testCase.expected.referenceCount);
      }
      if (testCase.expected.selectedReferenceCount !== undefined) {
        assert.equal(
          result.candidates[0].referenceEvidenceFingerprints.length,
          testCase.expected.selectedReferenceCount,
        );
      }
      if (testCase.expected.referencesTruncated !== undefined) {
        assert.equal(result.candidates[0].referencesTruncated, testCase.expected.referencesTruncated);
      }
      if (testCase.expected.syndicatedCount !== undefined) {
        assert.equal(
          result.evidence.filter((row) => row.independence === "syndicated").length,
          testCase.expected.syndicatedCount,
        );
      }
      if (testCase.expected.sharedContentFingerprint) {
        assert.equal(new Set(result.evidence.map((row) => row.contentFingerprint)).size, 1);
      }
      if (testCase.expected.distinctOccurrenceDedupeKeys) {
        assert.equal(new Set(result.candidates.map((row) => row.occurrenceDedupeKey)).size, 2);
      }
      for (const candidate of result.candidates) {
        assert.equal(candidate.selectionPolicyVersion, fixture.policyVersion);
      }
    });
  }
});
