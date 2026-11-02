import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  AI_REGULATIONS,
  REGULATORY_ACTIONS,
  COUNTRY_REGULATION_PROFILES,
} from '../src/config/ai-regulations.ts';

// Executive Order 14148, Sec. 2 (90 FR 8237, FR Doc. 2025-01901): "The following
// executive actions are hereby revoked: ... (ggg) Executive Order 14110".
describe('AI regulations dataset: EO 14110', () => {
  const eo = AI_REGULATIONS.find((r) => r.id === 'us-eo-14110');

  it('is not listed as active after its revocation', () => {
    assert.ok(eo, 'us-eo-14110 entry exists');
    assert.equal(eo.status, 'revoked');
  });

  it('has a revocation action dated 2025-01-20 sourced to the Federal Register', () => {
    const revocation = REGULATORY_ACTIONS.find(
      (a) => a.regulationId === 'us-eo-14110' && a.date === '2025-01-20',
    );
    assert.ok(revocation, 'a 2025-01-20 action for us-eo-14110 exists');
    assert.equal(revocation.type, 'executive-order');
    assert.equal(revocation.source, 'Federal Register');
  });

  it('is not counted among the United States active regulations', () => {
    const us = COUNTRY_REGULATION_PROFILES.find((p) => p.countryCode === 'US');
    assert.ok(us);
    assert.ok(!us.activeRegulations.includes('us-eo-14110'));
  });

  it('every country profile lists only regulations whose status matches the bucket', () => {
    const byId = new Map(AI_REGULATIONS.map((r) => [r.id, r]));
    for (const profile of COUNTRY_REGULATION_PROFILES) {
      for (const id of profile.activeRegulations) {
        assert.equal(byId.get(id)?.status, 'active', `${profile.countryCode} active: ${id}`);
      }
      for (const id of profile.proposedRegulations) {
        assert.equal(byId.get(id)?.status, 'proposed', `${profile.countryCode} proposed: ${id}`);
      }
    }
  });
});
