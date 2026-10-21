import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

const root = resolve(import.meta.dirname, '..');

function readRepo(path) {
  return readFileSync(resolve(root, path), 'utf8');
}

const REQUIRED_ROLES = [
  'Audit Captain',
  'Claim Cartographer',
  'Runtime Truth Reviewer',
  'Data Pipeline / Redis Reviewer',
  'Generated Contract Reviewer',
  'Executable Examples Reviewer',
  'Bias / Methodology Reviewer',
  'Adversarial Verifier',
];

describe('documentation alignment audit council protocol', () => {
  const protocol = readRepo('docs/internal/documentation-alignment-audit-protocol.md');
  const claimLedger = readRepo('docs/internal/documentation-alignment-claim-ledger.template.md');
  const roleSignoff = readRepo('docs/internal/documentation-alignment-role-signoff.template.md');
  const finalReport = readRepo('docs/internal/documentation-alignment-final-report.template.md');

  it('defines every required specialist role and blocks single-reviewer closure', () => {
    for (const role of REQUIRED_ROLES) {
      assert.match(protocol, new RegExp(role.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      assert.match(roleSignoff, new RegExp(role.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      assert.match(finalReport, new RegExp(role.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    }

    assert.match(protocol, /Cannot self-approve closure/);
    assert.match(protocol, /all-writer\/all-reader inventory|all-writer\/all-reader/i);
    assert.match(protocol, /Fixture-backed examples must be recomputed/i);
  });

  it('claim ledger template requires source-of-truth and publishing-surface evidence', () => {
    for (const required of [
      'Claim',
      'Type',
      'Source of truth',
      'Publishing surfaces',
      'Reviewer role',
      'Evidence',
      'Redis writers/readers enumerated',
      'generated OpenAPI YAML/JSON checked',
      'examples and fixtures recomputed',
    ]) {
      assert.match(claimLedger, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
    }
  });

  it('final report template forbids fully-aligned language before role signoff evidence', () => {
    assert.match(finalReport, /Do not state "fully aligned" until all required role signoffs below are complete/);
    assert.match(finalReport, /Use "fully aligned" only if every role signoff is complete/);
  });
});

describe('high-risk Redis documentation guardrails', () => {
  it('UCDP writers for conflict:ucdp-events:v1 share the non-empty discovery guard', () => {
    const relay = readRepo('scripts/ais-relay.cjs');
    const standalone = readRepo('scripts/seed-ucdp-events.mjs');

    assert.match(relay, /UCDP_REDIS_KEY = 'conflict:ucdp-events:v1'/);
    assert.match(standalone, /const REDIS_KEY = 'conflict:ucdp-events:v1'/);
    assert.match(relay, /Result\.length === 0\) throw/);
    assert.match(relay, /page0\.Result\.length > 0/);
    assert.match(standalone, /page0\.Result\.length === 0/);
  });

  it('Fear & Greed history Redis key is documented as planned until a writer exists', () => {
    const seeder = readRepo('scripts/seed-fear-greed.mjs');
    const doc = readRepo('docs/fear-greed-index-2.0-brief.md');

    assert.doesNotMatch(seeder, /market:fear-greed:history:v1/);
    assert.match(doc, /market:fear-greed:history:v1` is a planned sorted set/);
    assert.match(doc, /current seeder does not write or read it yet/);
  });
});
