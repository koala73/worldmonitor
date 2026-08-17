import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DEFERRED_GENERATED_SERVICES,
  collectDeferredServiceViolations,
} from '../scripts/lib/sebuf-deferred-services.mjs';

// scripts/enforce-sebuf-api-contract.mjs is merge-blocking (`lint:api-contract`, run by
// the CI `biome` job, which deploy-gate lists as required). Its deferred-service
// exemption lets a generated service exist with no HTTP gateway — so the branches that
// are supposed to retire that exemption are the ones that must not rot. They are all
// INERT on the shipped tree (the service exists, no gateway exists), which means CI
// passing on the repo proves nothing about any of them. Hence direct unit coverage.

const KEY = 'demo_domain/v1';
const ENTRY = { removalIssue: '#1234', owner: '@someone', reviewBy: '2026-11-05' };

function run(overrides = {}) {
  return collectDeferredServiceViolations({
    deferred: new Map([[KEY, ENTRY]]),
    seenGeneratedServices: new Set([KEY]),
    seenGatewayDomains: new Set(),
    generatedTreePresent: true,
    today: '2026-08-05',
    ...overrides,
  });
}

describe('deferred generated service classification', () => {
  it('is clean while the service exists, has no gateway, and is in date', () => {
    assert.deepEqual(run(), []);
  });

  it('flags a deferred entry whose generated service is gone', () => {
    const violations = run({ seenGeneratedServices: new Set() });
    assert.equal(violations.length, 1);
    assert.match(violations[0].message, /no longer exists/);
    assert.match(violations[0].remedy, /#1234/);
  });

  it('flags a deferred entry that has gained an HTTP gateway', () => {
    const violations = run({ seenGatewayDomains: new Set([KEY]) });
    assert.equal(violations.length, 1);
    assert.match(violations[0].message, /now has an HTTP gateway/);
  });

  it('does NOT claim the service was removed when nothing has been generated yet', () => {
    // The bug this guards: the stale-entry loop used to run outside the
    // `existsSync(GEN_SERVER_DIR)` check, so an ungenerated tree produced
    // "service no longer exists" and told the reader to delete the exemption —
    // the opposite of the correct fix, and it permanently disarms the gate.
    const violations = run({
      seenGeneratedServices: new Set(),
      generatedTreePresent: false,
    });
    assert.deepEqual(violations, []);
  });

  it('flags an entry past its review date so the exemption cannot be permanent', () => {
    // Neither of the other two triggers fires in the state that actually rots: the
    // service sits gateway-less forever because the tracking issue was dropped.
    const violations = run({ today: '2026-11-06' });
    assert.equal(violations.length, 1);
    assert.match(violations[0].message, /passed its 2026-11-05 review date/);
  });

  it('prefers the more specific violation over the date when both apply', () => {
    const violations = run({ today: '2026-11-06', seenGatewayDomains: new Set([KEY]) });
    assert.equal(violations.length, 1);
    assert.match(violations[0].message, /now has an HTTP gateway/);
  });
});

describe('the shipped deferred list', () => {
  it('carries a removal issue, an owner, and a review date for every entry', () => {
    for (const [key, entry] of DEFERRED_GENERATED_SERVICES) {
      assert.match(entry.removalIssue, /^#\d+$/, `${key} needs a #NNNN removal issue`);
      assert.match(entry.owner, /^@[\w-]+$/, `${key} needs an @owner`);
      assert.match(entry.reviewBy, /^\d{4}-\d{2}-\d{2}$/, `${key} needs an ISO reviewBy date`);
    }
  });

  it('is not yet expired (fails loudly once a real entry goes stale)', () => {
    const today = new Date().toISOString().slice(0, 10);
    for (const [key, entry] of DEFERRED_GENERATED_SERVICES) {
      assert.ok(
        today <= entry.reviewBy,
        `${key} passed its ${entry.reviewBy} review date — land ${entry.removalIssue} or re-affirm the entry`,
      );
    }
  });
});
